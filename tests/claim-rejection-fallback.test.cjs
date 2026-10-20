"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const clone = value => JSON.parse(JSON.stringify(value));
const event = { addListener() {} };
const RUN = "rejection-fallback-run";
const task = {
  taskKey: "selected-order", selectionId: "selected-alias", stableTaskKey: "stable-alias",
  title: "Fixture order", bounty: 0.2, taskType: "评论",
  tweetUrl: "https://x.com/fixture/status/123", seatLocked: true,
  seatLockedAt: "2026-10-14T03:00:00.000Z",
};
const lighthouseTab = { id: 11, windowId: 1, url: "https://app.lhdao.top/campaigns", status: "complete" };
const xTab = { id: 77, windowId: 1, url: task.tweetUrl, status: "complete" };

// Keep the real adoption, wait, rejection-check, sendToTab and direct-opening
// functions. Browser adapters are inert and record every attempted X effect.
async function worker(t) {
  const sent = [], created = [], recovered = [], adopted = [], stored = {}, hooks = {};
  const timers = new Set();
  const chrome = {
    runtime: {
      id: "test", getURL: file => `chrome-extension://test/${file}`,
      getManifest: () => ({ version: "test" }), onInstalled: event, onMessage: event,
    },
    storage: { session: require("./session-fixture.cjs")(), local: {
      async setAccessLevel() {},
      async get(keys) { return Object.fromEntries(keys.map(key => [key, stored[key]])); },
      async set(values, callback) { Object.assign(stored, clone(values)); callback?.(); },
      async remove() {},
    } },
    alarms: { onAlarm: event, async create() {}, async clear() {} },
    tabs: {
      onCreated: event, onUpdated: event, onRemoved: event,
      async get(id) { return id === xTab.id ? xTab : lighthouseTab; },
      async query() { return [lighthouseTab]; },
      async update() { return lighthouseTab; },
      async create(properties) { created.push(clone(properties)); return xTab; },
      async sendMessage(tabId, message) {
        sent.push({ tabId, ...clone(message) });
        if (message.type === "CHECK_LIGHTHOUSE_LOCK_FAILURE") {
          return {
            ok: true, failed: true, message: "锁定失败：不可领取",
            task: { ...task, seatLocked: false, detailText: "Fixture order 0.2 LUX 不可领取" },
            claimRejection: {
              runId: RUN, taskKey: task.taskKey, seatLockedAt: task.seatLockedAt,
              claimIntentId: "fixture-intent",
            },
          };
        }
        return { ok: true };
      },
    },
  };
  const context = vm.createContext({
    chrome, console, URL, AbortController, importScripts() {},
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
    fetch: async () => { throw new Error("Network forbidden in rejection fallback tests"); },
  });
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  for (const file of ["reply-engine.js", "background.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "../src", file), "utf8");
    vm.runInContext(source, context, { filename: file });
  }
  await vm.runInContext("runtimeStateReady", context);
  Object.assign(context, {
    ensureLighthouseAlertBridge: async () => {},
    publishLighthouseMonitorSnapshot() {},
    rememberLighthouseTabById: async () => {},
    getLighthouseWindowId: async () => lighthouseTab.windowId,
    getBoundMatchingTaskXTab: async () => hooks.bound || null,
    consumeXOpenCandidate: () => hooks.candidate || null,
    findRecentTweetTab: async () => null,
    focusTaskXTab: async () => {},
    readPlazaTodayIncome: async () => 0,
    waitForXReadyBeforeReply: async () => true,
    handleXReplyResult: async () => ({ ok: true, replied: true }),
    recoverAndContinue: async (message, options) => {
      recovered.push({ message, options: clone(options) });
      return { ok: true, recovered: true };
    },
  });
  const originalAdopt = context.adoptCurrentXTab;
  context.adoptCurrentXTab = (...args) => { adopted.push(clone(args)); return originalAdopt(...args); };
  vm.runInContext(`Object.assign(runtimeState, {
    running: true, mode: "auto", stage: "seat_locked", runId: "${RUN}",
    lighthouseTabId: 11, lighthouseWindowId: 1, runtimeWindowId: 1
  })`, context);
  const state = () => vm.runInContext("runtimeState", context);
  state().currentTask = { ...task };
  return { c: context, state, sent, created, recovered, adopted, hooks };
}

test("a proven refusal returns to recovery without direct X fallback or RUN_X_REPLY", async t => {
  const w = await worker(t);
  let directCalls = 0;
  const originalDirect = w.c.openDirectTweetTabIfAvailable;
  w.c.openDirectTweetTabIfAvailable = (...args) => { directCalls++; return originalDirect(...args); };
  const result = await w.c.adoptTargetOpenedTweet({ ...task }, lighthouseTab.id, "auto");
  assert.ok(w.sent.some(message => message.type === "CHECK_LIGHTHOUSE_LOCK_FAILURE"), "exercise a real operation-bound refusal check");
  assert.deepEqual({
    directCalls,
    createdTabs: w.created.length,
    replyMessages: w.sent.filter(message => message.type === "RUN_X_REPLY").length,
    recoveryCalls: w.recovered.length,
  }, { directCalls: 0, createdTabs: 0, replyMessages: 0, recoveryCalls: 1 });
  assert.equal(result.recovered, true);
  assert.equal(w.recovered[0].options.task.claimRejected, true);
});

for (const flag of ["claimRejected", "lockFailed"]) {
  for (const mode of ["create", "bound", "site-candidate"]) {
    test(`${flag} prevents direct fallback from using a ${mode} X tab`, async t => {
      const w = await worker(t);
      const rejected = { ...task, seatLocked: false, seatLockedAt: null, [flag]: true };
      w.state().currentTask = rejected;
      if (mode === "bound") w.hooks.bound = xTab;
      if (mode === "site-candidate") {
        w.hooks.candidate = xTab;
        w.state().pendingXOpen = { lighthouseTabId: lighthouseTab.id, windowId: 1, startedAt: Date.now() };
      }
      const result = await w.c.openDirectTweetTabIfAvailable(rejected, lighthouseTab.id, {
        allowAwaitingXTabAdoption: true, source: "extension_fallback",
      });
      assert.deepEqual({
        result,
        createdTabs: w.created.length,
        adoptedTabs: w.adopted.length,
        xTabId: w.state().xTabId,
        replyMessages: w.sent.filter(message => message.type === "RUN_X_REPLY").length,
      }, { result: null, createdTabs: 0, adoptedTabs: 0, xTabId: null, replyMessages: 0 });
    });
  }
}

test("a refusal arriving during a direct-fallback await cannot create X from a stale task argument", async t => {
  const w = await worker(t);
  const optimistic = { ...task };
  let lookups = 0;
  w.c.getBoundMatchingTaskXTab = async () => {
    if (++lookups === 1) {
      w.state().currentTask = {
        ...optimistic, seatLocked: false, seatLockedAt: null,
        claimRejected: true, lockFailed: true,
      };
    }
    return null;
  };
  const result = await w.c.openDirectTweetTabIfAvailable(optimistic, lighthouseTab.id);
  assert.deepEqual({
    result, createdTabs: w.created.length, adoptedTabs: w.adopted.length,
    xTabId: w.state().xTabId,
  }, { result: null, createdTabs: 0, adoptedTabs: 0, xTabId: null });
});
