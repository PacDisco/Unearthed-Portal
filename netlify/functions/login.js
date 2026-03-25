export async function handler(event) {
  try {
    const { email, password } = JSON.parse(event.body);

    if (!email || !password) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing email or password" })
      };
    }

    const cleanEmail = email.toLowerCase().trim();

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
              value: cleanEmail
            }]
          }],
          properties: ["email", "portal_password"]
        })
      }
    );

    const contactData = await contactRes.json();
    const contact = contactData.results?.[0];

    if (!contact) {
      return {
        statusCode: 200,
        body: JSON.stringify({ success: false, error: "Email not found" })
      };
    }

    const storedPassword = contact.properties?.portal_password;

    if (!storedPassword) {
      return {
        statusCode: 200,
        body: JSON.stringify({ success: false, error: "no_password" })
      };
    }

    if (storedPassword !== password) {
      return {
        statusCode: 200,
        body: JSON.stringify({ success: false, error: "Incorrect password" })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, email: cleanEmail })
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
}
