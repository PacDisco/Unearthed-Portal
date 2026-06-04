// DEPRECATED — do not use.
//
// This module was an alternative session-token implementation that used its
// own `PORTAL_SESSION_SECRET` env var and a different token payload shape.
// The portal already has a canonical session system in
// `netlify/functions/_shared/auth.js` (env var SESSION_SECRET), which login.js
// issues tokens for and every protected endpoint verifies against.
//
// The application-edit endpoints now use _shared/auth.js too, so nothing
// imports this file. It is intentionally left empty to avoid implying that a
// second secret (PORTAL_SESSION_SECRET) needs to be configured.
//
// Safe to delete this file from the repo.

export {};
