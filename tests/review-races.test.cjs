"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sourceRoot = process.env.LIGHTHOUSE_TEST_SOURCE_ROOT || path.join(__dirname, "../src");
const readSource = file => fs.readFileSync(path.join(sourceRoot, file), "utf8");
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
  const stored = options.savedState ? { lighthouseAutoRunStateV1: clone(options.savedState) } : {};
  const effects = [], hooks = {};
  const chrome = {
    runtime: {
      id: "test", getURL: (p) => `chrome-extension://test/${p}`,
      getManifest: () => ({ version: "test" }), onInstalled: event, onMessage: event
    },
    storage: { local: {
      setAccessLevel: async () => {},
      get: async (keys) => hooks.storageGet ? hooks.storageGet(keys) : Object.fromEntries(keys.map((key) => [key, stored[key]])),
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
    fetch: async () => { throw new Error("Network forbidden in review race tests"); }
  });
  for (const file of ["reply-engine.js", "background.js"]) {
    vm.runInContext(readSource(file), c, { filename: file });
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
  if (!options.savedState) vm.runInContext(`Object.assign(runtimeState, {
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

// The production listener and executeXStep/assertActiveRun remain intact.
// Only its DOM observer startup is disabled; the deferred final action is a
// local counter, so these cancellation checks cannot post or use the network.
async function pendingXAction(w) {
  const entered = deferred(), release = deferred();
  let listener, actions = 0;
  const c = vm.createContext({ URL, console,
    location: { href: "https://x.com/old/status/111" },
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } }
  });
  let source = readSource("content/x.js").replace("  startTaskWidgetAssist();", "  // DOM observer disabled by offline fixture.");
  const end = source.lastIndexOf("})();");
  source = source.slice(0, end)
    + "globalThis.fixtureExecute = executeXStep; globalThis.fixtureAssert = assertActiveRun;\n"
    + source.slice(end);
  vm.runInContext(source, c, { filename: "content/x.js" });
  const pending = c.fixtureExecute({ type: "RUN_X_REPLY", platform: "lighthouse", runId: "uncertain-run",
    task: { taskKey: "old-task", tweetUrl: "https://x.com/old/status/111" }
  }, async () => {
    entered.resolve();
    await release.promise;
    c.fixtureAssert("uncertain-run");
    actions += 1;
    return { ok: true };
  });
  await entered.promise;
  w.c.chrome.tabs.sendMessage = async (id, message) => {
    w.effects.push({ type: message.type, id, runId: message.runId });
    if (id === 12) return new Promise(resolve => listener(message, {}, resolve));
    return { ok: true };
  };
  return { release, pending, actions: () => actions };
}

function installUnresolvedSnapshot(w) {
  vm.runInContext(`Object.assign(runtimeState, {
    running: false, mode: "idle", stage: "stopped", runId: "stop-rotated-run", xTabId: 12,
    currentTask: { taskKey: "old-task", tweetUrl: "https://x.com/old/status/111", seatLocked: true },
    uncertainAction: { type: "RUN_X_REPLY", runId: "uncertain-run", tabId: 12, taskKey: "old-task" }
  })`, w.c);
}

test("full restart cannot discard a complete unresolved X action or start a new scan", { timeout: 3000 }, async () => {
  const w = await worker();
  installUnresolvedSnapshot(w);
  let scans = 0;
  w.c.startNextAutoTask = async () => { scans += 1; return { ok: true }; };
  const priorIntent = clone(w.state().uncertainAction);
  const priorTask = clone(w.state().currentTask);
  const result = await w.message("START_RUN");
  assert.equal(result.ok, false, "an unresolved live action must prevent a new scan");
  assert.equal(scans, 0, "the old order must be reconciled before scanning again");
  assert.deepEqual(clone(w.state().uncertainAction), priorIntent);
  assert.deepEqual(clone(w.state().currentTask), priorTask);
  assert.equal(w.state().running, false);
});

test("full restart cancellation reaches the unresolved X action despite a rotated run and missing tab binding", { timeout: 3000 }, async () => {
  const w = await worker();
  installUnresolvedSnapshot(w);
  // The persisted action is the authoritative cancellation target even when
  // the ordinary tab binding has been lost or replaced since STOP.
  w.state().xTabId = null;
  const x = await pendingXAction(w);
  const intent = clone(w.state().uncertainAction);
  let scans = 0;
  w.c.startNextAutoTask = async () => { scans += 1; return { ok: true }; };
  let restarted;
  try {
    restarted = await w.message("START_RUN");
  } finally {
    x.release.resolve();
  }
  const result = await x.pending;
  const xCancels = w.effects.filter(effect => effect.type === "CANCEL_X_RUN");
  assert.ok(xCancels.some(effect => effect.runId === intent.runId), "cancel the action's real run, not only the stopped snapshot's new ID");
  assert.equal(restarted.ok, false, "cancelling the X loop does not prove the order was never posted");
  assert.equal(scans, 0);
  assert.equal(result.ok, false, "the real X guard must reject the cancelled old step");
  assert.equal(x.actions(), 0, "no local action may run after cancellation");
  assert.deepEqual(clone(w.state().uncertainAction), intent, "a cancellation ACK alone is not completion evidence");
});

test("selected restart preserves a complete unresolved X action and sends no new task action", { timeout: 3000 }, async () => {
  const w = await worker();
  installUnresolvedSnapshot(w);
  const priorIntent = clone(w.state().uncertainAction), priorTask = clone(w.state().currentTask);
  const result = await w.message("RUN_SELECTED_COUNTDOWN_TASK", { selectedTask: { taskType: "评论", selectionId: "selected-next" } });
  assert.equal(result.ok, false);
  assert.deepEqual(clone(w.state().uncertainAction), priorIntent, "a selected task cannot replace the old unresolved action");
  assert.deepEqual(clone(w.state().currentTask), priorTask);
  assert.equal(w.state().running, false);
  assert.deepEqual(w.effects.filter(effect => !effect.type.startsWith("CANCEL_")), [], "only cancellation may reach the page before reconciliation");
});

test("a selected-start cancellation finishing first cannot defeat a newer pending STOP", { timeout: 3000 }, async () => {
  const w = await worker();
  const entered1 = deferred(), entered2 = deferred(), release1 = deferred(), release2 = deferred();
  let cancels = 0;
  w.c.chrome.tabs.sendMessage = async (id, message) => {
    w.effects.push({ type: message.type, id, runId: message.runId });
    if (message.type === "CANCEL_LIGHTHOUSE_RUN") {
      const sequence = ++cancels;
      if (sequence === 1) { entered1.resolve(); await release1.promise; }
      if (sequence === 2) { entered2.resolve(); await release2.promise; }
      return { ok: true };
    }
    return { ok: false, claimActionAttempted: false, message: "offline platform refusal" };
  };
  const selected = w.message("RUN_SELECTED_COUNTDOWN_TASK", { selectedTask: { taskType: "评论", selectionId: "selected-next" } });
  await entered1.promise;
  const stop = w.message("STOP_RUN");
  await entered2.promise;
  const effectsAtStop = clone(w.effects);
  release1.resolve();
  const selectedResult = await selected;
  release2.resolve();
  const stopResult = await stop;
  assert.equal(stopResult.ok, true, "the later explicit STOP must remain authoritative");
  assert.equal(selectedResult.ok, false);
  assert.equal(w.state().running, false);
  assert.equal(w.state().stage, "stopped");
  assert.deepEqual(clone(w.effects), effectsAtStop, "the cancelled selected start must not open, focus, or claim a task");
});

test("04 real delayed X lookup cannot clear or rewrite a newer run's bound X tab", { timeout: 3000 }, async () => {
  const w = await worker({ realLookups: true });
  const entered = deferred(), release = deferred();
  vm.runInContext('runtimeState.xTabId=12; runtimeState.xTabWindowId=1; runtimeState.currentTask.tweetUrl="https://x.com/old/status/111"', w.c);
  w.hooks.get = async id => {
    if (id === 12) {
      entered.resolve(); await release.promise;
      return { id: 12, windowId: 1, url: "https://x.com/old/status/111" };
    }
    return lighthouseTab;
  };
  const pending = w.message("DEBUG_RUN_X_REPLY").catch(error => ({ ok: false, error: error.message }));
  await entered.promise;
  vm.runInContext(`runtimeState = { ...createInitialState(), running: true, mode: "auto", runId: "new-run", stage: "new_run_owned",
    runtimeWindowId: 2, lighthouseWindowId: 2, lighthouseTabId: 21, xTabId: 22, xTabWindowId: 2,
    currentTask: { taskKey: "new-task", tweetUrl: "https://x.com/new/status/222", seatLocked: true }
  }`, w.c);
  const stableState = clone(w.state()), stableEffects = clone(w.effects);
  release.resolve();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.deepEqual(clone(w.state()), stableState, "an old lookup must not clear the newer run's X binding");
  assert.deepEqual(clone(w.effects), stableEffects);
});

test("06 real delayed Lighthouse lookup cannot overwrite stopped state inside its completion helper", { timeout: 3000 }, async () => {
  const w = await worker({ realLookups: true });
  const entered = deferred(), release = deferred();
  let first = true;
  w.hooks.get = async () => {
    if (first) { first = false; entered.resolve(); await release.promise; }
    return lighthouseTab;
  };
  const pending = w.message("DEBUG_WAIT_LIGHTHOUSE_COMPLETION_RETURN");
  await entered.promise;
  assert.equal((await w.message("STOP_RUN")).ok, true);
  const stableState = clone(w.state()), stableEffects = clone(w.effects);
  release.resolve();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.deepEqual(clone(w.state()), stableState, "outer cancellation must not hide a late inner stage/log write");
  assert.deepEqual(clone(w.effects), stableEffects);
});

test("a new full start paused in its real settings read cannot continue after STOP", { timeout: 3000 }, async () => {
  const w = await worker();
  vm.runInContext('runtimeState = createInitialState(); runtimeState.runtimeWindowId = 1', w.c);
  const entered = deferred(), release = deferred();
  let paused = false;
  w.hooks.storageGet = async keys => {
    if (keys.includes("settings") && !paused) {
      paused = true; entered.resolve(); await release.promise;
    }
    return {};
  };
  const pending = w.message("START_RUN");
  await entered.promise;
  assert.equal((await w.message("STOP_RUN")).ok, true);
  const stableState = clone(w.state()), stableEffects = clone(w.effects);
  release.resolve();
  const result = await pending;
  assert.equal(result.ok, false, "an old start must report cancellation after STOP");
  assert.deepEqual(clone(w.state()), stableState, "resuming a startup settings read must not rewrite stopped state");
  assert.deepEqual(clone(w.effects), stableEffects, "no old startup may focus or open a tab after STOP");
});

test("a new selected start paused in its real tab lookup cannot continue after STOP", { timeout: 3000 }, async () => {
  const w = await worker({ realLookups: true });
  vm.runInContext('runtimeState = createInitialState(); runtimeState.runtimeWindowId = 1', w.c);
  const entered = deferred(), release = deferred();
  let paused = false;
  w.hooks.query = async () => {
    if (!paused) { paused = true; entered.resolve(); await release.promise; }
    return [lighthouseTab];
  };
  const pending = w.message("RUN_SELECTED_COUNTDOWN_TASK", { selectedTask: { taskType: "评论", selectionId: "selected-next" } });
  await entered.promise;
  assert.equal((await w.message("STOP_RUN")).ok, true);
  const stableState = clone(w.state()), stableEffects = clone(w.effects);
  release.resolve();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.deepEqual(clone(w.state()), stableState, "resuming a selected startup lookup must not write tab bindings or failure stages");
  assert.deepEqual(clone(w.effects), stableEffects, "no selected startup may navigate or claim after STOP");
});

test("a restored STOP epoch cannot be reused by the fresh worker's second command", { timeout: 3000 }, async () => {
  const w = await worker({ savedState: {
    running: false, mode: "idle", stage: "stopped", runId: "old-run", stopEpoch: 2,
    lighthouseTabId: 11, lighthouseWindowId: 1, runtimeWindowId: 1,
    currentTask: { taskKey: "old-task", seatLocked: false }, logs: []
  } });
  assert.equal(w.state().stopEpoch, 2, "the epoch must come from production snapshot restoration");
  const entered1 = deferred(), entered2 = deferred(), release1 = deferred(), release2 = deferred();
  let cancels = 0;
  w.c.chrome.tabs.sendMessage = async (id, message) => {
    w.effects.push({ type: message.type, id, runId: message.runId });
    if (message.type === "CANCEL_LIGHTHOUSE_RUN") {
      const sequence = ++cancels;
      if (sequence === 1) { entered1.resolve(); await release1.promise; }
      if (sequence === 2) { entered2.resolve(); await release2.promise; }
      return { ok: true };
    }
    return { ok: false, claimActionAttempted: false, message: "offline platform refusal" };
  };
  // START_SELECTED advances the new worker's queue epoch to 1, then STOP to 2.
  // Reusing that number as the persisted state's STOP identity loses the event.
  const selected = w.message("RUN_SELECTED_COUNTDOWN_TASK", { selectedTask: { taskType: "评论", selectionId: "selected-next" } });
  await entered1.promise;
  const stop = w.message("STOP_RUN");
  await entered2.promise;
  const stableEffects = clone(w.effects);
  release1.resolve();
  const selectedResult = await selected;
  release2.resolve();
  const stopResult = await stop;
  assert.equal(stopResult.ok, true, "the newer STOP must win even after restoring an identical numeric epoch");
  assert.equal(selectedResult.ok, false);
  assert.equal(w.state().running, false);
  assert.equal(w.state().stage, "stopped");
  assert.deepEqual(clone(w.effects), stableEffects, "the old selected request must perform no page action after STOP");
});
