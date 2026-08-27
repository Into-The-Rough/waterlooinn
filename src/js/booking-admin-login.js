(function () {
    "use strict";

    var panel = document.querySelector("[data-admin-login]");
    if (!panel) return;
    var errorBox = panel.querySelector(".admin-login-error");
    var form = panel.querySelector("[data-password-login]");
    var identityButton = panel.querySelector("[data-identity-login]");
    var identityFallback = panel.querySelector("[data-identity-fallback]");

    function showError(message) {
        errorBox.textContent = message;
        errorBox.hidden = false;
    }

    if (!window.bookingIdentity) {
        identityFallback.hidden = true;
    } else if (!window.bookingIdentity.available) {
        identityFallback.hidden = true;
    }

    function signedIn() {
        if (window.bookingIdentity) window.bookingIdentity.close();
        window.location.replace("/admin/bookings/");
    }

    form.addEventListener("submit", async function (event) {
        event.preventDefault();
        errorBox.hidden = true;
        var submit = form.querySelector('button[type="submit"]');
        var data = new FormData(form);
        submit.disabled = true;
        submit.textContent = "Signing in…";
        try {
            var response = await fetch("/api/admin/session", {
                method: "POST",
                credentials: "same-origin",
                headers: {
                    "Accept": "application/json",
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    username: data.get("username"),
                    password: data.get("password")
                })
            });
            var result = await response.json();
            if (!response.ok) {
                throw new Error(result.error && result.error.message || "Sign-in failed.");
            }
            form.reset();
            signedIn();
        } catch (error) {
            showError(error.message || "Sign-in failed. Please try again.");
            submit.disabled = false;
            submit.textContent = "Sign in";
        }
    });

    async function checkExistingSession() {
        var response = await fetch("/api/admin/session", {
            credentials: "same-origin",
            headers: { "Accept": "application/json" }
        });
        if (response.ok) signedIn();
    }

    if (!window.bookingIdentity || !window.bookingIdentity.available) {
        checkExistingSession().catch(function () {});
        return;
    }

    window.bookingIdentity.onLogin(signedIn);
    identityButton.addEventListener("click", function () {
        errorBox.hidden = true;
        window.bookingIdentity.open();
    });

    checkExistingSession().then(function () {
        return window.bookingIdentity.user();
    }).then(function (user) {
        if (user) {
            window.location.replace("/admin/bookings/");
        }
    }).catch(function (error) {
        if (error && error.message) showError(error.message);
    });
})();
