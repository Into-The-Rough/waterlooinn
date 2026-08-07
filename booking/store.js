"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

class BookingStore {
    constructor(databasePath) {
        if (databasePath !== ":memory:") {
            fs.mkdirSync(path.dirname(databasePath), { recursive: true });
        }
        this.db = new DatabaseSync(databasePath);
        this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
        this.migrate();
    }

    migrate() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS bookings (
                id TEXT PRIMARY KEY,
                reference TEXT NOT NULL UNIQUE,
                booking_date TEXT NOT NULL,
                booking_time TEXT NOT NULL,
                duration_minutes INTEGER NOT NULL,
                party_size INTEGER NOT NULL CHECK (party_size BETWEEN 1 AND 8),
                guest_name TEXT NOT NULL,
                email TEXT,
                phone TEXT,
                requests TEXT NOT NULL DEFAULT '',
                internal_notes TEXT NOT NULL DEFAULT '',
                source TEXT NOT NULL DEFAULT 'web',
                status TEXT NOT NULL DEFAULT 'confirmed',
                cancellation_token_hash TEXT UNIQUE,
                stable_manage_token_hash TEXT UNIQUE,
                email_status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                cancelled_at TEXT,
                call_confirmed_at TEXT,
                customer_confirmed_at TEXT,
                reminder_sent_at TEXT,
                area TEXT NOT NULL DEFAULT 'Restaurant',
                table_label TEXT NOT NULL DEFAULT '',
                deposit_amount_pence INTEGER NOT NULL DEFAULT 0,
                deposit_status TEXT NOT NULL DEFAULT 'not_required',
                deposit_paid_at TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_bookings_date
                ON bookings (booking_date, booking_time);
            CREATE INDEX IF NOT EXISTS idx_bookings_status
                ON bookings (status);

            CREATE TABLE IF NOT EXISTS booking_blocks (
                id TEXT PRIMARY KEY,
                booking_date TEXT NOT NULL,
                booking_time TEXT NOT NULL DEFAULT '*',
                reason TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                UNIQUE (booking_date, booking_time)
            );

            CREATE INDEX IF NOT EXISTS idx_booking_blocks_date
                ON booking_blocks (booking_date);

            CREATE TABLE IF NOT EXISTS booking_emails (
                id TEXT PRIMARY KEY,
                booking_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                recipient TEXT NOT NULL,
                subject TEXT NOT NULL,
                html TEXT NOT NULL,
                status TEXT NOT NULL,
                provider_id TEXT,
                error TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_booking_emails_booking
                ON booking_emails (booking_id, created_at);

            CREATE TABLE IF NOT EXISTS booking_events (
                id TEXT PRIMARY KEY,
                booking_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                actor TEXT NOT NULL DEFAULT 'Admin',
                details TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_booking_events_booking
                ON booking_events (booking_id, created_at);

            CREATE TABLE IF NOT EXISTS waitlist_entries (
                id TEXT PRIMARY KEY,
                booking_date TEXT NOT NULL,
                booking_time TEXT NOT NULL,
                party_size INTEGER NOT NULL CHECK (party_size BETWEEN 1 AND 8),
                guest_name TEXT NOT NULL,
                email TEXT NOT NULL,
                phone TEXT NOT NULL,
                notes TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'waiting',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                notified_at TEXT,
                booked_at TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_waitlist_date
                ON waitlist_entries (booking_date, booking_time, status, created_at);

            CREATE TABLE IF NOT EXISTS waitlist_emails (
                id TEXT PRIMARY KEY,
                waitlist_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                recipient TEXT NOT NULL,
                subject TEXT NOT NULL,
                html TEXT NOT NULL,
                status TEXT NOT NULL,
                provider_id TEXT,
                error TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (waitlist_id) REFERENCES waitlist_entries(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_waitlist_emails_entry
                ON waitlist_emails (waitlist_id, created_at);
        `);

        const bookingColumns = new Set(
            this.db.prepare("PRAGMA table_info(bookings)").all().map((column) => column.name)
        );
        const bookingMigrations = {
            call_confirmed_at: "TEXT",
            customer_confirmed_at: "TEXT",
            reminder_sent_at: "TEXT",
            stable_manage_token_hash: "TEXT",
            area: "TEXT NOT NULL DEFAULT 'Restaurant'",
            table_label: "TEXT NOT NULL DEFAULT ''",
            deposit_amount_pence: "INTEGER NOT NULL DEFAULT 0",
            deposit_status: "TEXT NOT NULL DEFAULT 'not_required'",
            deposit_paid_at: "TEXT"
        };
        for (const [column, definition] of Object.entries(bookingMigrations)) {
            if (!bookingColumns.has(column)) {
                this.db.exec(`ALTER TABLE bookings ADD COLUMN ${column} ${definition}`);
            }
        }

        const eventColumns = new Set(
            this.db.prepare("PRAGMA table_info(booking_events)").all().map((column) => column.name)
        );
        if (!eventColumns.has("details")) {
            this.db.exec("ALTER TABLE booking_events ADD COLUMN details TEXT NOT NULL DEFAULT ''");
        }

        this.db.prepare(`
            UPDATE bookings
            SET deposit_amount_pence = 0,
                deposit_status = 'not_required',
                deposit_paid_at = NULL
            WHERE deposit_amount_pence <> 0
               OR deposit_status <> 'not_required'
               OR deposit_paid_at IS NOT NULL
        `).run();
    }

    transaction(callback) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const result = callback();
            this.db.exec("COMMIT");
            return result;
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }

    insertBooking(booking) {
        this.db.prepare(`
            INSERT INTO bookings (
                id, reference, booking_date, booking_time, duration_minutes,
                party_size, guest_name, email, phone, requests, internal_notes,
                source, status, cancellation_token_hash, email_status,
                stable_manage_token_hash,
                created_at, updated_at, cancelled_at, call_confirmed_at,
                customer_confirmed_at, reminder_sent_at, area, table_label,
                deposit_amount_pence, deposit_status, deposit_paid_at
            ) VALUES (
                $id, $reference, $booking_date, $booking_time, $duration_minutes,
                $party_size, $guest_name, $email, $phone, $requests, $internal_notes,
                $source, $status, $cancellation_token_hash, $email_status,
                $stable_manage_token_hash,
                $created_at, $updated_at, $cancelled_at, $call_confirmed_at,
                $customer_confirmed_at, $reminder_sent_at, $area, $table_label,
                $deposit_amount_pence, $deposit_status, $deposit_paid_at
            )
        `).run(booking);
        return this.getBooking(booking.id);
    }

    getBooking(id) {
        return this.db.prepare("SELECT * FROM bookings WHERE id = ?").get(id) || null;
    }

    getBookingByTokenHash(tokenHash) {
        return this.db.prepare(
            "SELECT * FROM bookings WHERE cancellation_token_hash = ? OR stable_manage_token_hash = ?"
        ).get(tokenHash, tokenHash) || null;
    }

    listBookings(date) {
        return this.db.prepare(`
            SELECT * FROM bookings
            WHERE booking_date = ?
            ORDER BY booking_time ASC, created_at ASC
        `).all(date);
    }

    listActiveBookings(date, excludeId = "") {
        return this.db.prepare(`
            SELECT * FROM bookings
            WHERE booking_date = ?
              AND status IN ('confirmed', 'arrived', 'seated')
              AND id <> ?
            ORDER BY booking_time ASC
        `).all(date, excludeId);
    }

    updateBooking(id, patch) {
        const allowed = new Set([
            "booking_date", "booking_time", "duration_minutes", "party_size",
            "guest_name", "email", "phone", "requests", "internal_notes",
            "source", "status", "cancellation_token_hash", "email_status",
            "stable_manage_token_hash",
            "updated_at", "cancelled_at", "call_confirmed_at",
            "customer_confirmed_at", "reminder_sent_at", "area", "table_label",
            "deposit_amount_pence", "deposit_status", "deposit_paid_at"
        ]);
        const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
        if (entries.length === 0) return this.getBooking(id);
        const assignments = entries.map(([key]) => `${key} = $${key}`).join(", ");
        this.db.prepare(`UPDATE bookings SET ${assignments} WHERE id = $id`).run({
            id,
            ...Object.fromEntries(entries)
        });
        return this.getBooking(id);
    }

    createBlock(block) {
        this.db.prepare(`
            INSERT INTO booking_blocks (
                id, booking_date, booking_time, reason, created_at
            ) VALUES ($id, $booking_date, $booking_time, $reason, $created_at)
        `).run(block);
        return this.getBlock(block.id);
    }

    getBlock(id) {
        return this.db.prepare("SELECT * FROM booking_blocks WHERE id = ?").get(id) || null;
    }

    listBlocks(date) {
        return this.db.prepare(`
            SELECT * FROM booking_blocks
            WHERE booking_date = ?
            ORDER BY booking_time ASC
        `).all(date);
    }

    removeBlock(id) {
        return this.db.prepare("DELETE FROM booking_blocks WHERE id = ?").run(id).changes > 0;
    }

    insertEmail(email) {
        this.db.prepare(`
            INSERT INTO booking_emails (
                id, booking_id, kind, recipient, subject, html, status,
                provider_id, error, created_at
            ) VALUES (
                $id, $booking_id, $kind, $recipient, $subject, $html, $status,
                $provider_id, $error, $created_at
            )
        `).run(email);
        return this.getEmail(email.id);
    }

    updateEmail(id, patch) {
        const allowed = new Set(["status", "provider_id", "error"]);
        const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
        if (entries.length === 0) return this.getEmail(id);
        const assignments = entries.map(([key]) => `${key} = $${key}`).join(", ");
        this.db.prepare(`UPDATE booking_emails SET ${assignments} WHERE id = $id`).run({
            id,
            ...Object.fromEntries(entries)
        });
        return this.getEmail(id);
    }

    getEmail(id) {
        return this.db.prepare("SELECT * FROM booking_emails WHERE id = ?").get(id) || null;
    }

    listEmailsForBooking(bookingId) {
        return this.db.prepare(`
            SELECT id, booking_id, kind, recipient, subject, status, error, created_at
            FROM booking_emails
            WHERE booking_id = ?
            ORDER BY created_at DESC
        `).all(bookingId);
    }

    insertBookingEvent(event) {
        this.db.prepare(`
            INSERT INTO booking_events (id, booking_id, kind, actor, details, created_at)
            VALUES ($id, $booking_id, $kind, $actor, $details, $created_at)
        `).run({ ...event, details: event.details || "" });
        return this.db.prepare("SELECT * FROM booking_events WHERE id = ?").get(event.id);
    }

    listBookingEvents(bookingId) {
        return this.db.prepare(`
            SELECT id, booking_id, kind, actor, details, created_at
            FROM booking_events
            WHERE booking_id = ?
            ORDER BY created_at DESC
        `).all(bookingId);
    }

    listReminderCandidates() {
        return this.db.prepare(`
            SELECT * FROM bookings
            WHERE status = 'confirmed'
              AND email IS NOT NULL
              AND email <> ''
              AND reminder_sent_at IS NULL
            ORDER BY booking_date ASC, booking_time ASC
        `).all();
    }

    listBookingsByContact(email, phone, excludeId = "") {
        return this.db.prepare(`
            SELECT * FROM bookings
            WHERE id <> ?
              AND ((? <> '' AND email = ?) OR (? <> '' AND phone = ?))
            ORDER BY booking_date DESC, booking_time DESC, created_at DESC
            LIMIT 12
        `).all(excludeId, email || "", email || "", phone || "", phone || "");
    }

    insertWaitlistEntry(entry) {
        this.db.prepare(`
            INSERT INTO waitlist_entries (
                id, booking_date, booking_time, party_size, guest_name,
                email, phone, notes, status, created_at, updated_at,
                notified_at, booked_at
            ) VALUES (
                $id, $booking_date, $booking_time, $party_size, $guest_name,
                $email, $phone, $notes, $status, $created_at, $updated_at,
                $notified_at, $booked_at
            )
        `).run(entry);
        return this.getWaitlistEntry(entry.id);
    }

    getWaitlistEntry(id) {
        return this.db.prepare("SELECT * FROM waitlist_entries WHERE id = ?").get(id) || null;
    }

    listWaitlist(date) {
        return this.db.prepare(`
            SELECT * FROM waitlist_entries
            WHERE booking_date = ?
            ORDER BY booking_time ASC, created_at ASC
        `).all(date);
    }

    listWaitingForDate(date) {
        return this.db.prepare(`
            SELECT * FROM waitlist_entries
            WHERE booking_date = ? AND status = 'waiting'
            ORDER BY created_at ASC
        `).all(date);
    }

    updateWaitlistEntry(id, patch) {
        const allowed = new Set(["status", "updated_at", "notified_at", "booked_at"]);
        const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
        if (!entries.length) return this.getWaitlistEntry(id);
        const assignments = entries.map(([key]) => `${key} = $${key}`).join(", ");
        this.db.prepare(`UPDATE waitlist_entries SET ${assignments} WHERE id = $id`).run({
            id,
            ...Object.fromEntries(entries)
        });
        return this.getWaitlistEntry(id);
    }

    insertWaitlistEmail(email) {
        this.db.prepare(`
            INSERT INTO waitlist_emails (
                id, waitlist_id, kind, recipient, subject, html, status,
                provider_id, error, created_at
            ) VALUES (
                $id, $waitlist_id, $kind, $recipient, $subject, $html, $status,
                $provider_id, $error, $created_at
            )
        `).run(email);
        return this.getWaitlistEmail(email.id);
    }

    updateWaitlistEmail(id, patch) {
        const allowed = new Set(["status", "provider_id", "error"]);
        const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
        if (!entries.length) return this.getWaitlistEmail(id);
        const assignments = entries.map(([key]) => `${key} = $${key}`).join(", ");
        this.db.prepare(`UPDATE waitlist_emails SET ${assignments} WHERE id = $id`).run({
            id,
            ...Object.fromEntries(entries)
        });
        return this.getWaitlistEmail(id);
    }

    getWaitlistEmail(id) {
        return this.db.prepare("SELECT * FROM waitlist_emails WHERE id = ?").get(id) || null;
    }

    listWaitlistEmails(waitlistId) {
        return this.db.prepare(`
            SELECT id, waitlist_id, kind, recipient, subject, status, error, created_at
            FROM waitlist_emails
            WHERE waitlist_id = ?
            ORDER BY created_at DESC
        `).all(waitlistId);
    }

    close() {
        this.db.close();
    }
}

module.exports = { BookingStore };
