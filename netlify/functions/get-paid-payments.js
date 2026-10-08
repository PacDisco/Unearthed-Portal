// Returns every payment recorded on the contact's most recent Deal
// (payment_1..15), and — when a portalId is given — how those payments apply
// to that trip's schedule (which rows are paid, part paid or outstanding).
// The parsing and the allocation live in _shared/payment-schedule.js, which
// create-checkout-session.js also uses, so what's shown and what's charged
// always agree.
//
// Query: ?email=<student email>&portalId=<trip id, optional>

import { authenticateSelf, isAdmin } from "./_shared/auth.js";
import {
  fetchDealPayments, resolvePortalForEmail, loadSchedule, allocateSchedule
} from "./_shared/payment-schedule.js";

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});

export async function handler(event) {
  try {
    const { email, portalId } = event.queryStringParameters || {};
    if (!email) return json(400, { error: "Missing email" });

    // Auth: you may only read your own payment data (admins may read any).
    const auth = await authenticateSelf(event, email);
    if (auth.response) return auth.response;

    const cleanEmail = String(email).toLowerCase().trim();
    const deal = await fetchDealPayments(cleanEmail);

    let allocation = null;
    if (portalId) {
      const tripId = await resolvePortalForEmail({
        email: cleanEmail,
        portalId: String(portalId),
        admin: isAdmin(auth.session)
      });
      const schedule = await loadSchedule(tripId);
      allocation = allocateSchedule(schedule.rows, deal.payments);
    }

    return json(200, { ...deal, allocation });
  } catch (err) {
    if (err && err.statusCode) return json(err.statusCode, { error: err.message, payments: [] });
    console.error("[get-paid-payments] ERROR:", err);
    return json(500, { error: "Server error" });
  }
}
