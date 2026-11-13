"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const nunjucks = require("nunjucks");

const templates = new nunjucks.Environment(new nunjucks.FileSystemLoader(path.join(__dirname, "../src/_includes")));
const poster = { image: "/images/christmas-menu.png", title: "Christmas Fayre Menu", alt: "Christmas menu poster" };

test("a menu poster renders its heading and a link to the full-size image", () => {
    const html = templates.render("menu-posters.njk", { menu: { posters: [poster] } });
    assert.match(html, /<h2>Christmas Fayre Menu<\/h2>/);
    assert.match(html, /<a class="menu-poster-link" href="\/images\/christmas-menu\.png"/);
    assert.match(html, /<img src="\/images\/christmas-menu\.png" alt="Christmas menu poster" loading="lazy">/);
});

test("the heading is optional", () => {
    const html = templates.render("menu-posters.njk", { menu: { posters: [{ image: poster.image }] } });
    assert.doesNotMatch(html, /<h2>/);
    assert.match(html, /<img src="\/images\/christmas-menu\.png" alt=""/);
});

test("nothing is rendered when there are no posters or a poster has no image", () => {
    for (const menu of [{}, { posters: [] }, { posters: [{ title: "No image yet" }] }]) {
        assert.equal(templates.render("menu-posters.njk", { menu }).trim(), "");
    }
});

test("poster text and image attributes are escaped", () => {
    const html = templates.render("menu-posters.njk", {
        menu: { posters: [{ image: '/images/x.png" onclick="alert(1)', title: "<script>alert(1)</script>" }] }
    });
    assert.doesNotMatch(html, /<script>|" onclick="/);
    assert.match(html, /&lt;script&gt;/);
});
