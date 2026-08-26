CREATE TABLE bookings (
    id TEXT PRIMARY KEY,
    reference TEXT NOT NULL UNIQUE,
    booking_date TEXT NOT NULL,
    booking_time TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
    party_size INTEGER NOT NULL CHECK (party_size BETWEEN 1 AND 8),
    guest_name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    requests TEXT NOT NULL DEFAULT '',
    internal_notes TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'web'
        CHECK (source IN ('web', 'phone', 'walk_in', 'admin')),
    status TEXT NOT NULL DEFAULT 'confirmed'
        CHECK (status IN ('pending', 'confirmed', 'arrived', 'seated', 'completed', 'cancelled', 'no_show', 'expired')),
    cancellation_token_hash TEXT UNIQUE,
    stable_manage_token_hash TEXT UNIQUE,
    manage_token_expires_at TEXT,
    idempotency_key TEXT UNIQUE,
    email_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    cancelled_at TEXT,
    call_confirmed_at TEXT,
    customer_confirmed_at TEXT,
    reminder_sent_at TEXT,
    reminder_claimed_at TEXT,
    hold_expires_at TEXT,
    area TEXT NOT NULL DEFAULT 'Restaurant'
        CHECK (area IN ('Restaurant', 'Bar', 'Outside')),
    table_label TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_bookings_date ON bookings (booking_date, booking_time);
CREATE INDEX idx_bookings_status ON bookings (status);
CREATE UNIQUE INDEX idx_bookings_idempotency
    ON bookings (idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE booking_blocks (
    id TEXT PRIMARY KEY,
    booking_date TEXT NOT NULL,
    booking_time TEXT NOT NULL DEFAULT '*',
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (booking_date, booking_time)
);

CREATE INDEX idx_booking_blocks_date ON booking_blocks (booking_date);

CREATE TABLE booking_emails (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    recipient TEXT NOT NULL,
    subject TEXT NOT NULL,
    html TEXT NOT NULL,
    status TEXT NOT NULL,
    provider_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_booking_emails_booking
    ON booking_emails (booking_id, created_at);

CREATE TABLE booking_events (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT 'Admin',
    details TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE INDEX idx_booking_events_booking
    ON booking_events (booking_id, created_at);

CREATE TABLE waitlist_entries (
    id TEXT PRIMARY KEY,
    booking_date TEXT NOT NULL,
    booking_time TEXT NOT NULL,
    party_size INTEGER NOT NULL CHECK (party_size BETWEEN 1 AND 8),
    guest_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'waiting'
        CHECK (status IN ('waiting', 'notified', 'booked', 'closed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    notified_at TEXT,
    booked_at TEXT,
    idempotency_key TEXT UNIQUE,
    notification_claimed_at TEXT
);

CREATE INDEX idx_waitlist_date
    ON waitlist_entries (booking_date, booking_time, status, created_at);
CREATE UNIQUE INDEX idx_waitlist_idempotency
    ON waitlist_entries (idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE waitlist_emails (
    id TEXT PRIMARY KEY,
    waitlist_id TEXT NOT NULL REFERENCES waitlist_entries(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    recipient TEXT NOT NULL,
    subject TEXT NOT NULL,
    html TEXT NOT NULL,
    status TEXT NOT NULL,
    provider_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_waitlist_emails_entry
    ON waitlist_emails (waitlist_id, created_at);

CREATE TABLE rate_limit_events (
    id TEXT PRIMARY KEY,
    rate_key TEXT NOT NULL,
    action TEXT NOT NULL,
    created_at BIGINT NOT NULL
);

CREATE INDEX idx_rate_limit_lookup
    ON rate_limit_events (rate_key, action, created_at);

CREATE TABLE admin_events (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    details TEXT NOT NULL DEFAULT '',
    request_id TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_admin_events_created_at ON admin_events (created_at);

CREATE TABLE app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT INTO app_meta (key, value) VALUES
    ('manage_token_version', '2'),
    ('online_bookings_enabled', 'false'),
    ('max_online_covers', '30');
