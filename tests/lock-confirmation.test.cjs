"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const RUN = "lock-confirmation-run";
const INTENT = "lock-confirmation-intent";
const URL_X = "https://x.com/fixture/status/123";
const source = fs.readFileSync(path.join(process.env.LIGHTHOUSE_TEST_SOURCE_ROOT || path.join(__dirname, "../src"), "content/lighthouse.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8"));

function node(text, options = {}) {
  return {
    innerText: text, textContent: text, isConnected: true, visible: true, disabled: false,
    href: "", control: false, ...options,
    getAttribute(name) { return name === "href" ? this.href : ""; },
    matches() { return this.control; },
    scrollIntoView() {},
  };
}

// Real listener, click, lock verification and receipt handling; only DOM/page
// navigation and elapsed time are simulated. No fixture can reach a website.
function page(options = {}) {
  let listener, now = 1000000;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const observers = new Set();
  const fixture = { get elapsedMs() { return now - 1000000; }, releaseAtMs: options.releaseAtMs || 0, clicks: 0, outside: "", reports: [], nodes: [], notices: options.initialNotices || [], root: null,
    elapse(ms) { now += ms; },
    notify(text) { this.notices.push(node(text)); for (const observer of observers) observer.callback(); },
    clearNotices() { this.notices = []; for (const observer of observers) observer.callback(); },
    observers,
  };
  const button = node("锁定席位", { control: true, click() {
    fixture.clicks++;
    options.onClick?.(fixture, button);
  } });
  fixture.nodes.push(button, ...(options.initialNodes || []));
  const root = {
    title: "Fixture order", isConnected: true, visible: true,
    get innerText() { const sec = Math.ceil(Math.max(0, fixture.releaseAtMs - fixture.elapsedMs) / 1000);
      const countdown = sec ? `等待下一批释放 · ${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}` : "";
      return `${countdown} ${this.title} 评论任务 0.1 LUX 当前可抢 0 席 ${fixture.nodes.map(n => n.innerText).join(" ")}`; },
    querySelectorAll(selector) {
      if (selector === "a[href]") return fixture.nodes.filter(n => n.href);
      if (selector.includes("h1,h2,h3")) return [node(this.title)];
      return fixture.nodes;
    },
    contains(target) { return fixture.nodes.includes(target); },
  };
  fixture.root = root;
  const body = { get innerText() { return `${fixture.root.innerText} ${fixture.outside}`; } };
  const context = vm.createContext({
    console, URL, Date: Clock, AbortController, setTimeout, clearTimeout, fixture,
    document: { body, querySelectorAll: selector => selector.includes("data-rht-toaster") ? fixture.notices : fixture.nodes },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() { observers.add(this); }
      disconnect() { observers.delete(this); }
    },
    location: { href: "https://app.lhdao.top/campaigns", pathname: "/campaigns" },
    window: { addEventListener() {} },
    fixtureWait: async ms => { now += ms; await options.onWait?.(fixture, button); },
    fixturePhase: async (_allowed, _settings, label) => options.onPhase?.(fixture, label),
    fetch: async () => { throw new Error("Network forbidden in lock confirmation tests"); },
    chrome: { runtime: {
      onMessage: { addListener(fn) { listener = fn; } },
      async sendMessage(message) { fixture.reports.push(message); return { ok: true, paused: false }; },
    } },
  });
  const adapters = `
    findTaskDetailRoot = () => fixture.root;
    isTaskDetailOpen = () => true;
    findLockButton = () => fixture.elapsedMs < fixture.releaseAtMs ? null : (fixture.nodes.find(node => node.innerText === "锁定席位") || null);
    isVisible = node => Boolean(node && node.visible && node.isConnected);
    isDisabled = node => node.disabled;
    confirmPagePhase = async (...args) => { await fixturePhase(...args); return { phase: "detail_ready" }; };
    acceptInvitationIfPresent = async () => false;
    confirmLighthouseGuidanceBeforeClaim = async () => false;
    getLighthousePreClaimNoticeButton = () => fixture.pendingNotice || null;
    hasDetailRequestTimeout = () => false;
    assertSupportedDetailTask = () => {};
    buildTask = () => ({ taskKey: "detail-order", title: fixture.root.title,
      taskType: "评论", detailText: fixture.root.innerText, tweetUrl: extractTweetUrl(fixture.root) });
    debugOpenFirstCommentTask = async () => ({ ok: true, task: { taskKey: "selected-order", title: "Fixture order" } });
    wait = fixtureWait;
  `;
  const end = source.lastIndexOf("})();");
  vm.runInContext(source.slice(0, end) + adapters + source.slice(end), context);
  return { fixture, button, root,
    dispatch(type = "DEBUG_LOCK_SEAT_AND_EXTRACT", extra = {}) {
      return new Promise(resolve => listener({ type, runId: RUN, claimIntentId: INTENT,
        settings: { actionDelayMs: 500, cooldownPollMs: 250 }, selectedTask: {}, ...extra }, {}, resolve));
    },
  };
}

for (const route of ["DEBUG_LOCK_SEAT_AND_EXTRACT", "WAIT_SELECTED_COUNTDOWN_AND_LOCK", "START_LIGHTHOUSE_COMMENT_TASK"]) {
  test(`${route}: new success on the selected detail confirms exactly one lock click`, async () => {
    const p = page({ onClick(f) { f.nodes.push(node("席位已锁定")); } });
    const result = await p.dispatch(route);
    assert.equal(result.ok, true, result.message);
    assert.equal(result.task.seatLocked, true);
    assert.equal(p.fixture.clicks, 1);
  });
  test(`${route}: a loading button with zero seats cannot confirm a lock`, async () => {
    const p = page({ onClick(_f, button) { button.disabled = true; } });
    const result = await p.dispatch(route);
    assert.equal(result.ok, false);
    assert.equal(result.claimActionAttempted, true);
    assert.notEqual(result.task?.seatLocked, true);
    assert.match(result.message, /未确认.*锁位|锁位.*未确认/);
    assert.equal(p.fixture.clicks, 1);
  });
}

for (const kind of ["detached", "hidden", "unrelated-state", "preview-link", "old-success", "old-action", "static-step", "other-detail"]) {
  test(`${kind} cannot stand in for current-task lock confirmation`, async () => {
    const initialNodes = kind === "preview-link" ? [node("预览推文", { href: URL_X, control: true })]
      : kind === "old-success" ? [node("已锁定")]
      : kind === "old-action" ? [node("在 X 打开", { control: true, href: URL_X })] : [];
    const p = page({ initialNodes, onClick(f, button) {
      if (kind === "detached") button.isConnected = false;
      if (kind === "hidden") button.visible = false;
      if (kind === "unrelated-state") f.outside = "其他订单 进行中";
      if (kind === "static-step") f.nodes.push(node("前往 X 完成动作"));
      if (kind === "other-detail") { f.root.title = "Different order"; f.nodes.push(node("已锁定")); }
    } });
    const result = await p.dispatch();
    assert.equal(result.ok, false);
    assert.notEqual(result.task?.seatLocked, true);
    assert.equal(p.fixture.clicks, 1, "an unresolved click must not be dispatched again");
  });
}

test("temporary loading followed by current-task success is awaited", async () => {
  let observedLoading = false;
  const p = page({ onClick(_f, button) { button.disabled = true; }, onWait(f) {
    if (f.clicks) { observedLoading = true; f.nodes.push(node("已领取")); }
  } });
  const result = await p.dispatch();
  assert.equal(result.ok, true, result.message);
  assert.equal(observedLoading, true, "loading alone must not return success");
  assert.equal(p.fixture.clicks, 1);
});

test("an already locked detail with its target resumes without another claim click", async () => {
  const p = page({ initialNodes: [node("席位已锁定"), node("去 X 完成动作", { control: true, href: URL_X })] });
  p.fixture.nodes = p.fixture.nodes.filter(n => n !== p.button);
  const result = await p.dispatch();
  assert.equal(result.ok, true, result.message);
  assert.equal(result.task.seatLocked, true);
  assert.equal(result.task.resumedLockedTask, true);
  assert.equal(result.task.tweetUrl, URL_X);
  assert.equal(p.fixture.clicks, 0);
});

test("an old locked badge beside a lock button cannot activate resume", async () => {
  const p = page({ initialNodes: [node("席位已锁定"), node("去 X 完成动作", { control: true, href: URL_X })] });
  const result = await p.dispatch();
  assert.equal(result.ok, false);
  assert.notEqual(result.task?.resumedLockedTask, true);
  assert.equal(p.fixture.clicks, 1);
});

for (const route of ["DEBUG_LOCK_SEAT_AND_EXTRACT", "WAIT_SELECTED_COUNTDOWN_AND_LOCK", "START_LIGHTHOUSE_COMMENT_TASK"]) {
  test(`${route}: same-order locked state continues even when labels already existed before the claim`, async () => {
    const p = page({ initialNodes: [node("席位已锁定"), node("去 X 完成动作", { control: true, href: URL_X })],
      onClick(f, button) { f.nodes = f.nodes.filter(n => n !== button); } });
    const result = await p.dispatch(route);
    assert.equal(result.ok, true, result.message);
    assert.equal(result.task.seatLocked, true);
    assert.equal(result.task.tweetUrl, URL_X);
    assert.equal(p.fixture.clicks, 1);
  });
}

for (const scenario of ["disabled-claim", "wrong-target", "missing-target", "disabled-x", "missing-status"]) {
  test(`unchanged lock-state fallback remains unconfirmed for ${scenario}`, async () => {
    const action = node("去 X 完成动作", { control: true, href: scenario === "missing-target" ? "" : URL_X,
      disabled: scenario === "disabled-x" });
    const initialNodes = scenario === "missing-status" ? [action] : [node("席位已锁定"), action];
    const p = page({ initialNodes, onClick(f, button) {
      if (scenario === "disabled-claim") button.disabled = true;
      else f.nodes = f.nodes.filter(n => n !== button);
      if (scenario === "wrong-target") action.href = "https://x.com/other/status/456";
    }});
    const result = await p.dispatch();
    assert.equal(result.ok, false);
    assert.notEqual(result.task?.seatLocked, true);
    assert.equal(p.fixture.clicks, 1);
  });
}

test("a slow platform acknowledgement after five seconds is awaited without another claim", async () => {
  let elapsed = 0;
  const p = page({ onClick(_f, button) { button.disabled = true; }, onWait(f) {
    if (f.clicks && ++elapsed >= 20) f.nodes.push(node("席位已锁定"));
  } });
  const result = await p.dispatch();
  assert.equal(result.ok, true, result.message);
  assert.equal(p.fixture.clicks, 1);
});

for (const changedTask of [false, true]) {
  test(`a suspended wait checks the final receipt without another click (changed task: ${changedTask})`, async () => {
    let suspended = false;
    const p = page({ onWait(f) {
      if (!f.clicks || suspended) return;
      suspended = true;
      f.elapse(45000);
      if (changedTask) f.root.title = "Different order";
      f.nodes.push(node("席位已锁定"));
    } });
    const result = await p.dispatch();
    assert.equal(result.ok, !changedTask, result.message);
    assert.equal(result.task?.seatLocked === true, !changedTask);
    assert.equal(p.fixture.clicks, 1);
  });
}

for (const [text, retryAfterMs, claimRetryScope] of [
  ["当前没有可锁定的席位，请刷新任务查看最新名额。", 15000, "global"],
  ["本批名额暂不可领取，请约 2 分钟后重试。", 120000, "task"],
  ["本批名额暂不可领取，请约 30 分钟后重试。", 1800000, "task"],
  ["你抢的太快了，请 30 秒后重试", 30000, "global"],
  ["当前无法接单，请刷新任务后重试", 30000, "global"],
]) {
  test(`fresh temporary site refusal is retained and bound to its click: ${text}`, async () => {
    const p = page({ initialNodes: [node("在 X 打开", { control: true, href: URL_X })],
      onClick(f) { f.notify(text); f.clearNotices(); } });
    const result = await p.dispatch();
    assert.equal(result.ok, false);
    assert.equal(result.claimRejection?.claimIntentId, INTENT);
    assert.equal(result.retryAfterMs, retryAfterMs);
    assert.equal(result.claimRetryScope, claimRetryScope);
    assert.equal(result.task.seatLocked, false);
    assert.equal(p.fixture.clicks, 1);
    assert.equal(p.fixture.observers.size, 0, "the observer must be released after the attempt");
    assert.ok(p.fixture.reports.some(item => JSON.stringify(item).includes(text)));
  });
}

for (const scenario of ["stale", "other-detail", "generic-error", "old-success", "loading"]) {
  test(`temporary feedback does not release uncertain claims: ${scenario}`, async () => {
    const refusal = "当前没有可锁定的席位，请刷新任务查看最新名额。";
    const p = page({ initialNotices: scenario === "stale" ? [node(refusal)] : [],
      initialNodes: scenario === "old-success" ? [node("已锁定")] : [],
      onClick(f, button) {
        if (scenario === "other-detail") f.root.title = "Other order";
        if (scenario === "loading") { button.disabled = true; button.innerText = "处理中"; }
        if (scenario !== "stale") f.notify(scenario === "generic-error" ? "操作失败，请稍后重试。" : refusal);
        if (scenario === "other-detail") f.root.title = "Fixture order";
      } });
    const result = await p.dispatch();
    assert.equal(result.ok, false);
    assert.equal(result.claimRejection, undefined);
    assert.equal(p.fixture.clicks, 1);
    assert.equal(p.fixture.observers.size, 0);
    if (scenario === "generic-error") assert.ok(p.fixture.reports.some(item => JSON.stringify(item).includes("操作失败，请稍后重试。")));
  });
}

test("success takes precedence over transient global refusal feedback", async () => {
  const p = page({ onClick(f) {
    f.notify("当前没有可锁定的席位，请刷新任务查看最新名额。");
    f.nodes.push(node("席位已锁定"));
  } });
  const result = await p.dispatch();
  assert.equal(result.ok, true, result.message);
  assert.equal(result.claimRejection, undefined);
  assert.equal(p.fixture.clicks, 1);
  assert.equal(p.fixture.observers.size, 0);
});

test("a newly enabled X action in the same detail confirms the transition", async () => {
  const action = node("前往 X 完成动作", { control: true, disabled: true, href: URL_X });
  const p = page({ initialNodes: [action], onClick() { action.disabled = false; } });
  assert.equal((await p.dispatch()).ok, true);
  assert.equal(p.fixture.clicks, 1);
});

test("unrelated refusal text cannot override current-detail success", async () => {
  const p = page({ onClick(f) { f.outside = "其他订单 不可领取"; f.nodes.push(node("已锁定")); } });
  const result = await p.dispatch();
  assert.equal(result.ok, true, result.message);
});

for (const route of ["DEBUG_LOCK_SEAT_AND_EXTRACT", "WAIT_SELECTED_COUNTDOWN_AND_LOCK", "START_LIGHTHOUSE_COMMENT_TASK"]) {
  test(`${route}: a fresh same-detail refusal is bound to this exact claim intent`, async () => {
    const p = page({ onClick(f) { f.nodes.push(node("不可领取")); } });
    const result = await p.dispatch(route);
    assert.equal(result.ok, false);
    assert.equal(result.claimActionAttempted, true);
    assert.equal(result.task.seatLocked, false);
    assert.equal(result.claimRejection?.runId, RUN);
    assert.equal(result.claimRejection?.type, route);
    assert.equal(result.claimRejection?.claimIntentId, INTENT);
    assert.equal(result.claimRejection?.taskKey, result.task.taskKey);
    assert.equal(result.task.taskKey, route === "START_LIGHTHOUSE_COMMENT_TASK" ? "selected-order" : "detail-order");
    assert.equal(p.fixture.clicks, 1);
  });
}

for (const kind of ["success-and-refusal", "other-detail-refusal", "outside-refusal", "replacement-detail-refusal"]) {
  test(`${kind} cannot prove the current order was rejected`, async () => {
    const p = page({ onClick(f) {
      if (kind === "success-and-refusal") f.nodes.push(node("已锁定"), node("不可领取"));
      if (kind === "other-detail-refusal") { f.root.title = "Other order"; f.nodes.push(node("不可领取")); }
      if (kind === "outside-refusal") f.outside = "不可领取";
      if (kind === "replacement-detail-refusal") {
        f.root = { ...f.root, innerText: "Other order 评论任务 0.1 LUX 不可领取" };
        f.nodes.push(node("不可领取"));
      }
    } });
    const result = await p.dispatch();
    assert.equal(result.ok, false);
    assert.equal(result.claimRejection, undefined);
    assert.notEqual(result.task?.seatLocked, true);
    assert.equal(p.fixture.clicks, 1);
  });
}

test("a reused detail with a changed reward cannot confirm the original task", async () => {
  const p = page({ onClick(f) {
    Object.defineProperty(f.root, "innerText", { value: "Fixture order 评论任务 0.5 LUX 已锁定" });
    f.nodes.push(node("已锁定"));
  } });
  const result = await p.dispatch();
  assert.equal(result.ok, false);
  assert.notEqual(result.task?.seatLocked, true);
});

test("replacement detail with the same title and a success badge remains unconfirmed", async () => {
  const p = page({ onClick(f) {
    f.root = { ...f.root, innerText: "Fixture order 评论任务 0.1 LUX 已锁定" };
    f.nodes.push(node("已锁定"));
  } });
  assert.equal((await p.dispatch()).ok, false);
});

test("switching tasks during the post-lock phase await cannot attach success to the next task", async () => {
  const p = page({ onClick(f) { f.nodes.push(node("已锁定")); }, onPhase(f, label) {
    if (label === "锁定席位后") f.root.title = "Next task";
  } });
  const result = await p.dispatch();
  assert.equal(result.ok, false);
  assert.notEqual(result.task?.seatLocked, true);
  assert.equal(p.fixture.clicks, 1);
});

for (const evidence of [node("锁定成功"), node("前往 X 完成动作", { control: true, href: URL_X })]) {
  test(`a late refusal cannot revoke confirmed evidence: ${evidence.innerText}`, async () => {
    const p = page({ onClick(f) { f.nodes.push(evidence); } });
    const result = await p.dispatch();
    assert.equal(result.ok, true);
    p.fixture.nodes.push(node("不可领取"));
    const check = await p.dispatch("CHECK_LIGHTHOUSE_LOCK_FAILURE", { task: result.task });
    assert.equal(check.failed, false);
    assert.equal(check.claimRejection, undefined);
  });
}

// Feed real content receipts through the full background protocol. This covers
// persistence and ensures an unconfirmed click never reaches X adoption.
async function worker(t, p) {
  const event = { addListener() {} }, stored = {}, timers = new Set(), effects = [];
  const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const tab = { id: 11, windowId: 1, status: "complete", url: "https://app.lhdao.top/campaigns" };
  const chrome = {
    runtime: { id: "test", onInstalled: event, onMessage: event,
      getURL: value => `chrome-extension://test/${value}`, getManifest: () => manifest },
    storage: { session: require("./session-fixture.cjs")(), local: { async setAccessLevel() {},
      async get(keys) { return Object.fromEntries(keys.map(key => [key, copy(stored[key])])); },
      async set(values, callback) { Object.assign(stored, copy(values)); callback?.(); },
    } },
    alarms: { onAlarm: event, async create() {}, async clear() {} },
    tabs: { onCreated: event, onUpdated: event, onRemoved: event,
      async get() { return tab; }, async query() { return [tab]; },
      async sendMessage(_id, message) {
        // Keep readiness on the real content listener, outside the action log.
        if (message.type === "CHECK_LIGHTHOUSE_RUNNER_READY") return p.dispatch(message.type, message);
        effects.push(message.type);
        return p.dispatch(message.type);
      },
    },
  };
  const c = vm.createContext({ chrome, console, URL, AbortController, importScripts() {},
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout,
    fetch: async () => { throw new Error("Network forbidden in lock receipt integration tests"); },
  });
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  for (const name of ["reply-engine.js", "background.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../src", name), "utf8"), c);
  }
  await vm.runInContext("runtimeStateReady", c);
  Object.assign(c, { ensureLighthouseAlertBridge: async () => {}, publishLighthouseMonitorSnapshot() {},
    createRunId: () => INTENT });
  vm.runInContext(`Object.assign(runtimeState, { running: true, mode: "auto", runId: "${RUN}",
    lighthouseTabId: 11, runtimeWindowId: 1 })`, c);
  return { stored, effects, state: () => vm.runInContext("runtimeState", c),
    send: () => c.sendToTab(11, { type: "START_LIGHTHOUSE_COMMENT_TASK", runId: RUN, settings: { actionDelayMs: 500 } }),
  };
}

test("real unconfirmed click stays stopped and persisted without a locked order or another send", async t => {
  const p = page({ onClick(_f, button) { button.disabled = true; } }), w = await worker(t, p);
  const result = await w.send();
  assert.equal(result.uncertain, true);
  assert.equal(w.state().running, false);
  assert.equal(w.state().stage, "action_result_unknown");
  assert.notEqual(w.state().currentTask?.seatLocked, true);
  assert.ok(w.stored.lighthouseAutoRunStateV1.uncertainAction);
  assert.equal(w.stored.lighthouseAutoRunStateV1.running, false);
  await w.send();
  assert.equal(p.fixture.clicks, 1);
  assert.deepEqual(w.effects, ["START_LIGHTHOUSE_COMMENT_TASK"]);
});

test("real same-detail rejection releases only its matching background intent", async t => {
  const p = page({ onClick(f) { f.nodes.push(node("不可领取")); } }), w = await worker(t, p);
  const result = await w.send();
  assert.equal(result.claimRejectionConfirmed, true);
  assert.equal(w.state().running, true);
  assert.equal(w.state().uncertainAction, undefined);
  assert.equal(w.stored.lighthouseAutoRunStateV1.uncertainAction, undefined);
  assert.equal(p.fixture.clicks, 1);
});

test("real confirmed lock persists the order and clears the pending intent", async t => {
  const p = page({ onClick(f) { f.nodes.push(node("已锁定")); } }), w = await worker(t, p);
  assert.equal((await w.send()).ok, true);
  assert.equal(w.state().currentTask.seatLocked, true);
  assert.equal(w.state().uncertainAction, undefined);
  assert.equal(w.stored.lighthouseAutoRunStateV1.currentTask.seatLocked, true);
});

test("a lingering pre-claim notice cannot hide the complete same-order lock receipt",async()=>{
 const p=page({initialNodes:[node("在 X 打开",{control:true,href:URL_X})],onClick(f,button){
   f.nodes=f.nodes.filter(n=>n!==button);f.nodes.push(node("席位已锁定"),node("去 X 完成动作",{control:true,href:URL_X}));f.pendingNotice={};
 }});
 const r=await p.dispatch();assert.equal(r.ok,true,r.message);assert.equal(r.task.seatLocked,true);assert.equal(p.fixture.clicks,1);
});

for (const incomplete of ["status only", "wrong target", "claim control remains"]) {
  test(`a lingering notice still waits when the receipt is incomplete: ${incomplete}`, async () => {
    const p = page({ initialNodes: [node("在 X 打开", { control: true, href: URL_X })], onClick(f, button) {
      if (incomplete !== "claim control remains") f.nodes = f.nodes.filter(n => n !== button);
      f.nodes.push(node("席位已锁定"));
      if (incomplete !== "status only") f.nodes.push(node("去 X 完成动作", { control: true, href: URL_X }));
      if (incomplete === "wrong target") {
        for (const n of f.nodes) if (n.href) n.href = "https://x.com/other/status/456";
      }
      f.pendingNotice = {};
    } });
    const result = await p.dispatch();
    assert.equal(result.ok, false);
    assert.notEqual(result.task?.seatLocked, true);
    assert.equal(p.fixture.clicks, 1);
  });
}

test("selected locking follows the changing detail clock past the old one-minute cutoff", async () => {
  const p = page({ releaseAtMs: 125000, onClick(f, button) {
    f.nodes = f.nodes.filter(n => n !== button);
    f.nodes.push(node("席位已锁定"), node("去 X 完成动作", { control: true, href: URL_X }));
  } });
  const result = await p.dispatch("WAIT_SELECTED_COUNTDOWN_AND_LOCK", { selectedTask: { countdownSec: 0 } });
  assert.equal(result.ok, true, result.message);
  assert.equal(p.fixture.clicks, 1);
  assert.ok(p.fixture.elapsedMs >= 125000);
});

// Production exposes the target link only after the claim succeeds. The
// pre-claim "在 X 打开" is a button with no href, not a preview anchor.
for (const route of ["DEBUG_LOCK_SEAT_AND_EXTRACT", "WAIT_SELECTED_COUNTDOWN_AND_LOCK", "START_LIGHTHOUSE_COMMENT_TASK"]) {
  test(`${route}: a target revealed only after locking is accepted before a lingering notice`, async () => {
    const p = page({ initialNodes: [node("在 X 打开", { control: true })], onClick(f, button) {
      f.nodes = f.nodes.filter(n => n !== button);
      f.nodes.push(node("席位已锁定"), node("去 X 完成动作", { control: true }),
        node("没有自动打开？点此直接前往目标", { control: true, href: URL_X }));
      f.pendingNotice = {};
    } });
    const result = await p.dispatch(route);
    assert.equal(result.ok, true, result.message);
    assert.equal(result.task.seatLocked, true);
    assert.equal(result.task.tweetUrl, URL_X);
    assert.equal(p.fixture.clicks, 1);
  });
}
