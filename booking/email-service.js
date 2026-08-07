"use strict";

const crypto = require("node:crypto");
const site = require("../src/_data/site.json");
const { BOOKING_CONFIG, formatTime } = require("./config");

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function redactSensitiveHtml(value) {
    return String(value || "").replace(/([?#&]token=)[A-Za-z0-9_-]+/g, "$1redacted");
}

function formatDate(value) {
    return new Intl.DateTimeFormat("en-GB", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "UTC"
    }).format(new Date(`${value}T12:00:00Z`));
}

function emailButton(href, label, colour = "#b18a42") {
    return `<a href="${escapeHtml(href)}" style="display:inline-block;background:${colour};color:#ffffff;text-decoration:none;padding:14px 22px;border-radius:4px;font-weight:bold;margin:4px;">${escapeHtml(label)}</a>`;
}

function emailShell({ preheader, heading, intro, content, action }) {
    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;background:#f5f0e8;color:#26392d;font-family:Arial,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(preheader)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f0e8;padding:24px 12px;">
        <tr><td align="center">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#ffffff;border-radius:8px;overflow:hidden;">
                <tr>
                    <td style="background:#102b1d;padding:28px;text-align:center;">
                        <div style="font-family:Georgia,serif;font-size:30px;color:#ffffff;">The Waterloo <span style="color:#c7a45b;">Inn</span></div>
                        <div style="margin-top:6px;color:#d7caaa;font-size:13px;letter-spacing:2px;text-transform:uppercase;">Biggin, Derbyshire</div>
                    </td>
                </tr>
                <tr>
                    <td style="padding:38px 34px;">
                        <h1 style="font-family:Georgia,serif;font-size:30px;line-height:1.2;margin:0 0 16px;color:#193c29;">${escapeHtml(heading)}</h1>
                        <p style="font-size:16px;line-height:1.65;margin:0 0 24px;color:#4c5b51;">${escapeHtml(intro)}</p>
                        ${content}
                        ${action || ""}
                        <p style="font-size:13px;line-height:1.6;color:#6e776f;margin:30px 0 0;border-top:1px solid #e8e1d4;padding-top:20px;">
                            The Waterloo Inn, Biggin, Nr Hartington, Buxton, Derbyshire, SK17 0DH<br>
                            <a href="tel:${escapeHtml(site.phone)}" style="color:#8d6b2d;">${escapeHtml(site.phone)}</a>
                            &nbsp;·&nbsp;
                            <a href="mailto:${escapeHtml(site.email)}" style="color:#8d6b2d;">${escapeHtml(site.email)}</a>
                        </p>
                    </td>
                </tr>
            </table>
        </td></tr>
    </table>
</body>
</html>`;
}

function bookingDetails(booking) {
    const requests = booking.requests
        ? `<tr><td style="padding:9px 0;color:#6e776f;">Special requests</td><td style="padding:9px 0;text-align:right;color:#26392d;">${escapeHtml(booking.requests)}</td></tr>`
        : "";
    const area = booking.area
        ? `<tr><td style="padding:9px 0;color:#6e776f;">Area</td><td style="padding:9px 0;text-align:right;">${escapeHtml(booking.area)}${booking.table_label ? ` · ${escapeHtml(booking.table_label)}` : ""}</td></tr>`
        : "";
    return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#faf7f1;border:1px solid #e8e1d4;border-radius:6px;padding:14px 20px;margin-bottom:24px;">
        <tr><td style="padding:9px 0;color:#6e776f;">Reference</td><td style="padding:9px 0;text-align:right;font-weight:bold;">${escapeHtml(booking.reference)}</td></tr>
        <tr><td style="padding:9px 0;color:#6e776f;">Date</td><td style="padding:9px 0;text-align:right;">${escapeHtml(formatDate(booking.booking_date))}</td></tr>
        <tr><td style="padding:9px 0;color:#6e776f;">Time</td><td style="padding:9px 0;text-align:right;">${escapeHtml(formatTime(booking.booking_time))}</td></tr>
        <tr><td style="padding:9px 0;color:#6e776f;">Guests</td><td style="padding:9px 0;text-align:right;">${booking.party_size}</td></tr>
        ${area}${requests}
    </table>`;
}

function waitlistDetails(entry) {
    return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#faf7f1;border:1px solid #e8e1d4;border-radius:6px;padding:14px 20px;margin-bottom:24px;">
        <tr><td style="padding:9px 0;color:#6e776f;">Date</td><td style="padding:9px 0;text-align:right;">${escapeHtml(formatDate(entry.booking_date))}</td></tr>
        <tr><td style="padding:9px 0;color:#6e776f;">Preferred time</td><td style="padding:9px 0;text-align:right;">${escapeHtml(formatTime(entry.booking_time))}</td></tr>
        <tr><td style="padding:9px 0;color:#6e776f;">Guests</td><td style="padding:9px 0;text-align:right;">${entry.party_size}</td></tr>
    </table>`;
}

class EmailService {
    constructor(store, options = {}) {
        this.store = store;
        this.apiKey = options.apiKey ?? process.env.RESEND_API_KEY ?? "";
        this.fromEmail = options.fromEmail ?? process.env.BOOKING_FROM_EMAIL ?? "bookings@waterlooinnbiggin.com";
        this.staffEmail = options.staffEmail ?? process.env.BOOKING_STAFF_EMAIL ?? site.email;
        this.publicUrl = (options.publicUrl ?? process.env.BOOKING_PUBLIC_URL ?? "http://localhost:8888").replace(/\/$/, "");
    }

    async providerDelivery(recipient, subject, html) {
        if (!this.apiKey) return { status: "preview", providerId: null, error: null };
        try {
            const response = await fetch("https://api.resend.com/emails", {
                method: "POST",
                signal: AbortSignal.timeout(10_000),
                headers: {
                    "Authorization": `Bearer ${this.apiKey}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    from: `${BOOKING_CONFIG.venueName} <${this.fromEmail}>`,
                    to: [recipient],
                    reply_to: site.email,
                    subject,
                    html
                })
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.message || "Email provider rejected the message.");
            return { status: "sent", providerId: result.id || null, error: null };
        } catch (error) {
            return { status: "failed", providerId: null, error: error.message };
        }
    }

    async deliver({ booking, kind, recipient, subject, html }) {
        const id = crypto.randomUUID();
        const createdAt = new Date().toISOString();
        this.store.insertEmail({
            id,
            booking_id: booking.id,
            kind,
            recipient,
            subject,
            html: redactSensitiveHtml(html),
            status: this.apiKey ? "sending" : "preview",
            provider_id: null,
            error: null,
            created_at: createdAt
        });
        const delivery = await this.providerDelivery(recipient, subject, html);
        return this.store.updateEmail(id, {
            status: delivery.status,
            provider_id: delivery.providerId,
            error: delivery.error
        });
    }

    async deliverWaitlist({ entry, kind, recipient, subject, html }) {
        const id = crypto.randomUUID();
        this.store.insertWaitlistEmail({
            id,
            waitlist_id: entry.id,
            kind,
            recipient,
            subject,
            html: redactSensitiveHtml(html),
            status: this.apiKey ? "sending" : "preview",
            provider_id: null,
            error: null,
            created_at: new Date().toISOString()
        });
        const delivery = await this.providerDelivery(recipient, subject, html);
        return this.store.updateWaitlistEmail(id, {
            status: delivery.status,
            provider_id: delivery.providerId,
            error: delivery.error
        });
    }

    async sendBookingEmails(booking, manageToken) {
        const manageUrl = `${this.publicUrl}/booking/manage/#token=${encodeURIComponent(manageToken)}`;
        const awaitingVerification = booking.status === "pending";
        const customerHtml = emailShell({
            preheader: awaitingVerification
                ? `Confirm your Waterloo Inn booking for ${formatDate(booking.booking_date)}.`
                : `Your table at The Waterloo Inn is confirmed for ${formatDate(booking.booking_date)}.`,
            heading: awaitingVerification ? "Confirm your email to reserve the table" : "Your table is confirmed",
            intro: awaitingVerification
                ? `Thanks ${booking.guest_name}. Please use the secure button below within ${BOOKING_CONFIG.verificationHoldMinutes} minutes to confirm your booking.`
                : `Thanks ${booking.guest_name}. We look forward to welcoming you to The Waterloo Inn.`,
            content: `${bookingDetails(booking)}
                <p style="font-size:14px;line-height:1.6;color:#5a665d;">
                    Your table will be held for ${BOOKING_CONFIG.tableHoldMinutes} minutes after the booked time. If you are running late, please call us on ${escapeHtml(site.phone)}.
                </p>`,
            action: `<p style="text-align:center;margin:28px 0 0;">${emailButton(manageUrl, awaitingVerification ? "Confirm booking" : "Manage booking")}</p>`
        });
        const staffHtml = emailShell({
            preheader: `New website booking: ${booking.reference}`,
            heading: "New table booking",
            intro: `${booking.guest_name} has made a ${awaitingVerification ? "booking awaiting email verification" : "confirmed booking"}.`,
            content: `${bookingDetails(booking)}
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                    <tr><td style="padding:6px 0;color:#6e776f;">Telephone</td><td style="text-align:right;"><a href="tel:${escapeHtml(booking.phone || "")}">${escapeHtml(booking.phone || "Not supplied")}</a></td></tr>
                    <tr><td style="padding:6px 0;color:#6e776f;">Email</td><td style="text-align:right;">${escapeHtml(booking.email || "Not supplied")}</td></tr>
                    <tr><td style="padding:6px 0;color:#6e776f;">Source</td><td style="text-align:right;">${escapeHtml(booking.source)}</td></tr>
                </table>`,
            action: `<p style="text-align:center;margin:28px 0 0;">${emailButton(`${this.publicUrl}/admin/bookings/?date=${booking.booking_date}`, "Open booking diary", "#193c29")}</p>`
        });

        const emails = [];
        if (booking.email) {
            emails.push(await this.deliver({
                booking,
                kind: "customer_confirmation",
                recipient: booking.email,
                subject: `${awaitingVerification ? "Please confirm your booking" : "Booking confirmed"} · ${formatDate(booking.booking_date)} at ${formatTime(booking.booking_time)}`,
                html: customerHtml
            }));
        }
        emails.push(await this.deliver({
            booking,
            kind: "staff_notification",
            recipient: this.staffEmail,
            subject: `New booking · ${booking.party_size} guests · ${formatDate(booking.booking_date)} ${formatTime(booking.booking_time)}`,
            html: staffHtml
        }));
        return emails;
    }

    async sendReminderEmail(booking, manageToken) {
        const baseManageUrl = `${this.publicUrl}/booking/manage/#token=${encodeURIComponent(manageToken)}`;
        const html = emailShell({
            preheader: `A reminder about your table at The Waterloo Inn tomorrow.`,
            heading: "Are you still joining us?",
            intro: `Hello ${booking.guest_name}. Your table at The Waterloo Inn is coming up soon. Please confirm or make any changes below.`,
            content: bookingDetails(booking),
            action: `<p style="text-align:center;margin:28px 0 0;">
                ${emailButton(`${baseManageUrl}&intent=confirm`, "Confirm my booking", "#193c29")}
                ${emailButton(`${baseManageUrl}&intent=cancel`, "Change or cancel", "#8a3b30")}
            </p>`
        });
        return this.deliver({
            booking,
            kind: "customer_reminder",
            recipient: booking.email,
            subject: `Please confirm your table · ${formatDate(booking.booking_date)} at ${formatTime(booking.booking_time)}`,
            html
        });
    }

    async sendAmendmentEmails(booking, manageToken) {
        const manageUrl = `${this.publicUrl}/booking/manage/#token=${encodeURIComponent(manageToken)}`;
        const customerHtml = emailShell({
            preheader: `Your Waterloo Inn booking has been updated.`,
            heading: "Your booking has been updated",
            intro: `Thanks ${booking.guest_name}. These are your new booking details.`,
            content: bookingDetails(booking),
            action: `<p style="text-align:center;margin:28px 0 0;">${emailButton(manageUrl, "Manage booking")}</p>`
        });
        const staffHtml = emailShell({
            preheader: `Booking ${booking.reference} was changed online.`,
            heading: "Customer amended a booking",
            intro: `${booking.guest_name} changed their booking using the customer link.`,
            content: bookingDetails(booking),
            action: `<p style="text-align:center;margin:28px 0 0;">${emailButton(`${this.publicUrl}/admin/bookings/?date=${booking.booking_date}`, "Open booking diary", "#193c29")}</p>`
        });
        const emails = [];
        if (booking.email) {
            emails.push(await this.deliver({
                booking,
                kind: "customer_amendment",
                recipient: booking.email,
                subject: `Booking updated · ${formatDate(booking.booking_date)} at ${formatTime(booking.booking_time)}`,
                html: customerHtml
            }));
        }
        emails.push(await this.deliver({
            booking,
            kind: "staff_amendment",
            recipient: this.staffEmail,
            subject: `Booking changed · ${booking.reference}`,
            html: staffHtml
        }));
        return emails;
    }

    async sendCancellationEmails(booking) {
        const customerHtml = emailShell({
            preheader: `Booking ${booking.reference} has been cancelled.`,
            heading: "Your booking is cancelled",
            intro: `Your booking at The Waterloo Inn has been cancelled as requested.`,
            content: bookingDetails(booking),
            action: `<p style="text-align:center;margin:28px 0 0;">${emailButton(`${this.publicUrl}/book/`, "Make another booking")}</p>`
        });
        const staffHtml = emailShell({
            preheader: `Booking ${booking.reference} has been cancelled.`,
            heading: "Booking cancelled",
            intro: `${booking.guest_name}'s booking has been cancelled and its capacity is available again.`,
            content: bookingDetails(booking),
            action: ""
        });
        const emails = [];
        if (booking.email) {
            emails.push(await this.deliver({
                booking,
                kind: "customer_cancellation",
                recipient: booking.email,
                subject: `Booking cancelled · ${booking.reference}`,
                html: customerHtml
            }));
        }
        emails.push(await this.deliver({
            booking,
            kind: "staff_cancellation",
            recipient: this.staffEmail,
            subject: `Cancelled · ${booking.reference} · ${booking.party_size} guests`,
            html: staffHtml
        }));
        return emails;
    }

    async sendWaitlistJoinedEmails(entry) {
        const customerHtml = emailShell({
            preheader: `You are on The Waterloo Inn waiting list.`,
            heading: "You’re on the waiting list",
            intro: `Thanks ${entry.guest_name}. We’ll let you know if a suitable table becomes available. This is not yet a confirmed booking.`,
            content: waitlistDetails(entry),
            action: ""
        });
        const staffHtml = emailShell({
            preheader: `New waiting-list request from ${entry.guest_name}.`,
            heading: "New waiting-list request",
            intro: `${entry.guest_name} would like a table if capacity becomes available.`,
            content: `${waitlistDetails(entry)}
                <p style="font-size:14px;line-height:1.6;color:#5a665d;">${escapeHtml(entry.phone)} · ${escapeHtml(entry.email)}</p>`,
            action: `<p style="text-align:center;margin:28px 0 0;">${emailButton(`${this.publicUrl}/admin/bookings/?date=${entry.booking_date}`, "Open waiting list", "#193c29")}</p>`
        });
        return Promise.all([
            this.deliverWaitlist({
                entry,
                kind: "waitlist_joined",
                recipient: entry.email,
                subject: `Waiting list · ${formatDate(entry.booking_date)} at ${formatTime(entry.booking_time)}`,
                html: customerHtml
            }),
            this.deliverWaitlist({
                entry,
                kind: "staff_waitlist_joined",
                recipient: this.staffEmail,
                subject: `Waiting list · ${entry.party_size} guests · ${formatDate(entry.booking_date)} ${formatTime(entry.booking_time)}`,
                html: staffHtml
            })
        ]);
    }

    async sendWaitlistAvailableEmail(entry) {
        const bookingUrl = new URL(`${this.publicUrl}/book/`);
        bookingUrl.searchParams.set("date", entry.booking_date);
        bookingUrl.searchParams.set("party", String(entry.party_size));
        bookingUrl.searchParams.set("time", entry.booking_time);
        const html = emailShell({
            preheader: `A table may now be available at The Waterloo Inn.`,
            heading: "A table has become available",
            intro: `Hello ${entry.guest_name}. Capacity has opened up around your preferred time. Tables remain first come, first served until a booking is completed.`,
            content: waitlistDetails(entry),
            action: `<p style="text-align:center;margin:28px 0 0;">${emailButton(bookingUrl.toString(), "Book this table", "#193c29")}</p>`
        });
        return this.deliverWaitlist({
            entry,
            kind: "waitlist_availability",
            recipient: entry.email,
            subject: `A table is available · ${formatDate(entry.booking_date)} at ${formatTime(entry.booking_time)}`,
            html
        });
    }
}

module.exports = { EmailService, escapeHtml, formatDate, redactSensitiveHtml };
