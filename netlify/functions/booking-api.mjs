import crypto from "node:crypto";
import { auth, mailer, service, store, assertRuntimeConfiguration } from "../lib/booking-runtime.mjs";

const JSON_HEADERS = {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
};

const SAFE_SERVICE_ERRORS = new Set([
    "BASIC_AUTH_UNAVAILABLE",
    "EMAIL_UNAVAILABLE",
    "IDENTITY_UNAVAILABLE",
    "ONLINE_BOOKINGS_CLOSED"
]);

function legacyRequest(request) {
    return {
        method: request.method,
        headers: Object.fromEntries(request.headers.entries())
    };
}

function json(status, payload, extraHeaders = {}) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { ...JSON_HEADERS, ...extraHeaders }
    });
}

function errorResponse(error, requestId) {
    const status = Number(error.status) || 500;
    if (status >= 500 && !SAFE_SERVICE_ERRORS.has(error.code)) console.error(`[${requestId}]`, error);
    const exposeMessage = status < 500 || SAFE_SERVICE_ERRORS.has(error.code);
    return json(status, {
        error: {
            code: error.code || (status >= 500 ? "SERVER_ERROR" : "REQUEST_ERROR"),
            message: exposeMessage ? error.message : "Something went wrong. Please try again.",
            field: error.field || null,
            suggestion: error.suggestion || null
        }
    }, { "X-Request-Id": requestId });
}

async function readJson(request) {
    const contentType = String(request.headers.get("content-type") || "").toLowerCase();
    if (!contentType.startsWith("application/json")) {
        throw Object.assign(new Error("Content-Type must be application/json."), {
            status: 415,
            code: "UNSUPPORTED_MEDIA_TYPE"
        });
    }
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > 65_536) {
        throw Object.assign(new Error("Request is too large."), { status: 413, code: "REQUEST_TOO_LARGE" });
    }
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > 65_536) {
        throw Object.assign(new Error("Request is too large."), { status: 413, code: "REQUEST_TOO_LARGE" });
    }
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        throw Object.assign(new Error("Invalid request data."), { status: 400, code: "INVALID_JSON" });
    }
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
    return request.headers.get("x-nf-client-connection-ip") ||
        String(request.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
        "unknown";
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
        throw Object.assign(new Error("Too many attempts. Please wait and try again."), {
            status: 429,
            code: "RATE_LIMITED"
        });
    }
}

function adminPermission(method, pathname) {
    if (method === "GET") return "bookings:read";
    if (/\/(emails|reminder|reminders|resend|notify)(\/|$)/.test(pathname)) return "bookings:email";
    if (/\/(blocks|booking-settings)(\/|$)/.test(pathname)) return "bookings:capacity";
    return "bookings:write";
}

function requireCustomerEmailDelivery() {
    if (mailer.apiKey) return;
    throw Object.assign(new Error("Customer email delivery is temporarily unavailable."), {
        status: 503,
        code: "EMAIL_UNAVAILABLE"
    });
}

async function route(request, url, requestId) {
    const { pathname, searchParams } = url;
    const legacy = legacyRequest(request);

    if (request.method === "GET" && pathname === "/api/booking-status") {
        const state = await service.getOnlineBookingState();
        return json(200, { enabled: state.enabled });
    }

    if (request.method === "POST" && pathname === "/api/admin/session") {
        auth.assertSameOrigin(legacy);
        const input = await readJson(request);
        const loginName = String(input.username || "").trim().toLowerCase();
        await checkRateLimit(request, "admin-password-login-ip", 20, 15 * 60 * 1000);
        await checkRateLimit(
            request,
            "admin-password-login-account",
            5,
            15 * 60 * 1000,
            loginName || "missing"
        );
        const session = await auth.authenticateBasic(input.username, input.password);
        if (!session) {
            throw Object.assign(new Error("Username or password is incorrect."), {
                status: 401,
                code: "INVALID_CREDENTIALS"
            });
        }
        await store.insertAdminEvent({
            id: crypto.randomUUID(), actor: session.actor, action: "admin_password_login",
            target_type: "session", target_id: session.identityId, details: "", request_id: requestId,
            created_at: new Date().toISOString()
        });
        return json(200, { actor: session.actor, role: session.role }, {
            "Set-Cookie": auth.adminCookie(session)
        });
    }

    if (request.method === "GET" && pathname === "/api/admin/session") {
        const session = await auth.requireAdmin(legacy, "bookings:read");
        await store.insertAdminEvent({
            id: crypto.randomUUID(), actor: session.actor, action: "admin_session_verified",
            target_type: "session", target_id: session.identityId, details: "", request_id: requestId,
            created_at: new Date().toISOString()
        });
        return json(200, { actor: session.actor, role: session.role, authMethod: session.authMethod || "identity" });
    }

    if (request.method === "DELETE" && pathname === "/api/admin/session") {
        const session = await auth.requireAdmin(legacy, "bookings:read");
        auth.assertSameOrigin(legacy);
        await store.insertAdminEvent({
            id: crypto.randomUUID(), actor: session.actor, action: "admin_logout",
            target_type: "session", target_id: null, details: "", request_id: requestId,
            created_at: new Date().toISOString()
        });
        return json(200, { ok: true }, { "Set-Cookie": auth.clearAdminCookie() });
    }

    let adminSession = null;
    if (pathname.startsWith("/api/admin/")) {
        adminSession = await auth.requireAdmin(legacy, adminPermission(request.method, pathname));
        if (!["GET", "HEAD"].includes(request.method)) auth.assertSameOrigin(legacy);
    }
    const audit = () => ({ actor: adminSession?.actor || "Admin", requestId });

    if (request.method === "GET" && pathname === "/api/health") {
        return json(200, {
            ok: true,
            mode: "netlify-functions-postgres",
            emailDelivery: mailer.apiKey ? "resend" : "not-configured"
        });
    }

    if (request.method === "GET" && pathname === "/api/availability") {
        return json(200, await service.getPublicAvailability(
            searchParams.get("date"), searchParams.get("partySize")
        ));
    }

    if (request.method === "GET" && pathname === "/api/manage-availability") {
        const session = auth.requireManage(legacy);
        return json(200, await service.getManagedAvailabilityById(
            session.bookingId, searchParams.get("date"), searchParams.get("partySize")
        ));
    }

    if (request.method === "POST" && pathname === "/api/bookings") {
        requireCustomerEmailDelivery();
        await checkRateLimit(request, "booking-ip", 5, 15 * 60 * 1000);
        const input = await readJson(request);
        if (input.company) {
            return json(201, {
                booking: { reference: "WI-RECEIVED", status: "confirmed" },
                emailStatus: "preview"
            });
        }
        await checkRateLimit(request, "booking-email", 3, 60 * 60 * 1000,
            String(input.email || "").trim().toLowerCase());
        await checkRateLimit(request, "booking-phone", 3, 60 * 60 * 1000,
            String(input.phone || "").replace(/\D/g, ""));
        const result = await service.createBooking(input, {
            idempotencyKey: request.headers.get("idempotency-key")
        });
        return json(201, customerBookingResponse(result));
    }

    if (request.method === "POST" && pathname === "/api/manage-session") {
        auth.assertSameOrigin(legacy);
        await checkRateLimit(request, "manage-exchange", 10, 15 * 60 * 1000);
        const input = await readJson(request);
        const exchange = await service.exchangeManageToken(input.token);
        const session = auth.createManageSession(exchange.bookingId);
        return json(200, { managed: exchange.managed, csrfToken: session.csrf }, {
            "Set-Cookie": auth.manageCookie(session)
        });
    }

    if (request.method === "GET" && pathname === "/api/manage-session") {
        const session = auth.requireManage(legacy);
        return json(200, {
            managed: await service.getManagedBookingById(session.bookingId),
            csrfToken: session.csrf
        });
    }

    if (request.method === "GET" && pathname === "/api/manage-booking") {
        const session = auth.requireManage(legacy);
        return json(200, await service.getManagedBookingById(session.bookingId));
    }

    if (request.method === "POST" && pathname === "/api/confirm-booking") {
        const session = auth.requireManage(legacy);
        auth.requireCsrf(legacy, session);
        await readJson(request);
        return json(200, await service.confirmBookingById(session.bookingId));
    }

    if (request.method === "PATCH" && pathname === "/api/amend-booking") {
        const session = auth.requireManage(legacy);
        auth.requireCsrf(legacy, session);
        return json(200, await service.amendBookingById(session.bookingId, await readJson(request)));
    }

    if (request.method === "POST" && pathname === "/api/cancel-booking") {
        const session = auth.requireManage(legacy);
        auth.requireCsrf(legacy, session);
        await readJson(request);
        const result = await service.cancelBookingById(session.bookingId);
        auth.destroyManageSession(legacy);
        return json(200, result, { "Set-Cookie": auth.clearManageCookie() });
    }

    if (request.method === "POST" && pathname === "/api/waitlist") {
        requireCustomerEmailDelivery();
        await checkRateLimit(request, "waitlist-ip", 5, 15 * 60 * 1000);
        const input = await readJson(request);
        if (input.company) return json(201, { entry: { status: "waiting" } });
        await checkRateLimit(request, "waitlist-contact", 3, 60 * 60 * 1000,
            `${String(input.email || "").trim().toLowerCase()}:${String(input.phone || "").replace(/\D/g, "")}`);
        const result = await service.createWaitlistEntry(input, {
            idempotencyKey: request.headers.get("idempotency-key")
        });
        return json(201, {
            entry: { status: result.entry.status },
            replayed: result.replayed === true
        });
    }

    if (request.method === "GET" && pathname === "/api/admin/diary") {
        return json(200, await service.listDiary(searchParams.get("date")));
    }
    if (request.method === "GET" && pathname === "/api/admin/calendar") {
        return json(200, await service.listCalendar(searchParams.get("month")));
    }
    if (request.method === "GET" && pathname === "/api/admin/booking-settings") {
        return json(200, await service.getOnlineBookingState());
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
        return json(200, await service.getOnlineBookingState());
    }

    if (request.method === "POST" && pathname === "/api/admin/bookings") {
        const input = await readJson(request);
        if (input.overrideCapacity === true && !adminSession.permissions.has("bookings:capacity")) {
            throw Object.assign(new Error("This account cannot override capacity."), {
                status: 403,
                code: "FORBIDDEN"
            });
        }
        return json(201, await service.createBooking(input, {
            admin: true,
            overrideCapacity: input.overrideCapacity === true,
            idempotencyKey: request.headers.get("idempotency-key") || null,
            ...audit()
        }));
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
        return json(200, await service.updateBooking(decodeURIComponent(bookingMatch[1]), input, audit()));
    }

    const resendMatch = pathname.match(/^\/api\/admin\/bookings\/([^/]+)\/resend$/);
    if (request.method === "POST" && resendMatch) {
        return json(200, await service.resendConfirmation(decodeURIComponent(resendMatch[1]), audit()));
    }

    const callMatch = pathname.match(/^\/api\/admin\/bookings\/([^/]+)\/call-confirmation$/);
    if (request.method === "PATCH" && callMatch) {
        const input = await readJson(request);
        return json(200, await service.setCallConfirmation(
            decodeURIComponent(callMatch[1]), input.confirmed, audit()
        ));
    }

    const reminderMatch = pathname.match(/^\/api\/admin\/bookings\/([^/]+)\/reminder$/);
    if (request.method === "POST" && reminderMatch) {
        return json(200, await service.sendReminderForBooking(decodeURIComponent(reminderMatch[1]), {
            force: true,
            ...audit()
        }));
    }

    if (request.method === "POST" && pathname === "/api/admin/reminders/run") {
        return json(200, await service.sendDueReminders(audit()));
    }

    const waitlistNotify = pathname.match(/^\/api\/admin\/waitlist\/([^/]+)\/notify$/);
    if (request.method === "POST" && waitlistNotify) {
        return json(200, await service.notifyWaitlistEntry(decodeURIComponent(waitlistNotify[1]), audit()));
    }

    const waitlistMatch = pathname.match(/^\/api\/admin\/waitlist\/([^/]+)$/);
    if (request.method === "PATCH" && waitlistMatch) {
        const input = await readJson(request);
        return json(200, await service.updateWaitlistStatus(
            decodeURIComponent(waitlistMatch[1]), input.status, audit()
        ));
    }

    if (request.method === "POST" && pathname === "/api/admin/blocks") {
        return json(201, { block: await service.createBlock(await readJson(request), audit()) });
    }

    const blockMatch = pathname.match(/^\/api\/admin\/blocks\/([^/]+)$/);
    if (request.method === "DELETE" && blockMatch) {
        return json(200, await service.removeBlock(decodeURIComponent(blockMatch[1]), audit()));
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
        return new Response(email.html, {
            status: 200,
            headers: {
                "Cache-Control": "no-store",
                "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
                "Content-Type": "text/html; charset=utf-8",
                "Referrer-Policy": "no-referrer",
                "X-Content-Type-Options": "nosniff",
                "X-Frame-Options": "DENY",
                "X-Robots-Tag": "noindex"
            }
        });
    }

    return json(404, { error: { code: "NOT_FOUND", message: "API route not found." } });
}

export default async function handler(request) {
    const requestId = crypto.randomUUID();
    try {
        assertRuntimeConfiguration();
        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: { ...JSON_HEADERS, "Allow": "GET, POST, PATCH, DELETE, OPTIONS" }
            });
        }
        return await route(request, new URL(request.url), requestId);
    } catch (error) {
        return errorResponse(error, requestId);
    }
}

export const config = { path: "/api/*" };
