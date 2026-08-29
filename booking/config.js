"use strict";

const BOOKING_CONFIG = Object.freeze({
    venueName: "The Waterloo Inn",
    timezone: "Europe/London",
    slotMinutes: 30,
    durationMinutes: 120,
    maxPartySize: 8,
    maxAdminPartySize: 30,
    maxOnlineCovers: 30,
    minimumNoticeMinutes: 120,
    maximumAdvanceDays: 90,
    tableHoldMinutes: 15,
    reminderLeadHours: 24,
    largePartySize: 7,
    manageTokenGraceHours: 24,
    verificationHoldMinutes: 15,
    retention: {
        emailDays: 30,
        cancelledDays: 90,
        waitlistDays: 90,
        customerDays: 365
    },
    areas: ["Restaurant", "Bar", "Outside"],
    serviceHours: {
        0: { start: "12:00", end: "19:00", label: "Sunday" },
        1: { start: "12:00", end: "20:00", label: "Monday" },
        2: null,
        3: { start: "12:00", end: "20:00", label: "Wednesday" },
        4: { start: "12:00", end: "20:00", label: "Thursday" },
        5: { start: "12:00", end: "21:00", label: "Friday" },
        6: { start: "12:00", end: "21:00", label: "Saturday" }
    }
});

const WEEKDAY_LABELS = Object.freeze([
    "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"
]);

function isIsoDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day, 12));
    return parsed.getUTCFullYear() === year &&
        parsed.getUTCMonth() === month - 1 &&
        parsed.getUTCDate() === day;
}

function timeToMinutes(value) {
    if (!/^\d{2}:\d{2}$/.test(String(value || ""))) return Number.NaN;
    const [hours, minutes] = value.split(":").map(Number);
    if (hours > 23 || minutes > 59) return Number.NaN;
    return (hours * 60) + minutes;
}

function minutesToTime(value) {
    const hours = Math.floor(value / 60);
    const minutes = value % 60;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function formatTime(value) {
    const minutes = timeToMinutes(value);
    if (Number.isNaN(minutes)) return value;
    const hours = Math.floor(minutes / 60);
    const suffix = hours >= 12 ? "pm" : "am";
    const displayHour = hours % 12 || 12;
    const displayMinutes = minutes % 60;
    return displayMinutes === 0
        ? `${displayHour}${suffix}`
        : `${displayHour}:${String(displayMinutes).padStart(2, "0")}${suffix}`;
}

function getWeekday(date) {
    if (!isIsoDate(date)) return null;
    return new Date(`${date}T12:00:00Z`).getUTCDay();
}

function getServiceRule(date) {
    const weekday = getWeekday(date);
    return weekday === null ? null : BOOKING_CONFIG.serviceHours[weekday];
}

function generateSlots(date) {
    const rule = getServiceRule(date);
    return generateSlotsForRule(rule);
}

function generateSlotsForRule(rule) {
    if (!rule) return [];
    const slots = [];
    const start = timeToMinutes(rule.start);
    const end = timeToMinutes(rule.end);
    for (let value = start; value <= end; value += BOOKING_CONFIG.slotMinutes) {
        slots.push(minutesToTime(value));
    }
    return slots;
}

function venueNow(now = new Date()) {
    const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: BOOKING_CONFIG.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
    });
    const parts = Object.fromEntries(
        formatter.formatToParts(now)
            .filter((part) => part.type !== "literal")
            .map((part) => [part.type, part.value])
    );
    return {
        date: `${parts.year}-${parts.month}-${parts.day}`,
        time: `${parts.hour}:${parts.minute}`,
        minutes: (Number(parts.hour) * 60) + Number(parts.minute)
    };
}

function dateDistance(fromDate, toDate) {
    if (!isIsoDate(fromDate) || !isIsoDate(toDate)) return Number.NaN;
    const from = Date.parse(`${fromDate}T12:00:00Z`);
    const to = Date.parse(`${toDate}T12:00:00Z`);
    return Math.round((to - from) / 86400000);
}

function venueDateTime(date, time) {
    if (!isIsoDate(date) || Number.isNaN(timeToMinutes(time))) return null;
    const [year, month, day] = date.split("-").map(Number);
    const [hour, minute] = time.split(":").map(Number);
    const target = Date.UTC(year, month - 1, day, hour, minute);
    const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: BOOKING_CONFIG.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
    });
    let guess = target;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const parts = Object.fromEntries(
            formatter.formatToParts(new Date(guess))
                .filter((part) => part.type !== "literal")
                .map((part) => [part.type, Number(part.value)])
        );
        const rendered = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
        const difference = target - rendered;
        guess += difference;
        if (difference === 0) break;
    }
    return new Date(guess);
}

module.exports = {
    BOOKING_CONFIG,
    WEEKDAY_LABELS,
    dateDistance,
    formatTime,
    generateSlots,
    generateSlotsForRule,
    getServiceRule,
    getWeekday,
    isIsoDate,
    minutesToTime,
    timeToMinutes,
    venueDateTime,
    venueNow
};
