"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const sourceRoot = process.env.LIGHTHOUSE_TEST_SOURCE_ROOT || path.join(__dirname, "../src");
const STATE_KEY = "lighthouseAutoRunStateV1";
const KEEPALIVE = "lighthouseAutoRunKeepaliveV1";
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const lockedTask = { taskKey: "locked-like-order", taskType: "点赞互动", bounty: "0.1", handle: "@fixture", claimed: true, seatLocked: true, seatLockedAt: 12345, tweetUrl: "https://x.com/fixture/status/123" };
const pendingEvidence = { type: "COMPLETE_X_TASK_WIDGET", taskKey: lockedTask.taskKey, runId: "live-run", tabId: 12 };

// Chrome storage serializes arguments at the API boundary. Clone both reads
// and writes so changing runtimeState.running later cannot alter saved data.
async function boot(t, stored) {
  const event = { addListener() {} };
  const calls = { runStateWrites: [], alarmsCreated: [], alarmsCleared: [], browser: [], scans: [] };
  const timers = new Set();
  const tab = (id) => ({ id, windowId: 1, status: "complete", url: id === 12 ? lockedTask.tweetUrl : "https://app.lhdao.top/campaigns" });
  const chrome = {
    runtime: {
      id: "test", getURL: (value) => `chrome-extension://test/${value}`,
      getManifest: () => ({ version: "test" }), onInstalled: event, onMessage: event,
      async getPlatformInfo() { calls.browser.push({ type: "getPlatformInfo" }); return { os: "mac" }; },
    },
    storage: { local: {
      async setAccessLevel() {},
      async get(keys) { return Object.fromEntries(keys.map((key) => [key, clone(stored[key])])); },
      async set(values, callback) {
        if (Object.hasOwn(values, STATE_KEY)) calls.runStateWrites.push(clone(values[STATE_KEY]));
        Object.assign(stored, clone(values));
        callback?.();
      },
    } },
    alarms: {
      onAlarm: event,
      async create(name, options) { calls.alarmsCreated.push({ name, options: clone(options) }); },
      async clear(name) { calls.alarmsCleared.push(name); return true; },
    },
    windows: { async get(id) { calls.browser.push({ type: "getWindow", id }); return { id }; } },
    tabs: {
      onCreated: event, onUpdated: event, onRemoved: event,
      async get(id) { calls.browser.push({ type: "getTab", id }); return tab(id); },
      async query(options) { calls.browser.push({ type: "queryTabs", options: clone(options) }); return [tab(11)]; },
      async create(options) { calls.browser.push({ type: "createTab", options: clone(options) }); return tab(21); },
      async update(id, options) { calls.browser.push({ type: "updateTab", id, options: clone(options) }); return tab(id); },
      async reload(id) { calls.browser.push({ type: "reloadTab", id }); },
      async sendMessage(id, payload) { calls.browser.push({ type: "sendMessage", id, payload: clone(payload) }); return { ok: true }; },
    },
    scripting: { async executeScript(options) { calls.browser.push({ type: "executeScript", options: clone(options) }); return []; } },
  };
  const context = vm.createContext({
    chrome, console, URL, AbortController, importScripts() {},
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timer.unref(); timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
    fetch: async () => { throw new Error("No network in stopped-state restoration tests"); },
  });
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  for (const file of ["reply-engine.js", "background.js"]) {
    vm.runInContext(fs.readFileSync(path.join(sourceRoot, file), "utf8"), context, { filename: file });
  }
  await vm.runInContext("runtimeStateReady", context);
  // Observe any attempted restart without actually scanning or claiming an order.
  context.startNextAutoTask = async (reason) => { calls.scans.push(reason); };
  const state = () => vm.runInContext("runtimeState", context);
  const message = (type) => context.handleMessage({ type, clientWindowId: 1 },
    { id: "test", url: "chrome-extension://test/src/debug/debug.html" });
  return { context, calls, state, message };
}

function setLiveOrder(worker, extra = {}) {
  Object.assign(worker.state(), {
    running: true, mode: "auto", stage: "lighthouse_completion_waiting", runId: "live-run",
    currentTask: clone(lockedTask), lighthouseTabId: 11, lighthouseWindowId: 1,
    runtimeWindowId: 1, xTabId: 12, xTabWindowId: 1,
    lastXResult: { ok: true, mode: "like", message: "已点赞" },
    completionEvidence: null, logs: [], ...clone(extra)
  });
}

for (const uncertain of [false, true]) {
  test(`locked failure persists the stopped order before returning (uncertain=${uncertain})`, async (t) => {
    const stored = { replyHistoryRecords: [{ taskKey: "historic-order", mode: "like" }] };
    const worker = await boot(t, stored);
    setLiveOrder(worker, uncertain ? { uncertainAction: pendingEvidence } : {});
    const priorTask = clone(worker.state().currentTask);
    const result = await worker.context.recoverAndContinue("等待 Lighthouse 显示已完成超时，已保留 X 页面", {
      runId: "live-run", task: clone(priorTask), closeX: false
    });
    assert.equal(result.ok, false);
    assert.equal(worker.state().running, false);
    assert.equal(worker.state().stage, "locked_task_recovery_blocked");
    assert.equal(stored[STATE_KEY].running, false, "a later worker must read a stopped snapshot, not the last running log write");
    assert.equal(stored[STATE_KEY].stage, "locked_task_recovery_blocked");
    assert.equal(stored[STATE_KEY].runId, "live-run");
    assert.deepEqual(stored[STATE_KEY].currentTask, priorTask);
    assert.deepEqual(stored[STATE_KEY].uncertainAction, uncertain ? pendingEvidence : undefined);
    assert.equal(stored[STATE_KEY].xTabId, 12);
    assert.equal(stored[STATE_KEY].completionEvidence, null);
    assert.deepEqual(stored.replyHistoryRecords, [{ taskKey: "historic-order", mode: "like" }]);
    assert.deepEqual(worker.calls.scans, []);
    assert.deepEqual(worker.calls.browser, [], "a locked failure must preserve both browser pages");
  });

  test(`a fresh worker preserves a locked failure without an interruption warning or resume (uncertain=${uncertain})`, async (t) => {
    const stored = {};
    const worker = await boot(t, stored);
    setLiveOrder(worker, uncertain ? { uncertainAction: pendingEvidence } : {});
    await worker.context.recoverAndContinue("等待 Lighthouse 显示已完成超时，已保留 X 页面", {
      runId: "live-run", task: clone(lockedTask), closeX: false
    });
    const stopLogs = clone(worker.state().logs);
    const rebooted = await boot(t, stored);
    assert.equal(rebooted.state().running, false);
    assert.equal(rebooted.state().stage, "stopped", "a deliberate locked-order stop is not an interrupted active run");
    assert.deepEqual(clone(rebooted.state().logs), stopLogs, "restoration must not manufacture another recovery warning");
    assert.deepEqual(clone(rebooted.state().currentTask), lockedTask);
    assert.deepEqual(clone(rebooted.state().uncertainAction), uncertain ? pendingEvidence : undefined);
    assert.equal(rebooted.state().xTabId, 12);
    assert.deepEqual(rebooted.calls.alarmsCreated, []);
    await rebooted.context.handleAutoRunKeepaliveTick();
    assert.equal(rebooted.state().running, false);
    assert.equal(rebooted.state().stage, "stopped");
    assert.deepEqual(clone(rebooted.state().logs), stopLogs);
    assert.deepEqual(rebooted.calls.runStateWrites, []);
    assert.deepEqual(rebooted.calls.browser, []);
    assert.deepEqual(rebooted.calls.scans, []);
    assert.ok(!rebooted.calls.alarmsCreated.some(call => call.name === KEEPALIVE));
  });
}

test("an explicitly unclaimed failure still closes the detail and resumes the next scan", async (t) => {
  const stored = {};
  const worker = await boot(t, stored);
  const candidate = { taskKey: "unclaimed-candidate", taskType: "点赞互动", bounty: "0.1", seatLocked: false };
  setLiveOrder(worker, { currentTask: candidate });
  // Keep real recovery, tab lookup, close/reload and storage code; only skip
  // elapsed pacing and observe the next scan before it can select a task.
  worker.context.delay = async () => {};
  await worker.context.recoverAndContinue("详情暂时不可用", { runId: "live-run", task: candidate, closeX: false });
  assert.equal(worker.state().running, true);
  assert.notEqual(worker.state().stage, "locked_task_recovery_blocked");
  assert.deepEqual(worker.calls.scans, ["recover_after_failure"]);
  assert.ok(worker.calls.browser.some(call => call.type === "sendMessage" && call.payload.type === "CLOSE_LIGHTHOUSE_TASK_DETAIL"));
  assert.ok(worker.calls.browser.some(call => call.type === "reloadTab" && call.id === 11));
  assert.equal(stored[STATE_KEY].running, true);
});
