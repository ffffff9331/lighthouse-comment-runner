"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const clone = (value) => JSON.parse(JSON.stringify(value));
const task = { taskKey: "previous-order", claimed: true, seatLocked: true };
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
};

async function worker(extra = {}) {
  const stored = {
    lighthouseAutoRunStateV1: { running: false, mode: "idle", stage: "stopped", runId: "old-run",
      currentTask: task, lighthouseTabId: 11, xTabId: 12, runtimeWindowId: 1, ...extra },
    replyHistoryRecords: [{ taskKey: "historic-order", createdAt: "2026-10-01T00:00:00.000Z" }],
  };
  const event = { addListener() {} }, calls = [], scans = [];
  const chrome = {
    runtime: { id: "test", getURL: (p) => `chrome-extension://test/${p}`,
      getManifest: () => ({ version: "test" }), onInstalled: event, onMessage: event },
    storage: { local: {
      async setAccessLevel() {},
      async get(keys) { return Object.fromEntries(keys.map((key) => [key, stored[key]])); },
      async set(values, callback) { Object.assign(stored, clone(values)); callback?.(); },
    } },
    alarms: { onAlarm: event, async create() {}, async clear() {} },
    tabs: { onCreated: event, onUpdated: event, onRemoved: event,
      async update(id) { return { id, windowId: 1 }; },
      async sendMessage(id, payload) { calls.push({ id, payload: clone(payload) }); return { ok: true }; },
    },
  };
  const c = vm.createContext({ chrome, console, URL, AbortController, importScripts() {}, clearTimeout,
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; },
    fetch: async () => { throw Error("No network in manual restart tests"); },
  });
  for (const file of ["reply-engine.js", "background.js"])
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../src", file), "utf8"), c);
  await vm.runInContext("runtimeStateReady", c);
  Object.assign(c, {
    getOrCreateLighthouseTab: async () => ({ id: 21, windowId: 1, url: "https://app.lhdao.top/campaigns" }),
    focusLighthouseTabForAutoScan: async () => true,
    waitForTabComplete: async () => {},
    startNextAutoTask: async (reason) => { scans.push(reason); },
    resolveLighthouseTab: async () => 21,
    rememberLighthouseTabById: async () => {},
    ensureLighthouseAlertBridge: async () => {},
    closeLighthouseTaskDetail: async () => true,
  });
  const state = () => vm.runInContext("runtimeState", c);
  const message = (type, extra = {}) => c.handleMessage({ type, clientWindowId: 1, ...extra },
    { id: "test", url: "chrome-extension://test/src/debug/debug.html" });
  return { c, chrome, calls, scans, stored, state, message };
}

for (const uncertain of [false, true]) {
  test(`explicit full start ignores stale local order flags without inventing completion, uncertain=${uncertain}`, async () => {
    const w = await worker(uncertain ? { uncertainAction: { type: "RUN_X_REPLY", runId: "old-run" } } : {});
    const history = clone(w.stored.replyHistoryRecords);
    assert.equal((await w.message("START_RUN")).ok, true);
    assert.deepEqual(w.scans, ["start"]);
    assert.equal(w.state().currentTask, null);
    assert.ok(!w.state().uncertainAction);
    assert.equal(w.state().completed, 0);
    assert.ok(!w.state().completionEvidence);
    assert.deepEqual(w.stored.replyHistoryRecords, history);
    assert.deepEqual(w.calls.map(({ id, payload }) => [id, payload.type, payload.runId]), [
      [11, "CANCEL_LIGHTHOUSE_RUN", "old-run"], [12, "CANCEL_X_RUN", "old-run"],
    ]);
  });
}

test("automatic restarts still cannot discard an unresolved action", async () => {
  const w = await worker({ uncertainAction: { type: "RUN_X_REPLY", runId: "old-run" } });
  assert.equal((await w.c.startAutoRun({}, 1)).ok, false);
  assert.equal(w.state().currentTask.taskKey, task.taskKey);
  assert.equal(w.scans.length, 0);
});

test("duplicate full start is rejected while old content cancellation is pending", async () => {
  const w = await worker();
  const entered = deferred(), release = deferred();
  w.chrome.tabs.sendMessage = async () => { entered.resolve(); await release.promise; return { ok: true }; };
  const first = w.message("START_RUN");
  await entered.promise;
  assert.equal((await w.message("START_RUN")).ok, false);
  release.resolve();
  assert.equal((await first).ok, true);
  assert.equal(w.scans.length, 1);
});

test("stop during manual restart cancellation prevents a new scan", async () => {
  const w = await worker();
  const entered = deferred(), release = deferred();
  w.chrome.tabs.sendMessage = async () => { entered.resolve(); await release.promise; return { ok: true }; };
  const first = w.message("START_RUN");
  await entered.promise;
  await w.message("STOP_RUN");
  release.resolve();
  assert.equal((await first).cancelled, true);
  assert.equal(w.state().running, false);
  assert.equal(w.scans.length, 0);
});

test("missing old tabs do not prevent explicit full start", async () => {
  const w = await worker();
  w.chrome.tabs.sendMessage = async () => { throw Error("No tab with id: 11."); };
  assert.equal((await w.message("START_RUN")).ok, true);
  assert.equal(w.scans.length, 1);
});

test("selected start reaches the platform despite stale local order flags and respects platform refusal", async () => {
  const w = await worker({ uncertainAction: { type: "RUN_X_REPLY", runId: "old-run" } });
  w.chrome.tabs.sendMessage = async (id, payload) => {
    w.calls.push({ id, payload: clone(payload) });
    if (payload.type.startsWith("CANCEL_")) return { ok: true };
    return { ok: false, message: "platform: active order" };
  };
  const result = await w.message("RUN_SELECTED_COUNTDOWN_TASK", { selectedTask: { selectionId: "next", taskType: "评论" } });
  assert.equal(result.result?.message, "platform: active order");
  assert.equal(w.calls.filter(({ payload }) => payload.type === "OPEN_SELECTED_COUNTDOWN_TASK_DETAIL").length, 1);
  assert.equal(w.calls.filter(({ payload }) => payload.type === "RUN_X_REPLY").length, 0);
  assert.equal(w.state().running, false);
  assert.equal(w.state().completed, 0);
});

test("an empty selected-start request retains the prior order and sends nothing", async () => {
  const w = await worker();
  const result = await w.message("RUN_SELECTED_COUNTDOWN_TASK");
  assert.equal(result.error, "未选中任务");
  assert.equal(w.state().currentTask.taskKey, task.taskKey);
  assert.equal(w.calls.length, 0);
});
