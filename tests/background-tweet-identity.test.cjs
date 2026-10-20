"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ID = "2111837370354167816";
const TARGET = `https://x.com/i/status/${ID}`;
const ALIAS = `https://x.com/lubihuangdai888/status/${ID}`;
const OTHER = "https://x.com/other/status/2111837370354167817";
const NOTICE = "CONFIRM_LIGHTHOUSE_LOCKED_TASK_NOTICE";
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const lighthouse = { id: 11, windowId: 1, status: "complete", url: "https://app.lhdao.top/campaigns" };

// The entire production worker runs with only Chrome and time boundaries
// replaced. No network, user pages, posting, or extension state is touched.
async function worker(t, initialTabs = []) {
  let now = 1000000;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const tabs = new Map([lighthouse, ...initialTabs].map(tab => [tab.id, clone(tab)]));
  const hooks = {}, created = [], sent = [], logs = [], stored = {}, timers = new Set();
  const event = { addListener() {} };
  const chrome = {
    runtime: { id: "test", getURL: value => `chrome-extension://test/${value}`,
      getManifest: () => ({ version: "test" }), onInstalled: event, onMessage: event },
    storage: { session: require("./session-fixture.cjs")(), local: { async setAccessLevel() {},
      async get(keys) { return Object.fromEntries(keys.filter(key => Object.hasOwn(stored, key)).map(key => [key, clone(stored[key])])); },
      async set(values, callback) { Object.assign(stored, clone(values)); callback?.(); },
    } },
    alarms: { onAlarm: event, async create() {}, async clear() {} },
    windows: { async get(id) { return { id }; }, async update(id) { return { id }; } },
    tabs: {
      onCreated: { addListener(fn) { hooks.created = fn; } },
      onUpdated: { addListener(fn) { hooks.updated = fn; } }, onRemoved: event,
      async get(id) { if (!tabs.has(id)) throw new Error("No tab"); return clone(tabs.get(id)); },
      async query(query) {
        const result = [...tabs.values()].filter(tab =>
          (!Number.isInteger(query.windowId) || tab.windowId === query.windowId)
          && (!query.active || tab.active === true)
          && (!query.url || /^https:\/\/(?:x|twitter)\.com\//.test(tab.url || "")));
        await hooks.query?.(query);
        return clone(result);
      },
      async create(properties) {
        created.push({ at: now, ...clone(properties) });
        const tab = { id: 100 + created.length, windowId: properties.windowId || 1,
          status: "loading", url: "about:blank", pendingUrl: properties.url, openerTabId: properties.openerTabId };
        tabs.set(tab.id, tab);
        hooks.created(tab);
        return clone(tab);
      },
      async update(id) { return clone(tabs.get(id)); },
      async sendMessage(id, message) {
        sent.push({ id, at: now, ...clone(message) });
        if (hooks.sendMessage) return hooks.sendMessage(id, message);
        return { ok: true };
      },
    },
  };
  const c = vm.createContext({ chrome, console, URL, Date: Clock, AbortController, importScripts() {},
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timers.add(timer); return timer; }, clearTimeout,
    fetch: async () => { throw new Error("Network forbidden in identity regression tests"); },
  });
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  for (const file of ["reply-engine.js", "background.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../src", file), "utf8"), c, { filename: file });
  }
  await vm.runInContext("runtimeStateReady", c);
  Object.assign(c, { ensureLighthouseAlertBridge: async () => {}, publishLighthouseMonitorSnapshot() {},
    log: (level, message) => logs.push({ level, message }),
    delay: async ms => { now += ms; await hooks.delay?.(now); },
  });
  vm.runInContext(`Object.assign(runtimeState, { running: true, runId: "identity-run", mode: "auto",
    lighthouseTabId: 11, lighthouseWindowId: 1, runtimeWindowId: 1,
    currentTask: { taskKey: "current-order", seatLocked: true, tweetUrl: "${TARGET}" } })`, c);
  const state = () => vm.runInContext("runtimeState", c);
  c.beginXOpenWatch(11, "auto");
  return { c, hooks, tabs, created, sent, logs, stored, state, now: () => now,
    add(tab) { tabs.set(tab.id, clone(tab)); hooks.created(clone(tab)); },
    open: () => c.openDirectTweetTabIfAvailable(state().currentTask, 11, { allowAwaitingXTabAdoption: true }),
    wait: options => c.waitForLighthouseOpenedTweet(state().currentTask, 11, "auto",
      { timeoutMs: 3500, manualOpenAfterMs: 1, ...options }),
  };
}

for (const [name, tab] of [
  ["existing author alias", { url: ALIAS, status: "complete" }],
  ["twitter author alias", { url: ALIAS.replace("x.com", "twitter.com"), status: "complete" }],
  ["pending author alias", { url: "about:blank", pendingUrl: ALIAS, status: "loading" }],
]) test(`${name} is reused without opening another tweet tab`, async t => {
  const w = await worker(t, [{ id: 21, windowId: 1, ...tab }]);
  assert.equal(await w.open(), 21);
  assert.equal(w.created.length, 0);
  assert.equal(w.state().xTabId, 21);
});

test("a queued author alias is consumed as this exact tweet", async t => {
  const w = await worker(t);
  w.add({ id: 21, windowId: 1, url: ALIAS, status: "complete", openerTabId: 11 });
  assert.equal(w.c.consumeXOpenCandidate(11, TARGET)?.id, 21);
  assert.equal(w.created.length, 0);
});

test("a recorded tab survives a same-ID author redirect", async t => {
  const w = await worker(t, [{ id: 21, windowId: 1, url: ALIAS, status: "complete" }]);
  w.state().xTabId = 21;
  assert.equal((await w.c.getBoundMatchingTaskXTab(TARGET))?.id, 21);
  assert.equal(w.state().xTabId, 21);
});

test("manual active-tab adoption accepts the current same-ID author alias", async t => {
  const w = await worker(t, [{ id: 21, windowId: 1, url: ALIAS, status: "complete", active: true }]);
  assert.equal(await w.c.resolveCurrentXTab({ allowActiveTweetTab: true }), 21);
  assert.equal(w.created.length, 0);
});

for (const [name, url, windowId] of [
  ["different ID", OTHER, 1],
  ["different window", ALIAS, 2],
  ["embedded target on an unrelated domain", `https://evil.example/?next=${TARGET}`, 1],
  ["X hostname suffix", `https://x.com.evil.example/i/status/${ID}`, 1],
  ["credentials", `https://evil.example@x.com/i/status/${ID}`, 1],
  ["invalid ID suffix", `${ALIAS}evil`, 1],
]) test(`${name} cannot be adopted for this tweet`, async t => {
  const w = await worker(t, [{ id: 21, windowId, url, status: "complete", active: true }]);
  w.state().xTabId = 21;
  assert.equal(await w.c.getBoundMatchingTaskXTab(TARGET), null);
  assert.equal(w.state().xTabId, null);
  assert.equal(await w.c.findRecentTweetTab(w.now(), 11, 1, TARGET), null);
  assert.equal(w.created.length, 0);
});

test("reply history recognizes a completed author alias for i/status", async t => {
  const w = await worker(t);
  w.stored.replyHistoryRecords = [{ id: "prior", tweetUrl: ALIAS, replyText: "Already posted" }];
  const result = await w.c.queryTweetReplyHistory({ url: TARGET });
  assert.equal(result.replied, true);
  assert.equal(result.record.id, "prior");
  assert.equal((await w.c.queryTweetReplyHistory({ url: OTHER })).replied, false);
});

test("completion evidence accepts the same ID alias but still binds run and task", async t => {
  const w = await worker(t);
  const evidence = { runId: "identity-run", taskKey: "current-order", tweetUrl: ALIAS, officialCompletion: true };
  assert.equal(w.c.latchLighthouseCompletion(evidence, "identity-run"), true);
  for (const change of [{ tweetUrl: OTHER }, { taskKey: "other-order" }, { runId: "old-run" }]) {
    assert.equal(w.c.latchLighthouseCompletion({ ...evidence, ...change }, "identity-run"), false);
  }
});

function noticeReceipt(message, fields = {}) {
  return { ok: true, noticePresent: true, noticeClicked: true, pending: false,
    runId: message.runId, taskKey: message.task.taskKey, tweetUrl: message.task.tweetUrl, ...fields };
}

test("a bound post-lock notice gets time to open its own tab before fallback", async t => {
  const w = await worker(t);
  let clickedAt = null;
  w.hooks.sendMessage = (_id, message) => {
    if (message.type !== NOTICE) return { ok: true };
    assert.equal(message.runId, "identity-run");
    assert.equal(message.task.taskKey, "current-order");
    assert.equal(message.task.tweetUrl, TARGET);
    assert.equal(message.task.seatLocked, true);
    if (w.now() < 1000500) return { ok: true, noticePresent: false };
    if (clickedAt === null) clickedAt = w.now();
    return noticeReceipt(message, { noticeClicked: w.now() === clickedAt });
  };
  w.hooks.delay = now => {
    if (clickedAt !== null && now - clickedAt >= 500 && !w.tabs.has(21)) {
      w.add({ id: 21, windowId: 1, url: ALIAS, status: "complete", openerTabId: 11 });
    }
  };
  assert.equal(await w.wait(), true);
  assert.notEqual(clickedAt, null, "the post-lock confirmation must actually be dispatched");
  assert.ok(w.now() - clickedAt >= 500);
  assert.equal(w.state().xTabId, 21);
  assert.equal(w.created.length, 0);
  assert.equal(w.sent.some(message => message.type === "OPEN_CURRENT_DETAIL_TWEET_TARGET"), false);
});

test("a notice mounted after multiple observation rounds is still confirmed", async t => {
  const w = await worker(t);
  let clicked = false;
  w.hooks.sendMessage = (_id, message) => {
    if (message.type !== NOTICE) return { ok: true };
    if (w.now() < 1001500) return { ok: true, noticePresent: false };
    clicked = true;
    w.add({ id: 21, windowId: 1, url: ALIAS, status: "complete", openerTabId: 11 });
    return noticeReceipt(message);
  };
  assert.equal(await w.wait({ manualOpenAfterMs: 3000 }), true);
  assert.equal(clicked, true);
  assert.ok(w.sent.filter(message => message.type === NOTICE).length >= 2);
  assert.equal(w.created.length, 0);
});

test("a same-order target capture during notice click does not cancel successful navigation", async t => {
  const w = await worker(t);
  let clicked = false;
  w.hooks.sendMessage = (_id, message) => {
    if (message.type !== NOTICE) return { ok: true };
    clicked = true;
    // The real LIGHTHOUSE_TARGET_TWEET_URL handler merges a new task object
    // when the official window.open bridge reports the post-confirmation URL.
    w.state().currentTask = w.c.mergeTaskPreservingCapturedTweetUrl(w.state().currentTask, null,
      { tweetUrl: ALIAS, targetUrlSource: "lighthouse_window_open" });
    w.add({ id: 21, windowId: 1, url: ALIAS, status: "complete", openerTabId: 11 });
    return noticeReceipt(message);
  };
  assert.equal(await w.wait(), true);
  assert.equal(clicked, true);
  assert.equal(w.state().currentTask.taskKey, "current-order");
  assert.equal(w.state().xTabId, 21);
  assert.equal(w.created.length, 0);
});

test("manual target navigation cannot bypass a pending reminder on an already locked order", async t => {
  const w = await worker(t);
  w.hooks.sendMessage = (_id, message) => message.type === NOTICE
    ? noticeReceipt(message, { pending: true, noticeClicked: false }) : { ok: true };
  let result;
  try { result = await w.c.ensureTweetTabAfterTargetClick(11, {}, w.state().currentTask, "debug"); }
  catch (_) { result = null; }
  assert.ok(w.sent.some(message => message.type === NOTICE), "an already locked order must check its reminder first");
  assert.equal(result, null);
  assert.equal(w.created.length, 0);
  assert.equal(w.sent.some(message => message.type === "OPEN_CURRENT_DETAIL_TWEET_TARGET"), false);
  assert.equal(w.state().currentTask.taskKey, "current-order");
  assert.equal(w.state().currentTask.seatLocked, true);
});

for (const [name, fields] of [
  ["not locked", { seatLocked: false }],
  ["rejected", { claimRejected: true }],
  ["lock failed", { lockFailed: true }],
]) test(`${name} task never authorizes the post-lock notice`, async t => {
  const w = await worker(t);
  Object.assign(w.state().currentTask, fields);
  try { await w.wait({ timeoutMs: 1000, manualOpenAfterMs: 0 }); } catch (_) {}
  assert.equal(w.sent.some(message => message.type === NOTICE), false);
});

for (const transition of ["STOP", "new task"]) test(`${transition} during notice confirmation prevents all later actions`, async t => {
  const w = await worker(t);
  let interruptedAt = -1;
  w.hooks.sendMessage = (_id, message) => {
    if (message.type !== NOTICE) return { ok: true };
    interruptedAt = w.sent.length;
    if (transition === "STOP") Object.assign(w.state(), { running: false, manuallyStopped: true });
    else w.state().currentTask = { taskKey: "new-order", tweetUrl: OTHER, seatLocked: true };
    return noticeReceipt(message);
  };
  let result;
  try { result = await w.wait(); } catch (_) { result = false; }
  assert.notEqual(interruptedAt, -1, "the fixture must reach the pending confirmation");
  assert.notEqual(result, true);
  assert.equal(w.created.length, 0);
  assert.equal(w.sent.length, interruptedAt, "a stale confirmation may not cause later page commands");
  if (transition === "new task") assert.equal(w.state().currentTask.taskKey, "new-order");
});

for (const [name, fields] of [
  ["failure", { ok: false }],
  ["pending confirmation", { pending: true, noticeClicked: false }],
  ["wrong task", { taskKey: "other-order" }],
  ["wrong tweet", { tweetUrl: OTHER }],
  ["wrong run", { runId: "old-run" }],
  ["unbound receipt", { taskKey: undefined, tweetUrl: undefined, runId: undefined }],
]) test(`${name} cannot be bypassed by opening a fallback X tab`, async t => {
  const w = await worker(t);
  w.hooks.sendMessage = (_id, message) => message.type === NOTICE
    ? noticeReceipt(message, fields) : { ok: true };
  let result;
  try { result = await w.wait({ timeoutMs: 2000 }); } catch (_) { result = false; }
  assert.ok(w.sent.some(message => message.type === NOTICE), "the confirmation must be checked");
  assert.notEqual(result, true);
  assert.equal(w.created.length, 0);
  assert.equal(w.sent.some(message => message.type === "OPEN_CURRENT_DETAIL_TWEET_TARGET"), false);
  assert.equal(w.state().currentTask.taskKey, "current-order");
  assert.equal(w.state().currentTask.seatLocked, true);
});

test("an unconfirmed reminder timeout leaves the locked order explicitly stopped", async t => {
  const w = await worker(t);
  w.hooks.sendMessage = (_id, message) => message.type === NOTICE
    ? noticeReceipt(message, { pending: true, noticeClicked: false }) : { ok: true };
  const taskBefore = clone(w.state().currentTask);
  const uncertainBefore = w.state().uncertainAction;
  await assert.rejects(w.wait({ timeoutMs: 1500 }), /提醒/);
  assert.equal(w.state().running, false, "a terminal wait must not leave the UI falsely running");
  assert.equal(w.state().stage, "locked_task_recovery_blocked");
  assert.deepEqual(clone(w.state().currentTask), taskBefore);
  assert.equal(w.state().uncertainAction, uncertainBefore);
  assert.equal(w.created.length, 0);
  assert.equal(w.sent.some(message => message.type.startsWith("CANCEL_") || message.type === "START_LIGHTHOUSE_COMMENT_TASK"), false);
});

test("a pending reminder deadline cannot stop a replacement task after its last wait", async t => {
  const w = await worker(t);
  w.hooks.sendMessage = (_id, message) => message.type === NOTICE
    ? noticeReceipt(message, { pending: true, noticeClicked: false }) : { ok: true };
  w.hooks.delay = () => {
    w.state().currentTask = { taskKey: "replacement-order", tweetUrl: OTHER, seatLocked: true };
    w.state().stage = "replacement_task_running";
  };
  let result;
  try { result = await w.wait({ timeoutMs: 500 }); } catch (_) { result = false; }
  assert.equal(result, false);
  assert.equal(w.state().currentTask.taskKey, "replacement-order");
  assert.equal(w.state().running, true, "the old notice deadline must not stop a new task in the same run");
  assert.equal(w.state().stage, "replacement_task_running");
  assert.equal(w.logs.some(entry => entry.level === "error"), false);
  assert.equal(w.created.length, 0);
});
