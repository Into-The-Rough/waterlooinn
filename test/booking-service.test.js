"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { BookingStore } = require("../booking/store");
const { EmailService } = require("../booking/email-service");
const { BookingService } = require("../booking/service");

async function createFixture(options = {}) {
    const store = new BookingStore(":memory:");
    const mailer = new EmailService(store, {
        apiKey: "",
        publicUrl: "http://localhost:8888",
        staffEmail: "pub@example.com"
    });
    const service = new BookingService(store, mailer, {
        now: options.now || (() => new Date("2026-07-28T10:00:00Z")),
        requireEmailVerification: options.requireEmailVerification ?? false
    });
    if (options.onlineBookingsEnabled !== false) {
        await service.setOnlineBookingsEnabled(true, { actor: "Test setup" });
    }
    const manageTokens = new Map();
    for (const method of ["sendBookingEmails", "sendAmendmentEmails", "sendReminderEmail"]) {
        const original = mailer[method].bind(mailer);
        mailer[method] = (booking, token) => {
            manageTokens.set(booking.id, token);
            return original(booking, token);
        };
    }
    const originalCreateBooking = service.createBooking.bind(service);
    service.createBooking = (input, createOptions = {}) => originalCreateBooking(input, {
        ...createOptions,
        idempotencyKey: createOptions.admin
            ? (createOptions.idempotencyKey || null)
            : (createOptions.idempotencyKey || crypto.randomUUID())
    });
    const originalCreateWaitlist = service.createWaitlistEntry.bind(service);
    service.createWaitlistEntry = (input, createOptions = {}) => originalCreateWaitlist(input, {
        ...createOptions,
        idempotencyKey: createOptions.idempotencyKey || crypto.randomUUID()
    });
    store.testManageTokens = manageTokens;
    return { store, mailer, service };
}

test("a fresh booking database starts with public online bookings disabled", async (t) => {
    const { store, service } = await createFixture({ onlineBookingsEnabled: false });
    t.after(() => store.close());

    assert.equal((await service.getOnlineBookingState()).enabled, false);
    await assert.rejects(
        service.getPublicAvailability("2026-07-29", 2),
        (error) => error.code === "ONLINE_BOOKINGS_CLOSED"
    );
});

function manageTokenFor(store, bookingId) {
    return store.testManageTokens.get(bookingId);
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

test("publishes the configured Wednesday availability", async (t) => {
    const { store, service } = await createFixture();
    t.after(() => store.close());

    const availability = await service.getAvailability("2026-07-29", 4);
    assert.equal(availability.service.label, "Wednesday");
    assert.equal(availability.durationMinutes, 120);
    assert.equal(availability.slots[0].time, "12:00");
    assert.equal(availability.slots.at(-1).time, "20:00");
    assert.equal(availability.slots.every((slot) => slot.available), true);
    await assert.rejects(
        service.getAvailability("2026-08-04", 2),
        /not available on Tuesdays/
    );
});

test("public bookings start tomorrow while admins can record a same-day booking", async (t) => {
    const { store, service } = await createFixture();
    t.after(() => store.close());

    await assert.rejects(
        service.getPublicAvailability("2026-07-28", 2),
        (error) => error.code === "SAME_DAY_BOOKING" && /at least one day in advance/.test(error.message)
    );
    await assert.rejects(
        service.createBooking(bookingInput({ date: "2026-07-28" })),
        (error) => error.code === "SAME_DAY_BOOKING"
    );

    const adminBooking = await service.createBooking(bookingInput({
        date: "2026-07-28",
        partySize: 7,
        name: "Same-day telephone booking"
    }), { admin: true, actor: "Test manager" });
    assert.equal(adminBooking.booking.date, "2026-07-28");
    assert.equal(adminBooking.booking.partySize, 7);
});

test("weekly food booking days and times are editable without removing existing bookings", async (t) => {
    const { store, service } = await createFixture();
    t.after(() => store.close());

    const existing = await service.createBooking(bookingInput());
    const defaults = (await service.getOnlineBookingState()).serviceHours;
    const wednesday = defaults.find((day) => day.weekday === 3);
    assert.equal(wednesday.enabled, true);

    const closedWednesday = defaults.map((day) => day.weekday === 3
        ? { ...day, enabled: false }
        : day);
    const closedState = await service.setServiceHours(closedWednesday, {
        actor: "Test Manager",
        requestId: "schedule-request-1"
    });
    assert.equal(closedState.serviceHours.find((day) => day.weekday === 3).enabled, false);
    assert.equal(closedState.serviceHoursUpdatedBy, "Test Manager");
    await assert.rejects(
        service.getPublicAvailability("2026-07-29", 2),
        (error) => error.code === "CLOSED_DAY" && /Wednesdays/.test(error.message)
    );

    const diary = await service.listDiary("2026-07-29");
    assert.equal(diary.service, null);
    assert.deepEqual(diary.slots, []);
    assert.equal(diary.bookings[0].id, existing.booking.id);
    const calendarDay = (await service.listCalendar("2026-07")).days
        .find((day) => day.date === "2026-07-29");
    assert.equal(calendarDay.isRegularServiceDay, false);
    assert.equal(calendarDay.bookingCount, 1);

    const reopenedWednesday = closedState.serviceHours.map((day) => day.weekday === 3
        ? { ...day, enabled: true, start: "17:00", end: "19:00" }
        : day);
    await service.setServiceHours(reopenedWednesday, { actor: "Test Manager" });
    const availability = await service.getAvailability("2026-07-29", 2);
    assert.equal(availability.slots[0].time, "17:00");
    assert.equal(availability.slots.at(-1).time, "19:00");

    await assert.rejects(
        service.setServiceHours(reopenedWednesday.map((day) => day.weekday === 3
            ? { ...day, start: "17:15" }
            : day)),
        /30-minute intervals/
    );
});

test("global master switch blocks new public bookings but leaves admin booking available", async (t) => {
    const { store, service } = await createFixture();
    t.after(() => store.close());

    assert.equal((await service.getOnlineBookingState()).enabled, true);
    assert.equal((await service.getOnlineBookingState()).maxCovers, 30);
    assert.equal((await service.getOnlineBookingState()).maxArrivalCovers, 10);
    const disabled = await service.setOnlineBookingsEnabled(false, {
        actor: "Test Manager",
        requestId: "request-1"
    });
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.updatedBy, "Test Manager");
    await assert.rejects(
        service.getPublicAvailability("2026-07-29", 2),
        (error) => error.code === "ONLINE_BOOKINGS_CLOSED"
    );
    await assert.rejects(
        service.createBooking(bookingInput()),
        (error) => error.code === "ONLINE_BOOKINGS_CLOSED"
    );

    const adminBooking = await service.createBooking(bookingInput({
        email: "",
        phone: "",
        source: "phone"
    }), { admin: true, actor: "Test Manager" });
    assert.equal(adminBooking.booking.status, "confirmed");

    const enabled = await service.setOnlineBookingsEnabled(true, { actor: "Test Manager" });
    assert.equal(enabled.enabled, true);
    assert.equal((await service.getPublicAvailability("2026-07-29", 2)).slots[0].available, true);
});

test("peak cover capacity is editable and used by availability and diary summaries", async (t) => {
    const { store, service } = await createFixture();
    t.after(() => store.close());

    const state = await service.setMaxOnlineCovers(36, { actor: "Test Manager" });
    assert.equal(state.maxCovers, 36);
    const firstSlot = (await service.getAvailability("2026-07-29", 2)).slots[0];
    assert.equal(firstSlot.remainingPeakCovers, 36);
    assert.equal(firstSlot.remainingArrivalCovers, 10);
    assert.equal(firstSlot.remainingCovers, 10);
    assert.equal((await service.listDiary("2026-07-29")).config.maxOnlineCovers, 36);
    assert.equal((await service.listCalendar("2026-07")).maxCovers, 36);
    await assert.rejects(service.setMaxOnlineCovers(0), /between 1 and 500/);
    await assert.rejects(service.setMaxOnlineCovers(12.5), /whole number/);
});

test("half-hour arrival capacity defaults to 10 and is editable", async (t) => {
    const { store, service } = await createFixture();
    t.after(() => store.close());

    assert.equal((await service.getOnlineBookingState()).maxArrivalCovers, 10);
    const state = await service.setMaxOnlineArrivalCovers(12, { actor: "Test Manager" });
    assert.equal(state.maxArrivalCovers, 12);
    const firstSlot = (await service.getAvailability("2026-07-29", 2)).slots[0];
    assert.equal(firstSlot.remainingArrivalCovers, 12);
    assert.equal((await service.listDiary("2026-07-29")).config.maxOnlineArrivalCovers, 12);
    await assert.rejects(service.setMaxOnlineArrivalCovers(0), /between 1 and 500/);
    await assert.rejects(service.setMaxOnlineArrivalCovers(12.5), /whole number/);
});

test("creates a confirmed booking and customer/staff email previews", async (t) => {
    const { store, service } = await createFixture();
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
    const customerEmail = store.getEmail(emails.find((email) => email.kind === "customer_confirmation").id);
    assert.match(customerEmail.html, /reserved for a maximum of two hours/);
});

test("admin bookings support up to 30 guests while public bookings remain capped at seven", async (t) => {
    const { store, service } = await createFixture();
    t.after(() => store.close());

    await assert.rejects(
        service.createBooking(bookingInput({ partySize: 8 })),
        /Online bookings are available for 1–7 guests/
    );

    const result = await service.createBooking(bookingInput({ partySize: 30 }), {
        admin: true,
        overrideCapacity: true,
        actor: "Test manager"
    });
    assert.equal(result.booking.partySize, 30);
    assert.equal((await service.getManagedBookingById(result.booking.id)).canAmend, false);

    await assert.rejects(
        service.createBooking(bookingInput({ partySize: 31 }), {
            admin: true,
            overrideCapacity: true,
            actor: "Test manager"
        }),
        /Admin bookings are available for 1–30 guests/
    );
});

test("SQLite party-size migration preserves existing booking records", async (t) => {
    const { store, service } = await createFixture();
    t.after(() => store.close());
    const existing = await service.createBooking(bookingInput());
    const emailCount = store.listEmailsForBooking(existing.booking.id).length;
    const eventCount = store.listBookingEvents(existing.booking.id).length;

    store.migrateAdminPartySizeLimit();

    assert.equal((await store.getBooking(existing.booking.id)).party_size, 4);
    assert.equal(store.listEmailsForBooking(existing.booking.id).length, emailCount);
    assert.equal(store.listBookingEvents(existing.booking.id).length, eventCount);
    assert.equal(store.db.prepare("PRAGMA foreign_key_check").all().length, 0);

    const large = await service.createBooking(bookingInput({
        time: "18:00",
        partySize: 30,
        name: "Large admin party"
    }), {
        admin: true,
        overrideCapacity: true,
        actor: "Test manager"
    });
    assert.equal(large.booking.partySize, 30);
});

test("failed email delivery does not expire a confirmed website booking", async (t) => {
    let now = new Date("2026-07-28T10:00:00Z");
    const { store, mailer, service } = await createFixture({ now: () => now });
    t.after(() => store.close());
    mailer.sendBookingEmails = async () => [
        { kind: "customer_confirmation", status: "failed" },
        { kind: "staff_notification", status: "failed" }
    ];

    const result = await service.createBooking(bookingInput());
    assert.equal(result.booking.status, "confirmed");
    assert.equal(result.booking.holdExpiresAt, null);
    assert.equal(result.emailStatus, "failed");

    now = new Date("2026-07-28T11:00:00Z");
    const diary = await service.listDiary("2026-07-29");
    assert.equal(diary.bookings[0].status, "confirmed");
    assert.equal(diary.summary.bookingCount, 1);
    assert.equal(diary.summary.covers, 4);
});

test("enforces overlapping cover capacity", async (t) => {
    const { store, service } = await createFixture();
    t.after(() => store.close());
    await service.setMaxOnlineCovers(28, { actor: "Test manager" });

    await service.createBooking(bookingInput({
        partySize: 7,
        name: "First Party",
        email: "first@example.com"
    }));
    await service.createBooking(bookingInput({
        time: "12:30",
        partySize: 7,
        name: "Second Party",
        email: "second@example.com"
    }));
    await service.createBooking(bookingInput({
        time: "13:00",
        partySize: 7,
        name: "Third Party",
        email: "third@example.com"
    }));
    await service.createBooking(bookingInput({
        time: "13:30",
        partySize: 7,
        name: "Fourth Party",
        email: "fourth@example.com"
    }));

    const availability = await service.getAvailability("2026-07-29", 1);
    const oneThirty = availability.slots.find((slot) => slot.time === "13:30");
    assert.equal(oneThirty.available, false);
    assert.equal(oneThirty.remainingCovers, 0);
});

test("limits arrivals to 10 covers in each exact half-hour slot", async (t) => {
    const { store, service } = await createFixture();
    t.after(() => store.close());

    await service.createBooking(bookingInput({
        partySize: 7,
        name: "First Arrival",
        email: "first-arrival@example.com"
    }));
    const afterSeven = await service.getAvailability("2026-07-29", 3);
    assert.equal(afterSeven.slots.find((slot) => slot.time === "12:00").available, true);
    assert.equal(afterSeven.slots.find((slot) => slot.time === "12:00").remainingArrivalCovers, 3);
    assert.equal(afterSeven.slots.find((slot) => slot.time === "12:30").remainingArrivalCovers, 10);

    await assert.rejects(
        service.createBooking(bookingInput({
            partySize: 4,
            name: "Too Many Arrivals",
            email: "too-many@example.com"
        })),
        (error) => error.code === "SLOT_UNAVAILABLE"
    );
    await service.createBooking(bookingInput({
        partySize: 3,
        name: "Final Arrival",
        email: "final-arrival@example.com"
    }));
    const fullSlot = (await service.getAvailability("2026-07-29", 1)).slots
        .find((slot) => slot.time === "12:00");
    assert.equal(fullSlot.available, false);
    assert.equal(fullSlot.remainingArrivalCovers, 0);
    assert.equal(fullSlot.remainingPeakCovers, 20);

    await assert.rejects(
        service.createBooking(bookingInput({
            partySize: 1,
            name: "Telephone Arrival",
            email: "",
            phone: "",
            source: "phone"
        }), { admin: true, actor: "Test manager" }),
        (error) => error.code === "ARRIVAL_CAPACITY_EXCEEDED"
    );
    const overridden = await service.createBooking(bookingInput({
        partySize: 1,
        name: "Approved Telephone Arrival",
        email: "",
        phone: "",
        source: "phone"
    }), { admin: true, overrideCapacity: true, actor: "Test manager" });
    assert.equal(overridden.booking.status, "confirmed");
});

test("cancellation token cancels once and releases capacity", async (t) => {
    const { store, service } = await createFixture();
    t.after(() => store.close());

    const result = await service.createBooking(bookingInput({ partySize: 7 }));
    const token = manageTokenFor(store, result.booking.id);

    assert.equal((await service.getManagedBooking(token)).canCancel, true);
    const cancelled = await service.cancelBooking(token);
    assert.equal(cancelled.booking.status, "cancelled");
    assert.equal((await service.getAvailability("2026-07-29", 7)).slots[0].available, true);
    await assert.rejects(service.getManagedBooking(token), /invalid or has expired/);
});

test("admin closures remove slots from public availability", async (t) => {
    const { store, service } = await createFixture();
    t.after(() => store.close());

    const block = await service.createBlock({
        date: "2026-07-29",
        time: "18:00",
        reason: "Private supper"
    });
    const availability = await service.getAvailability("2026-07-29", 2);
    assert.equal(availability.slots.find((slot) => slot.time === "18:00").available, false);
    await service.removeBlock(block.id);
    assert.equal(
        (await service.getAvailability("2026-07-29", 2)).slots.find((slot) => slot.time === "18:00").available,
        true
    );
});

test("admin call confirmation is timestamped, idempotent and audited", async (t) => {
    const { store, service } = await createFixture();
    t.after(() => store.close());

    const result = await service.createBooking(bookingInput());
    const bookingId = result.booking.id;
    const confirmed = await service.setCallConfirmation(bookingId, true);

    assert.ok(confirmed.booking.callConfirmedAt);
    assert.equal(confirmed.auditEvents.length, 2);
    assert.equal(confirmed.auditEvents[0].kind, "call_confirmed");
    assert.equal(confirmed.auditEvents[0].actor, "Admin");

    const repeated = await service.setCallConfirmation(bookingId, true);
    assert.equal(repeated.booking.callConfirmedAt, confirmed.booking.callConfirmedAt);
    assert.equal(repeated.auditEvents.length, 2);

    const cleared = await service.setCallConfirmation(bookingId, false);
    assert.equal(cleared.booking.callConfirmedAt, null);
    assert.equal(cleared.auditEvents.length, 3);
    assert.equal(cleared.auditEvents[0].kind, "call_confirmation_cleared");
});

test("monthly calendar summarises bookings, covers and peak capacity", async (t) => {
    const { store, service } = await createFixture();
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
    await service.createBlock({
        date: "2026-07-30",
        time: "*",
        reason: "Private event"
    });

    const calendar = await service.listCalendar("2026-07");
    const bookedDay = calendar.days.find((day) => day.date === "2026-07-29");
    const closedDay = calendar.days.find((day) => day.date === "2026-07-30");

    assert.equal(calendar.monthLabel, "July 2026");
    assert.equal(bookedDay.bookingCount, 2);
    assert.equal(bookedDay.totalCovers, 10);
    assert.equal(bookedDay.peakCovers, 10);
    assert.equal(bookedDay.peakRemaining, 20);
    assert.equal(closedDay.wholeDayClosed, true);
});

test("admins can assign a seating area and table", async (t) => {
    const { store, service } = await createFixture();
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
    const { store, service } = await createFixture();
    t.after(() => store.close());

    const result = await service.createBooking(bookingInput());
    const token = manageTokenFor(store, result.booking.id);
    const confirmed = await service.confirmBooking(token);
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
    const { store, service } = await createFixture({
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

test("reminders rotate manage tokens and stored previews redact the bearer", async (t) => {
    const { store, service } = await createFixture();
    t.after(() => store.close());

    const result = await service.createBooking(bookingInput());
    const originalToken = manageTokenFor(store, result.booking.id);
    await service.sendReminderForBooking(result.booking.id, { force: true });

    await assert.rejects(service.getManagedBooking(originalToken), /invalid or has expired/);
    const rotatedToken = manageTokenFor(store, result.booking.id);
    assert.equal((await service.exchangeManageToken(rotatedToken)).bookingId, result.booking.id);
    const reminder = store.listEmailsForBooking(result.booking.id)
        .find((email) => email.kind === "customer_reminder");
    const storedHtml = store.getEmail(reminder.id).html;
    assert.doesNotMatch(storedHtml, new RegExp(rotatedToken));
    assert.match(storedHtml, /#token=redacted/);
});

test("a cancellation offers released capacity to the earliest waiting guest", async (t) => {
    const { store, service } = await createFixture();
    t.after(() => store.close());
    await service.setMaxOnlineCovers(28, { actor: "Test manager" });
    await service.setMaxOnlineArrivalCovers(28, { actor: "Test manager" });

    const first = await service.createBooking(bookingInput({
        partySize: 7,
        name: "First Full Table",
        email: "first-full@example.com"
    }));
    await service.createBooking(bookingInput({
        partySize: 7,
        name: "Second Full Table",
        email: "second-full@example.com"
    }));
    await service.createBooking(bookingInput({
        partySize: 7,
        name: "Third Full Table",
        email: "third-full@example.com"
    }));
    await service.createBooking(bookingInput({
        partySize: 7,
        name: "Fourth Full Table",
        email: "fourth-full@example.com"
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
    const { store, service } = await createFixture();
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

    const diary = await service.listDiary("2026-07-29");
    const current = diary.bookings.find((booking) => booking.time === "17:00");
    assert.equal(current.guestHistory.previousBookingCount, 1);
    assert.equal(current.guestHistory.completedVisitCount, 1);
    assert.equal(diary.attention.largeParty, 1);
    assert.equal(diary.attention.specialRequest, 2);
    assert.equal(diary.attention.depositPending, undefined);
});

test("rejects impossible ISO calendar dates", async (t) => {
    const { store, service } = await createFixture();
    t.after(() => store.close());
    await assert.rejects(service.getAvailability("2026-09-31", 2), /valid date/);
    await assert.rejects(service.getAvailability("2026-02-29", 2), /valid date/);
});

test("customer management response excludes administrative and contact fields", async (t) => {
    const { store, service } = await createFixture();
    t.after(() => store.close());
    const result = await service.createBooking(bookingInput());
    await service.updateBooking(result.booking.id, { internalNotes: "Private staff note" }, {
        actor: "Test manager",
        requestId: "request-1"
    });
    const managed = await service.getManagedBooking(manageTokenFor(store, result.booking.id));
    assert.equal(Object.hasOwn(managed.booking, "internalNotes"), false);
    assert.equal(Object.hasOwn(managed.booking, "email"), false);
    assert.equal(Object.hasOwn(managed.booking, "phone"), false);
    assert.equal(Object.hasOwn(managed.booking, "id"), false);
    const events = store.listBookingEvents(result.booking.id);
    assert.equal(events[0].actor, "Test manager");
    assert.equal(events[0].kind, "booking_details_changed");
});

test("booking creation is idempotent and does not duplicate email", async (t) => {
    const { store, service } = await createFixture();
    t.after(() => store.close());
    const key = "same-request-identifier-001";
    const first = await service.createBooking(bookingInput(), { idempotencyKey: key });
    const second = await service.createBooking(bookingInput(), { idempotencyKey: key });
    assert.equal(second.replayed, true);
    assert.equal(second.booking.id, first.booking.id);
    assert.equal(store.listBookings("2026-07-29").length, 1);
    assert.equal(store.listEmailsForBooking(first.booking.id).length, 2);
});

test("concurrent reminder attempts claim delivery once", async (t) => {
    const { store, service, mailer } = await createFixture();
    t.after(() => store.close());
    const result = await service.createBooking(bookingInput());
    let deliveries = 0;
    mailer.sendReminderEmail = async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        deliveries += 1;
        return { status: "sent" };
    };
    const reminders = await Promise.all([
        service.sendReminderForBooking(result.booking.id),
        service.sendReminderForBooking(result.booking.id)
    ]);
    assert.equal(deliveries, 1);
    assert.equal(reminders.filter((item) => item.prepared).length, 1);
});

test("email-verification holds remain available only when explicitly enabled", async (t) => {
    const { store, service } = await createFixture({ requireEmailVerification: true });
    t.after(() => store.close());
    const result = await service.createBooking(bookingInput());
    assert.equal(result.booking.status, "pending");
    assert.ok(result.booking.holdExpiresAt);
    const confirmed = await service.confirmBooking(manageTokenFor(store, result.booking.id));
    assert.equal(confirmed.booking.status, "confirmed");
    assert.equal(confirmed.canConfirm, false);
});

test("manage tokens expire after the booking grace period", async (t) => {
    let now = new Date("2026-07-28T10:00:00Z");
    const { store, service } = await createFixture({ now: () => now });
    t.after(() => store.close());
    const result = await service.createBooking(bookingInput());
    const token = manageTokenFor(store, result.booking.id);
    now = new Date("2026-07-31T13:00:00Z");
    await assert.rejects(service.getManagedBooking(token), /invalid or has expired/);
});

test("failed replacement email keeps the previous manage token usable", async (t) => {
    const { store, service, mailer } = await createFixture();
    t.after(() => store.close());
    const result = await service.createBooking(bookingInput());
    const originalToken = manageTokenFor(store, result.booking.id);
    mailer.sendReminderEmail = async () => ({ status: "failed", error: "provider unavailable" });

    const reminder = await service.sendReminderForBooking(result.booking.id, { force: true });

    assert.equal(reminder.prepared, false);
    assert.equal((await service.exchangeManageToken(originalToken)).bookingId, result.booking.id);
});

test("expired verification holds disappear from admin capacity summaries", async (t) => {
    let now = new Date("2026-07-28T10:00:00Z");
    const { store, service } = await createFixture({
        now: () => now,
        requireEmailVerification: true
    });
    t.after(() => store.close());
    const result = await service.createBooking(bookingInput());
    const token = manageTokenFor(store, result.booking.id);
    now = new Date("2026-07-28T10:16:00Z");

    const diary = await service.listDiary("2026-07-29");

    assert.equal(diary.bookings[0].status, "expired");
    assert.equal(diary.summary.bookingCount, 0);
    assert.equal(diary.summary.covers, 0);
    const calendarDay = (await service.listCalendar("2026-07")).days.find((day) => day.date === "2026-07-29");
    assert.equal(calendarDay.recordCount, 1);
    assert.equal(calendarDay.bookingCount, 0);
    assert.equal(calendarDay.inactiveCount, 1);
    assert.equal(calendarDay.expiredCount, 1);
    await assert.rejects(service.exchangeManageToken(token), /invalid or has expired/);
});

test("recent booking activity returns the newest records first", async (t) => {
    let now = new Date("2026-07-28T10:00:00Z");
    const { store, service } = await createFixture({ now: () => now });
    t.after(() => store.close());

    const first = await service.createBooking(bookingInput({ email: "first@example.com" }));
    now = new Date("2026-07-28T10:01:00Z");
    const second = await service.createBooking(bookingInput({
        time: "15:00",
        name: "Newest Guest",
        email: "newest@example.com"
    }));

    const result = await service.listRecentBookings(1);
    assert.equal(result.bookings.length, 1);
    assert.equal(result.bookings[0].id, second.booking.id);
    assert.equal(result.bookings[0].name, "Newest Guest");
    assert.notEqual(result.bookings[0].id, first.booking.id);
    await assert.rejects(service.listRecentBookings(21), /between 1 and 20/);
});

test("recent booking activity excludes visits before today", async (t) => {
    let now = new Date("2026-07-28T10:00:00Z");
    const { store, service } = await createFixture({ now: () => now });
    t.after(() => store.close());

    const oldVisit = await service.createBooking(bookingInput({
        name: "Yesterday's Guest",
        email: "yesterday@example.com"
    }));
    now = new Date("2026-07-30T10:00:00Z");
    const upcomingVisit = await service.createBooking(bookingInput({
        date: "2026-07-31",
        name: "Upcoming Guest",
        email: "upcoming@example.com"
    }));

    const result = await service.listRecentBookings(6);
    assert.deepEqual(result.bookings.map((booking) => booking.id), [upcomingVisit.booking.id]);
    assert.notEqual(result.bookings[0].id, oldVisit.booking.id);
});

test("waiting-list creation is idempotent", async (t) => {
    const { store, service } = await createFixture();
    t.after(() => store.close());
    await service.setMaxOnlineCovers(28, { actor: "Test manager" });
    await service.setMaxOnlineArrivalCovers(28, { actor: "Test manager" });
    await service.createBooking(bookingInput({ partySize: 7, email: "one@example.com" }));
    await service.createBooking(bookingInput({ partySize: 7, email: "two@example.com" }));
    await service.createBooking(bookingInput({ partySize: 7, email: "three@example.com" }));
    await service.createBooking(bookingInput({ partySize: 7, email: "four@example.com" }));
    const input = {
        date: "2026-07-29",
        time: "12:00",
        partySize: 2,
        name: "Waiting Guest",
        email: "waiting@example.com",
        phone: "07111111111"
    };
    const key = "same-waitlist-request-001";

    const first = await service.createWaitlistEntry(input, { idempotencyKey: key });
    const emailCount = store.listWaitlistEmails(first.entry.id).length;
    const second = await service.createWaitlistEntry(input, { idempotencyKey: key });

    assert.equal(second.replayed, true);
    assert.equal(second.entry.id, first.entry.id);
    assert.equal(store.listWaitlist("2026-07-29").length, 1);
    assert.equal(store.listWaitlistEmails(first.entry.id).length, emailCount);
});

test("durable rate limits and retention remove stale personal data", async (t) => {
    let now = new Date("2026-07-28T10:00:00Z");
    const { store, service } = await createFixture({ now: () => now });
    t.after(() => store.close());
    assert.equal(await store.consumeRateLimit({
        id: crypto.randomUUID(), key: "source", action: "book", now: 1000, windowMs: 1000, limit: 2
    }), true);
    assert.equal(await store.consumeRateLimit({
        id: crypto.randomUUID(), key: "source", action: "book", now: 1001, windowMs: 1000, limit: 2
    }), true);
    assert.equal(await store.consumeRateLimit({
        id: crypto.randomUUID(), key: "source", action: "book", now: 1002, windowMs: 1000, limit: 2
    }), false);

    const result = await service.createBooking(bookingInput());
    now = new Date("2028-01-01T10:00:00Z");
    const retained = await service.runRetention();
    const booking = store.getBooking(result.booking.id);

    assert.ok(retained.bookingEmails >= 2);
    assert.equal(booking.guest_name, "Deleted guest");
    assert.equal(booking.email, null);
    assert.equal(booking.phone, null);
    assert.equal(booking.requests, "");
    assert.equal(store.listEmailsForBooking(result.booking.id).length, 0);
});
