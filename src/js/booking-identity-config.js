(function () {
    "use strict";

    if (!["localhost", "127.0.0.1", "0.0.0.0"].includes(window.location.hostname)) return;
    var endpoint = document.documentElement.dataset.identityUrl || "";
    var suffix = "/.netlify/identity";
    if (endpoint.endsWith(suffix)) {
        window.localStorage.setItem("netlifySiteURL", endpoint.slice(0, -suffix.length));
    }
})();
