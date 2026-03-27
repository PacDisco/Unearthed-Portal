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

    // Get all contacts associated to this portal
    const assocRes = await fetch(
      `https://api.hubapi.com/crm/v4/objects/${OBJECT}/${portalId}/associations/contacts`,
      { headers }
    );

    const assocData = await assocRes.json();

    // Filter to Teacher label only
    const teacherIds = (assocData.results || [])
      .filter(r => r.associationTypes?.some(t => t.label === "Teacher"))
      .map(r => r.toObjectId);

    if (teacherIds.length === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({ teachers: [] })
      };
    }

    // Fetch teacher contact details
    const teachersRes = await fetch(
      "https://api.hubapi.com/crm/v3/objects/contacts/batch/read",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          inputs: teacherIds.map(id => ({ id: String(id) })),
          properties: ["firstname", "lastname", "email", "phone"]
        })
      }
    );

    const teachersData = await teachersRes.json();

    const teachers = teachersData.results
      .map(t => ({
        name: `${t.properties.firstname || ""} ${t.properties.lastname || ""}`.trim(),
        email: t.properties.email || "",
        phone: t.properties.phone || ""
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      statusCode: 200,
      body: JSON.stringify({ teachers })
    };

  } catch (err) {
    console.error("ERROR:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
}
