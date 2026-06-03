// GET /.netlify/functions/get-application
//
// Returns the logged-in user's OWN application submission, ready to render in
// the secure portal edit form. Security model:
//   1. Caller must present a valid signed session token (Authorization:
//      Bearer <token>, issued by login.js). No token => 401.
//   2. The email is taken from the *verified* token payload, never from the
//      request — so a caller cannot ask for someone else's application.
//   3. The submission ID is resolved server-side and is NOT returned to the
//      browser. The client only ever sees field labels/values.
//   4. Sensitive field values (passport, health, etc.) are withheld entirely;
//      the client is told only that a value exists.

import { verifyRequest } from "./lib/session.js";
import { findSubmissionByEmail, buildClientFields } from "./lib/jotform.js";

function json(statusCode, payload) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };
}

export async function handler(event) {
  try {
    if (event.httpMethod && event.httpMethod !== "GET") {
      return json(405, { error: "Method not allowed" });
    }

    // 1. Authenticate.
    let auth;
    try {
      auth = verifyRequest(event);
    } catch (e) {
      // Thrown only when PORTAL_SESSION_SECRET is missing/misconfigured.
      console.error("[get-application] session config error:", e?.message || e);
      return json(500, { error: "Server auth is not configured." });
    }
    if (!auth.ok) return json(401, { error: "Not authenticated", detail: auth.error });

    if (!process.env.JOTFORM_API_KEY) {
      return json(500, { error: "Jotform is not configured." });
    }

    // 2. Resolve the caller's own submission from the verified email.
    const result = await findSubmissionByEmail(auth.email);
    if (!result.found) {
      return json(200, {
        found: false,
        fields: [],
        warning: result.warning || null,
      });
    }

    // 3. Build client-safe fields (sensitive values withheld). submissionId
    //    and formId are deliberately omitted from the response.
    const fields = buildClientFields(result.submission);

    return json(200, {
      found: true,
      submittedAt: result.submission.created_at || null,
      fields,
      warning: result.warning || null,
    });

  } catch (err) {
    console.error("[get-application] error:", err?.stack || err?.message || err);
    return json(500, { error: "Could not load your application." });
  }
}
