"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/content/x.js"), "utf8");
const fixture = fs.readFileSync(path.join(__dirname, "invitation-popup.test.cjs"), "utf8");
const Element = new Function(`${fixture.slice(fixture.indexOf("class Element"), fixture.indexOf("function page("))}; return Element;`)();
const TARGET = "https://x.com/author/status/123";
const OTHER = "https://x.com/other/status/456";

function article(url, handle, text, children = []) {
  return new Element("article", "", [
    new Element("a", handle, [], {href: `/${handle}`}),
    new Element("a", "", [new Element("time")], {href: url}),
    new Element("div", text, [], {"data-testid": "tweetText"}),
    ...children
  ]);
}

function page() {
  let elapsed = 0;
  const box = new Element("div", "", [], {"data-testid": "tweetTextarea_0", contenteditable: "true", role: "textbox"});
  const send = new Element("button", "Reply", [], {"data-testid": "tweetButtonInline"});
  const form = new Element("form", "", [box, send]);
  const target = article(TARGET, "author", "Target tweet", [form]);
  const column = new Element("div", "", [target], {"data-testid": "primaryColumn"});
  const body = new Element("body", "", [column]);
  const f = {handle: "@me", complete: false};
  const location = {href: TARGET};
  const context = vm.createContext({
    URL, console, f, location, document: body,
    Date: {now: () => elapsed},
    tick: async ms => { elapsed += ms; },
    chrome: {runtime: {onMessage: {addListener() {}}}}
  });
  const end = source.lastIndexOf("})();");
  vm.runInContext(source.slice(0, end) + `
    function startTaskWidgetAssist() {}
    function isVisible(node) { return node.isConnected && !node.hidden; }
    function hasAccountRestrictionBanner() { return false; }
    function getCurrentAccountHandle() { return f.handle; }
    function inferTaskActions() { return {complete: true, steps: [{action: "comment", completed: f.complete}]}; }
    wait = tick;
    activeTargetUrl = ${JSON.stringify(TARGET)};
    activeRunId = "composer-run";
    globalThis.api = {getBoundReplyBox, openReplyComposer, findSendButton, assertBoundReplyBox, waitForReplySuccess, assertActiveRun};
  ` + source.slice(end), context);
  return {api: context.api, f, box, form, send, target, column, body, location};
}

test("unique target-owned composer and submit action remain usable", async () => {
  const p = page();
  assert.equal(await p.api.openReplyComposer({}), p.box);
  assert.equal(p.api.findSendButton(p.box), p.send);
});

for (const change of ["other-target", "duplicate-box", "nested-article", "removed-box", "generic-compose"]) {
  test(`reply binding rejects ${change} before typing or submitting`, () => {
    const p = page();
    if (change === "other-target") p.location.href = OTHER;
    if (change === "generic-compose") p.location.href = "https://x.com/compose/post";
    if (change === "duplicate-box") p.form.appendChild(new Element("div", "", [], {"data-testid": "tweetTextarea_0", contenteditable: "true"}));
    if (change === "nested-article") { p.form.remove(); p.target.appendChild(article(OTHER, "other", "Quoted", [p.form])); }
    if (change === "removed-box") p.box.remove();
    assert.equal(p.api.getBoundReplyBox(), null);
    assert.throws(() => p.api.assertBoundReplyBox(p.box), /回复框已变化/);
    assert.equal(p.api.findSendButton(p.box), null);
    assert.equal(p.send.clicks, 0);
  });
}

test("publication needs a fresh own reply plus same-task official comment completion", async () => {
  const p = page();
  const publication = {column: p.column, handle: "@me", text: "My reply", task: {}, before: new Set(["https://x.com/i/status/123"])};
  p.column.appendChild(article("https://x.com/me/status/789", "me", "My reply"));
  assert.equal((await p.api.waitForReplySuccess(1000, 250, publication)).ok, false);
  p.f.complete = true;
  const result = await p.api.waitForReplySuccess(1000, 250, publication);
  assert.equal(result.ok, true);
  assert.equal(result.reason, "published_reply");
  assert.equal(result.replyUrl, "https://x.com/i/status/789");
});

for (const scenario of ["old-reply", "wrong-author", "wrong-text", "changed-account", "changed-target"]) {
  test(`publication never confirms ${scenario}`, async () => {
    const p = page();
    p.f.complete = true;
    const before = new Set(["https://x.com/i/status/123"]);
    if (scenario === "old-reply") before.add("https://x.com/i/status/789");
    p.column.appendChild(article("https://x.com/me/status/789", scenario === "wrong-author" ? "other" : "me",
      scenario === "wrong-text" ? "Different reply" : "My reply"));
    if (scenario === "changed-account") p.f.handle = "@another";
    if (scenario === "changed-target") p.location.href = OTHER;
    const result = await p.api.waitForReplySuccess(1000, 250, {column: p.column, handle: "@me", text: "My reply", task: {}, before});
    assert.equal(result.ok, false);
    assert.equal(p.send.clicks, 0);
  });
}
