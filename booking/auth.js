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
        this.secureCookies = Boolean(options.secureCookies);
        this.allowedOrigin = new URL(options.publicUrl || "http://127.0.0.1:8888").origin;
        this.identityUrl = String(options.identityUrl ?? process.env.BOOKING_IDENTITY_URL ??
            "https://waterlooinnbiggin.com/.netlify/identity").replace(/\/$/, "");
        this.adminRoles = options.adminRoles ?? String(process.env.BOOKING_ADMIN_ROLES || "")
            .split(",").map((role) => role.trim()).filter(Boolean);
        this.fetch = options.fetch ?? globalThis.fetch;
        this.now = options.now ?? (() => Date.now());
        this.identityCacheMs = Number(options.identityCacheMs ?? 30_000);
        this.identityCache = new Map();
        this.identitySettings = null;
        this.manageTtlMs = Number(options.manageTtlMs || 30 * 60 * 1000);
        this.manageSessions = new Map();
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

    destroyManageSession(request) {
        const id = parseCookies(request.headers.cookie).wi_manage_session;
        if (id) this.manageSessions.delete(id);
    }

    manageCookie(session) {
        return this.cookie("wi_manage_session", session.id, Math.floor(this.manageTtlMs / 1000));
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

    bearerToken(request) {
        const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(String(request.headers.authorization || ""));
        if (!match || match[1].length > 8192) return null;
        return match[1];
    }

    pruneIdentityCache() {
        const now = this.now();
        for (const [key, entry] of this.identityCache) {
            if (entry.expiresAt <= now) this.identityCache.delete(key);
        }
        while (this.identityCache.size >= 1_000) {
            this.identityCache.delete(this.identityCache.keys().next().value);
        }
    }

    async getIdentitySettings() {
        const now = this.now();
        if (this.identitySettings?.expiresAt > now) return this.identitySettings.value;
        const response = await this.identityFetch(`${this.identityUrl}/settings`, {});
        if (!response.ok) throw authUnavailable();
        const value = await response.json();
        this.identitySettings = { value, expiresAt: now + 30_000 };
        return value;
    }

    async identityFetch(url, options) {
        try {
            return await this.fetch(url, {
                ...options,
                signal: AbortSignal.timeout(5_000)
            });
        } catch {
            throw authUnavailable();
        }
    }

    tokenExpiry(token) {
        try {
            const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
            return Number(payload.exp) * 1000;
        } catch {
            return 0;
        }
    }

    async getAdminSession(request) {
        const token = this.bearerToken(request);
        if (!token) return null;
        this.pruneIdentityCache();
        const cacheKey = crypto.createHash("sha256").update(token).digest("hex");
        const cached = this.identityCache.get(cacheKey);
        if (cached?.expiresAt > this.now()) return cached.session;

        const response = await this.identityFetch(`${this.identityUrl}/user`, {
            headers: { "Authorization": `Bearer ${token}` }
        });
        if (response.status === 401 || response.status === 403) return null;
        if (!response.ok) throw authUnavailable();
        const user = await response.json();
        const roles = Array.isArray(user.app_metadata?.roles) ? user.app_metadata.roles : [];
        if (this.adminRoles.length) {
            if (!roles.some((role) => this.adminRoles.includes(role))) {
                throw forbidden("This Identity account cannot access the booking diary.");
            }
        } else {
            const settings = await this.getIdentitySettings();
            if (settings.disable_signup !== true) {
                throw forbidden("Booking access requires invite-only Identity or configured admin roles.");
            }
        }
        const session = {
            identityId: user.id,
            actor: user.user_metadata?.full_name || user.email || "Waterloo Inn admin",
            email: user.email || "",
            role: roles[0] || "identity-user",
            permissions: new Set(ADMIN_PERMISSIONS)
        };
        const tokenExpiry = this.tokenExpiry(token);
        const expiresAt = Math.min(this.now() + this.identityCacheMs, tokenExpiry || Number.MAX_SAFE_INTEGER);
        this.identityCache.set(cacheKey, { session, expiresAt });
        return session;
    }

    async requireAdmin(request, permission = "bookings:read") {
        const session = await this.getAdminSession(request);
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

function authUnavailable() {
    return Object.assign(new Error("The admin identity service is temporarily unavailable."), {
        status: 503,
        code: "IDENTITY_UNAVAILABLE"
    });
}

module.exports = { ADMIN_PERMISSIONS, SessionAuth, parseCookies, safeEqual };
