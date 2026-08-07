# Waterloo Inn booking prototype

This is a local-only table booking prototype for the Waterloo Inn website.

## Run it

```bash
npm run dev:bookings
```

Then open:

- Website: <http://127.0.0.1:8888/>
- Dedicated booking page: <http://127.0.0.1:8888/book/>
- Booking diary: <http://127.0.0.1:8888/admin/bookings/>

The admin area opens with a month-at-a-glance calendar showing booking count,
total covers and peak capacity for every day. Selecting a date opens its full
diary below the overview. Customer phone numbers are tap-to-call links. Each
booking also has a persistent "Called to confirm" checkbox with a timestamped
admin audit history; named staff attribution can replace the generic "Admin"
actor once production authentication is connected.

The diary also includes:

- A pre-service "Needs attention" queue for unconfirmed bookings, email
  failures, large parties, special requests and waitlist entries
- One-tap Arrived, Seated, Completed and No-show actions
- Search and status filters
- A print-ready daily service sheet
- Restaurant, bar and outside area assignment plus table labels
- Contact-based guest history, including previous visits, cancellations and
  no-shows
- A waiting-list diary with availability notifications and conversion into a
  confirmed booking

Customers can confirm, amend or cancel through their secure email link.
Amendments are capacity checked and generate updated customer and staff email
previews. The local server checks once per minute for bookings within 24 hours
and prepares reminder emails with confirm and change/cancel actions.

The local database is created at `.local/booking-diary.sqlite`. This directory is
ignored by Git.

## Default rules

- Instant confirmation
- Parties of 1–8
- 30-minute arrival intervals
- Two-hour table duration
- 20 simultaneous online covers
- Two hours' minimum notice
- Booking up to 90 days ahead
- Reminder 24 hours before arrival
- Restaurant seating area by default; bar and outside are admin options
- Monday: 12:00–20:00
- Tuesday: closed
- Wednesday and Thursday: 12:00–20:00
- Friday and Saturday: 12:00–21:00
- Sunday: 12:00–19:00

## Local email mode

With no email credentials configured, customer confirmations, staff
notifications and cancellations are saved as safe previews. Open a booking in
the diary to view its generated emails.

The templates are already prepared to use:

- From: `bookings@waterlooinnbiggin.com`
- Staff notifications: `waterlooinn417@gmail.com`
- Customer confirmation with a secure manage/cancel link
- Customer and staff cancellation messages

Nothing is sent while running in the default local mode.

Waiting-list and reminder messages are safe email previews; SMS can be added as
a second delivery channel without changing the booking workflow.

## Production work still required

The user-facing flow and diary are complete prototypes, but publishing the
system will require:

1. Moving SQLite data to a production Postgres database.
2. Exposing the API through authenticated server-side functions.
3. Protecting the diary with the existing admin identity.
4. Verifying `waterlooinnbiggin.com` with the email provider.
5. Adding live email credentials as environment variables.
6. Moving the one-minute local reminder check to a hosted scheduled job.
7. Connecting optional reminders/waitlist alerts to an SMS provider.
8. Agreeing a customer-data retention policy for guest history.
9. Running a final test with the pub's confirmed kitchen hours, seating areas
   and capacity.

The local server deliberately does not contain deployable credentials or send
real messages.
