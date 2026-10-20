"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const sourceRoot = process.env.LIGHTHOUSE_TEST_SOURCE_ROOT || path.join(__dirname, "../src");
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const event = { addListener() {} };
const tab = { id: 11, windowId: 1, url: "https://app.lhdao.top/campaigns", status: "complete" };
const stateKey = "lighthouseAutoRunStateV1";
const invitation = { source: "lighthouse_invitation", taskKey: "invitation:https://x.com/i/status/123", tweetUrl: "https://x.com/fixture/status/123", taskType: "评论", bounty: 0.2 };

async function worker(t, saved = {}) {
  let now = 1000000;
  class Clock extends Date { static now() { return now; } }
  const stored = { lighthouseAiApiKey: "fixture-key", ...clone(saved) }, effects = [], hooks = {}, timers = new Set();
  const chrome = {
    runtime: { id: "test", getURL: p => `chrome-extension://test/${p}`, getManifest: () => ({ version: "test" }), onInstalled: event, onMessage: event },
    storage: { local: { async setAccessLevel() {},
      async get(keys) { if (hooks.get) await hooks.get(keys); return Object.fromEntries(keys.filter(key => Object.hasOwn(stored, key)).map(key => [key, clone(stored[key])])); },
      async set(values, callback) { if (hooks.set) await hooks.set(values); Object.assign(stored, clone(values)); callback?.(); }, async remove() {} } },
    alarms: { onAlarm: event, async create() {}, async clear() {} },
    tabs: { onCreated: event, onUpdated: event, onRemoved: event,
      async get() { return { ...tab }; }, async query() { return [{ ...tab }]; },
      async update(id, values) { effects.push({ type: "update", id, values }); return { ...tab }; },
      async reload(id) { effects.push({ type: "reload", id }); },
      async sendMessage(id, message) {
        effects.push({ type: "message", id, message: clone(message) });
        if (message.type === "CHECK_LIGHTHOUSE_RUNNER_READY") return hooks.ready ? hooks.ready(message)
          : { ok: true, version: "test", instanceId: "fixture-page", url: tab.url, paused: false };
        if (message.type === "CHECK_LIGHTHOUSE_INVITATION") return hooks.probe ? hooks.probe(message) : { ok: true, invitationPending: false };
        if (message.type === "CLOSE_LIGHTHOUSE_TASK_DETAIL") return hooks.close ? hooks.close(message) : { ok: true };
        if (message.type === "START_LIGHTHOUSE_COMMENT_TASK") return hooks.claim(message);
        return { ok: true };
      }
    }
  };
  const c = vm.createContext({ chrome, console, URL, Date: Clock, AbortController, importScripts() {},
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timer.unref(); timers.add(timer); return timer; },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); }, fetch: async () => { throw Error("Network forbidden in invitation tests"); } });
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  for (const file of ["reply-engine.js", "background.js"]) vm.runInContext(fs.readFileSync(path.join(sourceRoot, file), "utf8"), c, { filename: file });
  await vm.runInContext("runtimeStateReady", c);
  Object.assign(c, { publishLighthouseMonitorSnapshot() {}, ensureLighthouseAlertBridge: async () => {},
    waitForTabComplete: async () => true, delay: async ms => { now += ms; if (hooks.delay) await hooks.delay(ms); },
    getOrCreateLighthouseTab: async () => ({ ...tab }), rememberLighthouseTabById: async () => {}, focusLighthouseTabForAutoScan: async () => true });
  if (!saved[stateKey]) vm.runInContext(`Object.assign(runtimeState, { running: true, mode: "auto", stage: "campaigns_returned", runId: "invitation-run", lighthouseTabId: 11, lighthouseWindowId: 1, runtimeWindowId: 1 })`, c);
  const state = () => vm.runInContext("runtimeState", c);
  const messages = type => effects.filter(e => e.type === "message" && e.message.type === type);
  return { c, chrome, stored, effects, hooks, state, messages, now: () => now,
    reloads: () => effects.filter(e => e.type === "reload"), refreshAt: () => vm.runInContext("lastCampaignsRefreshAt", c) };
}

const reloadPaths = {
  refresh: w => w.c.refreshLighthouseCampaignsTab(11, "fixture refresh", () => true, true),
  afterRefusal: w => w.c.reloadLighthouseCampaignsAfterOrder(11, "fixture refusal", () => true, true),
  closeFallback: w => { w.hooks.close = async () => ({ ok: false }); return w.c.closeLighthouseTaskDetail(11, {}, "fixture close", () => true, true); }
};
for (const [name, invoke] of Object.entries(reloadPaths)) {
  test(`${name}: no invitation keeps the existing reload path`, async t => {
    const w = await worker(t); const result = await invoke(w);
    assert.ok(result === true || result.ok); assert.equal(w.reloads().length, 1);
    assert.equal(w.messages("CHECK_LIGHTHOUSE_INVITATION").length, 1);
    assert.equal(w.refreshAt() > 0, name !== "closeFallback");
  });
  test(`${name}: visible pending invitation is preserved without claiming or changing cooldown`, async t => {
    const w = await worker(t); w.state().claimRetryNotBefore = w.now() + 45000;
    w.hooks.probe = async () => ({ ok: true, invitationPending: true });
    const result = await invoke(w);
    assert.ok(result === true || result.invitationPending); assert.equal(w.reloads().length, 0);
    assert.equal(w.refreshAt(), 0); assert.equal(w.state().claimRetryNotBefore, w.now() + 45000);
    assert.equal(w.messages("START_LIGHTHOUSE_COMMENT_TASK").length, 0); assert.equal(w.state().currentTask, null);
  });
  for (const failure of ["not-ok", "rejection"]) test(`${name}: ${failure} probe cannot invent an invitation or discard the page`, async t => {
    const w = await worker(t);
    w.hooks.probe = async () => { if (failure === "rejection") throw Error("fixture probe failure"); return { ok: false }; };
    const result = await invoke(w); assert.ok(result === false || result.ok === false);
    assert.equal(result?.invitationPending, undefined); assert.equal(w.reloads().length, 0);
  });
  for (const change of ["stop", "new-run", "new-order"]) test(`${name}: late invitation read after ${change} cannot reload`, async t => {
    const w = await worker(t), entered = deferred(), release = deferred();
    w.hooks.probe = async () => { entered.resolve(); await release.promise; return { ok: true, invitationPending: false }; };
    const pending = invoke(w); await entered.promise;
    if (change === "stop") Object.assign(w.state(), { running: false, manuallyStopped: true });
    if (change === "new-run") vm.runInContext('runtimeState = { ...createInitialState(), running: true, mode: "auto", runId: "replacement" }', w.c);
    if (change === "new-order") w.state().currentTask = { taskKey: "protected-order", seatLocked: true };
    const before = clone(w.state()); release.resolve(); const result = await pending;
    assert.ok(result === false || result.cancelled); assert.equal(w.reloads().length, 0);
    assert.deepEqual(clone(w.state()), before);
  });
}

test("invitation arriving during account cooldown survives refusal recovery and reaches the existing START path", async t => {
  const w = await worker(t); let pendingInvitation = false, scans = 0; const delays = [];
  w.hooks.probe = async () => ({ ok: true, invitationPending: pendingInvitation });
  w.hooks.close = async () => ({ ok: true, invitationPending: pendingInvitation });
  w.hooks.delay = async ms => { delays.push(ms); if (ms === 45000) pendingInvitation = true; };
  w.hooks.claim = async message => {
    if (++scans > 1) { assert.equal(pendingInvitation, true); w.state().running = false; return { ok: false, cancelled: true }; }
    const task = { taskKey: "rejected-order", seatLocked: false, claimRejected: true };
    return { ok: false, claimActionAttempted: true, task, retryAfterMs: 45000,
      claimRejection: { runId: message.runId, type: message.type, claimIntentId: message.claimIntentId, taskKey: task.taskKey } };
  };
  await w.c.startNextAutoTask("fixture-cooldown");
  assert.equal(scans, 2); assert.ok(delays.includes(45000)); assert.equal(w.reloads().length, 0);
  assert.equal(w.state().claimRetryNotBefore, undefined);
});

for (const pendingInvitation of [false, true]) test(`a missing main content receiver is reinjected before auto START with invitation pending=${pendingInvitation}`, async t => {
  const w = await worker(t); let contentReady = false, injections = 0;
  w.state().stage = "starting";
  w.chrome.scripting = { async executeScript({ files }) {
    assert.deepEqual(Array.from(files), ["src/content/lighthouse.js"]); injections++; contentReady = true;
  } };
  w.hooks.close = async () => undefined;
  w.hooks.ready = async () => contentReady
    ? { ok: true, version: "test", instanceId: "fixture-page", url: tab.url, paused: false } : undefined;
  w.hooks.probe = async () => contentReady ? { ok: true, invitationPending: pendingInvitation } : undefined;
  w.hooks.claim = async () => {
    if (!contentReady) return undefined;
    return { ok: true, claimActionAttempted: true, task: { taskKey: "recovered-claim", seatLocked: true } };
  };
  w.c.adoptTargetOpenedTweet = async () => ({ ok: true });
  const result = await w.c.startNextAutoTask("fixture-main-receiver-missing");
  assert.equal(result.ok, true); assert.equal(injections, 1);
  assert.equal(w.messages("CHECK_LIGHTHOUSE_INVITATION").length, 2);
  assert.equal(w.messages("START_LIGHTHOUSE_COMMENT_TASK").length, 1);
  assert.equal(w.reloads().length, pendingInvitation ? 0 : 1);
  assert.equal(w.state().uncertainAction, undefined);
});

test("an unavailable main content receiver never starts a claim or fabricates an unknown order", async t => {
  const w = await worker(t); let injections = 0;
  w.state().stage = "starting";
  w.chrome.scripting = { async executeScript() { injections++; } };
  w.hooks.close = async () => undefined;
  w.hooks.ready = async () => undefined;
  w.hooks.probe = async () => undefined;
  w.hooks.claim = async () => undefined;
  const result = await w.c.startNextAutoTask("fixture-main-receiver-unavailable");
  assert.equal(result.ok, false); assert.equal(injections, 1);
  assert.equal(w.messages("START_LIGHTHOUSE_COMMENT_TASK").length, 0);
  assert.equal(w.state().uncertainAction, undefined);
  assert.equal(w.state().stage, "campaigns_reload_failed");
  assert.equal(w.reloads().length, 0);
});

for (const refreshRequested of [false, true]) test(`a confirmed no-click transient releases its ordinary candidate before recovery refreshRequested=${refreshRequested}`, async t => {
  const w = await worker(t); let scans = 0;
  w.hooks.claim = async message => {
    if (++scans === 1) {
      const task = { source: "lighthouse_list", taskKey: "ordinary-candidate", tweetUrl: "https://x.com/fixture/status/444", taskType: "评论" };
      await w.c.handleMessage({ type: "DEBUG_TASK_CANDIDATE", runId: message.runId, task }, { tab: { id: 11, windowId: 1 } });
      return { ok: false, transient: true, refreshRequested, claimActionAttempted: false, task, message: "详情加载失败，未尝试领取" };
    }
    assert.equal(w.state().currentTask, null);
    return { ok: true, claimActionAttempted: true, task: { taskKey: "next-order", seatLocked: true } };
  };
  w.c.adoptTargetOpenedTweet = async () => ({ ok: true });
  const result = await w.c.startNextAutoTask("fixture-transient-candidate");
  assert.equal(result.ok, true); assert.equal(scans, 2); assert.equal(w.reloads().length, 1);
  assert.equal(w.state().uncertainAction, undefined);
});

test("auto scanning after returning to campaigns repairs its receiver even when detail close is skipped", async t => {
  const w = await worker(t); let contentReady = false, injections = 0;
  w.chrome.scripting = { async executeScript() { injections++; contentReady = true; } };
  w.hooks.ready = async () => contentReady
    ? { ok: true, version: "test", instanceId: "fixture-page", url: tab.url, paused: false } : undefined;
  w.hooks.claim = async () => {
    assert.equal(contentReady, true);
    return { ok: true, claimActionAttempted: true, task: { taskKey: "ready-claim", seatLocked: true } };
  };
  w.c.adoptTargetOpenedTweet = async () => ({ ok: true });
  assert.equal((await w.c.startNextAutoTask("fixture-campaigns-returned")).ok, true);
  assert.equal(injections, 1); assert.equal(w.messages("CLOSE_LIGHTHOUSE_TASK_DETAIL").length, 0);
  assert.equal(w.messages("START_LIGHTHOUSE_COMMENT_TASK").length, 1);
});

for (const type of ["START_LIGHTHOUSE_COMMENT_TASK", "DEBUG_OPEN_FIRST_COMMENT_TASK", "DEBUG_LOCK_SEAT_AND_EXTRACT"])
test(`${type} requires a real runner acknowledgement before creating a claim intent`, async t => {
  const w = await worker(t); let injections = 0;
  w.chrome.scripting = { async executeScript() { injections++; } };
  w.hooks.ready = async () => undefined;
  const result = await w.c.sendToTab(11, { type, runId: w.state().runId });
  assert.equal(result.ok, false); assert.equal(result.runnerUnavailable, true);
  assert.equal(injections, 1); assert.equal(w.messages(type).length, 0);
  assert.equal(w.state().uncertainAction, undefined);
  assert.equal(w.stored[stateKey]?.uncertainAction, undefined);
});

for (const change of ["stop", "new-run", "new-order", "unknown-action"]) test(`runner reinjection interrupted by ${change} cannot send or persist a stale claim`, async t => {
  const w = await worker(t), entered = deferred(), release = deferred();
  w.chrome.scripting = { async executeScript() { entered.resolve(); await release.promise; } };
  w.hooks.ready = async () => undefined;
  const pending = w.c.sendToTab(11, { type: "START_LIGHTHOUSE_COMMENT_TASK", runId: w.state().runId });
  await entered.promise;
  if (change === "stop") Object.assign(w.state(), { running: false, manuallyStopped: true });
  if (change === "new-run") vm.runInContext('runtimeState = { ...createInitialState(), running: true, mode: "auto", runId: "new-ready-run" }', w.c);
  if (change === "new-order") w.state().currentTask = { taskKey: "protected-order", seatLocked: true };
  if (change === "unknown-action") w.state().uncertainAction = { type: "COMPLETE_LIGHTHOUSE_COMMENT_TASK", taskKey: "pending-order" };
  const before = clone(w.state()); release.resolve();
  assert.equal((await pending).cancelled, true);
  assert.equal(w.messages("START_LIGHTHOUSE_COMMENT_TASK").length, 0);
  assert.deepEqual(clone(w.state()), before); assert.equal(w.stored[stateKey], undefined);
});

test("an already dispatched claim with a lost receipt stays unknown and is never repaired by resending", async t => {
  const w = await worker(t); let injections = 0;
  w.chrome.scripting = { async executeScript() { injections++; } };
  w.c.reconcileStoppedClaim = async () => {};
  w.hooks.claim = async message => {
    const checkpoint = { version: 1, runId: message.runId, operationType: message.type,
      claimIntentId: message.claimIntentId, instanceId: "fixture-page" };
    assert.equal((await record(w, { ...checkpoint, phase: "ready" })).ok, true);
    assert.equal((await record(w, { ...checkpoint, phase: "before_click" })).permitClaimClick, true);
    return undefined;
  };
  const result = await w.c.sendToTab(11, { type: "START_LIGHTHOUSE_COMMENT_TASK", runId: w.state().runId });
  assert.equal(result.uncertain, true); assert.equal(injections, 0);
  assert.equal(w.messages("START_LIGHTHOUSE_COMMENT_TASK").length, 1);
  assert.equal(w.state().uncertainAction.claimActionAttempted, true);
  assert.equal(w.state().stage, "action_result_unknown");
  assert.equal(w.stored[stateKey].uncertainAction.claimActionAttempted, true);
});

test("an existing unknown action blocks readiness repair and any new claim", async t => {
  const w = await worker(t); let injections = 0;
  w.chrome.scripting = { async executeScript() { injections++; } };
  const intent = w.state().uncertainAction = { type: "START_LIGHTHOUSE_COMMENT_TASK", intentId: "protected-intent" };
  const result = await w.c.sendToTab(11, { type: "START_LIGHTHOUSE_COMMENT_TASK", runId: w.state().runId });
  assert.equal(result.uncertain, true); assert.equal(injections, 0);
  assert.equal(w.messages("CHECK_LIGHTHOUSE_RUNNER_READY").length, 0);
  assert.equal(w.messages("START_LIGHTHOUSE_COMMENT_TASK").length, 0);
  assert.equal(w.state().uncertainAction, intent);
});

for (const invalid of ["version", "instanceId", "url"]) test(`runner readiness repairs an invalid ${invalid} acknowledgement before claiming`, async t => {
  const w = await worker(t); let injections = 0;
  const ready = { ok: true, version: "test", instanceId: "fixture-page", url: tab.url, paused: false };
  w.chrome.scripting = { async executeScript() { injections++; } };
  w.hooks.ready = async () => injections ? ready : { ...ready, [invalid]: "" };
  assert.equal((await w.c.ensureLighthouseRunnerReady(11)).ok, true);
  assert.equal(injections, 1); assert.equal(w.messages("CHECK_LIGHTHOUSE_RUNNER_READY").length, 2);
  assert.equal(w.messages("START_LIGHTHOUSE_COMMENT_TASK").length, 0);
});

test("runner readiness respects a paused content script without reinjecting or claiming", async t => {
  const w = await worker(t); let injections = 0;
  w.chrome.scripting = { async executeScript() { injections++; } };
  w.hooks.ready = async () => ({ ok: true, version: "test", instanceId: "fixture-page", url: tab.url, paused: true });
  const result = await w.c.sendToTab(11, { type: "START_LIGHTHOUSE_COMMENT_TASK", runId: w.state().runId });
  assert.equal(result.runnerUnavailable, true); assert.equal(injections, 0);
  assert.equal(w.messages("START_LIGHTHOUSE_COMMENT_TASK").length, 0);
  assert.equal(w.state().uncertainAction, undefined);
});

for (const boundary of ["refresh readiness", "close receipt"]) test(`a protected order appearing during ${boundary} blocks the later reload`, async t => {
  const w = await worker(t);
  if (boundary === "refresh readiness") w.c.waitForTabComplete = async () => { w.state().currentTask = { taskKey: "late-order", seatLocked: true }; return true; };
  else w.hooks.close = async () => { w.state().uncertainAction = { intentId: "late-intent" }; return { ok: false }; };
  const result = boundary === "refresh readiness"
    ? await reloadPaths.refresh(w) : await w.c.closeLighthouseTaskDetail(11, {}, "fixture close", () => true, true);
  assert.ok(result === false || result.cancelled); assert.equal(w.reloads().length, 0);
  assert.equal(w.messages("CHECK_LIGHTHOUSE_INVITATION").length, 0);
});

function seedCheckpoint(w, type = "START_LIGHTHOUSE_COMMENT_TASK") {
  Object.assign(w.state(), { running: true, mode: type.startsWith("DEBUG_") ? "debug" : "auto", currentTask: null });
  w.state().uncertainAction = { type, runId: w.state().runId, tabId: 11, intentId: "claim-intent", taskKey: "",
    checkpointRequired: true, checkpointVersion: 1, contentInstanceId: "fixture-page", claimActionAttempted: false };
  return { version: 1, phase: "before_click", runId: w.state().runId, operationType: type,
    claimIntentId: "claim-intent", instanceId: "fixture-page", invitationTask: clone(invitation) };
}
const record = (w, message) => w.c.recordLighthouseClaimCheckpoint(message, { tab: { id: 11 }, frameId: 0 });

for (const operation of ["START_LIGHTHOUSE_COMMENT_TASK", "DEBUG_OPEN_FIRST_COMMENT_TASK"]) test(`${operation}: invitation identity is durable before permission and restores as protected`, async t => {
  const w = await worker(t), message = seedCheckpoint(w, operation), entered = deferred(), release = deferred();
  w.hooks.set = async values => { if (values[stateKey]?.uncertainAction?.claimActionAttempted) { entered.resolve(); await release.promise; } };
  let settled = false;
  const pending = record(w, message).then(result => { settled = true; return result; });
  await entered.promise; assert.equal(settled, false); assert.equal(w.stored[stateKey], undefined);
  release.resolve(); const result = await pending;
  assert.equal(result.permitClaimClick, true); assert.equal(w.stored[stateKey].currentTask.taskKey, invitation.taskKey);
  assert.equal(w.stored[stateKey].currentTask.tweetUrl, invitation.tweetUrl);
  assert.equal(w.stored[stateKey].uncertainAction.taskKey, invitation.taskKey);
  assert.equal(w.stored[stateKey].uncertainAction.claimActionAttempted, true);
  const restored = await worker(t, w.stored);
  assert.equal(restored.state().running, false); assert.equal(restored.state().currentTask.taskKey, invitation.taskKey);
  assert.equal(restored.state().uncertainAction.taskKey, invitation.taskKey);
  assert.equal(restored.messages("START_LIGHTHOUSE_COMMENT_TASK").length, 0);
});

test("the same invitation may repeat its checkpoint for the lock click, a different invitation cannot overwrite it", async t => {
  const w = await worker(t), message = seedCheckpoint(w);
  assert.equal((await record(w, message)).permitClaimClick, true);
  const intent = w.state().uncertainAction;
  assert.equal((await record(w, message)).permitClaimClick, true);
  assert.equal(w.state().uncertainAction, intent);
  const before = clone(w.state());
  const other = { ...message, invitationTask: { ...invitation, taskKey: "invitation:https://x.com/i/status/456", tweetUrl: "https://x.com/other/status/456" } };
  assert.equal((await record(w, other)).ok, false); assert.deepEqual(clone(w.state()), before);
});

for (const field of ["source", "taskKey", "tweetUrl", "taskType", "claimed"]) test(`invalid invitation ${field} cannot authorize or persist a click`, async t => {
  const w = await worker(t), message = seedCheckpoint(w);
  message.invitationTask[field] = field === "claimed" ? true : field === "taskType" ? "" : "invalid";
  const before = clone(w.state()); assert.equal((await record(w, message)).ok, false);
  assert.deepEqual(clone(w.state()), before); assert.equal(w.stored[stateKey], undefined);
});
for (const operation of ["DEBUG_LOCK_SEAT_AND_EXTRACT", "WAIT_SELECTED_COUNTDOWN_AND_LOCK", "RUN_X_WIDGET_CLAIM"]) test(`${operation} cannot adopt an unrelated invitation payload`, async t => {
  const w = await worker(t), message = seedCheckpoint(w, operation);
  assert.equal((await record(w, message)).ok, false); assert.equal(w.state().uncertainAction.claimActionAttempted, false);
});
for (const protection of ["claimed", "seatLocked", "invitationAccepted", "lastXResult", "completionEvidence", "currentTask", "selectedTask", "intentTask"]) test(`invitation checkpoint preserves existing ${protection}`, async t => {
  const w = await worker(t), message = seedCheckpoint(w);
  if (["claimed", "seatLocked", "invitationAccepted"].includes(protection)) w.state().currentTask = { ...invitation, [protection]: true };
  else if (protection === "intentTask") w.state().uncertainAction.taskKey = "another-order";
  else w.state()[protection] = { taskKey: "another-order", tweetUrl: "https://x.com/other/status/456" };
  const before = clone(w.state()); assert.equal((await record(w, message)).ok, false);
  assert.deepEqual(clone(w.state()), before); assert.equal(w.stored[stateKey], undefined);
});

test("the invitation requirements, not an old like-only draft, control the API Key preflight", async t => {
  const w = await worker(t), message = seedCheckpoint(w); w.stored.lighthouseAiApiKey = "";
  w.state().currentTask = { ...invitation, taskType: "点赞" };
  const result = await record(w, message);
  assert.equal(result.ok, false); assert.match(result.error, /API Key/);
  assert.equal(w.state().uncertainAction.claimActionAttempted, false);
  message.invitationTask.taskType = "点赞";
  assert.equal((await record(w, message)).permitClaimClick, true);
});

test("failed durable invitation write never permits a click", async t => {
  const w = await worker(t), message = seedCheckpoint(w);
  w.hooks.set = async values => { if (values[stateKey]) throw Error("fixture disk failure"); };
  await assert.rejects(record(w, message), /fixture disk failure/);
  assert.equal(w.stored[stateKey], undefined); assert.equal(w.state().uncertainAction.taskKey, invitation.taskKey);
});
for (const boundary of ["settings read", "durable write"]) for (const change of ["stop", "new-run", "new-order"]) test(`invitation checkpoint after ${change} during ${boundary} cannot permit a late click`, async t => {
  const w = await worker(t), message = seedCheckpoint(w), entered = deferred(), release = deferred(); let held = false;
  const pause = async () => { if (!held) { held = true; entered.resolve(); await release.promise; } };
  if (boundary === "settings read") w.hooks.get = pause;
  else w.hooks.set = async values => { if (values[stateKey]) await pause(); };
  const pending = record(w, message); await entered.promise;
  if (change === "stop") Object.assign(w.state(), { running: false, manuallyStopped: true });
  if (change === "new-run") vm.runInContext('runtimeState = { ...createInitialState(), running: true, mode: "auto", runId: "new-run" }', w.c);
  if (change === "new-order") w.state().currentTask = { taskKey: "protected-new-order", seatLocked: true };
  const before = clone(w.state()); release.resolve(); const result = await pending;
  assert.equal(result.ok, false); assert.notEqual(result.permitClaimClick, true); assert.deepEqual(clone(w.state()), before);
});

function prepareWatchdog(w) {
  w.state().lastProgressAt = 0;
  w.state().stage = "selecting_task";
  let restarts = 0;
  w.c.startAutoRun = async () => { restarts++; return { ok: true }; };
  return () => restarts;
}
for (const when of ["before cancellation", "during cancellation"]) test(`idle watchdog preserves an invitation appearing ${when}`, async t => {
  const w = await worker(t), restarts = prepareWatchdog(w); let reads = 0;
  w.hooks.probe = async () => ({ ok: true, invitationPending: when === "before cancellation" || ++reads > 1 });
  await w.c.handleAutoRunKeepaliveTick();
  assert.equal(w.reloads().length, 0); assert.equal(restarts(), 1);
  assert.equal(w.messages("CHECK_LIGHTHOUSE_INVITATION").length, 2);
  assert.equal(w.messages("CANCEL_LIGHTHOUSE_RUN").length, 1);
  assert.equal(w.messages("START_LIGHTHOUSE_COMMENT_TASK").length, 0);
});
test("idle watchdog still reloads and restarts when both invitation checks confirm none", async t => {
  const w = await worker(t), restarts = prepareWatchdog(w);
  await w.c.handleAutoRunKeepaliveTick();
  assert.equal(w.reloads().length, 1); assert.equal(restarts(), 1);
  assert.equal(w.messages("CHECK_LIGHTHOUSE_INVITATION").length, 2);
});
for (const pendingInvitation of [false, true]) test(`idle watchdog recovers the original unclaimed draft with invitation pending=${pendingInvitation}`, async t => {
  const w = await worker(t), restarts = prepareWatchdog(w);
  const draft = { taskKey: "unclaimed-draft", seatLocked: false, claimRejected: true };
  w.state().currentTask = draft;
  w.hooks.probe = async () => {
    assert.equal(w.state().currentTask, draft);
    return { ok: true, invitationPending: pendingInvitation };
  };
  await w.c.handleAutoRunKeepaliveTick();
  assert.equal(w.reloads().length, pendingInvitation ? 0 : 1); assert.equal(restarts(), 1);
  assert.equal(w.messages("CHECK_LIGHTHOUSE_INVITATION").length, 2);
});
for (const readNumber of [1, 2]) for (const change of ["replacement", "seatLocked", "seatLockedAt", "claimed", "invitationAccepted", "uncertainAction"]) test(`idle watchdog protects an unclaimed draft changed to ${change} at invitation check ${readNumber}`, async t => {
  const w = await worker(t), restarts = prepareWatchdog(w); let reads = 0;
  w.state().currentTask = { taskKey: "unclaimed-draft", seatLocked: false, claimRejected: true };
  w.hooks.probe = async () => {
    if (++reads === readNumber) {
      if (change === "replacement") w.state().currentTask = { taskKey: "replacement-draft", seatLocked: false };
      else if (change === "uncertainAction") w.state().uncertainAction = { intentId: "new-claim-intent" };
      else w.state().currentTask[change] = change === "seatLockedAt" ? "2026-10-21T12:00:00.000Z" : true;
    }
    return { ok: true, invitationPending: false };
  };
  await w.c.handleAutoRunKeepaliveTick();
  assert.equal(reads, readNumber); assert.equal(w.reloads().length, 0); assert.equal(restarts(), 0);
  if (change === "replacement") assert.equal(w.state().currentTask.taskKey, "replacement-draft");
  else if (change === "uncertainAction") assert.equal(w.state().uncertainAction.intentId, "new-claim-intent");
  else assert.ok(w.state().currentTask[change]);
});
for (const readNumber of [1, 2]) for (const change of ["stop", "new-run", "new-order", "probe-failure"]) test(`idle watchdog cancels ${change} at invitation check ${readNumber}`, async t => {
  const w = await worker(t), restarts = prepareWatchdog(w), entered = deferred(), release = deferred(); let reads = 0;
  w.hooks.probe = async () => {
    if (++reads === readNumber) { entered.resolve(); await release.promise; if (change === "probe-failure") throw Error("fixture probe failure"); }
    return { ok: true, invitationPending: false };
  };
  const pending = w.c.handleAutoRunKeepaliveTick(); await entered.promise;
  if (change === "stop") Object.assign(w.state(), { running: false, manuallyStopped: true });
  if (change === "new-run") vm.runInContext('runtimeState = { ...createInitialState(), running: true, mode: "auto", runId: "new-watchdog-run" }', w.c);
  if (change === "new-order") w.state().currentTask = { taskKey: "protected-order", seatLocked: true };
  release.resolve(); await pending;
  assert.equal(w.reloads().length, 0); assert.equal(restarts(), 0);
  if (change === "new-order") assert.equal(w.state().currentTask.taskKey, "protected-order");
  if (change === "probe-failure") { assert.equal(w.state().running, false); assert.equal(w.state().stage, "campaigns_reload_failed"); }
});
test("idle watchdog never shortens a platform cooldown to handle an invitation", async t => {
  const w = await worker(t), restarts = prepareWatchdog(w); w.state().claimRetryNotBefore = w.now() + 45000;
  w.hooks.probe = async () => ({ ok: true, invitationPending: true });
  await w.c.handleAutoRunKeepaliveTick();
  assert.equal(w.messages("CHECK_LIGHTHOUSE_INVITATION").length, 0); assert.equal(w.reloads().length, 0); assert.equal(restarts(), 0);
  assert.equal(w.state().claimRetryNotBefore, w.now() + 45000);
});
