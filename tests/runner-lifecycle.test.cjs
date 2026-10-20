"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = process.env.LIGHTHOUSE_TEST_SOURCE_ROOT || path.join(__dirname, "../src");
const read = name => fs.readFileSync(path.join(root, name), "utf8");
const copy = value => JSON.parse(JSON.stringify(value));
const event = { addListener() {} };
const stateKey = "lighthouseAutoRunStateV1";
const selected = { selectionId: "order-A", taskKey: "order-A", taskType: "评论", title: "A", bounty: 0.1, countdownSec: 600 };
const order = { ...selected, tweetUrl: "https://x.com/fixture/status/123" };

// Execute the complete background module, including the actual message gate,
// durable state writes, completion evidence, counting and cancellation code.
// Only Chrome/DOM/network boundaries are fake. No website can be contacted.
async function worker(options = {}) {
  const stored = {}, effects = [], sent = [];
  let claims = 0, completed = false, c;
  const edge = async name => options.edge?.(name);
  const state = () => vm.runInContext("runtimeState", c);
  const evidence = () => ({ runId: state().runId, taskKey: order.taskKey,
    tweetUrl: order.tweetUrl, observedAt: Date.now(), officialCompletion: true });
  const chrome = {
    runtime: { id: "fixture", getURL: p => `chrome-extension://fixture/${p}`,
      getManifest: () => ({ version: "fixture" }), onInstalled: event, onMessage: event,
      async sendMessage() {}, async getPlatformInfo() {} },
    storage: { session: require("./session-fixture.cjs")(), local: { async setAccessLevel() {},
      async get(keys) { return Object.fromEntries(keys.map(k => [k, stored[k]])); },
      async set(values, cb) { await options.beforeSave?.(values); Object.assign(stored, copy(values)); cb?.(); } } },
    alarms: { onAlarm: event, async create() {}, async clear() {} },
    tabs: { onCreated: event, onUpdated: event, onRemoved: event,
      async update(id) { return { id, windowId: 1 }; },
      async get(id) { return { id, windowId: 1, url: id === 11 ? "https://app.lhdao.top/campaigns" : order.tweetUrl }; },
      async query() { return [{ id: 11, windowId: 1, url: "https://app.lhdao.top/campaigns" }]; },
      async sendMessage(id, payload) {
        sent.push(copy(payload));
        effects.push({ type: payload.type, running: state().running, task: payload.task?.taskKey });
        await options.onSend?.(payload, { stored, state, effects });
        await edge(payload.type);
        if (/^CANCEL_|^AUTOMATION_/.test(payload.type)) return { ok: true };
        if (payload.type === "OPEN_SELECTED_COUNTDOWN_TASK_DETAIL") {
          if (options.missing) return { ok: false, claimActionAttempted: false, message: "目标任务已下架" };
          return { ok: true, claimActionAttempted: false, task: copy(order),
            detailConfirmation: { runId: payload.runId, type: payload.type,
              claimIntentId: payload.claimIntentId, taskKey: order.taskKey, phase: "detail_ready", invitationResolved: true } };
        }
        if (payload.type === "WAIT_SELECTED_COUNTDOWN_AND_LOCK") {
          claims++;
          if (options.claimReplyUnknown) return { ok: false, claimActionAttempted: true, task: copy(order), message: "锁位回执延迟" };
          if (claims === 1 && options.first === "refusal") return {
            ok: false, claimActionAttempted: true, task: { ...order, seatLocked: false, claimRejected: true },
            claimRejection: { runId: payload.runId, type: payload.type, claimIntentId: payload.claimIntentId, taskKey: order.taskKey },
            claimRetryScope: "task", retryAfterMs: 5, message: "本批名额暂不可领取" };
          if (claims === 1 && options.first === "deferred") return {
            ok: false, claimActionAttempted: false, deferredRelease: true,
            task: { ...order, deferUntil: Date.now() + 5 }, message: "等待下一批放号" };
          return { ok: true, claimActionAttempted: true,
            task: { ...order, seatLocked: true, seatLockedAt: new Date().toISOString() } };
        }
        if (payload.type === "CHECK_LIGHTHOUSE_ORDER_OUTCOME") return { ok: true, outcome: "locked",
          runId: payload.runId, claimIntentId: payload.claimIntentId, taskKey: order.taskKey, tweetUrl: order.tweetUrl };
        if (payload.type === "CLOSE_LIGHTHOUSE_TASK_DETAIL") return { ok: true, message: "已关闭详情" };
        if (payload.type === "BEGIN_LIGHTHOUSE_COMPLETION_WATCH") return { ok: true };
        if (payload.type === "READ_LIGHTHOUSE_TODAY_INCOME") return { ok: true, income: 0 };
        if (payload.type === "RUN_X_REPLY") {
          if (options.replyDisconnect) throw Error("message channel closed");
          return { ok: true, replyText: "测试回执", tweet: { url: order.tweetUrl } };
        }
        if (payload.type === "COMPLETE_X_TASK_WIDGET") { completed = true; return { ok: true, submitted: true }; }
        if (/^CHECK_.*COMPLETION$/.test(payload.type)) return { ok: true, completed,
          evidence: completed ? { ...evidence(), ...(id === 12 ? { source: "lighthouse_x_widget" } : {}) } : null };
        throw Error(`Unexpected boundary: ${payload.type}`);
      } },
    windows: { async update() {}, async get() { return { id: 1 }; } }
  };
  c = vm.createContext({ chrome, console, URL, AbortController, importScripts() {}, clearTimeout,
    setTimeout(fn, ms) { const t = setTimeout(fn, ms); t.unref(); return t; },
    fetch() { throw Error("Network forbidden"); } });
  for (const name of ["reply-engine.js", "background.js"]) vm.runInContext(read(name), c);
  await vm.runInContext("runtimeStateReady", c);
  Object.assign(c, {
    publishLighthouseMonitorSnapshot() {}, ensureLighthouseAlertBridge: async () => {},
    ensureContentScriptInjected: async () => true,
    getSettings: async () => ({ aiApiKey: "fixture-key", replyMode: "post", autoSubmitLighthouse: true, maxTasksPerRun: options.maxTasksPerRun ?? 9999,
      maxTaskAttempts: 3, actionDelayMs: 0, lockSeatTimeoutMs: 1000 }),
    resolveLighthouseTab: async () => 11, getOrCreateLighthouseTab: async () => ({ id: 11, windowId: 1 }),
    waitForTabComplete: async () => true, waitForXReadyBeforeReply: async () => { await edge("ready"); return true; },
    // This old snapshot wait is deliberately observed: the live detail owns
    // availability, so orchestration must not sleep from a selected UI copy.
    waitForSelectedCountdownWindow: async () => { effects.push({ type: "stale-selection-wait" }); return selected; },
    waitForLighthouseOpenedTweet: async () => { state().xTabId = 12; await edge("adopt"); return true; },
    delay: async () => {},
    reloadLighthouseCampaignsAfterOrder: async () => { effects.push({ type: "reload", running: state().running }); return true; },
    recordReplyHistory: async () => { effects.push({ type: "record-reply" }); await edge("history"); }
  });
  return { c, sent, stored, effects, state, claims: () => claims };
}

for (const first of ["refusal", "deferred"]) test(`selected run: ${first} rechecks the same task and completes exactly once`, async () => {
  const w = await worker({ first });
  const result = await w.c.runSelectedCountdownTask(selected, 1);
  assert.equal(result.ok, true, result.error);
  assert.equal(w.claims(), 2);
  assert.equal(w.state().completed, 1);
  assert.equal(w.state().stage, "selected_flow_done");
  assert.equal(w.state().running, false);
  assert.equal(w.effects.filter(e => e.type === "RUN_X_REPLY").length, 1);
  assert.equal(w.effects.filter(e => e.type === "COMPLETE_X_TASK_WIDGET").length, 1);
  assert.ok(w.effects.some(e => e.type === "CLOSE_LIGHTHOUSE_TASK_DETAIL" && e.running));
  assert.ok(!w.effects.some(e => e.type === "stale-selection-wait"));
  assert.equal(w.stored[stateKey].running, false);
});

test("a removed selected task is cleaned up before entering the terminal state", async () => {
  const w = await worker({ missing: true });
  const result = await w.c.runSelectedCountdownTask(selected, 1);
  assert.equal(result.ok, false);
  assert.ok(w.effects.some(e => e.type === "CLOSE_LIGHTHOUSE_TASK_DETAIL" && e.running));
  assert.equal(w.state().stage, "selected_task_open_failed");
  assert.equal(w.state().running, false);
});

test("an outbound reply intent is durable before dispatch and survives a lost reply", async () => {
  let savedBeforeDispatch = false;
  const w = await worker({ replyDisconnect: true, onSend(payload, { stored }) {
    if (payload.type === "RUN_X_REPLY") savedBeforeDispatch = stored[stateKey]?.uncertainAction?.type === "RUN_X_REPLY";
  } });
  await w.c.runSelectedCountdownTask(selected, 1);
  assert.equal(savedBeforeDispatch, true);
  assert.equal(w.state().uncertainAction?.type, "RUN_X_REPLY");
  assert.equal(w.state().running, false);
  assert.equal(w.claims(), 1);
  assert.equal(w.sent.filter(m => m.type === "RUN_X_REPLY").length, 1);
  assert.equal(w.sent.filter(m => m.type === "COMPLETE_X_TASK_WIDGET").length, 0);
});

function panelSelection() {
  const source = read("debug/debug.js");
  const c = vm.createContext({ Date });
  for (const name of ["resolveSelectedCountdownTask", "deriveLocalCountdownTask", "buildCountdownSelectionKey", "normalizeTweetUrl", "formatCountdown"]) {
    const start = source.search(new RegExp(`^function ${name}\\(`, "m"));
    const body = source.slice(start), next = body.search(/\n(?:async )?function /);
    vm.runInContext(next < 0 ? body : body.slice(0, next), c);
  }
  Object.assign(c, { selectedCountdownKey: "order-A", selectedCountdownTask: { ...selected, isCooling: false },
    renderedCountdownTasks: [], countdownTasks: [] });
  return c;
}
test("selection is an identity: a refreshed platform countdown replaces its old UI copy", () => {
  const c = panelSelection();
  c.countdownTasks = [{ ...selected, isCooling: true, expiresAt: Date.now() + 120000 }];
  const task = c.resolveSelectedCountdownTask();
  assert.equal(task.isCooling, true);
  assert.ok(task.countdownSec > 110);
});
test("selection no longer starts a task that vanished from the live list", () => {
  assert.equal(panelSelection().resolveSelectedCountdownTask(), null);
});

for (const boundary of ["OPEN_SELECTED_COUNTDOWN_TASK_DETAIL", "WAIT_SELECTED_COUNTDOWN_AND_LOCK",
  "adopt", "ready", "RUN_X_REPLY", "history", "COMPLETE_X_TASK_WIDGET", "CLOSE_LIGHTHOUSE_TASK_DETAIL"]) {
  test(`full selected flow: STOP and restart during ${boundary} prevents old follow-up work`, async () => {
    let entered, release;
    const held = new Promise(resolve => { release = resolve; });
    const reached = new Promise(resolve => { entered = resolve; });
    let intercepted = false;
    const w = await worker({ async edge(name) {
      if (name === boundary && !intercepted) { intercepted = true; entered(); await held; }
    } });
    const pending = w.c.runSelectedCountdownTask(selected, 1);
    await reached;
    vm.runInContext('runtimeState = { ...createInitialState(), runId: "new-run", running: true, mode: "debug", stage: "new-stage" }', w.c);
    const before = copy(w.state()), sent = copy(w.sent);
    release();
    const result = await pending;
    assert.equal(result.cancelled, true);
    assert.deepEqual(copy(w.state()), before);
    assert.deepEqual(copy(w.sent), sent);
  });
}

test("selected start after explicit STOP unpauses content before opening a detail", async () => {
  const w = await worker();
  Object.assign(w.state(), { manuallyStopped: true, stage: "stopped" });
  const result = await w.c.handleMessage({ type: "RUN_SELECTED_COUNTDOWN_TASK", selectedTask: selected, clientWindowId: 1 },
    { id: "fixture", url: "chrome-extension://fixture/src/debug/debug.html" });
  assert.equal(result.ok, true);
  const resumed = w.sent.findIndex(m => m.type === "AUTOMATION_PAUSE_CHANGED" && m.paused === false);
  const opened = w.sent.findIndex(m => m.type === "OPEN_SELECTED_COUNTDOWN_TASK_DETAIL");
  assert.ok(resumed >= 0 && opened > resumed);
  assert.equal(w.state().completed, 1);
  assert.equal(w.state().running, false);
});


test("a late exact-order lock receipt resumes the original selected orchestration without polling", async () => {
  const w = await worker({ claimReplyUnknown: true });
  const result = await w.c.runSelectedCountdownTask(selected, 1);
  assert.equal(result.ok, true, result.error);
  assert.equal(w.state().completed, 1);
  assert.equal(w.state().stage, "selected_flow_done");
  assert.equal(w.claims(), 1);
  assert.equal(w.sent.filter(m => m.type === "CHECK_LIGHTHOUSE_ORDER_OUTCOME").length, 1);
  assert.equal(w.sent.filter(m => m.type === "RUN_X_REPLY").length, 1);
  assert.equal(w.sent.filter(m => m.type === "COMPLETE_X_TASK_WIDGET").length, 1);
});

test("explicit start continues a reconciled locked order through the full auto pipeline without re-claiming", async () => {
  const w = await worker({ maxTasksPerRun: 1 });
  Object.assign(w.state(), { running: false, mode: "idle", resumeMode: "auto", stage: "stopped", lighthouseTabId: 11,
    lighthouseWindowId: 1, runtimeWindowId: 1, currentTask: { ...order, claimReconciled: true, seatLocked: true } });
  const result = await w.c.startAutoRun({}, 1, true);
  assert.equal(result.ok, true, result.error);
  assert.equal(w.state().completed, 1);
  assert.equal(w.state().stage, "finished");
  assert.equal(w.state().running, false);
  assert.equal(w.claims(), 0);
  assert.equal(w.sent.filter(m => m.type === "RUN_X_REPLY").length, 1);
  assert.equal(w.sent.filter(m => m.type === "COMPLETE_X_TASK_WIDGET").length, 1);
});

for (const mode of ["manual stop", "new run"]) test(`reconciled continuation cannot outlive ${mode} during its fresh receipt read`, async () => {
  let w;
  w = await worker({ async edge(name) {
    if (name === "CHECK_LIGHTHOUSE_ORDER_OUTCOME") {
      if (mode === "manual stop") w.state().manuallyStopped = true;
      else vm.runInContext('runtimeState = {...createInitialState(),runId:"new-run",stage:"stopped"}', w.c);
    }
  } });
  Object.assign(w.state(), { running: false, stage: "claim_locked_reconciled", lighthouseTabId: 11,
    lighthouseWindowId: 1, runtimeWindowId: 1, currentTask: { ...order, claimReconciled: true, seatLocked: true } });
  const result = await w.c.startAutoRun({}, 1, true);
  assert.equal(result.cancelled, true);
  assert.equal(w.sent.filter(m => m.type === "RUN_X_REPLY").length, 0);
  if (mode === "manual stop") assert.equal(w.state().manuallyStopped, true);
  else assert.equal(w.state().runId, "new-run");
});

for (const outcome of ["unknown", "completed", "wrong target"]) test(`reconciled continuation does not reply after fresh receipt is ${outcome}`, async () => {
  const w = await worker();
  Object.assign(w.state(), { running: false, stage: "claim_locked_reconciled", lighthouseTabId: 11,
    lighthouseWindowId: 1, runtimeWindowId: 1, currentTask: { ...order, claimReconciled: true, seatLocked: true } });
  const original = w.c.chrome.tabs.sendMessage;
  w.c.chrome.tabs.sendMessage = async (id, msg) => {
    const result = await original(id, msg);
    if (msg.type === "CHECK_LIGHTHOUSE_ORDER_OUTCOME") return { ...result,
      outcome: outcome === "wrong target" ? "locked" : outcome,
      tweetUrl: outcome === "wrong target" ? "https://x.com/other/status/456" : result.tweetUrl };
    return result;
  };
  const result = await w.c.startAutoRun({}, 1, true);
  assert.equal(result.ok, false);
  assert.equal(w.state().running, false);
  assert.equal(w.sent.filter(m => m.type === "RUN_X_REPLY").length, 0);
});

test("simultaneous reconciled starts can dispatch at most one reply", async () => {
  const w = await worker({ maxTasksPerRun: 1 });
  Object.assign(w.state(), { running: false, stage: "claim_locked_reconciled", lighthouseTabId: 11,
    lighthouseWindowId: 1, runtimeWindowId: 1, currentTask: { ...order, claimReconciled: true, seatLocked: true } });
  await Promise.all([w.c.startAutoRun({}, 1, true), w.c.startAutoRun({}, 1, true)]);
  assert.equal(w.sent.filter(m => m.type === "RUN_X_REPLY").length, 1);
  assert.equal(w.state().completed, 1);
});
