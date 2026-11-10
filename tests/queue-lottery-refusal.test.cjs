"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Reuse the semantic DOM and real content listener, not selector-specific
// answers. Claims, feedback observation, validation and clicks are production.
const fixtureSource = fs.readFileSync(path.join(__dirname, "invitation-popup.test.cjs"), "utf8");
const fixtureEnd = fixtureSource.indexOf('test("ordinary list selection');
assert.ok(fixtureEnd > 0);
const { page, Element, TARGET, OTHER, RUN } = new Function("require", "__dirname",
  `${fixtureSource.slice(0, fixtureEnd)}\nreturn { page, Element, TARGET, OTHER, RUN };`)(require, __dirname);
const QUEUED = "您已在队列中，请等待结果";
const ENTERED = "你已加入队列 无需重复点击 预计在 4 秒内确定席位 请耐心等待，结果将自动弹出";
const FULL = "本席位已满 很遗憾，请继续关注其他任务 我知道了";

function queuePage(options = {}) {
  const p = page({ popup: false });
  const observers = new Set();
  p.c.MutationObserver = class {
    constructor(callback) { this.callback = callback; }
    observe() { observers.add(this); }
    disconnect() { observers.delete(this); }
  };
  const notifyMutation = () => { for (const observer of observers) observer.callback(); };
  const f = { p, observers, results: [], elapsed: 0, resultShown: false, ackEffects: 0 };
  const toast = text => {
    const root = new Element("div", "", [new Element("div", text, [], { role: "status" })], { "data-rht-toaster": "" });
    p.body.appendChild(root); notifyMutation(); return root;
  };
  const resultPopup = () => {
    const acknowledge = new Element("button", "我知道了", [], { "data-slot": "alert-dialog-action" });
    acknowledge.disabled = Boolean(options.delayedAckReady);
    const root = new Element("div", "", [
      new Element("h2", "本席位已满", [], { "data-slot": "alert-dialog-title" }),
      new Element("p", "很遗憾，请继续关注其他任务", [], { "data-slot": "alert-dialog-description" }),
      acknowledge,
    ], { role: "alertdialog", "data-slot": "alert-dialog-content", "data-state": "open" });
    acknowledge.onClick = () => { f.ackEffects++; root.remove(); options.onAcknowledge?.(f); notifyMutation(); };
    f.results.push({ root, acknowledge });
    p.body.appendChild(root); notifyMutation(); return root;
  };
  const install = () => {
    const detail = p.f.installDetail(TARGET);
    if (options.noTarget) {
      detail.querySelector("a[href]").remove();
      detail.appendChild(new Element("button", "在 X 打开"));
    }
    detail.appendChild(new Element("p", "抽签 · 锁定席位 抽签成功后锁定专属席位"));
    if (options.oldPopup) resultPopup();
    if (options.oldPositive) detail.appendChild(new Element("p", "已提交"));
    p.f.lock.onClick = () => {
      f.lock = p.f.lock;
      if (options.entryBeforeQueue) toast(ENTERED);
      f.lock.ownText = QUEUED; f.lock.disabled = true;
      if (options.duplicate) detail.appendChild(new Element("button", QUEUED, [], { disabled: "" }));
      if (!options.noEntry && !options.entryBeforeQueue) toast(ENTERED);
      if (options.entryBeforeQueue) notifyMutation();
    };
  };
  p.action.onClick = p.card.onClick = install;
  Object.assign(f, { toast, resultPopup, notifyMutation });
  p.f.beforeWait = async ms => {
    if (!f.lock?.clicks) return;
    f.elapsed += ms;
    if (options.delayedAckReady && f.resultShown && !f.ackBecameReady && f.elapsed >= 5500) {
      assert.equal(f.ackEffects, 0, "a disabled result action must never be clicked");
      f.results[0].acknowledge.disabled = false;
      f.ackBecameReady = true;
      notifyMutation();
    }
    if (f.resultShown || f.elapsed < 5000 || options.noResult) return;
    f.resultShown = true;
    if (options.toastOnly) toast(FULL);
    else if (options.tweetOnly) {
      p.f.detail.appendChild(new Element("section", "", [new Element("h2", "TARGET TWEET LIVE"), new Element("p", FULL)]));
      notifyMutation();
    } else if (!options.oldPopup) resultPopup();
    await options.afterResult?.(f);
  };
  f.run = async (route = "DEBUG_LOCK_SEAT_AND_EXTRACT") => {
    if (route !== "START_LIGHTHOUSE_COMMENT_TASK") install();
    return p.run(route);
  };
  return f;
}

for (const route of ["DEBUG_LOCK_SEAT_AND_EXTRACT", "WAIT_SELECTED_COUNTDOWN_AND_LOCK", "START_LIGHTHOUSE_COMMENT_TASK"]) {
  test(`${route}: a fresh queue lottery rejection dismisses only its own result and binds the refusal`, async () => {
    const f = queuePage({ duplicate: route === "START_LIGHTHOUSE_COMMENT_TASK" });
    const result = await f.run(route);
    assert.equal(result.ok, false);
    assert.equal(result.claimActionAttempted, true);
    assert.equal(result.task?.claimRejected, true, result.message);
    assert.equal(result.task.seatLocked, false);
    assert.equal(result.task.tweetUrl, TARGET);
    assert.deepEqual(JSON.parse(JSON.stringify(result.claimRejection)), {
      runId: RUN, type: route, claimIntentId: "popup-intent", taskKey: result.task.taskKey,
    });
    assert.ok(result.task.taskKey);
    assert.equal(f.lock.clicks, 1, "queue recovery must never submit a second claim");
    assert.equal(f.results[0].acknowledge.clicks, 1);
    assert.equal(f.ackEffects, 1);
    assert.equal(f.results[0].root.isConnected, false);
    assert.ok(f.elapsed >= 5000, "wait for the official result rather than infer refusal from queueing");
    assert.equal(f.observers.size, 0);
  });
}

for (const scenario of ["no-entry", "old-popup", "toast-only", "tweet-only", "old-positive", "changed-detail", "changed-target", "replacement-result", "stop", "new-invitation"]) {
  test(`queue lottery rejection preserves the order for ${scenario}`, async () => {
    const f = queuePage({ noEntry: scenario === "no-entry", oldPopup: scenario === "old-popup",
      toastOnly: scenario === "toast-only", tweetOnly: scenario === "tweet-only", oldPositive: scenario === "old-positive",
      afterResult: async f => {
        if (scenario === "changed-detail") f.p.f.detail.querySelector("h2").ownText = "另一条评论任务";
        if (scenario === "changed-target") f.p.f.detail.querySelector("a[href]").href = OTHER;
        if (scenario === "replacement-result") { f.results[0].root.remove(); f.resultPopup(); }
        if (scenario === "stop") await f.p.pause();
        if (scenario === "new-invitation") f.p.f.showPopup();
        f.notifyMutation();
      },
    });
    const result = await f.run();
    assert.equal(result.ok, false);
    assert.equal(result.claimRejection, undefined, "unbound queue feedback cannot release an order");
    assert.notEqual(result.task?.claimRejected, true);
    assert.equal(f.lock.clicks, 1);
    assert.equal(f.ackEffects, 0);
    assert.equal(f.results.reduce((sum, value) => sum + value.acknowledge.clicks, 0), 0);
    assert.equal(f.observers.size, 0);
  });
}

test("same-order success wins over a queue lottery refusal popup", async () => {
  const f = queuePage({ afterResult: f => {
    f.p.f.detail.appendChild(new Element("span", "席位已锁定"));
    f.notifyMutation();
  } });
  const result = await f.run();
  assert.equal(result.ok, true, result.message);
  assert.equal(result.task?.seatLocked, true);
  assert.equal(result.claimRejection, undefined);
  assert.equal(f.lock.clicks, 1);
  assert.equal(f.ackEffects, 0);
});

for (const boundary of ["stop", "changed-target", "success"]) {
  test(`queue result acknowledgement cannot emit a refusal after synchronous ${boundary}`, async () => {
    const f = queuePage({ onAcknowledge: f => {
      if (boundary === "stop") f.p.pause();
      if (boundary === "changed-target") f.p.f.detail.querySelector("a[href]").href = OTHER;
      if (boundary === "success") f.p.f.detail.appendChild(new Element("span", "席位已锁定"));
    } });
    const result = await f.run();
    assert.equal(f.ackEffects, 1, "exercise the boundary inside the real acknowledgement click");
    assert.equal(result.claimRejection, undefined);
    assert.notEqual(result.task?.claimRejected, true);
    assert.equal(f.lock.clicks, 1);
    assert.equal(f.observers.size, 0);
  });
}

test("queue entry without a terminal lottery result remains unknown without acknowledging or retrying", async () => {
  const f = queuePage({ noResult: true });
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(result.claimActionAttempted, true);
  assert.equal(result.claimRejection, undefined);
  assert.notEqual(result.task?.claimRejected, true);
  assert.notEqual(result.task?.seatLocked, true);
  assert.match(result.message, /未确认.*锁位|锁位.*未确认/);
  assert.equal(f.lock.clicks, 1);
  assert.equal(f.ackEffects, 0);
  assert.equal(f.results.length, 0);
});

test("queue rejection before the site reveals its target URL still acknowledges only this same detail", async () => {
  const f = queuePage({ noTarget: true, duplicate: true });
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(result.task?.claimRejected, true, result.message);
  assert.equal(result.task.seatLocked, false);
  assert.equal(result.task.tweetUrl, "", "do not invent a target while the site exposes only an X button");
  assert.equal(result.claimRejection?.taskKey, result.task.taskKey);
  assert.equal(f.lock.clicks, 1);
  assert.equal(f.ackEffects, 1);
});

test("real queue refusal clears its matching persisted background intent without deduping an unclaimed task", async t => {
  const workerSource = fs.readFileSync(path.join(__dirname, "lock-confirmation.test.cjs"), "utf8");
  const start = workerSource.indexOf("async function worker(t, p) {");
  const end = workerSource.indexOf('test("real unconfirmed click', start);
  assert.ok(start > 0 && end > start);
  const worker = new Function("require", "__dirname", "RUN", "INTENT", `
    const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8"));
    ${workerSource.slice(start, end)}
    return worker;
  `)(require, __dirname, RUN, "popup-intent");
  const f = queuePage({ noTarget: true, duplicate: true });
  const w = await worker(t, { dispatch: (type, message) => message ? f.p.dispatch(message) : f.run(type) });
  const result = await w.send();
  assert.equal(result.claimRejectionConfirmed, true, result.message);
  assert.equal(w.state().running, true);
  assert.equal(w.state().uncertainAction, undefined);
  assert.equal(w.stored.lighthouseAutoRunStateV1.uncertainAction, undefined);
  assert.equal(w.state().attemptedTaskRecords.length, 0);
  assert.equal(f.lock.clicks, 1);
  assert.equal(f.ackEffects, 1);
  assert.deepEqual(w.effects, ["START_LIGHTHOUSE_COMMENT_TASK"]);
});

test("fresh queue entry feedback is retained when React updates the disabled queue control afterward", async () => {
  const f = queuePage({ entryBeforeQueue: true });
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(result.task?.claimRejected, true, result.message);
  assert.equal(result.claimRejection?.runId, RUN);
  assert.equal(f.lock.clicks, 1);
  assert.equal(f.ackEffects, 1);
});

test("queue result with unchanged text waits for its acknowledgement button to become enabled", async () => {
  const f = queuePage({ delayedAckReady: true });
  const result = await f.run();
  assert.equal(f.ackBecameReady, true, "exercise a separate attribute-only readiness transition");
  assert.equal(result.ok, false);
  assert.equal(result.task?.claimRejected, true, result.message);
  assert.equal(result.claimRejection?.runId, RUN);
  assert.equal(f.lock.clicks, 1);
  assert.equal(f.ackEffects, 1);
});
