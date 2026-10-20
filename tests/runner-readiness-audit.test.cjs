"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Load fixture definitions only, before either source file registers tests.
// The real worker and content listeners execute unchanged; only Chrome's
// transport, storage, DOM and clock boundaries are supplied by the fixtures.
function fixture(file, boundary, exported) {
  const source = fs.readFileSync(path.join(__dirname, file), "utf8");
  const end = source.indexOf(boundary);
  assert.ok(end > 0, `Missing fixture boundary in ${file}`);
  const prefix = source.slice(0, end);
  assert.equal(/\btest\s*\(/.test(prefix), false, `Fixture extraction registered tests in ${file}`);
  return new Function("require", "__dirname", `${prefix}\nreturn ${exported};`)(require, __dirname);
}
const worker = fixture("invitation-refresh.test.cjs", "const reloadPaths =", "worker");
const page = fixture("invitation-popup.test.cjs", 'test("ordinary list selection', "page");
const sourceRoot = process.env.LIGHTHOUSE_TEST_SOURCE_ROOT || path.join(__dirname, "../src");
const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, "../manifest.json"), "utf8"));
const clone = value => JSON.parse(JSON.stringify(value));
const tab = { id: 11, windowId: 1, url: "https://app.lhdao.top/campaigns", status: "complete" };

async function connected(t, options) {
  const w = await worker(t);
  const p = page(options);
  const upstream = [];
  w.chrome.runtime.getManifest = () => manifest;
  w.chrome.tabs.sendMessage = async (id, message) => {
    assert.equal(id, tab.id);
    w.effects.push({ type: "message", id, message: clone(message) });
    return p.dispatch(message);
  };
  p.c.chrome.runtime.sendMessage = async message => {
    const result = await w.c.handleMessage(clone(message), { id: "test", tab, frameId: 0, url: tab.url });
    upstream.push({ message: clone(message), result: clone(result) });
    return result;
  };
  return { w, p, upstream };
}

for (const popup of [false, true]) {
  test(`real readiness and claim bridge completes ${popup ? "invitation" : "ordinary"} locking`, async t => {
    const { w, p, upstream } = await connected(t, { popup });
    assert.equal(w.state().uncertainAction, undefined);
    const result = await w.c.sendToTab(tab.id, {
      type: "START_LIGHTHOUSE_COMMENT_TASK", runId: w.state().runId,
      settings: { actionDelayMs: 150, cooldownPollMs: 250, lockSeatTimeoutMs: 5000, enableCooldownSniping: true }
    });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.task.seatLocked, true);
    assert.equal(result.task.tweetUrl, popup
      ? "https://x.com/invited/status/2110664701864444362"
      : "https://x.com/other/status/2110664701864444363");
    assert.equal(p.f.accept?.clicks || 0, popup ? 1 : 0);
    assert.equal(p.action.clicks, popup ? 0 : 1);
    assert.equal(p.f.lock.clicks, 1);
    const outbound = w.effects.filter(effect => effect.type === "message").map(effect => effect.message.type);
    assert.deepEqual(outbound, ["CHECK_LIGHTHOUSE_RUNNER_READY", "START_LIGHTHOUSE_COMMENT_TASK"]);
    const checkpoints = upstream.filter(entry => entry.message.type === "LIGHTHOUSE_CLAIM_CHECKPOINT");
    assert.equal(checkpoints[0].message.phase, "ready");
    assert.equal(checkpoints[0].result.checkpointRegistered, true);
    assert.equal(checkpoints.filter(entry => entry.result.permitClaimClick).length, popup ? 2 : 1);
    assert.equal(w.state().uncertainAction, undefined);
    assert.equal(w.stored.lighthouseAutoRunStateV1.uncertainAction, undefined);
    assert.equal(w.stored.lighthouseAutoRunStateV1.currentTask.tweetUrl, result.task.tweetUrl);
    assert.equal(w.stored.lighthouseAutoRunStateV1.currentTask.seatLocked, true);
  });
}

async function flushUntil(predicate) {
  for (let attempt = 0; attempt < 20 && !predicate(); attempt += 1) await new Promise(setImmediate);
  assert.equal(predicate(), true, "Expected asynchronous boundary was not reached");
}

test("unanswered readiness probes time out twice and never create a claim, including a late reply", async t => {
  const w = await worker(t);
  const probeTimers = [];
  const lateReplies = [];
  const originalSetTimeout = w.c.setTimeout;
  const originalClearTimeout = w.c.clearTimeout;
  w.c.setTimeout = (callback, ms) => {
    if (ms !== 2000) return originalSetTimeout(callback, ms);
    const timer = { callback, ms, cleared: false };
    probeTimers.push(timer);
    return timer;
  };
  w.c.clearTimeout = timer => {
    if (probeTimers.includes(timer)) timer.cleared = true;
    else originalClearTimeout(timer);
  };
  let injections = 0;
  w.chrome.scripting = { async executeScript() { injections += 1; } };
  w.hooks.ready = () => new Promise(resolve => lateReplies.push(resolve));
  const pending = w.c.sendToTab(tab.id, { type: "START_LIGHTHOUSE_COMMENT_TASK", runId: w.state().runId });
  await flushUntil(() => probeTimers.length === 1);
  assert.equal(injections, 0);
  probeTimers[0].callback();
  await flushUntil(() => probeTimers.length === 2);
  assert.equal(injections, 1);
  probeTimers[1].callback();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.runnerUnavailable, true);
  assert.equal(result.claimActionAttempted, false);
  assert.equal(w.messages("CHECK_LIGHTHOUSE_RUNNER_READY").length, 2);
  assert.equal(probeTimers.every(timer => timer.cleared), true);
  const stateBeforeLateReply = clone(w.state());
  for (const resolve of lateReplies) resolve({ ok: true, version: "test", instanceId: "late-page", url: tab.url, paused: false });
  await new Promise(setImmediate);
  assert.deepEqual(clone(w.state()), stateBeforeLateReply);
  assert.equal(w.messages("START_LIGHTHOUSE_COMMENT_TASK").length, 0);
  assert.equal(w.state().uncertainAction, undefined);
  assert.equal(w.stored.lighthouseAutoRunStateV1?.uncertainAction, undefined);
});

test("a rejected main-script injection fails before claim intent or START", async t => {
  const w = await worker(t);
  let injections = 0;
  w.hooks.ready = async () => undefined;
  w.chrome.scripting = { async executeScript({ target, files }) {
    injections += 1;
    assert.equal(target.tabId, tab.id);
    assert.deepEqual(Array.from(files), ["src/content/lighthouse.js"]);
    throw new Error("Cannot access contents of this page");
  } };
  const result = await w.c.sendToTab(tab.id, { type: "START_LIGHTHOUSE_COMMENT_TASK", runId: w.state().runId });
  assert.equal(result.ok, false);
  assert.equal(result.runnerUnavailable, true);
  assert.equal(result.claimActionAttempted, false);
  assert.equal(injections, 1);
  assert.equal(w.messages("CHECK_LIGHTHOUSE_RUNNER_READY").length, 1);
  assert.equal(w.messages("START_LIGHTHOUSE_COMMENT_TASK").length, 0);
  assert.equal(w.state().uncertainAction, undefined);
  assert.equal(w.stored.lighthouseAutoRunStateV1?.uncertainAction, undefined);
});

test("the real paused runner blocks an invitation without reinjection or an accept action", async t => {
  const { w, p, upstream } = await connected(t, { popup: true });
  let injections = 0;
  w.chrome.scripting = { async executeScript() { injections += 1; } };
  await p.pause();
  const result = await w.c.sendToTab(tab.id, { type: "START_LIGHTHOUSE_COMMENT_TASK", runId: w.state().runId });
  assert.equal(result.ok, false);
  assert.equal(result.runnerUnavailable, true);
  assert.equal(injections, 0);
  assert.equal(w.messages("CHECK_LIGHTHOUSE_RUNNER_READY").length, 1);
  assert.equal(w.messages("START_LIGHTHOUSE_COMMENT_TASK").length, 0);
  assert.equal(p.f.accept.clicks + p.action.clicks, 0);
  assert.equal(upstream.some(entry => entry.message.type === "LIGHTHOUSE_CLAIM_CHECKPOINT"), false);
  assert.equal(w.state().uncertainAction, undefined);
});
