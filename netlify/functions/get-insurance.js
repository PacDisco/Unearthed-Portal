export async function handler(event) {
  try {
    const OBJECT = "2-58156993";
    const FIXED_ID = "50506535214";
    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
      "Content-Type": "application/json"
    };

    const res = await fetch(
      `https://api.hubapi.com/crm/v3/objects/${OBJECT}/${FIXED_ID}?properties=insurance_overview_and_faqs,insurance_policy_wording,payment_form_url`,
      { headers }
    );

    if (!res.ok) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Fixed object fetch failed",
          details: await res.text()
        })
      };
    }

    const data = await res.json();

    return {
      statusCode: 200,
      body: JSON.stringify({
        insurance_overview_and_faqs: data.properties?.insurance_overview_and_faqs || null,
        insurance_policy_wording: data.properties?.insurance_policy_wording || null,
        payment_form_url: data.properties?.payment_form_url || null
      })
    };

  } catch (err) {
    console.error("ERROR:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
}
