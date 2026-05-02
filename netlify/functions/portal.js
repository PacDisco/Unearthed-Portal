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

    // Manual overrides for paired labels where HubSpot returns null
    // Add new paired labels here as needed: typeId -> label name
    const pairedLabelOverrides = {
      28: "Trip Leader"
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

    console.log("RAW ASSOC RESULTS:", JSON.stringify(assocData.results, null, 2));

    if (!assocData.results || assocData.results.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "No portal association found" })
      };
    }

    const portalId = assocData.results[0].toObjectId;

    console.log("PORTAL ID:", portalId);

    // Get typeIds from this association
    const typeIds = assocData.results
      .flatMap(r => r.associationTypes || [])
      .map(t => t.typeId);

    // Fetch label definitions
    const labelDefsRes = await fetch(
      `https://api.hubapi.com/crm/v4/associations/contacts/${OBJECT}/labels`,
      { headers }
    );

    const labelDefs = await labelDefsRes.json();

    console.log("LABEL DEFS:", JSON.stringify(labelDefs, null, 2));

    // Match typeIds to label definitions
    // Use override map for paired labels where HubSpot returns null
    const labels = (labelDefs.results || [])
      .filter(def => typeIds.includes(def.typeId))
      .map(def => pairedLabelOverrides[def.typeId] || def.label)
      .filter(l => l && l !== "Program");

    console.log("LABELS EXTRACTED:", labels);

    // 3. Get portal content
    const portalRes = await fetch(
      `https://api.hubapi.com/crm/v3/objects/${OBJECT}/${portalId}?properties=portal_title,destination,price,trip_information_content,destination_overview_content,travel_information_content,general_information_content,family_information_content,payments_information_content,payments_form_url,trip_leader_information_content,teacher_information_content,faqs,hs_object_id,itinerary,initial_planning_meeting,initial_planning_meeting_information,training_event,training_event_information,final_briefing,final_briefing_information,build_up_day,build_up_day_information,re_entry_workshop,re_entry_workshop_information,flight_departure_date,departure_airlines,departure_routing,return_flight_date,return_flight_airlines,return_flight_routing,payment_date_1,payment_amount_1,payment_date_2,payment_amount_2,payment_date_3,payment_amount_3,payment_date_4,payment_amount_4,payment_date_5,payment_amount_5,payment_date_6,payment_amount_6,payment_date_7,payment_amount_7,payment_date_8,payment_amount_8,payment_date_9,payment_amount_9,payment_date_10,payment_amount_10,student_manual,student_handbook,gear_list,fundraising_guide,fitness`,
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
