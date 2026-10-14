"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const sourceRoot = process.env.LIGHTHOUSE_TEST_SOURCE_ROOT || path.join(__dirname, "../src");
const source = fs.readFileSync(path.join(sourceRoot, "background.js"), "utf8");
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function load(names, context) {
  vm.createContext(context);
  for (const name of names) {
    const pattern = new RegExp(`^(?:async )?function ${name}\\(`, "m");
    const start = source.search(pattern);
    assert.notEqual(start, -1, `missing ${name}`);
    const remaining = source.slice(start);
    const next = remaining.search(/\n(?:async )?function /);
    vm.runInContext(next < 0 ? remaining : remaining.slice(0, next), context);
  }
  return context;
}

// STOP discards the old state object; a later authorized manual start installs
// a fresh identity. Hooks pause real orchestration at Chrome/content boundaries.
function restart(context, effects) {
  context.runtimeState = { running: false, manuallyStopped: true, runId: "stopped-run", stopEpoch: 2 };
  context.selectedStartInFlight = false;
  context.runtimeState = {
    running: true, runId: "new-run", stopEpoch: 2, mode: "debug", stage: "new-stage",
    currentTask: { taskKey: "new-task" }, lighthouseTabId: 91, xTabId: 92, xTabWindowId: 9,
    failed: 0, completed: 0,
  };
  const snapshot = { state: clone(context.runtimeState), effects: clone(effects) };
  return () => {
    assert.deepEqual(clone(context.runtimeState), snapshot.state, "old work must not change the new run");
    assert.deepEqual(clone(effects), snapshot.effects, "old work must not dispatch actions after restart");
  };
}

function selectedWorker(boundary) {
  const effects = [], entered = deferred(), release = deferred();
  let held = false;
  const edge = async (name, result) => {
    effects.push({ name });
    if (!held && name === boundary) { held = true; entered.resolve(); await release.promise; }
    return result;
  };
  const c = load(["runSelectedCountdownTask"], {
    runtimeState: { stopEpoch: 1 },
    createInitialState: () => ({ failed: 0, completed: 0 }), setRuntimeWindow() {}, createRunId: () => "old-run",
    ensureAutoRunKeepalive: async () => {}, isIgnoredNonCommentTask: () => false,
    getSettings: async () => ({ replyMode: "post", autoSubmitLighthouse: true }),
    resolveLighthouseTab: async () => 11, rememberLighthouseTabById: async () => {},
    chrome: { tabs: { update: async () => {} } }, waitForTabComplete: async () => {},
    log() {}, setStage(stage) { c.runtimeState.stage = stage; },
    sendToTab: async (tabId, message) => {
      effects.push({ name: "send", tabId, type: message.type, runId: message.runId });
      return edge(message.type, { ok: true, task: { taskKey: "old-task" } });
    },
    waitForSelectedCountdownWindow: async () => edge("countdown", { taskKey: "old-task" }),
    beginXOpenWatch() { effects.push({ name: "watch" }); }, clearXOpenWatch() {}, markAttemptedTask() {},
    waitForLighthouseOpenedTweet: async () => { c.runtimeState.xTabId = 12; return edge("adopt", true); },
    waitForXReadyBeforeReply: async () => edge("ready", true),
    recordReplyHistory: async () => edge("history", true),
    completeXTaskWidgetLifecycle: async () => edge("completion", { ok: true }),
    waitForLighthouseTaskCompletionAndReturn: async () => edge("campaigns", { ok: true }),
    closeLighthouseDetailToCampaigns: async () => edge("close", true),
    closeLighthouseTaskDetail: async () => edge("close-failure", true),
  });
  return { c, effects, entered, release };
}

for (const boundary of ["countdown", "WAIT_SELECTED_COUNTDOWN_AND_LOCK", "adopt", "ready", "RUN_X_REPLY", "history", "completion", "campaigns", "close"]) {
  test(`selected task: ${boundary} completion after STOP and restart has no effect`, { timeout: 2000 }, async () => {
    const w = selectedWorker(boundary);
    const pending = w.c.runSelectedCountdownTask({ taskKey: "old-task" });
    await w.entered.promise;
    const unchanged = restart(w.c, w.effects);
    w.release.resolve();
    assert.equal((await pending).cancelled, true);
    unchanged();
  });
}

test("selected task still completes when its identity remains current", async () => {
  const w = selectedWorker("unused");
  assert.equal((await w.c.runSelectedCountdownTask({ taskKey: "old-task" })).ok, true);
  assert.equal(w.c.runtimeState.stage, "selected_flow_done");
  assert.equal(w.c.runtimeState.completed, 1);
});

for (const boundary of ["tab", "window"]) {
  test(`focus X: old ${boundary} update receipt cannot restore cleared tab records`, async () => {
    const effects = [], entered = deferred(), release = deferred();
    const c = load(["focusTaskXTab"], {
      runtimeState: { runId: "old-run", running: true },
      chrome: {
        tabs: { async update() { effects.push("tab"); if (boundary === "tab") { entered.resolve(); await release.promise; } return { id: 12, windowId: 1 }; } },
        windows: { async update() { effects.push("window"); if (boundary === "window") { entered.resolve(); await release.promise; } } },
      },
    });
    const pending = c.focusTaskXTab(12);
    await entered.promise;
    const unchanged = restart(c, effects);
    release.resolve();
    await pending;
    unchanged();
  });
}

for (const boundary of ["settings", "target"]) {
  test(`adopt X: old ${boundary} response cannot open a fallback for the new task`, async () => {
    const effects = [], entered = deferred(), release = deferred();
    const c = load(["adoptTargetOpenedTweet"], {
      runtimeState: { runId: "old-run", running: true, mode: "auto", currentTask: { taskKey: "old-task" }, lighthouseTabId: 11 },
      mergeTaskPreservingCapturedTweetUrl: (a, b) => ({ ...a, ...b }), rememberLighthouseTabById: async () => {},
      async getSettings() { if (boundary === "settings") { entered.resolve(); await release.promise; } return {}; },
      SITE_X_OPEN_WAIT_MS: 5000,
      async waitForLighthouseOpenedTweet() { effects.push("wait-target"); if (boundary === "target") { entered.resolve(); await release.promise; } return false; },
      async openDirectTweetTabIfAvailable(task) { effects.push({ type: "open", task: clone(task) }); return 12; },
      log() {}, setStage(stage) { c.runtimeState.stage = stage; },
    });
    const pending = c.adoptTargetOpenedTweet({ taskKey: "old-task" }, 11, "auto");
    await entered.promise;
    const unchanged = restart(c, effects);
    release.resolve();
    assert.equal((await pending).cancelled, true);
    unchanged();
  });
}

test("official completion: old X cancellation receipt cannot overwrite a new stage", async () => {
  const effects = [], entered = deferred(), release = deferred();
  const c = load(["completeXTaskWidgetLifecycle"], {
    runtimeState: { runId: "old-run", running: true },
    setStage(stage) { c.runtimeState.stage = stage; }, log() {},
    async sendToTab(tabId, message) {
      effects.push(message.type);
      if (message.type === "COMPLETE_X_TASK_WIDGET") return new Promise(() => {});
      entered.resolve(); await release.promise; return { ok: true };
    },
    waitForOfficialLighthouseCompletionDuringXSubmission: async () => ({ ok: true }),
  });
  const pending = c.completeXTaskWidgetLifecycle(12, "old-run", {});
  await entered.promise;
  const unchanged = restart(c, effects);
  release.resolve();
  assert.equal((await pending).cancelled, true);
  unchanged();
});

test("selected countdown final jitter cannot return an old task after restart", async () => {
  const entered = deferred(), release = deferred();
  let now = 0;
  const c = load(["waitForSelectedCountdownWindow"], {
    runtimeState: { runId: "old-run", running: true, mode: "selected_once" },
    Date: { now: () => now }, log() {}, formatDuration: String, randomBetween: () => 10,
    async delay(ms) { if (ms === 10) { entered.resolve(); await release.promise; } else now += ms; },
  });
  const pending = c.waitForSelectedCountdownWindow({ countdownSec: 6 }, { cooldownPollMs: 500 });
  await entered.promise;
  restart(c, []);
  release.resolve();
  assert.equal(await pending, null);
});

test("old selected-start finally cannot unlock a new selected-start request", async () => {
  const entered = deferred(), release = deferred();
  const c = load(["startSelectedCountdownTask"], {
    runtimeState: { runId: "old-run", stopEpoch: 1 }, selectedStartInFlight: false,
    log() {}, async runSelectedCountdownTask() { entered.resolve(); return release.promise; },
  });
  const pending = c.startSelectedCountdownTask({ taskKey: "old-task" });
  await entered.promise;
  restart(c, []);
  const newerOwner = {};
  c.selectedStartInFlight = newerOwner;
  release.resolve({ ok: false, cancelled: true });
  await pending;
  assert.equal(c.selectedStartInFlight, newerOwner);
});
