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

function page(orderUrl = TARGET) {
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
    tick: async ms => { elapsed += Number(ms) || 0; f.onWait?.(); },
    setTimeout: (callback, ms) => queueMicrotask(() => { elapsed += ms; f.onPoll?.(); callback(); }),
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
    activeTargetUrl = ${JSON.stringify(orderUrl)};
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

function addReplyButton(p) {
  const button = new Element("button", "Reply", [], {"data-testid": "reply"});
  p.target.appendChild(button);
  return button;
}

test("opens a composer with the unique button owned by the target tweet", async () => {
  const p = page();
  p.form.remove();
  const button = addReplyButton(p);
  button.onClick = () => p.target.appendChild(p.form);
  assert.equal(await p.api.openReplyComposer({actionDelayMs: 100}), p.box);
  assert.equal(button.clicks, 1);
});

test("uses a same-tweet composer that appears while waiting for the reply entry", async () => {
  const p = page();
  p.form.remove();
  p.f.onPoll = () => {
    p.f.onPoll = null;
    addReplyButton(p);
    p.target.appendChild(p.form);
  };
  assert.equal(await p.api.openReplyComposer({actionDelayMs: 100}), p.box);
  assert.equal(p.target.querySelector('[data-testid="reply"]').clicks, 0);
});

test("uses a same-tweet composer that appears just before the reply button click", async () => {
  const p = page();
  p.form.remove();
  const button = addReplyButton(p);
  p.f.onWait = () => {
    p.f.onWait = null;
    p.target.appendChild(p.form);
  };
  assert.equal(await p.api.openReplyComposer({actionDelayMs: 100}), p.box);
  assert.equal(button.clicks, 0);
});

function addInlineReply(p) {
  p.form.remove();
  p.box.remove();
  p.send.remove();
  // X's native conversation editor uses a sibling container, and need not use a form.
  p.column.appendChild(new Element("section", "当前任务"));
  const inline = new Element("div", "", [p.box, p.send], {"data-testid": "inline_reply_offscreen"});
  p.column.appendChild(inline);
  return inline;
}

test("binds an edited target through its own /history timestamp on the post page", async () => {
  const p = page("https://x.com/i/status/123");
  p.target.querySelector("time").parentElement.href = "/author/status/123/history";
  p.target.appendChild(new Element("a", "", [], {href: "/author/status/123/photo/1"}));
  p.target.appendChild(new Element("a", "", [], {href: "/author/status/123/analytics"}));
  addInlineReply(p);

  assert.equal(await p.api.openReplyComposer({actionDelayMs: 100}), p.box);
  assert.equal(p.api.findSendButton(p.box), p.send);
  assert.equal(p.send.clicks, 0);
});

for (const scenario of ["quoted", "duplicate-target", "different-id", "different-host", "no-timestamp", "history-page"]) {
  test(`does not bind an edit-history link with ${scenario}`, () => {
    const p = page();
    const timestamp = p.target.querySelector("time");
    const link = timestamp.parentElement;
    link.href = "/author/status/123/history";
    if (scenario === "quoted") {
      link.remove();
      p.target.appendChild(new Element("div", "", [link], {role: "link"}));
    }
    if (scenario === "duplicate-target") p.column.appendChild(article(TARGET, "author", "Another copy"));
    if (scenario === "different-id") link.href = "/author/status/456/history";
    if (scenario === "different-host") link.href = "https://example.com/author/status/123/history";
    if (scenario === "no-timestamp") timestamp.remove();
    if (scenario === "history-page") p.location.href = `${TARGET}/history`;
    assert.equal(p.api.getBoundReplyBox(), null);
    assert.equal(p.api.findSendButton(p.box), null);
    assert.equal(p.send.clicks, 0);
  });
}

test("uses the native inline editor below the exact target with its own send button", async () => {
  const p = page();
  const button = addReplyButton(p);
  addInlineReply(p);
  p.column.appendChild(article(OTHER, "other", "Nearby reply", [
    new Element("button", "Reply", [], {"data-testid": "tweetButtonInline"})
  ]));
  assert.equal(await p.api.openReplyComposer({actionDelayMs: 100}), p.box);
  assert.equal(p.api.findSendButton(p.box), p.send);
  assert.equal(button.clicks, 0);
});

test("ignores an empty visible inline container under another tweet", async () => {
  const p = page();
  const button = addReplyButton(p);
  addInlineReply(p);
  p.column.appendChild(article(OTHER, "other", "Nearby reply"));
  p.column.appendChild(new Element("div", "", [], {"data-testid": "inline_reply_offscreen"}));

  assert.equal(await p.api.openReplyComposer({actionDelayMs: 100}), p.box);
  assert.doesNotThrow(() => p.api.assertBoundReplyBox(p.box));
  assert.equal(p.api.findSendButton(p.box), p.send);
  assert.equal(button.clicks, 0);
});

test("ignores an empty visible inline container before the target editor", async () => {
  const p = page();
  const editor = addInlineReply(p);
  const placeholder = new Element("div", "", [], {"data-testid": "inline_reply_offscreen"});
  p.column.replaceChildren(p.target, placeholder, editor);

  assert.equal(await p.api.openReplyComposer({actionDelayMs: 100}), p.box);
  assert.equal(p.api.findSendButton(p.box), p.send);
});

test("a second inline container with a send control still blocks an existing editor", async () => {
  const p = page();
  const editor = addInlineReply(p);
  assert.equal(await p.api.openReplyComposer({actionDelayMs: 100}), p.box);

  const unrelatedSend = new Element("button", "Reply", [], {"data-testid": "tweetButtonInline"});
  editor.appendChild(new Element("div", "", [unrelatedSend], {"data-testid": "inline_reply_offscreen"}));
  assert.throws(() => p.api.assertBoundReplyBox(p.box), /回复框已变化/);
  assert.equal(p.api.findSendButton(p.box), null);
  assert.equal(p.send.clicks + unrelatedSend.clicks, 0);
});

test("accepts the native inline composer inserted by the target reply button", async () => {
  const p = page();
  p.form.remove();
  const button = addReplyButton(p);
  button.onClick = () => addInlineReply(p);
  assert.equal(await p.api.openReplyComposer({actionDelayMs: 100}), p.box);
  assert.equal(button.clicks, 1);
});

test("revalidates inline ownership when a different tweet appears before the editor", async () => {
  const p = page();
  const inline = addInlineReply(p);
  assert.equal(await p.api.openReplyComposer({actionDelayMs: 100}), p.box);
  p.column.replaceChildren(p.target, article(OTHER, "other", "Different tweet"), inline);
  assert.throws(() => p.api.assertBoundReplyBox(p.box), /回复框已变化/);
  assert.equal(p.api.findSendButton(p.box), null);
  assert.equal(p.send.clicks, 0);
});

for (const scenario of ["other-tweet", "hidden-other-tweet", "generic-dialog", "two-editors", "second-inline-container", "other-route"]) {
  test(`does not use an inline composer with ${scenario}`, () => {
    const p = page();
    const inline = addInlineReply(p);
    if (scenario === "other-tweet" || scenario === "hidden-other-tweet") {
      const other = article(OTHER, "other", "Other tweet");
      other.hidden = scenario === "hidden-other-tweet";
      p.column.replaceChildren(p.target, other, inline);
    }
    if (scenario === "generic-dialog") {
      p.box.remove();
      inline.appendChild(new Element("div", "", [p.box], {role: "dialog"}));
    }
    if (scenario === "two-editors" || scenario === "second-inline-container") {
      const duplicate = new Element("div", "", [], {"data-testid": "tweetTextarea_0", contenteditable: "true"});
      if (scenario === "two-editors") inline.appendChild(duplicate);
      else p.column.appendChild(new Element("div", "", [duplicate], {"data-testid": "inline_reply_offscreen"}));
    }
    if (scenario === "other-route") p.location.href = OTHER;
    assert.equal(p.api.getBoundReplyBox(), null);
    assert.equal(p.api.findSendButton(p.box), null);
    assert.equal(p.send.clicks, 0);
  });
}

test("never picks a send button outside the bound inline editor", async () => {
  const p = page();
  addInlineReply(p);
  p.send.remove();
  p.column.appendChild(p.send);
  assert.equal(await p.api.openReplyComposer({actionDelayMs: 100}), p.box);
  assert.equal(p.api.findSendButton(p.box), null);
  assert.equal(p.send.clicks, 0);
});

test("leaves an unbound visible composer untouched and reports why the reply is blocked", async () => {
  const p = page();
  p.form.remove();
  p.column.appendChild(p.form);
  const button = addReplyButton(p);
  await assert.rejects(p.api.openReplyComposer({actionDelayMs: 100}), /已有回复框.*无法确认.*本单/);
  assert.equal(button.clicks, 0);
  assert.equal(p.api.findSendButton(p.box), null);
});

test("does not click an ambiguous reply control", async () => {
  const p = page();
  p.form.remove();
  const first = addReplyButton(p);
  const second = addReplyButton(p);
  await assert.rejects(p.api.openReplyComposer({actionDelayMs: 100}), /多个.*回复按钮/);
  assert.equal(first.clicks + second.clicks, 0);
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

for (const scenario of ["old-reply", "wrong-author", "wrong-text", "changed-account", "changed-target", "history-only-reply"]) {
  test(`publication never confirms ${scenario}`, async () => {
    const p = page();
    p.f.complete = true;
    const before = new Set(["https://x.com/i/status/123"]);
    if (scenario === "old-reply") before.add("https://x.com/i/status/789");
    const replyUrl = scenario === "history-only-reply" ? "https://x.com/me/status/789/history" : "https://x.com/me/status/789";
    p.column.appendChild(article(replyUrl, scenario === "wrong-author" ? "other" : "me",
      scenario === "wrong-text" ? "Different reply" : "My reply"));
    if (scenario === "changed-account") p.f.handle = "@another";
    if (scenario === "changed-target") p.location.href = OTHER;
    const result = await p.api.waitForReplySuccess(1000, 250, {column: p.column, handle: "@me", text: "My reply", task: {}, before});
    assert.equal(result.ok, false);
    assert.equal(p.send.clicks, 0);
  });
}
