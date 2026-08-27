"use strict";

const COMMON_DOMAIN_TYPOS = Object.freeze({
    "gmial.com": "gmail.com",
    "gamil.com": "gmail.com",
    "gmail.co": "gmail.com",
    "hotmial.com": "hotmail.com",
    "hotmal.com": "hotmail.com",
    "outlok.com": "outlook.com",
    "yaho.com": "yahoo.com",
    "icloud.co": "icloud.com"
});

function cleanText(value, maximumLength = 500) {
    return String(value || "").trim().replace(/\s+/g, " ").slice(0, maximumLength);
}

function normaliseEmail(value) {
    return String(value || "").trim().toLowerCase();
}

function validateEmail(value, required = true) {
    const email = normaliseEmail(value);
    if (!email && !required) return { value: "", suggestion: null };
    if (!email) throw validationError("Please enter an email address.", "email");
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        throw validationError("Please check the email address and try again.", "email");
    }
    const [local, domain] = email.split("@");
    const suggestedDomain = COMMON_DOMAIN_TYPOS[domain] || null;
    return {
        value: email,
        suggestion: suggestedDomain ? `${local}@${suggestedDomain}` : null
    };
}

function normalisePhone(value, required = true) {
    const raw = String(value || "").trim();
    if (!raw && !required) return "";
    if (!raw) throw validationError("Please enter a phone number.", "phone");
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) {
        throw validationError("Please check the phone number and try again.", "phone");
    }
    if (raw.startsWith("+")) return `+${digits}`;
    return digits;
}

function validationError(message, field = null, code = "VALIDATION_ERROR") {
    const error = new Error(message);
    error.status = 400;
    error.code = code;
    error.field = field;
    return error;
}

module.exports = {
    cleanText,
    normaliseEmail,
    normalisePhone,
    validateEmail,
    validationError
};
