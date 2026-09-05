import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { NetlifyDB } from "@netlify/database-dev";
import { PostgresBookingStore } from "../booking/postgres-store.mjs";
import emailModule from "../booking/email-service.js";
import serviceModule from "../booking/service.js";

const { EmailService } = emailModule;
const { BookingService } = serviceModule;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Netlify Postgres migration persists defaults and enforces capacity", async (t) => {
    const database = new NetlifyDB({ logger: () => {} });
    const connectionString = await database.start();
    t.after(async () => database.stop());
    const applied = await database.applyMigrations(path.join(projectRoot, "netlify/database/migrations"));
    assert.deepEqual(applied, [
        "20260826210000_create_booking_system",
        "20260829200000_allow_admin_party_size_30"
    ]);

    const store = new PostgresBookingStore({ connectionString });
    t.after(async () => store.close());
    const mailer = new EmailService(store, { publicUrl: "https://example.com" });
    const service = new BookingService(store, mailer, {
        now: () => new Date("2026-08-26T08:00:00Z"),
        requireEmailVerification: false
    });

    const initialState = await service.getOnlineBookingState();
    assert.equal(initialState.enabled, false);
    assert.equal(initialState.maxCovers, 30);
    assert.equal(initialState.maxArrivalCovers, 10);
    assert.equal(initialState.updatedAt, null);
    assert.equal(initialState.updatedBy, null);
    assert.equal(initialState.serviceHours.length, 7);
    assert.equal(initialState.serviceHours.find((day) => day.weekday === 2).enabled, false);
    assert.equal(initialState.serviceHoursUpdatedAt, null);
    await service.setMaxOnlineCovers(7, { actor: "Test manager" });
    await service.setOnlineBookingsEnabled(true, { actor: "Test manager" });

    const makeInput = (suffix) => ({
        date: "2026-09-02",
        time: "18:00",
        partySize: 7,
        name: `Test Guest ${suffix}`,
        email: `guest${suffix}@example.com`,
        phone: `0712345678${suffix}`
    });
    const created = await service.createBooking(makeInput("1"), {
        idempotencyKey: "postgres-capacity-0001"
    });
    assert.equal(created.emailStatus, "preview");
    await assert.rejects(
        service.createBooking(makeInput("2"), { idempotencyKey: "postgres-capacity-0002" }),
        (error) => error.code === "SLOT_UNAVAILABLE"
    );

    const diary = await service.listDiary("2026-09-02");
    assert.equal(diary.bookings.length, 1);
    assert.equal(diary.summary.covers, 7);
    assert.equal((await store.listEmailsForBooking(diary.bookings[0].id)).length, 2);

    await service.setMaxOnlineCovers(30, { actor: "Test manager" });
    const adminBooking = await service.createBooking({
        ...makeInput("3"),
        time: "21:00",
        partySize: 30
    }, {
        admin: true,
        overrideCapacity: true,
        actor: "Test manager"
    });
    assert.equal(adminBooking.booking.partySize, 30);

    process.env.NETLIFY_DB_URL = connectionString;
    process.env.BOOKING_PUBLIC_URL = "https://example.com";
    process.env.BOOKING_SESSION_SECRET = "a-long-random-test-secret-that-is-at-least-32-characters";
    const [{ default: apiHandler }, functionRuntime] = await Promise.all([
        import("../netlify/functions/booking-api.mjs"),
        import("../netlify/lib/booking-runtime.mjs")
    ]);
    t.after(async () => functionRuntime.store.close());
    const response = await apiHandler(new Request("https://example.com/api/booking-status"));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const statusBody = await response.json();
    assert.equal(statusBody.enabled, true);
    assert.equal(statusBody.serviceHours.length, 7);

    await functionRuntime.service.setOnlineBookingsEnabled(false, { actor: "Test manager" });
    const closedResponse = await apiHandler(new Request(
        "https://example.com/api/availability?date=2026-09-02&partySize=2"
    ));
    assert.equal(closedResponse.status, 503);
    const closedBody = await closedResponse.json();
    assert.equal(closedBody.error.code, "ONLINE_BOOKINGS_CLOSED");
    assert.match(closedBody.error.message, /call us on 01298 463248/i);
});
