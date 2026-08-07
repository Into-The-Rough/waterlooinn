(function () {
    "use strict";

    var identity = window.netlifyIdentity;
    var resolveReady;
    var rejectReady;
    var ready = new Promise(function (resolve, reject) {
        resolveReady = resolve;
        rejectReady = reject;
    });

    if (!identity) {
        rejectReady(new Error("The Waterloo Inn identity service could not be loaded."));
        return;
    }

    identity.on("init", function (user) { resolveReady(user || null); });
    identity.on("login", function (user) { resolveReady(user); });
    identity.on("error", function (error) { rejectReady(error); });
    window.setTimeout(function () {
        resolveReady(identity.currentUser() || null);
    }, 500);

    async function user() {
        return identity.currentUser() || await ready;
    }

    async function token() {
        var current = await user();
        if (!current) {
            var error = new Error("Please sign in with your Waterloo Inn admin account.");
            error.code = "AUTH_REQUIRED";
            throw error;
        }
        return current.jwt();
    }

    window.bookingIdentity = {
        user: user,
        token: token,
        open: function () { identity.open("login"); },
        close: function () { identity.close(); },
        logout: function () { return identity.logout(); },
        onLogin: function (callback) { identity.on("login", callback); }
    };
})();
