(function () {
    "use strict";

    var panel = document.querySelector("[data-manage-booking]");
    if (!panel) return;

    var params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    var token = params.get("token");
    var intent = params.get("intent");
    if (window.location.hash) {
        window.history.replaceState({}, "", window.location.pathname);
    }
    var csrfToken = "";
    var loading = panel.querySelector(".manage-loading");
    var errorPanel = panel.querySelector(".manage-error");
    var errorMessage = panel.querySelector(".manage-error-message");
    var details = panel.querySelector(".manage-details");
    var confirmPanel = panel.querySelector(".manage-confirm-panel");
    var confirmedPanel = panel.querySelector(".manage-confirmed");
    var confirmButton = panel.querySelector(".js-confirm-booking");
    var confirmError = panel.querySelector(".manage-confirm-error");
    var amendPanel = panel.querySelector(".manage-amend-panel");
    var amendForm = panel.querySelector(".manage-amend-form");
    var amendError = panel.querySelector(".manage-amend-error");
    var amendSuccess = panel.querySelector(".manage-amend-success");
    var cancelPanel = panel.querySelector(".manage-cancel-panel");
    var cancelledPanel = panel.querySelector(".manage-cancelled");
    var cancelButton = panel.querySelector(".js-cancel-booking");
    var cancelError = panel.querySelector(".manage-cancel-error");
    var currentBooking = null;

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

    async function api(url, options) {
        var settings = Object.assign({}, options || {});
        settings.headers = Object.assign({
            "Accept": "application/json",
            "Content-Type": "application/json"
        }, settings.headers || {});
        if (csrfToken && settings.method && settings.method !== "GET") {
            settings.headers["X-CSRF-Token"] = csrfToken;
        }
        var response = await fetch(url, settings);
        var result = await response.json();
        if (!response.ok) throw new Error(result.error && result.error.message || "Request failed.");
        return result;
    }

    function showLoadError(message) {
        loading.hidden = true;
        details.hidden = true;
        errorMessage.textContent = message;
        errorPanel.hidden = false;
    }

    function updateSummary(booking) {
        currentBooking = booking;
        panel.querySelector(".manage-reference").textContent = "Reference " + booking.reference;
        panel.querySelector('[data-field="date"]').textContent = formatDate(booking.date);
        panel.querySelector('[data-field="time"]').textContent = booking.timeLabel;
        panel.querySelector('[data-field="party"]').textContent =
            booking.partySize + (booking.partySize === 1 ? " guest" : " guests");
        panel.querySelector('[data-field="name"]').textContent = booking.name;
    }

    async function loadAmendmentAvailability(preferredTime) {
        var date = amendForm.elements.date.value;
        var partySize = amendForm.elements.partySize.value;
        var timeSelect = amendForm.elements.time;
        var submit = amendForm.querySelector('button[type="submit"]');
        timeSelect.disabled = true;
        submit.disabled = true;
        timeSelect.innerHTML = '<option value="">Checking availability…</option>';
        amendError.hidden = true;
        try {
            var data = await api(
                "/api/manage-availability?date=" + encodeURIComponent(date) +
                "&partySize=" + encodeURIComponent(partySize),
                { method: "GET" }
            );
            var openSlots = data.slots.filter(function (slot) { return slot.available; });
            if (!openSlots.length) {
                timeSelect.innerHTML = '<option value="">No times available</option>';
                amendError.textContent = "There are no suitable online times for that selection.";
                amendError.hidden = false;
                return;
            }
            timeSelect.innerHTML = openSlots.map(function (slot) {
                return '<option value="' + slot.time + '"' + (slot.time === preferredTime ? " selected" : "") + ">" + slot.label + "</option>";
            }).join("");
            timeSelect.disabled = false;
            submit.disabled = false;
        } catch (error) {
            timeSelect.innerHTML = '<option value="">Unavailable</option>';
            amendError.textContent = error.message;
            amendError.hidden = false;
        }
    }

    function applyManagedState(result) {
        var booking = result.booking;
        updateSummary(booking);
        if (booking.customerConfirmedAt) {
            confirmPanel.hidden = true;
            confirmedPanel.hidden = false;
        } else if (result.canConfirm) {
            confirmPanel.hidden = false;
            confirmedPanel.hidden = true;
        } else {
            confirmPanel.hidden = true;
            confirmedPanel.hidden = true;
        }

        if (result.canAmend) {
            amendPanel.hidden = false;
            amendForm.elements.date.value = booking.date;
            amendForm.elements.partySize.value = String(booking.partySize);
            amendForm.elements.requests.value = booking.requests || "";
            loadAmendmentAvailability(booking.time);
        } else {
            amendPanel.innerHTML = "<h2>This booking cannot be changed online</h2><p>Please call the pub on <a href=\"tel:01298463248\">01298 463248</a> if you need any help.</p>";
        }

        if (!result.canCancel) {
            cancelPanel.innerHTML = "<h2>This booking cannot be cancelled online</h2><p>Please call the pub on <a href=\"tel:01298463248\">01298 463248</a> if you need any help.</p>";
        }
    }

    async function loadBooking() {
        try {
            var session;
            if (token) {
                session = await api("/api/manage-session", {
                    method: "POST",
                    body: JSON.stringify({ token: token })
                });
                token = "";
            } else {
                session = await api("/api/manage-session", { method: "GET" });
            }
            csrfToken = session.csrfToken;
            var result = session.managed || await api("/api/manage-booking", { method: "GET" });
            applyManagedState(result);
            loading.hidden = true;
            details.hidden = false;
            var target = intent === "confirm" ? confirmPanel : (intent === "cancel" ? cancelPanel : null);
            if (target && !target.hidden) {
                target.classList.add("is-emphasised");
                target.scrollIntoView({ behavior: "smooth", block: "center" });
            }
        } catch (error) {
            showLoadError(error.message);
        }
    }

    amendForm.elements.date.min = isoDate(new Date());
    amendForm.elements.date.max = isoDate(addDays(new Date(), 90));
    amendForm.elements.date.addEventListener("change", function () {
        loadAmendmentAvailability("");
    });
    amendForm.elements.partySize.addEventListener("change", function () {
        loadAmendmentAvailability("");
    });

    confirmButton.addEventListener("click", async function () {
        confirmError.hidden = true;
        confirmButton.disabled = true;
        confirmButton.textContent = "Confirming…";
        try {
            var result = await api("/api/confirm-booking", {
                method: "POST",
                body: "{}"
            });
            applyManagedState(result);
        } catch (error) {
            confirmError.textContent = error.message;
            confirmError.hidden = false;
            confirmButton.disabled = false;
            confirmButton.textContent = "Confirm my booking";
        }
    });

    amendForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        amendError.hidden = true;
        amendSuccess.hidden = true;
        var submit = amendForm.querySelector('button[type="submit"]');
        submit.disabled = true;
        submit.textContent = "Saving…";
        try {
            var result = await api("/api/amend-booking", {
                method: "PATCH",
                body: JSON.stringify({
                    date: amendForm.elements.date.value,
                    time: amendForm.elements.time.value,
                    partySize: Number(amendForm.elements.partySize.value),
                    requests: amendForm.elements.requests.value
                })
            });
            applyManagedState(result);
            amendSuccess.textContent = "Your booking has been updated and new confirmation emails have been prepared.";
            amendSuccess.hidden = false;
        } catch (error) {
            amendError.textContent = error.message;
            amendError.hidden = false;
        } finally {
            submit.disabled = false;
            submit.textContent = "Save changes";
        }
    });

    cancelButton.addEventListener("click", async function () {
        if (!window.confirm("Cancel this table booking? This cannot be undone.")) return;
        cancelError.hidden = true;
        cancelButton.disabled = true;
        cancelButton.textContent = "Cancelling…";
        try {
            await api("/api/cancel-booking", {
                method: "POST",
                body: "{}"
            });
            confirmPanel.hidden = true;
            confirmedPanel.hidden = true;
            amendPanel.hidden = true;
            cancelPanel.hidden = true;
            cancelledPanel.hidden = false;
        } catch (error) {
            cancelError.textContent = error.message;
            cancelError.hidden = false;
            cancelButton.disabled = false;
            cancelButton.textContent = "Cancel this booking";
        }
    });

    loadBooking();
})();
