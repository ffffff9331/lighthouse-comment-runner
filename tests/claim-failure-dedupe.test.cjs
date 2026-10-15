"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sourceRoot = process.env.LIGHTHOUSE_TEST_SOURCE_ROOT || path.join(__dirname, "../src");
const read = file => fs.readFileSync(path.join(sourceRoot, file), "utf8");
const clone = value => JSON.parse(JSON.stringify(value));
const event = { addListener() {} };
const task = { taskKey: "list-task", selectionId: "selection-task", stableTaskKey: "stable-task", taskType: "评论", bounty: "0.2", title: "Fixture task", handle: "@fixture", tweetUrl: "https://x.com/fixture/status/123" };
const tab = { id: 11, windowId: 1, url: "https://app.lhdao.top/campaigns", status: "complete" };

// Exercise the complete production background, including sendToTab's receipt
// classification and the actual reload helper. Chrome edges are inert; no
// fixture can reach a site, claim a seat, or post a reply.
async function worker(t, initialStored = {}) {
  let now = 1000000;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const sent = [], reloads = [], effects = [], stored = clone(initialStored), hooks = {}, timers = new Set();
  const chrome = {
    runtime: { id: "test", getURL: p => `chrome-extension://test/${p}`, getManifest: () => ({ version: "test" }), onInstalled: event, onMessage: event },
    storage: { local: {
      async setAccessLevel() {},
      async get(keys) { return Object.fromEntries(keys.map(key => [key, stored[key]])); },
      async set(values, callback) { Object.assign(stored, clone(values)); callback?.(); },
      async remove() {},
    } },
    alarms: { onAlarm: event, async create() {}, async clear() {} },
    tabs: {
      onCreated: event, onUpdated: event, onRemoved: event,
      async get() { return tab; }, async query() { return [tab]; },
      async update() { return tab; },
      async reload(id) { reloads.push(id); effects.push("reload"); },
      async sendMessage(id, message) {
        sent.push(clone(message));
        if (message.type === "START_LIGHTHOUSE_COMMENT_TASK") {
          const count = sent.filter(item => item.type === message.type).length;
          return hooks.claim ? hooks.claim(message, count) : { ok: true, claimActionAttempted: true, task: { ...task, taskKey: "next-order", seatLocked: true } };
        }
        if (message.type === "CHECK_LIGHTHOUSE_LOCK_FAILURE" && hooks.lockFailure) return hooks.lockFailure(message);
        return { ok: true };
      },
    },
  };
  const c = vm.createContext({ chrome, console, URL, Date: Clock, AbortController, importScripts() {},
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
    fetch: async () => { throw new Error("Network forbidden in claim failure tests"); },
  });
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  for (const file of ["reply-engine.js", "background.js"]) vm.runInContext(read(file), c, { filename: file });
  await vm.runInContext("runtimeStateReady", c);
  Object.assign(c, {
    ensureLighthouseAlertBridge: async () => {}, publishLighthouseMonitorSnapshot() {},
    getOrCreateLighthouseTab: async () => tab, rememberLighthouseTabById: async () => {},
    focusLighthouseTabForAutoScan: async () => true, waitForTabComplete: async () => true, delay: async () => {},
    closeLighthouseTaskDetail: async () => { effects.push("close-detail"); return true; },
    getLighthouseWindowId: async () => 1, getBoundMatchingTaskXTab: async () => null,
    consumeXOpenCandidate: () => null, findRecentTweetTab: async () => null,
    openDirectTweetTabIfAvailable: async () => null,
  });
  const realAdopt = c.adoptTargetOpenedTweet;
  c.adoptTargetOpenedTweet = async () => ({ ok: true });
  vm.runInContext(`Object.assign(runtimeState, { running: true, mode: "auto", stage: "campaigns_returned", runId: "claim-test", lighthouseTabId: 11, lighthouseWindowId: 1, runtimeWindowId: 1 })`, c);
  const state = () => vm.runInContext("runtimeState", c);
  return { c, Clock, chrome, hooks, sent, reloads, effects, stored, realAdopt, state,
    now: () => now, advance: ms => { now += ms; },
    scan: () => c.startNextAutoTask("fixture_claim_failure"),
    scans: () => sent.filter(message => message.type === "START_LIGHTHOUSE_COMMENT_TASK"),
  };
}

function assertTaskEligible(message, keys) {
  for (const key of keys) assert.equal(message.attemptedTaskKeys.includes(key), false, `confirmed unclaimed task remains excluded: ${key}`);
}

function immediateRefusal(message) {
  return { ok: false, claimActionAttempted: true, message: "锁定失败：不可领取",
    task: { ...task, seatLocked: false, claimRejected: true },
    claimRejection: { runId: message.runId, type: message.type,
      claimIntentId: message.claimIntentId, taskKey: task.taskKey } };
}

test("a bound immediate lock refusal clears intent and resumes the plaza without excluding the task", async t => {
  const w = await worker(t);
  w.hooks.claim = (message, count) => count === 1 ? immediateRefusal(message)
    : { ok: true, claimActionAttempted: true, task: { taskKey: "next-order", seatLocked: true } };
  await w.scan();
  assert.equal(w.scans().length, 2);
  assert.equal(w.reloads.length, 1);
  assert.equal(w.state().uncertainAction, undefined);
  assertTaskEligible(w.scans()[1], w.c.getTaskDedupeKeys(task));
});

for (const cancelled of [false, true]) {
  test(`confirmed site cooldown is respected before refreshing (stop during wait: ${cancelled})`, async t => {
    const w = await worker(t), delays = [];
    w.hooks.claim = (message, count) => count === 1 ? { ...immediateRefusal(message), retryAfterMs: 30000 }
      : { ok: true, claimActionAttempted: true, task: { taskKey: "next-order", seatLocked: true } };
    w.c.delay = async ms => {
      delays.push(ms);
      if (ms === 30000) {
        assert.equal(w.reloads.length, 0, "cooldown must precede refresh and another attempt");
        assert.equal(w.scans().length, 1);
        assert.equal(w.state().stage, "claim_retry_cooldown");
        assert.equal(w.stored.lighthouseAutoRunStateV1.claimRetryNotBefore, w.now() + 30000);
        if (cancelled) w.state().running = false;
      }
    };
    await w.scan();
    assert.ok(delays.includes(30000));
    assert.equal(w.scans().length, cancelled ? 1 : 2);
    assert.equal(w.reloads.length, cancelled ? 0 : 1);
  });
}

test("a resumed worker waits out the persisted platform cooldown before claiming", async t => {
  const w = await worker(t), delays = [];
  w.state().claimRetryNotBefore = w.now() + 45000;
  w.c.delay = async ms => {
    delays.push(ms);
    if (ms === 45000) assert.equal(w.scans().length, 0);
  };
  await w.scan();
  assert.equal(delays[0], 45000);
  assert.equal(w.scans().length, 1);
  assert.equal(w.state().claimRetryNotBefore, undefined);
});

for (const minutes of [30, 480]) {
  test(`a rejected batch estimate of ${minutes} minutes returns to the live plaza without local dedupe`, async t => {
    const w = await worker(t), delays = [];
    const listTask = { ...task, taskKey: "list-alias", stableTaskKey: "stable-alias" };
    w.hooks.claim = (message, count) => {
      if (count !== 1) return { ok: true, claimActionAttempted: true, task: { taskKey: "next-order", seatLocked: true } };
      w.state().currentTask = listTask;
      return { ...immediateRefusal(message), retryAfterMs: minutes * 60000, claimRetryScope: "task" };
    };
    w.c.delay = async ms => { delays.push(ms); };
    await w.scan();
    assert.equal(w.scans().length, 2);
    assert.equal(w.reloads.length, 1);
    assert.equal(w.state().claimRetryNotBefore, undefined);
    assertTaskEligible(w.scans()[1], [...w.c.getTaskDedupeKeys(task), ...w.c.getTaskDedupeKeys(listTask)]);
    assert.ok(delays.every(ms => ms < 15000));
    assert.ok(w.state().logs.some(entry => entry.text.includes("返回广场读取平台新的倒计时")));
  });
}

for (const condition of ["batch", "rate-limit", "missing-log", "wrong-deadline", "uncertain", "locked"]) {
  test(`legacy cooldown restore respects current order and refusal identity: ${condition}`, async t => {
    const now = 1000000, deadline = now + 1800000;
    const saved = { running: true, mode: "auto", runId: "prior-run", claimRetryNotBefore: deadline,
      attemptedTaskRecords: [{key: "old-unclaimed", expiresAt: deadline, claimCooldown: true}],
      attemptedTaskKeys: ["old-unclaimed"],
      logs: [{at: new Date(now - 3000).toISOString(), text: "平台明确拒绝本次锁位：本批名额暂不可领取，请约 30 分钟后重试。"}] };
    if (condition === "rate-limit") saved.logs.unshift({at: new Date(now).toISOString(), text: "平台明确拒绝本次锁位：你抢的太快了，请 30 秒后重试"});
    if (condition === "missing-log") saved.logs = [];
    if (condition === "wrong-deadline") saved.claimRetryNotBefore += 120000;
    if (condition === "uncertain") saved.uncertainAction = { type: "START_LIGHTHOUSE_COMMENT_TASK" };
    if (condition === "locked") saved.currentTask = { ...task, seatLocked: true };
    const w = await worker(t, {lighthouseAutoRunStateV1: saved});
    assert.equal(w.state().claimRetryNotBefore, condition === "batch" ? undefined : saved.claimRetryNotBefore);
    assert.equal(w.state().attemptedTaskRecords.length, ["uncertain", "locked"].includes(condition) ? 1 : 0);
  });
}

test("unclaimed attempts do not create timed exclusions, locked orders retain protection", async t => {
  const w = await worker(t);
  w.c.markAttemptedTask({...task, deferUntil: w.now() + 1800000});
  assert.equal(w.c.getActiveAttemptedTaskKeys().includes(task.taskKey), false);
  w.c.markAttemptedTask({...task, seatLocked: true});
  assert.equal(w.c.getActiveAttemptedTaskKeys().includes(task.taskKey), true);
});

test("stop after a batch refusal prevents refresh and another scan", async t => {
  const w = await worker(t);
  w.hooks.claim = message => ({ ...immediateRefusal(message), retryAfterMs: 1800000, claimRetryScope: "task" });
  w.c.closeLighthouseTaskDetail = async () => { w.state().running = false; return true; };
  await w.scan();
  assert.equal(w.scans().length, 1);
  assert.equal(w.reloads.length, 0);
});

for (const mismatch of ["runId", "type", "claimIntentId", "taskKey"]) {
  test(`an immediate refusal with a different ${mismatch} retains the pending claim`, async t => {
    const w = await worker(t);
    w.hooks.claim = message => {
      const result = immediateRefusal(message);
      result.retryAfterMs = 1800000;
      result.claimRetryScope = "task";
      result.claimRejection[mismatch] = "unrelated";
      return result;
    };
    await w.scan();
    assert.equal(w.scans().length, 1);
    assert.equal(w.reloads.length, 0);
    assert.equal(w.state().stage, "action_result_unknown");
    assert.equal(w.state().running, false);
    assert.ok(w.stored.lighthouseAutoRunStateV1.uncertainAction);
  });
}

for (const protection of ["seatLocked", "claimed", "invitationAccepted", "completionEvidence", "lastXResult"]) {
  test(`an immediate refusal cannot discard concurrent ${protection} evidence`, async t => {
    const w = await worker(t);
    w.hooks.claim = message => {
      w.state().currentTask = { ...task };
      if (["completionEvidence", "lastXResult"].includes(protection)) w.state()[protection] = { ok: true };
      else w.state().currentTask[protection] = true;
      return immediateRefusal(message);
    };
    await w.scan();
    assert.equal(w.scans().length, 1);
    assert.equal(w.reloads.length, 0);
    assert.equal(w.state().running, false);
    assert.ok(w.state().uncertainAction);
    assert.equal(w.state().currentTask.taskKey, task.taskKey);
  });
}

test("explicit no-click refusal reloads the plaza and leaves the same task eligible", async t => {
  const w = await worker(t);
  w.hooks.claim = (_message, count) => count === 1
    ? { ok: false, claimActionAttempted: false, transient: false, message: "任务不可做：不可领取", task: { ...task, seatLocked: false, claimed: false } }
    : { ok: true, claimActionAttempted: true, task: { taskKey: "next-order", seatLocked: true } };
  await w.scan();
  assert.equal(w.scans().length, 2, "a definite rejection must continue scanning");
  assert.equal(w.reloads.length, 1, "a definite rejection must actually reload once");
  assert.equal(w.effects.indexOf("close-detail") < w.effects.indexOf("reload"), true);
  assert.equal(w.state().uncertainAction, undefined);
  assertTaskEligible(w.scans()[1], w.c.getTaskDedupeKeys(task));
});

test("a later explicit lock rejection releases every optimistic list/detail dedupe key before refreshing", async t => {
  const w = await worker(t);
  const provisional = { ...task, detailText: "锁定席位 倒计时 00:01", seatLocked: true, seatLockedAt: new w.Clock().toISOString() };
  const refusal = { ...task, taskKey: "detail-refused", detailText: "锁定失败 不可领取", seatLocked: false, claimed: false };
  w.state().currentTask = provisional;
  w.c.markAttemptedTask(provisional);
  w.hooks.lockFailure = () => ({ ok: true, failed: true, message: "锁定失败：不可领取", task: refusal,
    claimRejection: { runId: "claim-test", taskKey: provisional.taskKey, seatLockedAt: provisional.seatLockedAt } });
  await w.realAdopt(provisional, tab.id, "auto");
  assert.equal(w.reloads.length, 1);
  assert.equal(w.scans().length, 1);
  assert.equal(w.state().uncertainAction, undefined);
  assertTaskEligible(w.scans()[0], [...w.c.getTaskDedupeKeys(provisional), ...w.c.getTaskDedupeKeys(refusal)]);
});

for (const mismatch of ["run", "task"]) {
  test(`a rejection receipt for a different ${mismatch} cannot release the current locked order`, async t => {
    const w = await worker(t);
    const locked = { ...task, seatLocked: true, seatLockedAt: new w.Clock().toISOString() };
    w.state().currentTask = locked;
    w.c.markAttemptedTask(locked);
    w.c.delay = async ms => w.advance(ms);
    w.hooks.lockFailure = () => ({ ok: true, failed: true, message: "锁定失败：不可领取", task: { ...task, seatLocked: false },
      claimRejection: { runId: mismatch === "run" ? "stale-run" : "claim-test", taskKey: mismatch === "task" ? "unrelated-task" : task.taskKey, seatLockedAt: locked.seatLockedAt } });
    await w.realAdopt(locked, tab.id, "auto");
    assert.equal(w.reloads.length, 0, "unbound refusal is not permission to reload a live order");
    assert.equal(w.scans().length, 0);
    assert.equal(w.state().running, false);
    assert.equal(w.state().currentTask.taskKey, task.taskKey);
    assert.equal(w.state().currentTask.seatLocked, true);
  });
}

test("a confirmed locked order remains protected after the ordinary three-minute dedupe window", async t => {
  const w = await worker(t);
  const locked = { ...task, seatLocked: true, claimed: true, seatLockedAt: new w.Clock().toISOString() };
  w.state().currentTask = locked;
  w.c.markAttemptedTask(locked);
  w.advance(180001);
  const result = await w.c.recoverAndContinue("X 后续步骤失败", { runId: "claim-test", task: locked, closeX: false });
  assert.equal(result.ok, false);
  assert.equal(w.state().running, false);
  assert.equal(w.state().stage, "locked_task_recovery_blocked");
  assert.equal(w.state().currentTask.taskKey, task.taskKey);
  assert.equal(w.reloads.length, 0);
  assert.equal(w.scans().length, 0);
});

for (const lostReceipt of [false, true]) {
  test(`an attempted claim with ${lostReceipt ? "a lost receipt" : "an unconfirmed timeout"} never reloads or retries`, async t => {
    const w = await worker(t);
    w.hooks.claim = async () => {
      if (lostReceipt) throw new Error("The message port closed before a response was received.");
      return { ok: false, claimActionAttempted: true, transient: true, message: "Request timeout", task };
    };
    await w.scan();
    assert.equal(w.scans().length, 1);
    assert.equal(w.reloads.length, 0);
    assert.equal(w.state().running, false);
    assert.equal(w.state().stage, "action_result_unknown");
    assert.equal(w.state().uncertainAction.type, "START_LIGHTHOUSE_COMMENT_TASK");
    assert.equal(w.stored.lighthouseAutoRunStateV1.uncertainAction.runId, "claim-test");
  });
}

test("legacy three-minute temporary records expire at the exact boundary without removing permanent ignores", async t => {
  const w = await worker(t), started = w.now();
  w.state().attemptedTaskRecords = [{ key: task.taskKey, expiresAt: started + 180000 }];
  w.state().attemptedTaskKeys = [task.taskKey];
  vm.runInContext("permanentIgnoredTaskKeysCache.add('permanent-ignore')", w.c);
  w.advance(179999);
  assert.deepEqual(clone(w.c.getActiveAttemptedTaskKeys()).sort(), [task.taskKey, "permanent-ignore"].sort());
  w.advance(1);
  assert.deepEqual(clone(w.c.getActiveAttemptedTaskKeys()), ["permanent-ignore"]);
  assert.deepEqual(clone(w.state().attemptedTaskRecords), []);
});

function plaza(w) {
  let listener;
  const replies = [];
  const began = w.now();
  const c = vm.createContext({ console, URL, Date: w.Clock, AbortController, setTimeout, clearTimeout,
    fixtureTask: task,
    fixtureWait: async ms => {
      w.advance(ms);
      if (w.now() - began > 181000) throw new Error("Fixture deadline: expired dedupe still blocked the same scan");
    },
    window: { addEventListener() {} }, document: { body: { innerText: "任务广场 评论 0.2 LUX" } },
    location: { href: tab.url, pathname: "/campaigns", origin: "https://app.lhdao.top" },
    chrome: { runtime: {
      onMessage: { addListener(fn) { listener = fn; } },
      sendMessage: message => w.c.handleMessage(message, { tab }),
    } },
  });
  // Keep the production listener, scan loop and background protocol. Substitute
  // only page parsing and DOM actions, with fake time instead of a real 3m wait.
  const adapters = `
    ensureCampaignsPage = async () => {};
    confirmPagePhase = async () => {};
    ensureAllTaskFilter = async () => {};
    waitForCampaignsReady = async () => {};
    isTaskDetailOrRecoverableOverlayOpen = () => false;
    isCampaignsListOpen = () => true;
    getLiveAutoMinTaskBounty = async () => 0.1;
    collectTaskCandidates = (keys) => [{ ...fixtureTask, text: "Fixture task", target: {}, isAutomatable: true, isBlocked: false, cooldownMs: 0, attempted: (keys || []).includes(fixtureTask.taskKey) }];
    getLighthousePageSnapshot = () => ({ phase: "campaigns", path: "/campaigns" });
    openTaskDetailOrFail = async () => {};
    acceptInvitationIfPresent = async () => false;
    buildTask = () => ({ ...fixtureTask });
    assertSupportedDetailTask = () => {};
    hasDetailRequestTimeout = () => false;
    debugLockSeatAndExtract = async () => ({ ok: true, task: { ...fixtureTask, seatLocked: true } });
    wait = fixtureWait;
  `;
  const source = read("content/lighthouse.js"), end = source.lastIndexOf("})();");
  vm.runInContext(source.slice(0, end) + adapters + source.slice(end), c);
  return { replies, dispatch: message => new Promise(resolve => {
    listener(message, {}, result => { replies.push(clone(result)); resolve(result); });
  }) };
}

test("a pending content scan releases expired three-minute exclusions without waiting five minutes for idle refresh", async t => {
  const w = await worker(t), started = w.now();
  w.state().attemptedTaskRecords = [{ key: task.taskKey, expiresAt: started + 180000 }];
  w.state().attemptedTaskKeys = [task.taskKey];
  const page = plaza(w);
  w.hooks.claim = (message, count) => count === 1 ? page.dispatch(message)
    : { ok: true, claimActionAttempted: true, task: { taskKey: "fixture-end", seatLocked: true } };
  await w.scan();
  assert.equal(page.replies[0].ok, true, page.replies[0].message);
  assert.ok(w.now() - started <= 180500, "expiry must become visible within one content poll");
  assert.equal(w.scans().length, 1);
  assert.equal(w.reloads.length, 0, "expiry alone must not require another page reload");
});

test("confirmed no-click refusal still consumes the one-attempt budget", async t => {
  const w = await worker(t);
  w.stored.settings = { ...await w.c.getSettings(), maxTaskAttempts: 1 };
  w.hooks.claim = () => ({ ok: false, claimActionAttempted: false, transient: false,
    message: "任务不可做：不可领取", task: { ...task, seatLocked: false, claimed: false } });
  await w.scan();
  assert.equal(w.scans().length, 1, "removing failure dedupe must not bypass maxTaskAttempts");
  assert.equal(w.state().attempts, 1);
  assert.equal(w.state().running, false);
  assert.equal(w.state().stage, "attempt_limit_reached");
  assert.equal(w.reloads.length, 1);
  assert.equal(w.c.getActiveAttemptedTaskKeys().includes(task.taskKey), false);
});

test("a permanent key overlapping an expiring temporary record is never sent as temporary", async t => {
  const w = await worker(t), started = w.now();
  await w.c.ensurePermanentIgnoredTaskKeysLoaded();
  w.state().attemptedTaskRecords = [{ key: task.taskKey, expiresAt: started + 180000 }];
  w.state().attemptedTaskKeys = [task.taskKey];
  vm.runInContext(`permanentIgnoredTaskKeysCache.add(${JSON.stringify(task.taskKey)})`, w.c);
  await w.scan();
  const request = w.scans()[0];
  assert.equal(request.attemptedTaskKeys.includes(task.taskKey), true);
  assert.equal(request.attemptedTaskRecords.some(record => record.key === task.taskKey), false,
    "content expiry must not downgrade a permanent exclusion to a temporary key");
  w.advance(180001);
  assert.equal(w.c.getActiveAttemptedTaskKeys().includes(task.taskKey), true);
});

for (const protection of ["uncertain", "invitation", "completion", "lastXResult"]) {
  test(`a matching late rejection cannot release a task with ${protection} protection`, async t => {
    const w = await worker(t);
    const locked = { ...task, seatLocked: true, seatLockedAt: new w.Clock().toISOString() };
    if (protection === "invitation") locked.invitationAccepted = { runId: "claim-test", taskKey: task.taskKey };
    w.state().currentTask = locked;
    w.c.markAttemptedTask(locked);
    if (protection === "uncertain") w.state().uncertainAction = { runId: "claim-test", taskKey: task.taskKey, tabId: 11, type: "RUN_X_REPLY" };
    if (protection === "completion") w.state().completionEvidence = { runId: "claim-test", taskKey: task.taskKey, officialCompletion: true };
    if (protection === "lastXResult") w.state().lastXResult = { ok: true, mode: "post", replyText: "fixture completed reply" };
    w.c.delay = async ms => w.advance(ms);
    w.hooks.lockFailure = () => ({ ok: true, failed: true, message: "锁定失败：不可领取", task: { ...task, seatLocked: false },
      claimRejection: { runId: "claim-test", taskKey: task.taskKey, seatLockedAt: locked.seatLockedAt } });
    await w.realAdopt(locked, tab.id, "auto");
    assert.equal(w.reloads.length, 0);
    assert.equal(w.scans().length, 0);
    assert.equal(w.state().running, false);
    assert.equal(w.state().currentTask.taskKey, task.taskKey);
    assert.equal(w.state().currentTask.seatLocked, true);
    assert.equal(w.c.getActiveAttemptedTaskKeys().includes(task.taskKey), true);
    assert.equal(w.state().logs.some(entry => /已解除本任务去重|不加入去重/.test(entry.text)), false);
  });
}

for (const protection of ["locked", "invitation", "claimed", "completion", "lastXResult"]) {
  test(`a no-click failure receipt cannot overwrite existing ${protection} order protection`, async t => {
    const w = await worker(t);
    w.hooks.claim = (_message, count) => {
      if (count > 1) return { ok: true, claimActionAttempted: true, task: { taskKey: "wrong-next-order", seatLocked: true } };
      // Existing order evidence arrives while the first scan's response is in
      // flight. Its late refusal must not overwrite these stronger facts.
      const protectedTask = { ...task };
      if (protection === "locked") Object.assign(protectedTask, { seatLocked: true, seatLockedAt: new w.Clock().toISOString() });
      if (protection === "invitation") protectedTask.invitationAccepted = { runId: "claim-test", taskKey: task.taskKey };
      if (protection === "claimed") protectedTask.claimed = true;
      w.state().currentTask = protectedTask;
      w.c.markAttemptedTask(protectedTask);
      if (protection === "completion") w.state().completionEvidence = { runId: "claim-test", taskKey: task.taskKey, officialCompletion: true };
      if (protection === "lastXResult") w.state().lastXResult = { ok: true, mode: "post", replyText: "fixture completed reply" };
      return { ok: false, claimActionAttempted: false, transient: false, message: "任务不可做：不可领取",
        task: { ...task, seatLocked: false, seatLockedAt: null, claimed: false, invitationAccepted: null } };
    };
    await w.scan();
    assert.equal(w.reloads.length, 0, "a late no-click failure is not permission to discard the existing order page");
    assert.equal(w.scans().length, 1, "the next claim must wait for the protected order to be checked");
    assert.equal(w.state().running, false);
    assert.equal(w.state().currentTask.taskKey, task.taskKey);
    assert.equal(w.c.getActiveAttemptedTaskKeys().includes(task.taskKey), true);
    if (protection === "locked") assert.equal(w.state().currentTask.seatLocked, true);
    if (protection === "invitation") assert.ok(w.state().currentTask.invitationAccepted);
    if (protection === "claimed") assert.equal(w.state().currentTask.claimed, true);
    if (protection === "completion") assert.equal(w.state().completionEvidence?.taskKey, task.taskKey);
    if (protection === "lastXResult") assert.equal(w.state().lastXResult?.ok, true);
  });
}
