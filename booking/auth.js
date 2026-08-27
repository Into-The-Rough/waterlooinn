"use strict";

const crypto = require("node:crypto");

const ADMIN_PERMISSIONS = Object.freeze([
    "bookings:read",
    "bookings:write",
    "bookings:email",
    "bookings:capacity"
]);

const DEFAULT_ADMIN_SESSION_DAYS = 30;
const SCRYPT_KEY_LENGTH = 32;

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

function parsePasswordHash(value) {
    const parts = String(value || "").split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return null;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isInteger(N) || N < 1_024 || N > 65_536 || (N & (N - 1)) !== 0) return null;
    if (!Number.isInteger(r) || r < 1 || r > 16) return null;
    if (!Number.isInteger(p) || p < 1 || p > 4) return null;
    try {
        const salt = Buffer.from(parts[4], "base64url");
        const digest = Buffer.from(parts[5], "base64url");
        if (salt.length < 16 || digest.length !== SCRYPT_KEY_LENGTH) return null;
        return { N, r, p, salt, digest };
    } catch {
        return null;
    }
}

function derivePassword(password, parsed) {
    const maxmem = Math.max(32 * 1024 * 1024, (128 * parsed.N * parsed.r) + (2 * 1024 * 1024));
    return new Promise((resolve, reject) => {
        crypto.scrypt(String(password), parsed.salt, parsed.digest.length, {
            N: parsed.N,
            r: parsed.r,
            p: parsed.p,
            maxmem
        }, (error, derived) => error ? reject(error) : resolve(derived));
    });
}

async function verifyPassword(password, storedHash) {
    const parsed = parsePasswordHash(storedHash);
    if (!parsed) return false;
    const derived = await derivePassword(password, parsed);
    return crypto.timingSafeEqual(derived, parsed.digest);
}

async function hashPassword(password, options = {}) {
    const value = String(password || "");
    if (!value || value.length > 1_024) throw new Error("Password must contain between 1 and 1024 characters.");
    const N = Number(options.N || 16_384);
    const r = Number(options.r || 8);
    const p = Number(options.p || 1);
    const salt = options.salt ? Buffer.from(options.salt) : crypto.randomBytes(16);
    const parsed = { N, r, p, salt, digest: Buffer.alloc(SCRYPT_KEY_LENGTH) };
    if (!parsePasswordHash(`scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${parsed.digest.toString("base64url")}`)) {
        throw new Error("Invalid scrypt password-hashing parameters.");
    }
    const digest = await derivePassword(value, parsed);
    return `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${digest.toString("base64url")}`;
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
        this.sessionSecret = String(options.sessionSecret ?? process.env.BOOKING_SESSION_SECRET ?? "");
        this.manageSessions = new Map();
        this.basicUsername = String(options.basicUsername ??
            process.env.BOOKING_BASIC_AUTH_USERNAME ?? "").trim();
        this.basicPasswordHash = String(options.basicPasswordHash ??
            process.env.BOOKING_BASIC_AUTH_PASSWORD_HASH ?? "").trim();
        const configuredActor = String(options.basicActor ??
            process.env.BOOKING_BASIC_AUTH_ACTOR ?? "").trim();
        this.basicActor = configuredActor || this.basicUsername || "Booking diary";
        const configuredDays = Number(options.adminSessionDays ??
            process.env.BOOKING_BASIC_AUTH_SESSION_DAYS ?? DEFAULT_ADMIN_SESSION_DAYS);
        const sessionDays = Number.isFinite(configuredDays)
            ? Math.min(90, Math.max(1, configuredDays))
            : DEFAULT_ADMIN_SESSION_DAYS;
        this.adminTtlMs = Number(options.adminTtlMs ?? sessionDays * 24 * 60 * 60 * 1000);
    }

    createManageSession(bookingId) {
        if (this.sessionSecret) {
            const session = {
                csrf: randomToken(),
                bookingId,
                expiresAt: this.now() + this.manageTtlMs
            };
            session.id = this.signManageSession(session);
            return session;
        }
        this.pruneSessions(this.manageSessions);
        const id = randomToken();
        const session = {
            id,
            csrf: randomToken(),
            bookingId,
            expiresAt: this.now() + this.manageTtlMs
        };
        this.manageSessions.set(id, session);
        return session;
    }

    getManageSession(request) {
        const id = parseCookies(request.headers.cookie).wi_manage_session;
        return this.sessionSecret ? this.verifyManageSession(id) : this.getSession(this.manageSessions, id);
    }

    signManageSession(session) {
        const payload = Buffer.from(JSON.stringify({
            bookingId: session.bookingId,
            csrf: session.csrf,
            expiresAt: session.expiresAt
        })).toString("base64url");
        const signature = crypto.createHmac("sha256", this.sessionSecret).update(payload).digest("base64url");
        return `${payload}.${signature}`;
    }

    verifyManageSession(token) {
        if (!token || token.length > 4096) return null;
        const separator = token.lastIndexOf(".");
        if (separator < 1) return null;
        const payload = token.slice(0, separator);
        const signature = token.slice(separator + 1);
        const expected = crypto.createHmac("sha256", this.sessionSecret).update(payload).digest("base64url");
        if (!safeEqual(signature, expected)) return null;
        try {
            const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
            if (typeof session.bookingId !== "string" || typeof session.csrf !== "string" ||
                !Number.isFinite(session.expiresAt) || session.expiresAt <= this.now()) {
                return null;
            }
            return { ...session, id: token };
        } catch {
            return null;
        }
    }

    getSession(collection, id) {
        this.pruneSessions(collection);
        if (!id) return null;
        const session = collection.get(id) || null;
        if (!session) return null;
        if (session.expiresAt <= this.now()) {
            collection.delete(id);
            return null;
        }
        return session;
    }

    pruneSessions(collection) {
        const now = this.now();
        for (const [id, session] of collection) {
            if (session.expiresAt <= now) collection.delete(id);
        }
        while (collection.size >= 10_000) {
            collection.delete(collection.keys().next().value);
        }
    }

    destroyManageSession(request) {
        if (this.sessionSecret) return;
        const id = parseCookies(request.headers.cookie).wi_manage_session;
        if (id) this.manageSessions.delete(id);
    }

    manageCookie(session) {
        return this.cookie("wi_manage_session", session.id, Math.floor(this.manageTtlMs / 1000));
    }

    clearManageCookie() {
        return this.cookie("wi_manage_session", "", 0);
    }

    basicAuthConfigured() {
        return Boolean(this.basicUsername && parsePasswordHash(this.basicPasswordHash) && this.sessionSecret);
    }

    basicCredentialVersion() {
        return crypto.createHash("sha256")
            .update(`${this.basicUsername}\n${this.basicPasswordHash}`)
            .digest("base64url").slice(0, 22);
    }

    async authenticateBasic(username, password) {
        if (!this.basicAuthConfigured()) throw basicAuthUnavailable();
        const suppliedUsername = String(username || "").trim();
        const suppliedPassword = String(password || "");
        if (suppliedUsername.length > 128 || suppliedPassword.length > 1_024) return null;

        // Always perform the password derivation so an invalid username is not a cheaper request.
        const passwordMatches = await verifyPassword(suppliedPassword, this.basicPasswordHash);
        if (!safeEqual(suppliedUsername.toLowerCase(), this.basicUsername.toLowerCase()) || !passwordMatches) {
            return null;
        }

        const session = {
            username: this.basicUsername,
            expiresAt: this.now() + this.adminTtlMs,
            version: this.basicCredentialVersion()
        };
        session.id = this.signAdminSession(session);
        return this.basicAdminSession(session);
    }

    signAdminSession(session) {
        const payload = Buffer.from(JSON.stringify({
            username: session.username,
            expiresAt: session.expiresAt,
            version: session.version
        })).toString("base64url");
        const signature = crypto.createHmac("sha256", this.sessionSecret)
            .update(`admin.${payload}`).digest("base64url");
        return `${payload}.${signature}`;
    }

    verifyAdminSession(token) {
        if (!this.basicAuthConfigured() || !token || token.length > 4_096) return null;
        const separator = token.lastIndexOf(".");
        if (separator < 1) return null;
        const payload = token.slice(0, separator);
        const signature = token.slice(separator + 1);
        const expected = crypto.createHmac("sha256", this.sessionSecret)
            .update(`admin.${payload}`).digest("base64url");
        if (!safeEqual(signature, expected)) return null;
        try {
            const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
            if (!safeEqual(session.username, this.basicUsername) ||
                !safeEqual(session.version, this.basicCredentialVersion()) ||
                !Number.isFinite(session.expiresAt) || session.expiresAt <= this.now()) {
                return null;
            }
            return this.basicAdminSession({ ...session, id: token });
        } catch {
            return null;
        }
    }

    basicAdminSession(session) {
        return {
            ...session,
            identityId: `basic:${this.basicUsername}`,
            actor: this.basicActor,
            email: "",
            role: "booking-user",
            authMethod: "password",
            permissions: new Set(ADMIN_PERMISSIONS)
        };
    }

    adminCookie(session) {
        const maxAge = Math.max(0, Math.floor((session.expiresAt - this.now()) / 1000));
        return this.cookie("wi_admin_session", session.id, maxAge);
    }

    clearAdminCookie() {
        return this.cookie("wi_admin_session", "", 0);
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
        const cookieSession = this.verifyAdminSession(parseCookies(request.headers.cookie).wi_admin_session);
        if (cookieSession) return cookieSession;
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

function basicAuthUnavailable() {
    return Object.assign(new Error("Password sign-in is not configured for the booking diary."), {
        status: 503,
        code: "BASIC_AUTH_UNAVAILABLE"
    });
}

module.exports = {
    ADMIN_PERMISSIONS,
    SessionAuth,
    hashPassword,
    parseCookies,
    safeEqual,
    verifyPassword
};
