// Lists the students associated to a given portal record, with each
// student's actual paid totals (read from their associated Deal's
// payment_1..10 strings) and any associated Parent contacts.
//
// Important: payment_1..10 live on the *Deal*, not the Contact. The previous
// implementation read those properties off the contact directly and got
// `undefined` for every student, which meant every card showed
// "TOTAL PAID: $0 / No payments recorded". This version walks contact →
// associated Deals (most recently created), parses the leading numeric
// value out of each deal payment_N string ("250, pi_xxx, 2026-03-12"), and
// sums them.

export async function handler(event) {
  try {
    const { portalId } = event.queryStringParameters || {};

    if (!portalId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing portalId" })
      };
    }

    const OBJECT = "2-58156993";
    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
      "Content-Type": "application/json"
    };

    // 1. Get all contacts associated to this portal
    const assocRes = await fetch(
      `https://api.hubapi.com/crm/v4/objects/${OBJECT}/${portalId}/associations/contacts`,
      { headers }
    );

    if (!assocRes.ok) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Portal contact associations fetch failed",
          details: await assocRes.text()
        })
      };
    }

    const assocData = await assocRes.json();

    // 2. Filter to only Student associations
    const studentIds = (assocData.results || [])
      .filter(r => r.associationTypes?.some(t => t.label === "Student"))
      .map(r => r.toObjectId);

    if (studentIds.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({ students: [] })
      };
    }

    // 3. Batch-read student contact basic info (name/email/phone only;
    //    payment data lives on the deal, not here).
    const studentsRes = await fetch(
      "https://api.hubapi.com/crm/v3/objects/contacts/batch/read",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          inputs: studentIds.map(id => ({ id: String(id) })),
          properties: ["firstname", "lastname", "email", "phone"]
        })
      }
    );

    if (!studentsRes.ok) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Student batch-read failed",
          details: await studentsRes.text()
        })
      };
    }

    const studentsData = await studentsRes.json();

    // 4. For each student, resolve parent contacts and deal-side payments
    //    in parallel.
    const students = await Promise.all(
      (studentsData.results || []).map(async (student) => {
        const [parents, paymentInfo] = await Promise.all([
          fetchParents(student.id, headers),
          fetchStudentPayments(student.id, headers)
        ]);

        return {
          id: student.id,
          name: `${student.properties.firstname || ""} ${student.properties.lastname || ""}`.trim(),
          email: student.properties.email || "",
          phone: student.properties.phone || "",
          totalPaid: paymentInfo.totalPaid,
          payments: paymentInfo.payments,
          dealAmount: paymentInfo.dealAmount,
          parents
        };
      })
    );

    // Sort students alphabetically
    students.sort((a, b) => a.name.localeCompare(b.name));

    return {
      statusCode: 200,
      body: JSON.stringify({ students })
    };

  } catch (err) {
    console.error("ERROR:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
}

// ---------- helpers ----------

async function fetchParents(contactId, headers) {
  const parentAssocRes = await fetch(
    `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/contacts`,
    { headers }
  );
  if (!parentAssocRes.ok) return [];

  const parentAssocData = await parentAssocRes.json();
  const parentIds = (parentAssocData.results || [])
    .filter(r => r.associationTypes?.some(t => t.label === "Parent"))
    .map(r => r.toObjectId);

  if (parentIds.length === 0) return [];

  const parentsRes = await fetch(
    "https://api.hubapi.com/crm/v3/objects/contacts/batch/read",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        inputs: parentIds.map(id => ({ id: String(id) })),
        properties: ["firstname", "lastname", "email", "phone"]
      })
    }
  );

  if (!parentsRes.ok) return [];

  const parentsData = await parentsRes.json();
  return (parentsData.results || []).map(p => ({
    name: `${p.properties.firstname || ""} ${p.properties.lastname || ""}`.trim(),
    email: p.properties.email || "",
    phone: p.properties.phone || ""
  }));
}

// Returns the student's actual paid totals from their most recently created
// associated Deal. Uses the same payment_N parsing pattern as get-paid-payments.js.
async function fetchStudentPayments(contactId, headers) {
  const empty = { totalPaid: 0, payments: [], dealAmount: null };

  // Find associated deals for the student
  const dealAssocRes = await fetch(
    `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/deals`,
    { headers }
  );
  if (!dealAssocRes.ok) return empty;

  const dealAssocData = await dealAssocRes.json();
  const dealIds = (dealAssocData.results || [])
    .map(r => r.toObjectId)
    .filter(Boolean);

  if (dealIds.length === 0) return empty;

  // Batch-read those deals — createdate to pick the most recent, plus all
  // payment fields and the deal's amount for context.
  const PAYMENT_FIELDS = [
    "payment_1", "payment_2", "payment_3", "payment_4", "payment_5",
    "payment_6", "payment_7", "payment_8", "payment_9", "payment_10"
  ];

  const dealsRes = await fetch(
    "https://api.hubapi.com/crm/v3/objects/deals/batch/read",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        inputs: dealIds.map(id => ({ id: String(id) })),
        properties: ["dealname", "createdate", "amount", "total_amount_paid", ...PAYMENT_FIELDS]
      })
    }
  );

  if (!dealsRes.ok) return empty;

  const dealsData = await dealsRes.json();
  const deals = dealsData.results || [];
  if (deals.length === 0) return empty;

  // Pick most recently created
  const sorted = deals.slice().sort((a, b) => {
    const ta = new Date(a.properties?.createdate || 0).getTime();
    const tb = new Date(b.properties?.createdate || 0).getTime();
    return tb - ta;
  });
  const deal = sorted[0];

  let totalPaid = 0;
  const payments = [];
  for (let i = 1; i <= 10; i++) {
    const raw = deal.properties?.[`payment_${i}`];
    const amount = extractPaymentAmount(raw);
    if (amount != null && amount > 0) {
      totalPaid += amount;
      payments.push({ label: `Payment ${i}`, amount });
    }
  }

  return {
    totalPaid: Math.round(totalPaid * 100) / 100,
    payments,
    dealAmount: deal.properties?.amount ? parseFloat(deal.properties.amount) : null
  };
}

// Pulls the leading numeric value out of a deal's payment_N string, which is
// stored in the loose "<amount>, <stripe_pi>, <date>" format on the Deal
// object. Tolerates messy formats — strips any non-digit chars from the first
// comma-separated token, returns null if nothing valid is left.
function extractPaymentAmount(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const first = trimmed.split(",")[0].trim();
  // Keep digits, dots, minus; drop currency symbols, letters, etc.
  const cleaned = first.replace(/[^0-9.\-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") return null;
  const n = parseFloat(cleaned);
  if (!isFinite(n) || n <= 0) return null;
  return n;
}
