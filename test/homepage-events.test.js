"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const nunjucks = require("nunjucks");

const templates = new nunjucks.Environment(new nunjucks.FileSystemLoader(path.join(__dirname, "../src/_includes")));
const event = {
    name: "Live music!",
    description: "Dom Morgan - back by popular demand!",
    day: "Saturday 19th September 8:30pm",
    image: "/images/poster.jpg"
};

test("existing event images default to the uncropped poster layout", () => {
    const html = templates.render("event-card.njk", { event });
    assert.match(html, /event-card--with-image event-card--poster/);
    assert.doesNotMatch(html, /event-card--photo/);
    assert.match(html, /href="\/images\/poster\.jpg" data-event-image/);
    assert.match(html, /aria-label="View full image for Live music!"/);
    assert.match(html, /Saturday 19th September 8:30pm/);
});

test("admins can explicitly choose cropped photo mode", () => {
    const html = templates.render("event-card.njk", { event: { ...event, imageStyle: "photo" } });
    assert.match(html, /event-card--with-image event-card--photo/);
    assert.doesNotMatch(html, /event-card--poster/);
});

test("empty or unrecognised image modes fall back to showing the whole poster", () => {
    for (const imageStyle of ["", "poster", "unknown"]) {
        assert.match(templates.render("event-card.njk", { event: { ...event, imageStyle } }), /event-card--poster/);
    }
});

test("events without an image retain their text and do not create empty image links", () => {
    const html = templates.render("event-card.njk", { event: { ...event, image: "" } });
    assert.match(html, /<article class="event-card">/);
    assert.match(html, /Dom Morgan - back by popular demand!/);
    assert.doesNotMatch(html, /data-event-image|<img|event-card--with-image/);
});

test("event details and image attributes are escaped as text", () => {
    const html = templates.render("event-card.njk", {
        event: { ...event, name: '<script>alert("event")</script>', description: '<img src=x onerror="alert(1)">', image: '/images/poster.jpg" onclick="alert(1)' }
    });
    assert.doesNotMatch(html, /<script>|<img src=x|" onclick="/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&quot; onclick=&quot;/);
});
