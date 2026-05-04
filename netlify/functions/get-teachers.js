// Returns the contacts associated to a portal, split into:
//   - teachers     — contacts with the "Teacher" association label, with
//                    full contact details (name/email/phone).
//   - tripLeaders  — contacts with the "Trip Leader" association label,
//                    with name + trip_leader_bio (custom contact property).
//
// Both lists feed the "SCHOOL CONTACTS" section on the portal so parents
// see who's accompanying the trip and a short bio of each trip leader.

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

    // 1. Get every contact associated to this portal
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
    const results = assocData.results || [];

    // 2. Bucket by association label
    const teacherIds = results
      .filter(r => r.associationTypes?.some(t => t.label === "Teacher"))
      .map(r => r.toObjectId);

    const tripLeaderIds = results
      .filter(r => r.associationTypes?.some(t => t.label === "Trip Leader"))
      .map(r => r.toObjectId);

    // 3. Fetch contact details for each bucket in parallel.
    //    Trip leaders need trip_leader_bio in addition to the basics.
    const [teachers, tripLeaders] = await Promise.all([
      fetchContacts(teacherIds, headers, ["firstname", "lastname", "email", "phone"], shapeTeacher),
      fetchContacts(tripLeaderIds, headers, ["firstname", "lastname", "trip_leader_bio"], shapeTripLeader)
    ]);

    // Sort each list alphabetically by name
    teachers.sort((a, b) => a.name.localeCompare(b.name));
    tripLeaders.sort((a, b) => a.name.localeCompare(b.name));

    return {
      statusCode: 200,
      body: JSON.stringify({ teachers, tripLeaders })
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

async function fetchContacts(ids, headers, properties, shape) {
  if (!ids || ids.length === 0) return [];

  const res = await fetch(
    "https://api.hubapi.com/crm/v3/objects/contacts/batch/read",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        inputs: ids.map(id => ({ id: String(id) })),
        properties
      })
    }
  );

  if (!res.ok) return [];

  const data = await res.json();
  return (data.results || []).map(shape);
}

function shapeTeacher(c) {
  return {
    name: `${c.properties.firstname || ""} ${c.properties.lastname || ""}`.trim(),
    email: c.properties.email || "",
    phone: c.properties.phone || ""
  };
}

function shapeTripLeader(c) {
  return {
    name: `${c.properties.firstname || ""} ${c.properties.lastname || ""}`.trim(),
    bio:  c.properties.trip_leader_bio || ""
  };
}
