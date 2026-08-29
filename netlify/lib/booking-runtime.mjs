import authModule from "../../booking/auth.js";
import emailModule from "../../booking/email-service.js";
import serviceModule from "../../booking/service.js";
import { PostgresBookingStore } from "../../booking/postgres-store.mjs";

const { SessionAuth } = authModule;
const { EmailService } = emailModule;
const { BookingService } = serviceModule;

export const publicUrl = String(
    process.env.BOOKING_PUBLIC_URL || "https://waterlooinnbiggin.com"
).replace(/\/$/, "");

export const store = new PostgresBookingStore();
export const mailer = new EmailService(store, { publicUrl });
export const service = new BookingService(store, mailer, { requireEmailVerification: false });
export const auth = new SessionAuth({
    publicUrl,
    identityUrl: process.env.BOOKING_IDENTITY_URL || `${publicUrl}/.netlify/identity`,
    secureCookies: new URL(publicUrl).protocol === "https:",
    sessionSecret: process.env.BOOKING_SESSION_SECRET || "",
    basicUsername: process.env.BOOKING_BASIC_AUTH_USERNAME || "",
    basicPasswordHash: process.env.BOOKING_BASIC_AUTH_PASSWORD_HASH || "",
    basicActor: process.env.BOOKING_BASIC_AUTH_ACTOR || ""
});

export function assertRuntimeConfiguration() {
    if (String(process.env.BOOKING_SESSION_SECRET || "").length < 32) {
        throw Object.assign(new Error("BOOKING_SESSION_SECRET must contain at least 32 characters."), {
            status: 503,
            code: "CONFIGURATION_ERROR"
        });
    }
    const basicUsername = String(process.env.BOOKING_BASIC_AUTH_USERNAME || "").trim();
    const basicPasswordHash = String(process.env.BOOKING_BASIC_AUTH_PASSWORD_HASH || "").trim();
    if (Boolean(basicUsername) !== Boolean(basicPasswordHash) ||
        (basicUsername && !auth.basicAuthConfigured())) {
        throw Object.assign(new Error("Booking password sign-in is not configured correctly."), {
            status: 503,
            code: "CONFIGURATION_ERROR"
        });
    }
}
