// Creates a Stripe Checkout Session on demand so the portal's per-row
// payment amounts can deep-link directly to checkout.stripe.com instead of
// going through the existing intermediate "make payment + history" page.
//
// Uses the merchant's existing Stripe credentials (STRIPE_SECRET_KEY).
// No Stripe SDK dependency — calls the REST API directly with fetch and
// application/x-www-form-urlencoded, matching Stripe's documented format.
//
// Expected POST body (JSON):
//   {
//     email:         "parent@example.com",       // required
//     paymentIndex:  3,                           // 1..10, optional
//     baseAmount:    1000.00,                     // listed installment amount
//     chargeAmount:  1030.00,                     // fee-inclusive total to charge
//     description:   "Costa Rica Mini Semester — Payment 3"  // optional
//   }
//
// Returns:  { url, id }   on success
//           { error, details? }   on failure

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: "Method not allowed" })
      };
    }

    if (!process.env.STRIPE_SECRET_KEY) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Stripe is not configured",
          details: "Set STRIPE_SECRET_KEY in Netlify environment variables."
        })
      };
    }

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch (e) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid JSON body" })
      };
    }

    const {
      email,
      paymentIndex,
      baseAmount,
      chargeAmount,
      description
    } = body;

    if (!email) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing email" }) };
    }
    const charge = parseFloat(chargeAmount);
    if (!isFinite(charge) || charge <= 0) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing or invalid chargeAmount" }) };
    }

    // Origin = where to send the user back to after payment.
    const origin =
      event.headers?.origin ||
      event.headers?.referer?.split("/").slice(0, 3).join("/") ||
      "https://portal.unearthededucation.org";

    const currency = (process.env.STRIPE_CURRENCY || "nzd").toLowerCase();
    const unitAmountCents = Math.round(charge * 100);

    const productName = (description && description.trim()) ||
      (paymentIndex ? `Payment ${paymentIndex}` : "Portal payment");

    // Look up (or create) a Stripe Customer for the logged-in email.
    // Passing `customer` (rather than `customer_email`) makes Stripe Checkout
    // render the email as read-only on the payment form, so the parent can't
    // change it mid-flow and break reconciliation against the HubSpot deal.
    let customerId;
    try {
      customerId = await findOrCreateStripeCustomer(email, process.env.STRIPE_SECRET_KEY);
    } catch (err) {
      console.error("Stripe customer lookup/create failed:", err);
      return {
        statusCode: 502,
        body: JSON.stringify({
          error: "Could not resolve a Stripe customer for this email",
          details: err.message
        })
      };
    }

    // Build the request body Stripe expects: form-urlencoded with bracket
    // notation for nested fields (e.g. line_items[0][price_data][currency]).
    const params = new URLSearchParams();
    params.append("mode", "payment");
    params.append("payment_method_types[]", "card");
    params.append("customer", customerId);
    // When `customer` is set, Stripe locks the email field but by default
    // won't update name/address on the customer record. Tell it to merge
    // any new info collected at checkout back onto the saved customer.
    params.append("customer_update[address]", "auto");
    params.append("customer_update[name]", "auto");
    params.append("allow_promotion_codes", "false");

    params.append("line_items[0][quantity]", "1");
    params.append("line_items[0][price_data][currency]", currency);
    params.append("line_items[0][price_data][unit_amount]", String(unitAmountCents));
    params.append("line_items[0][price_data][product_data][name]", productName);

    const successQuery = paymentIndex ? `paid=${encodeURIComponent(paymentIndex)}` : "paid=1";
    params.append("success_url", `${origin}/index.html?${successQuery}&session_id={CHECKOUT_SESSION_ID}`);
    params.append("cancel_url", `${origin}/index.html`);

    // Metadata so the merchant can reconcile the Stripe charge against the
    // portal schedule on the receiving end (webhooks, dashboard, etc.).
    params.append("metadata[contact_email]", email);
    if (paymentIndex != null) params.append("metadata[payment_index]", String(paymentIndex));
    if (baseAmount != null && baseAmount !== "") {
      params.append("metadata[base_amount]", String(baseAmount));
    }
    params.append("metadata[charge_amount]", String(charge));
    params.append("metadata[processing_fee_rate]", "0.03");
    params.append("metadata[source]", "unearthed-portal-row-click");

    // Mirror metadata onto the PaymentIntent so it shows on the underlying
    // charge as well (useful for HubSpot's Stripe sync if you have one).
    params.append("payment_intent_data[metadata][contact_email]", email);
    if (paymentIndex != null) {
      params.append("payment_intent_data[metadata][payment_index]", String(paymentIndex));
    }
    if (baseAmount != null && baseAmount !== "") {
      params.append("payment_intent_data[metadata][base_amount]", String(baseAmount));
    }
    params.append("payment_intent_data[metadata][charge_amount]", String(charge));
    params.append("payment_intent_data[metadata][processing_fee_rate]", "0.03");

    const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });

    const data = await stripeRes.json();

    if (!stripeRes.ok) {
      console.error("Stripe checkout creation failed:", data);
      return {
        statusCode: 502,
        body: JSON.stringify({
          error: data?.error?.message || "Stripe checkout creation failed",
          stripeErrorType: data?.error?.type || null,
          stripeErrorCode: data?.error?.code || null
        })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ url: data.url, id: data.id })
    };

  } catch (err) {
    console.error("ERROR:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
}

// Returns a Stripe Customer ID for the given email — reusing an existing one
// where possible, or creating a new one. Using a Customer (rather than just
// `customer_email`) is what locks the email field on the Checkout page.
async function findOrCreateStripeCustomer(email, secretKey) {
  const cleanEmail = String(email).trim().toLowerCase();

  // 1. Look up existing customer(s) with this email.
  const lookupRes = await fetch(
    `https://api.stripe.com/v1/customers?email=${encodeURIComponent(cleanEmail)}&limit=1`,
    { headers: { Authorization: `Bearer ${secretKey}` } }
  );
  const lookupData = await lookupRes.json();

  if (!lookupRes.ok) {
    throw new Error(
      "Stripe customer lookup failed: " +
      (lookupData?.error?.message || `HTTP ${lookupRes.status}`)
    );
  }

  if (Array.isArray(lookupData.data) && lookupData.data.length > 0) {
    return lookupData.data[0].id;
  }

  // 2. None found — create one.
  const createParams = new URLSearchParams();
  createParams.append("email", cleanEmail);
  createParams.append("metadata[source]", "unearthed-portal");

  const createRes = await fetch("https://api.stripe.com/v1/customers", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: createParams.toString()
  });
  const createData = await createRes.json();

  if (!createRes.ok || !createData.id) {
    throw new Error(
      "Stripe customer create failed: " +
      (createData?.error?.message || `HTTP ${createRes.status}`)
    );
  }

  return createData.id;
}
