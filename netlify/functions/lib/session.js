// Stateless, signed portal session tokens.
//
// Why this exists
// ---------------
// The portal's only pre-existing "session" was `sessionStorage.portalEmail`
// on the client, which the serverless functions then trusted verbatim. That
// means anyone could call a function with someone else's email and act as
// them. The magic-link `portal_token` is NOT a session — it's a one-time,
// 1-hour credential that set-password.js deletes after use.
//
// To let the new application-edit endpoints verify the caller server-side
// (instead of trusting a client-supplied email) we mint a short signed token
// at login. It is an HMAC-SHA256 over `email|expiry`, so the server can
// confirm both the identity and that the token hasn't been tampered with —
// without storing anything in HubSpot or a database.
//
// Required env var:
//   PORTAL_SESSION_SECRET — a long random string (e.g. `openssl rand -hex 32`).
//                           Keep it only in Netlify env vars. Rotating it
//                           invalidates all existing sessions (users re-login).
//
// Optional env var:
//   PORTAL_SESSION_TTL_HOURS — session lifetime in hours. Default 720 (30 days).

import crypto from "crypto";

const DEFAULT_TTL_HOURS = 720; // 30 days

function getSecret() {
  const secret = process.env.PORTAL_SESSION_SECRET;
  if (!secret || secret.length < 16) {
    // Fail loud rather than silently issuing forgeable tokens.
    throw new Error(
      "PORTAL_SESSION_SECRET is not set (or too short). " +
      "Set a long random value in the Netlify environment variables."
    );
  }
  return secret;
}

// base64url helpers (no padding) so the token is URL/header safe.
function b64urlEncode(str) {
  return Buffer.from(str, "utf8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  const pad = str.length % 4 ? "=".repeat(4 - (str.length % 4)) : "";
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf8");
}

function sign(payloadB64) {
  return crypto.createHmac("sha256", getSecret())
    .update(payloadB64)
    .digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Issue a token for a verified email. Call this ONLY after the password
// (or magic link) has been validated.
export function issueSession(email) {
  const cleanEmail = String(email || "").toLowerCase().trim();
  if (!cleanEmail) throw new Error("issueSession: email required");

  const ttlHours = Number(process.env.PORTAL_SESSION_TTL_HOURS) || DEFAULT_TTL_HOURS;
  const exp = Date.now() + ttlHours * 60 * 60 * 1000;

  const payload = JSON.stringify({ e: cleanEmail, exp });
  const payloadB64 = b64urlEncode(payload);
  const sig = sign(payloadB64);
  return `${payloadB64}.${sig}`;
}

// Verify a token. Returns { ok: true, email } or { ok: false, error }.
// Never throws on a malformed token (only on missing server config).
export function verifySession(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) {
    return { ok: false, error: "Missing or malformed session token" };
  }

  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return { ok: false, error: "Malformed session token" };

  const expectedSig = sign(payloadB64);
  // Constant-time compare. Lengths must match for timingSafeEqual.
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: "Invalid session signature" };
  }

  let payload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64));
  } catch {
    return { ok: false, error: "Unreadable session payload" };
  }

  if (!payload?.e || !payload?.exp) {
    return { ok: false, error: "Incomplete session payload" };
  }
  if (Date.now() > Number(payload.exp)) {
    return { ok: false, error: "Session expired" };
  }

  return { ok: true, email: String(payload.e).toLowerCase().trim() };
}

// Convenience wrapper for handlers: pulls the token from a Bearer
// Authorization header or an `x-portal-session` header, verifies it, and
// returns the same shape as verifySession.
export function verifyRequest(event) {
  const headers = event?.headers || {};
  // Header names arrive lower-cased on Netlify/AWS.
  const auth = headers.authorization || headers.Authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const token = bearer || headers["x-portal-session"] || headers["X-Portal-Session"] || "";
  return verifySession(token);
}
