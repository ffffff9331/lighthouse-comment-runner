"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const sourceRoot = process.env.LIGHTHOUSE_TEST_SOURCE_ROOT || path.join(__dirname, "../src");
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const lighthouse = { id: 11, windowId: 1, active: true, status: "complete", url: "https://app.lhdao.top/campaigns" };
const xTab = id => ({ id, windowId: 1, status: "complete", url: `https://x.com/example/status/${id}` });
const event = { addListener() {} };

async function worker(t) {
  const stored = {}, effects = [], hooks = {}, timers = new Set();
  const chrome = {
    runtime: { id: "test", getURL: p => `chrome-extension://test/${p}`, getManifest: () => ({ version: "test" }),
      onInstalled: event, onMessage: event, async sendMessage(message) { effects.push({ type: "runtimeMessage", message: clone(message) }); return { ok: true }; } },
    storage: { local: { async setAccessLevel() {}, async get(keys) { return Object.fromEntries(keys.map(k => [k, stored[k]])); },
      async set(values, callback) { Object.assign(stored, clone(values)); callback?.(); } } },
    alarms: { onAlarm: event, async create(name) { effects.push({ type: "alarmCreate", name }); }, async clear(name) { effects.push({ type: "alarmClear", name }); } },
    tabs: {
      onCreated: event, onUpdated: event, onRemoved: event,
      async get(id) { effects.push({ type: "get", id }); return hooks.get ? hooks.get(id) : id === 11 ? { ...lighthouse } : xTab(id); },
      async query(query) { effects.push({ type: "query", query: clone(query) }); return hooks.query ? hooks.query(query) : [{ ...lighthouse }]; },
      async update(id, properties) { effects.push({ type: "update", id, properties: clone(properties) }); return hooks.update ? hooks.update(id, properties) : id === 11 ? { ...lighthouse } : xTab(id); },
      async create(properties) { effects.push({ type: "create", properties: clone(properties) }); return { ...lighthouse }; },
      async remove(id) { effects.push({ type: "remove", id }); if (hooks.remove) return hooks.remove(id); },
      async sendMessage(id, message) { effects.push({ type: "tabMessage", id, message: clone(message) }); return { ok: true }; },
    },
    scripting: { async executeScript() { return []; } },
  };
  const c = vm.createContext({ chrome, console, URL, AbortController, importScripts() {},
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timer.unref(); timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); }, fetch: async () => { throw Error("No network in close race tests"); } });
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  for (const file of ["reply-engine.js", "background.js"]) vm.runInContext(fs.readFileSync(path.join(sourceRoot, file), "utf8"), c);
  await vm.runInContext("runtimeStateReady", c); await flush();
  stored.settings = clone(vm.runInContext("normalizeSettings(DEFAULT_SETTINGS)", c));
  vm.runInContext(`Object.assign(runtimeState, { running: true, mode: "debug", stage: "old-debug", runId: "old-run", lighthouseTabId: 11, lighthouseWindowId: 1, runtimeWindowId: 1, xTabId: 12, xTabWindowId: 1 })`, c);
  c.startNextAutoTask = async () => { effects.push({ type: "scan" }); return { ok: true }; };
  c.waitForTabComplete = async () => true;
  c.waitForTabClosed = async id => hooks.closed ? hooks.closed(id) : true;
  c.delay = async () => {};
  const state = () => vm.runInContext("runtimeState", c);
  const message = type => c.handleMessage({ type, clientWindowId: 1 }, { id: "test", url: "chrome-extension://test/src/debug/debug.html" });
  const interrupt = async restart => {
    assert.equal((await message("STOP_RUN")).ok, true);
    if (restart) {
      assert.equal((await message("START_RUN")).ok, true);
      // Represent the next run having already adopted its own X task tab.
      Object.assign(state(), { xTabId: 13, xTabWindowId: 1, currentTask: { taskKey: "new-order", tweetUrl: xTab(13).url } });
      await c.persistAutoRunState(true);
    }
    await flush();
    return { state: clone(state()), effects: clone(effects), persisted: clone(stored.lighthouseAutoRunStateV1) };
  };
  return { c, hooks, effects, stored, state, message, interrupt };
}

for (const boundary of ["X tab lookup", "X tab removal"]) {
  for (const restart of [false, true]) {
    test(`closeRecordedXTab: rejected ${boundary} after ${restart ? "STOP and restart" : "STOP"} cannot log into current state`, { timeout: 3000 }, async t => {
      const w = await worker(t), entered = deferred(), release = deferred();
      t.after(() => release.resolve());
      let intercepted = false;
      const lateFailure = async () => {
        intercepted = true;
        entered.resolve();
        await release.promise;
        throw new Error("old close browser failure");
      };
      if (boundary === "X tab lookup") {
        w.hooks.get = id => id === 12 && !intercepted ? lateFailure() : id === 11 ? { ...lighthouse } : xTab(id);
      } else {
        w.hooks.remove = id => id === 12 && !intercepted ? lateFailure() : undefined;
      }
      const pending = w.message("DEBUG_CLOSE_X_RETURN_LIGHTHOUSE");
      await entered.promise;
      const snapshot = await w.interrupt(restart);
      release.resolve();
      const result = await pending;
      await flush();
      assert.equal(result.ok, false);
      assert.equal(result.cancelled, true);
      assert.deepEqual(clone(w.state()), snapshot.state, "late browser failure must not append an old close error");
      assert.deepEqual(clone(w.effects), snapshot.effects);
      assert.deepEqual(w.stored.lighthouseAutoRunStateV1, snapshot.persisted);
    });
  }
}

test("current DEBUG_CLOSE_X_RETURN_LIGHTHOUSE closes its X tab and returns to Lighthouse", async t => {
  const w = await worker(t);
  const result = await w.message("DEBUG_CLOSE_X_RETURN_LIGHTHOUSE");
  assert.equal(result.ok, true);
  assert.equal(w.state().stage, "returned_lighthouse");
  assert.equal(w.state().xTabId, null);
  assert.deepEqual(w.effects.filter(e => e.type === "remove").map(e => e.id), [12]);
  assert.ok(w.effects.some(e => e.type === "update" && e.id === 11));
});

for (const boundary of ["lighthouse lookup", "active X lookup", "close confirmation", "return focus"]) {
  for (const restart of [false, true]) {
    test(`DEBUG_CLOSE_X_RETURN_LIGHTHOUSE: late ${boundary} after ${restart ? "STOP and restart" : "STOP"} cannot touch current tabs or state`, { timeout: 3000 }, async t => {
      const w = await worker(t), entered = deferred(), release = deferred();
      t.after(() => release.resolve());
      let intercepted = false;
      const pause = async value => { intercepted = true; entered.resolve(); await release.promise; return value; };
      if (boundary === "lighthouse lookup") {
        w.hooks.get = id => id === 11 && !intercepted ? pause({ ...lighthouse }) : id === 11 ? { ...lighthouse } : xTab(id);
      } else if (boundary === "active X lookup") {
        w.state().xTabId = null;
        w.hooks.query = query => query.active && !intercepted ? pause([xTab(12)]) : [{ ...lighthouse }];
      } else if (boundary === "close confirmation") {
        w.hooks.closed = () => pause(true);
      } else {
        w.hooks.update = id => id === 11 && !intercepted ? pause({ ...lighthouse }) : id === 11 ? { ...lighthouse } : xTab(id);
      }
      const pending = w.message("DEBUG_CLOSE_X_RETURN_LIGHTHOUSE");
      await entered.promise;
      const snapshot = await w.interrupt(restart);
      release.resolve();
      const result = await pending;
      await flush();
      assert.equal(result.ok, false, "a cancelled close must not report success");
      assert.equal(result.cancelled, true);
      assert.deepEqual(clone(w.state()), snapshot.state, "old close must not refill or overwrite current runtime");
      assert.deepEqual(clone(w.effects), snapshot.effects, "old close must not close new tabs or focus Lighthouse after STOP");
      assert.deepEqual(w.stored.lighthouseAutoRunStateV1, snapshot.persisted);
    });
  }
}
