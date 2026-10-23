"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/content/x.js"), "utf8");
const TARGET = "https://x.com/yapmarkets/status/2113528032996872298";
const OTHER = "https://x.com/other/status/2113528032996872299";
const REQUIREMENTS = "当前任务 +2.55LUX 要完成 转发 待完成 停留时长 15/10s";

class Element {
  constructor(tag, attrs = {}, text = "") {
    this.tagName = tag.toUpperCase(); this.attrs = attrs; this.text = text;
    this.children = []; this.parentElement = null; this.visible = true; this.isConnected = true;
    this.classList = { contains: () => false };
  }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } return this; }
  get innerText() { return [this.text, ...this.children.map(n => n.innerText)].join(" ").trim(); }
  get textContent() { return this.innerText; }
  getAttribute(key) { return this.attrs[key] ?? null; }
  matches(selector) {
    return selector.split(",").some(part => {
      const s = part.trim(), tag = s.match(/^[\w-]+/);
      if (tag && tag[0].toUpperCase() !== this.tagName) return false;
      for (const m of s.matchAll(/\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/g)) {
        if (!(m[1] in this.attrs) || (m[2] !== undefined && this.attrs[m[1]] !== m[2])) return false;
      }
      return !s.includes(".") && !s.includes(" ");
    });
  }
  closest(selector) { for (let n = this; n; n = n.parentElement) if (n.matches(selector)) return n; return null; }
  querySelectorAll(selector) { return this.children.flatMap(n => [...(n.matches(selector) ? [n] : []), ...n.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getBoundingClientRect() { return {width: this.visible ? 100 : 0, height: 30}; }
  scrollIntoView() {}
  click() { this.onClick?.(); }
}

// Real listener, runReply, requirement parser, repost DOM selectors, click
// helper and run guards; only page readiness, unrelated actions and time fake.
function page(options = {}) {
  let listener, elapsed = 0;
  const calls = {open: 0, confirm: 0, undo: 0, quote: 0, other: 0, like: 0, ai: 0, post: 0};
  const body = new Element("body"), location = {href: TARGET};
  const f = {calls, body, location, menu: null, button: null, article: null};
  const sendCancel = () => listener({type: "CANCEL_X_RUN", runId: "repost-run"}, {}, () => {});
  function article(url, current) {
    const a = new Element("article");
    a.append(new Element("a", {href: url}).append(new Element("time")));
    const b = new Element("button", {"data-testid": current && options.already ? "unretweet" : "retweet", "aria-expanded": "false"});
    if (current && options.disabled) b.attrs["aria-disabled"] = "true";
    b.onClick = () => {
      if (!current) { calls.other++; return; }
      if (b.attrs["data-testid"] === "unretweet") { calls.undo++; return; }
      calls.open++; b.attrs["aria-expanded"] = "true";
      const menu = new Element("div", {role: "menu"});
      const confirm = new Element("div", {role: "menuitem", "data-testid": options.undoMenu ? "unretweetConfirm" : "retweetConfirm"}, "转帖");
      if (options.disabledConfirm) confirm.attrs["aria-disabled"] = "true";
      confirm.onClick = () => {
        calls.confirm++;
        if (options.unconfirmed) return;
        if (options.rerender) {
          a.isConnected = false; body.children = body.children.filter(n => n !== a);
          body.append(article(TARGET, true));
        }
        f.button.attrs["data-testid"] = "unretweet";
        f.button.attrs["aria-expanded"] = "false";
        body.children = body.children.filter(n => n !== menu); f.menu = null;
      };
      const quote = new Element("a", {role: "menuitem", href: "/compose/post"}, "引用");
      quote.onClick = () => { calls.quote++; };
      if (!options.noConfirm) menu.append(confirm);
      menu.append(quote); body.append(menu); f.menu = menu;
      if (options.cancelOnOpen) sendCancel();
      if (options.changeTargetOnOpen) location.href = OTHER;
      if (options.foreignMenu) b.attrs["aria-expanded"] = "false";
    };
    if (!current || !options.missingButton) a.append(b);
    if (current) { f.article = a; f.button = b; }
    return a;
  }
  body.append(article(OTHER, false), article(options.wrongArticle ? OTHER : TARGET, true));
  if (options.existingMenu) body.append(new Element("div", {role: "menu"}));
  const panel = new Element("section", {}, options.requirements || REQUIREMENTS);
  const officialButton = new Element("button", {}, "完成上面步骤解锁");
  panel.append(officialButton); body.append(panel);
  class FakeDate extends Date { static now() { return 100000 + elapsed; } }
  const tick = async ms => { elapsed += ms; options.onWait?.(f, sendCancel); };
  const c = vm.createContext({console, URL, Date: FakeDate, location, window: {}, f,
    document: {body, querySelectorAll: s => body.querySelectorAll(s), querySelector: s => body.querySelector(s)},
    getComputedStyle: () => ({display: "block", visibility: "visible"}),
    setTimeout(fn, ms) { elapsed += ms; queueMicrotask(fn); return 1; }, clearTimeout() {}, tick,
    officialButtons: () => [officialButton],
    chrome: {runtime: {onMessage: {addListener(fn) { listener = fn; }}, async sendMessage(message) {
      if (message.type === "CONTENT_LOG") return {ok: true};
      if (message.type === "GENERATE_AI_REPLY") { calls.ai++; return {ok: true, replyText: "fixture reply"}; }
      throw new Error(`Unexpected message ${message.type}`);
    }}},
    fetch: async () => { throw new Error("No network in repost tests"); },
  });
  const adapters = `
    function startTaskWidgetAssist() {}
    waitForPageReady = async () => {};
    assertNotLoginWall = () => {};
    scrapeCurrentTweet = () => ({url: location.href, text: "fixture tweet"});
    simulateReadingBeforeReply = async () => {};
    queryAccessibleElements = s => s === "button.lh-cur-btn" ? officialButtons() : document.querySelectorAll(s);
    wait = tick;
    randomClickDelay = () => tick(500);
    likeCurrentTweetIfNeeded = async () => { f.calls.like++; return {ok: true}; };
    detectExistingReplyBeforeWriting = async () => ({replied: false});
    openReplyComposer = async () => {};
    fillReplyText = async () => {};
    clickPostButtonAndVerify = async () => { f.calls.post++; return {ok: true}; };
  `;
  const end = source.lastIndexOf("})();");
  vm.runInContext(source.slice(0, end) + adapters + source.slice(end), c);
  return {f, calls, elapsed: () => elapsed,
    send: (patch = {}) => new Promise(resolve => listener({type: "RUN_X_REPLY", platform: "lighthouse", runId: "repost-run",
      task: {taskKey: "repost-order", tweetUrl: TARGET, taskType: options.taskType || "转发", seatLocked: true},
      settings: {replyMode: "post", replyProvider: "native"}, ...patch}, {}, resolve)),
  };
}

test("pure repost confirms the target native action once without liking or composing a reply", async () => {
  const p = page();
  const result = await p.send();
  assert.equal(result.ok, true, result.message);
  assert.equal(result.mode, "repost");
  assert.equal(result.repost.status, "reposted");
  assert.deepEqual(p.calls, {open: 1, confirm: 1, undo: 0, quote: 0, other: 0, like: 0, ai: 0, post: 0});
});

for (const options of [{already: true}, {requirements: REQUIREMENTS.replace("转发 待完成", "转发 已完成")}]) {
  test(`already-complete repost never clicks undo: ${JSON.stringify(options)}`, async () => {
    const p = page(options);
    assert.equal((await p.send()).ok, true);
    assert.equal(p.calls.open + p.calls.confirm + p.calls.undo, 0);
  });
}

test("native rerender after confirmation is read from the fresh target article", async () => {
  const p = page({rerender: true});
  assert.equal((await p.send()).ok, true);
  assert.equal(p.calls.confirm, 1);
});

test("a target timestamp inside another tweet's quoted card cannot identify the outer tweet", async () => {
  const p = page({wrongArticle: true});
  p.f.article.append(new Element("div", {role: "link"}).append(
    new Element("a", {href: TARGET}).append(new Element("time"))));
  assert.equal((await p.send()).ok, false);
  assert.equal(p.calls.open + p.calls.confirm + p.calls.other, 0);
});

test("two native repost controls on the target article are ambiguous", async () => {
  const p = page();
  p.f.article.append(new Element("button", {"data-testid": "retweet"}));
  assert.equal((await p.send()).ok, false);
  assert.equal(p.calls.open, 0);
});

for (const options of [{noConfirm: true}, {undoMenu: true}, {foreignMenu: true}, {disabledConfirm: true},
  {existingMenu: true}, {missingButton: true}, {disabled: true}, {wrongArticle: true}, {unconfirmed: true}]) {
  test(`ambiguous, unavailable or unconfirmed repost fails closed: ${JSON.stringify(options)}`, async () => {
    const p = page(options), result = await p.send();
    assert.equal(result.ok, false);
    assert.equal(p.calls.quote + p.calls.undo + p.calls.other + p.calls.ai + p.calls.post, 0);
    assert.equal(p.calls.confirm, options.unconfirmed ? 1 : 0);
    const repeated = await p.send();
    assert.deepEqual(repeated, result);
    assert.equal(p.calls.open, options.existingMenu || options.missingButton || options.disabled || options.wrongArticle ? 0 : 1);
  });
}

for (const options of [{cancelOnOpen: true}, {changeTargetOnOpen: true}, {onWait(f, cancel) { if (f.menu) cancel(); }}]) {
  test(`stop or target change before confirm prevents publishing: ${Object.keys(options)[0]}`, async () => {
    const p = page(options), result = await p.send();
    assert.equal(result.ok, false);
    assert.equal(p.calls.open, 1);
    assert.equal(p.calls.confirm, 0);
  });
}

test("concurrent duplicate repost messages share one native action", async () => {
  const p = page(), results = await Promise.all([p.send(), p.send()]);
  assert.equal(results[0].ok, true);
  assert.deepEqual(results[0], results[1]);
  assert.equal(p.calls.open, 1);
  assert.equal(p.calls.confirm, 1);
});

test("a repost declaration cannot be downgraded to a pure-like widget", async () => {
  const p = page({requirements: REQUIREMENTS.replace("转发", "点赞")});
  const result = await p.send();
  assert.equal(result.ok, false);
  assert.equal(result.actionAttempted, false);
  assert.match(result.message, /任务要求冲突/);
  assert.equal(p.calls.open + p.calls.like, 0);
});

test("composite repost performs each required action and refuses to continue if repost is unconfirmed", async () => {
  for (const unconfirmed of [false, true]) {
    const p = page({unconfirmed, taskType: "评论+点赞+转发",
      requirements: REQUIREMENTS.replace("转发 待完成", "评论 待完成 点赞 待完成 转发 待完成")});
    const result = await p.send();
    assert.equal(result.ok, !unconfirmed);
    assert.equal(p.calls.confirm, 1);
    assert.equal(p.calls.post, unconfirmed ? 0 : 1);
    assert.equal(p.calls.ai, unconfirmed ? 0 : 1);
  }
});

test("quote requirements never run a native repost or reply", async () => {
  const p = page({requirements: REQUIREMENTS.replace("转发", "引用转发"), taskType: "引用"});
  const result = await p.send();
  assert.equal(result.ok, false);
  assert.equal(result.actionAttempted, false);
  assert.equal(p.calls.open + p.calls.quote + p.calls.post, 0);
});
