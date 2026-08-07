"use strict";

const crypto = require("node:crypto");

const ADMIN_PERMISSIONS = Object.freeze([
    "bookings:read",
    "bookings:write",
    "bookings:email",
    "bookings:capacity"
]);

function randomToken() {
    return crypto.randomBytes(32).toString("base64url");
}

function parseCookies(header) {
    return String(header || "").split(";").reduce((cookies, part) => {
        const separator = part.indexOf("=");
        if (separator < 1) return cookies;
        const name = part.slice(0, separator).trim();
        const value = part.slice(separator + 1).trim();
        try {
            cookies[name] = decodeURIComponent(value);
        } catch {
            cookies[name] = "";
        }
        return cookies;
    }, {});
}

function safeEqual(left, right) {
    const leftHash = crypto.createHash("sha256").update(String(left || "")).digest();
    const rightHash = crypto.createHash("sha256").update(String(right || "")).digest();
    return crypto.timingSafeEqual(leftHash, rightHash);
}

class SessionAuth {
    constructor(options = {}) {
        this.adminPassword = options.adminPassword ?? process.env.BOOKING_ADMIN_PASSWORD ?? "";
        this.adminActor = options.adminActor ?? process.env.BOOKING_ADMIN_USERNAME ?? "Waterloo Inn admin";
        this.secureCookies = Boolean(options.secureCookies);
        this.allowedOrigin = new URL(options.publicUrl || "http://127.0.0.1:8888").origin;
        this.adminTtlMs = Number(options.adminTtlMs || 8 * 60 * 60 * 1000);
        this.manageTtlMs = Number(options.manageTtlMs || 30 * 60 * 1000);
        this.adminSessions = new Map();
        this.manageSessions = new Map();
    }

    isAdminConfigured() {
        return this.adminPassword.length >= 12;
    }

    verifyAdminPassword(password) {
        return this.isAdminConfigured() && safeEqual(password, this.adminPassword);
    }

    createAdminSession() {
        this.pruneSessions(this.adminSessions);
        const id = randomToken();
        const session = {
            id,
            csrf: randomToken(),
            actor: this.adminActor,
            role: "admin",
            permissions: new Set(ADMIN_PERMISSIONS),
            expiresAt: Date.now() + this.adminTtlMs
        };
        this.adminSessions.set(id, session);
        return session;
    }

    createManageSession(bookingId) {
        this.pruneSessions(this.manageSessions);
        const id = randomToken();
        const session = {
            id,
            csrf: randomToken(),
            bookingId,
            expiresAt: Date.now() + this.manageTtlMs
        };
        this.manageSessions.set(id, session);
        return session;
    }

    getAdminSession(request) {
        return this.getSession(this.adminSessions, parseCookies(request.headers.cookie).wi_admin_session);
    }

    getManageSession(request) {
        return this.getSession(this.manageSessions, parseCookies(request.headers.cookie).wi_manage_session);
    }

    getSession(collection, id) {
        this.pruneSessions(collection);
        if (!id) return null;
        const session = collection.get(id) || null;
        if (!session) return null;
        if (session.expiresAt <= Date.now()) {
            collection.delete(id);
            return null;
        }
        return session;
    }

    pruneSessions(collection) {
        const now = Date.now();
        for (const [id, session] of collection) {
            if (session.expiresAt <= now) collection.delete(id);
        }
        while (collection.size >= 10_000) {
            collection.delete(collection.keys().next().value);
        }
    }

    destroyAdminSession(request) {
        const id = parseCookies(request.headers.cookie).wi_admin_session;
        if (id) this.adminSessions.delete(id);
    }

    destroyManageSession(request) {
        const id = parseCookies(request.headers.cookie).wi_manage_session;
        if (id) this.manageSessions.delete(id);
    }

    adminCookie(session) {
        return this.cookie("wi_admin_session", session.id, Math.floor(this.adminTtlMs / 1000));
    }

    manageCookie(session) {
        return this.cookie("wi_manage_session", session.id, Math.floor(this.manageTtlMs / 1000));
    }

    clearAdminCookie() {
        return this.cookie("wi_admin_session", "", 0);
    }

    clearManageCookie() {
        return this.cookie("wi_manage_session", "", 0);
    }

    cookie(name, value, maxAge) {
        return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}` +
            (this.secureCookies ? "; Secure" : "");
    }

    assertSameOrigin(request) {
        const fetchSite = String(request.headers["sec-fetch-site"] || "");
        if (fetchSite === "cross-site") throw forbidden("Cross-site requests are not allowed.");
        const origin = request.headers.origin;
        if (origin && origin !== this.allowedOrigin) throw forbidden("Request origin is not allowed.");
    }

    requireAdmin(request, permission = "bookings:read") {
        const session = this.getAdminSession(request);
        if (!session) throw unauthorized("Admin authentication is required.");
        if (!session.permissions.has(permission)) throw forbidden("This account cannot perform that action.");
        return session;
    }

    requireManage(request) {
        const session = this.getManageSession(request);
        if (!session) throw unauthorized("Your secure booking session has expired. Please reopen the email link.");
        return session;
    }

    requireCsrf(request, session) {
        this.assertSameOrigin(request);
        if (!safeEqual(request.headers["x-csrf-token"], session.csrf)) {
            throw forbidden("The security token for this request is missing or invalid.");
        }
    }
}

function unauthorized(message) {
    return Object.assign(new Error(message), { status: 401, code: "AUTH_REQUIRED" });
}

function forbidden(message) {
    return Object.assign(new Error(message), { status: 403, code: "FORBIDDEN" });
}

module.exports = { ADMIN_PERMISSIONS, SessionAuth, parseCookies, safeEqual };
