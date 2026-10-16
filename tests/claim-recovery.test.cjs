"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const read = (name) => fs.readFileSync(path.join(__dirname, "../src", name), "utf8");
const clone = (value) => JSON.parse(JSON.stringify(value));
const stateKey = "lighthouseAutoRunStateV1";
const runId = "claim-recovery-test";
const task = { taskKey: "list-later-release", selectionId: "selection-later-release", stableTaskKey: "stable-later-release",
  taskType: "评论", bounty: "0.2", title: "Delayed release" };
const detailTask = { taskKey: "detail-text-including-changing-countdown", taskType: "评论", bounty: "0.2",
  title: "Task detail", detailText: "下一批放号 14:12", tweetUrl: "https://x.com/fixture/status/12345" };
const event = { addListener() {} };
const noNetwork = async () => { throw Error("Network forbidden in claim recovery tests"); };

// Executes the production content listener and claim functions. Only DOM,
// page navigation and timing adapters are replaced, inside this VM only.
function content(kind = "deferred", onReport = async () => {}, entryLabel = "领取任务") {
  let listener;
  const replies = [], reports = [];
  const detailRoot = { innerText: kind === "eligibility_refusal" ? "需灯塔严选资格" : (kind === "hard_refusal" || kind.startsWith("entry_") ? "不可领取" : "下一批放号 14:12") };
  const button = { clicked: 0, href: "", innerText: "锁定席位", isConnected: true,
    getAttribute: () => "", scrollIntoView() {}, click() { this.clicked += 1; } };
  const invitation = { clicked: 0, innerText: "接受邀请", click() { this.clicked += 1; } };
  const entry = { clicked: 0, innerText: entryLabel, getAttribute: () => "", scrollIntoView() {}, click() { this.clicked += 1; } };
  const c = vm.createContext({ console, URL, AbortController, clearTimeout, setTimeout, fetch: noNetwork,
    fixtureTask: task, fixtureDetailTask: {...detailTask, detailText: detailRoot.innerText}, fixtureKind: kind, fixtureDetailRoot: detailRoot, fixtureButton: button, fixtureInvitation: invitation, fixtureEntry: entry,
    document: { body: detailRoot, querySelectorAll: () => [] }, window: { addEventListener() {} },
    location: { href: "https://app.lhdao.top/campaigns", pathname: "/campaigns" },
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } },
      async sendMessage(message) {
        reports.push(clone(message));
        const result = await onReport(message);
        // Isolated content fixtures use an acknowledged background checkpoint;
        // connected fixtures execute the real background handler above.
        if (!result && message.type === "LIGHTHOUSE_CLAIM_CHECKPOINT") return {
          ok: true, checkpointRegistered: true, permitClaimClick: message.phase === "before_click",
          claimIntentId: message.claimIntentId, instanceId: message.instanceId
        };
        return result;
      }
    } }
  });
  const adapters = `
    debugOpenFirstCommentTask = async (settings) => {
      if (fixtureKind === "invitation_deferred") await acceptInvitationIfPresent(settings);
      if (fixtureKind.startsWith("entry_")) await tryOpenTaskDetailTarget(fixtureEntry, settings);
      await chrome.runtime.sendMessage({type: "DEBUG_TASK_CANDIDATE", runId: activeRunId, task: fixtureTask});
      return {ok: true, task: fixtureTask};
    };
    confirmPagePhase = async () => { if (fixtureKind === "preclaim_timeout") throw new Error("Request timeout"); };
    buildTask = () => ({...fixtureDetailTask});
    isTaskDetailOpen = () => !fixtureKind.startsWith("entry_") || fixtureEntry.clicked > 0;
    hasTaskUnavailableError = () => false;
    hasEnteredDetailLoadingFlow = () => false;
    isCampaignsListOpen = () => fixtureEntry.clicked === 0;
    findTaskDetailRoot = () => fixtureDetailRoot;
    findInvitationAcceptButton = () => fixtureKind === "invitation_deferred" && !fixtureInvitation.clicked ? fixtureInvitation : null;
    findLockButton = () => fixtureKind === "clicked_timeout" ? fixtureButton : null;
    isVisible = () => true;
    isDisabled = () => false;
    confirmLighthouseGuidanceBeforeClaim = async () => { if (fixtureKind === "clicked_timeout") throw new Error("Request timeout"); };
    getLighthousePageSnapshot = () => ({phase: "detail_ready", path: "/campaigns"});
    wait = async () => {};
  `;
  const source = read("content/lighthouse.js");
  const end = source.lastIndexOf("})();");
  assert.ok(end > 0);
  vm.runInContext(source.slice(0, end) + adapters + source.slice(end), c);
  return {
    button, invitation, entry, replies, reports,
    dispatch(payload) { return new Promise((resolve) => {
      assert.equal(listener(payload, {}, (reply) => { replies.push(clone(reply)); resolve(reply); }), true);
    }); }
  };
}

async function worker(responseFactory) {
  const stored = {}, sent = [], effects = [];
  const chrome = {
    runtime: { id: "test", getURL: (p) => `chrome-extension://test/${p}`,
      getManifest: () => ({ version: "test" }), onInstalled: event, onMessage: event },
    storage: { local: {
      async setAccessLevel() {},
      async get(keys) { return Object.fromEntries(keys.map((key) => [key, stored[key]])); },
      async set(values, callback) { Object.assign(stored, clone(values)); callback?.(); }
    } },
    alarms: { onAlarm: event, async create() {}, async clear() {} },
    tabs: { onCreated: event, onUpdated: event, onRemoved: event,
      async sendMessage(id, payload) { sent.push(clone(payload)); return responseFactory(payload); }
    }
  };
  const c = vm.createContext({ chrome, console, URL, AbortController, importScripts() {}, clearTimeout,
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; }, fetch: noNetwork });
  for (const file of ["reply-engine.js", "background.js"]) vm.runInContext(read(file), c);
  await vm.runInContext("runtimeStateReady", c);
  Object.assign(c, {
    ensureLighthouseAlertBridge: async () => {}, publishLighthouseMonitorSnapshot: () => {},
    getOrCreateLighthouseTab: async () => ({ id: 11, windowId: 1 }), rememberLighthouseTabById: async () => {},
    focusLighthouseTabForAutoScan: async () => true, waitForTabComplete: async () => {}, delay: async () => {},
    beginXOpenWatch: () => effects.push("beginXOpenWatch"), clearXOpenWatch: () => effects.push("clearXOpenWatch"),
    closeLighthouseTaskDetail: async () => { effects.push("closeDetail"); return true; },
    reloadLighthouseCampaignsAfterOrder: async () => { effects.push("reloadCampaigns"); return true; }
  });
  vm.runInContext(`Object.assign(runtimeState, {running: true, mode: "auto", stage: "campaigns_returned", runId: "${runId}", lighthouseTabId: 11, runtimeWindowId: 1})`, c);
  return { c, sent, effects, stored, state: () => vm.runInContext("runtimeState", c) };
}

const payload = () => ({ type: "START_LIGHTHOUSE_COMMENT_TASK", runId, settings: { actionDelayMs: 500, lockSeatTimeoutMs: 60000 } });

test("unclaimed release delay keeps its deferUntil and clears the pending claim", async () => {
  const page = content();
  const w = await worker((message) => page.dispatch(message));
  const reply = await w.c.sendToTab(11, payload());
  assert.equal(reply.ok, false);
  assert.equal(reply.deferredRelease, true);
  assert.equal(reply.claimActionAttempted, false);
  assert.equal(reply.transient, false, "deferred task must remain eligible for per-task retry registration");
  assert.ok(reply.task.deferUntil > Date.now() + 790000);
  assert.equal(reply.task.deferUntil, page.replies[0].task.deferUntil);
  assert.equal(reply.task.taskKey, task.taskKey);
  assert.equal(reply.task.selectionId, task.selectionId);
  assert.equal(reply.task.stableTaskKey, task.stableTaskKey);
  assert.equal(reply.task.detailText, detailTask.detailText);
  assert.equal(reply.task.tweetUrl, detailTask.tweetUrl);
  assert.equal(w.state().running, true);
  assert.equal(w.state().uncertainAction, undefined);
  assert.equal(w.stored[stateKey].uncertainAction, undefined);
});

test("duplicates share the complete deferred receipt and execute the claim flow once", async () => {
  const page = content();
  const [one, two] = await Promise.all([page.dispatch(payload()), page.dispatch(payload())]);
  assert.deepEqual(clone(one), clone(two));
  assert.equal(two.deferredRelease, true);
  assert.equal(two.claimActionAttempted, false);
  assert.ok(two.task.deferUntil > Date.now());
  assert.equal(page.reports.filter((message) => message.type === "DEBUG_TASK_CANDIDATE" && message.task.taskKey === task.taskKey).length, 1);
  assert.equal(page.reports.filter((message) => message.type === "DEBUG_TASK_CANDIDATE" && message.task.taskKey === detailTask.taskKey).length, 1);
});

test("auto scan returns an unclaimed delayed task to the live plaza without exclusions", async () => {
  let w;
  const page = content("deferred", (message) => w.c.handleMessage(message, {tab: {id: 11, windowId: 1}}));
  w = await worker((message) => {
    if (w.sent.length === 1) return page.dispatch(message);
    // End the fixture once the real production loop reaches its second scan.
    // The real second request and its exclusion keys have already been saved.
    w.state().running = false;
    return {ok: false, cancelled: true, message: "test ends after confirmed continuation"};
  });
  await w.c.startNextAutoTask("test_release_recovery");
  assert.equal(w.sent.length, 2);
  assert.equal(w.sent[1].type, "START_LIGHTHOUSE_COMMENT_TASK");
  assert.ok(!w.sent[1].attemptedTaskKeys.includes(task.taskKey));
  assert.ok(!w.sent[1].attemptedTaskKeys.includes(task.selectionId));
  assert.ok(!w.sent[1].attemptedTaskKeys.includes(task.stableTaskKey));
  assert.deepEqual(page.reports.filter((message) => message.type === "DEBUG_TASK_CANDIDATE").map((message) => message.task.taskKey),
    [task.taskKey, detailTask.taskKey], "detail notification must overwrite the earlier list candidate in this fixture");
  assert.equal(w.state().currentTask, null);
  const delayed = w.state().attemptedTaskRecords.find((record) => record.key === task.taskKey);
  assert.equal(delayed, undefined);
  assert.equal(w.state().failed, 0, "waiting for release is not a failed order");
  assert.ok(w.effects.indexOf("clearXOpenWatch") < w.effects.indexOf("reloadCampaigns"));
  assert.ok(w.effects.includes("closeDetail"));
  assert.ok(w.effects.includes("reloadCampaigns"));
  assert.ok(w.state().logs.some((entry) => entry.text.includes("retry_after_deferred_release")));
});

test("an invitation click prevents a later release countdown from clearing the claim intent", async () => {
  const page = content("invitation_deferred");
  const w = await worker((message) => page.dispatch(message));
  const reply = await w.c.sendToTab(11, payload());
  assert.equal(page.invitation.clicked, 1);
  assert.equal(page.replies[0].deferredRelease, true);
  assert.equal(page.replies[0].claimActionAttempted, true);
  assert.equal(reply.uncertain, true);
  assert.equal(w.state().running, false);
  assert.equal(w.state().stage, "action_result_unknown");
  assert.equal(w.stored[stateKey].uncertainAction.type, payload().type);
  assert.match(w.state().logs[0].text, /不会自动重试/);
});

test("a transient load error after a lock click remains uncertain", async () => {
  const page = content("clicked_timeout");
  const w = await worker((message) => page.dispatch(message));
  const reply = await w.c.sendToTab(11, payload());
  assert.equal(page.button.clicked, 1);
  assert.equal(page.replies[0].transient, true);
  assert.equal(page.replies[0].claimActionAttempted, true);
  assert.equal(reply.uncertain, true);
  assert.equal(w.state().running, false);
  assert.ok(w.state().uncertainAction);
  assert.equal(w.sent.length, 1);
});

test("a transient load error before any claim action remains safe to retry", async () => {
  const page = content("preclaim_timeout");
  const w = await worker((message) => page.dispatch(message));
  const reply = await w.c.sendToTab(11, payload());
  assert.equal(reply.transient, true);
  assert.equal(reply.claimActionAttempted, false);
  assert.equal(reply.uncertain, undefined);
  assert.equal(w.state().running, true);
  assert.equal(w.state().uncertainAction, undefined);
});

test("lost claim receipts retain intent and are never sent twice", async () => {
  const w = await worker(async () => { throw Error("The message port closed before a response was received."); });
  const reply = await w.c.sendToTab(11, payload());
  assert.equal(reply.uncertain, true);
  assert.equal(w.state().running, false);
  assert.equal(w.state().stage, "action_result_unknown");
  assert.equal(w.sent.length, 1);
  assert.equal(w.stored[stateKey].uncertainAction.type, payload().type);
});

test("a deferred marker alone cannot clear an unproven claim", async () => {
  const w = await worker(() => ({ok: false, deferredRelease: true, task: {...task, deferUntil: Date.now() + 60000}}));
  const reply = await w.c.sendToTab(11, payload());
  assert.equal(reply.uncertain, true);
  assert.equal(w.state().running, false);
  assert.ok(w.state().uncertainAction);
});

test("a delayed unclaimed receipt past its deadline refreshes without local exclusions", async () => {
  let w, deliveredAt;
  const page = content("deferred", (message) => w.c.handleMessage(message, {tab: {id: 11, windowId: 1}}));
  w = await worker(async (message) => {
    if (w.sent.length === 1) {
      const receipt = await page.dispatch(message);
      // Simulate delivery after the deadline without sleeping or changing
      // the production content receipt. Freeze only this background's clock.
      deliveredAt = receipt.task.deferUntil + 1000;
      vm.runInContext(`Date.now = () => ${deliveredAt}`, w.c);
      return receipt;
    }
    w.state().running = false;
    return {ok: false, cancelled: true, message: "test ends after confirmed continuation"};
  });
  await w.c.startNextAutoTask("test_late_release_receipt");
  assert.equal(w.sent.length, 2, "an expired rescan time cannot turn an unclaimed receipt into uncertainty");
  const delayed = w.state().attemptedTaskRecords.find((record) => record.key === task.taskKey);
  assert.equal(delayed, undefined, "unclaimed tasks use the platform countdown");
  assert.equal(w.state().failed, 0);
  assert.ok(w.effects.includes("closeDetail"));
  assert.ok(w.effects.includes("reloadCampaigns"));
  assert.ok(!w.state().logs.some((entry) => entry.text.includes("不会自动重试")));
});

test("a real preclaim refusal keeps the selected list task eligible after refresh without uncertainty", async () => {
  let w;
  const page = content("hard_refusal", (message) => w.c.handleMessage(message, {tab: {id: 11, windowId: 1}}));
  w = await worker((message) => {
    if (w.sent.length === 1) return page.dispatch(message);
    w.state().running = false;
    return {ok: false, cancelled: true, message: "test ends after confirmed continuation"};
  });
  const clearWatch = w.c.clearXOpenWatch;
  w.c.clearXOpenWatch = () => {
    assert.equal(w.state().running, true);
    assert.equal(w.state().uncertainAction, undefined, "confirmed no-click refusal clears the previous claim intent");
    clearWatch();
  };
  await w.c.startNextAutoTask("test_preclaim_refusal");
  assert.equal(page.replies[0].message, "任务不可做：不可领取");
  assert.equal(page.replies[0].claimActionAttempted, false);
  assert.equal(page.replies[0].transient, false);
  assert.equal(page.replies[0].deferredRelease, false);
  assert.equal(w.sent.length, 2, "a refused task must not halt the scan");
  for (const key of [task.taskKey, task.selectionId, task.stableTaskKey]) {
    assert.ok(!w.sent[1].attemptedTaskKeys.includes(key), "an unclaimed refusal must not exclude the original list identity: " + key);
  }
  assert.equal(w.state().failed, 1);
  assert.ok(w.effects.includes("closeDetail"));
  assert.ok(w.effects.includes("reloadCampaigns"));
  assert.notEqual(w.state().stage, "action_result_unknown");
  assert.ok(!w.state().logs.some((entry) => entry.text.includes("不会自动重试")));
});

for (const [label, attempted] of [
  ["接受邀请", true], ["立即接单", true], ["领取任务", true], ["开始任务", true],
  ["查看详情", false], ["任务正文提到开始任务和接受邀请\n预计获得 0.2 LUX\n查看详情", false]
]) {
  test(`list entry ${JSON.stringify(label)} records claim action=${attempted} before a refusal`, async () => {
    const page = content("entry_refusal", async () => {}, label);
    const w = await worker((message) => page.dispatch(message));
    const reply = await w.c.sendToTab(11, payload());
    assert.equal(page.entry.clicked, 1, "production tryOpenTaskDetailTarget must actually dispatch the click");
    assert.equal(page.replies[0].message, "任务不可做：不可领取");
    assert.equal(page.replies[0].claimActionAttempted, attempted);
    if (attempted) {
      assert.equal(reply.uncertain, true);
      assert.equal(w.state().running, false);
      assert.ok(w.state().uncertainAction);
    } else {
      assert.equal(reply.uncertain, undefined);
      assert.equal(w.state().running, true);
      assert.equal(w.state().uncertainAction, undefined);
    }
  });
}

test("a live eligibility refusal exits without a claim and the automatic runner scans the next task", async () => {
  let w;
  const page = content("eligibility_refusal", (message) => w.c.handleMessage(message, { tab: { id: 11, windowId: 1 } }));
  w = await worker((message) => {
    if (w.sent.length === 1) return page.dispatch(message);
    w.state().running = false;
    return { ok: false, cancelled: true, message: "test ends after confirmed continuation" };
  });
  const reload = w.c.reloadLighthouseCampaignsAfterOrder;
  w.c.reloadLighthouseCampaignsAfterOrder = async (...args) => {
    assert.equal(w.state().uncertainAction, undefined, "the rejected order is cleared before the next scan starts");
    return reload(...args);
  };
  await w.c.startNextAutoTask("eligibility_refusal");
  assert.equal(page.replies[0].claimActionAttempted, false);
  assert.match(page.replies[0].message, /需灯塔严选资格/);
  assert.equal(page.button.clicked + page.invitation.clicked, 0);
  assert.equal(w.sent.length, 2);
  assert.equal(w.sent[1].type, "START_LIGHTHOUSE_COMMENT_TASK");
  assert.ok(w.effects.includes("closeDetail"));
  assert.ok(w.effects.includes("reloadCampaigns"));
  assert.ok(!w.sent[1].attemptedTaskKeys.includes(task.taskKey));
  assert.equal(w.state().currentTask, null);
});
