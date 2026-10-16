"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const STATE_KEY = "lighthouseAutoRunStateV1";
const KEEPALIVE = "lighthouseAutoRunKeepaliveV1";
const IDLE_RELOAD = "lighthouseCampaignsIdleReloadV1";
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const lockedTask = { taskKey: "locked-order", claimed: true, seatLocked: true, tweetUrl: "https://x.com/example/status/123" };
const uncertainAction = { type: "RUN_X_REPLY", taskKey: lockedTask.taskKey, runId: "saved-run", tabId: 12 };

function savedStorage(extra = {}) {
  return {
    [STATE_KEY]: {
      running: false, mode: "idle", stage: "stopped", runId: "saved-run",
      currentTask: clone(lockedTask), lighthouseTabId: 11, xTabId: 12,
      runtimeWindowId: 1, lighthouseWindowId: 1,
      pendingVerifications: [{ taskKey: "pending-order" }],
      logs: [{ at: "2026-10-13T14:31:16.000Z", level: "warn", text: "已停止运行" }],
      ...clone(extra),
    },
    replyHistoryRecords: [{ taskKey: "historic-order", createdAt: "2026-10-01T00:00:00.000Z" }],
  };
}

async function boot(t, stored, beforeWrite = null) {
  const event = { addListener() {} };
  const calls = { runStateWrites: [], alarmsCreated: [], alarmsCleared: [], browser: [], scans: [] };
  const timers = new Set();
  const tab = (id) => ({ id, windowId: 1, status: "complete", url: id === 12 ? lockedTask.tweetUrl : "https://app.lhdao.top/campaigns" });
  const chrome = {
    runtime: {
      id: "test", getURL: (value) => `chrome-extension://test/${value}`,
      getManifest: () => ({ version: "test" }), onInstalled: event, onMessage: event,
      async getPlatformInfo() { calls.browser.push({ type: "getPlatformInfo" }); return { os: "mac" }; },
    },
    storage: { local: {
      async setAccessLevel() {},
      async get(keys) { return Object.fromEntries(keys.map((key) => [key, clone(stored[key])])); },
      async set(values, callback) {
        await beforeWrite?.(values, callback);
        if (Object.hasOwn(values, STATE_KEY)) calls.runStateWrites.push(clone(values[STATE_KEY]));
        Object.assign(stored, clone(values));
        callback?.();
      },
    } },
    alarms: {
      onAlarm: event,
      async create(name, options) { calls.alarmsCreated.push({ name, options: clone(options) }); },
      async clear(name) { calls.alarmsCleared.push(name); return true; },
    },
    windows: { async get(id) { calls.browser.push({ type: "getWindow", id }); return { id }; } },
    tabs: {
      onCreated: event, onUpdated: event, onRemoved: event,
      async get(id) { calls.browser.push({ type: "getTab", id }); return tab(id); },
      async query(options) { calls.browser.push({ type: "queryTabs", options: clone(options) }); return [tab(11)]; },
      async create(options) { calls.browser.push({ type: "createTab", options: clone(options) }); return tab(21); },
      async update(id, options) { calls.browser.push({ type: "updateTab", id, options: clone(options) }); return tab(id); },
      async reload(id) { calls.browser.push({ type: "reloadTab", id }); },
      async sendMessage(id, payload) { calls.browser.push({ type: "sendMessage", id, payload: clone(payload) }); return { ok: true }; },
    },
    scripting: { async executeScript(options) { calls.browser.push({ type: "executeScript", options: clone(options) }); return []; } },
  };
  const context = vm.createContext({
    chrome, console, URL, AbortController, importScripts() {},
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timer.unref(); timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
    fetch: async () => { throw new Error("No network in stopped-state restoration tests"); },
  });
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  for (const file of ["reply-engine.js", "background.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../src", file), "utf8"), context, { filename: file });
  }
  await vm.runInContext("runtimeStateReady", context);
  // Observe any attempted restart without actually scanning or claiming an order.
  context.startNextAutoTask = async (reason) => { calls.scans.push(reason); };
  const state = () => vm.runInContext("runtimeState", context);
  const message = (type) => context.handleMessage({ type, clientWindowId: 1 },
    { id: "test", url: "chrome-extension://test/src/debug/debug.html" });
  return { context, calls, state, message };
}

for (const uncertain of [false, true]) {
  test(`repeated stopped snapshot boots and GET_STATE do not append or persist run logs (uncertain=${uncertain})`, async (t) => {
    const stored = savedStorage({ mode: "auto", ...(uncertain ? { uncertainAction } : {}) });
    const original = clone(stored);
    for (let index = 0; index < 3; index += 1) {
      const worker = await boot(t, stored);
      assert.equal((await worker.message("GET_STATE")).ok, true);
      const state = clone(worker.state());
      assert.equal(state.running, false);
      assert.equal(state.mode, "idle");
      assert.equal(state.stage, "stopped");
      assert.equal(state.runId, original[STATE_KEY].runId);
      assert.deepEqual(state.currentTask, original[STATE_KEY].currentTask);
      assert.deepEqual(state.uncertainAction, original[STATE_KEY].uncertainAction);
      assert.deepEqual(state.pendingVerifications, original[STATE_KEY].pendingVerifications);
      assert.deepEqual(state.logs, original[STATE_KEY].logs);
      assert.deepEqual(stored[STATE_KEY], original[STATE_KEY]);
      assert.deepEqual(stored.replyHistoryRecords, original.replyHistoryRecords);
      assert.equal(worker.calls.runStateWrites.length, 0);
      assert.deepEqual(worker.calls.alarmsCreated, []);
      assert.deepEqual(worker.calls.browser, []);
      assert.deepEqual(worker.calls.scans, []);
    }
  });
}

for (const scenario of [
  { name: "interrupted auto run", mode: "auto", uncertain: false, mayResume: true },
  { name: "interrupted auto run with uncertain action", mode: "auto", uncertain: true, mayResume: false },
  { name: "interrupted selected run", mode: "selected_once", uncertain: false, mayResume: false },
]) {
  test(`${scenario.name} preserves the existing restoration warning and keepalive rule`, async (t) => {
    const stored = savedStorage({ running: true, mode: scenario.mode, ...(scenario.uncertain ? { uncertainAction } : {}) });
    const original = clone(stored);
    const worker = await boot(t, stored);
    const state = clone(worker.state());
    assert.equal(state.running, false);
    assert.equal(state.mode, "idle");
    assert.equal(state.stage, scenario.mayResume ? "interrupted_not_resumed" : "stopped");
    assert.equal(state.runId, original[STATE_KEY].runId);
    assert.deepEqual(state.currentTask, original[STATE_KEY].currentTask);
    assert.deepEqual(state.uncertainAction, original[STATE_KEY].uncertainAction);
    assert.deepEqual(state.logs.slice(1), original[STATE_KEY].logs);
    assert.equal(state.logs[0].level, "warn");
    assert.equal(state.logs[0].text, scenario.mayResume
      ? "Chrome 后台恢复了中断的 Lighthouse 状态，等待保活闹钟自动续跑（先核对订单）"
      : "已恢复 Lighthouse 订单记录，保持停止状态");
    assert.equal(worker.calls.runStateWrites.length, 1);
    assert.deepEqual(worker.calls.alarmsCreated, scenario.mayResume
      ? [{ name: KEEPALIVE, options: { delayInMinutes: 0.5, periodInMinutes: 0.5 } }] : []);
    assert.deepEqual(stored.replyHistoryRecords, original.replyHistoryRecords);
    assert.deepEqual(worker.calls.browser, []);
    assert.deepEqual(worker.calls.scans, []);
  });
}

test("STOP_RUN followed by reboot and keepalive retains the stop without starting any action", async (t) => {
  const stored = savedStorage();
  const worker = await boot(t, stored);
  Object.assign(worker.state(), { running: true, mode: "auto", stage: "running_x_reply", scheduledResumeAt: Date.now() + 60000 });
  assert.equal((await worker.message("STOP_RUN")).ok, true);
  assert.deepEqual(worker.calls.browser.filter((call) => call.type === "sendMessage").map(({ id, payload }) => [id, payload.type, payload.runId]), [
    [11, "CANCEL_LIGHTHOUSE_RUN", "saved-run"], [12, "CANCEL_X_RUN", "saved-run"],
  ]);
  const stopped = clone(stored[STATE_KEY]);
  const history = clone(stored.replyHistoryRecords);
  assert.equal(stopped.running, false);
  assert.equal(stopped.stage, "stopped");
  assert.equal(stopped.scheduledResumeAt, 0);
  assert.notEqual(stopped.runId, "saved-run");
  assert.equal(stopped.logs[0].text, "已停止运行");
  assert.deepEqual(worker.calls.alarmsCleared, [KEEPALIVE, IDLE_RELOAD]);

  const rebooted = await boot(t, stored);
  await rebooted.context.handleAutoRunKeepaliveTick();
  assert.equal(rebooted.state().running, false);
  assert.equal(rebooted.state().stage, "stopped");
  assert.equal(rebooted.state().runId, stopped.runId);
  assert.deepEqual(clone(rebooted.state().currentTask), stopped.currentTask);
  assert.deepEqual(clone(rebooted.state().logs), stopped.logs);
  assert.deepEqual(stored[STATE_KEY], stopped);
  assert.deepEqual(stored.replyHistoryRecords, history);
  assert.equal(rebooted.calls.runStateWrites.length, 0);
  assert.deepEqual(rebooted.calls.alarmsCreated, []);
  assert.deepEqual(rebooted.calls.alarmsCleared, [KEEPALIVE, IDLE_RELOAD]);
  assert.deepEqual(rebooted.calls.browser, []);
  assert.deepEqual(rebooted.calls.scans, []);
});

const safeScanIntent = {type:"START_LIGHTHOUSE_COMMENT_TASK", runId:"saved-run", tabId:11,
  intentId:"intent-id", checkpointRequired:true, checkpointVersion:1, contentInstanceId:"page-id", claimActionAttempted:false};
test("worker restart revokes a proven no-click scan and resumes it once", async t => {
  const stored = savedStorage({running:true, mode:"auto", stage:"selecting_task", currentTask:null, xTabId:null, uncertainAction:safeScanIntent});
  const w = await boot(t,stored);
  assert.equal(w.state().stage,"interrupted_not_resumed");
  assert.equal(w.state().uncertainAction,undefined);
  assert.equal(stored[STATE_KEY].uncertainAction,undefined);
  const late = await w.context.handleMessage({type:"LIGHTHOUSE_CLAIM_CHECKPOINT",version:1,phase:"before_click",
    runId:"saved-run",operationType:safeScanIntent.type,claimIntentId:"intent-id",instanceId:"page-id"},{tab:{id:11},frameId:0});
  assert.equal(late.ok,false);
  await w.context.handleAutoRunKeepaliveTick();
  assert.equal(w.state().running,true);
  assert.equal(w.calls.scans.length,1);
});
for (const change of [
  {claimActionAttempted:true},{checkpointVersion:0},{checkpointRequired:false},{contentInstanceId:""},
  {runId:"another-run"},{tabId:99},{intentId:""}
]) test(`restart keeps unsafe or unbound claim intents protected: ${JSON.stringify(change)}`,async t=>{
  const intent={...safeScanIntent,...change};
  const w=await boot(t,savedStorage({running:true,mode:"auto",currentTask:null,uncertainAction:intent}));
  await w.context.handleAutoRunKeepaliveTick();
  assert.equal(w.state().running,false);assert.deepEqual(clone(w.state().uncertainAction),intent);
  assert.equal(w.calls.scans.length,0);
});
for (const extra of [{currentTask:lockedTask},{lastXResult:{ok:true}},{completionEvidence:{taskKey:"order",runId:"saved-run"}},{manuallyStopped:true},{running:false}]) {
  test(`checkpoint does not release protected or stopped state: ${JSON.stringify(extra)}`,async t=>{
    const w=await boot(t,savedStorage({running:true,mode:"auto",currentTask:null,uncertainAction:safeScanIntent,...extra}));
    await w.context.handleAutoRunKeepaliveTick();
    assert.equal(w.state().running,false);assert.equal(w.calls.scans.length,0);
  });
}

for (const counted of [false,true]) test(`restart finishes a confirmed order exactly once (alreadyCounted=${counted})`,async t=>{
  const stored=savedStorage({running:true,mode:"auto",stage:"campaigns_returned",completed:counted?4:3,
    currentTask:{...lockedTask,completionCounted:counted}, completionEvidence:{runId:"saved-run",taskKey:lockedTask.taskKey,officialCompletion:true}});
  const w=await boot(t,stored);
  w.context.closeLighthouseDetailToCampaigns=async()=>true;
  w.context.reloadLighthouseCampaignsAfterOrder=async()=>true;
  w.context.delay=async()=>{};
  await w.context.handleAutoRunKeepaliveTick();
  assert.equal(w.state().completed,4);
  assert.equal(w.state().currentTask,null);
  assert.equal(w.state().completionEvidence,null);
  assert.deepEqual(w.calls.scans,["after_success"]);
  assert.equal(w.calls.browser.some(x=>x.type==="sendMessage"&&x.payload.type==="RUN_X_REPLY"),false);
});
for (const extra of [{currentTask:{taskKey:"claimed-only",claimed:true}}, {currentTask:null,lastXResult:{ok:true}},
  {completionEvidence:{runId:"different",taskKey:lockedTask.taskKey}},
  {completionEvidence:{runId:"saved-run",taskKey:"different"}}]) {
  test(`restart cannot discard an unfinished or mismatched order: ${JSON.stringify(extra)}`,async t=>{
    const w=await boot(t,savedStorage({running:true,mode:"auto",...extra}));
    await w.context.handleAutoRunKeepaliveTick();
    assert.equal(w.state().running,false);assert.equal(w.calls.scans.length,0);
  });
}

test("failed durable revocation keeps a restarted no-click scan stopped",async t=>{
  const stored=savedStorage({running:true,mode:"auto",currentTask:null,uncertainAction:safeScanIntent});
  const w=await boot(t,stored,(values,callback)=>{
    if(!callback&&values[STATE_KEY]&&!values[STATE_KEY].uncertainAction)throw Error("storage unavailable");
  });
  await w.context.handleAutoRunKeepaliveTick();
  assert.equal(w.state().running,false);assert.equal(w.state().stage,"stopped");
  assert.deepEqual(clone(w.state().uncertainAction),safeScanIntent);assert.equal(w.calls.scans.length,0);
});
