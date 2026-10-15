"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const TARGET = "https://x.com/fixture/status/123";
const OTHER = "https://x.com/other/status/456";
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const lighthouse = { id: 11, windowId: 1, status: "complete", url: "https://app.lhdao.top/campaigns" };

// Run the complete worker with inert Chrome boundaries and a deterministic
// clock. Queries model committed-URL filtering so pendingUrl bugs are visible.
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
    storage: { local: { async setAccessLevel() {},
      async get(keys) { return Object.fromEntries(keys.map(key => [key, clone(stored[key])])); },
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
          && (!query.url || /^https:\/\/(?:x|twitter)\.com\//.test(tab.url || "")));
        await hooks.query?.();
        return clone(result);
      },
      async create(options) {
        created.push(clone(options));
        const tab = { id: 100 + created.length, windowId: 1, status: "loading",
          url: "about:blank", pendingUrl: options.url, openerTabId: options.openerTabId };
        tabs.set(tab.id, tab);
        hooks.created(tab);
        await hooks.create?.(tab);
        return clone(tab);
      },
      async update(id) { return clone(tabs.get(id)); },
      async sendMessage(id, message) { sent.push({ id, ...clone(message) }); return { ok: true }; },
    },
  };
  const c = vm.createContext({ chrome, console, URL, Date: Clock, AbortController, importScripts() {},
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timers.add(timer); return timer; }, clearTimeout,
    fetch: async () => { throw new Error("Network forbidden in X adoption tests"); },
  });
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  for (const file of ["reply-engine.js", "background.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../src", file), "utf8"), c);
  }
  await vm.runInContext("runtimeStateReady", c);
  Object.assign(c, { ensureLighthouseAlertBridge: async () => {}, publishLighthouseMonitorSnapshot() {},
    log: (level, message) => logs.push({ level, message }),
    delay: async ms => { now += ms; await hooks.delay?.(now); },
  });
  vm.runInContext(`Object.assign(runtimeState, { running: true, runId: "adoption-run", mode: "auto",
    lighthouseTabId: 11, lighthouseWindowId: 1, runtimeWindowId: 1,
    currentTask: { taskKey: "current-order", seatLocked: true, tweetUrl: "${TARGET}" } })`, c);
  const state = () => vm.runInContext("runtimeState", c);
  c.beginXOpenWatch(11, "auto");
  return { c, hooks, tabs, created, sent, logs, state, now: () => now,
    add(tab) { tabs.set(tab.id, clone(tab)); hooks.created(clone(tab)); },
    update(tab) { tabs.set(tab.id, clone(tab)); hooks.updated(tab.id, { url: tab.url }, clone(tab)); },
    open: () => c.openDirectTweetTabIfAvailable(state().currentTask, 11, { allowAwaitingXTabAdoption: true }),
    wait: () => c.waitForLighthouseOpenedTweet(state().currentTask, 11, "auto", { timeoutMs: 10000, manualOpenAfterMs: 1000 }),
  };
}

for (const [name, tab] of [
  ["normal site tab", { openerTabId: 11, url: TARGET, status: "complete", lastAccessed: 1000000 }],
  ["noopener tab", { url: TARGET, status: "complete", lastAccessed: 1000000 }],
  ["already-open exact target", { url: TARGET, status: "complete", lastAccessed: 800000 }],
  ["uncommitted pending URL", { url: "about:blank", pendingUrl: TARGET, status: "loading" }],
]) {
  test(`${name} is reused without creating a second X tab`, async t => {
    const w = await worker(t, [{ id: 21, windowId: 1, ...tab }]);
    assert.equal(await w.open(), 21);
    assert.equal(w.created.length, 0);
    assert.equal(w.state().xTabId, 21);
    assert.equal(w.state().currentTask.tweetUrl, TARGET);
  });
}

test("exact target is reused even after the old watch was cleared", async t => {
  const w = await worker(t, [{ id: 21, windowId: 1, url: TARGET, status: "complete" }]);
  w.c.clearXOpenWatch();
  assert.equal(await w.open(), 21);
  assert.equal(w.created.length, 0);
});

test("a bound tab loading the exact pending URL is not forgotten", async t => {
  const w = await worker(t, [{ id: 21, windowId: 1, url: "about:blank", pendingUrl: TARGET, status: "loading" }]);
  w.state().xTabId = 21;
  assert.equal((await w.c.getBoundMatchingTaskXTab(TARGET)).id, 21);
  assert.equal(w.state().xTabId, 21);
});

test("the normal wait adopts an existing noopener tab and never clicks the detail fallback", async t => {
  const w = await worker(t, [{ id: 21, windowId: 1, url: TARGET, status: "complete" }]);
  assert.equal(await w.wait(), true);
  assert.equal(w.state().xTabId, 21);
  assert.equal(w.created.length, 0);
  assert.equal(w.sent.some(message => message.type === "OPEN_CURRENT_DETAIL_TWEET_TARGET"), false);
  assert.equal(w.logs.some(entry => /未自动打开|官网未跳转/.test(entry.message)), false);
});

for (const name of ["different target", "other window"]) {
  test(`${name} is never mistaken for the current target`, async t => {
    const w = await worker(t, [{ id: 21, windowId: name === "other window" ? 2 : 1,
      url: name === "different target" ? OTHER : TARGET, openerTabId: 11, status: "complete" }]);
    assert.equal(await w.open(), 101);
    assert.equal(w.created.length, 1);
    assert.equal(w.created[0].url, TARGET);
    assert.equal(w.created[0].windowId, 1);
  });
}

test("unknown target never adopts an arbitrary X page or creates a fallback", async t => {
  const w = await worker(t, [{ id: 21, windowId: 1, url: TARGET, openerTabId: 11 }]);
  w.state().currentTask.tweetUrl = "";
  assert.equal(await w.open(), null);
  assert.equal(w.created.length, 0);
  assert.equal(w.state().xTabId, null);
});

test("a matching tab navigating away is not adopted from its old committed URL", async t => {
  const w = await worker(t, [{ id: 21, windowId: 1, url: TARGET, pendingUrl: OTHER,
    openerTabId: 11, status: "loading", lastAccessed: 1000000 }]);
  assert.equal(await w.c.findRecentTweetTab(w.now(), 11, 1, TARGET), null);
});

test("a later navigation event invalidates a queued matching URL", async t => {
  const w = await worker(t);
  w.add({ id: 21, windowId: 1, url: TARGET, openerTabId: 11, status: "complete" });
  w.update({ id: 21, windowId: 1, url: OTHER, openerTabId: 11, status: "complete" });
  assert.equal(w.c.consumeXOpenCandidate(11, TARGET), null);
});

test("a loading-only event invalidates the old target before its new URL commits", async t => {
  const w = await worker(t);
  w.add({ id: 21, windowId: 1, url: TARGET, status: "complete" });
  const navigating = { id: 21, windowId: 1, url: TARGET, pendingUrl: OTHER, status: "loading" };
  w.tabs.set(21, navigating);
  w.hooks.updated(21, { status: "loading" }, navigating);
  assert.equal(w.c.consumeXOpenCandidate(11, TARGET), null);
});

test("concurrent and repeated fallback requests create only one still-loading tab", async t => {
  const w = await worker(t);
  const results = await Promise.all([w.open(), w.open()]);
  assert.deepEqual(results, [101, 101]);
  assert.equal(await w.open(), 101);
  assert.equal(w.created.length, 1);
});

test("a site tab recorded while the final query is pending wins over fallback creation", async t => {
  const w = await worker(t);
  let injected = false;
  w.hooks.query = () => {
    if (injected) return;
    injected = true;
    w.add({ id: 21, windowId: 1, url: TARGET, openerTabId: 11, status: "complete" });
  };
  assert.equal(await w.open(), 21);
  assert.equal(w.created.length, 0);
});

test("STOP while the reuse query is pending cannot create or bind a tab", async t => {
  const w = await worker(t);
  w.hooks.query = () => { w.state().running = false; w.state().manuallyStopped = true; };
  assert.equal(await w.open(), null);
  assert.equal(w.created.length, 0);
  assert.equal(w.state().xTabId, null);
});

test("captured target recovery waits for the site's delayed navigation before creating a fallback", async t => {
  const w = await worker(t);
  w.add({ id: 21, windowId: 1, openerTabId: 11, url: "about:blank", status: "loading" });
  w.hooks.delay = now => {
    if (now >= 1003000) w.update({ id: 21, windowId: 1, url: TARGET, status: "complete" });
  };
  assert.equal(await w.c.recoverPendingXOpenFromCapturedUrl(TARGET), 21);
  assert.equal(w.created.length, 0);
});

for (const openerTabId of [11, undefined]) {
  test(`a new blank tab still navigating (opener=${openerTabId}) prevents fallback creation and another detail click`, async t => {
    const w = await worker(t);
    w.add({ id: 21, windowId: 1, openerTabId, url: "about:blank", status: "loading" });
    assert.equal(await w.wait(), false, "an unknown destination is not success");
    assert.equal(await w.open(), null, "timeout does not prove the site's tab was absent");
    assert.equal(w.created.length, 0);
    assert.equal(w.sent.some(message => message.type === "OPEN_CURRENT_DETAIL_TWEET_TARGET"), false);
  });
}

test("a tab that appears during captured recovery's final query is reported as reused", async t => {
  const w = await worker(t);
  w.hooks.query = () => {
    if (w.now() >= 1005000 && !w.tabs.has(21)) {
      w.add({ id: 21, windowId: 1, openerTabId: 11, url: TARGET, status: "complete" });
    }
  };
  assert.equal(await w.c.recoverPendingXOpenFromCapturedUrl(TARGET), 21);
  assert.equal(w.created.length, 0);
  assert.equal(w.logs.some(entry => /已只创建一次|已兜底打开/.test(entry.message)), false);
});

for (const kind of ["new navigation", "concurrent adoption"]) {
  test(`${kind} during fallback lookup prevents a second detail-button click`, async t => {
    const w = await worker(t);
    let fallbackQueries = 0;
    w.hooks.query = () => {
      if (w.now() < 1001000 || ++fallbackQueries !== 4) return;
      w.add({ id: 21, windowId: 1, url: kind === "new navigation" ? "about:blank" : TARGET,
        status: kind === "new navigation" ? "loading" : "complete" });
      if (kind === "concurrent adoption") {
        w.state().xTabId = 21;
        w.state().currentTask = { ...w.state().currentTask, xOpenSource: "site" };
      }
    };
    assert.equal(await w.wait(), kind === "concurrent adoption");
    assert.equal(w.created.length, 0);
    assert.equal(w.sent.some(message => message.type === "OPEN_CURRENT_DETAIL_TWEET_TARGET"), false);
  });
}
