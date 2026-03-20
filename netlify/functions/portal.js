export async function handler(event) {
  const email = event.queryStringParameters.email;

  if (!email) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing email" })
    };
  }

  // 1. Find contact
  const contactRes = await fetch(
    "https://api.hubapi.com/crm/v3/objects/contacts/search",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
        "Content-Type": "application/json"
      },
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

  const contactData = await contactRes.json();
  const contactId = contactData.results?.[0]?.id;

  if (!contactId) {
    return {
      statusCode: 404,
      body: JSON.stringify({ error: "Contact not found" })
    };
  }

  // 2. Get associated portal
  const assocRes = await fetch(
    `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/YOUR_OBJECT_NAME`,
    {
      headers: {
        Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`
      }
    }
  );

  const assocData = await assocRes.json();
  const portalId = assocData.results?.[0]?.toObjectId;

  // 3. Get portal content
  const portalRes = await fetch(
    `https://api.hubapi.com/crm/v3/objects/YOUR_OBJECT_NAME/${portalId}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`
      }
    }
  );

  const portal = await portalRes.json();

  return {
    statusCode: 200,
    body: JSON.stringify(portal.properties)
  };
}
