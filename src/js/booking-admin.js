(function () {
    "use strict";

    var dateInput = document.querySelector("[data-diary-date]");
    var bookingList = document.querySelector("[data-booking-list]");
    var waitlistList = document.querySelector("[data-waitlist-list]");
    var blockList = document.querySelector("[data-block-list]");
    var addForm = document.querySelector("[data-add-booking]");
    var blockForm = document.querySelector("[data-add-block]");
    var alertBox = document.querySelector(".admin-alert");
    var calendarGrid = document.querySelector("[data-calendar-grid]");
    var searchInput = document.querySelector("[data-booking-search]");
    var statusFilter = document.querySelector("[data-status-filter]");
    var filterEmpty = document.querySelector("[data-filter-empty]");
    var attentionList = document.querySelector("[data-attention-list]");
    var masterSwitch = document.querySelector("[data-booking-master-switch]");
    var masterToggle = document.querySelector("[data-booking-master-toggle]");
    var masterLabel = document.querySelector("[data-booking-master-label]");
    var masterDescription = document.querySelector("[data-booking-master-description]");
    var masterUpdated = document.querySelector("[data-booking-master-updated]");
    var capacityForm = document.querySelector("[data-capacity-form]");
    var capacityInput = capacityForm.elements.maxCovers;
    var capacitySubmit = capacityForm.querySelector('button[type="submit"]');
    var arrivalCapacityForm = document.querySelector("[data-arrival-capacity-form]");
    var arrivalCapacityInput = arrivalCapacityForm.elements.maxArrivalCovers;
    var arrivalCapacitySubmit = arrivalCapacityForm.querySelector('button[type="submit"]');
    var capacityOverrideLabel = document.querySelector("[data-capacity-override-label]");
    var serviceHoursForm = document.querySelector("[data-service-hours-form]");
    var serviceHoursList = document.querySelector("[data-service-hours-list]");
    var serviceHoursUpdated = document.querySelector("[data-service-hours-updated]");
    var emailDeliveryHeading = document.querySelector("[data-email-delivery-heading]");
    var emailDeliveryCopy = document.querySelector("[data-email-delivery-copy]");
    var recentBookingsList = document.querySelector("[data-recent-bookings-list]");
    var diary = null;
    var calendar = null;
    var calendarMonth = "";
    var attentionFilter = "";
    var recentBookingIds = new Set();
    var recentBookingsLoaded = false;
    var adminRequestId = window.crypto && window.crypto.randomUUID
        ? window.crypto.randomUUID()
        : String(Date.now()) + "-admin-" + Math.random().toString(36).slice(2);

    function isoDate(date) {
        var year = date.getFullYear();
        var month = String(date.getMonth() + 1).padStart(2, "0");
        var day = String(date.getDate()).padStart(2, "0");
        return year + "-" + month + "-" + day;
    }

    function dateFromIso(value) {
        return new Date(value + "T12:00:00");
    }

    function moveDate(days) {
        var value = dateFromIso(dateInput.value);
        value.setDate(value.getDate() + days);
        dateInput.value = isoDate(value);
        syncDate();
    }

    function moveMonth(months) {
        var value = new Date(calendarMonth + "-01T12:00:00");
        value.setMonth(value.getMonth() + months);
        calendarMonth = isoDate(value).slice(0, 7);
        loadCalendar();
    }

    function formatDate(value) {
        return new Intl.DateTimeFormat("en-GB", {
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric",
            timeZone: "UTC"
        }).format(new Date(value + "T12:00:00Z"));
    }

    function formatShortDate(value) {
        return new Intl.DateTimeFormat("en-GB", {
            day: "numeric",
            month: "short",
            year: "numeric",
            timeZone: "UTC"
        }).format(new Date(value + "T12:00:00Z"));
    }

    function formatDateTime(value) {
        return new Intl.DateTimeFormat("en-GB", {
            day: "numeric",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "Europe/London"
        }).format(new Date(value));
    }

    function escapeHtml(value) {
        return String(value == null ? "" : value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function showAlert(message, success) {
        alertBox.textContent = message;
        alertBox.classList.toggle("is-success", Boolean(success));
        alertBox.hidden = false;
        window.clearTimeout(showAlert.timeout);
        showAlert.timeout = window.setTimeout(function () {
            alertBox.hidden = true;
        }, 5000);
    }

    async function api(url, options) {
        var settings = Object.assign({}, options || {});
        var identityToken = null;
        try {
            identityToken = await window.bookingIdentity.optionalToken();
        } catch (_error) {}
        settings.headers = Object.assign({
            "Accept": "application/json",
            "Content-Type": "application/json"
        }, settings.headers || {});
        if (identityToken) settings.headers.Authorization = "Bearer " + identityToken;
        settings.credentials = "same-origin";
        var response = await fetch(url, settings);
        if (response.status === 401) {
            window.location.href = "/admin/bookings/login/";
            throw new Error("Admin session expired.");
        }
        var result = await response.json();
        if (!response.ok) throw new Error(result.error && result.error.message || "Request failed.");
        return result;
    }

    function updateServiceDayState(row) {
        var enabled = row.querySelector('[data-service-enabled]');
        var status = row.querySelector('[data-service-status]');
        row.classList.toggle("is-closed", !enabled.checked);
        status.textContent = enabled.checked ? "OPEN" : "CLOSED";
        row.querySelectorAll('input[type="time"]').forEach(function (input) {
            input.disabled = !enabled.checked;
            input.required = enabled.checked;
        });
    }

    function renderServiceHours(days) {
        serviceHoursList.innerHTML = days.map(function (day) {
            return '<div class="admin-service-day" data-service-day="' + Number(day.weekday) + '">' +
                '<label class="admin-service-day-toggle">' +
                    '<input type="checkbox" data-service-enabled' + (day.enabled ? " checked" : "") + '>' +
                    '<span>' + escapeHtml(day.label) + '</span>' +
                    '<strong data-service-status></strong>' +
                '</label>' +
                '<div class="admin-service-day-times">' +
                    '<label>First<input type="time" data-service-start step="1800" value="' + escapeHtml(day.start) + '"></label>' +
                    '<label>Last<input type="time" data-service-end step="1800" value="' + escapeHtml(day.end) + '"></label>' +
                '</div>' +
            '</div>';
        }).join("");
        serviceHoursList.querySelectorAll("[data-service-day]").forEach(function (row) {
            var toggle = row.querySelector("[data-service-enabled]");
            toggle.addEventListener("change", function () { updateServiceDayState(row); });
            updateServiceDayState(row);
        });
    }

    function renderBookingSettings(state) {
        masterToggle.checked = state.enabled;
        masterToggle.disabled = false;
        masterSwitch.classList.toggle("is-enabled", state.enabled);
        masterSwitch.classList.toggle("is-disabled", !state.enabled);
        masterLabel.textContent = state.enabled ? "ON" : "OFF";
        masterDescription.textContent = state.enabled
            ? "The website is accepting new table bookings and waiting-list requests."
            : "The public form and booking menu buttons are hidden. Admin, telephone and walk-in bookings still work.";
        masterUpdated.textContent = state.updatedAt
            ? "Last changed " + formatDateTime(state.updatedAt) + (state.updatedBy ? " by " + state.updatedBy : "")
            : "No manual changes yet.";
        capacityInput.value = state.maxCovers;
        capacityInput.disabled = false;
        capacitySubmit.disabled = false;
        arrivalCapacityInput.value = state.maxArrivalCovers;
        arrivalCapacityInput.disabled = false;
        arrivalCapacitySubmit.disabled = false;
        capacityOverrideLabel.textContent = "Override the " + state.maxCovers + "-cover peak and " +
            state.maxArrivalCovers + "-cover half-hour limits";
        if (Array.isArray(state.serviceHours)) renderServiceHours(state.serviceHours);
        serviceHoursUpdated.textContent = state.serviceHoursUpdatedAt
            ? "Last changed " + formatDateTime(state.serviceHoursUpdatedAt) +
                (state.serviceHoursUpdatedBy ? " by " + state.serviceHoursUpdatedBy : "")
            : "Using the default weekly food booking schedule.";
    }

    async function loadBookingSettings() {
        var state = await api("/api/admin/booking-settings", { method: "GET" });
        renderBookingSettings(state);
    }

    async function loadEmailDelivery() {
        try {
            var state = await api("/api/health", { method: "GET" });
            if (state.emailDelivery === "resend") {
                emailDeliveryHeading.textContent = "Emails are being sent";
                emailDeliveryCopy.textContent = "Customer and staff booking emails are sent through Resend. Open any booking to review its delivery status and preview the message.";
                return;
            }
            emailDeliveryHeading.textContent = "Local preview outbox";
            emailDeliveryCopy.textContent = "On this local server, emails are generated safely but not sent. Open any booking to preview its customer and staff messages.";
        } catch (_error) {
            emailDeliveryHeading.textContent = "Email delivery status unavailable";
            emailDeliveryCopy.textContent = "Open any booking to review its email delivery history and preview the message.";
        }
    }

    function statusLabel(status) {
        return {
            pending: "Awaiting email",
            confirmed: "Confirmed",
            arrived: "Arrived",
            seated: "Seated",
            completed: "Completed",
            cancelled: "Cancelled",
            no_show: "No-show",
            expired: "Expired"
        }[status] || status;
    }

    function sourceLabel(source) {
        return {
            web: "Website",
            phone: "Telephone",
            walk_in: "Walk-in",
            admin: "Admin"
        }[source] || source;
    }

    function waitlistStatusLabel(status) {
        return {
            waiting: "Waiting",
            notified: "Notified",
            booked: "Booked",
            closed: "Closed"
        }[status] || status;
    }

    function eventLabel(event) {
        return {
            booking_created: "Booking created",
            call_confirmed: "Confirmed by phone",
            call_confirmation_cleared: "Phone confirmation cleared",
            customer_confirmed: "Customer confirmed online",
            customer_amended: "Customer changed booking",
            booking_amended: "Admin changed booking",
            booking_cancelled: "Booking cancelled",
            status_changed: "Status changed",
            reminder_prepared: "Reminder prepared",
            confirmation_resent: "Confirmation resent"
        }[event.kind] || event.kind.replace(/_/g, " ");
    }

    function option(value, current, label) {
        return '<option value="' + value + '"' + (value === current ? " selected" : "") + ">" +
            escapeHtml(label) + "</option>";
    }

    function quickActionButtons(booking) {
        var actions = [];
        if (booking.status === "confirmed") {
            actions = [["arrived", "Arrived"], ["seated", "Seat now"], ["no_show", "No-show"]];
        } else if (booking.status === "arrived") {
            actions = [["seated", "Seated"], ["no_show", "No-show"]];
        } else if (booking.status === "seated") {
            actions = [["completed", "Completed"]];
        }
        if (!actions.length) return "";
        return '<div class="booking-quick-actions" aria-label="Quick service actions">' + actions.map(function (action) {
            return '<button type="button" data-quick-status="' + action[0] + '">' + escapeHtml(action[1]) + "</button>";
        }).join("") + "</div>";
    }

    function guestHistoryHtml(history) {
        if (!history || !history.previousBookingCount) {
            return '<div class="booking-guest-history"><strong>Guest history</strong><p>First booking found for these contact details.</p></div>';
        }
        var items = history.bookings.slice(0, 6).map(function (item) {
            return '<li><span>' + escapeHtml(formatShortDate(item.date)) + " · " + escapeHtml(item.timeLabel) +
                " · " + item.partySize + (item.partySize === 1 ? " guest" : " guests") +
                '</span><small>' + escapeHtml(statusLabel(item.status)) +
                (item.requests ? " · " + escapeHtml(item.requests) : "") + "</small></li>";
        }).join("");
        return '<div class="booking-guest-history"><strong>Guest history</strong>' +
            '<p>' + history.previousBookingCount + " other booking" + (history.previousBookingCount === 1 ? "" : "s") +
            " · " + history.completedVisitCount + " recorded visit" + (history.completedVisitCount === 1 ? "" : "s") +
            (history.noShowCount ? " · " + history.noShowCount + " no-show" : "") + "</p><ul>" + items + "</ul></div>";
    }

    function bookingCard(booking) {
        var emailLinks = booking.emails.map(function (email) {
            return '<a href="' + escapeHtml(email.previewUrl) + '" target="_blank" rel="noopener">' +
                escapeHtml(email.kind.replace(/_/g, " ")) + "</a>";
        }).join("");
        var contact = [
            booking.phone ? '<a href="tel:' + escapeHtml(booking.phone) + '" aria-label="Call ' +
                escapeHtml(booking.name) + ' on ' + escapeHtml(booking.phone) + '">☎ ' +
                escapeHtml(booking.phone) + "</a>" : "",
            booking.email ? '<a href="mailto:' + escapeHtml(booking.email) + '">' + escapeHtml(booking.email) + "</a>" : "",
            booking.requests ? "<span>Request: " + escapeHtml(booking.requests) + "</span>" : ""
        ].filter(Boolean).join("");
        var confirmationMeta = booking.customerConfirmedAt
            ? "Customer confirmed " + formatDateTime(booking.customerConfirmedAt)
            : (booking.callConfirmedAt
                ? "Phone confirmation recorded " + formatDateTime(booking.callConfirmedAt)
                : "No confirmation recorded");
        var auditItems = (booking.auditEvents || []).map(function (event) {
            return '<li><span>' + escapeHtml(eventLabel(event)) +
                (event.details ? '<em>' + escapeHtml(event.details) + "</em>" : "") +
                '</span><small>' + escapeHtml(event.actor) + " · " + escapeHtml(formatDateTime(event.createdAt)) +
                "</small></li>";
        }).join("");
        var attentionKeys = Object.keys(booking.attention || {}).filter(function (key) {
            return booking.attention[key];
        });
        var attentionBadges = attentionKeys.map(function (key) {
            return '<span class="booking-attention-badge attention-' + key + '">' + escapeHtml({
                unconfirmed: "Unconfirmed",
                emailFailed: "Email failed",
                largeParty: "Large party",
                specialRequest: "Special request"
            }[key]) + "</span>";
        }).join("");
        var searchText = [booking.name, booking.phone, booking.email, booking.reference, booking.requests,
            booking.internalNotes, booking.area, booking.tableLabel].join(" ").toLowerCase();
        var returningBadge = booking.guestHistory && booking.guestHistory.previousBookingCount
            ? '<span class="returning-guest-badge">Returning guest · ' + booking.guestHistory.previousBookingCount + " previous</span>"
            : "";

        return '<article class="booking-admin-card status-' + escapeHtml(booking.status) + '" data-booking-id="' + escapeHtml(booking.id) +
            '" data-status="' + escapeHtml(booking.status) + '" data-search="' + escapeHtml(searchText) +
            '" data-attention="' + escapeHtml(attentionKeys.join(" ")) + '">' +
            '<div class="booking-admin-summary">' +
                '<div class="booking-admin-time">' + escapeHtml(booking.timeLabel) + "</div>" +
                '<div class="booking-admin-guest"><strong>' + escapeHtml(booking.name) + '</strong><span>' +
                    booking.partySize + (booking.partySize === 1 ? " guest" : " guests") + " · " +
                    escapeHtml(sourceLabel(booking.source)) + " · " + escapeHtml(booking.reference) +
                    " · " + escapeHtml(booking.area) + (booking.tableLabel ? " / " + escapeHtml(booking.tableLabel) : "") +
                "</span></div>" +
                '<span class="booking-status">' + escapeHtml(statusLabel(booking.status)) + "</span>" +
            "</div>" +
            '<div class="booking-card-badges">' + returningBadge + attentionBadges + "</div>" +
            (contact ? '<div class="booking-admin-contact">' + contact + "</div>" : "") +
            '<div class="booking-call-confirmation">' +
                '<label><input type="checkbox" data-call-confirmed' + (booking.callConfirmedAt ? " checked" : "") +
                    (booking.status === "cancelled" ? " disabled" : "") + '><span>Called to confirm</span></label>' +
                '<span class="booking-call-meta">' + escapeHtml(confirmationMeta) + "</span>" +
            "</div>" +
            quickActionButtons(booking) +
            '<div class="booking-print-details"><span>' + escapeHtml(booking.area) +
                (booking.tableLabel ? " · " + escapeHtml(booking.tableLabel) : "") + "</span>" +
                (booking.internalNotes ? "<span>Internal: " + escapeHtml(booking.internalNotes) + "</span>" : "") + "</div>" +
            "<details><summary>View and edit booking</summary>" +
                guestHistoryHtml(booking.guestHistory) +
                (auditItems ? '<div class="booking-audit"><strong>Booking audit</strong><ul>' + auditItems + "</ul></div>" : "") +
                '<form class="booking-edit-form">' +
                    '<div class="booking-edit-grid">' +
                        '<label>Date<input type="date" name="date" value="' + escapeHtml(booking.date) + '" required></label>' +
                        '<label>Time<input type="time" name="time" step="1800" value="' + escapeHtml(booking.time) + '" required></label>' +
                        '<label>Guests<select name="partySize">' +
                            Array.from({ length: diary.config.maxAdminPartySize }, function (_value, index) {
                                var number = index + 1;
                                return option(String(number), String(booking.partySize), String(number));
                            }).join("") +
                        "</select></label>" +
                    "</div>" +
                    '<div class="booking-edit-grid">' +
                        '<label>Name<input type="text" name="name" value="' + escapeHtml(booking.name) + '" required></label>' +
                        '<label>Email<input type="email" name="email" value="' + escapeHtml(booking.email) + '"></label>' +
                        '<label>Phone<input type="tel" name="phone" value="' + escapeHtml(booking.phone) + '"></label>' +
                    "</div>" +
                    '<div class="booking-edit-grid">' +
                        '<label>Area<select name="area">' + ["Restaurant", "Bar", "Outside"].map(function (value) {
                            return option(value, booking.area, value);
                        }).join("") + "</select></label>" +
                        '<label>Table<input type="text" name="tableLabel" value="' + escapeHtml(booking.tableLabel) + '" placeholder="e.g. Table 6"></label>' +
                    "</div>" +
                    '<label>Guest requests<textarea name="requests" rows="2">' + escapeHtml(booking.requests) + "</textarea></label>" +
                    '<label>Internal notes<textarea name="internalNotes" rows="2">' + escapeHtml(booking.internalNotes) + "</textarea></label>" +
                    '<div class="booking-edit-grid">' +
                        '<label>Status<select name="status">' +
                            ["pending","confirmed","arrived","seated","completed","cancelled","no_show","expired"].map(function (value) {
                                return option(value, booking.status, statusLabel(value));
                            }).join("") +
                        "</select></label>" +
                        '<label>Source<select name="source">' +
                            ["web","phone","walk_in","admin"].map(function (value) {
                                return option(value, booking.source, sourceLabel(value));
                            }).join("") +
                        "</select></label>" +
                    "</div>" +
                    '<label class="admin-checkbox"><input type="checkbox" name="overrideCapacity"><span>Override capacity</span></label>' +
                    '<div class="booking-edit-actions">' +
                        '<button type="submit" class="admin-button">Save changes</button>' +
                        (booking.email ? '<button type="button" class="admin-button admin-button-secondary" data-resend>Resend confirmation</button>' : "") +
                        (booking.email && ["confirmed","arrived","seated"].includes(booking.status)
                            ? '<button type="button" class="admin-button admin-button-secondary" data-reminder>Prepare reminder</button>' : "") +
                        '<div class="booking-email-links">' + emailLinks + "</div>" +
                    "</div>" +
                "</form>" +
            "</details>" +
        "</article>";
    }

    function applyFilters() {
        var query = searchInput.value.trim().toLowerCase();
        var status = statusFilter.value;
        var visible = 0;
        bookingList.querySelectorAll(".booking-admin-card").forEach(function (card) {
            var matches = (!query || card.dataset.search.includes(query)) &&
                (!status || card.dataset.status === status) &&
                (!attentionFilter || card.dataset.attention.split(" ").includes(attentionFilter));
            card.hidden = !matches;
            if (matches) visible += 1;
        });
        filterEmpty.hidden = visible > 0 || !diary || !diary.bookings.length;
        attentionList.querySelectorAll("[data-attention-filter]").forEach(function (button) {
            button.classList.toggle("is-active", button.dataset.attentionFilter === attentionFilter);
        });
    }

    function wireBookingCards() {
        bookingList.querySelectorAll("[data-call-confirmed]").forEach(function (checkbox) {
            var card = checkbox.closest("[data-booking-id]");
            var bookingId = card.dataset.bookingId;
            checkbox.addEventListener("change", async function () {
                var confirmed = checkbox.checked;
                checkbox.disabled = true;
                try {
                    await api("/api/admin/bookings/" + encodeURIComponent(bookingId) + "/call-confirmation", {
                        method: "PATCH",
                        body: JSON.stringify({ confirmed: confirmed })
                    });
                    showAlert(confirmed ? "Confirmation call recorded." : "Confirmation call record cleared.", true);
                    await loadDiary();
                } catch (error) {
                    checkbox.checked = !confirmed;
                    checkbox.disabled = false;
                    showAlert(error.message, false);
                }
            });
        });

        bookingList.querySelectorAll("[data-quick-status]").forEach(function (button) {
            var bookingId = button.closest("[data-booking-id]").dataset.bookingId;
            button.addEventListener("click", async function () {
                button.disabled = true;
                try {
                    await api("/api/admin/bookings/" + encodeURIComponent(bookingId), {
                        method: "PATCH",
                        body: JSON.stringify({ status: button.dataset.quickStatus, overrideCapacity: true })
                    });
                    showAlert("Booking marked " + statusLabel(button.dataset.quickStatus).toLowerCase() + ".", true);
                    await refreshAll();
                } catch (error) {
                    button.disabled = false;
                    showAlert(error.message, false);
                }
            });
        });

        bookingList.querySelectorAll(".booking-edit-form").forEach(function (form) {
            var card = form.closest("[data-booking-id]");
            var bookingId = card.dataset.bookingId;
            form.addEventListener("submit", async function (event) {
                event.preventDefault();
                var submit = form.querySelector('button[type="submit"]');
                submit.disabled = true;
                try {
                    await api("/api/admin/bookings/" + encodeURIComponent(bookingId), {
                        method: "PATCH",
                        body: JSON.stringify({
                            date: form.elements.date.value,
                            time: form.elements.time.value,
                            partySize: Number(form.elements.partySize.value),
                            name: form.elements.name.value,
                            email: form.elements.email.value,
                            phone: form.elements.phone.value,
                            area: form.elements.area.value,
                            tableLabel: form.elements.tableLabel.value,
                            requests: form.elements.requests.value,
                            internalNotes: form.elements.internalNotes.value,
                            status: form.elements.status.value,
                            source: form.elements.source.value,
                            overrideCapacity: form.elements.overrideCapacity.checked
                        })
                    });
                    showAlert("Booking updated.", true);
                    await refreshAll();
                } catch (error) {
                    showAlert(error.message, false);
                } finally {
                    submit.disabled = false;
                }
            });

            var resend = form.querySelector("[data-resend]");
            if (resend) {
                resend.addEventListener("click", async function () {
                    resend.disabled = true;
                    try {
                        await api("/api/admin/bookings/" + encodeURIComponent(bookingId) + "/resend", {
                            method: "POST",
                            body: "{}"
                        });
                        showAlert("A new confirmation email has been prepared.", true);
                        await loadDiary();
                    } catch (error) {
                        resend.disabled = false;
                        showAlert(error.message, false);
                    }
                });
            }

            var reminder = form.querySelector("[data-reminder]");
            if (reminder) {
                reminder.addEventListener("click", async function () {
                    reminder.disabled = true;
                    try {
                        await api("/api/admin/bookings/" + encodeURIComponent(bookingId) + "/reminder", {
                            method: "POST",
                            body: "{}"
                        });
                        showAlert("Reminder email prepared.", true);
                        await loadDiary();
                    } catch (error) {
                        reminder.disabled = false;
                        showAlert(error.message, false);
                    }
                });
            }
        });
    }

    function renderAttention() {
        var items = [
            ["unconfirmed", "Unconfirmed"],
            ["emailFailed", "Email failures"],
            ["largeParty", "Large parties"],
            ["specialRequest", "Special requests"],
            ["waiting", "Waiting list"]
        ];
        var total = items.reduce(function (sum, item) { return sum + Number(diary.attention[item[0]] || 0); }, 0);
        if (!total) {
            attentionList.innerHTML = '<span class="admin-all-clear">✓ Nothing needs attention</span>';
            return;
        }
        attentionList.innerHTML = items.filter(function (item) {
            return diary.attention[item[0]] > 0;
        }).map(function (item) {
            return '<button type="button" data-attention-filter="' + item[0] + '"><strong>' +
                diary.attention[item[0]] + "</strong><span>" + escapeHtml(item[1]) + "</span></button>";
        }).join("");
        attentionList.querySelectorAll("[data-attention-filter]").forEach(function (button) {
            button.addEventListener("click", function () {
                if (button.dataset.attentionFilter === "waiting") {
                    document.querySelector(".admin-waitlist-section").scrollIntoView({ behavior: "smooth", block: "start" });
                    return;
                }
                attentionFilter = attentionFilter === button.dataset.attentionFilter ? "" : button.dataset.attentionFilter;
                applyFilters();
                bookingList.scrollIntoView({ behavior: "smooth", block: "start" });
            });
        });
    }

    function waitlistCard(entry) {
        var emailLinks = entry.emails.map(function (email) {
            return '<a href="' + escapeHtml(email.previewUrl) + '" target="_blank" rel="noopener">' +
                escapeHtml(email.kind.replace(/_/g, " ")) + "</a>";
        }).join("");
        var actions = "";
        if (["waiting", "notified"].includes(entry.status)) {
            actions += '<button type="button" data-waitlist-book="' + entry.id + '">Add as booking</button>';
            if (entry.status === "waiting") {
                actions += '<button type="button" data-waitlist-notify="' + entry.id + '">Notify if available</button>';
            }
            actions += '<button type="button" data-waitlist-close="' + entry.id + '">Close</button>';
        }
        return '<article class="admin-waitlist-card status-' + entry.status + '" data-waitlist-id="' + entry.id + '">' +
            '<div><strong>' + escapeHtml(entry.timeLabel) + " · " + escapeHtml(entry.name) + '</strong><span>' +
                entry.partySize + (entry.partySize === 1 ? " guest" : " guests") + " · " +
                escapeHtml(waitlistStatusLabel(entry.status)) + "</span></div>" +
            '<div class="admin-waitlist-contact"><a href="tel:' + escapeHtml(entry.phone) + '">☎ ' + escapeHtml(entry.phone) +
                '</a><a href="mailto:' + escapeHtml(entry.email) + '">' + escapeHtml(entry.email) + "</a></div>" +
            (entry.notes ? '<p>' + escapeHtml(entry.notes) + "</p>" : "") +
            '<div class="admin-waitlist-actions">' + actions + emailLinks + "</div>" +
        "</article>";
    }

    function renderWaitlist() {
        document.querySelector("[data-waitlist-count]").textContent = diary.waitlist.length
            ? diary.waitlist.length + " entr" + (diary.waitlist.length === 1 ? "y" : "ies")
            : "";
        if (!diary.waitlist.length) {
            waitlistList.innerHTML = '<p class="admin-empty">No one is waiting for this date.</p>';
            return;
        }
        waitlistList.innerHTML = diary.waitlist.map(waitlistCard).join("");

        waitlistList.querySelectorAll("[data-waitlist-notify]").forEach(function (button) {
            button.addEventListener("click", async function () {
                button.disabled = true;
                try {
                    await api("/api/admin/waitlist/" + encodeURIComponent(button.dataset.waitlistNotify) + "/notify", {
                        method: "POST",
                        body: "{}"
                    });
                    showAlert("Availability email prepared for the waiting customer.", true);
                    await loadDiary();
                } catch (error) {
                    button.disabled = false;
                    showAlert(error.message, false);
                }
            });
        });

        waitlistList.querySelectorAll("[data-waitlist-close]").forEach(function (button) {
            button.addEventListener("click", async function () {
                try {
                    await api("/api/admin/waitlist/" + encodeURIComponent(button.dataset.waitlistClose), {
                        method: "PATCH",
                        body: JSON.stringify({ status: "closed" })
                    });
                    showAlert("Waiting-list entry closed.", true);
                    await loadDiary();
                } catch (error) {
                    showAlert(error.message, false);
                }
            });
        });

        waitlistList.querySelectorAll("[data-waitlist-book]").forEach(function (button) {
            button.addEventListener("click", function () {
                var entry = diary.waitlist.find(function (item) { return item.id === button.dataset.waitlistBook; });
                if (!entry) return;
                addForm.elements.waitlistId.value = entry.id;
                addForm.elements.date.value = entry.date;
                addForm.elements.time.value = entry.time;
                addForm.elements.partySize.value = String(entry.partySize);
                addForm.elements.name.value = entry.name;
                addForm.elements.email.value = entry.email;
                addForm.elements.phone.value = entry.phone;
                addForm.elements.requests.value = entry.notes;
                addForm.scrollIntoView({ behavior: "smooth", block: "start" });
                addForm.elements.name.focus();
                showAlert("Waiting-list details copied into the booking form.", true);
            });
        });
    }

    function renderDiary() {
        document.querySelector('[data-stat="bookings"]').textContent = diary.summary.bookingCount;
        document.querySelector('[data-stat="covers"]').textContent = diary.summary.covers;
        document.querySelector('[data-stat="peak"]').textContent = diary.summary.peakCovers;
        document.querySelector('[data-stat="remaining"]').textContent = diary.summary.peakRemaining;
        document.querySelector("[data-diary-heading]").textContent = formatDate(diary.date);
        document.querySelector("[data-print-date]").textContent = formatDate(diary.date) + " · Service sheet";
        document.querySelector("[data-service-hours]").textContent = diary.service
            ? diary.service.start + "–" + diary.service.end
            : "No regular service";

        renderAttention();
        if (!diary.bookings.length) {
            bookingList.innerHTML = '<div class="admin-empty">No bookings in the diary for this date.</div>';
        } else {
            bookingList.innerHTML = diary.bookings.map(bookingCard).join("");
            wireBookingCards();
        }
        applyFilters();
        renderWaitlist();

        var blockTime = blockForm.elements.time;
        blockTime.innerHTML = '<option value="*">The whole day</option>' +
            diary.slots.map(function (time) {
                return '<option value="' + time + '">' + time + "</option>";
            }).join("");

        if (!diary.blocks.length) {
            blockList.innerHTML = '<p class="admin-empty">No online booking closures.</p>';
        } else {
            blockList.innerHTML = diary.blocks.map(function (block) {
                return '<div class="admin-block"><span><strong>' +
                    escapeHtml(block.booking_time === "*" ? "Whole day" : block.booking_time) +
                    "</strong><br>" + escapeHtml(block.reason) +
                    '</span><button type="button" data-remove-block="' + escapeHtml(block.id) + '">Reopen</button></div>';
            }).join("");
            blockList.querySelectorAll("[data-remove-block]").forEach(function (button) {
                button.addEventListener("click", async function () {
                    try {
                        await api("/api/admin/blocks/" + encodeURIComponent(button.dataset.removeBlock), {
                            method: "DELETE"
                        });
                        showAlert("Online availability reopened.", true);
                        await refreshAll();
                    } catch (error) {
                        showAlert(error.message, false);
                    }
                });
            });
        }
    }

    function recentBookingStatus(status) {
        return {
            pending: "Awaiting email",
            confirmed: "Confirmed",
            arrived: "Arrived",
            seated: "Seated",
            completed: "Completed",
            cancelled: "Cancelled",
            no_show: "No-show",
            expired: "Expired"
        }[status] || status;
    }

    function renderRecentBookings(bookings) {
        if (!bookings.length) {
            recentBookingsList.innerHTML = '<div class="admin-empty">No booking activity yet.</div>';
            return;
        }
        recentBookingsList.innerHTML = bookings.map(function (booking) {
            var source = {
                web: "Online booking",
                phone: "Telephone booking",
                walk_in: "Walk-in booking",
                admin: "Admin booking"
            }[booking.source] || "Admin booking";
            return '<button type="button" class="admin-recent-booking is-' + escapeHtml(booking.status) + '" data-recent-booking-date="' + escapeHtml(booking.date) + '">' +
                '<span class="admin-recent-booking-main"><strong>' + escapeHtml(booking.name) + '</strong>' +
                '<span>' + Number(booking.partySize) + (Number(booking.partySize) === 1 ? " guest" : " guests") + ' · ' + escapeHtml(formatShortDate(booking.date)) + ' at ' + escapeHtml(booking.timeLabel) + '</span></span>' +
                '<span class="admin-recent-booking-meta"><strong>' + escapeHtml(recentBookingStatus(booking.status)) + '</strong>' +
                '<span>' + escapeHtml(source) + ' · ' + escapeHtml(booking.reference) + '</span></span>' +
            '</button>';
        }).join("");
        recentBookingsList.querySelectorAll("[data-recent-booking-date]").forEach(function (button) {
            button.addEventListener("click", function () {
                dateInput.value = button.dataset.recentBookingDate;
                syncDate();
                document.querySelector(".admin-stats").scrollIntoView({ behavior: "smooth", block: "start" });
            });
        });
    }

    async function loadRecentBookings(announceNew) {
        try {
            var result = await api("/api/admin/recent-bookings?limit=6", { method: "GET" });
            var bookings = result.bookings || [];
            var newBookings = recentBookingsLoaded
                ? bookings.filter(function (booking) { return !recentBookingIds.has(booking.id); })
                : [];
            recentBookingIds = new Set(bookings.map(function (booking) { return booking.id; }));
            recentBookingsLoaded = true;
            renderRecentBookings(bookings);
            if (announceNew && newBookings.length) {
                var newest = newBookings[0];
                showAlert("New booking: " + newest.name + " · " + newest.partySize +
                    (Number(newest.partySize) === 1 ? " guest · " : " guests · ") +
                    formatShortDate(newest.date) + " at " + newest.timeLabel + ".", true);
                await loadCalendar();
                if (newBookings.some(function (booking) { return booking.date === dateInput.value; })) {
                    await loadDiary();
                }
            }
        } catch (error) {
            if (!recentBookingsLoaded) {
                recentBookingsList.innerHTML = '<div class="admin-empty">Recent booking activity could not be loaded.</div>';
                showAlert(error.message, false);
            }
        }
    }

    function renderCalendar() {
        document.querySelector("[data-calendar-heading]").textContent = calendar.monthLabel;
        var today = isoDate(new Date());
        var html = "";
        for (var blank = 0; blank < calendar.firstWeekday; blank += 1) {
            html += '<div class="admin-calendar-blank" aria-hidden="true"></div>';
        }
        html += calendar.days.map(function (day) {
            var classes = ["admin-calendar-day"];
            if (day.date === dateInput.value) classes.push("is-selected");
            if (day.date === today) classes.push("is-today");
            if (!day.isRegularServiceDay || day.wholeDayClosed) classes.push("is-closed");
            if (day.capacityPercent >= 100) classes.push("is-full");
            else if (day.capacityPercent >= 60) classes.push("is-busy");
            if (day.recordCount && !day.bookingCount) classes.push("is-history");

            var closure = day.wholeDayClosed
                ? "Online closed"
                : (!day.isRegularServiceDay ? "No service" : (day.blockedSlotCount ? day.blockedSlotCount + " slot closed" : ""));
            var historyParts = [];
            if (day.expiredCount) historyParts.push(day.expiredCount + " expired");
            if (day.cancellationCount) historyParts.push(day.cancellationCount + " cancelled");
            if (day.completedCount) historyParts.push(day.completedCount + " completed");
            if (day.noShowCount) historyParts.push(day.noShowCount + " no-show");
            var bookingSummary = day.bookingCount
                ? '<span class="calendar-day-bookings">' + day.bookingCount + (day.bookingCount === 1 ? " booking" : " bookings") + '</span>' +
                  '<span class="calendar-day-covers">' + day.totalCovers + (day.totalCovers === 1 ? " cover" : " covers") + '</span>' +
                  '<div class="calendar-day-capacity"><span style="width:' + day.capacityPercent + '%"></span></div>' +
                  '<span class="calendar-day-capacity-label">Peak ' + day.peakCovers + "/" + calendar.maxCovers + "</span>" +
                  (day.inactiveCount ? '<span class="calendar-day-history">+ ' + day.inactiveCount + ' previous</span>' : "")
                : day.recordCount
                    ? '<span class="calendar-day-bookings calendar-day-bookings-history">' + day.recordCount + (day.recordCount === 1 ? " booking record" : " booking records") + '</span>' +
                      '<span class="calendar-day-history">' + escapeHtml(historyParts.join(" · ") || day.inactiveCount + " inactive") + '</span>'
                    : '<span class="calendar-day-empty">No bookings</span>';
            if (day.waitlistCount) {
                bookingSummary += '<span class="calendar-day-waitlist">' + day.waitlistCount + " waiting</span>";
            }

            return '<button type="button" class="' + classes.join(" ") + '" data-calendar-date="' + day.date + '" aria-label="Open diary for ' + escapeHtml(formatDate(day.date)) + '">' +
                '<span class="calendar-day-top"><span class="calendar-day-number">' + day.dayNumber + "</span>" +
                (closure ? '<span class="calendar-day-closure">' + escapeHtml(closure) + "</span>" : "") + "</span>" +
                bookingSummary +
            "</button>";
        }).join("");
        calendarGrid.innerHTML = html;
        calendarGrid.querySelectorAll("[data-calendar-date]").forEach(function (button) {
            button.addEventListener("click", function () {
                dateInput.value = button.dataset.calendarDate;
                syncDate();
                document.querySelector(".admin-stats").scrollIntoView({ behavior: "smooth", block: "start" });
            });
        });
    }

    async function loadCalendar() {
        calendarGrid.innerHTML = '<div class="admin-loading">Loading calendar…</div>';
        try {
            calendar = await api("/api/admin/calendar?month=" + encodeURIComponent(calendarMonth), {
                method: "GET"
            });
            renderCalendar();
        } catch (error) {
            calendarGrid.innerHTML = '<div class="admin-empty">The calendar could not be loaded.</div>';
            showAlert(error.message, false);
        }
    }

    async function loadDiary() {
        bookingList.innerHTML = '<div class="admin-loading">Loading bookings…</div>';
        try {
            diary = await api("/api/admin/diary?date=" + encodeURIComponent(dateInput.value), {
                method: "GET"
            });
            renderDiary();
        } catch (error) {
            bookingList.innerHTML = '<div class="admin-empty">The diary could not be loaded.</div>';
            showAlert(error.message, false);
        }
    }

    async function refreshAll() {
        await Promise.all([loadDiary(), loadCalendar(), loadRecentBookings(false)]);
    }

    function syncDate() {
        var url = new URL(window.location.href);
        url.searchParams.set("date", dateInput.value);
        window.history.replaceState({}, "", url);
        addForm.elements.date.value = dateInput.value;
        attentionFilter = "";
        searchInput.value = "";
        statusFilter.value = "";
        var selectedMonth = dateInput.value.slice(0, 7);
        if (calendarMonth !== selectedMonth) {
            calendarMonth = selectedMonth;
            loadCalendar();
        } else if (calendar) {
            renderCalendar();
        }
        loadDiary();
    }

    var requestedDate = new URLSearchParams(window.location.search).get("date");
    dateInput.value = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate || "")
        ? requestedDate
        : isoDate(new Date());
    dateInput.addEventListener("change", syncDate);
    document.querySelector("[data-date-previous]").addEventListener("click", function () { moveDate(-1); });
    document.querySelector("[data-date-next]").addEventListener("click", function () { moveDate(1); });
    document.querySelector("[data-date-today]").addEventListener("click", function () {
        dateInput.value = isoDate(new Date());
        syncDate();
    });
    document.querySelector("[data-month-previous]").addEventListener("click", function () { moveMonth(-1); });
    document.querySelector("[data-month-next]").addEventListener("click", function () { moveMonth(1); });
    document.querySelector("[data-month-current]").addEventListener("click", function () {
        calendarMonth = isoDate(new Date()).slice(0, 7);
        loadCalendar();
    });
    searchInput.addEventListener("input", applyFilters);
    statusFilter.addEventListener("change", applyFilters);
    document.querySelector("[data-clear-filters]").addEventListener("click", function () {
        searchInput.value = "";
        statusFilter.value = "";
        attentionFilter = "";
        applyFilters();
    });
    document.querySelector("[data-print-diary]").addEventListener("click", function () {
        window.print();
    });
    document.querySelector("[data-run-reminders]").addEventListener("click", async function (event) {
        var button = event.currentTarget;
        button.disabled = true;
        try {
            var result = await api("/api/admin/reminders/run", { method: "POST", body: "{}" });
            showAlert(result.preparedCount
                ? result.preparedCount + " due reminder" + (result.preparedCount === 1 ? "" : "s") + " prepared."
                : "No reminders are due right now.", true);
            await loadDiary();
        } catch (error) {
            showAlert(error.message, false);
        } finally {
            button.disabled = false;
        }
    });

    masterToggle.addEventListener("change", async function () {
        var enabled = masterToggle.checked;
        masterToggle.disabled = true;
        try {
            var state = await api("/api/admin/booking-settings", {
                method: "PATCH",
                body: JSON.stringify({ enabled: enabled })
            });
            renderBookingSettings(state);
            showAlert(enabled
                ? "Online bookings are now enabled across the website."
                : "Online bookings are now disabled across the website.", true);
        } catch (error) {
            masterToggle.checked = !enabled;
            masterToggle.disabled = false;
            showAlert(error.message, false);
        }
    });

    capacityForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        capacityInput.disabled = true;
        capacitySubmit.disabled = true;
        try {
            var state = await api("/api/admin/booking-settings", {
                method: "PATCH",
                body: JSON.stringify({ maxCovers: Number(capacityInput.value) })
            });
            renderBookingSettings(state);
            showAlert("Peak cover capacity is now " + state.maxCovers + ".", true);
            await refreshAll();
        } catch (error) {
            capacityInput.disabled = false;
            capacitySubmit.disabled = false;
            showAlert(error.message, false);
        }
    });

    arrivalCapacityForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        arrivalCapacityInput.disabled = true;
        arrivalCapacitySubmit.disabled = true;
        try {
            var state = await api("/api/admin/booking-settings", {
                method: "PATCH",
                body: JSON.stringify({ maxArrivalCovers: Number(arrivalCapacityInput.value) })
            });
            renderBookingSettings(state);
            showAlert("Half-hour arrival capacity is now " + state.maxArrivalCovers + ".", true);
            await refreshAll();
        } catch (error) {
            arrivalCapacityInput.disabled = false;
            arrivalCapacitySubmit.disabled = false;
            showAlert(error.message, false);
        }
    });

    serviceHoursForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        var submit = serviceHoursForm.querySelector('button[type="submit"]');
        var serviceHours = Array.from(serviceHoursList.querySelectorAll("[data-service-day]")).map(function (row) {
            return {
                weekday: Number(row.dataset.serviceDay),
                enabled: row.querySelector("[data-service-enabled]").checked,
                start: row.querySelector("[data-service-start]").value,
                end: row.querySelector("[data-service-end]").value
            };
        });
        submit.disabled = true;
        try {
            var state = await api("/api/admin/booking-settings", {
                method: "PATCH",
                body: JSON.stringify({ serviceHours: serviceHours })
            });
            renderBookingSettings(state);
            showAlert("Weekly food table booking times saved.", true);
            await refreshAll();
        } catch (error) {
            showAlert(error.message, false);
        } finally {
            submit.disabled = false;
        }
    });

    addForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        var submit = addForm.querySelector('button[type="submit"]');
        submit.disabled = true;
        var waitlistId = addForm.elements.waitlistId.value;
        try {
            await api("/api/admin/bookings", {
                method: "POST",
                headers: { "Idempotency-Key": adminRequestId },
                body: JSON.stringify({
                    date: addForm.elements.date.value,
                    time: addForm.elements.time.value,
                    partySize: Number(addForm.elements.partySize.value),
                    source: addForm.elements.source.value,
                    area: addForm.elements.area.value,
                    tableLabel: addForm.elements.tableLabel.value,
                    name: addForm.elements.name.value,
                    email: addForm.elements.email.value,
                    phone: addForm.elements.phone.value,
                    requests: addForm.elements.requests.value,
                    internalNotes: addForm.elements.internalNotes.value,
                    overrideCapacity: addForm.elements.overrideCapacity.checked
                })
            });
            if (waitlistId) {
                await api("/api/admin/waitlist/" + encodeURIComponent(waitlistId), {
                    method: "PATCH",
                    body: JSON.stringify({ status: "booked" })
                });
            }
            showAlert(waitlistId ? "Waiting-list guest added as a confirmed booking." : "Booking added to the diary.", true);
            adminRequestId = window.crypto && window.crypto.randomUUID
                ? window.crypto.randomUUID()
                : String(Date.now()) + "-admin-" + Math.random().toString(36).slice(2);
            var retainedDate = addForm.elements.date.value;
            addForm.reset();
            addForm.elements.date.value = retainedDate;
            await refreshAll();
        } catch (error) {
            showAlert(error.message, false);
        } finally {
            submit.disabled = false;
        }
    });

    blockForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        var submit = blockForm.querySelector('button[type="submit"]');
        submit.disabled = true;
        try {
            await api("/api/admin/blocks", {
                method: "POST",
                body: JSON.stringify({
                    date: dateInput.value,
                    time: blockForm.elements.time.value,
                    reason: blockForm.elements.reason.value
                })
            });
            blockForm.reset();
            showAlert("Online availability closed.", true);
            await refreshAll();
        } catch (error) {
            showAlert(error.message, false);
        } finally {
            submit.disabled = false;
        }
    });

    async function initialiseAdmin() {
        var session = await api("/api/admin/session", { method: "GET" });
        var actor = document.querySelector("[data-admin-actor]");
        if (actor) actor.textContent = session.actor;
        await Promise.all([loadBookingSettings(), loadEmailDelivery(), loadRecentBookings(false)]);
        syncDate();
        window.setInterval(function () {
            if (!document.hidden) loadRecentBookings(true);
        }, 60000);
    }

    var logout = document.querySelector("[data-admin-logout]");
    if (logout) {
        logout.addEventListener("click", async function () {
            try {
                await api("/api/admin/session", { method: "DELETE", body: "{}" });
            } finally {
                try {
                    await window.bookingIdentity.logout();
                } catch (_error) {}
                window.location.href = "/admin/bookings/login/";
            }
        });
    }

    initialiseAdmin().catch(function (error) {
        showAlert(error.message, false);
    });
})();
