import { createToken } from "./_shared/auth.js";
import { verifyPassword, hashPassword } from "./_shared/password.js";

// ----- Brute-force throttle (fail-open) -----
// Locks an account for LOCK_MS after MAX_FAILS consecutive wrong passwords.
// Backed by two HubSpot contact number properties:
//   portal_failed_logins   (running count of recent failures)
//   portal_lockout_until   (epoch ms; while now < this value, login is blocked)
// IMPORTANT: if those properties don't exist yet, every call below silently
// no-ops, so login keeps working exactly as before until they're created.
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000; // 15 minutes

function hsHeaders() {
  return {
    Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
    "Content-Type": "application/json"
  };
}

async function readThrottle(contactId) {
  try {
    const r = await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}?properties=portal_failed_logins,portal_lockout_until`,
      { headers: hsHeaders() }
    );
    if (!r.ok) return { fails: 0, lockedUntil: 0, available: false };
    const d = await r.json();
    return {
      fails: parseInt(d.properties?.portal_failed_logins || "0", 10) || 0,
      lockedUntil: parseInt(d.properties?.portal_lockout_until || "0", 10) || 0,
      available: true
    };
  } catch (_) {
    return { fails: 0, lockedUntil: 0, available: false };
  }
}

async function writeThrottle(contactId, props) {
  try {
    await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`, {
      method: "PATCH",
      headers: hsHeaders(),
      body: JSON.stringify({ properties: props })
    });
  } catch (_) { /* fail-open: never block login on a throttle write */ }
}

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
          // admin_role + firstname are returned to the browser so the
          // login page can route admins straight to /admin.html and
          // greet by name. portal_password is what we authenticate against.
          properties: ["email", "portal_password", "admin_role", "firstname"]
        })
      }
    );

    const contactData = await contactRes.json();
    const contact = contactData.results?.[0];

    // Generic message for both "no such email" and "wrong password" so an
    // outsider can't probe which email addresses have portal accounts.
    const GENERIC_FAIL = "Incorrect email or password.";

    if (!contact) {
      return {
        statusCode: 200,
        body: JSON.stringify({ success: false, error: GENERIC_FAIL })
      };
    }

    // Reject early if this account is currently locked out from too many
    // recent failed attempts. (No-op until the HubSpot properties exist.)
    const throttle = contact.id
      ? await readThrottle(contact.id)
      : { fails: 0, lockedUntil: 0, available: false };
    if (throttle.lockedUntil && Date.now() < throttle.lockedUntil) {
      return {
        statusCode: 429,
        body: JSON.stringify({
          success: false,
          error: "Too many attempts. Please wait a few minutes and try again, or use the magic link."
        })
      };
    }

    const storedPassword = contact.properties?.portal_password;

    // Kept as a distinct signal: the login page shows a "use the magic link"
    // hint for accounts that exist but have never set a password.
    if (!storedPassword) {
      return {
        statusCode: 200,
        body: JSON.stringify({ success: false, error: "no_password" })
      };
    }

    // Verify against the stored value, which may be a scrypt hash or (for
    // not-yet-migrated accounts) legacy plaintext.
    const { ok, legacy } = await verifyPassword(password, storedPassword);
    if (!ok) {
      // Count the failure; lock the account once it crosses the threshold.
      if (throttle.available && contact.id) {
        const fails = throttle.fails + 1;
        if (fails >= MAX_FAILS) {
          await writeThrottle(contact.id, {
            portal_failed_logins: "0",
            portal_lockout_until: String(Date.now() + LOCK_MS)
          });
        } else {
          await writeThrottle(contact.id, { portal_failed_logins: String(fails) });
        }
      }
      return {
        statusCode: 200,
        body: JSON.stringify({ success: false, error: GENERIC_FAIL })
      };
    }

    // Successful login — clear any accumulated failure count / lockout.
    if (throttle.available && contact.id && (throttle.fails > 0 || throttle.lockedUntil)) {
      await writeThrottle(contact.id, { portal_failed_logins: "0", portal_lockout_until: "0" });
    }

    // Transparent migration: if this account still had a plaintext password,
    // re-save it as a hash now that we've confirmed the cleartext. Best-effort
    // — a failure here must not block a valid login.
    if (legacy && contact.id) {
      try {
        const newHash = await hashPassword(password);
        await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${contact.id}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ properties: { portal_password: newHash } })
        });
      } catch (e) {
        console.warn("[login] password hash upgrade failed (non-fatal):", e?.message || e);
      }
    }

    const adminRole = contact.properties?.admin_role || null;

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        email: cleanEmail,
        // Signed session token. The browser stores this and sends it on
        // every subsequent request (Authorization: Bearer …). The server
        // verifies it instead of trusting a caller-supplied email/role.
        token: createToken({ email: cleanEmail, role: adminRole }),
        // Optional fields. The login page checks adminRole to decide
        // whether to land the user on /admin.html or the regular portal.
        adminRole,
        firstName: contact.properties?.firstname || null
      })
    };

  } catch (err) {
    console.error("[login] error:", err?.message || err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server error" })
    };
  }
}
