"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sourceRoot = process.env.LIGHTHOUSE_TEST_SOURCE_ROOT || path.join(__dirname, "../src");
const clone = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const event = { addListener() {} };
const lighthouseTab = { id: 11, windowId: 1, url: "https://app.lhdao.top/campaigns" };

// Load the full production background. Only browser and timing boundaries are
// fixtures, so late returns exercise the real command and close-helper guards.
async function worker(options = {}) {
  const stored = {}, effects = [], hooks = {};
  const chrome = {
    runtime: {
      id: "test", getURL: (p) => `chrome-extension://test/${p}`,
      getManifest: () => ({ version: "test" }), onInstalled: event, onMessage: event
    },
    storage: { session: require("./session-fixture.cjs")(), local: {
      setAccessLevel: async () => {},
      get: async (keys) => Object.fromEntries(keys.map((key) => [key, stored[key]])),
      set: async (values, callback) => { Object.assign(stored, clone(values)); callback?.(); }
    } },
    alarms: { onAlarm: event, create: async () => {}, clear: async () => {} },
    tabs: {
      onCreated: event, onUpdated: event, onRemoved: event,
      get: async (id) => hooks.get ? hooks.get(id) : lighthouseTab,
      query: async (query) => hooks.query ? hooks.query(query) : [lighthouseTab],
      create: async (properties) => { effects.push({ type: "create", properties }); return lighthouseTab; },
      update: async (id, options) => { effects.push({ type: "update", id, options }); return lighthouseTab; },
      reload: async (id) => { effects.push({ type: "reload", id }); },
      sendMessage: async (id, message) => {
        effects.push({ type: message.type, id, runId: message.runId });
        if (message.type.startsWith("CANCEL_")) return { ok: true };
        if (hooks.sendMessage) return hooks.sendMessage(id, message);
        return { ok: true, task: { taskKey: "old-task", seatLocked: false } };
      }
    }
  };
  const c = vm.createContext({
    chrome, URL, AbortController, console, importScripts() {}, clearTimeout,
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; },
    fetch: async () => { throw new Error("Network forbidden in manual step stop tests"); }
  });
  for (const file of ["reply-engine.js", "background.js"]) {
    vm.runInContext(fs.readFileSync(path.join(sourceRoot, file), "utf8"), c, { filename: file });
  }
  await vm.runInContext("runtimeStateReady", c);
  Object.assign(c, {
    publishLighthouseMonitorSnapshot() {}, ensureLighthouseAlertBridge: async () => {},
    waitForTabComplete: async () => true,
    waitForLighthouseOpenedTweet: async () => ({ id: 12 }),
    delay: async () => {}
  });
  if (!options.realLookups) Object.assign(c, {
    getActiveLighthouseTab: async () => lighthouseTab,
    getOrCreateLighthouseTab: async () => lighthouseTab,
    resolveLighthouseTab: async () => lighthouseTab.id
  });
  vm.runInContext(`Object.assign(runtimeState, {
    running: true, mode: "debug", stage: "old_step_ready", runId: "old-run",
    lighthouseTabId: 11, lighthouseWindowId: 1, runtimeWindowId: 1,
    currentTask: { taskKey: "old-task", seatLocked: false }
  })`, c);
  const state = () => vm.runInContext("runtimeState", c);
  const message = (type, extra = {}) => c.handleMessage({ type, clientWindowId: 1, ...extra }, {
    id: "test", url: "chrome-extension://test/src/debug/debug.html"
  });
  const interrupt = async (kind) => {
    if (kind === "STOP") {
      assert.equal((await message("STOP_RUN")).ok, true);
      assert.equal(state().stage, "stopped");
    } else {
      // START_RUN / selected-task launch replaces ownership outside the manual
      // command tail. Keep its downstream site automation out of this fixture.
      vm.runInContext(`manualDebugCommandEpoch += 1;
        runtimeState = { ...createInitialState(), running: true, mode: "auto", stage: "new_run_owned",
          runId: "new-run", lighthouseTabId: 11, lighthouseWindowId: 1, runtimeWindowId: 1,
          currentTask: { taskKey: "new-task", seatLocked: true } };`, c);
    }
  };
  return { c, hooks, effects, state, message, interrupt };
}

for (const command of ["DEBUG_OPEN_CAMPAIGNS", "DEBUG_OPEN_FIRST_TASK", "DEBUG_LOCK_SEAT_OPEN_TWEET", "DEBUG_RETURN_CAMPAIGNS"]) {
  for (const interruption of ["STOP", "new run"]) {
    test(`${command}: a delayed browser lookup after ${interruption} cannot continue or overwrite state`, { timeout: 3000 }, async () => {
      const w = await worker(), entered = deferred(), release = deferred();
      const pause = async (value) => { entered.resolve(); await release.promise; return value; };
      if (command === "DEBUG_OPEN_CAMPAIGNS") {
        w.c.getActiveLighthouseTab = () => pause(lighthouseTab);
      } else if (command === "DEBUG_RETURN_CAMPAIGNS") {
        let first = true;
        w.c.waitForTabComplete = async () => {
          if (first) { first = false; return pause(true); }
          return true;
        };
      } else {
        w.c.resolveLighthouseTab = () => pause(lighthouseTab.id);
      }
      const pending = w.message(command, { expectedRunId: "old-run" });
      await entered.promise;
      await w.interrupt(interruption);
      const stableState = clone(w.state());
      const stableEffects = clone(w.effects);
      release.resolve();
      const result = await pending;
      assert.equal(result.ok, false, "the old command must not report success after losing ownership");
      assert.deepEqual(clone(w.state()), stableState, "late command completion must preserve stopped/new-run state");
      assert.deepEqual(clone(w.effects), stableEffects, "late command completion must not navigate, reload, or dispatch a page action");
    });
  }
}

for (const interruption of ["STOP", "new run"]) {
  test(`a late task-drawer response after ${interruption} cannot trigger reload fallback`, { timeout: 3000 }, async () => {
    const w = await worker(), entered = deferred(), release = deferred();
    w.hooks.sendMessage = async (_id, message) => {
      assert.equal(message.type, "CLOSE_LIGHTHOUSE_TASK_DETAIL");
      entered.resolve();
      await release.promise;
      return { ok: false, message: "old drawer close failed" };
    };
    const pending = w.message("DEBUG_RETURN_CAMPAIGNS", { expectedRunId: "old-run" });
    await entered.promise;
    await w.interrupt(interruption);
    const stableState = clone(w.state());
    const stableEffects = clone(w.effects);
    release.resolve();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.deepEqual(clone(w.state()), stableState);
    assert.deepEqual(clone(w.effects), stableEffects);
    assert.equal(w.effects.filter((effect) => effect.type === "reload").length, 0);
  });
}

const lookupCases = [
  { command: "DEBUG_OPEN_CAMPAIGNS", boundary: "active tabs.query", method: "query" },
  { command: "DEBUG_OPEN_CAMPAIGNS", boundary: "fallback tabs.query", method: "query", fallback: true },
  ...["DEBUG_OPEN_FIRST_TASK", "DEBUG_LOCK_SEAT_OPEN_TWEET", "DEBUG_RETURN_CAMPAIGNS"]
    .flatMap((command) => [
      { command, boundary: "remembered tabs.get", method: "get" },
      { command, boundary: "active tabs.query", method: "query" }
    ])
];

for (const { command, boundary, method, fallback } of lookupCases) {
  for (const interruption of ["STOP", "new run"]) {
    test(`${command}: real ${boundary} returning after ${interruption} cannot adopt an old tab`, { timeout: 3000 }, async () => {
      const w = await worker({ realLookups: true }), entered = deferred(), release = deferred();
      // A tab can move windows while Chrome resolves a query. Its late window
      // metadata must not rewrite the stopped or replacement run's ownership.
      const lateTab = { ...lighthouseTab, windowId: 9 };
      if (method === "query") {
        w.state().lighthouseTabId = null;
        w.hooks.query = async (query) => {
          if (fallback && query.active) return [];
          entered.resolve();
          await release.promise;
          return [lateTab];
        };
      } else {
        w.hooks.get = async (id) => {
          assert.equal(id, lighthouseTab.id);
          entered.resolve();
          await release.promise;
          return lateTab;
        };
      }
      const pending = w.message(command, { expectedRunId: "old-run" });
      await entered.promise;
      await w.interrupt(interruption);
      const stableState = clone(w.state());
      const stableEffects = clone(w.effects);
      release.resolve();
      const result = await pending;
      assert.equal(result.ok, false);
      assert.deepEqual(clone(w.state()), stableState, "a real lookup must not remember its stale tab after ownership changes");
      assert.deepEqual(clone(w.effects), stableEffects, "a stale lookup must not create, activate, reload, or dispatch actions");
    });
  }
}
