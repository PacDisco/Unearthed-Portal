# Security fixes — Chris's three findings

## 1. Jotform submissions editable at jotform.com/edit/<id> — MANUAL (Jotform), not code

This cannot be fixed in this repo. The portal no longer generates or exposes
that URL, but the page is served by Jotform, so anyone with a submission ID can
still open it. Fix it in the Jotform form settings for form `251396787451873`:

- Require login to edit submissions (so an anonymous edit link won't work), or
  disable submission editing entirely if parents only ever edit via the portal.
- Remove the "Edit Submission" link from the form's autoresponder/confirmation
  emails and the Thank-You page.

(Submission IDs are guessable, which is why this is rated serious.) The portal's
own editor remains safe because it authenticates the user and resolves their
submission server-side — it never hands the browser a Jotform edit URL.

## 2. Token not invalidated on logout — FIXED (server-side revocation)

Tokens now embed a version number (`ver`) that is also stored on the HubSpot
contact as `portal_token_version`. `authenticate()` rejects any token whose
`ver` no longer matches the contact's current value. The new `logout.js`
endpoint increments that value, instantly invalidating every token issued
before logout (this device and any others — i.e. "log out everywhere"). The
browser `logout()` buttons now call this endpoint before clearing local state.

A 30-second in-memory cache (`VERSION_CACHE_MS`) keeps this from adding a
HubSpot read to every request; a logout therefore takes full effect everywhere
within ~30s. On a HubSpot read error the check fails open (signature + expiry
still apply) to avoid mass lockouts during an outage.

## 3. Token valid for 2 weeks — FIXED

`TOKEN_TTL_MS` in `_shared/auth.js` is now **12 hours** (was 14 days). Combined
with #2, a leaked/post-logout token is useless quickly.

Tokens minted before this change had no `ver` and are now rejected on sight, so
**everyone is logged out once on deploy and must sign in again** — expected and
appropriate after a token-security fix.

---

## REQUIRED before deploy

### HubSpot property (for logout revocation to persist)
Create a contact property in HubSpot → Settings → Properties → Contact:
- Label: `Portal Token Version`
- Internal name: **`portal_token_version`**
- Field type: **Number**
- Default: 0

Without it, login still works and tokens still expire in 12h, but the logout
bump silently no-ops (it can't write a property that doesn't exist), so logout
won't actively revoke — it just clears the browser. Create the property to get
true revocation.

### Environment variables (Netlify) — unchanged
- `SESSION_SECRET` — signing secret (already required).
- `HUBSPOT_API_KEY` — already present; now also read/written by the auth layer.
- `JOTFORM_API_KEY` — for the application editor.

## Files changed in this round
- `netlify/functions/_shared/auth.js` — 12h TTL, token `ver`, async revocation
  check, `getCurrentTokenVersion` / `bumpTokenVersion`.
- `netlify/functions/logout.js` — NEW. Bumps the caller's token version.
- `netlify/functions/login.js`, `set-password.js` — stamp current `ver` into
  issued tokens.
- All protected endpoints — `authenticate*()` is now async, so calls are `await`ed.
- `public/index.html`, `admin.html`, `my-trips.html` — `logout()` calls the
  logout endpoint before clearing the session.
- `public/service-worker.js` — cache bumped to `v11-token-revocation`.

## After deploying
Load the site once online so the new service worker replaces the cached pages.
Everyone will be prompted to log in again (expected). Verify: log in, copy the
token, log out, then confirm the copied token is rejected by a protected
endpoint.
