// Pulls a parent/student's previously-uploaded files directly from the
// Jotform form they submitted them through.
//
// Why we go to Jotform directly rather than reading them off the contact in
// HubSpot: Jotform is the source of truth for the actual file URLs and the
// per-question labels (e.g. "Passport", "Medical form", "Consent letter"),
// and a HubSpot mirror would lose that context.
//
// Inputs (querystring):
//   email   — the logged-in portal user's email
//   formId  — Jotform form ID (the long numeric ID in the form URL)
//
// Required env var: JOTFORM_API_KEY
// Optional env var: JOTFORM_BASE_URL (default https://api.jotform.com — set to
//                   https://eu-api.jotform.com or https://hipaa-api.jotform.com
//                   if your account is on those regions)

export async function handler(event) {
  try {
    const { email, formId } = event.queryStringParameters || {};

    if (!email) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing email" }) };
    }
    if (!formId) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing formId" }) };
    }
    if (!process.env.JOTFORM_API_KEY) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Jotform is not configured",
          details: "Set JOTFORM_API_KEY in Netlify environment variables."
        })
      };
    }

    const cleanEmail = String(email).toLowerCase().trim();
    const apiKey = process.env.JOTFORM_API_KEY;
    const baseUrl = (process.env.JOTFORM_BASE_URL || "https://api.jotform.com").replace(/\/+$/, "");

    // Fetch all submissions for this form. Jotform paginates at 1000/request,
    // which is plenty for one program; we'll page if there are more.
    const allSubmissions = [];
    let offset = 0;
    const pageSize = 1000;
    while (true) {
      const url = `${baseUrl}/form/${encodeURIComponent(formId)}/submissions` +
        `?apiKey=${encodeURIComponent(apiKey)}&limit=${pageSize}&offset=${offset}`;
      const res = await fetch(url, { headers: { Accept: "application/json" } });

      if (!res.ok) {
        const text = await res.text();
        return {
          statusCode: 502,
          body: JSON.stringify({
            error: "Jotform fetch failed",
            status: res.status,
            details: text.slice(0, 500)
          })
        };
      }

      const data = await res.json();
      const page = Array.isArray(data?.content) ? data.content : [];
      allSubmissions.push(...page);
      if (page.length < pageSize) break;
      offset += pageSize;
      if (offset >= 5000) break; // safety net
    }

    // Walk each submission's answers; capture file uploads when the
    // submission's email answer matches the logged-in user's email.
    const documents = [];
    for (const submission of allSubmissions) {
      const answers = submission?.answers || {};
      let submissionEmail = null;
      const fileUploads = [];

      for (const qid of Object.keys(answers)) {
        const a = answers[qid] || {};
        const t = String(a.type || "").toLowerCase();
        const label = a.text || a.name || "";

        if (t === "control_email" && a.answer) {
          submissionEmail = String(a.answer).toLowerCase().trim();
        } else if (t === "control_fileupload" && a.answer) {
          const v = a.answer;
          const urls = Array.isArray(v) ? v.filter(Boolean) : [String(v)].filter(Boolean);
          for (const u of urls) {
            fileUploads.push({ url: u, fieldLabel: label });
          }
        }
      }

      if (!submissionEmail || submissionEmail !== cleanEmail) continue;
      if (fileUploads.length === 0) continue;

      for (const f of fileUploads) {
        let filename = "Document";
        try {
          const u = new URL(f.url);
          filename = decodeURIComponent(u.pathname.split("/").pop() || "Document");
        } catch (_) { /* leave default */ }

        documents.push({
          submissionId: submission.id,
          uploadedAt: submission.created_at || null,
          fieldLabel: f.fieldLabel,
          filename,
          url: f.url
        });
      }
    }

    // Newest first
    documents.sort((a, b) => {
      const ta = a.uploadedAt ? new Date(a.uploadedAt).getTime() : 0;
      const tb = b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
      return tb - ta;
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ documents })
    };

  } catch (err) {
    console.error("ERROR:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}
