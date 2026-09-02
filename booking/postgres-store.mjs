import { AsyncLocalStorage } from "node:async_hooks";
import { getDatabase } from "@netlify/database";

const BOOKING_COLUMNS = [
    "id", "reference", "booking_date", "booking_time", "duration_minutes",
    "party_size", "guest_name", "email", "phone", "requests", "internal_notes",
    "source", "status", "cancellation_token_hash", "email_status",
    "stable_manage_token_hash", "manage_token_expires_at", "idempotency_key",
    "created_at", "updated_at", "cancelled_at", "call_confirmed_at",
    "customer_confirmed_at", "reminder_sent_at", "reminder_claimed_at",
    "hold_expires_at", "area", "table_label"
];

const BOOKING_UPDATE_COLUMNS = new Set(BOOKING_COLUMNS.filter((column) => !["id", "reference", "created_at"].includes(column)));
const EMAIL_UPDATE_COLUMNS = new Set(["status", "provider_id", "error"]);
const WAITLIST_UPDATE_COLUMNS = new Set([
    "status", "updated_at", "notified_at", "booked_at", "notification_claimed_at"
]);

function first(result) {
    return result.rows[0] || null;
}

function assignments(entries, offset = 1) {
    return entries.map(([column], index) => `${column} = $${index + offset}`).join(", ");
}

export class PostgresBookingStore {
    constructor(options = {}) {
        this.database = options.database || getDatabase(
            options.connectionString ? { connectionString: options.connectionString } : undefined
        );
        this.transactionContext = new AsyncLocalStorage();
        this.writeTail = Promise.resolve();
    }

    query(text, values = []) {
        const client = this.transactionContext.getStore();
        return (client || this.database.pool).query(text, values);
    }

    async transaction(callback) {
        const activeClient = this.transactionContext.getStore();
        if (activeClient) return callback();

        let releaseLocalWrite;
        const previousWrite = this.writeTail;
        this.writeTail = new Promise((resolve) => { releaseLocalWrite = resolve; });
        await previousWrite;
        let client;
        try {
            client = await this.database.pool.connect();
            await client.query("BEGIN");
            // Every capacity-sensitive write locks the same durable settings row.
            // The lock is released by COMMIT/ROLLBACK and works across function
            // instances, preventing two requests from claiming the last covers.
            await client.query(`
                SELECT value FROM app_meta
                WHERE key = $1
                FOR UPDATE
            `, ["max_online_covers"]);
            const result = await this.transactionContext.run(client, callback);
            await client.query("COMMIT");
            return result;
        } catch (error) {
            if (client) await client.query("ROLLBACK");
            throw error;
        } finally {
            if (client) client.release();
            releaseLocalWrite();
        }
    }

    async getAppMeta(key, fallback = null) {
        const row = first(await this.query("SELECT value FROM app_meta WHERE key = $1", [key]));
        return row ? row.value : fallback;
    }

    async setAppMeta(key, value) {
        const stored = String(value);
        await this.query(`
            INSERT INTO app_meta (key, value) VALUES ($1, $2)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        `, [key, stored]);
        return stored;
    }

    async insertBooking(booking) {
        const values = BOOKING_COLUMNS.map((column) => booking[column] ?? null);
        const placeholders = BOOKING_COLUMNS.map((_, index) => `$${index + 1}`).join(", ");
        const result = await this.query(`
            INSERT INTO bookings (${BOOKING_COLUMNS.join(", ")})
            VALUES (${placeholders})
            RETURNING *
        `, values);
        return first(result);
    }

    async getBooking(id) {
        return first(await this.query("SELECT * FROM bookings WHERE id = $1", [id]));
    }

    async getBookingByTokenHash(tokenHash) {
        return first(await this.query(`
            SELECT * FROM bookings
            WHERE cancellation_token_hash = $1 OR stable_manage_token_hash = $1
        `, [tokenHash]));
    }

    async getBookingByIdempotencyKey(key) {
        if (!key) return null;
        return first(await this.query("SELECT * FROM bookings WHERE idempotency_key = $1", [key]));
    }

    async listBookings(date) {
        return (await this.query(`
            SELECT * FROM bookings
            WHERE booking_date = $1
            ORDER BY booking_time ASC, created_at ASC
        `, [date])).rows;
    }

    async listRecentBookings(limit = 6) {
        return (await this.query(`
            SELECT * FROM bookings
            ORDER BY created_at DESC
            LIMIT $1
        `, [limit])).rows;
    }

    async listActiveBookings(date, excludeId = "", nowIso = new Date().toISOString()) {
        return (await this.query(`
            SELECT * FROM bookings
            WHERE booking_date = $1
              AND status IN ('pending', 'confirmed', 'arrived', 'seated')
              AND (status <> 'pending' OR hold_expires_at > $2)
              AND id <> $3
            ORDER BY booking_time ASC
        `, [date, nowIso, excludeId])).rows;
    }

    async expirePendingHolds(nowIso) {
        const result = await this.query(`
            UPDATE bookings
            SET status = 'expired', cancellation_token_hash = NULL,
                stable_manage_token_hash = NULL, manage_token_expires_at = NULL,
                updated_at = $1
            WHERE status = 'pending' AND hold_expires_at <= $1
        `, [nowIso]);
        return result.rowCount;
    }

    async updateBooking(id, patch) {
        const entries = Object.entries(patch).filter(([key]) => BOOKING_UPDATE_COLUMNS.has(key));
        if (!entries.length) return this.getBooking(id);
        const values = entries.map(([, value]) => value);
        const result = await this.query(`
            UPDATE bookings SET ${assignments(entries)}
            WHERE id = $${entries.length + 1}
            RETURNING *
        `, [...values, id]);
        return first(result);
    }

    async createBlock(block) {
        const result = await this.query(`
            INSERT INTO booking_blocks (id, booking_date, booking_time, reason, created_at)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
        `, [block.id, block.booking_date, block.booking_time, block.reason, block.created_at]);
        return first(result);
    }

    async getBlock(id) {
        return first(await this.query("SELECT * FROM booking_blocks WHERE id = $1", [id]));
    }

    async listBlocks(date) {
        return (await this.query(`
            SELECT * FROM booking_blocks
            WHERE booking_date = $1
            ORDER BY booking_time ASC
        `, [date])).rows;
    }

    async removeBlock(id) {
        return (await this.query("DELETE FROM booking_blocks WHERE id = $1", [id])).rowCount > 0;
    }

    async insertEmail(email) {
        const result = await this.query(`
            INSERT INTO booking_emails (
                id, booking_id, kind, recipient, subject, html, status,
                provider_id, error, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING *
        `, [
            email.id, email.booking_id, email.kind, email.recipient, email.subject,
            email.html, email.status, email.provider_id, email.error, email.created_at
        ]);
        return first(result);
    }

    async updateEmail(id, patch) {
        const entries = Object.entries(patch).filter(([key]) => EMAIL_UPDATE_COLUMNS.has(key));
        if (!entries.length) return this.getEmail(id);
        const result = await this.query(`
            UPDATE booking_emails SET ${assignments(entries)}
            WHERE id = $${entries.length + 1}
            RETURNING *
        `, [...entries.map(([, value]) => value), id]);
        return first(result);
    }

    async getEmail(id) {
        return first(await this.query("SELECT * FROM booking_emails WHERE id = $1", [id]));
    }

    async listEmailsForBooking(bookingId) {
        return (await this.query(`
            SELECT id, booking_id, kind, recipient, subject, status, error, created_at
            FROM booking_emails
            WHERE booking_id = $1
            ORDER BY created_at DESC
        `, [bookingId])).rows;
    }

    async insertBookingEvent(event) {
        const result = await this.query(`
            INSERT INTO booking_events (id, booking_id, kind, actor, details, created_at)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
        `, [event.id, event.booking_id, event.kind, event.actor, event.details || "", event.created_at]);
        return first(result);
    }

    async listBookingEvents(bookingId) {
        return (await this.query(`
            SELECT id, booking_id, kind, actor, details, created_at
            FROM booking_events
            WHERE booking_id = $1
            ORDER BY created_at DESC
        `, [bookingId])).rows;
    }

    async listReminderCandidates() {
        return (await this.query(`
            SELECT * FROM bookings
            WHERE status = 'confirmed'
              AND email IS NOT NULL AND email <> ''
              AND reminder_sent_at IS NULL
              AND reminder_claimed_at IS NULL
            ORDER BY booking_date ASC, booking_time ASC
        `)).rows;
    }

    async claimReminder(id, claimedAt, staleBefore, force = false) {
        const result = await this.query(`
            UPDATE bookings SET reminder_claimed_at = $1
            WHERE id = $2
              AND (reminder_claimed_at IS NULL OR reminder_claimed_at < $3)
              AND ($4::boolean OR reminder_sent_at IS NULL)
        `, [claimedAt, id, staleBefore, force]);
        return result.rowCount === 1;
    }

    async releaseReminderClaim(id) {
        await this.query("UPDATE bookings SET reminder_claimed_at = NULL WHERE id = $1", [id]);
    }

    async listBookingsByContact(email, phone, excludeId = "") {
        return (await this.query(`
            SELECT * FROM bookings
            WHERE id <> $1
              AND (($2 <> '' AND email = $2) OR ($3 <> '' AND phone = $3))
            ORDER BY booking_date DESC, booking_time DESC, created_at DESC
            LIMIT 12
        `, [excludeId, email || "", phone || ""])).rows;
    }

    async insertWaitlistEntry(entry) {
        const result = await this.query(`
            INSERT INTO waitlist_entries (
                id, booking_date, booking_time, party_size, guest_name,
                email, phone, notes, status, created_at, updated_at,
                notified_at, booked_at, idempotency_key, notification_claimed_at
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
            ) RETURNING *
        `, [
            entry.id, entry.booking_date, entry.booking_time, entry.party_size,
            entry.guest_name, entry.email, entry.phone, entry.notes, entry.status,
            entry.created_at, entry.updated_at, entry.notified_at, entry.booked_at,
            entry.idempotency_key, entry.notification_claimed_at
        ]);
        return first(result);
    }

    async getWaitlistEntry(id) {
        return first(await this.query("SELECT * FROM waitlist_entries WHERE id = $1", [id]));
    }

    async getWaitlistEntryByIdempotencyKey(key) {
        if (!key) return null;
        return first(await this.query("SELECT * FROM waitlist_entries WHERE idempotency_key = $1", [key]));
    }

    async listWaitlist(date) {
        return (await this.query(`
            SELECT * FROM waitlist_entries
            WHERE booking_date = $1
            ORDER BY booking_time ASC, created_at ASC
        `, [date])).rows;
    }

    async listWaitingForDate(date) {
        return (await this.query(`
            SELECT * FROM waitlist_entries
            WHERE booking_date = $1 AND status = 'waiting'
            ORDER BY created_at ASC
        `, [date])).rows;
    }

    async updateWaitlistEntry(id, patch) {
        const entries = Object.entries(patch).filter(([key]) => WAITLIST_UPDATE_COLUMNS.has(key));
        if (!entries.length) return this.getWaitlistEntry(id);
        const result = await this.query(`
            UPDATE waitlist_entries SET ${assignments(entries)}
            WHERE id = $${entries.length + 1}
            RETURNING *
        `, [...entries.map(([, value]) => value), id]);
        return first(result);
    }

    async claimWaitlistNotification(id, claimedAt, staleBefore, force = false) {
        const result = await this.query(`
            UPDATE waitlist_entries SET notification_claimed_at = $1
            WHERE id = $2
              AND (notification_claimed_at IS NULL OR notification_claimed_at < $3)
              AND ($4::boolean OR status = 'waiting')
        `, [claimedAt, id, staleBefore, force]);
        return result.rowCount === 1;
    }

    async consumeRateLimit({ id, key, action, now, windowMs, limit }) {
        return this.transaction(async () => {
            await this.query("DELETE FROM rate_limit_events WHERE created_at < $1", [now - (24 * 60 * 60 * 1000)]);
            const row = first(await this.query(`
                SELECT COUNT(*)::integer AS count FROM rate_limit_events
                WHERE rate_key = $1 AND action = $2 AND created_at >= $3
            `, [key, action, now - windowMs]));
            if (row.count >= limit) return false;
            await this.query(`
                INSERT INTO rate_limit_events (id, rate_key, action, created_at)
                VALUES ($1, $2, $3, $4)
            `, [id, key, action, now]);
            return true;
        });
    }

    async insertAdminEvent(event) {
        await this.query(`
            INSERT INTO admin_events (
                id, actor, action, target_type, target_id, details, request_id, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
            event.id, event.actor, event.action, event.target_type, event.target_id,
            event.details, event.request_id, event.created_at
        ]);
        return event;
    }

    async applyRetention(cutoffs) {
        return this.transaction(async () => {
            const bookingEmails = await this.query("DELETE FROM booking_emails WHERE created_at < $1", [cutoffs.email]);
            const waitlistEmails = await this.query("DELETE FROM waitlist_emails WHERE created_at < $1", [cutoffs.email]);
            const cancelled = await this.query(`
                UPDATE bookings SET
                    guest_name = 'Deleted guest', email = NULL, phone = NULL,
                    requests = '', internal_notes = '', cancellation_token_hash = NULL,
                    stable_manage_token_hash = NULL, manage_token_expires_at = NULL,
                    updated_at = $1
                WHERE status = 'cancelled' AND cancelled_at < $2
                  AND (email IS NOT NULL OR phone IS NOT NULL OR guest_name <> 'Deleted guest')
            `, [cutoffs.now, cutoffs.cancelled]);
            const historic = await this.query(`
                UPDATE bookings SET
                    guest_name = 'Deleted guest', email = NULL, phone = NULL,
                    requests = '', internal_notes = '', cancellation_token_hash = NULL,
                    stable_manage_token_hash = NULL, manage_token_expires_at = NULL,
                    updated_at = $1
                WHERE booking_date < $2
                  AND (email IS NOT NULL OR phone IS NOT NULL OR guest_name <> 'Deleted guest')
            `, [cutoffs.now, cutoffs.customerDate]);
            const waitlist = await this.query(`
                DELETE FROM waitlist_entries
                WHERE updated_at < $1 AND (status <> 'waiting' OR booking_date < $2)
            `, [cutoffs.waitlist, cutoffs.today]);
            return {
                bookingEmails: bookingEmails.rowCount,
                waitlistEmails: waitlistEmails.rowCount,
                cancelled: cancelled.rowCount,
                historic: historic.rowCount,
                waitlist: waitlist.rowCount
            };
        });
    }

    async insertWaitlistEmail(email) {
        const result = await this.query(`
            INSERT INTO waitlist_emails (
                id, waitlist_id, kind, recipient, subject, html, status,
                provider_id, error, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING *
        `, [
            email.id, email.waitlist_id, email.kind, email.recipient, email.subject,
            email.html, email.status, email.provider_id, email.error, email.created_at
        ]);
        return first(result);
    }

    async updateWaitlistEmail(id, patch) {
        const entries = Object.entries(patch).filter(([key]) => EMAIL_UPDATE_COLUMNS.has(key));
        if (!entries.length) return this.getWaitlistEmail(id);
        const result = await this.query(`
            UPDATE waitlist_emails SET ${assignments(entries)}
            WHERE id = $${entries.length + 1}
            RETURNING *
        `, [...entries.map(([, value]) => value), id]);
        return first(result);
    }

    async getWaitlistEmail(id) {
        return first(await this.query("SELECT * FROM waitlist_emails WHERE id = $1", [id]));
    }

    async listWaitlistEmails(waitlistId) {
        return (await this.query(`
            SELECT id, waitlist_id, kind, recipient, subject, status, error, created_at
            FROM waitlist_emails
            WHERE waitlist_id = $1
            ORDER BY created_at DESC
        `, [waitlistId])).rows;
    }

    async close() {
        if (typeof this.database.pool.end === "function") await this.database.pool.end();
    }
}
