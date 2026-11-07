"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/content/x.js"), "utf8");
const TARGET = "https://x.com/Smlay_ero/status/2118725024416968927";
const OTHER = "https://x.com/other/status/2118725024416968928";
const RUN = "like-recapture-run";

class Element {
  constructor(tag, attrs = {}, text = "") {
    this.tagName = tag.toUpperCase(); this.attrs = attrs; this.text = text;
    this.children = []; this.parentElement = null; this.visible = true; this.isConnected = true;
    this.classList = {contains: value => (this.attrs.class || "").split(/\s+/).includes(value)};
  }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } return this; }
  get innerText() { return [this.text, ...this.children.map(n => n.innerText)].filter(Boolean).join(" "); }
  get textContent() { return this.innerText; }
  get disabled() { return "disabled" in this.attrs; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  matches(selector) {
    return selector.split(",").some(part => {
      const segments = part.trim().split(/\s+/);
      const simple = (node, value) => {
        const tag = value.match(/^[\w-]+/);
        if (tag && tag[0].toUpperCase() !== node.tagName) return false;
        for (const match of value.matchAll(/\.([\w-]+)/g)) if (!node.classList.contains(match[1])) return false;
        for (const match of value.matchAll(/\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/g)) {
          if (!(match[1] in node.attrs) || (match[2] !== undefined && node.attrs[match[1]] !== match[2])) return false;
        }
        return true;
      };
      if (!simple(this, segments.pop())) return false;
      let ancestor = this.parentElement;
      while (segments.length) {
        const expected = segments.pop();
        while (ancestor && !simple(ancestor, expected)) ancestor = ancestor.parentElement;
        if (!ancestor) return false;
        ancestor = ancestor.parentElement;
      }
      return true;
    });
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) { return this.children.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getBoundingClientRect() { return {left: 100, top: 100, right: 600, bottom: 400, width: this.visible && this.isConnected ? 500 : 0, height: 300}; }
  scrollIntoView() {}
  click() { this.onClick?.(); }
  dispatchEvent() { this.onClick?.(); return true; }
}
const el = (tag, className, text = "") => new Element(tag, {class: className}, text);

// Production listener, RUN_X_REPLY cache, native like state, completion loop,
// selectors and click/cancellation guards. Only browser rendering, time and
// unrelated composer preparation are simulated.
function page(options = {}) {
  let listener, elapsed = 0;
  const body = new Element("body"), location = {href: TARGET};
  const calls = {unlike: 0, like: 0, submit: 0, other: 0, stale: 0, ai: 0, post: 0};
  const f = {body, location, calls, events: [], article: null, button: null, panel: null};
  const cancel = () => listener({type: "CANCEL_X_RUN", runId: RUN}, {}, () => {});
  const disconnect = node => { node.isConnected = false; node.children.forEach(disconnect); };
  function setLikeDone() {
    f.likeBadge.text = "已完成";
    delete f.verify.attrs.disabled;
    f.verify.attrs.class = "lh-cur-btn on";
    f.verify.text = "验证发奖";
  }
  function createArticle(url, current, liked = true) {
    const article = new Element("article", {"data-testid": "tweet", ...(current ? {tabindex: "-1"} : {})});
    article.append(new Element("a", {href: url}).append(new Element("time")));
    const button = new Element("button", {"data-testid": liked ? "unlike" : "like"});
    button.onClick = () => {
      if (!button.isConnected) { calls.stale++; return; }
      if (!current) { calls.other++; return; }
      const action = button.attrs["data-testid"];
      calls[action]++; f.events.push({action, at: elapsed});
      if (action === "unlike") {
        if (!options.unlikeUnconfirmed) button.attrs["data-testid"] = "like";
        if (options.rerenderAfterUnlike) {
          disconnect(article); body.children = body.children.filter(node => node !== article);
          body.append(createArticle(TARGET, true, false));
        }
        if (options.cancelAfterUnlike) cancel();
        if (options.changeTargetAfterUnlike) location.href = OTHER;
      } else {
        if (!options.likeUnconfirmed) button.attrs["data-testid"] = "unlike";
        if (!options.officialNeverSync && (!options.likeUnconfirmed || options.unlockOnLikeAttempt)) setLikeDone();
      }
    };
    article.append(button);
    if (current) { f.article = article; f.button = button; }
    return article;
  }
  body.append(createArticle(OTHER, false), createArticle(TARGET, true, options.alreadyLiked !== false));
  f.createArticle = createArticle;
  const head = el("div", "lh-cur-head").append(el("span", "lh-cur-eyebrow", "当前任务"), el("span", "lh-cur-pill", "进行中"));
  const row = el("li", "lh-cur-item");
  f.likeBadge = el("span", "lh-cur-item-badge", "待完成");
  row.append(el("span", "lh-cur-item-label", "点赞"), f.likeBadge);
  const todo = el("ul", "lh-cur-todo").append(row);
  if (options.comment) todo.append(el("li", "lh-cur-item").append(el("span", "lh-cur-item-label", "评论"), el("span", "lh-cur-item-badge", "待完成")));
  const dwell = el("div", "lh-cur-dwell-row").append(el("span", "", "停留时长"), el("span", "r", "50/10s"));
  f.verify = new Element("button", {class: "lh-cur-btn off", disabled: ""}, "完成上面步骤解锁");
  f.verify.onClick = () => { calls.submit++; f.verify.text = "验证中"; f.verify.attrs.disabled = ""; };
  f.panel = el("section", "lh-cur-sec").append(head, el("div", "lh-cur-reward", "+0.1 LUX"), el("div", "lh-cur-todo-label", "要完成"), todo, dwell, f.verify);
  body.append(f.panel);
  f.setLikeDone = setLikeDone;
  f.setOrderDone = () => { head.children[1].text = "已完成"; head.children[1].attrs.class = "lh-cur-pill lh-cur-pill-done"; todo.children = []; f.verify.text = "打开任务广场"; };
  class FakeDate extends Date { static now() { return 100000 + elapsed; } }
  const tick = async ms => { elapsed += ms; options.onWait?.(f, cancel, elapsed); };
  const context = vm.createContext({console, URL, Date: FakeDate, location, window: {}, f,
    document: {body, querySelectorAll: selector => body.querySelectorAll(selector), querySelector: selector => body.querySelector(selector), elementFromPoint: () => null},
    getComputedStyle: () => ({display: "block", visibility: "visible"}),
    setTimeout(fn, ms) { elapsed += ms; queueMicrotask(fn); return 1; }, clearTimeout() {}, tick,
    chrome: {runtime: {onMessage: {addListener(fn) { listener = fn; }}, async sendMessage(message) {
      if (message.type === "CONTENT_LOG") return {ok: true};
      if (message.type === "GENERATE_AI_REPLY") { calls.ai++; return options.aiFails ? {ok: false, error: "fixture AI failure"} : {ok: true, replyText: "fixture reply"}; }
      throw new Error(`Unexpected message ${message.type}`);
    }}},
    fetch: async () => { throw new Error("No network in like recapture tests"); }
  });
  const adapters = `
    function startTaskWidgetAssist() {}
    waitForPageReady = async () => {};
    assertNotLoginWall = () => {};
    scrapeCurrentTweet = () => ({url: location.href, text: "fixture tweet"});
    simulateReadingBeforeReply = async () => {};
    wait = tick;
    randomClickDelay = () => tick(500);
    findLighthouseTaskWidget = () => f.panel;
    revealTaskWidgetArea = async () => f.panel;
    detectExistingReplyBeforeWriting = async () => ({replied: false});
    openReplyComposer = async () => {};
    fillReplyText = async () => {};
    clickPostButtonAndVerify = async () => { f.calls.post++; return {ok: true}; };
  `;
  const end = source.lastIndexOf("})();");
  vm.runInContext(source.slice(0, end) + adapters + source.slice(end), context);
  const task = {taskKey: "like-recapture-order", tweetUrl: TARGET, taskType: options.comment ? "评论+点赞" : "点赞", seatLocked: true};
  const send = (type = "RUN_X_REPLY", patch = {}) => new Promise(resolve => listener({type, platform: "lighthouse", runId: RUN,
    task: {...task, ...patch.task}, settings: {replyMode: "post", replyProvider: "native", ...patch.settings},
    ...Object.fromEntries(Object.entries(patch).filter(([key]) => !["task", "settings"].includes(key)))}, {}, resolve));
  return {f, calls, task, send, elapsed: () => elapsed};
}

test("pending official like recaptures an existing native like once, then submits through the unlocked official button", async () => {
  const p = page();
  const reply = await p.send();
  assert.equal(reply.ok, true, reply.message);
  assert.equal(reply.like.status, "already_liked");
  const started = p.elapsed();
  const result = await p.send("COMPLETE_X_TASK_WIDGET");
  assert.equal(result.ok, true, result.message);
  assert.equal(result.submitted, true);
  assert.deepEqual(p.f.events.map(event => event.action), ["unlike", "like"]);
  assert.ok(p.f.events[0].at - started >= 1500, "allow the official capture to synchronize before undoing a like");
  assert.equal(p.f.button.getAttribute("data-testid"), "unlike");
  assert.equal(p.calls.submit, 1);
  assert.equal(p.calls.other + p.calls.stale, 0);
});

test("unconfirmed unlike stops without a second social action or official submission", async () => {
  const p = page({unlikeUnconfirmed: true});
  await p.send();
  const result = await p.send("COMPLETE_X_TASK_WIDGET");
  assert.equal(result.ok, false);
  assert.equal(p.calls.unlike, 1);
  assert.equal(p.calls.like + p.calls.submit, 0);
  assert.deepEqual(await p.send("COMPLETE_X_TASK_WIDGET"), result);
  assert.equal(p.calls.unlike, 1, "retrying verification must not replay the failed pair");
});

test("an official like already acknowledged before verification is never undone", async () => {
  const p = page();
  await p.send();
  p.f.setLikeDone();
  const result = await p.send("COMPLETE_X_TASK_WIDGET");
  assert.equal(result.ok, true, result.message);
  assert.equal(result.submitted, true);
  assert.equal(p.calls.unlike + p.calls.like, 0);
  assert.equal(p.calls.submit, 1);
});

test("official acknowledgement during the synchronization grace period prevents undoing the like", async () => {
  const p = page({onWait(f, _cancel, elapsed) { if (elapsed >= 1000) f.setLikeDone(); }});
  await p.send();
  const result = await p.send("COMPLETE_X_TASK_WIDGET");
  assert.equal(result.ok, true, result.message);
  assert.equal(p.calls.submit, 1);
  assert.equal(p.calls.unlike + p.calls.like, 0);
});

test("a late official panel gets its own synchronization grace period before recapture", async () => {
  let pendingPanel;
  const p = page({onWait(f, _cancel, elapsed) {
    if (elapsed >= 2000 && !f.panel) { f.panel = pendingPanel; f.body.append(pendingPanel); }
    if (elapsed >= 3000) f.setLikeDone();
  }});
  await p.send();
  pendingPanel = p.f.panel;
  p.f.body.children = p.f.body.children.filter(node => node !== pendingPanel);
  p.f.panel = null;
  const result = await p.send("COMPLETE_X_TASK_WIDGET");
  assert.equal(result.ok, true, result.message);
  assert.equal(p.calls.submit, 1);
  assert.equal(p.calls.unlike + p.calls.like, 0, "official capture settled within 1000 ms of the panel appearing");
});

test("official acknowledgement during the pre-click delay prevents canceling the existing like", async () => {
  const p = page({onWait(f, _cancel, elapsed) { if (elapsed >= 1800) f.setLikeDone(); }});
  await p.send();
  const result = await p.send("COMPLETE_X_TASK_WIDGET");
  assert.equal(result.ok, true, result.message);
  assert.equal(p.calls.unlike + p.calls.like, 0);
  assert.equal(p.calls.submit, 1);
});

test("whole-order completion arriving during the grace period returns without social actions or submission", async () => {
  const p = page({onWait(f, _cancel, elapsed) { if (elapsed >= 1000) f.setOrderDone(); }});
  await p.send();
  const result = await p.send("COMPLETE_X_TASK_WIDGET");
  assert.equal(result.ok, true, result.message);
  assert.equal(result.alreadySubmitted, true);
  assert.equal(p.calls.unlike + p.calls.like + p.calls.submit, 0);
});

test("parallel and later verification requests share one native recapture and one official submission", async () => {
  const p = page();
  await p.send();
  const [first, duplicate] = await Promise.all([p.send("COMPLETE_X_TASK_WIDGET"), p.send("CLICK_X_TASK_VERIFY")]);
  assert.equal(first.ok, true, first.message);
  assert.deepEqual(duplicate, first);
  assert.deepEqual(await p.send("COMPLETE_X_TASK_WIDGET"), first);
  assert.equal(p.calls.unlike, 1);
  assert.equal(p.calls.like, 1);
  assert.equal(p.calls.submit, 1);
});

test("a newly applied native like is not undone when the official capture remains pending", async () => {
  const p = page({alreadyLiked: false, officialNeverSync: true});
  const reply = await p.send();
  assert.equal(reply.ok, true, reply.message);
  assert.equal(reply.like.status, "liked");
  const result = await p.send("COMPLETE_X_TASK_WIDGET");
  assert.equal(result.ok, false);
  assert.equal(p.calls.like, 1);
  assert.equal(p.calls.unlike + p.calls.submit, 0);
});

test("verification with no successful same-run action cannot toggle an existing like", async () => {
  const p = page();
  const result = await p.send("COMPLETE_X_TASK_WIDGET");
  assert.equal(result.ok, false);
  assert.equal(p.calls.unlike + p.calls.like + p.calls.submit, 0);
});

for (const [label, patch] of [
  ["different run", {runId: "another-run"}],
  ["different order", {task: {taskKey: "another-order"}}],
  ["unclaimed order", {task: {seatLocked: false, claimed: false, invitationAccepted: false}}],
  ["different platform", {platform: "xinhuo"}]
]) {
  test(`${label} cannot reuse a successful action to authorize native recapture`, async () => {
    const p = page();
    await p.send();
    const result = await p.send("COMPLETE_X_TASK_WIDGET", patch);
    assert.equal(result.ok, false);
    assert.equal(p.calls.unlike + p.calls.like + p.calls.submit, 0);
  });
}

test("an AI failure after observing an existing like cannot authorize recapture", async () => {
  const p = page({comment: true, aiFails: true});
  const reply = await p.send();
  assert.equal(reply.ok, false);
  assert.equal(p.calls.ai, 1);
  const result = await p.send("COMPLETE_X_TASK_WIDGET");
  assert.equal(result.ok, false);
  assert.equal(p.calls.unlike + p.calls.like + p.calls.submit, 0);
});

test("a fill-only reply does not authorize native recapture", async () => {
  const p = page({comment: true});
  const reply = await p.send("RUN_X_REPLY", {settings: {replyMode: "fill"}});
  assert.equal(reply.ok, true, reply.message);
  assert.equal(reply.mode, "fill");
  const result = await p.send("COMPLETE_X_TASK_WIDGET");
  assert.equal(result.ok, false);
  assert.equal(p.calls.unlike + p.calls.like + p.calls.submit + p.calls.post, 0);
});

test("unconfirmed restoration blocks official submission even if the official button becomes enabled", async () => {
  const p = page({likeUnconfirmed: true, unlockOnLikeAttempt: true});
  await p.send();
  const result = await p.send("COMPLETE_X_TASK_WIDGET");
  assert.equal(result.ok, false);
  assert.equal(p.calls.unlike, 1);
  assert.equal(p.calls.like, 1);
  assert.equal(p.f.button.getAttribute("data-testid"), "like");
  assert.equal(p.f.verify.disabled, false, "fixture simulates an independently enabled official button");
  assert.equal(p.calls.submit, 0);
  assert.deepEqual(await p.send("COMPLETE_X_TASK_WIDGET"), result);
  assert.equal(p.calls.unlike + p.calls.like, 2);
});

for (const [label, options] of [
  ["STOP", {cancelAfterUnlike: true}],
  ["navigation to another tweet", {changeTargetAfterUnlike: true}]
]) {
  test(`${label} between native actions prevents re-like and official submission`, async () => {
    const p = page(options);
    await p.send();
    const result = await p.send("COMPLETE_X_TASK_WIDGET");
    assert.equal(result.ok, false);
    assert.equal(p.calls.unlike, 1);
    assert.equal(p.calls.like + p.calls.submit, 0);
  });
}

test("rerender after unlike restores the like through the fresh target control", async () => {
  const p = page({rerenderAfterUnlike: true});
  await p.send();
  const oldButton = p.f.button;
  const result = await p.send("COMPLETE_X_TASK_WIDGET");
  assert.equal(result.ok, true, result.message);
  assert.equal(oldButton.isConnected, false);
  assert.notEqual(p.f.button, oldButton);
  assert.deepEqual(p.f.events.map(event => event.action), ["unlike", "like"]);
  assert.equal(p.calls.submit, 1);
  assert.equal(p.calls.other + p.calls.stale, 0);
});

test("rerender during the pre-unlike delay never clicks the obsolete native control", async () => {
  let replaced = false;
  const p = page({onWait(f, _cancel, elapsed) {
    if (elapsed < 1800 || replaced) return;
    replaced = true;
    const article = f.article;
    article.isConnected = false;
    f.button.isConnected = false;
    f.body.children = f.body.children.filter(node => node !== article);
    f.body.append(f.createArticle(TARGET, true));
  }});
  await p.send();
  const result = await p.send("COMPLETE_X_TASK_WIDGET");
  assert.equal(result.ok, true, result.message);
  assert.equal(replaced, true);
  assert.deepEqual(p.f.events.map(event => event.action), ["unlike", "like"]);
  assert.equal(p.calls.other + p.calls.stale, 0);
  assert.equal(p.calls.submit, 1);
});

test("a replaced official order panel between native actions blocks re-like and submission", async () => {
  let replaced = false;
  const p = page({onWait(f) {
    if (!f.calls.unlike || replaced) return;
    replaced = true;
    const oldPanel = f.panel;
    oldPanel.isConnected = false;
    f.body.children = f.body.children.filter(node => node !== oldPanel);
    f.panel = el("section", "lh-cur-sec").append(...oldPanel.children);
    f.body.append(f.panel);
  }});
  await p.send();
  const result = await p.send("COMPLETE_X_TASK_WIDGET");
  assert.equal(result.ok, false);
  assert.equal(replaced, true);
  assert.equal(p.calls.unlike, 1);
  assert.equal(p.calls.like + p.calls.submit, 0);
});

test("global STOP before the first native action prevents every social action and submission", async () => {
  let stopped = false;
  const p = page({onWait(_f, _cancel, elapsed) {
    if (elapsed < 1800 || stopped) return;
    stopped = true;
    p.send("AUTOMATION_PAUSE_CHANGED", {paused: true});
  }});
  await p.send();
  const result = await p.send("COMPLETE_X_TASK_WIDGET");
  assert.equal(result.ok, false);
  assert.equal(stopped, true);
  assert.equal(p.calls.unlike + p.calls.like + p.calls.submit, 0);
});

test("official capture staying pending permits only one recapture pair, not a loop", async () => {
  const p = page({officialNeverSync: true});
  await p.send();
  const result = await p.send("COMPLETE_X_TASK_WIDGET");
  assert.equal(result.ok, false);
  assert.deepEqual(p.f.events.map(event => event.action), ["unlike", "like"]);
  assert.equal(p.calls.submit, 0);
  assert.deepEqual(await p.send("COMPLETE_X_TASK_WIDGET"), result);
  assert.equal(p.calls.unlike + p.calls.like, 2);
});

for (const [label, prepare] of [
  ["wrong timestamp", f => { f.article.querySelector("a").attrs.href = OTHER; }],
  ["quoted target timestamp", f => {
    const link = f.article.children.shift();
    f.article.append(new Element("div", {"data-testid": "quoteTweet"}).append(link));
  }],
  ["duplicate target articles", f => { f.body.append(f.createArticle(TARGET, true)); }],
  ["duplicate native controls", f => {
    const duplicate = new Element("button", {"data-testid": "unlike"});
    duplicate.onClick = () => { f.calls.other++; };
    f.article.append(duplicate);
  }],
  ["disabled native control", f => { f.button.attrs.disabled = ""; }],
  ["native control inside a quoted tweet", f => {
    f.article.children = f.article.children.filter(node => node !== f.button);
    f.article.append(new Element("div", {"data-testid": "quoteTweet"}).append(f.button));
  }]
]) {
  test(`${label} prevents recapture from touching an ambiguous or unrelated target`, async () => {
    const p = page();
    await p.send();
    prepare(p.f);
    const result = await p.send("COMPLETE_X_TASK_WIDGET");
    assert.equal(result.ok, false);
    assert.equal(p.calls.unlike + p.calls.like + p.calls.submit + p.calls.other + p.calls.stale, 0);
  });
}
