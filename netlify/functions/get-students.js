export async function handler(event) {
  try {
    const { portalId } = event.queryStringParameters;

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

    const assocData = await assocRes.json();

    // 2. Filter to only Student associations
    const studentIds = assocData.results
      .filter(r => r.associationTypes?.some(t => t.label === "Student"))
      .map(r => r.toObjectId);

    if (studentIds.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({ students: [] })
      };
    }

    // 3. Fetch student contact details in batch
    const studentsRes = await fetch(
      "https://api.hubapi.com/crm/v3/objects/contacts/batch/read",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          inputs: studentIds.map(id => ({ id: String(id) })),
          properties: [
            "firstname", "lastname", "email", "phone",
            "payment_1", "payment_2", "payment_3", "payment_4", "payment_5",
            "payment_6", "payment_7", "payment_8", "payment_9", "payment_10"
          ]
        })
      }
    );

    const studentsData = await studentsRes.json();

    // 4. For each student, fetch their parent associations
    const students = await Promise.all(
      studentsData.results.map(async (student) => {
        const parentAssocRes = await fetch(
          `https://api.hubapi.com/crm/v4/objects/contacts/${student.id}/associations/contacts`,
          { headers }
        );

        const parentAssocData = await parentAssocRes.json();

        // Filter to Parent label
        const parentIds = (parentAssocData.results || [])
          .filter(r => r.associationTypes?.some(t => t.label === "Parent"))
          .map(r => r.toObjectId);

        let parents = [];

        if (parentIds.length > 0) {
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

          const parentsData = await parentsRes.json();
          parents = parentsData.results.map(p => ({
            name: `${p.properties.firstname || ""} ${p.properties.lastname || ""}`.trim(),
            email: p.properties.email || "",
            phone: p.properties.phone || ""
          }));
        }

        // Calculate total paid
        const paymentFields = [
          "payment_1", "payment_2", "payment_3", "payment_4", "payment_5",
          "payment_6", "payment_7", "payment_8", "payment_9", "payment_10"
        ];

        const totalPaid = paymentFields.reduce((sum, field) => {
          const val = parseFloat(student.properties[field] || 0);
          return sum + (isNaN(val) ? 0 : val);
        }, 0);

        return {
          id: student.id,
          name: `${student.properties.firstname || ""} ${student.properties.lastname || ""}`.trim(),
          email: student.properties.email || "",
          phone: student.properties.phone || "",
          totalPaid,
          payments: paymentFields.map((field, i) => ({
            label: `Payment ${i + 1}`,
            amount: student.properties[field] || null
          })).filter(p => p.amount),
          parents
        };
      })
    );

    // Sort students alphabetically by last name
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
