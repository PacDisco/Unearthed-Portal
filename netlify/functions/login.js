import { createToken } from "./_shared/auth.js";
import { verifyPassword, hashPassword } from "./_shared/password.js";

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
      return {
        statusCode: 200,
        body: JSON.stringify({ success: false, error: GENERIC_FAIL })
      };
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
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
}
