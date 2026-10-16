"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sourceRoot = process.env.LIGHTHOUSE_TEST_SOURCE_ROOT || path.join(__dirname, "../src");
const STATE_KEY = "lighthouseAutoRunStateV1";
const MONITOR_KEY = "lighthouseMonitorSnapshot";
const KEEPALIVE = "lighthouseAutoRunKeepaliveV1";
const IDLE_RELOAD = "lighthouseCampaignsIdleReloadV1";
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const lighthouseTab = { id: 11, windowId: 1, active: true, status: "complete", url: "https://app.lhdao.top/campaigns" };
const xTab = { id: 12, windowId: 1, status: "complete", url: "https://x.com/example/status/123" };
const oldTask = { taskKey: "old-order", title: "old task title", claimed: true, seatLocked: true, tweetUrl: xTab.url };

// Load complete background source. Chrome calls are inert and recorded; the
// final auto-scan boundary is replaced so no fixture can claim or post a task.
async function boot(t, stored = {}, seedOldRun = true) {
  const effects = [], writes = [], hooks = {}, timers = new Set(), listeners = {};
  const event = name => ({ addListener(fn) { listeners[name] = fn; } });
  const chrome = {
    runtime: {
      id: "test", getURL: value => `chrome-extension://test/${value}`,
      getManifest: () => ({ version: "test" }), onInstalled: event("installed"), onMessage: event("message"),
      async getPlatformInfo() { effects.push({ type: "platform" }); return { os: "mac" }; },
      async sendMessage(message) { effects.push({ type: "runtimeMessage", message: clone(message) }); return { ok: true }; },
    },
    storage: { local: {
      async setAccessLevel() {},
      async get(keys) {
        if (hooks.storageGet) {
          const override = hooks.storageGet(keys);
          if (override !== undefined) return override;
        }
        return Object.fromEntries(keys.map(key => [key, clone(stored[key])]));
      },
      async set(values, callback) {
        writes.push(clone(values));
        Object.assign(stored, clone(values));
        callback?.();
      },
      async remove(keys) { for (const key of [].concat(keys)) delete stored[key]; },
    } },
    alarms: {
      onAlarm: event("alarm"),
      async create(name, options) { effects.push({ type: "alarmCreate", name, options: clone(options) }); },
      async clear(name) { effects.push({ type: "alarmClear", name }); return true; },
    },
    tabs: {
      onCreated: event("tabCreated"), onUpdated: event("tabUpdated"), onRemoved: event("tabRemoved"),
      async get(id) { effects.push({ type: "getTab", id }); return { ...(id === 12 ? xTab : lighthouseTab) }; },
      async query(query) { effects.push({ type: "queryTabs", query: clone(query) }); return [{ ...lighthouseTab }, ...(query.url?.includes("x.com") ? [{ ...xTab }] : [])]; },
      async create(options) { effects.push({ type: "createTab", options: clone(options) }); return { ...lighthouseTab }; },
      async update(id, options) { effects.push({ type: "updateTab", id, options: clone(options) }); return { ...(id === 12 ? xTab : lighthouseTab) }; },
      async reload(id) { effects.push({ type: "reloadTab", id }); },
      async remove(id) { effects.push({ type: "removeTab", id }); },
      async sendMessage(id, message) {
        effects.push({ type: "tabMessage", id, message: clone(message) });
        if (hooks.sendMessage) {
          const override = hooks.sendMessage(id, message);
          if (override !== undefined) return override;
        }
        return { ok: true };
      },
    },
    windows: { async get(id) { effects.push({ type: "getWindow", id }); return { id }; } },
    scripting: { async executeScript(options) { effects.push({ type: "inject", options: clone(options) }); return []; } },
    notifications: { async create(id, options) { effects.push({ type: "notification", id, options: clone(options) }); return id; } },
  };
  const c = vm.createContext({
    chrome, console, URL, AbortController, importScripts() {},
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timer.unref(); timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
    fetch: async () => { throw new Error("Network is forbidden in manual STOP reset tests"); },
  });
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  for (const file of ["reply-engine.js", "background.js"]) {
    vm.runInContext(fs.readFileSync(path.join(sourceRoot, file), "utf8"), c, { filename: file });
  }
  await vm.runInContext("runtimeStateReady", c);
  await flush();
  c.startNextAutoTask = async reason => { effects.push({ type: "scan", reason }); return { ok: true }; };
  c.waitForTabComplete = async () => true;
  c.delay = async () => {};
  c.ensureLighthouseAlertBridge = async () => true;
  if (!stored.settings) stored.settings = clone(vm.runInContext("normalizeSettings({ ...DEFAULT_SETTINGS, aiModel: 'user-choice', aiApiKey: 'fixture-only' })", c));
  if (!stored.monitorSettings) stored.monitorSettings = clone(vm.runInContext("normalizeMonitorSettings({ ...DEFAULT_MONITOR_SETTINGS, voiceEngine: 'browser' })", c));
  if (!stored.replyHistoryRecords) stored.replyHistoryRecords = [{ taskKey: "completed-history", tweetUrl: "https://x.com/history/status/456", createdAt: "2026-10-13T00:00:00.000Z", bounty: "1" }];
  if (!stored.permanentIgnoredTaskKeysV4) stored.permanentIgnoredTaskKeysV4 = ["ignored-history"];
  if (seedOldRun) {
    c.oldTaskFixture = clone(oldTask);
    vm.runInContext(`Object.assign(runtimeState, {
      running: true, mode: "auto", stage: "running_x_reply", runId: "old-run", stopEpoch: 40,
      completed: 9, failed: 8, attempts: 7,
      lighthouseTabId: 11, lighthouseWindowId: 1, runtimeWindowId: 1,
      lighthousePage: { phase: "old-detail" }, xTabId: 12, xTabWindowId: 1,
      currentTask: oldTaskFixture, lastXResult: { old: true }, lastLockFailureReason: "old failure",
      scheduledResumeAt: Date.now() + 60000, startOptions: { lighthouseUrl: "https://app.lhdao.top/campaigns" },
      pendingXOpen: { createdTabIds: [12], candidates: [], lighthouseTabId: 11, windowId: 1 },
      pendingVerifications: [{ taskKey: "old-pending" }], attemptedTaskKeys: ["old-attempt"],
      attemptedTaskRecords: [{ taskKey: "old-attempt", at: Date.now() }],
      uncertainAction: { type: "RUN_X_REPLY", runId: "old-run", tabId: 12, taskKey: "old-order" },
      completionEvidence: { officialCompletion: true, runId: "old-run", taskKey: "old-order" },
      incomeAtTaskStart: 123, marketplaceRefreshInFlight: true,
      logs: [{ at: "2026-10-13T00:00:00.000Z", level: "warn", text: "OLD RUN LOG" }]
    });
    monitorCountdowns = { tasks: [{ selectionId: "old-countdown" }], timestamp: Date.now() };
    lastXTaskWidgetNotifyAt = 123; lastCampaignsRefreshAt = 456;
    globalThis.oldControllerFixture = new AbortController();
    activeAIRequests.add(oldControllerFixture);`, c);
    await c.persistAutoRunState(true);
  }
  const state = () => vm.runInContext("runtimeState", c);
  const caches = () => clone(vm.runInContext("({ monitorCountdowns, lastXTaskWidgetNotifyAt, lastCampaignsRefreshAt })", c));
  const message = (type, extra = {}) => c.handleMessage({ type, clientWindowId: 1, ...extra }, {
    id: "test", url: "chrome-extension://test/src/debug/debug.html",
  });
  return { c, hooks, stored, effects, writes, listeners, state, caches, message };
}

function assertCleared(state) {
  assert.equal(state.running, false);
  assert.equal(state.manuallyStopped, true);
  assert.equal(state.mode, "idle");
  assert.equal(state.stage, "stopped");
  for (const key of ["completed", "failed", "attempts", "scheduledResumeAt"]) assert.equal(state[key], 0, key);
  for (const key of ["lighthouseTabId", "lighthouseWindowId", "runtimeWindowId", "lighthousePage", "xTabId", "xTabWindowId", "currentTask", "lastXResult", "startOptions", "pendingXOpen", "uncertainAction", "completionEvidence", "incomeAtTaskStart"]) {
    assert.ok(state[key] == null, `${key} must not retain old run data`);
  }
  assert.equal(state.lastLockFailureReason, "");
  assert.ok(!state.marketplaceRefreshInFlight);
  for (const key of ["pendingVerifications", "attemptedTaskKeys", "attemptedTaskRecords"]) assert.deepEqual(clone(state[key]), [], key);
  assert.equal(state.logs.length, 1, "only the current stop confirmation should remain");
  assert.equal(state.logs[0].text, "已停止运行");
}

function persistentUserData(stored) {
  return clone({ settings: stored.settings, monitorSettings: stored.monitorSettings,
    replyHistoryRecords: stored.replyHistoryRecords, permanentIgnoredTaskKeysV4: stored.permanentIgnoredTaskKeysV4 });
}

test("manual STOP clears all old run fields and caches while retaining settings and completed history", async t => {
  const w = await boot(t), userData = persistentUserData(w.stored);
  const result = await w.message("STOP_RUN");
  await flush();
  assert.equal(result.ok, true);
  assertCleared(w.state());
  assertCleared(w.stored[STATE_KEY]);
  assert.notEqual(w.state().runId, "old-run");
  assert.equal(w.state().stopEpoch, 41);
  assert.equal(w.c.oldControllerFixture.signal.aborted, true);
  assert.deepEqual(w.caches(), { monitorCountdowns: { tasks: [], timestamp: 0 }, lastXTaskWidgetNotifyAt: 0, lastCampaignsRefreshAt: 0 });
  assert.deepEqual(persistentUserData(w.stored), userData);
  const cancelled = w.effects.filter(e => e.type === "tabMessage" && e.message.type.startsWith("CANCEL_"));
  assert.deepEqual(cancelled.map(e => [e.id, e.message.type, e.message.runId]), [[11, "CANCEL_LIGHTHOUSE_RUN", "old-run"], [12, "CANCEL_X_RUN", "old-run"]]);
  const cleared = w.effects.filter(e => e.type === "alarmClear").map(e => e.name);
  assert.ok(cleared.includes(KEEPALIVE));
  assert.ok(cleared.includes(IDLE_RELOAD));
  for (const tabId of [11, 12]) {
    assert.ok(w.effects.some(e => e.type === "tabMessage" && e.id === tabId && e.message.paused === true
      && (e.message.type === "AUTOMATION_PAUSE_CHANGED" || e.message.type.startsWith("CANCEL_"))), "pause must reach each already-open task page");
  }
  assert.ok(w.effects.some(e => e.type === "runtimeMessage" && e.message.type === "AUTOMATION_PAUSE_CHANGED" && e.message.paused === true), "pause must reach extension panels");
  assert.equal(w.stored[MONITOR_KEY].currentTask.title, "");
  assert.equal(w.stored[MONITOR_KEY].countdownCount, 0);
});

for (const stamp of ["old", "missing", "stopped"]) {
  test(`old content events cannot refill a stopped run (${stamp} runId)`, async t => {
    const w = await boot(t);
    await w.message("STOP_RUN");
    await flush();
    const state = clone(w.state()), caches = w.caches(), effectCount = w.effects.length;
    const runStamp = stamp === "missing" ? {} : { runId: stamp === "old" ? "old-run" : state.runId };
    const messages = [
      ["CONTENT_LOG", { level: "warn", text: "LATE OLD LOG", page: { phase: "late-detail" } }],
      ["DEBUG_TASK_CANDIDATE", { task: oldTask }],
      ["LIGHTHOUSE_TARGET_TWEET_URL", { tweetUrl: xTab.url, task: oldTask }],
      ["LIGHTHOUSE_TASK_READY", { task: oldTask }],
      ["X_REPLY_RESULT", { result: { ok: true, submitted: true, replyText: "old reply" } }],
      ["LIGHTHOUSE_TASK_DONE", { result: { ok: true, completed: true } }],
      ["MONITOR_COUNTDOWN_SYNC", { tasks: [{ selectionId: "late-countdown" }], timestamp: Date.now() }],
      ["HIGH_BOUNTY_ALERT", { bounty: 5, text: "late alert", voiceText: "late voice" }],
      ["X_TASK_WIDGET_HINT", { state: { kind: "ready", actionText: "late button" }, tweetUrl: xTab.url }],
    ];
    for (const [type, extra] of messages) {
      await w.message(type, { ...extra, ...runStamp });
      assert.deepEqual(clone(w.state()), state, `${type} must not change stopped runtime`);
      assert.deepEqual(w.caches(), caches, `${type} must not refill caches`);
    }
    await flush();
    assert.deepEqual(w.effects.slice(effectCount), [], "old messages must not notify, speak, scan, navigate, or inject");
    assert.deepEqual(w.stored[STATE_KEY], state);
  });
}

test("a countdown snapshot response arriving after STOP cannot restore old candidates", async t => {
  const w = await boot(t), entered = deferred(), release = deferred();
  vm.runInContext("monitorCountdowns = { tasks: [], timestamp: 0 }", w.c);
  w.hooks.sendMessage = (_id, message) => {
    if (message.type !== "MONITOR_GET_COUNTDOWNS_SNAPSHOT") return undefined;
    entered.resolve();
    return release.promise;
  };
  const pending = w.message("MONITOR_GET_COUNTDOWNS");
  await entered.promise;
  await w.message("STOP_RUN");
  await flush();
  const stopped = clone(w.state()), effectCount = w.effects.length;
  release.resolve({ ok: true, tasks: [{ selectionId: "late-from-page" }], timestamp: Date.now() });
  const result = await pending;
  await flush();
  assert.deepEqual(w.caches().monitorCountdowns.tasks, []);
  assert.deepEqual(clone(result.tasks || []), []);
  assert.deepEqual(clone(w.state()), stopped);
  assert.deepEqual(w.effects.slice(effectCount), []);
});

test("a monitor publication waiting on history cannot overwrite the clean STOP snapshot", async t => {
  const w = await boot(t), entered = deferred(), release = deferred();
  let intercepted = false;
  w.hooks.storageGet = keys => {
    if (intercepted || keys.length !== 1 || keys[0] !== "replyHistoryRecords") return undefined;
    intercepted = true;
    entered.resolve();
    return release.promise;
  };
  const pending = w.c.writeLighthouseMonitorSnapshot("old-publication");
  await entered.promise;
  await w.message("STOP_RUN");
  await flush();
  const stopped = clone(w.stored[MONITOR_KEY]);
  release.resolve({ replyHistoryRecords: clone(w.stored.replyHistoryRecords) });
  await pending;
  await flush();
  assert.deepEqual(w.stored[MONITOR_KEY], stopped, "pre-STOP publication must be discarded after it loses ownership");
  assert.equal(w.stored[MONITOR_KEY].currentTask.title, "");
  assert.equal(w.stored[MONITOR_KEY].countdownCount, 0);
});

test("worker reboot, status reads, and leftover alarms keep manual STOP inert", async t => {
  const w = await boot(t);
  await w.message("STOP_RUN");
  await flush();
  const storedStop = clone(w.stored[STATE_KEY]), userData = persistentUserData(w.stored);
  const rebooted = await boot(t, w.stored, false);
  const state = clone(rebooted.state());
  assertCleared(state);
  assert.equal(state.runId, storedStop.runId);
  const startEffects = rebooted.effects.length;
  assert.equal((await rebooted.message("GET_STATE")).ok, true);
  const content = await rebooted.message("GET_CONTENT_SETTINGS");
  const monitor = await rebooted.message("MONITOR_GET_STATUS");
  assert.equal(content.paused, true);
  assert.equal(monitor.paused, true);
  const countdowns = await rebooted.message("MONITOR_GET_COUNTDOWNS");
  assert.deepEqual(clone(countdowns.tasks), []);
  await rebooted.c.handleAutoRunKeepaliveTick();
  await rebooted.c.handleAutoRunKeepaliveTick();
  await flush();
  assert.deepEqual(clone(rebooted.state()), state, "reads and alarms cannot refill bindings or release manual pause");
  assert.deepEqual(rebooted.stored[STATE_KEY], storedStop);
  assert.deepEqual(persistentUserData(rebooted.stored), userData);
  assert.deepEqual(rebooted.effects.slice(startEffects).filter(e => e.type !== "alarmClear"), []);
  assert.equal(rebooted.writes.filter(values => Object.hasOwn(values, STATE_KEY)).length, 0);
});

for (const command of ["START_RUN", "DEBUG_OPEN_CAMPAIGNS"]) {
  test(`${command} explicitly starts a clean run and releases manual pause`, async t => {
    const w = await boot(t);
    await w.message("STOP_RUN");
    await flush();
    assert.equal(w.state().manuallyStopped, true);
    const stoppedRunId = w.state().runId, userData = persistentUserData(w.stored), count = w.effects.length;
    const result = await w.message(command);
    await flush();
    assert.equal(result.ok, true);
    assert.equal(w.state().running, true);
    assert.equal(w.state().mode, command === "START_RUN" ? "auto" : "debug");
    assert.equal(Boolean(w.state().manuallyStopped), false);
    assert.notEqual(w.state().runId, stoppedRunId);
    assert.ok(!w.state().uncertainAction);
    assert.ok(!w.state().currentTask);
    assert.deepEqual(clone(w.state().attemptedTaskKeys), []);
    assert.ok(w.effects.slice(count).some(e => e.type === "tabMessage" && e.message.type === "AUTOMATION_PAUSE_CHANGED" && e.message.paused === false));
    assert.equal((await w.message("GET_CONTENT_SETTINGS")).paused, false);
    assert.equal((await w.message("MONITOR_GET_STATUS")).paused, false);
    assert.deepEqual(persistentUserData(w.stored), userData);
    if (command === "START_RUN") assert.equal(w.effects.filter(e => e.type === "scan").length, 1);
  });
}

test("an old expectedRunId continuation cannot release manual pause", async t => {
  const w = await boot(t);
  await w.message("STOP_RUN");
  await flush();
  const stopped = clone(w.state()), count = w.effects.length;
  const result = await w.message("DEBUG_OPEN_CAMPAIGNS", { expectedRunId: "old-run" });
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.deepEqual(clone(w.state()), stopped);
  assert.deepEqual(w.effects.slice(count), []);
});

test("an empty selected start cannot release manual pause", async t => {
  const w = await boot(t);
  await w.message("STOP_RUN");
  await flush();
  const stopped = clone(w.state()), count = w.effects.length;
  const result = await w.message("RUN_SELECTED_COUNTDOWN_TASK");
  assert.equal(result.ok, false);
  assert.equal(w.state().manuallyStopped, true);
  assert.equal(w.state().runId, stopped.runId);
  assert.equal(w.state().running, false);
  assert.deepEqual(w.effects.slice(count), []);
});

test("explicit START waits for STOP and a late cancellation reply cannot clear the new run", { timeout: 5000 }, async t => {
  const w = await boot(t), entered = deferred(), release = deferred();
  w.hooks.sendMessage = (_id, message) => {
    if (message.type !== "CANCEL_LIGHTHOUSE_RUN" || message.runId !== "old-run") return undefined;
    entered.resolve();
    return release.promise;
  };
  const stopping = w.message("STOP_RUN");
  await entered.promise;
  const starting = w.message("START_RUN");
  await flush();
  assert.equal(w.state().manuallyStopped, true, "the restart must wait for captured old-run cancellation to settle or time out");
  assert.equal(w.effects.filter(e => e.type === "scan").length, 0);
  // The browser cancellation intentionally remains unanswered until its real
  // 2250 ms boundary. A fresh run may begin only after that bounded wait.
  const start = await starting;
  assert.equal(start.ok, true);
  await flush();
  const current = clone(w.state()), count = w.effects.length;
  assert.equal(current.running, true);
  assert.notEqual(current.runId, "old-run");
  release.resolve({ ok: true });
  const result = await stopping;
  await flush();
  assert.equal(result.ok, true);
  assert.deepEqual(clone(w.state()), current);
  assert.deepEqual(w.stored[STATE_KEY], current);
  assert.deepEqual(w.effects.slice(count), [], "the old STOP may not clear alarms, pause pages, or cancel a new run");
});
