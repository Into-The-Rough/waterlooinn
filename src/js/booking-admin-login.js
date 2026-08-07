(function () {
    "use strict";

    var form = document.querySelector("[data-admin-login]");
    if (!form) return;
    var errorBox = form.querySelector(".admin-login-error");

    form.addEventListener("submit", async function (event) {
        event.preventDefault();
        errorBox.hidden = true;
        var button = form.querySelector("button");
        button.disabled = true;
        try {
            var response = await fetch("/api/admin/login", {
                method: "POST",
                headers: { "Accept": "application/json", "Content-Type": "application/json" },
                body: JSON.stringify({ password: form.elements.password.value })
            });
            var result = await response.json();
            if (!response.ok) throw new Error(result.error && result.error.message || "Sign in failed.");
            window.location.replace("/admin/bookings/");
        } catch (error) {
            errorBox.textContent = error.message;
            errorBox.hidden = false;
            button.disabled = false;
        }
    });
})();
