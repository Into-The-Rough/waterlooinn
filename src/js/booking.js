(function () {
    "use strict";

    var widgets = document.querySelectorAll("[data-booking-widget]");
    if (!widgets.length) return;

    function isoDate(date) {
        var year = date.getFullYear();
        var month = String(date.getMonth() + 1).padStart(2, "0");
        var day = String(date.getDate()).padStart(2, "0");
        return year + "-" + month + "-" + day;
    }

    function addDays(date, days) {
        var result = new Date(date);
        result.setDate(result.getDate() + days);
        return result;
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

    function showError(element, message) {
        element.textContent = message;
        element.hidden = false;
    }

    function clearError(element) {
        element.textContent = "";
        element.hidden = true;
    }

    widgets.forEach(function (widget) {
        var form = widget.querySelector(".js-booking-form");
        if (!form) return;

        var dateInput = form.elements.date;
        var partyInput = form.elements.partySize;
        var details = form.querySelector(".booking-details");
        var availability = form.querySelector(".booking-availability");
        var prompt = form.querySelector(".booking-availability-prompt");
        var slots = form.querySelector(".booking-slots");
        var selection = form.querySelector(".booking-selection");
        var errorBox = form.querySelector(".booking-error");
        var submit = form.querySelector(".booking-submit");
        var success = widget.querySelector(".booking-success");
        var waitlistOffer = form.querySelector(".booking-waitlist-offer");
        var waitlistOpen = form.querySelector(".js-open-waitlist");
        var waitlistPanel = form.querySelector(".booking-waitlist-panel");
        var waitlistJoin = form.querySelector(".js-join-waitlist");
        var waitlistError = form.querySelector(".booking-waitlist-error");
        var waitlistSuccess = form.querySelector(".booking-waitlist-success");
        var selectedTime = "";
        var bookingRequestId = window.crypto && window.crypto.randomUUID
            ? window.crypto.randomUUID()
            : String(Date.now()) + "-" + Math.random().toString(36).slice(2);
        var waitlistRequestId = window.crypto && window.crypto.randomUUID
            ? window.crypto.randomUUID()
            : String(Date.now()) + "-waitlist-" + Math.random().toString(36).slice(2);
        var requested = new URLSearchParams(window.location.search);
        var requestedTime = requested.get("time") || "";

        var today = new Date();
        dateInput.min = isoDate(today);
        dateInput.max = isoDate(addDays(today, 90));
        if (!dateInput.value) dateInput.value = /^\d{4}-\d{2}-\d{2}$/.test(requested.get("date") || "")
            ? requested.get("date")
            : isoDate(addDays(today, 1));
        if (/^[1-8]$/.test(requested.get("party") || "")) {
            partyInput.value = requested.get("party");
        }

        function setLoading(isLoading) {
            availability.classList.toggle("is-loading", isLoading);
            if (isLoading) {
                prompt.textContent = "Checking availability…";
                slots.innerHTML = "";
            }
        }

        function resetSelection() {
            selectedTime = "";
            details.disabled = true;
            selection.textContent = "Choose a time above";
        }

        function selectTime(time, label) {
            selectedTime = time;
            details.disabled = false;
            selection.textContent = formatDate(dateInput.value) + " at " + label +
                " for " + partyInput.value + (partyInput.value === "1" ? " guest" : " guests");
            clearError(errorBox);
            var nameInput = form.elements.name;
            if (nameInput && window.innerWidth < 700) {
                nameInput.scrollIntoView({ behavior: "smooth", block: "center" });
            }
        }

        function renderSlots(data) {
            slots.innerHTML = "";
            var openSlots = data.slots.filter(function (slot) { return slot.available; });
            var waitlistSlots = data.slots.filter(function (slot) { return slot.waitlistEligible; });
            waitlistOffer.hidden = !waitlistSlots.length;
            waitlistPanel.hidden = true;
            waitlistSuccess.hidden = true;
            form.elements.waitlistTime.innerHTML = waitlistSlots.map(function (slot) {
                return '<option value="' + slot.time + '">' + slot.label + "</option>";
            }).join("");
            if (!openSlots.length) {
                prompt.textContent = "There are no online tables available for this selection. Try another date or call us on 01298 463248.";
                prompt.classList.add("is-unavailable");
                return;
            }
            prompt.classList.remove("is-unavailable");
            prompt.textContent = "Available arrival times";
            openSlots.forEach(function (slot) {
                var label = document.createElement("label");
                label.className = "booking-slot";
                var input = document.createElement("input");
                input.type = "radio";
                input.name = "time";
                input.value = slot.time;
                input.required = true;
                var span = document.createElement("span");
                span.textContent = slot.label;
                label.appendChild(input);
                label.appendChild(span);
                input.addEventListener("change", function () {
                    slots.querySelectorAll(".booking-slot").forEach(function (item) {
                        item.classList.remove("selected");
                    });
                    label.classList.add("selected");
                    selectTime(slot.time, slot.label);
                });
                slots.appendChild(label);
                if (slot.time === requestedTime) {
                    input.checked = true;
                    label.classList.add("selected");
                    selectTime(slot.time, slot.label);
                }
            });
            requestedTime = "";
        }

        async function loadAvailability() {
            resetSelection();
            slots.innerHTML = "";
            if (!dateInput.value || !partyInput.value) {
                prompt.textContent = "Choose a date and party size to see available times.";
                return;
            }
            setLoading(true);
            try {
                var response = await fetch(
                    "/api/availability?date=" + encodeURIComponent(dateInput.value) +
                    "&partySize=" + encodeURIComponent(partyInput.value),
                    { headers: { "Accept": "application/json" } }
                );
                var data = await response.json();
                if (!response.ok) throw new Error(data.error && data.error.message || "Availability could not be loaded.");
                renderSlots(data);
            } catch (error) {
                prompt.textContent = error.message;
                prompt.classList.add("is-unavailable");
            } finally {
                availability.classList.remove("is-loading");
            }
        }

        dateInput.addEventListener("change", loadAvailability);
        partyInput.addEventListener("change", loadAvailability);

        waitlistOpen.addEventListener("click", function () {
            waitlistPanel.hidden = !waitlistPanel.hidden;
            waitlistError.hidden = true;
            if (!waitlistPanel.hidden) {
                form.elements.waitlistName.value = form.elements.name.value || form.elements.waitlistName.value;
                form.elements.waitlistEmail.value = form.elements.email.value || form.elements.waitlistEmail.value;
                form.elements.waitlistPhone.value = form.elements.phone.value || form.elements.waitlistPhone.value;
                form.elements.waitlistName.focus();
            }
        });

        waitlistJoin.addEventListener("click", async function () {
            waitlistError.hidden = true;
            waitlistSuccess.hidden = true;
            var waitlistPayload = {
                date: dateInput.value,
                time: form.elements.waitlistTime.value,
                partySize: Number(partyInput.value),
                name: form.elements.waitlistName.value,
                email: form.elements.waitlistEmail.value,
                phone: form.elements.waitlistPhone.value,
                notes: form.elements.waitlistNotes.value,
                company: form.elements.company.value
            };
            if (!waitlistPayload.name || !waitlistPayload.email || !waitlistPayload.phone) {
                waitlistError.textContent = "Please enter your name, email and phone number.";
                waitlistError.hidden = false;
                return;
            }
            waitlistJoin.disabled = true;
            waitlistJoin.textContent = "Joining…";
            try {
                var response = await fetch("/api/waitlist", {
                    method: "POST",
                    headers: {
                        "Accept": "application/json",
                        "Content-Type": "application/json",
                        "Idempotency-Key": waitlistRequestId
                    },
                    body: JSON.stringify(waitlistPayload)
                });
                var result = await response.json();
                if (!response.ok) throw new Error(result.error && result.error.message || "The waiting list could not be joined.");
                waitlistSuccess.textContent = "You’re on the waiting list. We’ve prepared an email with the details.";
                waitlistSuccess.hidden = false;
                waitlistJoin.hidden = true;
            } catch (error) {
                waitlistError.textContent = error.message;
                waitlistError.hidden = false;
                waitlistJoin.disabled = false;
                waitlistJoin.textContent = "Join waiting list";
            }
        });

        async function sendBooking(payload) {
            var response = await fetch("/api/bookings", {
                method: "POST",
                headers: {
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                    "Idempotency-Key": bookingRequestId
                },
                body: JSON.stringify(payload)
            });
            var result = await response.json();
            if (!response.ok) {
                var apiError = new Error(result.error && result.error.message || "The booking could not be completed.");
                apiError.code = result.error && result.error.code;
                apiError.field = result.error && result.error.field;
                apiError.suggestion = result.error && result.error.suggestion;
                throw apiError;
            }
            return result;
        }

        form.addEventListener("submit", async function (event) {
            event.preventDefault();
            clearError(errorBox);
            if (!selectedTime) {
                showError(errorBox, "Please choose an available time.");
                return;
            }
            if (!form.checkValidity()) {
                form.reportValidity();
                return;
            }

            var payload = {
                date: dateInput.value,
                time: selectedTime,
                partySize: Number(partyInput.value),
                name: form.elements.name.value,
                email: form.elements.email.value,
                phone: form.elements.phone.value,
                requests: form.elements.requests.value,
                company: form.elements.company.value
            };

            submit.disabled = true;
            submit.textContent = "Confirming…";
            try {
                var result;
                try {
                    result = await sendBooking(payload);
                } catch (error) {
                    if (error.code === "EMAIL_SUGGESTION" && error.suggestion) {
                        var useSuggestion = window.confirm(
                            error.message + "\n\nChoose OK to use " + error.suggestion +
                            ", or Cancel to keep " + payload.email + "."
                        );
                        if (useSuggestion) {
                            payload.email = error.suggestion;
                            form.elements.email.value = error.suggestion;
                        } else {
                            payload.acceptEmailSuggestion = true;
                        }
                        result = await sendBooking(payload);
                    } else {
                        throw error;
                    }
                }

                var booking = result.booking;
                form.hidden = true;
                success.hidden = false;
                if (booking.status === "pending") {
                    success.querySelector(".booking-success-kicker").textContent = "Check your email";
                    success.querySelector("h3").textContent = "Confirm to reserve your table";
                } else {
                    success.querySelector(".booking-success-kicker").textContent = "Booking confirmed";
                    success.querySelector("h3").textContent = "We’ll see you at The Waterloo Inn";
                }
                success.querySelector(".booking-success-summary").textContent =
                    formatDate(booking.date) + " at " + booking.timeLabel + " for " +
                    booking.partySize + (booking.partySize === 1 ? " guest." : " guests.");
                success.querySelector(".booking-reference strong").textContent = booking.reference;
                success.querySelector(".booking-email-note span").textContent = booking.email;
                success.focus();
            } catch (error) {
                showError(errorBox, error.message);
                if (error.code === "SLOT_UNAVAILABLE") loadAvailability();
            } finally {
                submit.disabled = false;
                submit.textContent = "Confirm booking";
            }
        });

        var bookAgain = widget.querySelector(".js-book-again");
        if (bookAgain) {
            bookAgain.addEventListener("click", function () {
                form.reset();
                dateInput.value = isoDate(addDays(new Date(), 1));
                resetSelection();
                success.hidden = true;
                form.hidden = false;
                prompt.textContent = "Choose a date and party size to see available times.";
                slots.innerHTML = "";
                waitlistOffer.hidden = true;
                waitlistPanel.hidden = true;
                waitlistJoin.hidden = false;
                waitlistJoin.disabled = false;
                waitlistJoin.textContent = "Join waiting list";
                bookingRequestId = window.crypto && window.crypto.randomUUID
                    ? window.crypto.randomUUID()
                    : String(Date.now()) + "-" + Math.random().toString(36).slice(2);
                waitlistRequestId = window.crypto && window.crypto.randomUUID
                    ? window.crypto.randomUUID()
                    : String(Date.now()) + "-waitlist-" + Math.random().toString(36).slice(2);
                form.scrollIntoView({ behavior: "smooth", block: "start" });
            });
        }

        if (dateInput.value && partyInput.value) loadAvailability();
    });
})();
