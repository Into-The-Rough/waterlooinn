"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { SessionAuth } = require("../booking/auth");

function request(headers = {}) {
    return { headers };
}

test("admin authentication requires the configured password and permission", () => {
    const auth = new SessionAuth({
        adminPassword: "a-long-test-password",
        publicUrl: "https://example.com",
        secureCookies: true
    });
    assert.equal(auth.verifyAdminPassword("wrong"), false);
    assert.equal(auth.verifyAdminPassword("a-long-test-password"), true);
    const session = auth.createAdminSession();
    const authenticated = auth.requireAdmin(request({ cookie: `wi_admin_session=${session.id}` }), "bookings:write");
    assert.equal(authenticated.role, "admin");
    assert.match(auth.adminCookie(session), /HttpOnly; SameSite=Strict/);
    assert.match(auth.adminCookie(session), /; Secure/);
});

test("admin mutations require same-origin CSRF proof", () => {
    const auth = new SessionAuth({
        adminPassword: "a-long-test-password",
        publicUrl: "https://example.com"
    });
    const session = auth.createAdminSession();
    assert.throws(() => auth.requireCsrf(request({
        origin: "https://attacker.example",
        "x-csrf-token": session.csrf
    }), session), /origin/);
    assert.throws(() => auth.requireCsrf(request({
        origin: "https://example.com",
        "x-csrf-token": "wrong"
    }), session), /missing or invalid/);
    assert.doesNotThrow(() => auth.requireCsrf(request({
        origin: "https://example.com",
        "x-csrf-token": session.csrf
    }), session));
});

test("customer management sessions are short lived and booking scoped", () => {
    const auth = new SessionAuth({
        publicUrl: "https://example.com",
        manageTtlMs: 20
    });
    const session = auth.createManageSession("booking-1");
    const managed = auth.requireManage(request({ cookie: `wi_manage_session=${session.id}` }));
    assert.equal(managed.bookingId, "booking-1");
});
