"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// The optional source override runs these same user-visible cases against an
// older checkout. All browser APIs are local fixtures; no site is contacted.
const sourceRoot = process.env.LIGHTHOUSE_TEST_SOURCE_ROOT || path.join(__dirname, "../src");
const read = (file) => fs.readFileSync(path.join(sourceRoot, file), "utf8");
const clone = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };
const event = { addListener() {} };
const stateKey = "lighthouseAutoRunStateV1";
const scanType = "START_LIGHTHOUSE_COMMENT_TASK";
const task = { taskKey: "manual-order", taskType: "评论", bounty: "0.2", tweetUrl: "https://x.com/fixture/status/123" };
const noNetwork = async () => { throw Error("Network forbidden in manual takeover tests"); };

async function worker() {
  const stored = {}, sent = [], hooks = {};
  const chrome = {
    runtime: { id: "test", getURL: (p) => `chrome-extension://test/${p}`, getManifest: () => ({ version: "test" }),
      onInstalled: event, onMessage: event },
    storage: { session: require("./session-fixture.cjs")(), local: { setAccessLevel: async () => {},
      async get(keys) { return Object.fromEntries(keys.filter(key => Object.hasOwn(stored, key)).map((key) => [key, stored[key]])); },
      async set(values, callback) { Object.assign(stored, clone(values)); callback?.(); } } },
    alarms: { onAlarm: event, create: async () => {}, clear: async () => {} },
    tabs: { onCreated: event, onUpdated: event, onRemoved: event,
      async update(id) { return { id, windowId: 1 }; },
      async sendMessage(id, message) {
        sent.push({ id, message: clone(message) });
        if (message.type === "CANCEL_LIGHTHOUSE_RUN") {
          await hooks.beforeCancel?.(message);
          const reply = hooks.page ? await hooks.page.cancel(message) : { ok: true };
          return hooks.cancelReceipt ? hooks.cancelReceipt(reply, message) : reply;
        }
        if (message.type.startsWith("CANCEL_")) return { ok: true };
        if (message.type === "BEGIN_LIGHTHOUSE_COMPLETION_WATCH") return { ok: true };
        if (["RUN_X_REPLY", "COMPLETE_X_TASK_WIDGET"].includes(message.type)) {
          await hooks.beforeReply?.(message);
          return { ok: true, message: "fixture reply completed" };
        }
        if (hooks.page) return hooks.page.dispatch(message);
        throw Error("Unexpected Chrome message " + message.type);
      } }
  };
  const c = vm.createContext({ chrome, URL, AbortController, console, importScripts() {}, clearTimeout,
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; }, fetch: noNetwork });
  for (const file of ["reply-engine.js", "background.js"]) vm.runInContext(read(file), c, { filename: file });
  await vm.runInContext("runtimeStateReady", c);
  Object.assign(c, {
    publishLighthouseMonitorSnapshot() {}, ensureLighthouseAlertBridge: async () => {},
    getOrCreateLighthouseTab: async () => ({ id: 11, windowId: 1, url: "https://app.lhdao.top/campaigns" }),
    rememberLighthouseTabById: async () => {}, focusLighthouseTabForAutoScan: async () => true,
    resolveLighthouseTab: async () => 11, resolveCurrentXTab: async () => 12,
    waitForTabComplete: async () => true, delay: async () => {},
    waitForOfficialLighthouseCompletionDuringXSubmission: async () => null
  });
  vm.runInContext('Object.assign(runtimeState, {running:true, mode:"auto", stage:"campaigns_returned", runId:"auto-run", lighthouseTabId:11, lighthouseWindowId:1, runtimeWindowId:1})', c);
  const state = () => vm.runInContext("runtimeState", c);
  const message = (type, extra = {}) => c.handleMessage({ type, clientWindowId: 1, ...extra },
    { id: "test", url: "chrome-extension://test/src/debug/debug.html" });
  return { c, chrome, stored, sent, hooks, state, message,
    scans: () => sent.filter(({ message }) => message.type === scanType),
    actions: () => sent.filter(({ message }) => ["DEBUG_OPEN_FIRST_COMMENT_TASK", "RUN_X_REPLY", "COMPLETE_X_TASK_WIDGET"].includes(message.type)) };
}

// Load the complete Lighthouse script. Its real listener, operation registry,
// runCommentTask and selection loop run unchanged; only DOM/timing adapters
// are replaced. Cancellation releases a genuine pending selection iteration.
function marketplace(w, options = {}) {
  let listener;
  const entered = deferred(), release = deferred(), replies = [];
  const fixture = { ready: false, waited: false, clicks: 0, attempted: !!options.attempted, realWait: !!options.realWait };
  const c = vm.createContext({ URL, console, setTimeout, clearTimeout, fetch: noNetwork, fixture,
    fixtureTask: task, fixtureEntered: () => entered.resolve(),
    fixtureWait: async () => { fixture.waited = true; entered.resolve(); await release.promise; },
    fixtureButton: { click() { fixture.clicks++; } },
    window: { addEventListener() {} }, document: { body: { innerText: "任务广场 冷却中" } },
    location: { href: "https://app.lhdao.top/campaigns", pathname: "/campaigns" },
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } },
      sendMessage: (message) => w.c.handleMessage(message, { tab: { id: 11, windowId: 1 } }) } }
  });
  const adapters = `
    ensureCampaignsPage = async () => {};
    confirmPagePhase = async () => {};
    ensureAllTaskFilter = async () => {};
    waitForCampaignsReady = async () => {
      if (fixture.realWait && !fixture.waited) {
        fixture.waited = true;
        const waiting = wait(5000);
        fixtureEntered();
        await waiting;
      }
    };
    isTaskDetailOrRecoverableOverlayOpen = () => false;
    isCampaignsListOpen = () => true;
    getLiveAutoMinTaskBounty = async () => 0.1;
    collectTaskCandidates = () => [{...fixtureTask, target:{}, text:"fixture task", title:"fixture task",
      isAutomatable:true, isBlocked:false, cooldownMs:fixture.ready ? 0 : 1200000, bounty:0.2, attempted:false}];
    hasDetailRequestTimeout = () => false;
    getLighthousePageSnapshot = () => ({phase:"campaigns",path:"/campaigns"});
    buildTask = () => ({...fixtureTask,seatLocked:false});
    openTaskDetailOrFail = async () => {};
    acceptInvitationIfPresent = async () => {};
    assertSupportedDetailTask = () => {};
    ${options.realWait ? "" : `wait = async () => {
      if (fixture.attempted && !fixture.waited) await clickElement(fixtureButton, {claimAction:true,randomDelay:false});
      await fixtureWait();
    };`}
  `;
  const source = read("content/lighthouse.js"), end = source.lastIndexOf("})();");
  vm.runInContext(source.slice(0, end) + adapters + source.slice(end), c);
  const dispatch = (message) => new Promise((resolve) => {
    assert.equal(listener(message, {}, (reply) => { replies.push({ type: message.type, reply: clone(reply) }); resolve(reply); }), true);
  });
  const page = { c, fixture, entered, replies, dispatch,
    async cancel(message) {
      const result = dispatch(message);
      fixture.ready = true;
      release.resolve();
      return result;
    } };
  w.hooks.page = page;
  return page;
}

async function liveScan(options = {}) {
  const w = await worker(), page = marketplace(w, options);
  const flow = w.c.startNextAutoTask("fixture_pending_scan");
  await page.entered.promise;
  assert.equal(w.state().uncertainAction.type, scanType);
  return { w, page, flow };
}

function assertBlocked(w, result, intent) {
  assert.equal(result.ok, false);
  assert.equal(w.state().uncertainAction, intent, "unproven cancellation must retain the exact pending intent");
  assert.equal(w.actions().length, 0);
  assert.ok(!w.state().logs.some((entry) => /单步控制已接管/.test(entry.text)), "a refused step must not announce successful takeover");
}

for (const command of ["DEBUG_OPEN_FIRST_TASK", "DEBUG_RUN_X_REPLY"]) {
  test(`live pending scan safely hands control to ${command}`, { timeout: 3000 }, async () => {
    const { w, page, flow } = await liveScan();
    if (command === "DEBUG_RUN_X_REPLY") w.state().currentTask = clone(task);
    const result = await w.message(command);
    if (!result.ok) {
      // Bound the older implementation after its refusal; its auto retry loop
      // must not obscure the failed user-visible takeover assertion below.
      w.state().running = false;
      await page.cancel({ type: "CANCEL_LIGHTHOUSE_RUN", runId: "auto-run" });
    }
    await flow;
    assert.equal(result.ok, true);
    assert.equal(w.state().mode, "debug");
    assert.equal(w.state().running, true);
    assert.notEqual(w.state().runId, "auto-run");
    assert.ok(!w.state().uncertainAction);
    assert.equal(w.scans().length, 1);
    assert.equal(w.actions().length, 1);
    assert.equal(w.actions()[0].message.runId, w.state().runId);
    assert.equal(w.state().currentTask.taskKey, task.taskKey);
    assert.equal(w.state().stage, command === "DEBUG_RUN_X_REPLY" ? "x_replied" : "task_detail_opened");
    assert.equal(page.fixture.clicks, 0);
    const cancel = page.replies.find(({ type }) => type === "CANCEL_LIGHTHOUSE_RUN").reply;
    assert.equal(cancel.cancellationProof?.settled, true);
    assert.equal(cancel.cancellationProof?.claimActionAttempted, false);
  });
}

test("STOP consumes a proven no-click cancellation without leaving a stale claim marker", { timeout: 3000 }, async () => {
  const { w, page, flow } = await liveScan();
  assert.equal((await w.message("STOP_RUN")).ok, true);
  await flow;
  assert.equal(w.state().running, false);
  assert.equal(w.state().stage, "stopped");
  assert.ok(!w.state().uncertainAction);
  assert.ok(!w.stored[stateKey].uncertainAction);
  assert.equal(w.actions().length, 0);
  assert.equal(page.fixture.clicks, 0);
});

test("a real claim click prevents cancellation from authorizing a manual step", { timeout: 3000 }, async () => {
  const { w, page, flow } = await liveScan({ attempted: true });
  const intent = w.state().uncertainAction;
  const result = await w.message("DEBUG_RUN_X_REPLY");
  await flow;
  assert.equal(page.fixture.clicks, 1);
  assertBlocked(w, result, intent);
});

test("a saved unknown claim with no matching live operation cannot be dismissed", async () => {
  const w = await worker();
  marketplace(w);
  const intent = { type: scanType, runId: "historic-run", tabId: 11 };
  Object.assign(w.state(), { running: false, stage: "stopped", uncertainAction: intent });
  const result = await w.message("DEBUG_RUN_X_REPLY");
  assertBlocked(w, result, intent);
});

test("a lost cancellation receipt cannot erase an unresolved claim or report takeover", { timeout: 3000 }, async () => {
  const { w, flow } = await liveScan();
  const intent = w.state().uncertainAction;
  w.hooks.cancelReceipt = () => { throw Error("fixture cancellation receipt lost"); };
  const result = await w.message("DEBUG_RUN_X_REPLY");
  await flow;
  assertBlocked(w, result, intent);
});

test("wrong identity or incomplete proof never clears the claim intent", { timeout: 3000 }, async () => {
  const invalidFields = [["runId", "wrong-run"], ["type", "RUN_X_REPLY"], ["claimIntentId", "wrong-nonce"],
    ["tabId", 99], ["settled", false], ["claimActionAttempted", undefined], ["claimed", true]];
  for (const [field, value] of invalidFields) {
    const { w, flow } = await liveScan();
    const intent = w.state().uncertainAction;
    if (field === "tabId") intent.tabId = value;
    else w.hooks.cancelReceipt = (reply) => ({ ...reply, cancellationProof: { ...reply.cancellationProof,
      [field]: value } });
    const result = await w.message("DEBUG_RUN_X_REPLY");
    await flow;
    assertBlocked(w, result, intent);
  }
});

test("STOP during takeover cancellation wins over the awaiting old debug command", { timeout: 3000 }, async () => {
  const { w, flow } = await liveScan(), entered = deferred(), release = deferred();
  let first = true;
  w.hooks.beforeCancel = async () => { if (first) { first = false; entered.resolve(); await release.promise; } };
  const pending = w.message("DEBUG_RUN_X_REPLY");
  await entered.promise;
  await w.message("STOP_RUN");
  const stopped = clone(w.state());
  release.resolve();
  assert.equal((await pending).ok, false);
  await flow;
  assert.deepEqual(clone(w.state()), stopped);
  assert.equal(w.actions().length, 0);
});

test("a newer run is not overwritten when an old takeover cancellation finishes late", { timeout: 3000 }, async () => {
  const { w, flow } = await liveScan(), entered = deferred(), release = deferred();
  w.hooks.beforeCancel = async () => { entered.resolve(); await release.promise; };
  const pending = w.message("DEBUG_RUN_X_REPLY");
  await entered.promise;
  vm.runInContext('runtimeState = {...createInitialState(),running:true,mode:"auto",stage:"new_run_owned",runId:"new-run",lighthouseTabId:11,runtimeWindowId:1,currentTask:{taskKey:"new-task"},uncertainAction:{type:"RUN_X_REPLY",runId:"new-run",tabId:12}}', w.c);
  const fresh = clone(w.state());
  release.resolve();
  assert.equal((await pending).ok, false);
  await flow;
  assert.deepEqual(clone(w.state()), fresh);
  assert.equal(w.actions().length, 0);
});

test("successive manual steps retain the current task and the accepted debug run", { timeout: 3000 }, async () => {
  const w = await worker(), page = marketplace(w);
  page.fixture.ready = true;
  const claimedTask = { ...task, claimed: true, seatLocked: true };
  Object.assign(w.state(), { mode: "debug", stage: "debug_ready", currentTask: claimedTask });
  const runId = w.state().runId;
  assert.equal((await w.message("DEBUG_RUN_X_REPLY", { expectedRunId: runId })).ok, true);
  assert.equal((await w.message("DEBUG_RUN_X_REPLY", { expectedRunId: runId })).ok, true);
  assert.equal(w.state().runId, runId);
  assert.deepEqual(clone(w.state().currentTask), claimedTask);
  assert.deepEqual(w.actions().map(({ message }) => message.task.taskKey), [task.taskKey, task.taskKey]);
});

for (const interruption of ["STOP", "new run"]) {
  test(`queued old manual command cannot continue after ${interruption}`, { timeout: 3000 }, async () => {
    const w = await worker(), entered = deferred(), release = deferred();
    Object.assign(w.state(), { mode: "debug", currentTask: clone(task) });
    let first = true;
    w.hooks.beforeReply = async () => { if (first) { first = false; entered.resolve(); await release.promise; } };
    const pending = w.message("DEBUG_RUN_X_REPLY", { expectedRunId: "auto-run" });
    await entered.promise;
    const queued = w.message("DEBUG_RUN_X_REPLY", { expectedRunId: "auto-run" });
    // Let handleMessage enqueue before the run changes.
    await Promise.resolve(); await Promise.resolve();
    if (interruption === "STOP") await w.message("STOP_RUN");
    else vm.runInContext('runtimeState = {...createInitialState(),running:true,mode:"debug",stage:"new_run_owned",runId:"new-run",lighthouseTabId:11,runtimeWindowId:1,currentTask:{taskKey:"new-task"}}', w.c);
    const stable = clone(w.state());
    release.resolve();
    assert.equal((await pending).ok, false);
    assert.equal((await queued).ok, false);
    assert.equal(w.actions().length, 1);
    assert.deepEqual(clone(w.state()), stable);
  });
}

test("the real five-second content wait cancels within two seconds and permits the first takeover", { timeout: 6500 }, async () => {
  // This fixture leaves production wait() and real timers intact. Resolving
  // fixtureWait cannot help it: cancellation must be observed by wait itself.
  const { w, page, flow } = await liveScan({ realWait: true });
  const started = Date.now();
  const result = await w.message("DEBUG_OPEN_FIRST_TASK");
  const elapsed = Date.now() - started;
  if (!result.ok) {
    w.state().running = false;
    await page.cancel({ type: "CANCEL_LIGHTHOUSE_RUN", runId: "auto-run" });
  }
  await flow;
  assert.equal(result.ok, true, "the first click must complete takeover rather than ask for a retry");
  assert.ok(elapsed < 2000, `a five-second poll took ${elapsed}ms to cancel`);
  const receipt = page.replies.find(({ type }) => type === "CANCEL_LIGHTHOUSE_RUN").reply;
  assert.equal(receipt.cancellationProof?.settled, true);
  assert.equal(receipt.cancellationProof?.claimActionAttempted, false);
  assert.ok(!receipt.timedOut);
  assert.equal(w.state().stage, "task_detail_opened");
  assert.equal(w.actions().length, 1);
});

test("an expected-run continuation cannot revive a debug run while STOP is awaiting cancellation", { timeout: 3000 }, async () => {
  const w = await worker(), entered = deferred(), release = deferred();
  Object.assign(w.state(), { mode: "debug", currentTask: clone(task) });
  w.hooks.beforeCancel = async () => { entered.resolve(); await release.promise; };
  const stop = w.message("STOP_RUN");
  await entered.promise;
  assert.equal(w.state().runId, "auto-run", "exercise the interval before STOP rotates the run id");
  assert.equal(w.state().running, false);
  const continuation = await w.message("DEBUG_RUN_X_REPLY", { expectedRunId: "auto-run" });
  release.resolve();
  const stopped = await stop;
  assert.equal(continuation.ok, false);
  assert.equal(stopped.ok, true);
  assert.equal(w.state().running, false);
  assert.equal(w.state().stage, "stopped");
  assert.equal(w.actions().length, 0);
});

for (const action of ["RUN_X_REPLY", "COMPLETE_X_TASK_WIDGET"]) {
  test(`cancelling in-flight ${action} retains unknown evidence and ignores late outcomes`, { timeout: 3000 }, async (t) => {
    for (const lateOutcome of ["success", "error"]) {
      for (const replacement of [false, true]) {
        const w = await worker(), entered = deferred(), release = deferred();
        Object.assign(w.state(), { xTabId: 12, currentTask: { ...task, claimed: true, seatLocked: true } });
        let first = true;
        t.after(() => release.resolve());
        w.hooks.beforeReply = async () => {
          // A faulty duplicate is counted and returned immediately so the
          // older implementation fails visibly instead of hanging the test.
          if (!first) return;
          first = false;
          entered.resolve();
          await release.promise;
          if (lateOutcome === "error") throw Error("fixture late receipt lost");
        };
        const pending = action === "RUN_X_REPLY" ? w.c.debugRunXReply() : w.c.debugCompleteXTaskWidget();
        await entered.promise;
        const takeover = await w.message(action === "RUN_X_REPLY" ? "DEBUG_RUN_X_REPLY" : "DEBUG_COMPLETE_X_TASK_WIDGET");
        assert.equal(takeover.ok, false, "cancellation acknowledgement cannot authorize a duplicate irreversible step");
        const intent = w.state().uncertainAction;
        assert.equal(intent.type, action);
        assert.equal(intent.runId, "auto-run");
        assert.equal(intent.tabId, 12);
        assert.equal(intent.taskKey, task.taskKey);
        assert.deepEqual(clone(w.stored[stateKey].uncertainAction), clone(intent));
        assert.equal(w.actions().length, 1);
        assert.ok(w.sent.some(({ id, message }) => id === 12 && message.type === "CANCEL_X_RUN"));
        assert.ok(!w.state().logs.some((entry) => /单步控制已接管/.test(entry.text)));
        if (replacement) {
          vm.runInContext('runtimeState = {...createInitialState(),running:true,mode:"debug",stage:"new_run_owned",runId:"new-run",lighthouseTabId:11,xTabId:12,runtimeWindowId:1,currentTask:{taskKey:"new-task"},uncertainAction:{type:"RUN_X_REPLY",runId:"new-run",tabId:12,taskKey:"new-task"}}', w.c);
        }
        const stable = clone(w.state());
        release.resolve();
        assert.equal((await pending).ok, false);
        assert.deepEqual(clone(w.state()), stable, `late ${lateOutcome} must not alter the ${replacement ? "new" : "stopped"} run`);
        assert.equal(w.actions().length, 1);
      }
    }
  });
}

// Preserve the real open-task handler, invitation click, task builder and
// listener receipt. Only DOM lookup/navigation boundaries are adapted here.
function invitationMarketplace(w, { invitation = false, failAfterClick = false } = {}) {
  let listener;
  const fixture = { clicks: 0 };
  const replies = [];
  const detailRoot = { innerText: "评论任务 目标推文" };
  const invitationButton = { innerText: "接受邀请", click() { fixture.clicks += 1; } };
  const c = vm.createContext({ URL, console, setTimeout, clearTimeout, fetch: noNetwork,
    fixture, fixtureInvitation: invitation, fixtureFailAfterClick: failAfterClick,
    fixtureDetailRoot: detailRoot, fixtureInvitationButton: invitationButton,
    fixtureSelection: { ...task, text: "评论任务 0.2 LUX", target: {} },
    window: { addEventListener() {} }, document: { body: detailRoot, querySelectorAll: () => [] },
    location: { href: "https://app.lhdao.top/campaigns", pathname: "/campaigns" },
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } },
      sendMessage: (message) => w.c.handleMessage(message, { tab: { id: 11, windowId: 1 } }) } }
  });
  const adapters = `
    ensureCampaignsPage = async () => {};
    confirmPagePhase = async (_phases, _settings, label) => {
      if (fixtureFailAfterClick && fixture.clicks && label === "打开任务详情后")
        throw new Error("fixture invitation clicked but detail DOM became unreadable");
    };
    ensureAllTaskFilter = async () => {};
    selectNextCommentTask = async () => fixtureSelection;
    openTaskDetailOrFail = async () => {};
    findInvitationAcceptButton = () => fixtureInvitation ? fixtureInvitationButton : null;
    findTaskDetailRoot = () => fixtureDetailRoot;
    extractTitle = () => "Comment";
    extractTweetUrl = () => "https://x.com/fixture/status/123";
    detectCandidateTaskType = () => "评论";
    report = () => {};
    hasDetailRequestTimeout = () => false;
  `;
  const content = read("content/lighthouse.js"), end = content.lastIndexOf("})();");
  vm.runInContext(content.slice(0, end) + adapters + content.slice(end), c);
  const dispatch = (message) => new Promise((resolve) => {
    assert.equal(listener(message, {}, (reply) => {
      replies.push({ type: message.type, reply: clone(reply) });
      resolve(reply);
    }), true);
  });
  const page = { fixture, replies, dispatch, cancel: dispatch };
  w.hooks.page = page;
  return page;
}

test("ordinary step 02 without an invitation keeps its successful no-claim receipt", { timeout: 3000 }, async () => {
  const w = await worker(), page = invitationMarketplace(w);
  Object.assign(w.state(), { mode: "debug", stage: "debug_ready" });
  const result = await w.message("DEBUG_OPEN_FIRST_TASK");
  const receipt = page.replies.find(({ type }) => type === "DEBUG_OPEN_FIRST_COMMENT_TASK").reply;
  assert.equal(receipt.ok, true);
  assert.equal(receipt.claimActionAttempted, false);
  assert.equal(result.ok, true);
  assert.equal(w.state().running, true);
  assert.equal(w.state().stage, "task_detail_opened");
  assert.equal(w.state().uncertainAction, undefined);
  assert.equal(page.fixture.clicks, 0);
});

test("step 02 can continue after its invitation click and successful detail receipt", { timeout: 3000 }, async () => {
  const w = await worker(), page = invitationMarketplace(w, { invitation: true });
  Object.assign(w.state(), { mode: "debug", stage: "debug_ready" });
  const result = await w.message("DEBUG_OPEN_FIRST_TASK");
  const receipt = page.replies.find(({ type }) => type === "DEBUG_OPEN_FIRST_COMMENT_TASK").reply;
  assert.equal(page.fixture.clicks, 1);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.claimActionAttempted, true);
  assert.equal(result.ok, true, "a successful invitation detail receipt must not strand step 02 as an unknown action");
  assert.equal(w.state().running, true);
  assert.equal(w.state().stage, "task_detail_opened");
  assert.equal(w.state().uncertainAction, undefined);
});

test("an invitation click followed by a DOM error stays unknown and cannot click twice", { timeout: 3000 }, async () => {
  const w = await worker(), page = invitationMarketplace(w, { invitation: true, failAfterClick: true });
  Object.assign(w.state(), { mode: "debug", stage: "debug_ready" });
  const result = await w.message("DEBUG_OPEN_FIRST_TASK");
  const receipt = page.replies.find(({ type }) => type === "DEBUG_OPEN_FIRST_COMMENT_TASK").reply;
  assert.equal(page.fixture.clicks, 1);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.claimActionAttempted, true);
  assert.equal(result.ok, false);
  assert.equal(w.state().running, false);
  assert.equal(w.state().stage, "action_result_unknown");
  const intent = w.state().uncertainAction;
  assert.equal(intent.type, "DEBUG_OPEN_FIRST_COMMENT_TASK");
  assert.deepEqual(clone(w.stored[stateKey].uncertainAction), clone(intent));
  assert.equal((await w.message("DEBUG_OPEN_FIRST_TASK")).ok, false);
  assert.equal(w.state().uncertainAction, intent);
  assert.equal(page.fixture.clicks, 1, "takeover cannot repeat an invitation whose click outcome is unknown");
});
