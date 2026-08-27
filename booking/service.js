"use strict";

const crypto = require("node:crypto");
const {
    BOOKING_CONFIG,
    dateDistance,
    formatTime,
    generateSlots,
    getServiceRule,
    isIsoDate,
    timeToMinutes,
    venueDateTime,
    venueNow
} = require("./config");
const {
    cleanText,
    normalisePhone,
    validateEmail,
    validationError
} = require("./validation");

const ACTIVE_STATUSES = new Set(["pending", "confirmed", "arrived", "seated"]);
const VALID_STATUSES = new Set([
    "pending", "confirmed", "arrived", "seated", "completed", "cancelled", "no_show", "expired"
]);
const VALID_SOURCES = new Set(["web", "phone", "walk_in", "admin"]);
const VALID_AREAS = new Set(BOOKING_CONFIG.areas);
const VALID_WAITLIST_STATUSES = new Set(["waiting", "notified", "booked", "closed"]);

function tokenHash(token) {
    return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function publicBooking(row) {
    if (!row) return null;
    return {
        id: row.id,
        reference: row.reference,
        date: row.booking_date,
        time: row.booking_time,
        timeLabel: formatTime(row.booking_time),
        durationMinutes: row.duration_minutes,
        partySize: row.party_size,
        name: row.guest_name,
        email: row.email || "",
        phone: row.phone || "",
        requests: row.requests || "",
        internalNotes: row.internal_notes || "",
        source: row.source,
        status: row.status,
        emailStatus: row.email_status,
        area: row.area || "Restaurant",
        tableLabel: row.table_label || "",
        reminderSentAt: row.reminder_sent_at || null,
        holdExpiresAt: row.hold_expires_at || null,
        customerConfirmedAt: row.customer_confirmed_at || null,
        callConfirmedAt: row.call_confirmed_at || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        cancelledAt: row.cancelled_at
    };
}

function customerBooking(row) {
    if (!row) return null;
    return {
        reference: row.reference,
        date: row.booking_date,
        time: row.booking_time,
        timeLabel: formatTime(row.booking_time),
        partySize: row.party_size,
        name: row.guest_name,
        requests: row.requests || "",
        status: row.status,
        customerConfirmedAt: row.customer_confirmed_at || null,
        holdExpiresAt: row.hold_expires_at || null
    };
}

function publicWaitlistEntry(row) {
    if (!row) return null;
    return {
        id: row.id,
        date: row.booking_date,
        time: row.booking_time,
        timeLabel: formatTime(row.booking_time),
        partySize: row.party_size,
        name: row.guest_name,
        email: row.email,
        phone: row.phone,
        notes: row.notes || "",
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        notifiedAt: row.notified_at || null,
        bookedAt: row.booked_at || null
    };
}

class BookingService {
    constructor(store, mailer, options = {}) {
        this.store = store;
        this.mailer = mailer;
        this.now = options.now || (() => new Date());
        this.requireEmailVerification = options.requireEmailVerification ??
            (process.env.BOOKING_REQUIRE_EMAIL_VERIFICATION === "true" || process.env.NODE_ENV === "production");
    }

    nowDate() {
        return new Date(this.now());
    }

    nowIso() {
        return this.nowDate().toISOString();
    }

    createManageToken() {
        return crypto.randomBytes(32).toString("base64url");
    }

    tokenExpiryForBooking(booking) {
        const serviceTime = venueDateTime(booking.booking_date, booking.booking_time);
        if (!serviceTime) return null;
        return new Date(
            serviceTime.getTime() +
            ((booking.duration_minutes + (BOOKING_CONFIG.manageTokenGraceHours * 60)) * 60 * 1000)
        ).toISOString();
    }

    async issueManageToken(booking) {
        const credential = this.createManageCredential(booking);
        await this.activateManageCredential(booking.id, credential);
        return credential.rawToken;
    }

    createManageCredential(booking) {
        const rawToken = this.createManageToken();
        return {
            rawToken,
            hash: tokenHash(rawToken),
            expiresAt: this.tokenExpiryForBooking(booking)
        };
    }

    async activateManageCredential(bookingId, credential) {
        await this.store.updateBooking(bookingId, {
            cancellation_token_hash: credential.hash,
            stable_manage_token_hash: null,
            manage_token_expires_at: credential.expiresAt,
            updated_at: this.nowIso()
        });
    }

    async resolveManageToken(token) {
        if (!token || String(token).length > 128) return null;
        const booking = await this.store.getBookingByTokenHash(tokenHash(token));
        if (!booking || !booking.manage_token_expires_at ||
            Date.parse(booking.manage_token_expires_at) <= this.nowDate().getTime()) return null;
        return booking;
    }

    async appendEvent(bookingId, kind, actor, details = "") {
        return this.store.insertBookingEvent({
            id: crypto.randomUUID(),
            booking_id: bookingId,
            kind,
            actor,
            details: cleanText(details, 500),
            created_at: this.nowIso()
        });
    }

    async appendAdminEvent(actor, action, targetType, targetId, details = "", requestId = null) {
        return this.store.insertAdminEvent({
            id: crypto.randomUUID(),
            actor: cleanText(actor || "Admin", 100),
            action: cleanText(action, 100),
            target_type: cleanText(targetType, 50),
            target_id: targetId || null,
            details: cleanText(details, 500),
            request_id: requestId || null,
            created_at: this.nowIso()
        });
    }

    async getOnlineBookingState() {
        const [enabled, maxCovers, updatedAt, updatedBy] = await Promise.all([
            this.store.getAppMeta("online_bookings_enabled", "false"),
            this.getMaxOnlineCovers(),
            this.store.getAppMeta("online_bookings_updated_at"),
            this.store.getAppMeta("online_bookings_updated_by")
        ]);
        return {
            enabled: enabled === "true",
            maxCovers,
            updatedAt: updatedAt || null,
            updatedBy: updatedBy || null
        };
    }

    async getMaxOnlineCovers() {
        const stored = Number(await this.store.getAppMeta("max_online_covers", BOOKING_CONFIG.maxOnlineCovers));
        return Number.isInteger(stored) && stored >= 1 && stored <= 500
            ? stored
            : BOOKING_CONFIG.maxOnlineCovers;
    }

    async requireOnlineBookingsEnabled() {
        if ((await this.getOnlineBookingState()).enabled) return;
        throw Object.assign(new Error(
            "Online booking is temporarily unavailable. Please call us on 01298 463248."
        ), {
            status: 503,
            code: "ONLINE_BOOKINGS_CLOSED"
        });
    }

    async setOnlineBookingsEnabled(enabled, audit = {}) {
        if (typeof enabled !== "boolean") {
            throw validationError("Please provide a valid online booking state.", "enabled");
        }
        const current = await this.getOnlineBookingState();
        if (current.enabled === enabled) return current;
        const actor = cleanText(audit.actor || "Admin", 100);
        const updatedAt = this.nowIso();
        await this.store.transaction(async () => {
            await this.store.setAppMeta("online_bookings_enabled", enabled ? "true" : "false");
            await this.store.setAppMeta("online_bookings_updated_at", updatedAt);
            await this.store.setAppMeta("online_bookings_updated_by", actor);
            await this.appendAdminEvent(
                actor,
                enabled ? "online_bookings_enabled" : "online_bookings_disabled",
                "booking_settings",
                "global",
                enabled ? "Public online bookings opened" : "Public online bookings closed",
                audit.requestId
            );
        });
        return this.getOnlineBookingState();
    }

    async setMaxOnlineCovers(value, audit = {}) {
        const maxCovers = Number(value);
        if (!Number.isInteger(maxCovers) || maxCovers < 1 || maxCovers > 500) {
            throw validationError("Peak cover capacity must be a whole number between 1 and 500.", "maxCovers");
        }
        if (await this.getMaxOnlineCovers() === maxCovers) return this.getOnlineBookingState();
        const actor = cleanText(audit.actor || "Admin", 100);
        const updatedAt = this.nowIso();
        await this.store.transaction(async () => {
            await this.store.setAppMeta("max_online_covers", maxCovers);
            await this.store.setAppMeta("online_bookings_updated_at", updatedAt);
            await this.store.setAppMeta("online_bookings_updated_by", actor);
            await this.appendAdminEvent(
                actor,
                "online_capacity_changed",
                "booking_settings",
                "global",
                `Peak cover capacity changed to ${maxCovers}`,
                audit.requestId
            );
        });
        return this.getOnlineBookingState();
    }

    validateDate(date, { allowPast = false, allowClosedDay = false } = {}) {
        if (!isIsoDate(date)) throw validationError("Please choose a valid date.", "date");
        const current = venueNow(this.nowDate());
        const distance = dateDistance(current.date, date);
        if (!allowPast && distance < 0) {
            throw validationError("Please choose a future date.", "date");
        }
        if (!allowPast && distance > BOOKING_CONFIG.maximumAdvanceDays) {
            throw validationError(`Bookings are available up to ${BOOKING_CONFIG.maximumAdvanceDays} days ahead.`, "date");
        }
        if (!allowClosedDay && !getServiceRule(date)) {
            throw validationError("Online table bookings are not available on this day.", "date", "CLOSED_DAY");
        }
        return date;
    }

    validatePartySize(value) {
        const partySize = Number(value);
        if (!Number.isInteger(partySize) || partySize < 1 || partySize > BOOKING_CONFIG.maxPartySize) {
            throw validationError(`Online bookings are available for 1–${BOOKING_CONFIG.maxPartySize} guests.`, "partySize");
        }
        return partySize;
    }

    async overlappingCovers(date, time, durationMinutes, excludeId = "") {
        const start = timeToMinutes(time);
        const end = start + durationMinutes;
        return (await this.store.listActiveBookings(date, excludeId, this.nowIso())).reduce((total, booking) => {
            const bookingStart = timeToMinutes(booking.booking_time);
            const bookingEnd = bookingStart + booking.duration_minutes;
            return bookingStart < end && bookingEnd > start
                ? total + booking.party_size
                : total;
        }, 0);
    }

    async getAvailability(date, partySizeValue, excludeId = "") {
        await this.store.expirePendingHolds(this.nowIso());
        const validDate = this.validateDate(date);
        const partySize = this.validatePartySize(partySizeValue);
        const current = venueNow(this.nowDate());
        const blocks = await this.store.listBlocks(validDate);
        const blockedTimes = new Set(blocks.map((block) => block.booking_time));
        const wholeDayBlocked = blockedTimes.has("*");
        const maxOnlineCovers = await this.getMaxOnlineCovers();
        const slots = [];
        for (const time of generateSlots(validDate)) {
            const usedCovers = await this.overlappingCovers(
                validDate,
                time,
                BOOKING_CONFIG.durationMinutes,
                excludeId
            );
            const remainingCovers = Math.max(0, maxOnlineCovers - usedCovers);
            const tooSoon = validDate === current.date &&
                timeToMinutes(time) < current.minutes + BOOKING_CONFIG.minimumNoticeMinutes;
            const blocked = wholeDayBlocked || blockedTimes.has(time);
            const available = !tooSoon && !blocked && remainingCovers >= partySize;
            let reason = null;
            if (tooSoon) reason = "Online booking has closed for this time";
            else if (blocked) reason = "Unavailable";
            else if (remainingCovers < partySize) reason = "Not enough availability";
            slots.push({
                time,
                label: formatTime(time),
                available,
                waitlistEligible: !tooSoon && !blocked && !available,
                remainingCovers,
                reason
            });
        }
        return {
            date: validDate,
            partySize,
            service: getServiceRule(validDate),
            slotMinutes: BOOKING_CONFIG.slotMinutes,
            durationMinutes: BOOKING_CONFIG.durationMinutes,
            slots
        };
    }

    async getPublicAvailability(date, partySizeValue) {
        await this.requireOnlineBookingsEnabled();
        return this.getAvailability(date, partySizeValue);
    }

    async getManagedAvailability(token, date, partySize) {
        const booking = await this.resolveManageToken(token);
        if (!booking) throw Object.assign(new Error("This booking link is invalid or has expired."), { status: 404, code: "NOT_FOUND" });
        return this.getManagedAvailabilityById(booking.id, date, partySize);
    }

    async getManagedAvailabilityById(id, date, partySize) {
        const managed = await this.getManagedBookingById(id);
        if (!managed.canAmend) {
            throw validationError("This booking can no longer be changed online.", null, "CANNOT_AMEND");
        }
        return this.getAvailability(date, partySize, id);
    }

    normaliseInput(input, { admin = false, allowPast = false } = {}) {
        const date = this.validateDate(input.date, {
            allowPast,
            allowClosedDay: admin
        });
        const partySize = this.validatePartySize(input.partySize);
        const time = cleanText(input.time, 5);
        if (!/^\d{2}:\d{2}$/.test(time)) {
            throw validationError("Please choose an available time.", "time");
        }
        if (!admin && !generateSlots(date).includes(time)) {
            throw validationError("Please choose an available time.", "time");
        }
        const name = cleanText(input.name, 100);
        if (name.length < 2) throw validationError("Please enter the guest name.", "name");
        const emailResult = validateEmail(input.email, !admin);
        const phone = normalisePhone(input.phone, !admin);
        const source = admin && VALID_SOURCES.has(input.source) ? input.source : (admin ? "admin" : "web");
        const area = admin ? cleanText(input.area || "Restaurant", 50) : "Restaurant";
        if (admin && !VALID_AREAS.has(area)) {
            throw validationError("Please choose a valid seating area.", "area");
        }
        return {
            date,
            time,
            partySize,
            name,
            email: emailResult.value,
            emailSuggestion: emailResult.suggestion,
            phone,
            requests: cleanText(input.requests, 1000),
            internalNotes: admin ? cleanText(input.internalNotes, 1000) : "",
            source,
            area,
            tableLabel: admin ? cleanText(input.tableLabel, 50) : ""
        };
    }

    createReference(date) {
        const datePart = date.replaceAll("-", "").slice(2);
        const code = crypto.randomBytes(2).toString("hex").toUpperCase();
        return `WI-${datePart}-${code}`;
    }

    async createBooking(input, {
        admin = false,
        overrideCapacity = false,
        idempotencyKey = null,
        actor = "Admin",
        requestId = null
    } = {}) {
        if (!admin) await this.requireOnlineBookingsEnabled();
        const value = this.normaliseInput(input, { admin });
        if (!admin && value.emailSuggestion && input.acceptEmailSuggestion !== true) {
            throw Object.assign(
                validationError(
                    `Did you mean ${value.emailSuggestion}?`,
                    "email",
                    "EMAIL_SUGGESTION"
                ),
                { suggestion: value.emailSuggestion }
            );
        }
        if (!admin && !/^[A-Za-z0-9._:-]{16,128}$/.test(String(idempotencyKey || ""))) {
            throw validationError("A valid booking request identifier is required.", null, "IDEMPOTENCY_REQUIRED");
        }
        const id = crypto.randomUUID();
        const rawToken = this.createManageToken();
        const now = this.nowIso();
        const status = !admin && this.requireEmailVerification ? "pending" : "confirmed";
        const holdExpiresAt = status === "pending"
            ? new Date(this.nowDate().getTime() + (BOOKING_CONFIG.verificationHoldMinutes * 60 * 1000)).toISOString()
            : null;
        let replayed = false;
        const booking = await this.store.transaction(async () => {
            const duplicate = await this.store.getBookingByIdempotencyKey(idempotencyKey);
            if (duplicate) {
                replayed = true;
                return duplicate;
            }
            if (!admin) {
                const availability = await this.getAvailability(value.date, value.partySize);
                const chosen = availability.slots.find((slot) => slot.time === value.time);
                if (!chosen?.available) {
                    throw validationError(
                        chosen?.reason || "That time is no longer available.",
                        "time",
                        "SLOT_UNAVAILABLE"
                    );
                }
            } else if (!overrideCapacity) {
                const used = await this.overlappingCovers(
                    value.date,
                    value.time,
                    BOOKING_CONFIG.durationMinutes
                );
                if (used + value.partySize > await this.getMaxOnlineCovers()) {
                    throw validationError(
                        "This booking would exceed the current online cover limit. Use the override if the pub can accommodate it.",
                        "partySize",
                        "CAPACITY_EXCEEDED"
                    );
                }
            }
            const inserted = await this.store.insertBooking({
                id,
                reference: this.createReference(value.date),
                booking_date: value.date,
                booking_time: value.time,
                duration_minutes: BOOKING_CONFIG.durationMinutes,
                party_size: value.partySize,
                guest_name: value.name,
                email: value.email || null,
                phone: value.phone || null,
                requests: value.requests,
                internal_notes: value.internalNotes,
                source: value.source,
                status,
                cancellation_token_hash: tokenHash(rawToken),
                stable_manage_token_hash: null,
                manage_token_expires_at: null,
                idempotency_key: idempotencyKey,
                email_status: "pending",
                created_at: now,
                updated_at: now,
                cancelled_at: null,
                call_confirmed_at: null,
                customer_confirmed_at: null,
                reminder_sent_at: null,
                reminder_claimed_at: null,
                hold_expires_at: holdExpiresAt,
                area: value.area,
                table_label: value.tableLabel
            });
            await this.store.insertBookingEvent({
                id: crypto.randomUUID(),
                booking_id: id,
                kind: "booking_created",
                actor: admin ? actor : "Customer",
                details: `${value.partySize} guests · ${value.date} ${value.time}`,
                created_at: now
            });
            return inserted;
        });

        if (replayed) {
            return {
                booking: publicBooking(booking),
                emailSuggestion: value.emailSuggestion,
                emailStatus: booking.email_status,
                replayed: true
            };
        }

        if (admin) await this.appendAdminEvent(actor, "booking_created", "booking", booking.id, "", requestId);

        await this.store.updateBooking(booking.id, {
            manage_token_expires_at: this.tokenExpiryForBooking(booking),
            updated_at: now
        });

        const emails = await this.mailer.sendBookingEmails(await this.store.getBooking(booking.id), rawToken);
        const customerEmail = emails.find((email) => email.kind === "customer_confirmation");
        const emailStatus = customerEmail?.status || emails[0]?.status || "pending";
        const updated = await this.store.updateBooking(booking.id, {
            email_status: emailStatus,
            updated_at: this.nowIso()
        });
        return {
            booking: publicBooking(updated),
            emailSuggestion: value.emailSuggestion,
            emailStatus
        };
    }

    async getManagedBooking(token) {
        const booking = await this.resolveManageToken(token);
        if (!booking) throw Object.assign(new Error("This booking link is invalid or has expired."), { status: 404, code: "NOT_FOUND" });
        return this.getManagedBookingById(booking.id);
    }

    async getManagedBookingById(id) {
        const booking = await this.store.getBooking(id);
        if (!booking) throw Object.assign(new Error("This booking is unavailable."), { status: 404, code: "NOT_FOUND" });
        const current = venueNow(this.nowDate());
        const inFuture = dateDistance(current.date, booking.booking_date) > 0 ||
            (booking.booking_date === current.date && timeToMinutes(booking.booking_time) > current.minutes);
        const holdValid = booking.status !== "pending" ||
            (booking.hold_expires_at && Date.parse(booking.hold_expires_at) > this.nowDate().getTime());
        const activeAndFuture = ACTIVE_STATUSES.has(booking.status) && inFuture && holdValid;
        return {
            booking: customerBooking(booking),
            canCancel: activeAndFuture && booking.status !== "pending",
            canAmend: activeAndFuture && booking.status !== "pending",
            canConfirm: activeAndFuture &&
                (booking.status === "pending" || !booking.customer_confirmed_at)
        };
    }

    async exchangeManageToken(token) {
        const booking = await this.resolveManageToken(token);
        if (!booking) throw Object.assign(new Error("This booking link is invalid or has expired."), { status: 404, code: "NOT_FOUND" });
        return { bookingId: booking.id, managed: await this.getManagedBookingById(booking.id) };
    }

    async confirmBooking(token) {
        const booking = await this.resolveManageToken(token);
        if (!booking) throw Object.assign(new Error("This booking link is invalid or has expired."), { status: 404, code: "NOT_FOUND" });
        return this.confirmBookingById(booking.id);
    }

    async confirmBookingById(id) {
        const managed = await this.getManagedBookingById(id);
        if (!managed.canConfirm) {
            throw validationError("This booking can no longer be confirmed online.", null, "CANNOT_CONFIRM");
        }
        if (managed.booking.customerConfirmedAt) return managed;
        const now = this.nowIso();
        const updated = await this.store.transaction(async () => {
            const current = await this.store.getBooking(id);
            const currentManaged = await this.getManagedBookingById(id);
            if (!currentManaged.canConfirm) {
                throw validationError("This booking can no longer be confirmed online.", null, "CANNOT_CONFIRM");
            }
            const changed = await this.store.updateBooking(id, {
                status: current.status === "pending" ? "confirmed" : current.status,
                hold_expires_at: null,
                customer_confirmed_at: now,
                updated_at: now
            });
            await this.store.insertBookingEvent({
                id: crypto.randomUUID(),
                booking_id: id,
                kind: "customer_confirmed",
                actor: "Customer",
                details: "Confirmed from the manage-booking link",
                created_at: now
            });
            return changed;
        });
        return {
            booking: customerBooking(updated),
            canCancel: true,
            canAmend: true,
            canConfirm: false
        };
    }

    async amendBooking(token, input) {
        const booking = await this.resolveManageToken(token);
        if (!booking) throw Object.assign(new Error("This booking link is invalid or has expired."), { status: 404, code: "NOT_FOUND" });
        return this.amendBookingById(booking.id, input, token);
    }

    async amendBookingById(id, input, manageToken = null) {
        const managed = await this.getManagedBookingById(id);
        if (!managed.canAmend) {
            throw validationError("This booking can no longer be changed online.", null, "CANNOT_AMEND");
        }
        const existing = await this.store.getBooking(id);
        const value = this.normaliseInput({
            date: input.date ?? existing.booking_date,
            time: input.time ?? existing.booking_time,
            partySize: input.partySize ?? existing.party_size,
            name: existing.guest_name,
            email: existing.email,
            phone: existing.phone,
            requests: input.requests ?? existing.requests
        });
        const availability = await this.getAvailability(value.date, value.partySize, existing.id);
        const chosen = availability.slots.find((slot) => slot.time === value.time);
        if (!chosen?.available) {
            throw validationError(
                chosen?.reason || "That time is no longer available.",
                "time",
                "SLOT_UNAVAILABLE"
            );
        }
        const now = this.nowIso();
        const details = `${existing.booking_date} ${existing.booking_time}, ${existing.party_size} guests → ${value.date} ${value.time}, ${value.partySize} guests`;
        const updated = await this.store.transaction(async () => {
            const transactionalAvailability = await this.getAvailability(value.date, value.partySize, existing.id);
            const transactionalChoice = transactionalAvailability.slots.find((slot) => slot.time === value.time);
            if (!transactionalChoice?.available) {
                throw validationError(
                    transactionalChoice?.reason || "That time is no longer available.",
                    "time",
                    "SLOT_UNAVAILABLE"
                );
            }
            const changed = await this.store.updateBooking(existing.id, {
                booking_date: value.date,
                booking_time: value.time,
                party_size: value.partySize,
                requests: value.requests,
                customer_confirmed_at: now,
                reminder_sent_at: null,
                updated_at: now
            });
            await this.store.insertBookingEvent({
                id: crypto.randomUUID(),
                booking_id: existing.id,
                kind: "customer_amended",
                actor: "Customer",
                details,
                created_at: now
            });
            return changed;
        });
        const credential = manageToken ? null : this.createManageCredential(updated);
        const emailToken = manageToken || credential.rawToken;
        const emails = await this.mailer.sendAmendmentEmails(await this.store.getBooking(id), emailToken);
        const customerEmail = emails.find((email) => email.kind === "customer_amendment");
        if (credential && customerEmail && customerEmail.status !== "failed") {
            await this.activateManageCredential(id, credential);
        }
        if (customerEmail) {
            await this.store.updateBooking(updated.id, {
                email_status: customerEmail.status,
                updated_at: this.nowIso()
            });
        }
        return this.getManagedBookingById(id);
    }

    async cancelBooking(token) {
        const booking = await this.resolveManageToken(token);
        if (!booking) throw Object.assign(new Error("This booking link is invalid or has expired."), { status: 404, code: "NOT_FOUND" });
        return this.cancelBookingById(booking.id);
    }

    async cancelBookingById(id) {
        const now = this.nowIso();
        const updated = await this.store.transaction(async () => {
            const managed = await this.getManagedBookingById(id);
            if (!managed.canCancel) {
                throw validationError("This booking can no longer be cancelled online.", null, "CANNOT_CANCEL");
            }
            const changed = await this.store.updateBooking(id, {
                status: "cancelled",
                cancelled_at: now,
                updated_at: now,
                cancellation_token_hash: null,
                stable_manage_token_hash: null,
                manage_token_expires_at: null
            });
            await this.store.insertBookingEvent({
                id: crypto.randomUUID(),
                booking_id: id,
                kind: "booking_cancelled",
                actor: "Customer",
                details: "Cancelled online",
                created_at: now
            });
            return changed;
        });
        await this.mailer.sendCancellationEmails(updated);
        await this.notifyWaitlistForDate(updated.booking_date);
        return { booking: customerBooking(updated) };
    }

    async guestHistoryFor(booking) {
        const rows = await this.store.listBookingsByContact(
            booking.email || "",
            booking.phone || "",
            booking.id
        );
        const visits = rows.filter((row) => ["arrived", "seated", "completed"].includes(row.status));
        return {
            previousBookingCount: rows.length,
            completedVisitCount: visits.length,
            cancellationCount: rows.filter((row) => row.status === "cancelled").length,
            noShowCount: rows.filter((row) => row.status === "no_show").length,
            lastVisit: visits[0]?.booking_date || null,
            bookings: rows.map((row) => ({
                id: row.id,
                reference: row.reference,
                date: row.booking_date,
                timeLabel: formatTime(row.booking_time),
                partySize: row.party_size,
                status: row.status,
                requests: row.requests || "",
                internalNotes: row.internal_notes || ""
            }))
        };
    }

    eventForAdmin(event) {
        return {
            id: event.id,
            kind: event.kind,
            actor: event.actor,
            details: event.details || "",
            createdAt: event.created_at
        };
    }

    async listDiary(date) {
        this.validateDate(date, { allowPast: true, allowClosedDay: true });
        await this.store.expirePendingHolds(this.nowIso());
        const [rows, blocks, waitlistRows] = await Promise.all([
            this.store.listBookings(date),
            this.store.listBlocks(date),
            this.store.listWaitlist(date)
        ]);
        const bookings = await Promise.all(rows.map(async (row) => {
            const [emails, auditEvents, guestHistory] = await Promise.all([
                this.store.listEmailsForBooking(row.id),
                this.store.listBookingEvents(row.id),
                this.guestHistoryFor(row)
            ]);
            const booking = publicBooking(row);
            const attention = {
                unconfirmed: ACTIVE_STATUSES.has(row.status) && !row.call_confirmed_at && !row.customer_confirmed_at,
                emailFailed: row.email_status === "failed",
                largeParty: row.party_size >= BOOKING_CONFIG.largePartySize,
                specialRequest: Boolean(row.requests)
            };
            return {
                ...booking,
                attention,
                guestHistory,
                emails: emails.map((email) => ({
                    ...email,
                    previewUrl: `/admin/bookings/email-preview/?id=${encodeURIComponent(email.id)}`
                })),
                auditEvents: auditEvents.map((event) => this.eventForAdmin(event))
            };
        }));
        const waitlist = await Promise.all(waitlistRows.map(async (row) => ({
            ...publicWaitlistEntry(row),
            emails: (await this.store.listWaitlistEmails(row.id)).map((email) => ({
                ...email,
                previewUrl: `/admin/bookings/email-preview/?id=${encodeURIComponent(email.id)}`
            }))
        })));
        const active = bookings.filter((booking) => ACTIVE_STATUSES.has(booking.status));
        const coverCounts = await Promise.all(generateSlots(date).map((time) =>
            this.overlappingCovers(date, time, BOOKING_CONFIG.durationMinutes)
        ));
        const peakCovers = Math.max(0, ...coverCounts);
        const attentionCounts = {
            unconfirmed: bookings.filter((booking) => booking.attention.unconfirmed).length,
            emailFailed: bookings.filter((booking) => booking.attention.emailFailed).length,
            largeParty: bookings.filter((booking) => booking.attention.largeParty).length,
            specialRequest: bookings.filter((booking) => booking.attention.specialRequest).length,
            waiting: waitlist.filter((entry) => entry.status === "waiting").length
        };
        const maxOnlineCovers = await this.getMaxOnlineCovers();
        return {
            date,
            config: {
                ...BOOKING_CONFIG,
                maxOnlineCovers,
                serviceHours: undefined
            },
            service: getServiceRule(date),
            slots: generateSlots(date),
            bookings,
            waitlist,
            blocks,
            attention: attentionCounts,
            summary: {
                bookingCount: active.length,
                covers: active.reduce((total, booking) => total + booking.partySize, 0),
                peakCovers,
                peakRemaining: Math.max(0, maxOnlineCovers - peakCovers)
            }
        };
    }

    async listCalendar(month) {
        if (!/^\d{4}-\d{2}$/.test(String(month || ""))) {
            throw validationError("Please choose a valid month.", "month");
        }
        const [year, monthNumber] = month.split("-").map(Number);
        if (monthNumber < 1 || monthNumber > 12) {
            throw validationError("Please choose a valid month.", "month");
        }
        await this.store.expirePendingHolds(this.nowIso());
        const maxOnlineCovers = await this.getMaxOnlineCovers();
        const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
        const days = [];

        for (let dayNumber = 1; dayNumber <= daysInMonth; dayNumber += 1) {
            const date = `${year}-${String(monthNumber).padStart(2, "0")}-${String(dayNumber).padStart(2, "0")}`;
            const rows = await this.store.listBookings(date);
            const activeRows = rows.filter((booking) => ACTIVE_STATUSES.has(booking.status));
            const blocks = await this.store.listBlocks(date);
            const serviceRule = getServiceRule(date);
            const candidateTimes = new Set([
                ...generateSlots(date),
                ...activeRows.map((booking) => booking.booking_time)
            ]);
            let peakCovers = 0;
            candidateTimes.forEach((time) => {
                const start = timeToMinutes(time);
                const end = start + BOOKING_CONFIG.durationMinutes;
                const covers = activeRows.reduce((total, booking) => {
                    const bookingStart = timeToMinutes(booking.booking_time);
                    const bookingEnd = bookingStart + booking.duration_minutes;
                    return bookingStart < end && bookingEnd > start
                        ? total + booking.party_size
                        : total;
                }, 0);
                peakCovers = Math.max(peakCovers, covers);
            });

            days.push({
                date,
                dayNumber,
                isRegularServiceDay: Boolean(serviceRule),
                wholeDayClosed: blocks.some((block) => block.booking_time === "*"),
                blockedSlotCount: blocks.filter((block) => block.booking_time !== "*").length,
                bookingCount: activeRows.length,
                totalCovers: activeRows.reduce((total, booking) => total + booking.party_size, 0),
                peakCovers,
                peakRemaining: Math.max(0, maxOnlineCovers - peakCovers),
                capacityPercent: Math.min(100, Math.round((peakCovers / maxOnlineCovers) * 100)),
                cancellationCount: rows.filter((booking) => booking.status === "cancelled").length,
                waitlistCount: (await this.store.listWaitlist(date))
                    .filter((entry) => entry.status === "waiting").length
            });
        }

        return {
            month,
            year,
            monthNumber,
            monthLabel: new Intl.DateTimeFormat("en-GB", {
                month: "long",
                year: "numeric",
                timeZone: "UTC"
            }).format(new Date(Date.UTC(year, monthNumber - 1, 1))),
            firstWeekday: (new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay() + 6) % 7,
            maxCovers: maxOnlineCovers,
            days
        };
    }

    async updateBooking(id, input, audit = {}) {
        const actor = cleanText(audit.actor || "Admin", 100);
        const existing = await this.store.getBooking(id);
        if (!existing) throw Object.assign(new Error("Booking not found."), { status: 404, code: "NOT_FOUND" });
        const merged = {
            date: input.date ?? existing.booking_date,
            time: input.time ?? existing.booking_time,
            partySize: input.partySize ?? existing.party_size,
            name: input.name ?? existing.guest_name,
            email: input.email ?? existing.email,
            phone: input.phone ?? existing.phone,
            requests: input.requests ?? existing.requests,
            internalNotes: input.internalNotes ?? existing.internal_notes,
            source: input.source ?? existing.source,
            area: input.area ?? existing.area,
            tableLabel: input.tableLabel ?? existing.table_label
        };
        const value = this.normaliseInput(merged, { admin: true, allowPast: true });
        const status = input.status ?? existing.status;
        if (!VALID_STATUSES.has(status)) throw validationError("Please choose a valid booking status.", "status");
        if (["pending", "expired"].includes(status) && status !== existing.status) {
            throw validationError("Pending and expired states are managed automatically.", "status");
        }
        const overrideCapacity = input.overrideCapacity === true;
        if (ACTIVE_STATUSES.has(status) && !overrideCapacity) {
            const used = await this.overlappingCovers(
                value.date,
                value.time,
                BOOKING_CONFIG.durationMinutes,
                id
            );
            if (used + value.partySize > await this.getMaxOnlineCovers()) {
                throw validationError(
                    "This change would exceed the current cover limit.",
                    "partySize",
                    "CAPACITY_EXCEEDED"
                );
            }
        }
        const now = this.nowIso();
        const scheduleChanged = value.date !== existing.booking_date ||
            value.time !== existing.booking_time || value.partySize !== existing.party_size;
        const updatePatch = {
            booking_date: value.date,
            booking_time: value.time,
            party_size: value.partySize,
            guest_name: value.name,
            email: value.email || null,
            phone: value.phone || null,
            requests: value.requests,
            internal_notes: value.internalNotes,
            source: value.source,
            area: value.area,
            table_label: value.tableLabel,
            status,
            cancelled_at: status === "cancelled" ? (existing.cancelled_at || now) : null,
            reminder_sent_at: scheduleChanged ? null : existing.reminder_sent_at,
            updated_at: now
        };
        if (status === "cancelled") {
            updatePatch.cancellation_token_hash = null;
            updatePatch.stable_manage_token_hash = null;
            updatePatch.manage_token_expires_at = null;
        }
        const materialFields = [
            ["guest name", value.name, existing.guest_name],
            ["email", value.email, existing.email || ""],
            ["phone", value.phone, existing.phone || ""],
            ["requests", value.requests, existing.requests],
            ["internal notes", value.internalNotes, existing.internal_notes],
            ["source", value.source, existing.source],
            ["area", value.area, existing.area],
            ["table", value.tableLabel, existing.table_label]
        ].filter(([, next, previous]) => next !== previous).map(([label]) => label);
        const updated = await this.store.transaction(async () => {
            if (ACTIVE_STATUSES.has(status) && !overrideCapacity) {
                const transactionalUsed = await this.overlappingCovers(
                    value.date, value.time, BOOKING_CONFIG.durationMinutes, id
                );
                if (transactionalUsed + value.partySize > await this.getMaxOnlineCovers()) {
                    throw validationError("This change would exceed the current cover limit.",
                        "partySize", "CAPACITY_EXCEEDED");
                }
            }
            const changed = await this.store.updateBooking(id, updatePatch);
            if (status !== existing.status) {
                await this.store.insertBookingEvent({
                    id: crypto.randomUUID(),
                    booking_id: id,
                    kind: "status_changed",
                    actor,
                    details: `${existing.status} → ${status}`,
                    created_at: now
                });
            }
            if (scheduleChanged) {
                await this.store.insertBookingEvent({
                    id: crypto.randomUUID(),
                    booking_id: id,
                    kind: "booking_amended",
                    actor,
                    details: `${existing.booking_date} ${existing.booking_time}, ${existing.party_size} guests → ${value.date} ${value.time}, ${value.partySize} guests`,
                    created_at: now
                });
            }
            if (materialFields.length) {
                await this.store.insertBookingEvent({
                    id: crypto.randomUUID(),
                    booking_id: id,
                    kind: "booking_details_changed",
                    actor,
                    details: `Changed: ${materialFields.join(", ")}`,
                    created_at: now
                });
            }
            await this.appendAdminEvent(actor, "booking_updated", "booking", id,
                [...materialFields, status !== existing.status ? "status" : "", scheduleChanged ? "schedule" : ""]
                    .filter(Boolean).join(", "), audit.requestId);
            return changed;
        });
        if (status === "cancelled" && existing.status !== "cancelled") {
            await this.mailer.sendCancellationEmails(updated);
            await this.notifyWaitlistForDate(updated.booking_date);
        }
        return { booking: publicBooking(updated) };
    }

    async resendConfirmation(id, audit = {}) {
        const booking = await this.store.getBooking(id);
        if (!booking) throw Object.assign(new Error("Booking not found."), { status: 404, code: "NOT_FOUND" });
        if (!booking.email) throw validationError("This booking does not have a customer email address.", "email");
        if (!ACTIVE_STATUSES.has(booking.status)) throw validationError("Only active bookings can receive a confirmation.");
        const credential = this.createManageCredential(booking);
        const emails = await this.mailer.sendBookingEmails(booking, credential.rawToken);
        const customerEmail = emails.find((email) => email.kind === "customer_confirmation");
        if (customerEmail && customerEmail.status !== "failed") {
            await this.activateManageCredential(id, credential);
        }
        await this.store.updateBooking(id, {
            email_status: customerEmail?.status || "pending",
            updated_at: this.nowIso()
        });
        const actor = cleanText(audit.actor || "Admin", 100);
        await this.appendEvent(id, "confirmation_resent", actor, "Confirmation email prepared again");
        await this.appendAdminEvent(actor, "confirmation_resent", "booking", id, "", audit.requestId);
        return { booking: publicBooking(await this.store.getBooking(id)) };
    }

    async setCallConfirmation(id, confirmed, audit = {}) {
        const booking = await this.store.getBooking(id);
        if (!booking) throw Object.assign(new Error("Booking not found."), { status: 404, code: "NOT_FOUND" });
        if (typeof confirmed !== "boolean") {
            throw validationError("Please provide a valid confirmation state.", "confirmed");
        }

        const alreadyConfirmed = Boolean(booking.call_confirmed_at);
        if (alreadyConfirmed === confirmed) {
            return {
                booking: publicBooking(booking),
                auditEvents: await this.store.listBookingEvents(id)
            };
        }

        const now = this.nowIso();
        const actor = cleanText(audit.actor || "Admin", 100);
        const updated = await this.store.transaction(async () => {
            const changed = await this.store.updateBooking(id, {
                call_confirmed_at: confirmed ? now : null,
                updated_at: now
            });
            await this.store.insertBookingEvent({
                id: crypto.randomUUID(),
                booking_id: id,
                kind: confirmed ? "call_confirmed" : "call_confirmation_cleared",
                actor,
                details: confirmed ? "Customer confirmed by phone" : "Phone confirmation mark removed",
                created_at: now
            });
            return changed;
        });

        await this.appendAdminEvent(actor, confirmed ? "call_confirmed" : "call_confirmation_cleared",
            "booking", id, "", audit.requestId);

        return {
            booking: publicBooking(updated),
            auditEvents: await this.store.listBookingEvents(id)
        };
    }

    async sendReminderForBooking(id, { force = false, actor = "System", requestId = null } = {}) {
        const booking = await this.store.getBooking(id);
        if (!booking) throw Object.assign(new Error("Booking not found."), { status: 404, code: "NOT_FOUND" });
        if (!booking.email) throw validationError("This booking does not have a customer email address.", "email");
        if (!ACTIVE_STATUSES.has(booking.status)) throw validationError("Only active bookings can receive reminders.");
        if (booking.reminder_sent_at && !force) {
            return { booking: publicBooking(booking), prepared: false };
        }
        const claimedAt = this.nowIso();
        const staleBefore = new Date(this.nowDate().getTime() - (10 * 60 * 1000)).toISOString();
        if (!await this.store.claimReminder(id, claimedAt, staleBefore, force)) {
            return { booking: publicBooking(await this.store.getBooking(id)), prepared: false };
        }
        const credential = this.createManageCredential(booking);
        const email = await this.mailer.sendReminderEmail(booking, credential.rawToken);
        const now = this.nowIso();
        if (email.status === "failed") {
            await this.store.updateBooking(id, { email_status: "failed", updated_at: now });
            await this.store.releaseReminderClaim(id);
            return { booking: publicBooking(await this.store.getBooking(id)), prepared: false, email };
        }
        await this.activateManageCredential(id, credential);
        const updated = await this.store.updateBooking(id, {
            reminder_sent_at: now,
            reminder_claimed_at: null,
            email_status: email.status,
            updated_at: now
        });
        await this.appendEvent(id, "reminder_prepared", actor, "24-hour reminder prepared");
        if (actor !== "System") {
            await this.appendAdminEvent(actor, "reminder_prepared", "booking", id, "", requestId);
        }
        return { booking: publicBooking(updated), prepared: true, email };
    }

    async sendDueReminders(options = {}) {
        const now = this.nowDate();
        const latest = now.getTime() + (BOOKING_CONFIG.reminderLeadHours * 60 * 60 * 1000);
        const prepared = [];
        for (const booking of await this.store.listReminderCandidates()) {
            const bookingDate = venueDateTime(booking.booking_date, booking.booking_time);
            if (!bookingDate) continue;
            const timestamp = bookingDate.getTime();
            if (timestamp > now.getTime() && timestamp <= latest) {
                const result = await this.sendReminderForBooking(booking.id, options);
                if (result.prepared) prepared.push(result.booking);
            }
        }
        return { preparedCount: prepared.length, bookings: prepared };
    }

    async runRetention() {
        const now = this.nowDate();
        const daysAgo = (days) => new Date(now.getTime() - (days * 86400000));
        return this.store.applyRetention({
            now: now.toISOString(),
            today: venueNow(now).date,
            email: daysAgo(BOOKING_CONFIG.retention.emailDays).toISOString(),
            cancelled: daysAgo(BOOKING_CONFIG.retention.cancelledDays).toISOString(),
            waitlist: daysAgo(BOOKING_CONFIG.retention.waitlistDays).toISOString(),
            customerDate: daysAgo(BOOKING_CONFIG.retention.customerDays).toISOString().slice(0, 10)
        });
    }

    async createWaitlistEntry(input, { idempotencyKey = null } = {}) {
        await this.requireOnlineBookingsEnabled();
        if (!/^[A-Za-z0-9._:-]{16,128}$/.test(String(idempotencyKey || ""))) {
            throw validationError("A valid waiting-list request identifier is required.", null, "IDEMPOTENCY_REQUIRED");
        }
        const date = this.validateDate(input.date);
        const partySize = this.validatePartySize(input.partySize);
        const time = cleanText(input.time, 5);
        if (!generateSlots(date).includes(time)) {
            throw validationError("Please choose a valid time.", "time");
        }
        const name = cleanText(input.name, 100);
        if (name.length < 2) throw validationError("Please enter your name.", "name");
        const emailResult = validateEmail(input.email, true);
        const phone = normalisePhone(input.phone, true);
        const now = this.nowIso();
        let replayed = false;
        const entry = await this.store.transaction(async () => {
            const duplicate = await this.store.getWaitlistEntryByIdempotencyKey(idempotencyKey);
            if (duplicate) {
                replayed = true;
                return duplicate;
            }
            const availability = await this.getAvailability(date, partySize);
            const slot = availability.slots.find((item) => item.time === time);
            if (slot?.available) {
                throw validationError("A table is currently available at that time—please book it directly.", "time", "SLOT_AVAILABLE");
            }
            if (!slot?.waitlistEligible) {
                throw validationError("The waiting list is not available for that time.", "time", "WAITLIST_UNAVAILABLE");
            }
            return this.store.insertWaitlistEntry({
                id: crypto.randomUUID(),
                booking_date: date,
                booking_time: time,
                party_size: partySize,
                guest_name: name,
                email: emailResult.value,
                phone,
                notes: cleanText(input.notes, 500),
                status: "waiting",
                created_at: now,
                updated_at: now,
                notified_at: null,
                booked_at: null,
                idempotency_key: idempotencyKey,
                notification_claimed_at: null
            });
        });
        if (replayed) {
            return { entry: publicWaitlistEntry(entry), emailSuggestion: emailResult.suggestion, replayed: true };
        }
        await this.mailer.sendWaitlistJoinedEmails(entry);
        return { entry: publicWaitlistEntry(entry), emailSuggestion: emailResult.suggestion };
    }

    async notifyWaitlistEntry(id, { force = false, actor = "System", requestId = null } = {}) {
        const entry = await this.store.getWaitlistEntry(id);
        if (!entry) throw Object.assign(new Error("Waiting-list entry not found."), { status: 404, code: "NOT_FOUND" });
        if (entry.status !== "waiting" && !force) {
            return { entry: publicWaitlistEntry(entry), notified: false };
        }
        const availability = await this.getAvailability(entry.booking_date, entry.party_size);
        const slot = availability.slots.find((item) => item.time === entry.booking_time);
        if (!slot?.available && !force) {
            throw validationError("There is not currently enough availability for this party.", "time", "SLOT_UNAVAILABLE");
        }
        const claimedAt = this.nowIso();
        const staleBefore = new Date(this.nowDate().getTime() - (10 * 60 * 1000)).toISOString();
        if (!await this.store.claimWaitlistNotification(id, claimedAt, staleBefore, force)) {
            return { entry: publicWaitlistEntry(await this.store.getWaitlistEntry(id)), notified: false };
        }
        const email = await this.mailer.sendWaitlistAvailableEmail(entry);
        if (email.status === "failed") {
            await this.store.updateWaitlistEntry(id, { notification_claimed_at: null, updated_at: this.nowIso() });
            return { entry: publicWaitlistEntry(await this.store.getWaitlistEntry(id)), notified: false, email };
        }
        const now = this.nowIso();
        const updated = await this.store.updateWaitlistEntry(id, {
            status: "notified",
            notified_at: now,
            notification_claimed_at: null,
            updated_at: now
        });
        if (actor !== "System") {
            await this.appendAdminEvent(actor, "waitlist_notified", "waitlist", id, "", requestId);
        }
        return { entry: publicWaitlistEntry(updated), notified: true, email };
    }

    async notifyWaitlistForDate(date) {
        const notifiedTimes = new Set();
        const notified = [];
        for (const entry of await this.store.listWaitingForDate(date)) {
            if (notifiedTimes.has(entry.booking_time)) continue;
            const availability = await this.getAvailability(entry.booking_date, entry.party_size);
            const slot = availability.slots.find((item) => item.time === entry.booking_time);
            if (!slot?.available) continue;
            const result = await this.notifyWaitlistEntry(entry.id);
            if (result.notified) {
                notified.push(result.entry);
                notifiedTimes.add(entry.booking_time);
            }
        }
        return { notifiedCount: notified.length, entries: notified };
    }

    async updateWaitlistStatus(id, status, audit = {}) {
        const entry = await this.store.getWaitlistEntry(id);
        if (!entry) throw Object.assign(new Error("Waiting-list entry not found."), { status: 404, code: "NOT_FOUND" });
        if (!VALID_WAITLIST_STATUSES.has(status)) {
            throw validationError("Please choose a valid waiting-list status.", "status");
        }
        const now = this.nowIso();
        const updated = await this.store.updateWaitlistEntry(id, {
            status,
            updated_at: now,
            booked_at: status === "booked" ? (entry.booked_at || now) : entry.booked_at
        });
        await this.appendAdminEvent(audit.actor || "Admin", "waitlist_status_changed", "waitlist", id,
            `${entry.status} → ${status}`, audit.requestId);
        return { entry: publicWaitlistEntry(updated) };
    }

    async createBlock(input, audit = {}) {
        const date = this.validateDate(input.date, { allowPast: false, allowClosedDay: true });
        const time = input.time === "*" ? "*" : cleanText(input.time, 5);
        if (time !== "*" && !generateSlots(date).includes(time)) {
            throw validationError("Please choose a valid time to close.", "time");
        }
        try {
            const block = await this.store.createBlock({
                id: crypto.randomUUID(),
                booking_date: date,
                booking_time: time,
                reason: cleanText(input.reason || "Closed by the pub", 200),
                created_at: this.nowIso()
            });
            await this.appendAdminEvent(audit.actor || "Admin", "availability_closed", "block", block.id,
                `${date} ${time}`, audit.requestId);
            return block;
        } catch (error) {
            if (error.code === "23505" || /unique/i.test(String(error.message))) {
                throw validationError("That date or time is already closed.", "time");
            }
            throw error;
        }
    }

    async removeBlock(id, audit = {}) {
        if (!await this.store.removeBlock(id)) {
            throw Object.assign(new Error("Closure not found."), { status: 404, code: "NOT_FOUND" });
        }
        await this.appendAdminEvent(audit.actor || "Admin", "availability_reopened", "block", id,
            "", audit.requestId);
        return { success: true };
    }
}

module.exports = {
    ACTIVE_STATUSES,
    BookingService,
    publicBooking,
    publicWaitlistEntry,
    tokenHash
};
