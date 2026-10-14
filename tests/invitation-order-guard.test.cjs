"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sourceRoot = process.env.LIGHTHOUSE_TEST_SOURCE_ROOT || path.join(__dirname, "../src");
const clone = (value) => JSON.parse(JSON.stringify(value));
const stateKey = "lighthouseAutoRunStateV1";
const event = { addListener() {} };
const lighthouseTab = { id: 11, windowId: 1, status: "complete", url: "https://app.lhdao.top/campaigns" };
const invitedTask = { taskKey: "invited-order", taskType: "评论", bounty: 0.2,
  tweetUrl: "https://x.com/fixture/status/123" };
const nextTask = { taskKey: "next-order", selectionId: "next-selection", taskType: "评论", bounty: 0.2 };

// The full background, message routing, claim receipt handling, cancellation,
// persistence and order guards run unchanged. The content receipt is a bound
// detail-only success: the invitation was clicked, but no claim is fabricated.
async function worker(saved = null) {
  const stored = saved ? clone(saved) : {}, sent = [];
  let context;
  const state = () => vm.runInContext("runtimeState", context);
  const chrome = {
    runtime: { id: "test", getURL: (p) => `chrome-extension://test/${p}`,
      getManifest: () => ({ version: "test" }), onInstalled: event, onMessage: event },
    storage: { local: {
      setAccessLevel: async () => {},
      async get(keys) { return Object.fromEntries(keys.map((key) => [key, stored[key]])); },
      async set(values, callback) { Object.assign(stored, clone(values)); callback?.(); }
    } },
    alarms: { onAlarm: event, create: async () => {}, clear: async () => {} },
    tabs: { onCreated: event, onUpdated: event, onRemoved: event,
      get: async () => lighthouseTab,
      query: async () => [lighthouseTab],
      update: async () => lighthouseTab,
      async sendMessage(id, payload) {
        sent.push({ id, payload: clone(payload) });
        if (payload.type.startsWith("CANCEL_")) return { ok: true };
        if (payload.type === "DEBUG_OPEN_FIRST_COMMENT_TASK") {
          const opens = sent.filter((entry) => entry.payload.type === payload.type).length;
          const task = clone(opens === 1 ? invitedTask : nextTask);
          return { ok: true, task, claimActionAttempted: true, detailConfirmation: {
            runId: payload.runId, type: payload.type, claimIntentId: payload.claimIntentId,
            taskKey: task.taskKey, phase: "detail_ready", invitationResolved: true
          } };
        }
        if (payload.type === "DEBUG_LOCK_SEAT_AND_EXTRACT") {
          return { ok: true, claimActionAttempted: true,
            task: { ...clone(invitedTask), claimed: true, seatLocked: true } };
        }
        if (["START_LIGHTHOUSE_COMMENT_TASK", "OPEN_SELECTED_COUNTDOWN_TASK_DETAIL"].includes(payload.type)) {
          // Stop at the first actual dispatch into a different order. This
          // bounds the real automatic loop without replacing its entry guard.
          state().running = false;
          return { ok: false, cancelled: true, claimActionAttempted: false,
            message: "Offline fixture ends after next-order dispatch" };
        }
        throw new Error("Unexpected browser message: " + payload.type);
      }
    }
  };
  context = vm.createContext({ chrome, console, URL, AbortController, importScripts() {}, clearTimeout,
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; },
    fetch: async () => { throw new Error("Network forbidden in invitation order guard tests"); }
  });
  for (const file of ["reply-engine.js", "background.js"]) {
    vm.runInContext(fs.readFileSync(path.join(sourceRoot, file), "utf8"), context, { filename: file });
  }
  await vm.runInContext("runtimeStateReady", context);
  Object.assign(context, {
    publishLighthouseMonitorSnapshot() {}, ensureLighthouseAlertBridge: async () => {},
    waitForTabComplete: async () => true, delay: async () => {},
    closeLighthouseTaskDetail: async () => true,
    waitForLighthouseOpenedTweet: async () => ({ id: 12 })
  });
  if (!saved) vm.runInContext(`Object.assign(runtimeState, {
    running: true, mode: "debug", stage: "campaigns_opened", runId: "invitation-run",
    lighthouseTabId: 11, lighthouseWindowId: 1, runtimeWindowId: 1
  })`, context);
  const message = (type, extra = {}) => context.handleMessage({ type, clientWindowId: 1, ...extra },
    { id: "test", url: "chrome-extension://test/src/debug/debug.html" });
  const actions = (type) => sent.filter((entry) => entry.payload.type === type);
  return { c: context, stored, sent, state, message, actions };
}

// Automatic/uncertain cancellation retains the invitation. User STOP is now
// an explicit reset and is tested separately below.
async function protectedStop(w) {
  await w.c.cancelCurrentRun();
  w.c.setStage("stopped");
  assert.equal(w.state().running, false);
}

async function openedInvitation() {
  const w = await worker();
  const result = await w.message("DEBUG_OPEN_FIRST_TASK");
  assert.equal(result.ok, true, "confirmed invitation detail must complete step 02");
  assert.equal(w.state().stage, "task_detail_opened");
  assert.equal(w.state().currentTask.taskKey, invitedTask.taskKey);
  assert.equal(w.state().currentTask.claimed, undefined);
  assert.equal(w.state().currentTask.seatLocked, undefined);
  assert.ok(!w.state().uncertainAction, "the completed detail operation must allow the next step of this order");
  return w;
}

function assertOriginalOrder(w) {
  assert.equal(w.state().currentTask.taskKey, invitedTask.taskKey);
  assert.equal(w.stored[stateKey].currentTask.taskKey, invitedTask.taskKey);
  assert.equal(w.state().completed, 0);
  assert.equal(w.state().currentTask.claimed, undefined);
  assert.equal(w.state().currentTask.seatLocked, undefined);
}

test("confirmed invitation persists its action identity without inventing claimed or seatLocked", async () => {
  const w = await openedInvitation();
  const request = w.actions("DEBUG_OPEN_FIRST_COMMENT_TASK")[0];
  const guard = w.state().currentTask.invitationAccepted;
  assert.ok(guard, "successful invitation still needs a durable order guard");
  assert.equal(guard.runId, request.payload.runId);
  assert.equal(guard.type, request.payload.type);
  assert.equal(guard.intentId, request.payload.claimIntentId);
  assert.equal(guard.tabId, request.id);
  assert.equal(guard.taskKey, invitedTask.taskKey);
  assert.deepEqual(w.stored[stateKey].currentTask.invitationAccepted, clone(guard));
  assertOriginalOrder(w);
});

for (const type of ["START_RUN", "RUN_SELECTED_COUNTDOWN_TASK"]) {
  test(`protective cancellation after invitation cannot discard the order through ${type}`, async () => {
    const w = await openedInvitation();
    await protectedStop(w);
    const result = await w.message(type, type === "RUN_SELECTED_COUNTDOWN_TASK" ? { selectedTask: nextTask } : {});
    assert.equal(w.actions("START_LIGHTHOUSE_COMMENT_TASK").length, 0, "full start must not dispatch a new scan");
    assert.equal(w.actions("OPEN_SELECTED_COUNTDOWN_TASK_DETAIL").length, 0, "selected start must not open another order");
    assert.equal(result.ok, false);
    assert.equal(w.state().running, false);
    assertOriginalOrder(w);
  });
}

test("repeating step 02 after accepting an invitation cannot open another order", async () => {
  const w = await openedInvitation();
  const result = await w.message("DEBUG_OPEN_FIRST_TASK");
  assert.equal(w.actions("DEBUG_OPEN_FIRST_COMMENT_TASK").length, 1, "a second content open must not be sent");
  assert.equal(result.ok, false);
  assertOriginalOrder(w);
});

test("step 03 may lock the same invited order after step 02 succeeds", async () => {
  const w = await openedInvitation();
  const opening = w.actions("DEBUG_OPEN_FIRST_COMMENT_TASK")[0].payload;
  const result = await w.message("DEBUG_LOCK_SEAT_OPEN_TWEET");
  assert.equal(result.ok, true);
  const locks = w.actions("DEBUG_LOCK_SEAT_AND_EXTRACT");
  assert.equal(locks.length, 1);
  assert.equal(locks[0].payload.runId, opening.runId);
  assert.equal(locks[0].payload.task.taskKey, invitedTask.taskKey);
  assert.equal(w.state().currentTask.taskKey, invitedTask.taskKey);
  assert.equal(w.state().currentTask.claimed, true);
  assert.equal(w.state().stage, "tweet_opened");
  assert.equal(w.actions("DEBUG_OPEN_FIRST_COMMENT_TASK").length, 1);
});

for (const type of ["START_RUN", "RUN_SELECTED_COUNTDOWN_TASK"]) {
  test(`official completion of this invited order allows ${type} after protective cancellation`, async () => {
    const w = await openedInvitation();
    const runId = w.state().runId;
    assert.equal(w.c.latchLighthouseCompletion({ runId, taskKey: invitedTask.taskKey,
      tweetUrl: invitedTask.tweetUrl, officialCompletion: true }, runId), true);
    await protectedStop(w);
    await w.message(type, type === "RUN_SELECTED_COUNTDOWN_TASK" ? { selectedTask: nextTask } : {});
    const dispatchedType = type === "START_RUN" ? "START_LIGHTHOUSE_COMMENT_TASK" : "OPEN_SELECTED_COUNTDOWN_TASK_DETAIL";
    assert.equal(w.actions(dispatchedType).length, 1, "matching official completion releases the next-order guard");
    assert.notEqual(w.actions(dispatchedType)[0].payload.runId, runId);
  });
}

test("completion evidence for a different task cannot release the invitation order", async () => {
  const w = await openedInvitation();
  const runId = w.state().runId;
  assert.equal(w.c.latchLighthouseCompletion({ runId, taskKey: nextTask.taskKey, officialCompletion: true }, runId), false);
  await protectedStop(w);
  const result = await w.message("START_RUN");
  assert.equal(w.actions("START_LIGHTHOUSE_COMMENT_TASK").length, 0);
  assert.equal(result.ok, false);
  assertOriginalOrder(w);
});

test("a restored protective stop still blocks a new order after an accepted invitation", async () => {
  const original = await openedInvitation();
  await protectedStop(original);
  const restored = await worker(original.stored);
  const result = await restored.message("START_RUN");
  assert.equal(restored.actions("START_LIGHTHOUSE_COMMENT_TASK").length, 0);
  assert.equal(result.ok, false);
  assertOriginalOrder(restored);
});

for (const type of ["START_RUN", "DEBUG_OPEN_FIRST_TASK"]) {
  test(`explicit STOP clears the invited order and permits a fresh ${type}`, async () => {
    const w = await openedInvitation();
    const oldRunId = w.state().runId;
    assert.equal((await w.message("STOP_RUN")).ok, true);
    assert.equal(w.state().currentTask, null);
    assert.equal(w.stored[stateKey].currentTask, null);
    assert.equal(w.state().manuallyStopped, true);
    assert.equal(w.state().completed, 0, "reset must not manufacture completion");
    await w.message(type);
    const dispatchedType = type === "START_RUN" ? "START_LIGHTHOUSE_COMMENT_TASK" : "DEBUG_OPEN_FIRST_COMMENT_TASK";
    const dispatched = w.actions(dispatchedType);
    assert.equal(dispatched.length, type === "START_RUN" ? 1 : 2);
    assert.notEqual(dispatched.at(-1).payload.runId, oldRunId);
  });
}
