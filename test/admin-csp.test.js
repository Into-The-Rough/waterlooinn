"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function directivesFor(route) {
    const headers = fs.readFileSync(path.join(__dirname, "../src/_headers"), "utf8");
    const block = headers.split(/\r?\n\s*\r?\n/).find(block => block.split(/\r?\n/)[0] === route);
    assert.ok(block, `Missing headers for ${route}`);
    const policy = block.split(/\r?\n/).find(line => line.trimStart().startsWith("Content-Security-Policy:"));
    assert.ok(policy, `Missing CSP for ${route}`);
    return new Map(policy.slice(policy.indexOf(":") + 1).split(";").filter(value => value.trim()).map(value => {
        const [name, ...sources] = value.trim().split(/\s+/);
        return [name, sources];
    }));
}

test("content admin permits both previewing and reading uploaded image blobs", () => {
    const directives = directivesFor("/admin/*");
    assert.ok(directives.get("img-src").includes("blob:"));
    // Decap AssetProxy.toBase64 fetches its blob URL before uploading to Git Gateway.
    assert.ok(directives.get("connect-src").includes("blob:"));
    assert.ok(directives.get("connect-src").includes("'self'"));
    assert.ok(directives.get("connect-src").includes("https://api.github.com"));
    for (const broadSource of ["*", "https:", "data:"]) {
        assert.equal(directives.get("connect-src").includes(broadSource), false);
    }
});

test("public pages do not inherit the CMS blob connection permission", () => {
    assert.equal(directivesFor("/*").get("connect-src").includes("blob:"), false);
});
