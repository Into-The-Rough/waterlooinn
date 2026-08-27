(function () {
    "use strict";

    var panel = document.querySelector("[data-admin-login]");
    if (!panel) return;
    var errorBox = panel.querySelector(".admin-login-error");
    var button = panel.querySelector("[data-identity-login]");
    if (!window.bookingIdentity) {
        errorBox.textContent = "The Waterloo Inn identity service could not be loaded.";
        errorBox.hidden = false;
        button.disabled = true;
        return;
    }

    function signedIn() {
        window.bookingIdentity.close();
        window.location.replace("/admin/bookings/");
    }

    window.bookingIdentity.onLogin(signedIn);
    button.addEventListener("click", function () {
        errorBox.hidden = true;
        window.bookingIdentity.open();
    });

    window.bookingIdentity.user().then(function (user) {
        if (user) {
            window.location.replace("/admin/bookings/");
        }
    }).catch(function (error) {
        errorBox.textContent = error.message;
        errorBox.hidden = false;
    });
})();
