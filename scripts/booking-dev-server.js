"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");
const { SessionAuth } = require("../booking/auth");
const { BookingStore } = require("../booking/store");
const { BookingService } = require("../booking/service");
const { EmailService } = require("../booking/email-service");

const projectRoot = path.resolve(__dirname, "..");
const siteRoot = path.join(projectRoot, "_site");
const databasePath = process.env.BOOKING_DATABASE_PATH ||
    path.join(projectRoot, ".local", "booking-diary.sqlite");
const port = Number(process.env.BOOKING_PORT || 8888);
const host = process.env.BOOKING_HOST || "127.0.0.1";
const publicUrl = process.env.BOOKING_PUBLIC_URL || `http://${host}:${port}`;
const identityUrl = process.env.BOOKING_IDENTITY_URL ||
    "https://waterlooinnbiggin.com/.netlify/identity";
const identityOrigin = new URL(identityUrl).origin;
const isProduction = process.env.NODE_ENV === "production";
const trustProxy = process.env.BOOKING_TRUST_PROXY === "true";

if (isProduction) {
    if (new URL(publicUrl).protocol !== "https:") {
        throw new Error("BOOKING_PUBLIC_URL must use HTTPS in production.");
    }
    if (!trustProxy) {
        throw new Error("BOOKING_TRUST_PROXY=true is required behind the production HTTPS proxy.");
    }
    if (!process.env.RESEND_API_KEY) {
        throw new Error("RESEND_API_KEY is required for production email verification.");
    }
    if (!process.env.BOOKING_DATABASE_PATH) {
        throw new Error("BOOKING_DATABASE_PATH must point to persistent storage in production.");
    }
    if (new URL(identityUrl).protocol !== "https:") {
        throw new Error("BOOKING_IDENTITY_URL must use HTTPS in production.");
    }
}

const store = new BookingStore(databasePath);
const mailer = new EmailService(store, {
    publicUrl
});
const service = new BookingService(store, mailer);
const auth = new SessionAuth({
    publicUrl,
    identityUrl,
    secureCookies: new URL(publicUrl).protocol === "https:"
});
const MIME_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp"
};

function sendJson(response, status, payload, extraHeaders = {}) {
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...extraHeaders
    });
    response.end(JSON.stringify(payload));
}

function sendError(response, error) {
    const status = Number(error.status) || 500;
    if (status >= 500 && error.code !== "ONLINE_BOOKINGS_CLOSED") console.error(error);
    sendJson(response, status, {
        error: {
            code: error.code || (status === 500 ? "SERVER_ERROR" : "REQUEST_ERROR"),
            message: status === 500 ? "Something went wrong. Please try again." : error.message,
            field: error.field || null,
            suggestion: error.suggestion || null
        }
    });
}

function readJson(request) {
    return new Promise((resolve, reject) => {
        if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
            return reject(Object.assign(new Error("Content-Type must be application/json."), {
                status: 415,
                code: "UNSUPPORTED_MEDIA_TYPE"
            }));
        }
        let body = "";
        let tooLarge = false;
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
            if (tooLarge) return;
            body += chunk;
            if (Buffer.byteLength(body, "utf8") > 65536) {
                tooLarge = true;
                body = "";
                reject(Object.assign(new Error("Request is too large."), { status: 413 }));
            }
        });
        request.on("end", () => {
            if (tooLarge) return;
            if (!body) return resolve({});
            try {
                resolve(JSON.parse(body));
            } catch {
                reject(Object.assign(new Error("Invalid request data."), { status: 400 }));
            }
        });
        request.on("error", reject);
    });
}

function customerBookingResponse(result) {
    const booking = result.booking;
    return {
        ...result,
        booking: {
            reference: booking.reference,
            date: booking.date,
            time: booking.time,
            timeLabel: booking.timeLabel,
            partySize: booking.partySize,
            email: booking.email,
            status: booking.status,
            holdExpiresAt: booking.holdExpiresAt || null
        }
    };
}

function clientAddress(request) {
    if (trustProxy) {
        return String(request.headers["x-forwarded-for"] || "").split(",")[0].trim() || "proxy-unknown";
    }
    return request.socket.remoteAddress || "local";
}

async function checkRateLimit(request, action, limit, windowMs, discriminator = "") {
    const source = discriminator || clientAddress(request);
    const key = crypto.createHash("sha256").update(`${action}:${source}`).digest("hex");
    const allowed = await store.consumeRateLimit({
        id: crypto.randomUUID(),
        key,
        action,
        now: Date.now(),
        windowMs,
        limit
    });
    if (!allowed) {
        throw Object.assign(
            new Error("Too many attempts. Please wait and try again."),
            { status: 429, code: "RATE_LIMITED" }
        );
    }
}

function setSecurityHeaders(response, pathname) {
    const sensitive = pathname.startsWith("/admin/") || pathname.startsWith("/booking/manage/") ||
        pathname.startsWith("/api/admin/") || pathname.startsWith("/api/manage");
    let contentSecurityPolicy;
    if (pathname.startsWith("/admin/") && !pathname.startsWith("/admin/bookings/")) {
        contentSecurityPolicy = `default-src 'self'; script-src 'self' https://unpkg.com https://identity.netlify.com 'unsafe-inline' 'unsafe-eval'; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https: blob:; connect-src 'self' ${identityOrigin} https://*.netlify.com https://*.netlify.app https://api.github.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`;
    } else if (pathname.startsWith("/admin/bookings/") || pathname.startsWith("/booking/manage/") ||
        pathname.startsWith("/book/")) {
        contentSecurityPolicy = `default-src 'self'; script-src 'self' https://identity.netlify.com; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' ${identityOrigin}; frame-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`;
    } else {
        contentSecurityPolicy = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; frame-src 'self' https://www.google.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
    }
    response.setHeader("Content-Security-Policy", contentSecurityPolicy);
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    if (sensitive) response.setHeader("Cache-Control", "no-store");
    if (isProduction) response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}

async function serveStatic(pathname, response) {
    let decoded;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        return false;
    }
    let relative = decoded.replace(/^\/+/, "");
    if (!relative || relative.endsWith("/")) relative += "index.html";
    let filePath = path.resolve(siteRoot, relative);
    if (!filePath.startsWith(`${siteRoot}${path.sep}`) && filePath !== siteRoot) return false;
    if (!fs.existsSync(filePath) && !path.extname(filePath)) {
        const directoryIndex = path.join(filePath, "index.html");
        const htmlFile = `${filePath}.html`;
        if (fs.existsSync(directoryIndex)) filePath = directoryIndex;
        else if (fs.existsSync(htmlFile)) filePath = htmlFile;
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
    const headers = {
        "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
        "Cache-Control": pathname.startsWith("/admin/") || pathname.startsWith("/booking/manage/")
            ? "no-store"
            : (path.extname(filePath) === ".html" ? "no-cache" : "public, max-age=300"),
        "X-Content-Type-Options": "nosniff"
    };
    if (path.extname(filePath).toLowerCase() === ".html") {
        const state = await service.getOnlineBookingState();
        const html = fs.readFileSync(filePath, "utf8").replace(
            /<html\b([^>]*)>/,
            (_match, attributes) => `<html${attributes.replace(
                /\sdata-online-bookings=(?:"[^"]*"|'[^']*')/,
                ""
            )} data-online-bookings="${state.enabled ? "open" : "closed"}">`
        );
        response.writeHead(200, headers);
        response.end(html);
        return true;
    }
    response.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(response);
    return true;
}

async function handleApi(request, response, url) {
    const { pathname, searchParams } = url;
    const requestId = response.getHeader("X-Request-Id");

    if (request.method === "GET" && pathname === "/api/booking-status") {
        const state = await service.getOnlineBookingState();
        return sendJson(response, 200, { enabled: state.enabled });
    }

    if (request.method === "GET" && pathname === "/api/admin/session") {
        const session = await auth.requireAdmin(request, "bookings:read");
        await store.insertAdminEvent({
            id: crypto.randomUUID(), actor: session.actor, action: "admin_identity_verified",
            target_type: "session", target_id: session.identityId, details: "", request_id: requestId,
            created_at: new Date().toISOString()
        });
        return sendJson(response, 200, {
            actor: session.actor,
            role: session.role
        });
    }

    if (request.method === "DELETE" && pathname === "/api/admin/session") {
        const session = await auth.requireAdmin(request, "bookings:read");
        auth.assertSameOrigin(request);
        await store.insertAdminEvent({
            id: crypto.randomUUID(), actor: session.actor, action: "admin_logout",
            target_type: "session", target_id: null, details: "", request_id: requestId,
            created_at: new Date().toISOString()
        });
        return sendJson(response, 200, { ok: true });
    }

    let adminSession = null;
    if (pathname.startsWith("/api/admin/")) {
        let permission = "bookings:write";
        if (request.method === "GET") permission = "bookings:read";
        if (/\/(emails|reminder|reminders|resend|notify)(\/|$)/.test(pathname)) permission = "bookings:email";
        if (/\/blocks(\/|$)/.test(pathname)) permission = "bookings:capacity";
        if (/\/booking-settings(\/|$)/.test(pathname)) permission = "bookings:capacity";
        adminSession = await auth.requireAdmin(request, permission);
        if (!["GET", "HEAD"].includes(request.method)) auth.assertSameOrigin(request);
    }

    const audit = () => ({
        actor: adminSession?.actor || "Admin",
        requestId
    });

    if (request.method === "GET" && pathname === "/api/health") {
        return sendJson(response, 200, {
            ok: true,
            mode: "local",
            emailDelivery: process.env.RESEND_API_KEY ? "resend" : "local-preview"
        });
    }

    if (request.method === "GET" && pathname === "/api/availability") {
        return sendJson(
            response,
            200,
            await service.getPublicAvailability(searchParams.get("date"), searchParams.get("partySize"))
        );
    }

    if (request.method === "GET" && pathname === "/api/manage-availability") {
        const session = auth.requireManage(request);
        return sendJson(
            response,
            200,
            await service.getManagedAvailabilityById(
                session.bookingId,
                searchParams.get("date"),
                searchParams.get("partySize")
            )
        );
    }

    if (request.method === "POST" && pathname === "/api/bookings") {
        await checkRateLimit(request, "booking-ip", 5, 15 * 60 * 1000);
        const input = await readJson(request);
        if (input.company) {
            return sendJson(response, 201, {
                booking: { reference: "WI-RECEIVED", status: "confirmed" },
                emailStatus: "preview"
            });
        }
        await checkRateLimit(request, "booking-email", 3, 60 * 60 * 1000, String(input.email || "").trim().toLowerCase());
        await checkRateLimit(request, "booking-phone", 3, 60 * 60 * 1000, String(input.phone || "").replace(/\D/g, ""));
        const result = await service.createBooking(input, {
            idempotencyKey: request.headers["idempotency-key"]
        });
        return sendJson(response, 201, customerBookingResponse(result));
    }

    if (request.method === "POST" && pathname === "/api/manage-session") {
        auth.assertSameOrigin(request);
        await checkRateLimit(request, "manage-exchange", 10, 15 * 60 * 1000);
        const input = await readJson(request);
        const exchange = await service.exchangeManageToken(input.token);
        const session = auth.createManageSession(exchange.bookingId);
        return sendJson(response, 200, {
            managed: exchange.managed,
            csrfToken: session.csrf
        }, { "Set-Cookie": auth.manageCookie(session) });
    }

    if (request.method === "GET" && pathname === "/api/manage-session") {
        const session = auth.requireManage(request);
        return sendJson(response, 200, {
            managed: await service.getManagedBookingById(session.bookingId),
            csrfToken: session.csrf
        });
    }

    if (request.method === "GET" && pathname === "/api/manage-booking") {
        const session = auth.requireManage(request);
        return sendJson(response, 200, await service.getManagedBookingById(session.bookingId));
    }

    if (request.method === "POST" && pathname === "/api/confirm-booking") {
        const session = auth.requireManage(request);
        auth.requireCsrf(request, session);
        await readJson(request);
        return sendJson(response, 200, await service.confirmBookingById(session.bookingId));
    }

    if (request.method === "PATCH" && pathname === "/api/amend-booking") {
        const session = auth.requireManage(request);
        auth.requireCsrf(request, session);
        const input = await readJson(request);
        return sendJson(response, 200, await service.amendBookingById(session.bookingId, input));
    }

    if (request.method === "POST" && pathname === "/api/cancel-booking") {
        const session = auth.requireManage(request);
        auth.requireCsrf(request, session);
        await readJson(request);
        const result = await service.cancelBookingById(session.bookingId);
        auth.destroyManageSession(request);
        return sendJson(response, 200, result, { "Set-Cookie": auth.clearManageCookie() });
    }

    if (request.method === "POST" && pathname === "/api/waitlist") {
        await checkRateLimit(request, "waitlist-ip", 5, 15 * 60 * 1000);
        const input = await readJson(request);
        if (input.company) return sendJson(response, 201, { entry: { status: "waiting" } });
        await checkRateLimit(request, "waitlist-contact", 3, 60 * 60 * 1000,
            `${String(input.email || "").trim().toLowerCase()}:${String(input.phone || "").replace(/\D/g, "")}`);
        const result = await service.createWaitlistEntry(input, {
            idempotencyKey: request.headers["idempotency-key"]
        });
        return sendJson(response, 201, {
            entry: { status: result.entry.status },
            replayed: result.replayed === true
        });
    }

    if (request.method === "GET" && pathname === "/api/admin/diary") {
        return sendJson(response, 200, await service.listDiary(searchParams.get("date")));
    }

    if (request.method === "GET" && pathname === "/api/admin/calendar") {
        return sendJson(response, 200, await service.listCalendar(searchParams.get("month")));
    }

    if (request.method === "GET" && pathname === "/api/admin/booking-settings") {
        return sendJson(response, 200, await service.getOnlineBookingState());
    }

    if (request.method === "PATCH" && pathname === "/api/admin/booking-settings") {
        const input = await readJson(request);
        const hasEnabled = Object.hasOwn(input, "enabled");
        const hasMaxCovers = Object.hasOwn(input, "maxCovers");
        if (!hasEnabled && !hasMaxCovers) {
            throw Object.assign(new Error("No booking setting was provided."), {
                status: 400,
                code: "VALIDATION_ERROR"
            });
        }
        if (hasEnabled) await service.setOnlineBookingsEnabled(input.enabled, audit());
        if (hasMaxCovers) await service.setMaxOnlineCovers(input.maxCovers, audit());
        return sendJson(response, 200, await service.getOnlineBookingState());
    }

    if (request.method === "POST" && pathname === "/api/admin/bookings") {
        const input = await readJson(request);
        if (input.overrideCapacity === true && !adminSession.permissions.has("bookings:capacity")) {
            throw Object.assign(new Error("This account cannot override capacity."), {
                status: 403,
                code: "FORBIDDEN"
            });
        }
        const result = await service.createBooking(input, {
            admin: true,
            overrideCapacity: input.overrideCapacity === true,
            idempotencyKey: request.headers["idempotency-key"] || null,
            ...audit()
        });
        return sendJson(response, 201, result);
    }

    const bookingMatch = pathname.match(/^\/api\/admin\/bookings\/([^/]+)$/);
    if (request.method === "PATCH" && bookingMatch) {
        const input = await readJson(request);
        if (input.overrideCapacity === true && !adminSession.permissions.has("bookings:capacity")) {
            throw Object.assign(new Error("This account cannot override capacity."), {
                status: 403,
                code: "FORBIDDEN"
            });
        }
        return sendJson(
            response,
            200,
            await service.updateBooking(decodeURIComponent(bookingMatch[1]), input, audit())
        );
    }

    const resendMatch = pathname.match(/^\/api\/admin\/bookings\/([^/]+)\/resend$/);
    if (request.method === "POST" && resendMatch) {
        return sendJson(
            response,
            200,
            await service.resendConfirmation(decodeURIComponent(resendMatch[1]), audit())
        );
    }

    const callConfirmationMatch = pathname.match(/^\/api\/admin\/bookings\/([^/]+)\/call-confirmation$/);
    if (request.method === "PATCH" && callConfirmationMatch) {
        const input = await readJson(request);
        return sendJson(
            response,
            200,
            await service.setCallConfirmation(
                decodeURIComponent(callConfirmationMatch[1]),
                input.confirmed,
                audit()
            )
        );
    }

    const reminderMatch = pathname.match(/^\/api\/admin\/bookings\/([^/]+)\/reminder$/);
    if (request.method === "POST" && reminderMatch) {
        return sendJson(
            response,
            200,
            await service.sendReminderForBooking(decodeURIComponent(reminderMatch[1]), {
                force: true,
                ...audit()
            })
        );
    }

    if (request.method === "POST" && pathname === "/api/admin/reminders/run") {
        return sendJson(response, 200, await service.sendDueReminders(audit()));
    }

    const waitlistNotifyMatch = pathname.match(/^\/api\/admin\/waitlist\/([^/]+)\/notify$/);
    if (request.method === "POST" && waitlistNotifyMatch) {
        return sendJson(
            response,
            200,
            await service.notifyWaitlistEntry(decodeURIComponent(waitlistNotifyMatch[1]), {
                ...audit()
            })
        );
    }

    const waitlistMatch = pathname.match(/^\/api\/admin\/waitlist\/([^/]+)$/);
    if (request.method === "PATCH" && waitlistMatch) {
        const input = await readJson(request);
        return sendJson(
            response,
            200,
            await service.updateWaitlistStatus(decodeURIComponent(waitlistMatch[1]), input.status, audit())
        );
    }

    if (request.method === "POST" && pathname === "/api/admin/blocks") {
        return sendJson(response, 201, { block: await service.createBlock(await readJson(request), audit()) });
    }

    const blockMatch = pathname.match(/^\/api\/admin\/blocks\/([^/]+)$/);
    if (request.method === "DELETE" && blockMatch) {
        return sendJson(
            response,
            200,
            await service.removeBlock(decodeURIComponent(blockMatch[1]), audit())
        );
    }

    const emailMatch = pathname.match(/^\/api\/admin\/emails\/([^/]+)$/);
    if (request.method === "GET" && emailMatch) {
        const emailId = decodeURIComponent(emailMatch[1]);
        const email = await store.getEmail(emailId) || await store.getWaitlistEmail(emailId);
        if (!email) throw Object.assign(new Error("Email preview not found."), { status: 404 });
        await store.insertAdminEvent({
            id: crypto.randomUUID(), actor: adminSession.actor, action: "email_preview_viewed",
            target_type: "email", target_id: emailId, details: "", request_id: requestId,
            created_at: new Date().toISOString()
        });
        response.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Robots-Tag": "noindex",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
        });
        return response.end(email.html);
    }

    return sendJson(response, 404, {
        error: { code: "NOT_FOUND", message: "API route not found." }
    });
}

const server = http.createServer(async (request, response) => {
    try {
        const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
        response.setHeader("X-Request-Id", crypto.randomUUID());
        setSecurityHeaders(response, url.pathname);
        if (isProduction && String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim() !== "https") {
            throw Object.assign(new Error("HTTPS is required."), { status: 400, code: "HTTPS_REQUIRED" });
        }
        if (request.method === "OPTIONS") {
            response.writeHead(204, { "Allow": "GET, POST, PATCH, DELETE, OPTIONS" });
            return response.end();
        }
        if (url.pathname.startsWith("/api/")) {
            return await handleApi(request, response, url);
        }
        if (request.method === "GET" && await serveStatic(url.pathname, response)) return;
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
    } catch (error) {
        sendError(response, error);
    }
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;

async function prepareDueReminders() {
    try {
        const result = await service.sendDueReminders();
        if (result.preparedCount) {
            console.log(`Prepared ${result.preparedCount} due booking reminder${result.preparedCount === 1 ? "" : "s"}.`);
        }
    } catch (error) {
        console.error("Reminder check failed:", error);
    }
}

const reminderTimer = setInterval(prepareDueReminders, 60 * 1000);
reminderTimer.unref();

async function applyRetention() {
    try {
        const result = await service.runRetention();
        const changed = Object.values(result).reduce((total, value) => total + Number(value || 0), 0);
        if (changed) console.log(`Applied booking-data retention to ${changed} stored record${changed === 1 ? "" : "s"}.`);
    } catch (error) {
        console.error("Booking retention failed:", error);
    }
}

const retentionTimer = setInterval(applyRetention, 24 * 60 * 60 * 1000);
retentionTimer.unref();

server.listen(port, host, async () => {
    console.log(`Waterloo booking prototype: http://${host}:${port}`);
    console.log(`Booking diary: http://${host}:${port}/admin/bookings/`);
    console.log(`Database: ${databasePath}`);
    console.log(`Online bookings: ${(await service.getOnlineBookingState()).enabled ? "enabled" : "disabled"}.`);
    if (!process.env.RESEND_API_KEY) {
        console.log("Email mode: local previews in the booking diary (nothing is sent).");
    }
    prepareDueReminders();
    applyRetention();
});

function shutdown() {
    clearInterval(reminderTimer);
    clearInterval(retentionTimer);
    server.close(() => {
        store.close();
        process.exit(0);
    });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

module.exports = { server };
