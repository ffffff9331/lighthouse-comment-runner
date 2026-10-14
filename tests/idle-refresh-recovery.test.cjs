"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Set LIGHTHOUSE_TEST_SOURCE_ROOT to compare the same regression against an
// older checkout. The test never writes production files or contacts a site.
const sourceRoot = process.env.LIGHTHOUSE_TEST_SOURCE_ROOT || path.join(__dirname, "../src");
const read = (file) => fs.readFileSync(path.join(sourceRoot, file), "utf8");
const clone = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => {let resolve; const promise = new Promise((r) => {resolve = r;}); return {promise, resolve};};
const event = {addListener() {}};
const noNetwork = async () => {throw Error("Network forbidden in idle recovery tests");};
const stateKey = "lighthouseAutoRunStateV1";
const safeRefresh = () => ({ok: false, refreshRequested: true, transient: true,
  claimActionAttempted: false, message: "任务广场连续 5 分钟没有可执行任务，请求刷新", task: {taskKey: "unclaimed"}});

async function worker(options = {}) {
  let now = 1000000;
  class Clock extends Date {constructor(...args) {super(...(args.length ? args : [now]));} static now() {return now;}}
  const stored = {}, sent = [], reloads = [], adopted = [], hooks = {};
  const firstSent = deferred();
  let scanCount = 0;
  const chrome = {
    runtime: {id: "test", getURL: (p) => `chrome-extension://test/${p}`, getManifest: () => ({version: "test"}),
      getPlatformInfo: async () => ({}), onInstalled: event, onMessage: event},
    storage: {local: {setAccessLevel: async () => {},
      async get(keys) {return Object.fromEntries(keys.map((key) => [key, stored[key]]));},
      async set(values, callback) {
        const snapshot = clone(values);
        if (!callback && stored[stateKey]?.uncertainAction && snapshot[stateKey] && !snapshot[stateKey].uncertainAction) {
          await hooks.onIntentClear?.();
        }
        Object.assign(stored, snapshot);
        callback?.();
      }}},
    alarms: {onAlarm: event, create: async () => {}, clear: async () => {}},
    tabs: {onCreated: event, onUpdated: event, onRemoved: event,
      async update(id) {return {id, windowId: 1};},
      async reload(id) {reloads.push(id); await hooks.onReload?.();},
      async sendMessage(id, message) {
        sent.push(clone(message));
        if (message.type === "START_LIGHTHOUSE_COMMENT_TASK") {
          scanCount++;
          if (scanCount === 1) {firstSent.resolve(); return hooks.firstResponse ? hooks.firstResponse(message) : safeRefresh();}
          return {ok: true, claimActionAttempted: true, task: {taskKey: "next-claimed", seatLocked: true, seatLockedAt: new Clock().toISOString()}};
        }
        if (message.type === "CANCEL_LIGHTHOUSE_RUN") {await hooks.onCancel?.(message); return {ok: true};}
        if (message.type.startsWith("CANCEL_") || message.type === "BEGIN_LIGHTHOUSE_COMPLETION_WATCH") return {ok: true};
        if (message.type === "CLOSE_LIGHTHOUSE_TASK_DETAIL") return {ok: true, message: "已关闭详情"};
        throw Error("Unexpected Chrome message: " + message.type);
      }}
  };
  const c = vm.createContext({chrome, Date: Clock, URL, AbortController, console, importScripts() {}, clearTimeout,
    setTimeout: (fn, ms) => {const timer = setTimeout(fn, ms); timer.unref(); return timer;}, fetch: noNetwork});
  for (const file of ["reply-engine.js", "background.js"]) vm.runInContext(read(file), c, {filename: file});
  await vm.runInContext("runtimeStateReady", c);
  Object.assign(c, {
    publishLighthouseMonitorSnapshot() {}, ensureLighthouseAlertBridge: async () => {},
    getOrCreateLighthouseTab: async () => ({id: 11, windowId: 1, url: "https://app.lhdao.top/campaigns"}),
    rememberLighthouseTabById: async () => {}, focusLighthouseTabForAutoScan: async () => true,
    waitForTabComplete: async () => true, delay: async () => {},
    adoptTargetOpenedTweet: async (task) => {adopted.push(clone(task)); return {ok: true};}
  });
  vm.runInContext('Object.assign(runtimeState, {running:true, mode:"auto", stage:"campaigns_returned", runId:"scan-run", lighthouseTabId:11, lighthouseWindowId:1, runtimeWindowId:1})', c);
  if (options.old) vm.runInContext("runtimeState.lastProgressAt = Date.now() - 300001", c);
  return {c, chrome, stored, sent, reloads, adopted, hooks, firstSent, Clock,
    now: () => now, advance: (ms) => {now += ms;}, state: () => vm.runInContext("runtimeState", c),
    scan: () => c.startNextAutoTask("test_idle_refresh"),
    stop: () => c.handleMessage({type: "STOP_RUN", clientWindowId: 1}, {id: "test", url: "chrome-extension://test/src/debug/debug.html"})};
}

function coldMarketplaceContent(w, afterWait) {
  let listener, waited = 0;
  const replies = [];
  const c = vm.createContext({Date: w.Clock, URL, console, setTimeout, clearTimeout, fetch: noNetwork,
    window: {addEventListener() {}}, document: {body: {innerText: "任务广场 冷却中 20m"}},
    location: {href: "https://app.lhdao.top/campaigns", pathname: "/campaigns"},
    fixtureWait: async (ms) => {
      waited += ms; w.advance(ms);
      await afterWait?.(waited);
      if (waited > 301000) throw Error("Fixture exceeded five-minute refresh boundary");
    },
    chrome: {runtime: {onMessage: {addListener(fn) {listener = fn;}},
      sendMessage: (message) => w.c.handleMessage(message, {tab: {id: 11, windowId: 1}})}}
  });
  const adapters = `
    ensureCampaignsPage = async () => {};
    confirmPagePhase = async () => {};
    ensureAllTaskFilter = async () => {};
    waitForCampaignsReady = async () => {};
    isTaskDetailOrRecoverableOverlayOpen = () => false;
    isCampaignsListOpen = () => true;
    getLiveAutoMinTaskBounty = async () => 0.1;
    collectTaskCandidates = () => [{taskKey:"cooling-task", target:{}, isAutomatable:true, isBlocked:false,
      cooldownMs:1200000, bounty:0.2, attempted:false}];
    hasDetailRequestTimeout = () => false;
    getLighthousePageSnapshot = () => ({phase:"campaigns", path:"/campaigns"});
    buildTask = () => ({taskKey:"cooling-task", seatLocked:false});
    wait = fixtureWait;
  `;
  const source = read("content/lighthouse.js"), end = source.lastIndexOf("})();");
  vm.runInContext(source.slice(0, end) + adapters + source.slice(end), c);
  return {replies, waited: () => waited,
    dispatch: (message) => new Promise((resolve) => {
      assert.equal(listener(message, {}, (result) => {replies.push(clone(result)); resolve(result);}), true);
    })};
}

const cancellers = (w) => w.sent.filter((message) => message.type.startsWith("CANCEL_"));
const scans = (w) => w.sent.filter((message) => message.type === "START_LIGHTHOUSE_COMMENT_TASK");
function replaceWithNewRun(w) {
  vm.runInContext('runtimeState = {...createInitialState(), running:true, mode:"auto", stage:"new_run_owned", runId:"new-run", lighthouseTabId:11, runtimeWindowId:1, marketplaceRefreshInFlight:true, uncertainAction:{type:"RUN_X_REPLY",runId:"new-run",taskKey:"new-task"}}', w.c);
  return clone(w.state());
}

test("real content cooling loop returns a safe five-minute receipt, reloads once and resumes scanning", {timeout: 3000}, async () => {
  const w = await worker();
  let alarmChecked = false;
  const page = coldMarketplaceContent(w, async (waited) => {
    if (waited >= 300000 && !alarmChecked) {alarmChecked = true; await w.c.handleAutoRunKeepaliveTick();}
  });
  w.hooks.firstResponse = page.dispatch;
  w.hooks.onCancel = page.dispatch;
  await w.scan();
  assert.equal(page.replies[0].ok, false);
  assert.equal(page.replies[0].refreshRequested, true);
  assert.equal(page.replies[0].claimActionAttempted, false);
  assert.ok(page.waited() >= 300000 && page.waited() <= 301000);
  assert.equal(cancellers(w).length, 0);
  assert.equal(w.reloads.length, 1);
  assert.equal(scans(w).length, 2);
  assert.equal(w.adopted.length, 1);
  assert.equal(w.state().running, true);
  assert.equal(w.state().uncertainAction, undefined);
  assert.equal(w.state().runId, "scan-run");
});

test("watchdog cannot cancel a pending claim-capable scan or erase its intent", {timeout: 3000}, async () => {
  const w = await worker({old: true}), pending = deferred();
  w.hooks.firstResponse = () => pending.promise;
  const flow = w.scan();
  await w.firstSent.promise;
  const intent = w.state().uncertainAction;
  try {
    await w.c.handleAutoRunKeepaliveTick();
    assert.equal(w.state().running, true);
    assert.equal(w.state().runId, "scan-run");
    assert.equal(w.state().uncertainAction, intent);
    assert.equal(cancellers(w).length, 0);
    assert.equal(w.reloads.length, 0);
  } finally {pending.resolve(safeRefresh()); await flow;}
});

test("intent clearing owns the refresh lock before awaiting persistent storage", {timeout: 3000}, async () => {
  const w = await worker({old: true}), entered = deferred(), release = deferred();
  let intercepted = false;
  w.hooks.onIntentClear = async () => {
    if (intercepted) return;
    intercepted = true; entered.resolve(); await release.promise;
  };
  const flow = w.scan();
  await entered.promise;
  try {
    assert.equal(w.state().uncertainAction, undefined);
    assert.equal(w.state().marketplaceRefreshInFlight, true);
    await w.c.handleAutoRunKeepaliveTick();
    assert.equal(w.state().running, true);
    assert.equal(cancellers(w).length, 0);
    assert.equal(w.reloads.length, 0);
  } finally {release.resolve(); await flow;}
  assert.equal(w.reloads.length, 1);
  assert.equal(scans(w).length, 2);
});

test("STOP during the refresh cannot resurrect scanning or overwrite the stopped stage", {timeout: 3000}, async () => {
  const w = await worker(), entered = deferred(), release = deferred();
  w.hooks.onReload = async () => {entered.resolve(); await release.promise;};
  const flow = w.scan();
  await entered.promise;
  await w.stop();
  const stopped = clone(w.state());
  release.resolve(); await flow;
  assert.equal(w.state().running, false);
  assert.equal(w.state().runId, stopped.runId);
  assert.equal(w.state().stage, "stopped");
  assert.equal(scans(w).length, 1);
  assert.equal(w.reloads.length, 1);
});

test("a late old refresh completion cannot mutate a new run or release its lock", {timeout: 3000}, async () => {
  const w = await worker(), entered = deferred(), release = deferred();
  w.hooks.onReload = async () => {entered.resolve(); await release.promise;};
  const flow = w.scan();
  await entered.promise;
  const fresh = replaceWithNewRun(w);
  // Bound the old implementation's faulty recursive retry after it has
  // already overwritten the new run; the final equality still exposes it.
  w.c.delay = async () => {
    if (w.state().runId === "new-run" && w.state().stage !== "new_run_owned") w.state().running = false;
  };
  release.resolve(); await flow;
  assert.deepEqual(clone(w.state()), fresh);
  assert.equal(scans(w).length, 1);
  assert.equal(w.reloads.length, 1);
});

test("a late safe receipt cannot clear a newer run's pending action or initiate a reload", {timeout: 3000}, async () => {
  const w = await worker(), pending = deferred();
  w.hooks.firstResponse = () => pending.promise;
  const flow = w.scan();
  await w.firstSent.promise;
  const fresh = replaceWithNewRun(w);
  pending.resolve(safeRefresh()); await flow;
  assert.deepEqual(clone(w.state()), fresh);
  assert.equal(w.reloads.length, 0);
});

test("a refresh request after a claim click preserves uncertainty and never reloads", async () => {
  const w = await worker({old: true});
  w.hooks.firstResponse = () => ({...safeRefresh(), claimActionAttempted: true});
  await w.scan();
  assert.equal(w.state().running, false);
  assert.equal(w.state().stage, "action_result_unknown");
  assert.ok(w.state().uncertainAction);
  await w.c.handleAutoRunKeepaliveTick();
  assert.equal(w.reloads.length, 0);
  assert.equal(cancellers(w).length, 0);
  assert.equal(scans(w).length, 1);
});

test("a claimed order without optional seat fields is protected from idle refresh", async () => {
  const w = await worker({old: true});
  Object.assign(w.state(), {currentTask: {taskKey: "claimed-only", claimed: true}, stage: "waiting_x_ready"});
  await w.c.handleAutoRunKeepaliveTick();
  assert.equal(w.state().running, true);
  assert.equal(w.state().runId, "scan-run");
  assert.equal(w.reloads.length, 0);
  assert.equal(cancellers(w).length, 0);
});

test("STOP during the fallback watchdog reload cannot restart the stopped run", {timeout: 3000}, async () => {
  const w = await worker({old: true}), entered = deferred(), release = deferred();
  let restarts = 0;
  const start = w.c.startAutoRun;
  w.c.startAutoRun = async (...args) => {restarts++; return start(...args);};
  w.hooks.onReload = async () => {entered.resolve(); await release.promise;};
  const tick = w.c.handleAutoRunKeepaliveTick();
  await entered.promise;
  await w.stop();
  const stopped = clone(w.state());
  release.resolve(); await tick;
  assert.equal(restarts, 0);
  assert.equal(w.state().running, false);
  assert.equal(w.state().stage, "stopped");
  assert.equal(w.state().runId, stopped.runId);
  assert.equal(scans(w).length, 0);
});

test("fallback watchdog reports an explicit false restart result instead of silently stopping", async () => {
  const w = await worker({old: true});
  w.c.startAutoRun = async () => ({ok: false, error: "fixture restart refusal"});
  await w.c.handleAutoRunKeepaliveTick();
  assert.ok(w.state().logs.some((entry) => /fixture restart refusal/.test(entry.text)), "resolved ok:false needs a visible failure reason");
  assert.equal(w.state().running, false);
  assert.equal(w.reloads.length, 1);
});


test("idle fallback without interruption restarts one scan", {timeout: 3000}, async () => {
  const w = await worker({old: true});
  let restart, scansStarted = 0;
  const start = w.c.startAutoRun;
  w.c.startAutoRun = (...args) => (restart = start(...args));
  w.c.startNextAutoTask = async () => { scansStarted++; return {ok: true}; };
  await w.c.handleAutoRunKeepaliveTick();
  await restart;
  assert.equal(scansStarted, 1);
  assert.equal(w.reloads.length, 1);
  assert.equal(w.state().running, true);
  assert.equal(w.state().mode, "auto");
});

test("STOP before watchdog platform lookup returns prevents recovery", {timeout: 3000}, async () => {
  const w = await worker({old: true}), entered = deferred(), release = deferred();
  w.chrome.runtime.getPlatformInfo = async () => { entered.resolve(); await release.promise; return {}; };
  const tick = w.c.handleAutoRunKeepaliveTick();
  await entered.promise;
  assert.equal((await w.stop()).ok, true);
  const stopped = clone(w.state());
  release.resolve();
  await tick;
  assert.deepEqual(clone(w.state()), stopped);
  assert.equal(w.reloads.length, 0);
  assert.equal(scans(w).length, 0);
});

test("STOP during watchdog cancellation must take precedence over the automatic restart", {timeout:3000}, async () => {
  const w=await worker({old:true});
  const enteredWatch=deferred(), releaseWatch=deferred(), enteredStop=deferred(), releaseStop=deferred();
  let cancels=0, restarts=0;
  w.hooks.onCancel=async()=>{
    const cancellation=++cancels;
    if(cancellation===1){enteredWatch.resolve(); await releaseWatch.promise;}
    if(cancellation===2){enteredStop.resolve(); await releaseStop.promise;}
  };
  w.c.startNextAutoTask=async()=>{restarts++; return {ok:true};};
  const tick=w.c.handleAutoRunKeepaliveTick();
  await enteredWatch.promise;
  const stopping=w.stop();
  await enteredStop.promise;
  releaseWatch.resolve();
  await tick;
  releaseStop.resolve();
  const result=await stopping;
  await new Promise(setImmediate);
  assert.equal(result.ok,true,"the user STOP must finish successfully");
  assert.equal(restarts,0,"automatic recovery must not launch a new scan after STOP");
  assert.equal(w.state().running,false);
  assert.equal(w.state().stage,"stopped");
});
