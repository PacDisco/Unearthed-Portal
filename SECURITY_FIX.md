# Security fix — server-side authentication & authorization

This change closes the two issues reported by a parent (Chris Seifert) on the
Lincoln High / Nepal trip:

1. **Unauthenticated data access (IDOR).** Endpoints like
   `get-application-data?email=…` and `get-paid-payments?email=…` returned a
   person's private data (passport numbers, medical info, payments) to anyone
   who supplied the email. There was no check that the caller was that person,
   or even logged in.
2. **Client-side-only admin gating.** Admin access was decided in the browser
   (a `sessionStorage` `adminRole` flag). Anyone could set that flag by hand,
   reach `/admin.html?as_admin=1`, view every trip, and use `/admin-invite` to
   create more admins.

## Root cause

The app had no server-verified session. The browser simply passed an `email`
around and the functions trusted it. Roles were never verified server-side.

## What changed

A small, stateless **signed session token** is now issued at login and
**verified by every private endpoint**.

- `netlify/functions/_shared/auth.js` — new shared helper. Mints and verifies
  HMAC-SHA256 tokens (`base64url(payload).base64url(signature)`), where the
  payload is `{ email, role, exp }`. The signing secret never leaves the
  server, so the browser cannot forge a token or flip its own `role` to admin
  — any tampering breaks the signature. Tokens expire after 14 days.
  Exposes `authenticate` (any signed-in user), `authenticateSelf(event, email)`
  (must match the token's email; admins may act on any email), and
  `authenticateAdmin` (token's role must be a real admin role).

- **Token issued on login** (`login.js`) and on password set
  (`set-password.js`). The browser stores it in `sessionStorage.portalToken`
  and sends it as `Authorization: Bearer <token>` on every API call.

- **Endpoints gated:**
  | Endpoint | Rule |
  | --- | --- |
  | `get-application-data`, `get-paid-payments`, `get-uploaded-documents`, `create-checkout-session`, `save-push-subscription` | self-or-admin (token email must match the requested email) |
  | `portal` (`?email=` path) | self-or-admin |
  | `portal` (`?portalId=` admin view), `get-portals`, `admin-invite` | admin only |
  | `get-teachers`, `get-insurance` | any signed-in user |
  | `login`, `send-magic-link`, `verify-token`, `set-password`, `get-push-config` | public (pre-auth, by design) |

  `admin-invite` additionally now derives the inviter from the verified token
  (not a body field) and still re-checks `admin_role` live in HubSpot, so a
  revoked admin can't keep inviting.

- **Frontend** (`index.html`, `admin.html`, `my-trips.html`,
  `admin-invite.html`, `login.html`, `set-password.html`) now stores the token
  and attaches it to every request; a 401 clears the session and returns the
  user to the login page. Logout clears the token. Service-worker cache bumped
  to `unearthed-v8-auth` so installed PWAs pick up the new pages.

## REQUIRED before deploy: set SESSION_SECRET

The token signing key. Generate a long random value and add it as a Netlify
environment variable (Site settings → Environment variables):

```
openssl rand -hex 32
```

Set `SESSION_SECRET` to that value. If it is missing, the protected endpoints
fail closed (HTTP 500) rather than letting anyone through — so don't deploy
without it. Changing it later logs everyone out (their tokens stop verifying),
which is also your "revoke all sessions" lever.

No other new env vars. No new dependencies. No database.

## Verifying the fix

After deploy, with no session:

```
curl "https://portal.unearthededucation.org/.netlify/functions/get-application-data?email=someone@example.com"
# expect: HTTP 401  {"error":"Not signed in..."}
```

A logged-in non-admin requesting someone else's email gets **403**; an
unauthenticated call to `get-portals` / `admin-invite` gets **401**, and a
logged-in non-admin gets **403**. The auth helper ships with a self-test
covering round-trip, tamper/forgery rejection, expiry, self-vs-other, and
admin-vs-user (16 assertions, all passing).

## Batch 2 — additional hardening (2026)

Found during a wider audit after the initial fix:

- **Payment amount is now server-authoritative.** `create-checkout-session.js`
  previously charged whatever `chargeAmount` the browser sent — a logged-in
  user could pay any amount. It now ignores the client amount entirely: it
  takes `paymentIndex` + `portalId`, verifies the user is associated with that
  trip (admins may price any trip), reads `payment_amount_<index>` from the
  trip's Portal record (falling back to the global record), and applies the 3%
  card fee server-side. The frontend now sends `portalId` instead of an amount.

- **Passwords are now hashed.** New `netlify/functions/_shared/password.js`
  hashes with scrypt (salted; Node built-in, no new dependency). `set-password`
  stores a hash; `login` verifies against it. Existing **plaintext passwords
  still work and are transparently upgraded to a hash on the user's next
  successful login** — nobody is locked out, no migration script needed. Format:
  `scrypt$<salt>$<key>`.

- **Stripe redirect URLs pinned.** Success/cancel URLs are built from a fixed
  base (`PORTAL_BASE_URL`, default the production URL) instead of the request's
  `Origin`/`Referer` header, closing a post-payment open-redirect.

- **Generic login responses.** `login.js` returns the same "Incorrect email or
  password" for both unknown emails and wrong passwords, so outsiders can't
  probe which emails have accounts. (`send-magic-link` already responded
  generically.) The "set a password via magic link" hint for brand-new accounts
  is intentionally preserved.

No new required env vars in this batch. `PORTAL_BASE_URL` is optional (defaults
to the production URL). Tested: 10-assertion password self-test (hash/verify,
legacy upgrade flag, salt uniqueness) and amount-parser checks, all passing.

### Batch 2b — quick hardening (also done)
- Internal HubSpot/Stripe error text no longer returned to the browser (logged
  server-side instead); top-level catch handlers return a generic message.
- PII removed from server logs (portal.js full-record/association dumps, the
  cleartext "email not found" line in send-magic-link).
- Minimum password length (8) enforced server-side in set-password.js — applies
  to new/reset passwords only; existing shorter passwords keep working at login.
- Security headers added via `netlify.toml` (CSP, HSTS, X-Frame-Options,
  X-Content-Type-Options, Referrer-Policy, Permissions-Policy). CSP allow-list
  covers Google Fonts, the jsdelivr QR script, and Jotform embed/iframes.
- `X-Robots-Tag: noindex, nofollow` header + a noindex meta tag on index/login
  so the portal stays out of search engines.

## Batch 3 — rate-limiting + document-proxy gating

- **Login brute-force throttle.** After 5 consecutive wrong passwords an
  account is locked for 15 minutes. Backed by two HubSpot contact properties
  (see below). Fully **fail-open**: a separate, try/catch-wrapped read/write,
  so if the properties don't exist the throttle silently no-ops and login keeps
  working. A locked-out legitimate user can still get in via the magic link.

- **Magic-link send cooldown.** `send-magic-link.js` won't re-send to the same
  account within 60s (anti-inbox-bombing). Reuses the existing
  `portal_token_expiry` to estimate the last send time — no new property.

- **Document proxy is now authenticated.** `/document-proxy` (edge) and the
  legacy `get-document` function now require a valid session token. Because the
  files are loaded from `<img>`/`<a>` tags that can't send an Authorization
  header, the token rides in the URL (`?token=`); `get-uploaded-documents` and
  `get-teachers` append the caller's token to the proxy URLs they return. The
  edge function verifies the same HMAC token via Web Crypto (Deno runtime).
  Verified cross-runtime: the edge verifier accepts tokens minted by the Node
  login function and rejects tampered/expired/wrong-secret/missing ones.

### REQUIRED for the login throttle: create two HubSpot contact properties
Contacts → settings → Properties → Create property (object type **Contact**):
  1. Internal name `portal_failed_logins`  — type Number (or Single-line text)
  2. Internal name `portal_lockout_until`  — type Number (or Single-line text)
Until these exist the throttle is inactive (login still works normally). No new
property is needed for the magic-link cooldown or the proxy gating.

### Residual notes
- The session token now appears in document/photo URLs. Those requests are
  same-origin and Referrer-Policy is set, so leakage is limited; a future
  improvement is a short-lived, file-scoped token instead of the full session
  token.
- The edge proxy still follows upstream redirects (kept to avoid breaking
  Jotform file delivery); the Jotform key is only attached to Jotform-host
  requests.
- Push webhook shared secret (`WEBHOOK_SHARED_SECRET`) is still config-only —
  set it in Netlify + the HubSpot workflow to lock down that endpoint.

## Recommended follow-ups (not required to close the report)

- **`/document-proxy` (edge function) is not yet token-gated.** It streams a
  file given its exact Jotform/HubSpot URL. Those URLs are long and
  unguessable, and the only place that hands them out (`get-uploaded-documents`)
  is now authenticated — so practical exposure is much reduced. Gating it
  properly needs a Web Crypto (Deno) verifier since edge functions don't run
  the Node `crypto` module; worth doing as a fast follow.
- **Passwords are stored and compared in plaintext** on the HubSpot contact
  (`portal_password`). This was pre-existing and outside the reported issues,
  but should move to a salted hash (e.g. bcrypt/scrypt) when convenient.
- Consider a short-lived token (hours) with silent refresh if you want tighter
  session windows than 14 days.
