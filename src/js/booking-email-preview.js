(function () {
    "use strict";

    var panel = document.querySelector("[data-email-preview]");
    if (!panel) return;
    var loading = panel.querySelector(".admin-loading");
    var errorBox = panel.querySelector(".admin-login-error");
    var frame = panel.querySelector("iframe");
    var id = new URLSearchParams(window.location.search).get("id") || "";

    async function loadPreview() {
        if (!/^[A-Za-z0-9-]{16,128}$/.test(id)) throw new Error("The email preview link is invalid.");
        var token = await window.bookingIdentity.token();
        var response = await fetch("/api/admin/emails/" + encodeURIComponent(id), {
            headers: {
                "Accept": "text/html",
                "Authorization": "Bearer " + token
            }
        });
        if (response.status === 401) {
            window.location.replace("/admin/bookings/login/");
            return;
        }
        if (!response.ok) throw new Error("The email preview could not be loaded.");
        frame.srcdoc = await response.text();
        loading.hidden = true;
        frame.hidden = false;
    }

    loadPreview().catch(function (error) {
        if (error.code === "AUTH_REQUIRED") {
            window.location.replace("/admin/bookings/login/");
            return;
        }
        loading.hidden = true;
        errorBox.textContent = error.message;
        errorBox.hidden = false;
    });
})();
