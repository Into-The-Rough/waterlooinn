"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");
const { BookingStore } = require("../booking/store");
const { BookingService } = require("../booking/service");
const { EmailService } = require("../booking/email-service");

const projectRoot = path.resolve(__dirname, "..");
const siteRoot = path.join(projectRoot, "_site");
const databasePath = process.env.BOOKING_DATABASE_PATH ||
    path.join(projectRoot, ".local", "booking-diary.sqlite");
const port = Number(process.env.BOOKING_PORT || 8888);
const host = process.env.BOOKING_HOST || "127.0.0.1";

const store = new BookingStore(databasePath);
const mailer = new EmailService(store, {
    publicUrl: process.env.BOOKING_PUBLIC_URL || `http://${host}:${port}`
});
const service = new BookingService(store, mailer);
const rateLimits = new Map();

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

function sendJson(response, status, payload) {
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
    });
    response.end(JSON.stringify(payload));
}

function sendError(response, error) {
    const status = Number(error.status) || 500;
    if (status >= 500) console.error(error);
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
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
            body += chunk;
            if (body.length > 65536) {
                reject(Object.assign(new Error("Request is too large."), { status: 413 }));
                request.destroy();
            }
        });
        request.on("end", () => {
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

function checkRateLimit(request) {
    const address = request.socket.remoteAddress || "local";
    const now = Date.now();
    const windowMs = 10 * 60 * 1000;
    const entries = (rateLimits.get(address) || []).filter((value) => now - value < windowMs);
    if (entries.length >= 8) {
        throw Object.assign(
            new Error("Too many booking attempts. Please wait a few minutes and try again."),
            { status: 429, code: "RATE_LIMITED" }
        );
    }
    entries.push(now);
    rateLimits.set(address, entries);
}

function serveStatic(pathname, response) {
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
    response.writeHead(200, {
        "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
        "Cache-Control": path.extname(filePath) === ".html" ? "no-cache" : "public, max-age=300",
        "X-Content-Type-Options": "nosniff"
    });
    fs.createReadStream(filePath).pipe(response);
    return true;
}

async function handleApi(request, response, url) {
    const { pathname, searchParams } = url;

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
            service.getAvailability(searchParams.get("date"), searchParams.get("partySize"))
        );
    }

    if (request.method === "GET" && pathname === "/api/manage-availability") {
        return sendJson(
            response,
            200,
            service.getManagedAvailability(
                searchParams.get("token"),
                searchParams.get("date"),
                searchParams.get("partySize")
            )
        );
    }

    if (request.method === "POST" && pathname === "/api/bookings") {
        checkRateLimit(request);
        const input = await readJson(request);
        if (input.company) {
            return sendJson(response, 201, {
                booking: { reference: "WI-RECEIVED", status: "confirmed" },
                emailStatus: "preview"
            });
        }
        const result = await service.createBooking(input);
        return sendJson(response, 201, result);
    }

    if (request.method === "GET" && pathname === "/api/manage-booking") {
        return sendJson(response, 200, service.getManagedBooking(searchParams.get("token")));
    }

    if (request.method === "POST" && pathname === "/api/confirm-booking") {
        const input = await readJson(request);
        return sendJson(response, 200, service.confirmBooking(input.token));
    }

    if (request.method === "PATCH" && pathname === "/api/amend-booking") {
        const input = await readJson(request);
        return sendJson(response, 200, await service.amendBooking(input.token, input));
    }

    if (request.method === "POST" && pathname === "/api/cancel-booking") {
        const input = await readJson(request);
        return sendJson(response, 200, await service.cancelBooking(input.token));
    }

    if (request.method === "POST" && pathname === "/api/waitlist") {
        checkRateLimit(request);
        const input = await readJson(request);
        if (input.company) return sendJson(response, 201, { entry: { status: "waiting" } });
        return sendJson(response, 201, await service.createWaitlistEntry(input));
    }

    if (request.method === "GET" && pathname === "/api/admin/diary") {
        return sendJson(response, 200, service.listDiary(searchParams.get("date")));
    }

    if (request.method === "GET" && pathname === "/api/admin/calendar") {
        return sendJson(response, 200, service.listCalendar(searchParams.get("month")));
    }

    if (request.method === "POST" && pathname === "/api/admin/bookings") {
        const input = await readJson(request);
        const result = await service.createBooking(input, {
            admin: true,
            overrideCapacity: Boolean(input.overrideCapacity)
        });
        return sendJson(response, 201, result);
    }

    const bookingMatch = pathname.match(/^\/api\/admin\/bookings\/([^/]+)$/);
    if (request.method === "PATCH" && bookingMatch) {
        const input = await readJson(request);
        return sendJson(
            response,
            200,
            await service.updateBooking(decodeURIComponent(bookingMatch[1]), input)
        );
    }

    const resendMatch = pathname.match(/^\/api\/admin\/bookings\/([^/]+)\/resend$/);
    if (request.method === "POST" && resendMatch) {
        return sendJson(
            response,
            200,
            await service.resendConfirmation(decodeURIComponent(resendMatch[1]))
        );
    }

    const callConfirmationMatch = pathname.match(/^\/api\/admin\/bookings\/([^/]+)\/call-confirmation$/);
    if (request.method === "PATCH" && callConfirmationMatch) {
        const input = await readJson(request);
        return sendJson(
            response,
            200,
            service.setCallConfirmation(
                decodeURIComponent(callConfirmationMatch[1]),
                input.confirmed
            )
        );
    }

    const reminderMatch = pathname.match(/^\/api\/admin\/bookings\/([^/]+)\/reminder$/);
    if (request.method === "POST" && reminderMatch) {
        return sendJson(
            response,
            200,
            await service.sendReminderForBooking(decodeURIComponent(reminderMatch[1]), { force: true })
        );
    }

    if (request.method === "POST" && pathname === "/api/admin/reminders/run") {
        return sendJson(response, 200, await service.sendDueReminders());
    }

    const waitlistNotifyMatch = pathname.match(/^\/api\/admin\/waitlist\/([^/]+)\/notify$/);
    if (request.method === "POST" && waitlistNotifyMatch) {
        return sendJson(
            response,
            200,
            await service.notifyWaitlistEntry(decodeURIComponent(waitlistNotifyMatch[1]))
        );
    }

    const waitlistMatch = pathname.match(/^\/api\/admin\/waitlist\/([^/]+)$/);
    if (request.method === "PATCH" && waitlistMatch) {
        const input = await readJson(request);
        return sendJson(
            response,
            200,
            service.updateWaitlistStatus(decodeURIComponent(waitlistMatch[1]), input.status)
        );
    }

    if (request.method === "POST" && pathname === "/api/admin/blocks") {
        return sendJson(response, 201, { block: service.createBlock(await readJson(request)) });
    }

    const blockMatch = pathname.match(/^\/api\/admin\/blocks\/([^/]+)$/);
    if (request.method === "DELETE" && blockMatch) {
        return sendJson(
            response,
            200,
            service.removeBlock(decodeURIComponent(blockMatch[1]))
        );
    }

    const emailMatch = pathname.match(/^\/api\/admin\/emails\/([^/]+)$/);
    if (request.method === "GET" && emailMatch) {
        const emailId = decodeURIComponent(emailMatch[1]);
        const email = store.getEmail(emailId) || store.getWaitlistEmail(emailId);
        if (!email) throw Object.assign(new Error("Email preview not found."), { status: 404 });
        response.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Robots-Tag": "noindex"
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
        if (request.method === "OPTIONS") {
            response.writeHead(204, { "Allow": "GET, POST, PATCH, DELETE, OPTIONS" });
            return response.end();
        }
        if (url.pathname.startsWith("/api/")) {
            return await handleApi(request, response, url);
        }
        if (request.method === "GET" && serveStatic(url.pathname, response)) return;
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
    } catch (error) {
        sendError(response, error);
    }
});

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

server.listen(port, host, () => {
    console.log(`Waterloo booking prototype: http://${host}:${port}`);
    console.log(`Booking diary: http://${host}:${port}/admin/bookings/`);
    console.log(`Database: ${databasePath}`);
    if (!process.env.RESEND_API_KEY) {
        console.log("Email mode: local previews in the booking diary (nothing is sent).");
    }
    prepareDueReminders();
});

function shutdown() {
    clearInterval(reminderTimer);
    server.close(() => {
        store.close();
        process.exit(0);
    });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

module.exports = { server };
