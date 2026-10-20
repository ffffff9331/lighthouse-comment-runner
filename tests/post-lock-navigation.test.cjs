"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const RUN = "post-lock-run";
const TARGET = "https://x.com/current/status/2110664701864444362";
const ALIAS = "https://x.com/i/status/2110664701864444362";
const MESSAGE = "CONFIRM_LIGHTHOUSE_LOCKED_TASK_NOTICE";
const source = fs.readFileSync(path.join(process.env.LIGHTHOUSE_TEST_SOURCE_ROOT || path.join(__dirname, "../src"), "content/lighthouse.js"), "utf8");

function node(text, options = {}) {
  return { innerText: text, textContent: text, visible: true, isConnected: true,
    disabled: false, control: false, href: "", parentElement: null, ...options,
    getAttribute(name) { return name === "href" ? this.href : ""; },
    matches() { return this.control; },
    scrollIntoView() {},
  };
}

// Real content listener, claim receipt, post-lock navigation and STOP handling.
// DOM layout, navigation prerequisites and elapsed time are simulated only.
function page(options = {}) {
  let listener, now = 1000000;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const f = { nodes: [], notice: null, claimClicks: 0, navigationClicks: 0,
    reports: [], beforeWait: null, get elapsedMs() { return now - 1000000; } };
  f.root = {
    title: "Current order", visible: true, isConnected: true,
    get innerText() { return `${this.title} 评论任务 0.1 LUX ${f.nodes.map(n => n.innerText).join(" ")}`; },
    querySelectorAll(selector) {
      if (selector === "a[href]") return f.nodes.filter(n => n.href);
      if (selector.includes("h1,h2,h3")) return [node(this.title)];
      return f.nodes;
    },
    contains(target) { return f.nodes.includes(target); },
  };
  const installLocked = () => {
    f.nodes = [node("席位已锁定"), node("去 X 完成动作", { control: true }),
      node("没有自动打开？点此直接前往目标", { control: true, href: TARGET })];
  };
  const showNotice = (extra = {}) => {
    const scope = node(extra.heading || "席位已预订，请确认任务提醒 认真评论，避免仅退款 目标推文包含外部链接 稍后前往 已了解，前往 X");
    const button = node(extra.label || "已了解，前往 X", { control: true, disabled: Boolean(extra.disabled), parentElement: scope,
      click() { f.navigationClicks++; options.onNavigate?.(f); } });
    f.notice = { scope, button };
    return f.notice;
  };
  const lock = node("锁定席位", { control: true, click() {
    f.claimClicks++;
    installLocked();
    if (options.noticeOnClaim !== false) showNotice();
  } });
  f.nodes = [lock, node("在 X 打开", { control: true })];
  if (options.alreadyLocked) installLocked();
  const body = { get innerText() { return `${f.root.innerText} ${f.notice?.scope.innerText || ""}`; } };
  const c = vm.createContext({ console, URL, Date: Clock, setTimeout, clearTimeout, AbortController, fixture: f,
    document: { body, querySelectorAll(selector) {
      if (selector.includes("data-rht-toaster") || selector === "[role='dialog'],main,section,article,div") return [];
      return [...f.nodes, ...(f.notice ? [f.notice.button] : [])];
    } },
    location: { href: "https://app.lhdao.top/campaigns", pathname: "/campaigns" },
    window: { addEventListener() {} },
    fixtureWait: async ms => { now += ms; await f.beforeWait?.(ms); },
    fetch: async () => { throw Error("Network forbidden in post-lock navigation tests"); },
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } },
      async sendMessage(message) { f.reports.push(message); return { ok: true, paused: false }; } } },
  });
  const end = source.lastIndexOf("})();");
  vm.runInContext(source.slice(0, end) + `
    findTaskDetailRoot = () => fixture.root;
    isTaskDetailOpen = () => true;
    isVisible = node => Boolean(node && node.visible && node.isConnected);
    isDisabled = node => node.disabled;
    confirmPagePhase = async () => ({phase: "detail_ready"});
    acceptInvitationIfPresent = async () => false;
    hasDetailRequestTimeout = () => false;
    assertSupportedDetailTask = () => {};
    buildTask = () => ({ taskKey: "current-order", title: fixture.root.title,
      taskType: "评论", detailText: fixture.root.innerText, tweetUrl: extractTweetUrl(fixture.root) });
    wait = fixtureWait;
    globalThis.identityApi = {normalizeTweetUrl};
  ` + source.slice(end), c);
  const dispatch = message => new Promise(resolve => {
    if (!listener(message, {}, resolve)) resolve({ ok: false, unhandled: true });
  });
  return { f, showNotice, identity: c.identityApi,
    claim: async () => {
      const result = await dispatch({ type: "DEBUG_LOCK_SEAT_AND_EXTRACT", runId: RUN, claimIntentId: "claim-intent", settings: { actionDelayMs: 500 } });
      assert.equal(result.ok, true, result.message);
      assert.equal(result.task.seatLocked, true);
      return result.task;
    },
    confirm: (task, extra = {}) => dispatch({ type: MESSAGE, runId: RUN, task, ...extra }),
    pause: () => dispatch({ type: "AUTOMATION_PAUSE_CHANGED", paused: true }),
    watch: task => dispatch({ type: "BEGIN_LIGHTHOUSE_COMPLETION_WATCH", runId: RUN, task }),
  };
}

test("same locked order confirms the exact post-lock notice once without another claim", async () => {
  const p = page(), task = await p.claim();
  const result = await p.confirm(task);
  assert.equal(result.ok, true);
  assert.equal(result.noticePresent, true);
  assert.equal(result.noticeClicked, true);
  assert.equal(result.taskKey, task.taskKey);
  assert.equal(result.tweetUrl, task.tweetUrl);
  assert.equal(p.f.claimClicks, 1);
  assert.equal(p.f.navigationClicks, 1);
});

test("a notice appearing after lock success is handled on the next navigation poll", async () => {
  const p = page({ noticeOnClaim: false }), task = await p.claim();
  const first = await p.confirm(task);
  assert.equal(first.ok, true);
  assert.equal(first.noticePresent, false);
  assert.equal(p.f.navigationClicks, 0);
  p.showNotice();
  assert.equal((await p.confirm(task)).noticeClicked, true);
  assert.equal(p.f.navigationClicks, 1);
});

test("repeated, concurrent and rerendered notice messages cannot click twice", async () => {
  const p = page(), task = await p.claim();
  const results = await Promise.all([p.confirm(task), p.confirm(task)]);
  assert.ok(results.every(result => result.ok));
  assert.equal(p.f.navigationClicks, 1);
  p.showNotice();
  const repeat = await p.confirm(task);
  assert.equal(repeat.alreadyConfirmed, true);
  assert.equal(repeat.noticeClicked, false);
  assert.equal(p.f.navigationClicks, 1);
});

test("a disabled post-lock notice waits until its control becomes enabled", async () => {
  const p = page(), task = await p.claim();
  p.showNotice({ disabled: true });
  const waiting = await p.confirm(task);
  assert.equal(waiting.ok, true);
  assert.equal(waiting.pending, true);
  assert.equal(p.f.navigationClicks, 0);
  p.f.notice.button.disabled = false;
  assert.equal((await p.confirm(task)).noticeClicked, true);
  assert.equal(p.f.navigationClicks, 1);
});

test("the notice control is reacquired after its entrance render", async () => {
  const p = page(), task = await p.claim();
  const original = p.f.notice.button;
  p.f.beforeWait = async () => { original.isConnected = false; p.showNotice(); p.f.beforeWait = null; };
  assert.equal((await p.confirm(task)).noticeClicked, true);
  assert.notEqual(p.f.notice.button, original);
  assert.equal(p.f.navigationClicks, 1);
});

for (const when of ["before navigation", "during entrance wait"]) {
  test(`STOP ${when} prevents post-lock navigation`, async () => {
    const p = page(), task = await p.claim();
    if (when === "before navigation") await p.pause();
    else p.f.beforeWait = async () => { p.f.beforeWait = null; await p.pause(); };
    const result = await p.confirm(task);
    assert.equal(result.ok, false);
    assert.equal(result.cancelled, true);
    assert.equal(p.f.navigationClicks, 0);
  });
}

for (const mismatch of ["task key", "target", "run", "title", "replacement root", "missing lock status", "unclaimed task", "changed during wait"]) {
  test(`post-lock notice stays untouched for ${mismatch}`, async () => {
    const p = page(), task = { ...await p.claim() }, extra = {};
    if (mismatch === "task key") task.taskKey = "other-order";
    if (mismatch === "target") task.tweetUrl = "https://x.com/current/status/999";
    if (mismatch === "run") extra.runId = "other-run";
    if (mismatch === "title") p.f.root.title = "Other order";
    if (mismatch === "replacement root") p.f.root = { ...p.f.root };
    if (mismatch === "missing lock status") p.f.nodes = p.f.nodes.filter(n => n.innerText !== "席位已锁定");
    if (mismatch === "unclaimed task") task.seatLocked = false;
    if (mismatch === "changed during wait") p.f.beforeWait = async () => { p.f.root.title = "Other order"; };
    const result = await p.confirm(task, extra);
    assert.equal(result.unhandled, undefined);
    assert.equal(result.ok, false);
    assert.equal(p.f.navigationClicks, 0);
  });
}

for (const other of [
  { heading: "接单前需要注意以下事项 请先阅读下方提醒，再锁定席位 目标推文包含外部链接" },
  { heading: "别的网站弹窗 已了解，前往 X" },
  { label: "确认接单" },
]) {
  test(`unrelated or pre-claim notice is not navigation: ${other.heading || other.label}`, async () => {
    const p = page(), task = await p.claim();
    p.showNotice(other);
    const result = await p.confirm(task);
    assert.equal(result.ok, true);
    assert.equal(result.noticePresent, false);
    assert.equal(p.f.navigationClicks, 0);
  });
}

test("a restored locked order can use the same-order completion watch binding", async () => {
  const p = page({ alreadyLocked: true });
  const task = { taskKey: "restored-order", seatLocked: true, tweetUrl: TARGET };
  p.showNotice();
  assert.equal((await p.watch(task)).ok, true);
  assert.equal((await p.confirm(task)).noticeClicked, true);
  assert.equal(p.f.claimClicks, 0);
  assert.equal(p.f.navigationClicks, 1);
});

test("the same status ID under the official i alias retains the order binding", async () => {
  const p = page(), task = await p.claim();
  p.f.nodes.find(n => n.href).href = ALIAS;
  const result = await p.confirm(task);
  assert.equal(result.ok, true);
  assert.equal(result.noticeClicked, true);
  assert.equal(result.tweetUrl, TARGET, "identity matching must not rewrite the navigation destination");
});

test("tweet identity mode preserves the complete ID and navigation mode keeps the handle", () => {
  const p = page();
  assert.equal(p.identity.normalizeTweetUrl(`${TARGET}?s=20`), TARGET);
  assert.equal(p.identity.normalizeTweetUrl(TARGET, true), ALIAS);
  assert.equal(p.identity.normalizeTweetUrl("https://twitter.com/changed/status/2110664701864444362/photo/1", true), ALIAS);
});

for (const url of [
  `https://evil.test/?u=${TARGET}`,
  "https://x.com.evil.test/current/status/2110664701864444362",
  "https://u:p@x.com/current/status/2110664701864444362",
  "https://x.com:444/current/status/2110664701864444362",
  "http://x.com/current/status/2110664701864444362",
  "https://x.com/current/status/2110664701864444362oops",
]) test(`an invalid target cannot be normalized: ${url}`, () => {
  assert.equal(page().identity.normalizeTweetUrl(url), "");
});

test("without a post-lock notice an obsolete navigation binding does not block the existing X fallback", async () => {
  const p = page({ noticeOnClaim: false }), task = await p.claim();
  p.f.root = { ...p.f.root };
  const result = await p.confirm(task);
  assert.equal(result.ok, true);
  assert.equal(result.noticePresent, false);
  assert.equal(result.noticeClicked, false);
  assert.equal(p.f.navigationClicks, 0);
  p.showNotice();
  const guarded = await p.confirm(task);
  assert.equal(guarded.ok, false, "a real notice still requires a current exact-order binding");
  assert.equal(p.f.navigationClicks, 0);
});
