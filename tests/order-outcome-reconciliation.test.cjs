"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const sourceRoot = process.env.LIGHTHOUSE_TEST_SOURCE_ROOT || path.join(__dirname, "../src");
const read = file => fs.readFileSync(path.join(sourceRoot, file), "utf8");
const copy = value => JSON.parse(JSON.stringify(value));
const event = { addListener() {} };
const task = { taskKey: "bound-order", tweetUrl: "https://x.com/current/status/123", taskType: "评论", bounty: 0.1 };
const intent = { type: "START_LIGHTHOUSE_COMMENT_TASK", runId: "bound-run", tabId: 11, intentId: "bound-intent" };
const key = "lighthouseAutoRunStateV1";
const noNetwork = async () => { throw Error("Network forbidden in order reconciliation tests"); };

function page(options = {}) {
  let listener;
  const node = (text, extra = {}) => ({ innerText: text, textContent: text, isConnected: true, visible: true,
    disabled: false, href: "", control: false,
    getAttribute(name) { return name === "href" ? this.href : ""; },
    matches() { return this.control; },
    getBoundingClientRect() { return { width: 500, height: 300 }; },
    ...extra });
  const target = options.target || task.tweetUrl;
  const original = node("查看原推文", { href: target, control: true, visible: !options.hiddenLink });
  const marker = node("验证成功 · 奖励托管中");
  const result = node("验证成功 · 奖励托管中 + 0.10 LUX 继续搞钱 类似任务", {
    querySelectorAll: selector => selector === "h1,h2,h3,p,span,div" ? [marker] : [],
    contains(other) { return other === this || other === marker; },
    closest: () => ({ querySelectorAll: () => options.missingLink ? [] : [original,
      ...(options.conflictingLink ? [node("查看原推文", { href: "https://x.com/other/status/999" })] : []),
      node("推荐任务", { href: "https://x.com/recommended/status/888" })] })
  });
  const nodes = [node("席位已锁定"), node("去 X 完成动作", { control: true }),
    node("在 X 打开", { control: true, href: target })];
  if (options.claimControl) nodes.push(node("锁定席位", { control: true, disabled: true }));
  const root = node(`当前订单 0.1 LUX ${options.refusal ? "不可领取" : "席位已锁定"}`, {
    querySelectorAll: selector => selector === "a[href]" ? nodes.filter(n => n.href) : nodes
  });
  const c = vm.createContext({ console, URL, setTimeout, clearTimeout, AbortController,
    document: { body: {}, querySelectorAll: selector => selector === "[role='dialog'],main,section,article,div"
      && options.completed ? [result] : [] },
    window: { addEventListener() {} }, location: { href: "https://app.lhdao.top/campaigns", pathname: "/campaigns" },
    fetch: noNetwork, fixtureRoot: options.locked ? root : null,
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } }, async sendMessage() { return { ok: true }; } } }
  });
  const source = read("content/lighthouse.js"), end = source.lastIndexOf("})();");
  vm.runInContext(source.slice(0, end) + `
    isVisible = n => Boolean(n && n.visible && n.isConnected);
    isDisabled = n => n.disabled;
    findTaskDetailRoot = () => fixtureRoot;
    automationPaused = true;
    cancelledRunIds.add("bound-run");
  ` + source.slice(end), c);
  return { dispatch(message) { return new Promise(resolve => {
    const accepted = listener(message, {}, resolve);
    if (!accepted) resolve(null);
  }); } };
}

const payload = () => ({ type: "CHECK_LIGHTHOUSE_ORDER_OUTCOME", platform: "lighthouse", runId: intent.runId,
  claimIntentId: intent.intentId, task: copy(task) });

for (const [name, options, outcome] of [
  ["completed exact original tweet", { completed: true }, "completed"],
  ["locked exact original tweet", { locked: true }, "locked"],
  ["completed wrong tweet", { completed: true, target: "https://x.com/other/status/456" }, "unknown"],
  ["missing original link", { completed: true, missingLink: true }, "unknown"],
  ["hidden original link", { completed: true, hiddenLink: true }, "unknown"],
  ["conflicting original links", { completed: true, conflictingLink: true }, "unknown"],
  ["locked wrong tweet", { locked: true, target: "https://x.com/other/status/456" }, "unknown"],
  ["claim still in flight", { locked: true, claimControl: true }, "unknown"],
  ["contradictory refusal", { locked: true, refusal: true }, "unknown"],
]) test(`read-only outcome after cancellation: ${name}`, async () => {
  const result = await page(options).dispatch(payload());
  assert.equal(result?.outcome, outcome);
  assert.equal(result?.taskKey, task.taskKey);
  assert.equal(result?.claimIntentId, intent.intentId);
});

async function worker(options = {}) {
  const stored = {}, sent = [], hooks = {};
  const tab = { id: 11, windowId: 1, url: "https://app.lhdao.top/campaigns" };
  const content = page(options);
  const chrome = {
    runtime: { id: "test", getURL: p => `chrome-extension://test/${p}`, getManifest: () => ({ version: "test" }),
      onInstalled: event, onMessage: event },
    storage: { session: require("./session-fixture.cjs")(), local: { setAccessLevel: async () => {},
      async get(keys) { return Object.fromEntries(keys.map(k => [k, stored[k]])); },
      async set(values, cb) { await hooks.beforeSave?.(values); if (hooks.saveFails && values[key]) throw Error("disk failure");
        Object.assign(stored, copy(values)); cb?.(); } } },
    alarms: { onAlarm: event, create: async () => {}, clear: async () => {} },
    tabs: { onCreated: event, onUpdated: event, onRemoved: event,
      async get() { return { ...tab, ...hooks.tab }; },
      async sendMessage(id, message) { sent.push({ id, ...copy(message) });
        await hooks.beforeRead?.();
        const result = await content.dispatch(message);
        return hooks.edit ? hooks.edit(result) : result; } }
  };
  const c = vm.createContext({ chrome, console, URL, AbortController, importScripts() {},
    setTimeout, clearTimeout, fetch: noNetwork });
  for (const file of ["reply-engine.js", "background.js"]) vm.runInContext(read(file), c);
  await vm.runInContext("runtimeStateReady", c);
  c.publishLighthouseMonitorSnapshot = () => {};
  c.ensureContentScriptInjected = async () => false;
  const state = () => vm.runInContext("runtimeState", c);
  Object.assign(state(), { running: false, mode: "auto", stage: "action_result_unknown", runId: intent.runId,
    lighthouseTabId: 11, lighthouseWindowId: 1, runtimeWindowId: 1,
    currentTask: copy(task), uncertainAction: copy(intent) });
  const get = () => c.handleMessage({ type: "GET_STATE" }, { id: "test", url: "chrome-extension://test/debug.html" });
  return { c, state, stored, sent, hooks, get };
}

test("real content completion reconciles the saved unknown claim without any outbound action", async () => {
  const w = await worker({ completed: true });
  const result = await w.get();
  assert.equal(result.ok, true);
  assert.equal(w.state().stage, "claim_completed_reconciled");
  assert.equal(w.state().running, false);
  assert.equal(w.state().uncertainAction, null);
  assert.equal(w.stored[key].completionEvidence.tweetUrl, task.tweetUrl);
  assert.equal(w.c.hasLatchedLighthouseCompletion(intent.runId), true);
  await w.get();
  assert.deepEqual(w.sent.map(m => m.type), ["CHECK_LIGHTHOUSE_ORDER_OUTCOME"]);
  const repeat = await w.c.runManualDebugCommand({ type: "DEBUG_RUN_X_REPLY" }, 1);
  assert.equal(repeat.ok, false);
  assert.match(repeat.error, /本单已确认完成/);
});

test("a real locked outcome retains the same order and permits continuation without re-claiming", async () => {
  const w = await worker({ locked: true });
  await w.get();
  assert.equal(w.state().stage, "claim_locked_reconciled");
  assert.equal(w.state().currentTask.taskKey, task.taskKey);
  assert.equal(w.state().currentTask.seatLocked, true);
  assert.ok(!w.state().completionEvidence);
  assert.equal(w.state().running, false);
  const result = await w.c.startAutoRun({}, 1, false);
  assert.equal(result.ok, false);
  assert.match(result.error, /接续本单/);
  assert.equal(w.sent.length, 1);
});

for (const [field, value] of [["runId", "other"], ["claimIntentId", "other"], ["taskKey", "other"],
  ["tweetUrl", "https://x.com/other/status/999"], ["outcome", "unknown"], ["ok", false]]) {
  test(`invalid receipt preserves the unknown intent: ${field}`, async () => {
    const w = await worker({ completed: true });
    const original = w.state().uncertainAction;
    w.hooks.edit = r => ({ ...r, [field]: value });
    await w.get();
    assert.equal(w.state().uncertainAction, original);
    assert.equal(w.state().stage, "action_result_unknown");
  });
}

for (const change of ["post", "no target", "wrong window", "wrong site", "save failure"]) {
  test(`unproven or unpersisted recovery stays stopped: ${change}`, async () => {
    const w = await worker({ completed: true });
    if (change === "post") w.state().uncertainAction.type = "RUN_X_REPLY";
    if (change === "no target") w.state().currentTask.tweetUrl = "";
    if (change === "wrong window") w.hooks.tab = { windowId: 2 };
    if (change === "wrong site") w.hooks.tab = { url: "https://example.com" };
    if (change === "save failure") w.hooks.saveFails = true;
    const before = copy(w.state());
    await w.get();
    assert.deepEqual(copy(w.state()), before);
  });
}

for (const phase of ["read", "save"]) test(`a new stop/run wins over late ${phase} completion`, async () => {
  const w = await worker({ completed: true });
  const interrupt = () => vm.runInContext('runtimeState = {...createInitialState(),runId:"new-run",stage:"stopped",manuallyStopped:true}', w.c);
  if (phase === "read") w.hooks.beforeRead = interrupt;
  else { let first = true; w.hooks.beforeSave = () => { if (first) { first = false; interrupt(); } }; }
  await w.get();
  assert.equal(w.state().runId, "new-run");
  assert.equal(w.state().stage, "stopped");
  assert.ok(!w.state().completionEvidence);
  if (phase === "save") assert.equal(w.stored[key].runId, "new-run");
});

test("concurrent status polling shares one exact-order read", async () => {
  const w = await worker({ completed: true });
  await Promise.all([w.get(), w.get(), w.get()]);
  assert.equal(w.sent.length, 1);
  assert.equal(w.state().stage, "claim_completed_reconciled");
});
