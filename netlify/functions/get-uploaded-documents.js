// Pulls a parent/student's previously-uploaded files directly from the
// Jotform form(s) they submitted them through.
//
// Why we go to Jotform directly rather than reading them off the contact in
// HubSpot: Jotform is the source of truth for the actual file URLs and the
// per-question labels (e.g. "Passport", "Medical form", "Consent letter"),
// and a HubSpot mirror would lose that context.
//
// Inputs (querystring):
//   email     — the logged-in portal user's email (required)
//   formIds   — comma-separated Jotform form IDs (preferred)
//   formId    — single Jotform form ID (legacy, still supported)
//
// Required env var: JOTFORM_API_KEY
// Optional env var: JOTFORM_BASE_URL (default https://api.jotform.com — set to
//                   https://eu-api.jotform.com or https://hipaa-api.jotform.com
//                   if your account is on those regions)

export async function handler(event) {
  try {
    const { email, formId, formIds } = event.queryStringParameters || {};

    if (!email) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing email" }) };
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

    // Accept either a single formId or multiple via formIds=.
    const idList = (formIds || formId || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    if (idList.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing formId / formIds" }) };
    }

    const cleanEmail = String(email).toLowerCase().trim();
    const apiKey = process.env.JOTFORM_API_KEY;
    const baseUrl = (process.env.JOTFORM_BASE_URL || "https://api.jotform.com").replace(/\/+$/, "");

    // Process all forms in parallel — title fetch + submissions fetch each.
    const perForm = await Promise.all(idList.map(id => loadFormData(id, cleanEmail, apiKey, baseUrl)));

    // Aggregate
    const documents = [];
    const forms = [];
    let firstError = null;
    for (const r of perForm) {
      if (r.error && !firstError) firstError = r.error;
      forms.push({ id: r.id, title: r.title || null });
      for (const d of r.documents) documents.push(d);
    }

    documents.sort((a, b) => {
      const ta = a.uploadedAt ? new Date(a.uploadedAt).getTime() : 0;
      const tb = b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
      return tb - ta;
    });

    const response = { documents, forms };
    if (firstError) response.warning = firstError;

    return {
      statusCode: 200,
      body: JSON.stringify(response)
    };

  } catch (err) {
    console.error("ERROR:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}

async function loadFormData(formId, cleanEmail, apiKey, baseUrl) {
  const out = { id: formId, title: null, documents: [], error: null };

  // Fetch form metadata (for the title) and submissions in parallel.
  const [titleRes, submissions] = await Promise.all([
    fetchFormTitle(formId, apiKey, baseUrl),
    fetchAllSubmissions(formId, apiKey, baseUrl)
  ]);

  if (titleRes.error) {
    // Title is nice-to-have; don't fail the whole call over it.
    console.warn(`Form ${formId} title fetch warning:`, titleRes.error);
  } else {
    out.title = titleRes.title || null;
  }

  if (submissions.error) {
    out.error = `Form ${formId}: ${submissions.error}`;
    return out;
  }

  for (const submission of submissions.list) {
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

      out.documents.push({
        submissionId: submission.id,
        formId,
        uploadedAt: submission.created_at || null,
        fieldLabel: f.fieldLabel,
        filename,
        url: f.url
      });
    }
  }

  return out;
}

async function fetchFormTitle(formId, apiKey, baseUrl) {
  try {
    const res = await fetch(
      `${baseUrl}/form/${encodeURIComponent(formId)}?apiKey=${encodeURIComponent(apiKey)}`,
      { headers: { Accept: "application/json" } }
    );
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json();
    return { title: data?.content?.title || null };
  } catch (err) {
    return { error: err.message };
  }
}

async function fetchAllSubmissions(formId, apiKey, baseUrl) {
  const list = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const url = `${baseUrl}/form/${encodeURIComponent(formId)}/submissions` +
      `?apiKey=${encodeURIComponent(apiKey)}&limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });

    if (!res.ok) {
      const text = await res.text();
      return { error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
    }

    const data = await res.json();
    const page = Array.isArray(data?.content) ? data.content : [];
    list.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
    if (offset >= 5000) break; // safety net
  }
  return { list };
}
