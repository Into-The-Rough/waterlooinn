# Waterloo Inn booking system

The website includes public table booking and waiting-list flows, secure customer
management links, email confirmations/reminders, and an authenticated admin diary.
SQLite is used by the quick local preview server. The deployable implementation
uses Netlify Functions and Netlify Database (Postgres), so bookings and settings
survive function restarts and can be shared safely between function instances.

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

### Weekly food booking times

The **Food table booking times** panel in the admin diary controls the regular
seven-day booking schedule. Staff can mark each weekday open or closed and set
the first and last half-hour arrival time. Changes take effect immediately on the
public form and are recorded in the global audit log.

Online booking is for food tables only: a closed weekday offers no public table
bookings or waiting-list requests, including drinks-only bookings. Closing a day
does not delete bookings already in the diary, and staff can still add a telephone
or walk-in booking when needed. The separate **Close dates or times** control is
available for one-off closures without changing the regular weekly schedule.

## Security behaviour

- The diary reuses the site's existing invite-only Netlify Identity. Every admin
  API validates the current Identity bearer with the Waterloo Inn Identity service,
  checks its permission and enforces same-origin mutations. There is no separate
  booking password.
- Customer email links carry a random 256-bit token in the URL fragment. The
  browser exchanges it for a signed, booking-scoped, HTTP-only 30-minute cookie
  and immediately removes the fragment from the address bar. The cookie survives
  function cold starts and cannot be altered without invalidating its signature.
- Management tokens are stored only as SHA-256 hashes, expire after service plus
  a short grace period, and rotate when a replacement email is accepted.
- Production bookings remain pending for 15 minutes until the email link is used;
  the pending hold counts against capacity and expires automatically.
- Booking and waitlist creation require idempotency keys. Capacity decisions and
  insertions are serialised in Postgres transactions using a shared row lock;
  reminder and waitlist sends use database delivery claims.
- Persistent per-source and per-contact rate limits, a form honeypot, a 64 KiB
  JSON limit, short HTTP timeouts, strict input limits, and generic server errors
  reduce abuse and information leakage.
- Admin changes are attributed to the authenticated actor in booking and global
  audit records. Security headers include CSP, no-referrer, no-store on sensitive
  pages, frame denial, MIME sniffing protection, permissions policy, and HSTS in
  production.
- Stored email bodies are removed after 30 days. Cancelled customer data is
  anonymised after 90 days, completed/historic customer data after 365 days, and
  stale waitlist records after 90 days. A scheduled Function checks reminders and
  retention every six hours, keeping reminder delivery within the 18–24 hour
  window without repeatedly waking an idle database.

## Production requirements

Use the variables documented in [`.env.example`](.env.example). The deployment
needs Netlify Database, the existing invite-only Netlify Identity tenant,
`RESEND_API_KEY`, and a random `BOOKING_SESSION_SECRET` of at least 32 characters.
`BOOKING_PUBLIC_URL`, `BOOKING_FROM_EMAIL`, and `BOOKING_STAFF_EMAIL` should also
be set explicitly in Netlify. Netlify provides `NETLIFY_DB_URL` automatically;
never commit it. The SQL migration creates a fresh database with bookings off and
peak capacity set to 30.

The public form requires working customer email delivery before it accepts a
booking. Booking staff sign in at `/admin/bookings/login/` with the optional
booking-only username/password account, or use the existing invited Identity
account as a fallback. The password is stored only as a salted scrypt hash. Its
secure HTTP-only session lasts 30 days by default and changing the configured
username or hash immediately invalidates existing password sessions.

Configure `BOOKING_BASIC_AUTH_USERNAME`, `BOOKING_BASIC_AUTH_PASSWORD_HASH` and
optionally `BOOKING_BASIC_AUTH_ACTOR` and `BOOKING_BASIC_AUTH_SESSION_DAYS` in
Netlify's secret environment store. Never put the plaintext password or its real
hash in `.env.example` or Git. Password login attempts are rate limited in the
shared booking database.

The current Identity tenant has public signup disabled, matching the existing
Decap CMS access policy. For finer separation, assign an Identity role to booking
staff and configure `BOOKING_ADMIN_ROLES`. Before adding multiple application
instances, move customer management sessions to a shared server-side session store.

## Local SQLite backups

`npm run backup:bookings` takes a consistent snapshot of the local SQLite preview,
encrypts it with
AES-256-GCM, writes it with owner-only permissions, removes the plaintext
temporary file, and prunes matching backups older than the configured retention.

Generate the key once and save it in the deployment secret store, separately from
the backup destination:

```bash
openssl rand -base64 32
```

This script is not a backup for the deployed Postgres database. Database backup,
retention and restore arrangements must be confirmed in the selected Netlify
Database plan before the booking switch is enabled.

## Default booking rules

- Parties of 1–8, 30-minute arrival intervals, and a two-hour table duration
- 30 simultaneous online covers, two hours' notice, and 90 days' advance booking
- Monday 12:00–20:00; Tuesday closed; Wednesday/Thursday 12:00–20:00;
  Friday/Saturday 12:00–21:00; Sunday 12:00–19:00
- Restaurant by default, with bar/outside allocation available to admins
