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
        resolveReady(null);
        window.bookingIdentity = {
            available: false,
            user: async function () { return null; },
            token: async function () {
                var error = new Error("Please sign in to the Waterloo Inn booking diary.");
                error.code = "AUTH_REQUIRED";
                throw error;
            },
            optionalToken: async function () { return null; },
            open: function () {},
            close: function () {},
            logout: async function () {},
            onLogin: function () {}
        };
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

    async function optionalToken() {
        var current = await user();
        return current ? current.jwt() : null;
    }

    window.bookingIdentity = {
        available: true,
        user: user,
        token: token,
        optionalToken: optionalToken,
        open: function () { identity.open("login"); },
        close: function () { identity.close(); },
        logout: function () { return identity.logout(); },
        onLogin: function (callback) { identity.on("login", callback); }
    };
})();
