"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const RUN = "rejection-run";
const INTENT = "claim-intent-1";
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const task = {
  taskKey: "selected-list-order", selectionId: "selected-list-alias",
  stableTaskKey: "stable-list-alias", taskType: "评论", bounty: 0.2,
  title: "Fixture order", tweetUrl: "https://x.com/fixture/status/123",
  seatLocked: true, seatLockedAt: "2026-10-14T03:00:00.000Z",
};

function detail(text = "Fixture order 评论任务 0.2 LUX 目标推文") {
  return {
    innerText: text, visible: true, isConnected: true,
    get textContent() { return this.innerText; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { width: this.visible ? 600 : 0, height: 400 }; },
  };
}

// Exercise the production listener, operation receipts, settled-operation
// registry and rejection checker. Only the page/claim-result adapters are fake;
// the actual clickElement marks whether this operation attempted a claim.
function page(options = {}) {
  let listener;
  const root = detail(options.initialText);
  const fixture = {
    root, clicks: 0, attemptClick: options.attemptClick !== false,
    receiptTask: { ...task, ...(options.receiptTask || {}) },
    receiptOk: options.receiptOk !== false,
  };
  const body = detail(root.innerText);
  const button = { click() { fixture.clicks++; } };
  const context = vm.createContext({
    console, URL, AbortController, setTimeout, clearTimeout,
    fixture, fixtureButton: button,
    document: { body, querySelectorAll: () => [] },
    window: { addEventListener() {} },
    location: { href: "https://app.lhdao.top/campaigns", pathname: "/campaigns" },
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
    fetch: async () => { throw new Error("Network forbidden in claim rejection tests"); },
    chrome: { runtime: {
      onMessage: { addListener(fn) { listener = fn; } },
      sendMessage: async () => ({ ok: true, paused: false }),
    } },
  });
  const source = fs.readFileSync(path.join(__dirname, "../src/content/lighthouse.js"), "utf8");
  const end = source.lastIndexOf("})();");
  assert.ok(end > 0);
  const adapters = `
    findTaskDetailRoot = () => fixture.root;
    isTaskDetailOpen = () => Boolean(fixture.root && fixture.root.visible && fixture.root.isConnected);
    isVisible = node => Boolean(node && node.visible !== false && node.isConnected !== false);
    buildTask = () => ({ ...fixture.receiptTask, taskKey: "rebuilt-detail-key" });
    report = () => {};
    hasDetailRequestTimeout = () => false;
    async function fixtureClaim() {
      if (fixture.attemptClick) await clickElement(fixtureButton, { randomDelay: false, claimAction: true });
      return { ok: fixture.receiptOk, task: { ...fixture.receiptTask } };
    }
    runCommentTask = fixtureClaim;
    debugLockSeatAndExtract = fixtureClaim;
    waitSelectedCountdownAndLock = fixtureClaim;
  `;
  vm.runInContext(source.slice(0, end) + adapters + source.slice(end), context);
  const dispatch = message => new Promise(resolve => {
    assert.equal(listener({ runId: RUN, platform: "lighthouse", settings: {}, ...message }, {}, resolve), true);
  });
  return {
    root, body, fixture, dispatch,
    claim: (type = "START_LIGHTHOUSE_COMMENT_TASK", extra = {}) => dispatch({ type, claimIntentId: INTENT, ...extra }),
    reject(text = "Fixture order 评论任务 0.2 LUX 不可领取") {
      fixture.root.innerText = text;
      body.innerText = text;
    },
    check: (extra = {}) => dispatch({ type: "CHECK_LIGHTHOUSE_LOCK_FAILURE", task: { ...fixture.receiptTask }, ...extra }),
  };
}

function assertNoRejection(result) {
  assert.equal(result.claimRejection, undefined, "unbound observations cannot authorize clearing dedupe or an order");
  assert.equal(result.failed, false, "an unproven refusal must not enter the old destructive failure path");
}

for (const type of ["START_LIGHTHOUSE_COMMENT_TASK", "DEBUG_LOCK_SEAT_AND_EXTRACT", "WAIT_SELECTED_COUNTDOWN_AND_LOCK"]) {
  test(`${type}: a new refusal in the same detail returns an operation-bound rejection proof`, async () => {
    const p = page();
    const claimed = await p.claim(type);
    assert.equal(claimed.ok, true);
    assert.equal(claimed.claimActionAttempted, true);
    p.reject();
    const rejected = await p.check();
    assert.equal(rejected.ok, true);
    assert.equal(rejected.failed, true);
    assert.deepEqual(clone(rejected.claimRejection), {
      runId: RUN, taskKey: task.taskKey, seatLockedAt: task.seatLockedAt, claimIntentId: INTENT,
    });
    assert.equal(rejected.task.taskKey, task.taskKey, "retain the original selected-list identity instead of rebuilding it from error text");
    assert.equal(rejected.task.selectionId, task.selectionId);
    assert.equal(rejected.task.stableTaskKey, task.stableTaskKey);
    assert.equal(p.fixture.clicks, 1, "checking rejection must never dispatch another claim");
  });
}

test("another card's refusal in document.body cannot reject the current detail", async () => {
  const p = page();
  await p.claim();
  p.body.innerText += " 其他任务 不可领取";
  assertNoRejection(await p.check());
  assert.equal(p.fixture.clicks, 1);
});

for (const [name, extra] of [
  ["another run", { runId: "new-run" }],
  ["another task", { task: { ...task, taskKey: "other-task" } }],
  ["another lock attempt", { task: { ...task, seatLockedAt: "2026-10-14T03:00:01.000Z" } }],
  ["missing task identity", { task: {} }],
]) {
  test(`rejection from ${name} cannot reuse the stored lock observation`, async () => {
    const p = page();
    await p.claim();
    p.reject();
    assertNoRejection(await p.check(extra));
  });
}

test("a replacement detail element cannot reuse an older element's lock observation", async () => {
  const p = page();
  await p.claim();
  p.fixture.root = detail("Fixture order 评论任务 0.2 LUX 不可领取");
  p.body.innerText = p.fixture.root.innerText;
  assertNoRejection(await p.check());
});

for (const change of ["hidden", "detached", "missing"]) {
  test(`a ${change} detail cannot prove this order was refused`, async () => {
    const p = page();
    await p.claim();
    p.reject();
    if (change === "hidden") p.root.visible = false;
    else if (change === "detached") p.root.isConnected = false;
    else p.fixture.root = null;
    assertNoRejection(await p.check());
  });
}

test("a refusal already present when the claim returned is not a new rejection", async () => {
  const p = page({ initialText: "Fixture order 评论任务 0.2 LUX 不可领取" });
  await p.claim();
  assertNoRejection(await p.check());
});

for (const state of ["已领取", "已锁定", "进行中", "已完成", "已提交", "验证通过", "奖励到账"]) {
  test(`positive state ${state} prevents a simultaneous refusal from releasing the order`, async () => {
    const p = page();
    await p.claim();
    p.reject(`Fixture order 评论任务 0.2 LUX ${state} 不可领取`);
    assertNoRejection(await p.check());
  });
}

for (const [name, options] of [
  ["no actual claim click", { attemptClick: false }],
  ["no provisional locked-seat receipt", { receiptTask: { seatLocked: false } }],
  ["an unsuccessful claim receipt", { receiptOk: false }],
]) {
  test(`${name} cannot create a delayed rejection proof`, async () => {
    const p = page(options);
    await p.claim();
    p.reject();
    assertNoRejection(await p.check());
  });
}

test("a fresh page without a matching settled operation cannot infer failure from visible refusal text", async () => {
  const p = page();
  p.reject();
  assertNoRejection(await p.check());
});

test("STOP and resume cannot revive a cleared lock observation", async () => {
  const p = page();
  await p.claim();
  await p.dispatch({ type: "AUTOMATION_PAUSE_CHANGED", paused: true });
  await p.dispatch({ type: "AUTOMATION_PAUSE_CHANGED", paused: false });
  p.reject();
  const result = await p.check();
  assert.equal(result.cancelled, true);
  assert.equal(result.claimRejection, undefined);
  assert.equal(p.fixture.clicks, 1);
});

for (const state of ["已领取", "已锁定", "进行中"]) {
  test(`positive state ${state} at the lock receipt remains protected after refusal replaces the detail text`, async () => {
    const p = page({ initialText: `Fixture order 评论任务 0.2 LUX ${state}` });
    const claimed = await p.claim();
    assert.equal(claimed.ok, true);
    assert.equal(claimed.claimActionAttempted, true);
    p.reject();
    assertNoRejection(await p.check());
    assert.equal(p.fixture.clicks, 1);
  });
}

for (const [changed, rejectionText] of [
  ["title", "Different order 评论任务 0.2 LUX 不可领取"],
  ["bounty", "Fixture order 评论任务 0.8 LUX 不可领取"],
]) {
  test(`a detail root reused for another ${changed} cannot reuse the previous lock observation`, async () => {
    const p = page();
    await p.claim();
    const originalRoot = p.root;
    p.reject(rejectionText);
    assert.equal(p.fixture.root, originalRoot, "SPA detail reuse keeps the exact element identity");
    assertNoRejection(await p.check());
    assert.equal(p.fixture.clicks, 1);
  });
}
