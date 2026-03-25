export async function handler(event) {
  try {
    const email = event.queryStringParameters.email;
    if (!email) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing email" })
      };
    }

    const OBJECT = "2-58156993";
    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
      "Content-Type": "application/json"
    };

    // 1. Find contact
    const contactRes = await fetch(
      "https://api.hubapi.com/crm/v3/objects/contacts/search",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          filterGroups: [{
            filters: [{
              propertyName: "email",
              operator: "EQ",
              value: email
            }]
          }]
        })
      }
    );

    if (!contactRes.ok) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Contact fetch failed",
          details: await contactRes.text()
        })
      };
    }

    const contactData = await contactRes.json();
    const contactId = contactData.results?.[0]?.id;

    console.log("CONTACT ID:", contactId);

    if (!contactId) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Contact not found" })
      };
    }

    // 2. Get associated portal
    const assocRes = await fetch(
      `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/${OBJECT}`,
      { headers }
    );

    if (!assocRes.ok) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Association fetch failed",
          details: await assocRes.text()
        })
      };
    }

    const assocData = await assocRes.json();

    console.log("ASSOCIATIONS:", JSON.stringify(assocData, null, 2));

    if (!assocData.results || assocData.results.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "No portal association found" })
      };
    }

    const portalId = assocData.results[0].toObjectId;

    console.log("PORTAL ID:", portalId);

    // Fix: extract labels properly from all results
    // filtering out nulls and generic category names like "Program"
    const labels = assocData.results
      .flatMap(r => r.associationTypes || [])
      .map(t => t.label)
      .filter(l => l && l !== "Program");

    console.log("LABELS EXTRACTED:", labels);

    // 3. Get portal content
    const portalRes = await fetch(
      `https://api.hubapi.com/crm/v3/objects/${OBJECT}/${portalId}?properties=portal_title,trip_information_content,destination_overview_content,travel_information_content,general_information_content,family_information_content,payments_information_content,payments_form_url,trip_leader_information_content,teacher_information_content,faqs`,
      { headers }
    );

    if (!portalRes.ok) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Portal fetch failed",
          details: await portalRes.text()
        })
      };
    }

    const portal = await portalRes.json();

    console.log("PORTAL DATA:", JSON.stringify(portal, null, 2));

    // 4. Return data
    return {
      statusCode: 200,
      body: JSON.stringify({
        ...portal.properties,
        labels
      })
    };

  } catch (err) {
    console.error("ERROR:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Server error",
        details: err.message
      })
    };
  }
}
