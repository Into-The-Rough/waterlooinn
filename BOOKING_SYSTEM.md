# Waterloo Inn booking system

The website includes public table booking and waiting-list flows, secure customer
management links, email confirmations/reminders, and an authenticated admin diary.
SQLite is used for the local prototype and is suitable for a single application
instance when its database lives on persistent storage.

## Local use

Node.js 22.16 or newer is required. Build and start the combined site/API server:

```bash
npm run dev:bookings
```

Then open:

- Website: <http://127.0.0.1:8888/>
- Booking page: <http://127.0.0.1:8888/book/>
- Admin diary: <http://127.0.0.1:8888/admin/bookings/>

The database is created at `.local/booking-diary.sqlite` by default. That
directory and local environment files are ignored by Git. With no Resend API key,
emails are stored as local previews and nothing is sent. Preview copies have all
customer bearer tokens redacted and can only be opened by an authenticated admin.

### Online booking master switch

The top of the authenticated booking diary contains a global **Online bookings**
switch. Turning it off immediately hides booking buttons in the website navigation,
replaces both public booking forms with a telephone message, and rejects direct
availability, booking and waiting-list API requests. The setting is stored in the
booking database and survives server restarts. Admin, telephone and walk-in
bookings—and existing customer management links—continue to work. Every change is
attributed to the authenticated admin in the global audit log. A fresh booking
database starts with online bookings **OFF**, so an admin must deliberately enable
them after deployment checks are complete.

The same panel contains a **Peak cover capacity** field. This controls the maximum
number of guests whose two-hour bookings may overlap at any one time. It defaults
to 30, can be changed without restarting the server, and is reflected immediately
in public availability, the daily summary and the monthly calendar.

## Security behaviour

- The diary reuses the site's existing invite-only Netlify Identity. Every admin
  API validates the current Identity bearer with the Waterloo Inn Identity service,
  checks its permission and enforces same-origin mutations. There is no separate
  booking password.
- Customer email links carry a random 256-bit token in the URL fragment. The
  browser exchanges it for a booking-scoped, HTTP-only 30-minute session and
  immediately removes the fragment from the address bar.
- Management tokens are stored only as SHA-256 hashes, expire after service plus
  a short grace period, and rotate when a replacement email is accepted.
- Production bookings remain pending for 15 minutes until the email link is used;
  the pending hold counts against capacity and expires automatically.
- Booking and waitlist creation require idempotency keys. Capacity decisions and
  insertions are serialized in SQLite transactions; reminder and waitlist sends
  use database delivery claims.
- Persistent per-source and per-contact rate limits, a form honeypot, a 64 KiB
  JSON limit, short HTTP timeouts, strict input limits, and generic server errors
  reduce abuse and information leakage.
- Admin changes are attributed to the authenticated actor in booking and global
  audit records. Security headers include CSP, no-referrer, no-store on sensitive
  pages, frame denial, MIME sniffing protection, permissions policy, and HSTS in
  production.
- Stored email bodies are removed after 30 days. Cancelled customer data is
  anonymised after 90 days, completed/historic customer data after 365 days, and
  stale waitlist records after 90 days. Retention runs at startup and daily.

## Production requirements

Use the variables documented in [`.env.example`](.env.example). Production mode
will refuse to start unless the public and Identity URLs are HTTPS, proxy trust is
explicit, email delivery is configured, and the database path is explicitly set
to persistent storage.

Run one application instance. Customer management sessions are held in process
memory, and SQLite must not be shared over a network filesystem. Put the process
behind a trusted HTTPS reverse proxy, expose only the proxy publicly, forward a
sanitised client IP and `X-Forwarded-Proto: https`, and restrict operating-system
access to the service account and its database/backup directories.

The current Identity tenant has public signup disabled, matching the existing
Decap CMS access policy. For finer separation, assign an Identity role to booking
staff and configure `BOOKING_ADMIN_ROLES`. Before adding multiple application
instances, move customer management sessions to a shared server-side session store.

## Backups and recovery

`npm run backup:bookings` takes a consistent SQLite snapshot, encrypts it with
AES-256-GCM, writes it with owner-only permissions, removes the plaintext
temporary file, and prunes matching backups older than the configured retention.

Generate the key once and save it in the deployment secret store, separately from
the backup destination:

```bash
openssl rand -base64 32
```

Schedule the backup command outside the web process, copy encrypted backups to a
separate protected system, alert on failures, and periodically test decryption and
`PRAGMA integrity_check` in an isolated restore directory. Do not overwrite the
live database during a restore test.

## Default booking rules

- Parties of 1–8, 30-minute arrival intervals, and a two-hour table duration
- 30 simultaneous online covers, two hours' notice, and 90 days' advance booking
- Monday 12:00–20:00; Tuesday closed; Wednesday/Thursday 12:00–20:00;
  Friday/Saturday 12:00–21:00; Sunday 12:00–19:00
- Restaurant by default, with bar/outside allocation available to admins
