"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const RUN = "live-batch-refusal-run";
const INTENT = "live-batch-refusal-intent";
const REFUSAL = "本批名额暂不可领取，请约 1 分钟后重试。";
const TARGET = "https://x.com/fixture/status/123";
const GUIDE = [
  "评论任务 验证通过即到账",
  "回来提交验证 验证通过 LUX 即时到账",
  "按你的 Tier D- 计酬，验证通过即到账",
];
const source = fs.readFileSync(path.join(process.env.LIGHTHOUSE_TEST_SOURCE_ROOT || path.join(__dirname, "../src"), "content/lighthouse.js"), "utf8");

function node(text, options = {}) {
  return {
    innerText: text, textContent: text, isConnected: true, visible: true,
    disabled: false, control: false, href: "", ...options,
    getAttribute(name) { return name === "href" ? this.href : ""; },
    matches() { return this.control; },
    scrollIntoView() {},
  };
}

// Adapted from lock-confirmation.test.cjs. The production listener, clickable
// lock lookup, click dispatch, feedback collector and receipt checks all run.
// Only the DOM, navigation prerequisites and clock are local fixtures.
function page(options = {}) {
  let listener, now = 1000000;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const observers = new Set();
  const fixture = {
    clicks: 0, reports: [], nodes: [], notices: options.initialNotices || [], root: null,
    get elapsedMs() { return now - 1000000; },
    notify(text) { this.notices.push(node(text)); for (const observer of observers) observer.callback(); },
    clearNotices() { this.notices = []; for (const observer of observers) observer.callback(); },
    observers,
  };
  const button = node("锁定席位 · Tier D-", { control: true, click() {
    fixture.clicks++;
    options.onClick?.(fixture, button);
  } });
  const guide = options.withGuide === false ? [] : GUIDE.map(text => node(text));
  fixture.nodes.push(button, ...guide, node("在 X 打开", { control: true }), ...(options.initialNodes || []));
  fixture.root = {
    title: "把行为数据化成链上资产", isConnected: true, visible: true,
    get innerText() { return `${this.title} 评论任务 0.1 LUX 当前可抢 3 席 ${fixture.nodes.map(n => n.innerText).join(" ")}`; },
    querySelectorAll(selector) {
      if (selector === "a[href]") return fixture.nodes.filter(n => n.href);
      if (selector.includes("h1,h2,h3")) return [node(this.title)];
      return fixture.nodes;
    },
    contains(target) { return fixture.nodes.includes(target); },
  };
  const body = { get innerText() { return fixture.root.innerText; } };
  const context = vm.createContext({
    console, URL, Date: Clock, AbortController, setTimeout, clearTimeout, fixture,
    document: { body, querySelectorAll(selector) {
      if (selector.includes("data-rht-toaster")) return fixture.notices;
      if (selector === "button,a,[role='button'],input[type='button'],input[type='submit']") return fixture.nodes.filter(n => n.control);
      return fixture.nodes;
    } },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() { observers.add(this); }
      disconnect() { observers.delete(this); }
    },
    location: { href: "https://app.lhdao.top/campaigns", pathname: "/campaigns" },
    window: { addEventListener() {} },
    fixtureWait: async ms => { now += ms; await options.onWait?.(fixture, button); },
    fetch: async () => { throw new Error("Network forbidden in live batch refusal tests"); },
    chrome: { runtime: {
      onMessage: { addListener(fn) { listener = fn; } },
      async sendMessage(message) { fixture.reports.push(message); return { ok: true, paused: false }; },
    } },
  });
  const adapters = `
    findTaskDetailRoot = () => fixture.root;
    isTaskDetailOpen = () => true;
    isVisible = node => Boolean(node && node.visible && node.isConnected);
    isDisabled = node => node.disabled;
    confirmPagePhase = async () => ({ phase: "detail_ready" });
    acceptInvitationIfPresent = async () => false;
    confirmLighthouseGuidanceBeforeClaim = async () => false;
    getLighthousePreClaimNoticeButton = () => null;
    hasDetailRequestTimeout = () => false;
    assertSupportedDetailTask = () => {};
    buildTask = () => ({ taskKey: "detail-order", title: fixture.root.title,
      taskType: "评论", detailText: fixture.root.innerText, tweetUrl: extractTweetUrl(fixture.root) });
    debugOpenFirstCommentTask = async () => ({ ok: true, task: { taskKey: "selected-order", title: fixture.root.title } });
    wait = fixtureWait;
  `;
  const end = source.lastIndexOf("})();");
  vm.runInContext(source.slice(0, end) + adapters + source.slice(end), context);
  return { fixture, button,
    dispatch(type = "DEBUG_LOCK_SEAT_AND_EXTRACT") {
      return new Promise(resolve => listener({ type, runId: RUN, claimIntentId: INTENT,
        settings: { actionDelayMs: 500, cooldownPollMs: 250 }, selectedTask: {} }, {}, resolve));
    },
  };
}

function makeBusy(button, label = "正在预定席位…") {
  button.innerText = button.textContent = label;
  button.disabled = true;
}

function assertRejected(result, p, route) {
  assert.equal(result.ok, false);
  assert.equal(result.claimActionAttempted, true);
  assert.equal(result.task?.claimRejected, true, result.message);
  assert.equal(result.task?.seatLocked, false);
  assert.equal(result.retryAfterMs, 60000);
  assert.equal(result.claimRetryScope, "task");
  assert.equal(result.claimRejection?.runId, RUN);
  assert.equal(result.claimRejection?.claimIntentId, INTENT);
  assert.equal(result.claimRejection?.type, route);
  assert.equal(result.claimRejection?.taskKey, result.task.taskKey);
  assert.equal(result.task.taskKey, route === "START_LIGHTHOUSE_COMMENT_TASK" ? "selected-order" : "detail-order");
  assert.equal(p.fixture.clicks, 1);
  assert.equal(p.fixture.observers.size, 0);
  assert.ok(p.fixture.reports.some(report => JSON.stringify(report).includes(REFUSAL)));
}

function assertUncertain(result, p) {
  assert.equal(result.ok, false);
  assert.equal(result.claimActionAttempted, true);
  assert.equal(result.claimRejection, undefined);
  assert.notEqual(result.task?.claimRejected, true);
  assert.notEqual(result.task?.seatLocked, true);
  assert.match(result.message, /未确认.*锁位|锁位.*未确认/);
  assert.equal(p.fixture.clicks, 1);
  assert.equal(p.fixture.observers.size, 0);
}

// The user explicitly restored the conservative contract: even fresh refusal
// feedback cannot release a claim until the lock control is clickable again.
for (const route of ["DEBUG_LOCK_SEAT_AND_EXTRACT", "WAIT_SELECTED_COUNTDOWN_AND_LOCK", "START_LIGHTHOUSE_COMMENT_TASK"]) {
  test(`${route}: real static guidance and fresh batch refusal release a clickable lock`, async () => {
    const p = page({ onClick(f) {
      f.notify(REFUSAL);
      f.clearNotices();
    } });
    assertRejected(await p.dispatch(route), p, route);
  });
  for (const label of ["正在预定席位…", "正在锁定席位…"]) {
    test(`${route}: fresh refusal with persistent ${label} remains uncertain`, async () => {
      const p = page({ onClick(f, button) {
        makeBusy(button, label);
        f.notify(REFUSAL);
        f.clearNotices();
      } });
      assertUncertain(await p.dispatch(route), p);
    });
    test(`${route}: fresh refusal waits for ${label} to become clickable again`, async () => {
      let clickedAt = null, recovered = false;
      const p = page({ onClick(f, button) {
        clickedAt = f.elapsedMs;
        makeBusy(button, label);
        f.notify(REFUSAL);
        f.clearNotices();
      }, onWait(f, button) {
        if (clickedAt !== null && f.elapsedMs - clickedAt >= 1800) {
          button.innerText = button.textContent = "锁定席位 · Tier D-";
          button.disabled = false;
          recovered = true;
        }
      } });
      assertRejected(await p.dispatch(route), p, route);
      assert.equal(recovered, true, "a busy claim must not be released before the control becomes clickable");
      assert.ok(p.fixture.elapsedMs - clickedAt >= 1800, "the virtual clock must reach control recovery before rejection");
    });
  }
}

test("fresh batch refusal with a busy control remains uncertain without static success wording", async () => {
  const p = page({ withGuide: false, onClick(f, button) { makeBusy(button); f.notify(REFUSAL); } });
  assertUncertain(await p.dispatch(), p);
});

for (const scenario of ["no refusal", "stale refusal", "generic error", "other detail feedback", "changed detail", "replacement detail", "old locked status"]) {
  test(`busy lock remains protected with real guidance and ${scenario}`, async () => {
    const p = page({
      initialNotices: scenario === "stale refusal" ? [node(REFUSAL)] : [],
      initialNodes: scenario === "old locked status" ? [node("席位已锁定")] : [],
      onClick(f, button) {
        makeBusy(button);
        if (scenario === "no refusal" || scenario === "stale refusal") return;
        if (scenario === "other detail feedback" || scenario === "changed detail") f.root.title = "另一任务";
        if (scenario === "replacement detail") f.root = { ...f.root };
        f.notify(scenario === "generic error" ? "操作失败，请稍后重试。" : REFUSAL);
        if (scenario === "other detail feedback") f.root.title = "把行为数据化成链上资产";
      },
    });
    const result = await p.dispatch();
    assert.equal(result.ok, false);
    assert.equal(result.claimActionAttempted, true);
    assert.equal(result.claimRejection, undefined);
    assert.notEqual(result.task?.claimRejected, true);
    assert.notEqual(result.task?.seatLocked, true);
    assert.equal(p.fixture.clicks, 1);
    assert.equal(p.fixture.observers.size, 0);
  });
}

for (const withRefusal of [false, true]) {
  test(`new exact-order lock evidence wins over static guidance (fresh refusal: ${withRefusal})`, async () => {
    const p = page({ onClick(f, button) {
      makeBusy(button);
      if (withRefusal) {
        f.notify(REFUSAL);
        f.nodes.push(node("席位已锁定"));
      }
    }, onWait(f) {
      if (f.clicks && !f.nodes.some(n => n.innerText === "席位已锁定")) f.nodes.push(node("席位已锁定"));
    } });
    const result = await p.dispatch();
    assert.equal(result.ok, true, result.message);
    assert.equal(result.task?.seatLocked, true);
    assert.equal(result.claimRejection, undefined);
    assert.equal(p.fixture.clicks, 1);
    assert.equal(p.fixture.observers.size, 0);
  });
}

test("an already locked exact target resumes without another claim despite static guidance", async () => {
  const p = page({ initialNodes: [node("席位已锁定"), node("去 X 完成动作", { control: true, href: TARGET })] });
  p.fixture.nodes = p.fixture.nodes.filter(n => n !== p.button);
  const result = await p.dispatch();
  assert.equal(result.ok, true, result.message);
  assert.equal(result.task?.seatLocked, true);
  assert.equal(result.task?.resumedLockedTask, true);
  assert.equal(result.claimRejection, undefined);
  assert.equal(p.fixture.clicks, 0);
});
