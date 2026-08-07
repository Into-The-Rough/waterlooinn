"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { BookingStore } = require("../booking/store");
const { EmailService } = require("../booking/email-service");
const { BookingService, tokenHash } = require("../booking/service");

function createFixture(options = {}) {
    const store = new BookingStore(":memory:");
    const mailer = new EmailService(store, {
        apiKey: "",
        publicUrl: "http://localhost:8888",
        staffEmail: "pub@example.com"
    });
    const service = new BookingService(store, mailer, {
        now: options.now || (() => new Date("2026-07-28T10:00:00Z"))
    });
    return { store, mailer, service };
}

function manageTokenFor(store, bookingId) {
    const email = store.listEmailsForBooking(bookingId)
        .find((item) => item.kind === "customer_confirmation");
    return store.getEmail(email.id).html.match(/manage\/\?token=([A-Za-z0-9_-]+)/)[1];
}

function bookingInput(overrides = {}) {
    return {
        date: "2026-07-29",
        time: "12:00",
        partySize: 4,
        name: "Test Guest",
        email: "guest@example.com",
        phone: "07123456789",
        requests: "",
        ...overrides
    };
}

test("publishes the configured Wednesday availability", (t) => {
    const { store, service } = createFixture();
    t.after(() => store.close());

    const availability = service.getAvailability("2026-07-29", 4);
    assert.equal(availability.service.label, "Wednesday");
    assert.equal(availability.durationMinutes, 120);
    assert.equal(availability.slots[0].time, "12:00");
    assert.equal(availability.slots.at(-1).time, "20:00");
    assert.equal(availability.slots.every((slot) => slot.available), true);
    assert.throws(
        () => service.getAvailability("2026-08-04", 2),
        /not available on this day/
    );
});

test("creates a confirmed booking and customer/staff email previews", async (t) => {
    const { store, service } = createFixture();
    t.after(() => store.close());

    const result = await service.createBooking(bookingInput());
    assert.equal(result.booking.status, "confirmed");
    assert.equal(result.booking.phone, "07123456789");
    assert.match(result.booking.reference, /^WI-260729-[A-F0-9]{4}$/);
    assert.equal(result.emailStatus, "preview");

    const emails = store.listEmailsForBooking(result.booking.id);
    assert.equal(emails.length, 2);
    assert.deepEqual(
        new Set(emails.map((email) => email.kind)),
        new Set(["customer_confirmation", "staff_notification"])
    );
});

test("enforces overlapping cover capacity", async (t) => {
    const { store, service } = createFixture();
    t.after(() => store.close());

    await service.createBooking(bookingInput({
        partySize: 8,
        name: "First Party",
        email: "first@example.com"
    }));
    await service.createBooking(bookingInput({
        time: "12:30",
        partySize: 8,
        name: "Second Party",
        email: "second@example.com"
    }));
    await service.createBooking(bookingInput({
        time: "13:00",
        partySize: 4,
        name: "Third Party",
        email: "third@example.com"
    }));

    const availability = service.getAvailability("2026-07-29", 1);
    const oneThirty = availability.slots.find((slot) => slot.time === "13:30");
    assert.equal(oneThirty.available, false);
    assert.equal(oneThirty.remainingCovers, 0);
});

test("cancellation token cancels once and releases capacity", async (t) => {
    const { store, service } = createFixture();
    t.after(() => store.close());

    const result = await service.createBooking(bookingInput({ partySize: 8 }));
    const token = manageTokenFor(store, result.booking.id);

    assert.equal(service.getManagedBooking(token).canCancel, true);
    const cancelled = await service.cancelBooking(token);
    assert.equal(cancelled.booking.status, "cancelled");
    assert.equal(service.getAvailability("2026-07-29", 8).slots[0].available, true);
    assert.throws(() => service.getManagedBooking(token), /invalid or has expired/);
});

test("admin closures remove slots from public availability", (t) => {
    const { store, service } = createFixture();
    t.after(() => store.close());

    const block = service.createBlock({
        date: "2026-07-29",
        time: "18:00",
        reason: "Private supper"
    });
    const availability = service.getAvailability("2026-07-29", 2);
    assert.equal(availability.slots.find((slot) => slot.time === "18:00").available, false);
    service.removeBlock(block.id);
    assert.equal(
        service.getAvailability("2026-07-29", 2).slots.find((slot) => slot.time === "18:00").available,
        true
    );
});

test("admin call confirmation is timestamped, idempotent and audited", async (t) => {
    const { store, service } = createFixture();
    t.after(() => store.close());

    const result = await service.createBooking(bookingInput());
    const bookingId = result.booking.id;
    const confirmed = service.setCallConfirmation(bookingId, true);

    assert.ok(confirmed.booking.callConfirmedAt);
    assert.equal(confirmed.auditEvents.length, 2);
    assert.equal(confirmed.auditEvents[0].kind, "call_confirmed");
    assert.equal(confirmed.auditEvents[0].actor, "Admin");

    const repeated = service.setCallConfirmation(bookingId, true);
    assert.equal(repeated.booking.callConfirmedAt, confirmed.booking.callConfirmedAt);
    assert.equal(repeated.auditEvents.length, 2);

    const cleared = service.setCallConfirmation(bookingId, false);
    assert.equal(cleared.booking.callConfirmedAt, null);
    assert.equal(cleared.auditEvents.length, 3);
    assert.equal(cleared.auditEvents[0].kind, "call_confirmation_cleared");
});

test("monthly calendar summarises bookings, covers and peak capacity", async (t) => {
    const { store, service } = createFixture();
    t.after(() => store.close());

    await service.createBooking(bookingInput({
        partySize: 6,
        name: "Lunch Party",
        email: "lunch@example.com"
    }));
    await service.createBooking(bookingInput({
        time: "12:30",
        partySize: 4,
        name: "Second Lunch Party",
        email: "second-lunch@example.com"
    }));
    service.createBlock({
        date: "2026-07-30",
        time: "*",
        reason: "Private event"
    });

    const calendar = service.listCalendar("2026-07");
    const bookedDay = calendar.days.find((day) => day.date === "2026-07-29");
    const closedDay = calendar.days.find((day) => day.date === "2026-07-30");

    assert.equal(calendar.monthLabel, "July 2026");
    assert.equal(bookedDay.bookingCount, 2);
    assert.equal(bookedDay.totalCovers, 10);
    assert.equal(bookedDay.peakCovers, 10);
    assert.equal(bookedDay.peakRemaining, 10);
    assert.equal(closedDay.wholeDayClosed, true);
});

test("admins can assign a seating area and table", async (t) => {
    const { store, service } = createFixture();
    t.after(() => store.close());

    const result = await service.createBooking(bookingInput({ partySize: 7 }));
    const updated = await service.updateBooking(result.booking.id, {
        area: "Bar",
        tableLabel: "Table B2"
    });
    assert.equal(updated.booking.area, "Bar");
    assert.equal(updated.booking.tableLabel, "Table B2");
});

test("customer can confirm and amend an active booking", async (t) => {
    const { store, service } = createFixture();
    t.after(() => store.close());

    const result = await service.createBooking(bookingInput());
    const token = manageTokenFor(store, result.booking.id);
    const confirmed = service.confirmBooking(token);
    assert.ok(confirmed.booking.customerConfirmedAt);
    assert.equal(confirmed.canConfirm, false);

    const amended = await service.amendBooking(token, {
        date: "2026-07-29",
        time: "12:30",
        partySize: 5,
        requests: "Window if possible"
    });
    assert.equal(amended.booking.time, "12:30");
    assert.equal(amended.booking.partySize, 5);
    assert.equal(amended.booking.requests, "Window if possible");
    assert.ok(store.listEmailsForBooking(result.booking.id)
        .some((email) => email.kind === "customer_amendment"));
});

test("due reminders are prepared once with confirmation and cancellation links", async (t) => {
    const { store, service } = createFixture({
        now: () => new Date("2026-07-28T12:00:00Z")
    });
    t.after(() => store.close());

    const result = await service.createBooking(bookingInput());
    const first = await service.sendDueReminders();
    const second = await service.sendDueReminders();
    assert.equal(first.preparedCount, 1);
    assert.equal(second.preparedCount, 0);

    const reminder = store.listEmailsForBooking(result.booking.id)
        .find((email) => email.kind === "customer_reminder");
    assert.ok(reminder);
    const html = store.getEmail(reminder.id).html;
    assert.match(html, /Confirm my booking/);
    assert.match(html, /Change or cancel/);
    assert.doesNotMatch(html, /deposit/i);
});

test("pre-existing manage links remain valid when a reminder adds a stable link", async (t) => {
    const { store, service } = createFixture();
    t.after(() => store.close());

    const result = await service.createBooking(bookingInput());
    store.updateBooking(result.booking.id, {
        cancellation_token_hash: tokenHash("legacy-local-token"),
        stable_manage_token_hash: null
    });
    await service.sendReminderForBooking(result.booking.id, { force: true });

    assert.equal(service.getManagedBooking("legacy-local-token").booking.id, result.booking.id);
    const reminder = store.listEmailsForBooking(result.booking.id)
        .find((email) => email.kind === "customer_reminder");
    const stableToken = store.getEmail(reminder.id).html
        .match(/manage\/\?token=([A-Za-z0-9_-]+)/)[1];
    assert.equal(service.getManagedBooking(stableToken).booking.id, result.booking.id);
});

test("a cancellation offers released capacity to the earliest waiting guest", async (t) => {
    const { store, service } = createFixture();
    t.after(() => store.close());

    const first = await service.createBooking(bookingInput({
        partySize: 8,
        name: "First Full Table",
        email: "first-full@example.com"
    }));
    await service.createBooking(bookingInput({
        partySize: 8,
        name: "Second Full Table",
        email: "second-full@example.com"
    }));
    await service.createBooking(bookingInput({
        partySize: 4,
        name: "Third Full Table",
        email: "third-full@example.com"
    }));

    const waitlist = await service.createWaitlistEntry({
        date: "2026-07-29",
        time: "12:00",
        partySize: 4,
        name: "Waiting Guest",
        email: "waiting@example.com",
        phone: "07111111111",
        notes: "Happy to come at short notice"
    });
    assert.equal(waitlist.entry.status, "waiting");

    await service.cancelBooking(manageTokenFor(store, first.booking.id));
    const notified = store.getWaitlistEntry(waitlist.entry.id);
    assert.equal(notified.status, "notified");
    assert.ok(notified.notified_at);
    assert.ok(store.listWaitlistEmails(waitlist.entry.id)
        .some((email) => email.kind === "waitlist_availability"));
});

test("diary includes attention counts and contact-based guest history", async (t) => {
    const { store, service } = createFixture();
    t.after(() => store.close());

    const previous = await service.createBooking(bookingInput({
        time: "14:30",
        requests: "Gluten free"
    }));
    await service.updateBooking(previous.booking.id, { status: "completed" });
    await service.createBooking(bookingInput({
        time: "17:00",
        partySize: 7,
        requests: "Birthday"
    }));

    const diary = service.listDiary("2026-07-29");
    const current = diary.bookings.find((booking) => booking.time === "17:00");
    assert.equal(current.guestHistory.previousBookingCount, 1);
    assert.equal(current.guestHistory.completedVisitCount, 1);
    assert.equal(diary.attention.largeParty, 1);
    assert.equal(diary.attention.specialRequest, 2);
    assert.equal(diary.attention.depositPending, undefined);
});
