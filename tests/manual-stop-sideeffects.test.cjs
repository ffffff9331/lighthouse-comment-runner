"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sourceRoot = process.env.LIGHTHOUSE_TEST_SOURCE_ROOT || path.join(__dirname, "../src");
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const lighthouseTab = { id: 11, windowId: 1, active: true, status: "complete", url: "https://app.lhdao.top/campaigns" };
const oldXTab = { id: 12, windowId: 1, status: "complete", openerTabId: 11, url: "https://x.com/old/status/123" };
const event = { addListener() {} };

// Real background ownership and cancellation logic, with inert Chrome edges.
// Keep the real scan entry callable while replacing only recursive/new scans.
async function worker(t) {
  const effects = [], hooks = {}, stored = {}, timers = new Set();
  const chrome = {
    runtime: {
      id: "test", getURL: value => `chrome-extension://test/${value}`,
      getManifest: () => ({ version: "test" }), onInstalled: event, onMessage: event,
      async sendMessage(message) {
        effects.push({ type: "runtimeMessage", message: clone(message) });
        return hooks.runtimeMessage ? hooks.runtimeMessage(message) : { ok: true };
      },
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
        Object.assign(stored, clone(values));
        if (hooks.storageSet) await hooks.storageSet(values);
        callback?.();
      },
    } },
    alarms: {
      onAlarm: event,
      async create(name) { effects.push({ type: "alarmCreate", name }); },
      async clear(name) { effects.push({ type: "alarmClear", name }); return true; },
    },
    notifications: { async create(id, options) {
      effects.push({ type: "notification", id, options: clone(options) });
      return hooks.notification ? hooks.notification(id, options) : id;
    } },
    tabs: {
      onCreated: event, onUpdated: event, onRemoved: event,
      async get(id) { effects.push({ type: "getTab", id }); return { ...(id === 12 ? oldXTab : lighthouseTab) }; },
      async query(query) {
        effects.push({ type: "queryTabs", query: clone(query) });
        if (hooks.query) {
          const override = hooks.query(query);
          if (override !== undefined) return override;
        }
        return [{ ...lighthouseTab }];
      },
      async create(options) { effects.push({ type: "createTab", options: clone(options) }); return { ...oldXTab, id: 13 }; },
      async update(id, options) { effects.push({ type: "updateTab", id, options: clone(options) }); return { ...(id === 12 ? oldXTab : lighthouseTab) }; },
      async remove(id) { effects.push({ type: "removeTab", id }); },
      async reload(id) { effects.push({ type: "reloadTab", id }); },
      async sendMessage(id, message) {
        effects.push({ type: "tabMessage", id, message: clone(message) });
        return { ok: true, closed: true, returned: true };
      },
    },
    scripting: { async executeScript(options) {
      effects.push({ type: "inject", options: clone(options) });
      return hooks.executeScript ? hooks.executeScript(options) : [];
    } },
  };
  const c = vm.createContext({
    chrome, console, URL, AbortController, importScripts() {},
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timer.unref(); timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
    fetch: async () => { throw new Error("No network in manual STOP side-effect tests"); },
  });
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  for (const file of ["reply-engine.js", "background.js"]) {
    vm.runInContext(fs.readFileSync(path.join(sourceRoot, file), "utf8"), c, { filename: file });
  }
  await vm.runInContext("runtimeStateReady", c);
  await flush();
  stored.settings = clone(vm.runInContext("normalizeSettings(DEFAULT_SETTINGS)", c));
  stored.monitorSettings = clone(vm.runInContext("normalizeMonitorSettings({ ...DEFAULT_MONITOR_SETTINGS, voiceEngine: 'browser' })", c));
  stored.replyHistoryRecords = [];
  vm.runInContext(`Object.assign(runtimeState, {
    running: true, mode: "auto", stage: "old-active", runId: "old-run",
    lighthouseTabId: 11, lighthouseWindowId: 1, runtimeWindowId: 1, xTabId: 12, xTabWindowId: 1,
    currentTask: null, completionEvidence: null,
    logs: [{ at: "2026-10-13T00:00:00.000Z", level: "info", text: "old run" }]
  })`, c);
  const startNext = c.startNextAutoTask;
  c.startNextAutoTask = async reason => { effects.push({ type: "scan", reason }); return { ok: true }; };
  c.ensureLighthouseAlertBridge = async () => true;
  c.waitForTabComplete = async () => true;
  c.waitForTabClosed = async () => true;
  c.delay = async () => {};
  const state = () => vm.runInContext("runtimeState", c);
  const message = (type, extra = {}) => c.handleMessage({ type, clientWindowId: 1, ...extra }, {
    id: "test", url: "chrome-extension://test/src/debug/debug.html",
  });
  const restart = async () => {
    assert.equal((await message("STOP_RUN")).ok, true);
    assert.equal((await message("START_RUN")).ok, true);
    await flush();
    assert.equal(state().running, true);
    assert.notEqual(state().runId, "old-run");
    return { state: clone(state()), effects: clone(effects), persisted: clone(stored.lighthouseAutoRunStateV1) };
  };
  const unchanged = snapshot => {
    assert.deepEqual(clone(state()), snapshot.state, "old asynchronous work must not modify the new run");
    assert.deepEqual(clone(effects), snapshot.effects, "old work must not issue browser actions, notifications, speech, or scans after restarting");
    assert.deepEqual(stored.lighthouseAutoRunStateV1, snapshot.persisted, "old work must not persist over the new run");
  };
  return { c, hooks, stored, effects, state, message, restart, unchanged, startNext };
}

test("monitor injection logs a successful acknowledgement for the current run", { timeout: 3000 }, async t => {
  const w = await worker(t);
  assert.equal(await w.c.ensureMonitorContentScriptInjected(11), true);
  assert.equal(w.state().logs[0].text, "已为 Lighthouse 页面补注入倒计时监控脚本");
});

for (const outcome of ["success", "failure"]) {
  test(`monitor injection: a late ${outcome} acknowledgement after STOP and restart cannot log into the new run`, { timeout: 3000 }, async t => {
    const w = await worker(t), entered = deferred(), release = deferred();
    t.after(() => release.resolve([]));
    w.hooks.executeScript = options => {
      if (!options.files?.includes("src/content/lighthouse-monitor.js")) return [];
      entered.resolve();
      return release.promise.then(() => {
        if (outcome === "failure") throw new Error("old monitor injection failed");
        return [];
      });
    };
    const pending = w.c.ensureMonitorContentScriptInjected(11);
    await entered.promise;
    const snapshot = await w.restart();
    release.resolve([]);
    const result = await pending;
    await flush();
    w.unchanged(snapshot);
    assert.equal(result, false, "old injection must not authorize further work");
  });
}

test("a HIGH_BOUNTY_ALERT speech acknowledgement cannot append an old alert after STOP and restart", { timeout: 3000 }, async t => {
  const w = await worker(t), entered = deferred(), release = deferred();
  t.after(() => release.resolve({ ok: true }));
  w.hooks.runtimeMessage = message => {
    if (message.type !== "PANEL_SPEAK_TEXT") return { ok: true };
    entered.resolve();
    return release.promise;
  };
  const pending = w.message("HIGH_BOUNTY_ALERT", { bounty: "5", text: "old bounty", voiceText: "old speech" });
  await entered.promise;
  const snapshot = await w.restart();
  release.resolve({ ok: true });
  await pending;
  await flush();
  w.unchanged(snapshot);
});

test("a widget notification acknowledgement cannot append an old widget hint after STOP and restart", { timeout: 3000 }, async t => {
  const w = await worker(t), entered = deferred(), release = deferred();
  t.after(() => release.resolve("fixture-notification"));
  w.hooks.notification = () => { entered.resolve(); return release.promise; };
  const pending = w.c.handleXTaskWidgetHint({ state: { kind: "ready", actionText: "old action" }, tweetUrl: oldXTab.url }, { tab: oldXTab });
  await entered.promise;
  const snapshot = await w.restart();
  release.resolve("fixture-notification");
  await pending;
  await flush();
  w.unchanged(snapshot);
});

for (const operation of ["startNextAutoTask", "recoverAndContinue", "handleLighthouseDone"]) {
  test(`${operation}: a settings read crossing STOP and restart cannot act on the new run`, { timeout: 3000 }, async t => {
    const w = await worker(t), entered = deferred(), release = deferred();
    t.after(() => release.resolve({ settings: clone(w.stored.settings) }));
    let intercepted = false;
    w.hooks.storageGet = keys => {
      if (intercepted || keys.length !== 1 || keys[0] !== "settings") return undefined;
      intercepted = true;
      entered.resolve();
      return release.promise;
    };
    // Debug completion uses the legacy completion callback without requiring
    // an automatic run's official-evidence gate; the callback itself is real.
    if (operation === "handleLighthouseDone") w.state().mode = "debug";
    const pending = operation === "startNextAutoTask" ? w.startNext("old-scan")
      : operation === "recoverAndContinue" ? w.c.recoverAndContinue("old failure", { runId: "old-run" })
        : w.c.handleLighthouseDone({ ok: true, message: "old completion" });
    await entered.promise;
    const snapshot = await w.restart();
    release.resolve({ settings: clone(w.stored.settings) });
    await pending;
    await flush();
    w.unchanged(snapshot);
  });
}

test("a captured-target tab query crossing STOP and restart cannot adopt or open an old X target", { timeout: 3000 }, async t => {
  const w = await worker(t), entered = deferred(), release = deferred();
  t.after(() => release.resolve([]));
  Object.assign(w.state(), {
    xTabId: null, xTabWindowId: null,
    currentTask: { taskKey: "old-locked", seatLocked: true, tweetUrl: oldXTab.url },
    pendingXOpen: { lighthouseTabId: 11, windowId: 1, startedAt: Date.now(), createdTabIds: [], candidates: [] },
  });
  let intercepted = false;
  w.hooks.query = query => {
    if (intercepted || !Array.isArray(query.url) || query.url.length !== 2) return undefined;
    intercepted = true;
    entered.resolve();
    return release.promise;
  };
  const pending = w.c.recoverPendingXOpenFromCapturedUrl(oldXTab.url);
  await entered.promise;
  const snapshot = await w.restart();
  release.resolve([{ ...oldXTab, lastAccessed: Date.now() }]);
  await pending;
  await flush();
  w.unchanged(snapshot);
});

test("a permanent-ignore lookup crossing STOP and restart cannot add an old task or log", { timeout: 3000 }, async t => {
  const w = await worker(t), entered = deferred(), release = deferred();
  t.after(() => release.resolve({}));
  vm.runInContext("permanentIgnoredTaskKeysLoaded = false", w.c);
  const key = vm.runInContext("PERMANENT_IGNORED_TASK_KEYS_KEY", w.c);
  w.hooks.storageGet = keys => {
    if (keys.length !== 1 || keys[0] !== key) return undefined;
    entered.resolve();
    return release.promise;
  };
  const pending = w.c.markPermanentIgnoredTask({ taskKey: "old-ignored-task", taskType: "old-type" });
  await entered.promise;
  const snapshot = await w.restart();
  const storedKeys = clone(w.stored[key]);
  release.resolve({ [key]: [] });
  await pending;
  await flush();
  w.unchanged(snapshot);
  assert.deepEqual(w.stored[key], storedKeys, "old ignore request must not change saved exclusions");
  assert.equal(vm.runInContext("permanentIgnoredTaskKeysCache.has('old-ignored-task')", w.c), false);
});

for (const operation of ["markPermanentIgnoredTask", "recordReplyHistory"]) {
  test(`${operation}: an old persistence acknowledgement cannot log into a restarted run`, { timeout: 3000 }, async t => {
    const w = await worker(t), entered = deferred(), release = deferred();
    t.after(() => release.resolve());
    const key = operation === "recordReplyHistory" ? "replyHistoryRecords"
      : vm.runInContext("PERMANENT_IGNORED_TASK_KEYS_KEY", w.c);
    w.hooks.storageSet = values => {
      if (!(key in values)) return undefined;
      entered.resolve();
      return release.promise;
    };
    const pending = operation === "recordReplyHistory"
      ? w.c.recordReplyHistory({ ok: true, replyText: "completed reply retained", tweet: { url: oldXTab.url } })
      : w.c.markPermanentIgnoredTask({ taskKey: "old-ignored-task", taskType: "old-type" });
    await entered.promise;
    const snapshot = await w.restart();
    release.resolve();
    await pending;
    await flush();
    w.unchanged(snapshot);
    if (operation === "recordReplyHistory") {
      assert.equal(w.stored.replyHistoryRecords[0].replyText, "completed reply retained", "STOP must retain completed reply history");
    }
  });
}
