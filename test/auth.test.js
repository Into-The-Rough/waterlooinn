"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { SessionAuth } = require("../booking/auth");

function request(headers = {}) {
    return { headers };
}

function token(payload = {}) {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
        exp: Math.floor(Date.now() / 1000) + 3600,
        ...payload
    })}.test-signature`;
}

function response(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    };
}

test("admin authentication verifies the existing invite-only Netlify Identity", async () => {
    const accessToken = token();
    const calls = [];
    const auth = new SessionAuth({
        publicUrl: "https://example.com",
        identityUrl: "https://example.com/.netlify/identity",
        fetch: async (url, options) => {
            calls.push({ url, options });
            if (url.endsWith("/settings")) return response(200, { disable_signup: true });
            return response(200, {
                id: "identity-1",
                email: "manager@example.com",
                user_metadata: { full_name: "Waterloo Manager" },
                app_metadata: { roles: [] }
            });
        }
    });

    const authenticated = await auth.requireAdmin(request({
        authorization: `Bearer ${accessToken}`
    }), "bookings:write");

    assert.equal(authenticated.actor, "Waterloo Manager");
    assert.equal(authenticated.email, "manager@example.com");
    assert.ok(authenticated.permissions.has("bookings:write"));
    assert.equal(calls[0].options.headers.Authorization, `Bearer ${accessToken}`);
    assert.match(calls[0].url, /\/user$/);
    assert.match(calls[1].url, /\/settings$/);
});

test("admin authentication rejects invalid users and missing configured roles", async () => {
    const accessToken = token();
    const invalid = new SessionAuth({
        identityUrl: "https://example.com/.netlify/identity",
        fetch: async () => response(401, {})
    });
    await assert.rejects(
        invalid.requireAdmin(request({ authorization: `Bearer ${accessToken}` })),
        /authentication is required/
    );

    const wrongRole = new SessionAuth({
        identityUrl: "https://example.com/.netlify/identity",
        adminRoles: ["booking-admin"],
        fetch: async () => response(200, {
            id: "identity-2",
            email: "editor@example.com",
            app_metadata: { roles: ["editor"] }
        })
    });
    await assert.rejects(
        wrongRole.requireAdmin(request({ authorization: `Bearer ${accessToken}` })),
        /cannot access/
    );

    const openRegistration = new SessionAuth({
        identityUrl: "https://example.com/.netlify/identity",
        fetch: async (url) => url.endsWith("/settings")
            ? response(200, { disable_signup: false })
            : response(200, {
                id: "identity-3",
                email: "visitor@example.com",
                app_metadata: { roles: [] }
            })
    });
    await assert.rejects(
        openRegistration.requireAdmin(request({ authorization: `Bearer ${accessToken}` })),
        /invite-only Identity/
    );
});

test("admin mutations and customer sessions retain same-origin CSRF controls", () => {
    const auth = new SessionAuth({
        publicUrl: "https://example.com",
        identityUrl: "https://example.com/.netlify/identity",
        manageTtlMs: 20
    });
    assert.throws(() => auth.assertSameOrigin(request({
        origin: "https://attacker.example"
    })), /origin/);
    assert.doesNotThrow(() => auth.assertSameOrigin(request({
        origin: "https://example.com"
    })));

    const session = auth.createManageSession("booking-1");
    assert.throws(() => auth.requireCsrf(request({
        origin: "https://example.com",
        "x-csrf-token": "wrong"
    }), session), /missing or invalid/);
    const managed = auth.requireManage(request({ cookie: `wi_manage_session=${session.id}` }));
    assert.equal(managed.bookingId, "booking-1");
});
