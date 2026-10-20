"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const version = JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8")).version;

// Keep the real listener, invitation selector/click, task builder and page
// confirmation loop. Only DOM/navigation adapters and the clock are fixtures.
function page(outcome) {
  let listener, now = 100000;
  const fixture = { clicks: 0, phase: "campaigns", present: outcome !== "none" };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const root = { innerText: "评论任务 目标推文" };
  const invitation = { innerText: "邀请接单 接受邀请", parentElement: root };
  const button = {
    innerText: "接受邀请", disabled: false, visible: true, isConnected: true, parentElement: invitation,
    classList: { contains: () => false }, getAttribute: () => "",
    click() {
      fixture.clicks += 1;
      if (outcome === "disappears") fixture.present = false;
      if (outcome === "disabled") button.disabled = true;
    }
  };
  const c = vm.createContext({ console, URL, Date: Clock, setTimeout, clearTimeout, fixture,
    fixtureRoot: root, fixtureButton: button,
    fixtureSelection: { taskKey: "invited-order", taskType: "评论", text: "评论任务 0.2 LUX", bounty: 0.2, target: {} },
    fixtureWait: async (ms) => { now += ms; },
    fetch: async () => { throw new Error("Network forbidden"); },
    location: { href: "https://app.lhdao.top/campaigns", pathname: "/campaigns" },
    window: { addEventListener() {} },
    document: { body: root, querySelectorAll: () => fixture.present ? [button] : [] },
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } }, sendMessage: async () => ({ ok: true }) } }
  });
  const adapters = `
    ensureCampaignsPage = async () => {};
    ensureAllTaskFilter = async () => {};
    selectNextCommentTask = async () => fixtureSelection;
    findSelectedCountdownCandidate = async () => fixtureSelection;
    openTaskDetailOrFail = async () => { fixture.phase = "detail_ready"; };
    getLighthousePageSnapshot = () => ({phase: fixture.phase});
    findTaskDetailRoot = () => fixtureRoot;
    isTaskDetailOpen = () => fixture.phase === "detail_ready";
    isVisible = (node) => node.visible !== false;
    extractTitle = () => "Comment";
    extractTweetUrl = () => "https://x.com/fixture/status/123";
    detectCandidateTaskType = () => "评论";
    waitForSelectedTaskTweetTarget = async (settings) => buildTask(settings);
    report = () => {};
    hasDetailRequestTimeout = () => false;
    wait = fixtureWait;
  `;
  const source = fs.readFileSync(path.join(__dirname, "../src/content/lighthouse.js"), "utf8");
  const end = source.lastIndexOf("})();");
  vm.runInContext(source.slice(0, end) + adapters + source.slice(end), c);
  return { fixture, dispatch: (type) => new Promise((resolve) => {
    assert.equal(listener({ type, runId: "invite-run", claimIntentId: "intent-1", selectedTask: { taskKey: "invited-order" },
      settings: { actionDelayMs: 100, cooldownPollMs: 250 } }, {}, resolve), true);
  }) };
}

for (const type of ["DEBUG_OPEN_FIRST_COMMENT_TASK", "OPEN_SELECTED_COUNTDOWN_TASK_DETAIL", "OPEN_SELECTED_COUNTDOWN_TASK_TWEET"]) {
  for (const outcome of ["none", "disappears"]) {
    test(`${type}: ${outcome} confirms only this detail transition without inventing a claim`, async () => {
      const p = page(outcome), result = await p.dispatch(type);
      assert.equal(result.ok, true);
      assert.equal(p.fixture.clicks, outcome === "none" ? 0 : 1);
      assert.equal(result.claimActionAttempted, outcome === "disappears");
      assert.deepEqual(JSON.parse(JSON.stringify(result.detailConfirmation)), {
        runId: "invite-run", type, claimIntentId: "intent-1", taskKey: "invited-order",
        phase: "detail_ready", invitationResolved: true
      });
      assert.equal(result.claimed, undefined);
      assert.equal(result.task.claimed, undefined);
      assert.equal(result.task.seatLocked, undefined);
      assert.equal(result.detailConfirmed, undefined, "the listener must replace internal confirmation with its own bound receipt");
    });
  }
  for (const outcome of ["visible", "disabled"]) {
    test(`${type}: an invitation that stays ${outcome} cannot produce confirmation`, async () => {
      const p = page(outcome), result = await p.dispatch(type);
      assert.equal(p.fixture.clicks, 1);
      assert.equal(result.ok, false);
      assert.equal(result.claimActionAttempted, true);
      assert.equal(result.detailConfirmation, undefined);
      assert.match(result.message, /邀请接单仍待确认/);
    });
  }
}

async function receiptWorker(responseFactory) {
  const event = { addListener() {} };
  const stored = {}, sent = [];
  const copy = (value) => JSON.parse(JSON.stringify(value));
  let c, intent;
  const chrome = {
    runtime: { id: "test", getURL: (p) => `chrome-extension://test/${p}`,
      getManifest: () => ({ version }), onInstalled: event, onMessage: event },
    storage: { session: require("./session-fixture.cjs")(), local: { setAccessLevel: async () => {},
      get: async (keys) => Object.fromEntries(keys.map((key) => [key, stored[key]])),
      set: async (values, callback) => { Object.assign(stored, copy(values)); callback?.(); }
    } },
    alarms: { onAlarm: event, create: async () => {}, clear: async () => {} },
    tabs: { onCreated: event, onUpdated: event, onRemoved: event,
      sendMessage: async (_id, message) => {
        if (message.type === "CHECK_LIGHTHOUSE_RUNNER_READY") {
          return { ok: true, version, instanceId: "fixture-page", url: "https://app.lhdao.top/campaigns", paused: false };
        }
        sent.push(copy(message));
        intent = vm.runInContext("runtimeState.uncertainAction", c);
        return responseFactory(message);
      }
    }
  };
  c = vm.createContext({ chrome, console, URL, AbortController, importScripts() {}, clearTimeout,
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; },
    fetch: async () => { throw new Error("Network forbidden"); }
  });
  for (const file of ["reply-engine.js", "background.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../src", file), "utf8"), c, { filename: file });
  }
  await vm.runInContext("runtimeStateReady", c);
  Object.assign(c, { ensureLighthouseAlertBridge: async () => {}, publishLighthouseMonitorSnapshot() {} });
  vm.runInContext(`Object.assign(runtimeState, { running: true, mode: "debug", runId: "proof-run",
    lighthouseTabId: 11, lighthouseWindowId: 1, runtimeWindowId: 1,
    currentTask: { taskKey: "proof-order", taskType: "评论" } })`, c);
  return { stored, sent, intent: () => intent, state: () => vm.runInContext("runtimeState", c),
    run: (type) => c.sendToTab(11, { type, runId: "proof-run" }) };
}

function confirmedDetailReceipt(message) {
  return {
    ok: true, claimActionAttempted: true, task: { taskKey: "proof-order", taskType: "评论" },
    detailConfirmation: { runId: message.runId, type: message.type, claimIntentId: message.claimIntentId,
      taskKey: "proof-order", phase: "detail_ready", invitationResolved: true }
  };
}

for (const type of ["DEBUG_OPEN_FIRST_COMMENT_TASK", "OPEN_SELECTED_COUNTDOWN_TASK_DETAIL", "OPEN_SELECTED_COUNTDOWN_TASK_TWEET"]) {
  test(`${type}: background accepts its matching detail proof without inventing a locked seat`, async () => {
    const w = await receiptWorker(confirmedDetailReceipt);
    const result = await w.run(type);
    assert.equal(result.ok, true);
    assert.equal(w.state().running, true);
    assert.ok(w.intent(), "the real sender must persist an intent before dispatch");
    assert.equal(w.state().uncertainAction, undefined);
    assert.equal(w.stored.lighthouseAutoRunStateV1.uncertainAction, undefined);
    assert.equal(w.state().currentTask.claimed, undefined);
    assert.equal(w.state().currentTask.seatLocked, undefined);
    assert.equal(w.sent.length, 1);
  });
}

const rejectedProofs = [
  { name: "wrong run", edit: (reply) => { reply.detailConfirmation.runId = "other-run"; } },
  { name: "wrong type", edit: (reply) => { reply.detailConfirmation.type = "OPEN_SELECTED_COUNTDOWN_TASK_DETAIL"; } },
  { name: "wrong nonce", edit: (reply) => { reply.detailConfirmation.claimIntentId = "other-intent"; } },
  { name: "wrong task", edit: (reply) => { reply.detailConfirmation.taskKey = "other-order"; } },
  { name: "wrong phase", edit: (reply) => { reply.detailConfirmation.phase = "invitation_pending"; } },
  { name: "unresolved invitation", edit: (reply) => { reply.detailConfirmation.invitationResolved = false; } },
  { name: "wrong operation", type: "DEBUG_LOCK_SEAT_AND_EXTRACT", edit() {} },
  { name: "failed receipt", edit: (reply) => { reply.ok = false; } }
];
for (const { name, type = "DEBUG_OPEN_FIRST_COMMENT_TASK", edit } of rejectedProofs) {
  test(`background retains the intent for a detail proof with ${name}`, async () => {
    const w = await receiptWorker((message) => {
      const reply = confirmedDetailReceipt(message);
      edit(reply);
      return reply;
    });
    const result = await w.run(type);
    assert.equal(result.ok, false);
    assert.equal(result.uncertain, true);
    assert.equal(w.state().running, false);
    assert.equal(w.state().stage, "action_result_unknown");
    assert.equal(w.state().uncertainAction, w.intent(), "invalid proof cannot release the pending operation");
    assert.deepEqual(JSON.parse(JSON.stringify(w.stored.lighthouseAutoRunStateV1.uncertainAction)),
      JSON.parse(JSON.stringify(w.intent())));
    assert.equal(w.sent.length, 1);
  });
}
