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

const ACTIVE_STATUSES = new Set(["confirmed", "arrived", "seated"]);
const VALID_STATUSES = new Set(["confirmed", "arrived", "seated", "completed", "cancelled", "no_show"]);
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
        customerConfirmedAt: row.customer_confirmed_at || null,
        callConfirmedAt: row.call_confirmed_at || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        cancelledAt: row.cancelled_at
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
        this.tokenSecret = options.tokenSecret || process.env.BOOKING_TOKEN_SECRET ||
            "waterloo-inn-local-prototype-manage-token";
    }

    nowDate() {
        return new Date(this.now());
    }

    nowIso() {
        return this.nowDate().toISOString();
    }

    createManageToken(bookingId) {
        const payload = Buffer.from(String(bookingId), "utf8").toString("base64url");
        const signature = crypto.createHmac("sha256", this.tokenSecret)
            .update(payload)
            .digest("base64url");
        return `${payload}_${signature}`;
    }

    ensureManageToken(booking) {
        const rawToken = this.createManageToken(booking.id);
        const hashed = tokenHash(rawToken);
        if (booking.cancellation_token_hash !== hashed && booking.stable_manage_token_hash !== hashed) {
            this.store.updateBooking(booking.id, {
                stable_manage_token_hash: hashed,
                updated_at: this.nowIso()
            });
        }
        return rawToken;
    }

    appendEvent(bookingId, kind, actor, details = "") {
        return this.store.insertBookingEvent({
            id: crypto.randomUUID(),
            booking_id: bookingId,
            kind,
            actor,
            details: cleanText(details, 500),
            created_at: this.nowIso()
        });
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

    overlappingCovers(date, time, durationMinutes, excludeId = "") {
        const start = timeToMinutes(time);
        const end = start + durationMinutes;
        return this.store.listActiveBookings(date, excludeId).reduce((total, booking) => {
            const bookingStart = timeToMinutes(booking.booking_time);
            const bookingEnd = bookingStart + booking.duration_minutes;
            return bookingStart < end && bookingEnd > start
                ? total + booking.party_size
                : total;
        }, 0);
    }

    getAvailability(date, partySizeValue, excludeId = "") {
        const validDate = this.validateDate(date);
        const partySize = this.validatePartySize(partySizeValue);
        const current = venueNow(this.nowDate());
        const blocks = this.store.listBlocks(validDate);
        const blockedTimes = new Set(blocks.map((block) => block.booking_time));
        const wholeDayBlocked = blockedTimes.has("*");
        const slots = generateSlots(validDate).map((time) => {
            const usedCovers = this.overlappingCovers(
                validDate,
                time,
                BOOKING_CONFIG.durationMinutes,
                excludeId
            );
            const remainingCovers = Math.max(0, BOOKING_CONFIG.maxOnlineCovers - usedCovers);
            const tooSoon = validDate === current.date &&
                timeToMinutes(time) < current.minutes + BOOKING_CONFIG.minimumNoticeMinutes;
            const blocked = wholeDayBlocked || blockedTimes.has(time);
            const available = !tooSoon && !blocked && remainingCovers >= partySize;
            let reason = null;
            if (tooSoon) reason = "Online booking has closed for this time";
            else if (blocked) reason = "Unavailable";
            else if (remainingCovers < partySize) reason = "Not enough availability";
            return {
                time,
                label: formatTime(time),
                available,
                waitlistEligible: !tooSoon && !blocked && !available,
                remainingCovers,
                reason
            };
        });
        return {
            date: validDate,
            partySize,
            service: getServiceRule(validDate),
            slotMinutes: BOOKING_CONFIG.slotMinutes,
            durationMinutes: BOOKING_CONFIG.durationMinutes,
            slots
        };
    }

    getManagedAvailability(token, date, partySize) {
        const managed = this.getManagedBooking(token);
        if (!managed.canAmend) {
            throw validationError("This booking can no longer be changed online.", null, "CANNOT_AMEND");
        }
        return this.getAvailability(date, partySize, managed.booking.id);
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

    async createBooking(input, { admin = false, overrideCapacity = false } = {}) {
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
        const id = crypto.randomUUID();
        const rawToken = this.createManageToken(id);
        const now = this.nowIso();
        const booking = this.store.transaction(() => {
            if (!admin) {
                const availability = this.getAvailability(value.date, value.partySize);
                const chosen = availability.slots.find((slot) => slot.time === value.time);
                if (!chosen?.available) {
                    throw validationError(
                        chosen?.reason || "That time is no longer available.",
                        "time",
                        "SLOT_UNAVAILABLE"
                    );
                }
            } else if (!overrideCapacity) {
                const used = this.overlappingCovers(
                    value.date,
                    value.time,
                    BOOKING_CONFIG.durationMinutes
                );
                if (used + value.partySize > BOOKING_CONFIG.maxOnlineCovers) {
                    throw validationError(
                        "This booking would exceed the current online cover limit. Use the override if the pub can accommodate it.",
                        "partySize",
                        "CAPACITY_EXCEEDED"
                    );
                }
            }
            const inserted = this.store.insertBooking({
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
                status: "confirmed",
                cancellation_token_hash: tokenHash(rawToken),
                stable_manage_token_hash: null,
                email_status: "pending",
                created_at: now,
                updated_at: now,
                cancelled_at: null,
                call_confirmed_at: null,
                customer_confirmed_at: null,
                reminder_sent_at: null,
                area: value.area,
                table_label: value.tableLabel,
                deposit_amount_pence: 0,
                deposit_status: "not_required",
                deposit_paid_at: null
            });
            this.store.insertBookingEvent({
                id: crypto.randomUUID(),
                booking_id: id,
                kind: "booking_created",
                actor: admin ? "Admin" : "Customer",
                details: `${value.partySize} guests · ${value.date} ${value.time}`,
                created_at: now
            });
            return inserted;
        });

        const emails = await this.mailer.sendBookingEmails(booking, rawToken);
        const customerEmail = emails.find((email) => email.kind === "customer_confirmation");
        const emailStatus = customerEmail?.status || emails[0]?.status || "pending";
        const updated = this.store.updateBooking(booking.id, {
            email_status: emailStatus,
            updated_at: this.nowIso()
        });
        return {
            booking: publicBooking(updated),
            emailSuggestion: value.emailSuggestion,
            emailStatus
        };
    }

    getManagedBooking(token) {
        const booking = this.store.getBookingByTokenHash(tokenHash(token));
        if (!booking) throw Object.assign(new Error("This booking link is invalid or has expired."), { status: 404, code: "NOT_FOUND" });
        const current = venueNow(this.nowDate());
        const inFuture = dateDistance(current.date, booking.booking_date) > 0 ||
            (booking.booking_date === current.date && timeToMinutes(booking.booking_time) > current.minutes);
        const activeAndFuture = ACTIVE_STATUSES.has(booking.status) && inFuture;
        return {
            booking: publicBooking(booking),
            canCancel: activeAndFuture,
            canAmend: activeAndFuture,
            canConfirm: activeAndFuture && !booking.customer_confirmed_at
        };
    }

    confirmBooking(token) {
        const managed = this.getManagedBooking(token);
        if (!ACTIVE_STATUSES.has(managed.booking.status)) {
            throw validationError("This booking can no longer be confirmed online.", null, "CANNOT_CONFIRM");
        }
        if (managed.booking.customerConfirmedAt) return managed;
        const now = this.nowIso();
        const updated = this.store.transaction(() => {
            const changed = this.store.updateBooking(managed.booking.id, {
                customer_confirmed_at: now,
                updated_at: now
            });
            this.store.insertBookingEvent({
                id: crypto.randomUUID(),
                booking_id: managed.booking.id,
                kind: "customer_confirmed",
                actor: "Customer",
                details: "Confirmed from the manage-booking link",
                created_at: now
            });
            return changed;
        });
        return {
            booking: publicBooking(updated),
            canCancel: true,
            canAmend: true,
            canConfirm: false
        };
    }

    async amendBooking(token, input) {
        const managed = this.getManagedBooking(token);
        if (!managed.canAmend) {
            throw validationError("This booking can no longer be changed online.", null, "CANNOT_AMEND");
        }
        const existing = this.store.getBooking(managed.booking.id);
        const value = this.normaliseInput({
            date: input.date ?? existing.booking_date,
            time: input.time ?? existing.booking_time,
            partySize: input.partySize ?? existing.party_size,
            name: existing.guest_name,
            email: existing.email,
            phone: existing.phone,
            requests: input.requests ?? existing.requests
        });
        const availability = this.getAvailability(value.date, value.partySize, existing.id);
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
        const updated = this.store.transaction(() => {
            const changed = this.store.updateBooking(existing.id, {
                booking_date: value.date,
                booking_time: value.time,
                party_size: value.partySize,
                requests: value.requests,
                customer_confirmed_at: now,
                reminder_sent_at: null,
                updated_at: now
            });
            this.store.insertBookingEvent({
                id: crypto.randomUUID(),
                booking_id: existing.id,
                kind: "customer_amended",
                actor: "Customer",
                details,
                created_at: now
            });
            return changed;
        });
        const emails = await this.mailer.sendAmendmentEmails(updated, token);
        const customerEmail = emails.find((email) => email.kind === "customer_amendment");
        if (customerEmail) {
            this.store.updateBooking(updated.id, {
                email_status: customerEmail.status,
                updated_at: this.nowIso()
            });
        }
        return this.getManagedBooking(token);
    }

    async cancelBooking(token) {
        const managed = this.getManagedBooking(token);
        if (!managed.canCancel) {
            throw validationError("This booking can no longer be cancelled online.", null, "CANNOT_CANCEL");
        }
        const now = this.nowIso();
        const updated = this.store.transaction(() => {
            const changed = this.store.updateBooking(managed.booking.id, {
                status: "cancelled",
                cancelled_at: now,
                updated_at: now,
                cancellation_token_hash: null,
                stable_manage_token_hash: null
            });
            this.store.insertBookingEvent({
                id: crypto.randomUUID(),
                booking_id: managed.booking.id,
                kind: "booking_cancelled",
                actor: "Customer",
                details: "Cancelled online",
                created_at: now
            });
            return changed;
        });
        await this.mailer.sendCancellationEmails(updated);
        await this.notifyWaitlistForDate(updated.booking_date);
        return { booking: publicBooking(updated) };
    }

    guestHistoryFor(booking) {
        const rows = this.store.listBookingsByContact(
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

    listDiary(date) {
        this.validateDate(date, { allowPast: true, allowClosedDay: true });
        const rows = this.store.listBookings(date);
        const blocks = this.store.listBlocks(date);
        const bookings = rows.map((row) => {
            const emails = this.store.listEmailsForBooking(row.id);
            const auditEvents = this.store.listBookingEvents(row.id);
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
                guestHistory: this.guestHistoryFor(row),
                emails: emails.map((email) => ({
                    ...email,
                    previewUrl: `/api/admin/emails/${email.id}`
                })),
                auditEvents: auditEvents.map((event) => this.eventForAdmin(event))
            };
        });
        const waitlist = this.store.listWaitlist(date).map((row) => ({
            ...publicWaitlistEntry(row),
            emails: this.store.listWaitlistEmails(row.id).map((email) => ({
                ...email,
                previewUrl: `/api/admin/emails/${email.id}`
            }))
        }));
        const active = bookings.filter((booking) => ACTIVE_STATUSES.has(booking.status));
        const peakCovers = generateSlots(date).reduce((peak, time) => {
            return Math.max(peak, this.overlappingCovers(date, time, BOOKING_CONFIG.durationMinutes));
        }, 0);
        const attentionCounts = {
            unconfirmed: bookings.filter((booking) => booking.attention.unconfirmed).length,
            emailFailed: bookings.filter((booking) => booking.attention.emailFailed).length,
            largeParty: bookings.filter((booking) => booking.attention.largeParty).length,
            specialRequest: bookings.filter((booking) => booking.attention.specialRequest).length,
            waiting: waitlist.filter((entry) => entry.status === "waiting").length
        };
        return {
            date,
            config: {
                ...BOOKING_CONFIG,
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
                peakRemaining: Math.max(0, BOOKING_CONFIG.maxOnlineCovers - peakCovers)
            }
        };
    }

    listCalendar(month) {
        if (!/^\d{4}-\d{2}$/.test(String(month || ""))) {
            throw validationError("Please choose a valid month.", "month");
        }
        const [year, monthNumber] = month.split("-").map(Number);
        if (monthNumber < 1 || monthNumber > 12) {
            throw validationError("Please choose a valid month.", "month");
        }
        const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
        const days = [];

        for (let dayNumber = 1; dayNumber <= daysInMonth; dayNumber += 1) {
            const date = `${year}-${String(monthNumber).padStart(2, "0")}-${String(dayNumber).padStart(2, "0")}`;
            const rows = this.store.listBookings(date);
            const activeRows = rows.filter((booking) => ACTIVE_STATUSES.has(booking.status));
            const blocks = this.store.listBlocks(date);
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
                peakRemaining: Math.max(0, BOOKING_CONFIG.maxOnlineCovers - peakCovers),
                capacityPercent: Math.min(100, Math.round((peakCovers / BOOKING_CONFIG.maxOnlineCovers) * 100)),
                cancellationCount: rows.filter((booking) => booking.status === "cancelled").length,
                waitlistCount: this.store.listWaitlist(date).filter((entry) => entry.status === "waiting").length
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
            maxCovers: BOOKING_CONFIG.maxOnlineCovers,
            days
        };
    }

    async updateBooking(id, input) {
        const existing = this.store.getBooking(id);
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
        const overrideCapacity = Boolean(input.overrideCapacity);
        if (ACTIVE_STATUSES.has(status) && !overrideCapacity) {
            const used = this.overlappingCovers(
                value.date,
                value.time,
                BOOKING_CONFIG.durationMinutes,
                id
            );
            if (used + value.partySize > BOOKING_CONFIG.maxOnlineCovers) {
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
        }
        const updated = this.store.transaction(() => {
            const changed = this.store.updateBooking(id, updatePatch);
            if (status !== existing.status) {
                this.store.insertBookingEvent({
                    id: crypto.randomUUID(),
                    booking_id: id,
                    kind: "status_changed",
                    actor: "Admin",
                    details: `${existing.status} → ${status}`,
                    created_at: now
                });
            }
            if (scheduleChanged) {
                this.store.insertBookingEvent({
                    id: crypto.randomUUID(),
                    booking_id: id,
                    kind: "booking_amended",
                    actor: "Admin",
                    details: `${existing.booking_date} ${existing.booking_time}, ${existing.party_size} guests → ${value.date} ${value.time}, ${value.partySize} guests`,
                    created_at: now
                });
            }
            return changed;
        });
        if (status === "cancelled" && existing.status !== "cancelled") {
            await this.mailer.sendCancellationEmails(updated);
            await this.notifyWaitlistForDate(updated.booking_date);
        }
        return { booking: publicBooking(updated) };
    }

    async resendConfirmation(id) {
        const booking = this.store.getBooking(id);
        if (!booking) throw Object.assign(new Error("Booking not found."), { status: 404, code: "NOT_FOUND" });
        if (!booking.email) throw validationError("This booking does not have a customer email address.", "email");
        if (!ACTIVE_STATUSES.has(booking.status)) throw validationError("Only active bookings can receive a confirmation.");
        const rawToken = this.ensureManageToken(booking);
        const emails = await this.mailer.sendBookingEmails(this.store.getBooking(id), rawToken);
        const customerEmail = emails.find((email) => email.kind === "customer_confirmation");
        this.store.updateBooking(id, {
            email_status: customerEmail?.status || "pending",
            updated_at: this.nowIso()
        });
        this.appendEvent(id, "confirmation_resent", "Admin", "Confirmation email prepared again");
        return { booking: publicBooking(this.store.getBooking(id)) };
    }

    setCallConfirmation(id, confirmed) {
        const booking = this.store.getBooking(id);
        if (!booking) throw Object.assign(new Error("Booking not found."), { status: 404, code: "NOT_FOUND" });
        if (typeof confirmed !== "boolean") {
            throw validationError("Please provide a valid confirmation state.", "confirmed");
        }

        const alreadyConfirmed = Boolean(booking.call_confirmed_at);
        if (alreadyConfirmed === confirmed) {
            return {
                booking: publicBooking(booking),
                auditEvents: this.store.listBookingEvents(id)
            };
        }

        const now = this.nowIso();
        const updated = this.store.transaction(() => {
            const changed = this.store.updateBooking(id, {
                call_confirmed_at: confirmed ? now : null,
                updated_at: now
            });
            this.store.insertBookingEvent({
                id: crypto.randomUUID(),
                booking_id: id,
                kind: confirmed ? "call_confirmed" : "call_confirmation_cleared",
                actor: "Admin",
                details: confirmed ? "Customer confirmed by phone" : "Phone confirmation mark removed",
                created_at: now
            });
            return changed;
        });

        return {
            booking: publicBooking(updated),
            auditEvents: this.store.listBookingEvents(id)
        };
    }

    async sendReminderForBooking(id, { force = false } = {}) {
        let booking = this.store.getBooking(id);
        if (!booking) throw Object.assign(new Error("Booking not found."), { status: 404, code: "NOT_FOUND" });
        if (!booking.email) throw validationError("This booking does not have a customer email address.", "email");
        if (!ACTIVE_STATUSES.has(booking.status)) throw validationError("Only active bookings can receive reminders.");
        if (booking.reminder_sent_at && !force) {
            return { booking: publicBooking(booking), prepared: false };
        }
        const rawToken = this.ensureManageToken(booking);
        booking = this.store.getBooking(id);
        const email = await this.mailer.sendReminderEmail(booking, rawToken);
        const now = this.nowIso();
        const updated = this.store.updateBooking(id, {
            reminder_sent_at: now,
            email_status: email.status,
            updated_at: now
        });
        this.appendEvent(id, "reminder_prepared", force ? "Admin" : "System", "24-hour reminder prepared");
        return { booking: publicBooking(updated), prepared: true, email };
    }

    async sendDueReminders() {
        const now = this.nowDate();
        const latest = now.getTime() + (BOOKING_CONFIG.reminderLeadHours * 60 * 60 * 1000);
        const prepared = [];
        for (const booking of this.store.listReminderCandidates()) {
            const bookingDate = venueDateTime(booking.booking_date, booking.booking_time);
            if (!bookingDate) continue;
            const timestamp = bookingDate.getTime();
            if (timestamp > now.getTime() && timestamp <= latest) {
                const result = await this.sendReminderForBooking(booking.id);
                if (result.prepared) prepared.push(result.booking);
            }
        }
        return { preparedCount: prepared.length, bookings: prepared };
    }

    async createWaitlistEntry(input) {
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
        const availability = this.getAvailability(date, partySize);
        const slot = availability.slots.find((item) => item.time === time);
        if (slot?.available) {
            throw validationError("A table is currently available at that time—please book it directly.", "time", "SLOT_AVAILABLE");
        }
        if (!slot?.waitlistEligible) {
            throw validationError("The waiting list is not available for that time.", "time", "WAITLIST_UNAVAILABLE");
        }
        const now = this.nowIso();
        const entry = this.store.insertWaitlistEntry({
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
            booked_at: null
        });
        await this.mailer.sendWaitlistJoinedEmails(entry);
        return { entry: publicWaitlistEntry(entry), emailSuggestion: emailResult.suggestion };
    }

    async notifyWaitlistEntry(id, { force = false } = {}) {
        const entry = this.store.getWaitlistEntry(id);
        if (!entry) throw Object.assign(new Error("Waiting-list entry not found."), { status: 404, code: "NOT_FOUND" });
        if (entry.status !== "waiting" && !force) {
            return { entry: publicWaitlistEntry(entry), notified: false };
        }
        const availability = this.getAvailability(entry.booking_date, entry.party_size);
        const slot = availability.slots.find((item) => item.time === entry.booking_time);
        if (!slot?.available && !force) {
            throw validationError("There is not currently enough availability for this party.", "time", "SLOT_UNAVAILABLE");
        }
        const email = await this.mailer.sendWaitlistAvailableEmail(entry);
        const now = this.nowIso();
        const updated = this.store.updateWaitlistEntry(id, {
            status: "notified",
            notified_at: now,
            updated_at: now
        });
        return { entry: publicWaitlistEntry(updated), notified: true, email };
    }

    async notifyWaitlistForDate(date) {
        const notifiedTimes = new Set();
        const notified = [];
        for (const entry of this.store.listWaitingForDate(date)) {
            if (notifiedTimes.has(entry.booking_time)) continue;
            const availability = this.getAvailability(entry.booking_date, entry.party_size);
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

    updateWaitlistStatus(id, status) {
        const entry = this.store.getWaitlistEntry(id);
        if (!entry) throw Object.assign(new Error("Waiting-list entry not found."), { status: 404, code: "NOT_FOUND" });
        if (!VALID_WAITLIST_STATUSES.has(status)) {
            throw validationError("Please choose a valid waiting-list status.", "status");
        }
        const now = this.nowIso();
        const updated = this.store.updateWaitlistEntry(id, {
            status,
            updated_at: now,
            booked_at: status === "booked" ? (entry.booked_at || now) : entry.booked_at
        });
        return { entry: publicWaitlistEntry(updated) };
    }

    createBlock(input) {
        const date = this.validateDate(input.date, { allowPast: false, allowClosedDay: true });
        const time = input.time === "*" ? "*" : cleanText(input.time, 5);
        if (time !== "*" && !generateSlots(date).includes(time)) {
            throw validationError("Please choose a valid time to close.", "time");
        }
        try {
            return this.store.createBlock({
                id: crypto.randomUUID(),
                booking_date: date,
                booking_time: time,
                reason: cleanText(input.reason || "Closed by the pub", 200),
                created_at: this.nowIso()
            });
        } catch (error) {
            if (String(error.message).includes("UNIQUE")) {
                throw validationError("That date or time is already closed.", "time");
            }
            throw error;
        }
    }

    removeBlock(id) {
        if (!this.store.removeBlock(id)) {
            throw Object.assign(new Error("Closure not found."), { status: 404, code: "NOT_FOUND" });
        }
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
