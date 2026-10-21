"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = process.env.LIGHTHOUSE_TEST_SOURCE_ROOT || path.join(__dirname, "../src");
const source = fs.readFileSync(path.join(root, "background.js"), "utf8");
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

// The public-command regression loads the whole worker and uses real STOP and
// START handlers. Browser APIs and downstream site actions stay inert.
async function publicWorker(t) {
  const stored = {}, effects = [], hooks = {}, timers = new Set();
  const event = { addListener() {} };
  const tab = { id: 11, windowId: 1, status: "complete", url: "https://app.lhdao.top/campaigns" };
  const chrome = {
    runtime: { id: "test", getURL: p => `chrome-extension://test/${p}`, getManifest: () => ({ version: "test" }), onInstalled: event, onMessage: event, async sendMessage(message) { effects.push({ type: "runtime", message: clone(message) }); return { ok: true }; } },
    storage: { session: require("./session-fixture.cjs")(), local: {
      async setAccessLevel() {}, async get(keys) {
        if (hooks.get) { const answer = hooks.get(keys); if (answer !== undefined) return answer; }
        return Object.fromEntries(keys.filter(key => Object.hasOwn(stored, key)).map(key => [key, stored[key]]));
      },
      async set(values, callback) { Object.assign(stored, clone(values)); callback?.(); },
      async remove(keys) { for (const key of [].concat(keys)) delete stored[key]; },
    } },
    alarms: { onAlarm: event, async create() {}, async clear() { return true; } },
    tabs: {
      onCreated: event, onUpdated: event, onRemoved: event,
      async get() { return tab; }, async query() { return [tab]; },
      async update(id, options) { effects.push({ type: "update", id, options }); return tab; },
      async sendMessage(id, message) { effects.push({ type: "tab", id, message: clone(message) }); return { ok: true }; },
    },
    scripting: { async executeScript() { return []; } },
  };
  const c = vm.createContext({ chrome, console, URL, AbortController, importScripts() {},
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timer.unref(); timers.add(timer); return timer; }, clearTimeout,
    fetch: async () => { throw new Error("Network forbidden in fast STOP tests"); },
  });
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  vm.runInContext(fs.readFileSync(path.join(root, "reply-engine.js"), "utf8"), c);
  vm.runInContext(source, c);
  await vm.runInContext("runtimeStateReady", c);
  await flush();
  stored.settings = clone(vm.runInContext("normalizeSettings(DEFAULT_SETTINGS)", c));
  c.startNextAutoTask = async () => ({ ok: true });
  c.ensureLighthouseAlertBridge = async () => {};
  c.openNextLighthouseTaskTweetTab = async () => { effects.push({ type: "old-fast-entry" }); throw new Error("fixture stopped site actions"); };
  vm.runInContext(`runtimeState = { ...createInitialState(), running: true, mode: "debug", runId: "old-run", stage: "old-ready", lighthouseTabId: 11, runtimeWindowId: 1 }`, c);
  const state = () => vm.runInContext("runtimeState", c);
  const message = type => c.handleMessage({ type, clientWindowId: 1 }, { id: "test", url: "chrome-extension://test/src/debug/debug.html" });
  return { c, stored, effects, hooks, state, message };
}

for (const restart of [false, true]) {
  test(`public fast command: settings response after STOP${restart ? " and START" : ""} cannot resume the old command`, { timeout: 3000 }, async t => {
    const w = await publicWorker(t), entered = deferred(), release = deferred();
    let held = false;
    w.hooks.get = keys => {
      if (held || keys.length !== 1 || keys[0] !== "settings") return undefined;
      held = true; entered.resolve(); return release.promise;
    };
    const pending = w.message("DEBUG_FAST_X_CLAIM_REPLY_VERIFY").catch(error => ({ error: error.message }));
    await entered.promise;
    assert.equal((await w.message("STOP_RUN")).ok, true);
    assert.equal(w.state().running, false);
    assert.equal(w.state().manuallyStopped, true);
    if (restart) assert.equal((await w.message("START_RUN")).ok, true);
    await flush();
    const stable = clone(w.state()), effects = clone(w.effects);
    release.resolve({ settings: w.stored.settings });
    const result = await pending;
    await flush();
    assert.deepEqual(clone(w.state()), stable, "old settings must preserve stopped/new state");
    assert.deepEqual(clone(w.effects), effects, "old settings must not reopen the fast task flow");
    assert.equal(result.cancelled, true);
  });
}

function load(name, c) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.notEqual(start, -1);
  const rest = source.slice(start), end = rest.search(/\n(?:async )?function /);
  vm.createContext(c);
  if (name !== "getSettingsForRun" && name !== "blockRunWithoutAIKey" && name !== "missingAIKeyMessage") {
    for (const dependency of ["getSettingsForRun", "blockRunWithoutAIKey", "missingAIKeyMessage"]) load(dependency, c);
  }
  vm.runInContext(end < 0 ? rest : rest.slice(0, end), c);
  return c;
}

function fixture(name, boundary) {
  const entered = deferred(), release = deferred(), effects = [];
  let held = false;
  const edge = async (kind, result) => {
    effects.push(kind);
    if (!held && kind === boundary) { held = true; entered.resolve(); await release.promise; }
    return result;
  };
  const task = { taskKey: "old-task", taskType: "评论" };
  const c = load(name, {
    runtimeState: { running: true, runId: "old-run", stopEpoch: 1, mode: "debug", stage: "old-stage", failed: 0, completed: 0, currentTask: null },
    LIGHTHOUSE_CAMPAIGNS_URL: "https://app.lhdao.top/campaigns", hasLatchedLighthouseCompletion: () => false,
    createInitialState: () => ({ runId: "fast-run", running: false, failed: 0, completed: 0 }),
    setRuntimeWindow() {}, getSettings: async () => edge("settings", { actionDelayMs: 500, aiApiKey: "fixture-key" }),
    isIgnoredNonCommentTask: () => false, markPermanentIgnoredTask: async () => edge("ignore", true),
    describeTaskForLog: () => "old task", log() {}, setStage(stage) { c.runtimeState.stage = stage; },
    openSelectedTaskTweetTab: async () => edge("open-selected", 12), openNextLighthouseTaskTweetTab: async () => edge("open-next", 12),
    getOrCreateLighthouseTab: async () => edge("lookup", { id: 11 }), resolveLighthouseTab: async () => edge("lookup", 11),
    rememberLighthouseTabById: async () => edge("remember", true),
    chrome: { tabs: { update: async () => edge("update", { id: 11 }) } },
    waitForTabComplete: async () => edge("ready", true), delay: async () => edge("delay", true),
    ensurePermanentIgnoredTaskKeysLoaded: async () => edge("ignored-load", true), getActiveAttemptedTaskKeys: () => [],
    sendToTab: async (id, message) => edge(message.type,
      message.type === "DEBUG_OPEN_FIRST_COMMENT_TASK" && boundary === "refresh"
        ? { ok: false, refreshRequested: true } : { ok: true, task }),
    refreshLighthouseCampaignsTab: async () => edge("refresh", { ok: true }),
    closeLighthouseTaskDetail: async () => edge("close", true),
    beginXOpenWatch() { effects.push("watch"); }, clearXOpenWatch() { effects.push("clear-watch"); }, markAttemptedTask() {},
    mergeTaskPreservingCapturedTweetUrl: (a, b) => ({ ...a, ...b }),
    ensureTweetTabAfterTargetClick: async () => edge("ensure-target", 12),
    openDirectTweetTabIfAvailable: async () => edge("direct-target", null),
    waitForLighthouseOpenedTweet: async () => edge("wait-target", false),
    recordReplyHistory: async () => edge("history", true),
    completeXTaskWidgetLifecycle: async () => edge("completion", { ok: true }),
    waitForLighthouseTaskCompletionAndReturn: async () => edge("campaigns", { ok: true }),
  });
  const interrupt = restarted => {
    c.runtimeState = { running: false, manuallyStopped: true, mode: "idle", runId: "stopped-run", stopEpoch: 2, stage: "stopped", currentTask: null, failed: 0, completed: 0, xTabId: null };
    if (restarted) c.runtimeState = { ...c.runtimeState, running: true, manuallyStopped: false, mode: "auto", runId: "new-run", stage: "new-stage", currentTask: { taskKey: "new-task" }, xTabId: 92 };
    const stable = clone(c.runtimeState), stableEffects = clone(effects);
    return () => { assert.deepEqual(clone(c.runtimeState), stable); assert.deepEqual(clone(effects), stableEffects); };
  };
  return { c, task, entered, release, interrupt };
}

const cases = [
  ...["open-next", "RUN_X_WIDGET_CLAIM", "RUN_X_REPLY", "history", "completion", "campaigns"].map(boundary => ({ name: "debugFastXClaimReplyVerify", boundary, args: [] })),
  ...["lookup", "refresh", "OPEN_CURRENT_DETAIL_TWEET_TARGET"].map(boundary => ({ name: "openNextLighthouseTaskTweetTab", boundary, args: [{ actionDelayMs: 500 }] })),
  ...["lookup", "OPEN_SELECTED_COUNTDOWN_TASK_TWEET"].map(boundary => ({ name: "openSelectedTaskTweetTab", boundary, args: [{ taskKey: "old-task" }, {}] })),
  ...["direct-target", "wait-target", "OPEN_CURRENT_DETAIL_TWEET_TARGET"].map(boundary => ({ name: "ensureTweetTabAfterTargetClick", boundary, args: [11, {}, { taskKey: "old-task" }, "debug"] })),
];
for (const item of cases) for (const restart of [false, true]) {
  test(`${item.name}: old ${item.boundary} response after STOP${restart ? " and restart" : ""} has no effects`, { timeout: 2000 }, async () => {
    const w = fixture(item.name, item.boundary);
    const pending = w.c[item.name](...item.args).catch(error => ({ error: error.message }));
    await w.entered.promise;
    const unchanged = w.interrupt(restart);
    w.release.resolve();
    await pending;
    unchanged();
  });
}

test("fast command can finish normally while it owns the current run", async () => {
  const w = fixture("debugFastXClaimReplyVerify", "unused");
  const complete = w.c.completeXTaskWidgetLifecycle;
  w.c.completeXTaskWidgetLifecycle = async (...args) => {
    assert.equal(w.c.runtimeState.lastXResult?.ok, true, "verification requires this run's confirmed X reply");
    return complete(...args);
  };
  assert.equal((await w.c.debugFastXClaimReplyVerify()).ok, true);
  assert.equal(w.c.runtimeState.completed, 1);
  assert.equal(w.c.runtimeState.stage, "fast_flow_done");
});
