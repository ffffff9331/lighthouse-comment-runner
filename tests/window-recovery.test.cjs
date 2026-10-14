"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const stateKey = "lighthouseAutoRunStateV1";
const windowId = 1401307093;
const clone = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

async function worker({ exists = true, task = null } = {}) {
  const stored = { [stateKey]: {
    running: true, mode: "auto", runId: "old-run", currentTask: task,
    lighthouseTabId: 91, lighthouseWindowId: windowId, runtimeWindowId: windowId,
  } };
  const calls = { windows: [], queries: [], creates: [], messages: [], cleared: [] };
  const event = { addListener() {} };
  let alarm;
  const chrome = {
    runtime: {
      getURL: (file) => `chrome-extension://test/${file}`,
      getManifest: () => ({ version: "test" }),
      getPlatformInfo: async () => ({}), onInstalled: event, onMessage: event,
    },
    storage: { local: {
      async setAccessLevel() {},
      async get(keys) { return Object.fromEntries(keys.map((key) => [key, stored[key]])); },
      async set(values, callback) { Object.assign(stored, clone(values)); callback?.(); },
    } },
    alarms: {
      onAlarm: { addListener(fn) { alarm = fn; } }, async create() {},
      async clear(name) { calls.cleared.push(name); },
    },
    windows: { async get(id) {
      calls.windows.push(id);
      if (!exists) throw Error(`No window with id: ${id}.`);
      return { id };
    } },
    tabs: {
      onRemoved: event, onCreated: event, onUpdated: event,
      async get(id) { throw Error(`No tab with id: ${id}.`); },
      async query(query) {
        calls.queries.push(clone(query));
        if (!exists) throw Error(`No window with id: ${query.windowId}.`);
        return [];
      },
      async create(properties) { calls.creates.push(properties); throw Error("Must not create tabs in recovery tests"); },
      async sendMessage(id, payload) { calls.messages.push({ id, payload }); return { ok: true }; },
    },
  };
  const c = vm.createContext({
    chrome, console, URL, AbortController, importScripts() {}, clearTimeout,
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; },
    fetch: async () => { throw Error("Network must not run in recovery tests"); },
  });
  for (const file of ["reply-engine.js", "background.js"])
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../src", file), "utf8"), c);
  await vm.runInContext("runtimeStateReady", c);
  return { c, chrome, stored, calls, alarm, state: () => vm.runInContext("runtimeState", c) };
}

test("a live recorded window resumes the interrupted scan once", async () => {
  const w = await worker();
  let scans = 0;
  w.c.startNextAutoTask = async () => { scans++; };
  await w.c.handleAutoRunKeepaliveTick();
  assert.equal(scans, 1);
  assert.equal(w.state().running, true);
  assert.deepEqual(w.calls.windows, [windowId]);
  assert.equal(w.calls.cleared.length, 0);
});

test("a deleted recorded window stops recovery without querying another window or losing the task", async () => {
  const task = { taskKey: "candidate", seatLocked: false };
  const w = await worker({ exists: false, task });
  await assert.doesNotReject(() => w.c.handleAutoRunKeepaliveTick());
  assert.equal(w.state().running, false);
  assert.equal(w.state().stage, "runtime_window_missing");
  assert.deepEqual(clone(w.state().currentTask), task);
  assert.equal(w.stored[stateKey].stage, "runtime_window_missing");
  assert.equal(w.stored[stateKey].runId, "old-run");
  assert.equal(w.calls.queries.length, 0);
  assert.equal(w.calls.creates.length, 0);
  assert.equal(w.calls.messages.length, 0);
  assert.equal(w.calls.cleared.length, 2);
  await w.c.handleAutoRunKeepaliveTick();
  assert.deepEqual(w.calls.windows, [windowId]);
});

test("a window disappearing after validation stops recovery without an unhandled rejection", async () => {
  const w = await worker();
  w.chrome.tabs.query = async (query) => {
    w.calls.queries.push(query);
    throw Error(`No window with id: ${windowId}.`);
  };
  await assert.doesNotReject(() => w.c.handleAutoRunKeepaliveTick());
  assert.equal(w.state().running, false);
  assert.equal(w.state().stage, "runtime_window_missing");
  assert.equal(w.calls.creates.length, 0);
  assert.equal(w.calls.cleared.length, 2);
});

test("a locked unfinished order remains preserved without any recovery side effect", async () => {
  const task = { taskKey: "claimed", seatLocked: true, claimed: true };
  const w = await worker({ exists: false, task });
  await w.c.handleAutoRunKeepaliveTick();
  assert.equal(w.state().running, false);
  assert.deepEqual(clone(w.state().currentTask), task);
  assert.equal(w.calls.windows.length, 0);
  assert.equal(w.calls.queries.length, 0);
  assert.equal(w.calls.messages.length, 0);
});

for (const replacement of [false, true]) {
  test(`late missing-window failure cannot stop a newer run, replacement=${replacement}`, async () => {
    const w = await worker();
    const entered = deferred(), result = deferred();
    w.chrome.windows.get = () => { entered.resolve(); return result.promise; };
    const pending = w.c.handleAutoRunKeepaliveTick();
    await entered.promise;
    if (replacement) vm.runInContext('runtimeState = { ...runtimeState, runId: "new-run", running: true, mode: "debug", stage: "debug_takeover" };', w.c);
    else Object.assign(w.state(), { runId: "new-run", running: true, mode: "debug", stage: "debug_takeover" });
    result.reject(Error(`No window with id: ${windowId}.`));
    await pending;
    assert.equal(w.state().runId, "new-run");
    assert.equal(w.state().running, true);
    assert.equal(w.state().stage, "debug_takeover");
    assert.equal(w.calls.cleared.length, 0);
  });
}

test("stopping while the recorded window is being checked cannot resume the old run", async () => {
  const w = await worker();
  const entered = deferred(), result = deferred();
  w.chrome.windows.get = () => { entered.resolve(); return result.promise; };
  let scans = 0;
  w.c.startNextAutoTask = async () => { scans++; };
  const pending = w.c.handleAutoRunKeepaliveTick();
  await entered.promise;
  w.state().stage = "stopped";
  result.resolve({ id: windowId });
  await pending;
  assert.equal(scans, 0);
  assert.equal(w.state().running, false);
  assert.equal(w.state().stage, "stopped");
});

test("a generic browser failure is reported and stops recovery rather than silently continuing", async () => {
  const w = await worker();
  w.c.startNextAutoTask = async () => { throw Error("browser unavailable"); };
  await assert.doesNotReject(() => w.c.handleAutoRunKeepaliveTick());
  assert.equal(w.state().running, false);
  assert.equal(w.state().stage, "auto_resume_failed");
  assert.ok(w.state().logs.some((entry) => entry.text.includes("browser unavailable")));
  assert.equal(w.calls.cleared.length, 2);
});

test("two alarm ticks checking the same window resume only one scan", async () => {
  const w = await worker();
  const result = deferred();
  w.chrome.windows.get = () => result.promise;
  let scans = 0;
  w.c.startNextAutoTask = async () => { scans++; };
  const one = w.c.handleAutoRunKeepaliveTick(), two = w.c.handleAutoRunKeepaliveTick();
  result.resolve({ id: windowId });
  await Promise.all([one, two]);
  assert.equal(scans, 1);
  assert.equal(w.state().running, true);
});

test("the alarm event registers a rejection handler for unexpected failures", async () => {
  const w = await worker();
  let handlers = 0;
  w.c.handleAutoRunKeepaliveTick = () => ({ catch(handler) {
    handlers++;
    handler(Error("alarm failure"));
  } });
  w.alarm({ name: "lighthouseAutoRunKeepaliveV1" });
  assert.equal(handlers, 1);
  assert.ok(w.state().logs.some((entry) => entry.text.includes("alarm failure")));
});
