"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = process.env.LIGHTHOUSE_TEST_SOURCE_ROOT || path.join(__dirname, "../src");
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const target = "https://x.com/fixture/status/123";

function page(kind, options = {}) {
  const sent = [], listeners = [], timers = new Map(), observers = [], events = {}, speech = [];
  let timerId = 0, now = 10000, clicks = 0, cancelledSpeech = 0;
  const status = options.status || Promise.resolve({ ok: true, paused: Boolean(options.paused), enabled: true });
  class Clock extends Date { static now() { return now; } }
  class Element {
    constructor(text = "") { this.innerText = text; this.textContent = text; this.classList = { contains: () => false }; this.isConnected = true; }
    getBoundingClientRect() { return { width: 100, height: 40, top: 100, left: 100 }; }
    getAttribute() { return ""; }
    querySelectorAll() { return []; }
    querySelector() { return null; }
    closest() { return this; }
    scrollIntoView() {}
    click() { clicks++; }
  }
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.active = false; observers.push(this); }
    observe() { this.active = true; }
    disconnect() { this.active = false; }
  }
  const body = new Element("任务广场");
  const storage = new Map([["__lh_seen_tasks__", JSON.stringify(["old-task"])]]);
  const c = vm.createContext({ console: { log() {}, warn() {}, error() {} }, URL, Date: Clock, Element, MutationObserver,
    fixtureClaim: options.claimHandler,
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    document: { body, hidden: false, querySelectorAll: () => [], querySelector: () => null,
      createTreeWalker: () => ({ nextNode: () => false }), addEventListener: (name, fn) => { events[name] = fn; } },
    location: kind === "x" ? { href: target, pathname: "/fixture/status/123" } : { href: "https://app.lhdao.top/campaigns", pathname: "/campaigns", origin: "https://app.lhdao.top" },
    window: { innerWidth: 1400, innerHeight: 1000, addEventListener: (name, fn) => { events[name] = fn; } },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    speechSynthesis: { getVoices: () => [], speak: (utterance) => speech.push(utterance), cancel: () => { cancelledSpeech++; } },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms, interval: true }); return id; },
    clearInterval: (id) => timers.delete(id),
    fetch: async () => { throw Error("Network forbidden"); },
    chrome: { runtime: { onMessage: { addListener(fn) { listeners.push(fn); } }, sendMessage(message) {
      sent.push(message);
      if (["GET_CONTENT_SETTINGS", "MONITOR_GET_STATUS", "MONITOR_MIGRATE_SETTINGS"].includes(message.type)) return status;
      return Promise.resolve({ ok: true });
    } } }
  });
  const file = kind === "monitor" ? "lighthouse-monitor" : kind;
  const source = fs.readFileSync(path.join(root, `content/${file}.js`), "utf8");
  const end = source.lastIndexOf("})();");
  const hooks = kind === "x" ? `globalThis.testApi = { executeXStep, clickElement, wait,
    seed() { stepResults.set("old", Promise.resolve({ok:true})); cachedTaskWidgetControls = {}; lastTaskWidgetKey = "old"; },
    snapshot() { return { cached: stepResults.size, controls: cachedTaskWidgetControls, key: lastTaskWidgetKey }; } };`
    : kind === "lighthouse" ? `globalThis.testApi = { clickElement, wait, report,
      seed() { settledClaimOperations.set("old", {}); completionContext = {runId:"old",taskKey:"old"}; activeRunId = "old"; },
      snapshot() { return { cached: settledClaimOperations.size, completion: completionContext,
        claimRun: claimOperation?.runId || null, settledRuns: [...settledClaimOperations.values()].map((operation) => operation.runId) }; } };
      if (fixtureClaim) debugOpenFirstCommentTask = fixtureClaim;`
    : `globalThis.testApi = { syncCountdowns, scanForHighBounty, enqueueSpeech, collectCountdownSnapshot,
      seed() { lastCountdownData = [{taskKey:"old"}]; lastSyncAt = 1; },
      snapshot() { return { seen: seenTasks.size, cached: lastCountdownData.length, speech: speechQueue.length }; } };`;
  vm.runInContext(source.slice(0, end) + hooks + source.slice(end), c);
  const dispatch = (message) => {
    let response;
    const replies = [];
    for (const listener of listeners) listener(message, {}, (value) => { response = value; replies.push(value); });
    return { replies, response: () => response };
  };
  const fireTimers = async () => {
    for (let round = 0; round < 24 && timers.size; round++) {
    const pending = [...timers];
    for (const [id, timer] of pending) {
      if (!timers.has(id)) continue;
      if (!timer.interval) timers.delete(id);
      now += timer.ms || 1; timer.fn(); await flush();
    }
    }
  };
  return { c, api: c.testApi, sent, timers, observers, events, speech, storage, dispatch, fireTimers,
    clicks: () => clicks, cancelledSpeech: () => cancelledSpeech, button: new Element("验证"),
    pause: (paused) => dispatch({ type: "AUTOMATION_PAUSE_CHANGED", paused }) };
}

for (const kind of ["lighthouse", "x", "monitor"]) {
  test(`${kind}: STOP pause clears run caches and explicit resume is acknowledged`, async () => {
    const p = page(kind); await flush(); p.api.seed();
    const stopped = p.pause(true); await flush();
    assert.equal(stopped.response()?.ok, true);
    const snapshot = p.api.snapshot();
    assert.equal(snapshot.cached, 0);
    if (kind === "lighthouse") assert.equal(snapshot.completion, null);
    if (kind === "x") { assert.equal(snapshot.controls, null); assert.equal(snapshot.key, ""); }
    if (kind === "monitor") assert.equal(snapshot.seen, 0);
    assert.equal(p.pause(false).response()?.ok, true);
  });
}

for (const kind of ["x", "monitor"]) {
  test(`${kind}: fresh stopped page checks persisted pause before starting observers or timers`, async () => {
    const status = deferred(), p = page(kind, { status: status.promise });
    assert.equal(p.observers.filter((o) => o.active).length, 0);
    assert.equal(p.timers.size, 0);
    status.resolve({ ok: true, paused: true, enabled: true }); await flush();
    assert.equal(p.observers.filter((o) => o.active).length, 0);
    assert.equal(p.timers.size, 0);
    assert.ok(p.sent.some((m) => ["GET_CONTENT_SETTINGS", "MONITOR_GET_STATUS"].includes(m.type)));
  });
  test(`${kind}: late startup response cannot undo a STOP broadcast`, async () => {
    const status = deferred(), p = page(kind, { status: status.promise });
    p.pause(true);
    status.resolve({ ok: true, paused: false, enabled: true }); await flush();
    assert.equal(p.observers.filter((o) => o.active).length, 0);
    assert.equal(p.timers.size, 0);
  });
  test(`${kind}: stopping disconnects existing observers and timers until explicit resume`, async () => {
    const p = page(kind); await flush();
    assert.ok(p.observers.some((o) => o.active));
    const staleCallbacks = [...p.timers.values()].map((timer) => timer.fn);
    p.pause(true); await flush(); const count = p.sent.length;
    for (const callback of staleCallbacks) callback();
    p.events.pageshow?.(); p.events.visibilitychange?.(); await flush();
    assert.equal(p.observers.filter((o) => o.active).length, 0);
    assert.equal(p.timers.size, 0);
    assert.equal(p.sent.length, count);
    p.pause(false); await flush();
    assert.ok(p.observers.some((o) => o.active));
  });
}

test("Lighthouse suppresses page events and content logs while paused", async () => {
  const p = page("lighthouse"); await flush(); p.api.seed(); p.pause(true);
  const count = p.sent.length;
  p.api.report("info", "late");
  p.events["lighthouse-target-tweet-url"]({ detail: { tweetUrl: target } });
  p.events["lighthouse-unverified-link-alert-dismissed"]();
  await flush(); assert.equal(p.sent.length, count);
});

for (const kind of ["lighthouse", "x"]) {
  test(`${kind}: an in-flight delayed click is cancelled and new direct clicks stay blocked`, async () => {
    const p = page(kind); await flush();
    const pending = p.api.clickElement(p.button).then(() => ({ok:true}), () => ({ok:false}));
    p.pause(true); await p.fireTimers();
    assert.equal((await pending).ok, false);
    await assert.rejects(p.api.clickElement(p.button, {randomDelay:false}));
    assert.equal(p.clicks(), 0);
  });
}

test("X cannot replay a cancelled run after explicit resume", async () => {
  const p = page("x"); await flush();
  const message = {type:"COMPLETE_X_TASK_WIDGET",runId:"old",platform:"lighthouse",task:{taskKey:"order",tweetUrl:target}};
  const first = p.api.executeXStep(message, () => p.api.clickElement(p.button)); await flush();
  p.pause(true); await p.fireTimers(); assert.equal((await first).ok, false);
  p.pause(false); await flush();
  const replay = await p.api.executeXStep(message, () => p.api.clickElement(p.button, {randomDelay:false}));
  assert.equal(replay.ok, false);
  assert.equal(p.clicks(), 0);
});

test("monitor STOP clears queued speech and stale speech callbacks cannot continue it", async () => {
  const p = page("monitor"); await flush();
  p.api.enqueueSpeech("one"); p.api.enqueueSpeech("two");
  const first = p.speech[0]; assert.ok(first);
  p.pause(true); const count = p.sent.length;
  first.onend(); p.api.enqueueSpeech("late"); p.api.syncCountdowns({force:true});
  assert.equal(p.api.snapshot().speech, 0);
  assert.equal(p.speech.length, 1);
  assert.ok(p.cancelledSpeech() > 0);
  assert.equal(p.sent.length, count);
});

for (const kind of ["lighthouse", "x", "monitor"]) {
  test(`${kind}: paused cancellation applies the same pause and cache reset atomically`, async () => {
    const p = page(kind); await flush(); p.api.seed();
    p.dispatch({ type: kind === "x" ? "CANCEL_X_RUN" : "CANCEL_LIGHTHOUSE_RUN", runId: "old", paused: true });
    await flush();
    assert.equal(p.api.snapshot().cached, 0);
    assert.equal(p.observers.filter((o) => o.active).length, 0);
    if (kind !== "monitor") await assert.rejects(p.api.clickElement(p.button, {randomDelay:false}));
    else {
      const count = p.sent.length;
      p.api.syncCountdowns({force:true});
      assert.equal(p.sent.length, count);
    }
  });
}

test("monitor STOP cancels an in-flight snapshot retry without leaving a helper timer", async () => {
  const p = page("monitor"); await flush();
  const pending = p.api.collectCountdownSnapshot({force:true,allowRetry:true});
  p.pause(true); await flush(); await p.fireTimers();
  const result = await pending;
  assert.equal(result.paused, true);
  assert.equal(result.tasks.length, 0);
  assert.equal(p.timers.size, 0);
});

test("monitor stale utterance callback cannot advance a newer speech queue after resume", async () => {
  const p = page("monitor"); await flush();
  p.api.enqueueSpeech("old"); const old = p.speech[0];
  p.pause(true); p.pause(false); await flush();
  p.api.enqueueSpeech("new"); p.api.enqueueSpeech("queued new");
  old.onend();
  assert.equal(p.speech.length, 2);
  assert.equal(p.api.snapshot().speech, 1);
});

test("a newly loaded Lighthouse page rejects old work when persisted pause is true", async () => {
  const p = page("lighthouse", {paused:true}); await flush();
  const reply = p.dispatch({type:"BEGIN_LIGHTHOUSE_COMPLETION_WATCH",runId:"old",task:{taskKey:"old"}});
  await flush();
  assert.equal(reply.response()?.cancelled, true);
  assert.equal(p.api.snapshot().completion, null);
});

test("explicit STOP releases the old claim slot and its late finally cannot release a new claim", async () => {
  const old = deferred(), next = deferred(), calls = [];
  // Keep the real listener, claim slot, pause, cancellation, and receipt logic.
  // The handler boundary controls page latency without performing a DOM click.
  const p = page("lighthouse", {claimHandler: (_settings, message) => {
    calls.push(message.runId); return message.runId === "old" ? old.promise : next.promise;
  }});
  await flush();
  const type = "DEBUG_OPEN_FIRST_COMMENT_TASK";
  const oldReply = p.dispatch({type,runId:"old",claimIntentId:"old-intent"});
  await flush();
  assert.deepEqual(calls, ["old"]);
  const cancelled = p.dispatch({type:"CANCEL_LIGHTHOUSE_RUN",runId:"old",paused:true});
  await flush(); assert.equal(cancelled.response()?.ok, true);
  p.pause(false);
  const newReply = p.dispatch({type,runId:"new",claimIntentId:"new-intent"});
  await flush();
  try {
    assert.deepEqual(calls, ["old", "new"], "the first explicit restart must enter its own claim handler");
    assert.notEqual(newReply.response()?.conflict, true);
    old.resolve({ok:true,task:{taskKey:"old-task"}}); await flush();
    assert.equal(oldReply.response()?.cancelled, true);
    assert.equal(p.api.snapshot().claimRun, "new", "old finally must leave the replacement operation intact");
    assert.equal(p.api.snapshot().settledRuns.includes("old"), false);
    const duplicate = p.dispatch({type,runId:"new",claimIntentId:"new-intent"});
    await flush(); assert.equal(calls.length, 2);
    next.resolve({ok:true,task:{taskKey:"new-task"}}); await flush();
    assert.equal(newReply.response()?.ok, true);
    assert.equal(duplicate.response()?.ok, true);
    assert.equal(p.api.snapshot().claimRun, null);
  } finally {
    old.resolve({ok:false}); next.resolve({ok:false}); await flush();
  }
});

test("ordinary cancellation retains the pending claim slot until its proof settles", async () => {
  const pending = deferred();
  const p = page("lighthouse", {claimHandler: () => pending.promise}); await flush();
  const type = "DEBUG_OPEN_FIRST_COMMENT_TASK";
  p.dispatch({type,runId:"old",claimIntentId:"proof-intent"}); await flush();
  const cancellation = p.dispatch({type:"CANCEL_LIGHTHOUSE_RUN",runId:"old",expectedOperationType:type,claimIntentId:"proof-intent"});
  await flush();
  assert.equal(p.api.snapshot().claimRun, "old");
  const blocked = p.dispatch({type,runId:"new",claimIntentId:"new-intent"}); await flush();
  assert.equal(blocked.response()?.conflict, true);
  pending.resolve({ok:false}); await flush();
  assert.equal(cancellation.response()?.cancellationProof?.settled, true);
  assert.equal(cancellation.response()?.cancellationProof?.claimActionAttempted, false);
  assert.equal(cancellation.response()?.cancellationProof?.claimIntentId, "proof-intent");
});
