"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function fixture(file, boundary, exported) {
  const source = fs.readFileSync(path.join(__dirname, file), "utf8");
  const end = source.indexOf(boundary);
  assert.ok(end > 0);
  const prefix = source.slice(0, end);
  assert.equal(/^\s*test\s*\(/m.test(prefix), false);
  return new Function("require", "__dirname", `${prefix}\nreturn ${exported};`)(require, __dirname);
}
const { page, Element, TARGET, OTHER, RUN } = fixture("invitation-popup.test.cjs", 'test("ordinary list selection', "({ page, Element, TARGET, OTHER, RUN })");
const { connected } = fixture("runner-readiness-audit.test.cjs", "for (const popup of", "({ connected })");

// Structure observed on 2026-10-21: the target link is an icon with an
// accessible label; the working state has no LUX amount or close control.
function installExecution(p, { target = TARGET, phase = "claimed", receipt = true } = {}) {
  p.f.popup?.remove(); p.f.detail?.remove();
  const heading = new Element("h2", phase === "claimed" ? "接单成功，开始任务吧" : "完成任务后，回来验证");
  const status = new Element("div", "", [heading,
    new Element("p", receipt ? "席位已锁定，请使用绑定的 X 账号完成任务。" : "请先锁定席位")], { role: "status" });
  const link = new Element("a", "", [], { href: target, "aria-label": "查看目标推文" });
  const open = new Element("button", phase === "claimed" ? "去完成任务 ↗" : "打开目标推文 ↗");
  const verify = new Element("button", "我已完成，开始验证");
  const region = new Element("section", "", [status,
    ...(phase === "claimed" ? [new Element("div", "任务奖励 0.10 LUX")] : []),
    new Element("div", "剩余时间 —"), new Element("strong", "溪山梦"), link,
    new Element("p", "天天用 AI 改稿、查资料"), new Element("strong", "评论引导"),
    new Element("p", "谢谢大家，多评论两句"), open, verify,
    new Element("p", "插件会自动验证；验证未完成前请保留此窗口。")],
    { role: "region", "aria-label": "任务执行与验证" }, { width: 620, height: 800 });
  const root = new Element("div", "", [new Element("h2", "任务执行与验证"),
    new Element("p", "查看任务进度和验证结果"), region],
    { role: "dialog", "aria-label": "任务执行与验证" }, { width: 660, height: 900 });
  p.body.appendChild(root); p.f.detail = root;
  // Background cards must never become the current order's eligibility scope.
  p.card.appendChild(new Element("span", "档位不符 前往目标"));
  open.onClick = () => { heading.ownText = "完成任务后，回来验证"; open.ownText = "打开目标推文 ↗"; };
  return { root, region, heading, status, link, open, verify };
}

test("accepted invitation recognizes the real success dialog without visible target text or a close button", async () => {
  const p = page(); let execution;
  p.f.accept.onClick = () => { execution = installExecution(p); };
  const result = await p.run();
  assert.equal(result.ok, true, result.message);
  assert.equal(result.task.seatLocked, true);
  assert.equal(result.task.tweetUrl, TARGET);
  assert.equal(p.f.accept.clicks, 1);
  assert.equal(p.action.clicks, 0);
  const message = { type: "CONFIRM_LIGHTHOUSE_LOCKED_TASK_NOTICE", runId: RUN, task: result.task };
  const first = await p.dispatch(message);
  assert.equal(first.ok, true, first.message);
  assert.equal(first.noticeClicked, true);
  assert.equal(execution.open.clicks, 1);
  assert.equal(execution.verify.clicks, 0);
  await p.dispatch(message);
  assert.equal(execution.open.clicks, 1, "opening the same order is idempotent");
});

test("working execution dialog remains the bound locked order with no LUX amount", async () => {
  const p = page({ popup: false }); const e = installExecution(p, { phase: "working" });
  const task = { taskKey: "execution-order", tweetUrl: TARGET };
  const result = await p.dispatch({ type: "CHECK_LIGHTHOUSE_ORDER_OUTCOME", platform: "lighthouse", task });
  assert.equal(result.outcome, "locked");
  assert.equal(e.open.clicks + e.verify.clicks, 0);
});

for (const kind of ["wrong-target", "two-targets", "two-dialogs", "no-receipt", "untrusted-target"]) {
  test(`execution identity refuses ${kind} without touching either action`, async () => {
    const p = page({ popup: false });
    const e = installExecution(p, { phase: "working", receipt: kind !== "no-receipt",
      target: kind === "wrong-target" ? OTHER : kind === "untrusted-target" ? `https://example.org/?target=${TARGET}` : TARGET });
    if (kind === "two-targets") e.region.appendChild(new Element("a", "", [], { href: OTHER, "aria-label": "查看目标推文" }));
    if (kind === "two-dialogs") {
      p.f.detail = null; installExecution(p, { phase: "working" });
    }
    const task = { taskKey: "execution-order", tweetUrl: TARGET, seatLocked: true };
    const read = await p.run("CHECK_LIGHTHOUSE_EXECUTION_STATE", { task });
    assert.equal(read.present, true); assert.equal(read.ok, false);
    const result = await p.run("SUBMIT_LIGHTHOUSE_EXECUTION_VERIFICATION", { task, xActionsCompleted: true,
      settings: { autoSubmitLighthouse: true, replyMode: "post" } });
    assert.equal(result.ok, false);
    assert.equal(e.open.clicks + e.verify.clicks, 0);
  });
}

test("same-ID alias and unrelated prose links cannot change the execution target", async () => {
  const p = page({ popup: false }); const e = installExecution(p, { phase: "working" });
  e.region.appendChild(new Element("a", "其他推文", [], { href: OTHER }));
  const task = { taskKey: "execution-order", tweetUrl: TARGET.replace("/invited/", "/i/"), seatLocked: true };
  const read = await p.run("CHECK_LIGHTHOUSE_EXECUTION_STATE", { task });
  assert.equal(read.ok, true); assert.equal(read.canVerify, true);
  const message = { task, xActionsCompleted: true, settings: { autoSubmitLighthouse: true, replyMode: "post" } };
  const [a, b] = await Promise.all([p.run("SUBMIT_LIGHTHOUSE_EXECUTION_VERIFICATION", message), p.run("SUBMIT_LIGHTHOUSE_EXECUTION_VERIFICATION", message)]);
  assert.equal(a.submitted, true); assert.equal(b.submitted, true);
  await p.run("SUBMIT_LIGHTHOUSE_EXECUTION_VERIFICATION", message);
  assert.equal(e.verify.clicks, 1);
  assert.equal(e.open.clicks, 0);
});

for (const kind of ["stop", "changed-target", "replaced-dialog", "disabled", "no-x-result", "draft-mode", "manual-submit", "not-opened"]) {
  test(`verification refuses ${kind} before clicking`, async () => {
    const p = page({ popup: false }); const e = installExecution(p, { phase: kind === "not-opened" ? "claimed" : "working" });
    let boundary = false;
    p.f.beforeWait = async () => {
      if (boundary) return; boundary = true;
      if (kind === "stop") await p.pause();
      if (kind === "changed-target") e.link.href = OTHER;
      if (kind === "replaced-dialog") installExecution(p, { phase: "working" });
      if (kind === "disabled") e.verify.disabled = true;
    };
    const result = await p.run("SUBMIT_LIGHTHOUSE_EXECUTION_VERIFICATION", {
      task: { taskKey: "execution-order", tweetUrl: TARGET }, xActionsCompleted: kind !== "no-x-result",
      settings: { autoSubmitLighthouse: kind !== "manual-submit", replyMode: kind === "draft-mode" ? "fill" : "post" }
    });
    assert.equal(result.ok, false);
    assert.equal(e.verify.clicks + e.open.clicks, 0);
  });
}

async function executionWorker(t) {
  const { w, p } = await connected(t, { popup: false });
  const e = installExecution(p, { phase: "working" });
  const task = { source: "lighthouse_invitation", taskKey: "execution-order", tweetUrl: TARGET, seatLocked: true, taskType: "评论" };
  Object.assign(w.state(), { currentTask: task, lastXResult: { ok: true, posted: true }, xTabId: 22 });
  const send = w.chrome.tabs.sendMessage;
  w.chrome.tabs.sendMessage = async (id, message) => {
    if (id === 22) {
      w.effects.push({ type: "message", id, message: structuredClone(message) });
      return { ok: true, completed: false };
    }
    return send(id, message);
  };
  return { w, p, e, task };
}
const autoSettings = { replyMode: "post", autoSubmitLighthouse: true, actionDelayMs: 150 };

test("real worker persists verification intent, clicks the website once and waits for official completion", async t => {
  const { w, p, e, task } = await executionWorker(t);
  e.verify.onClick = () => {
    assert.equal(w.stored.lighthouseAutoRunStateV1.uncertainAction.type, "SUBMIT_LIGHTHOUSE_EXECUTION_VERIFICATION");
    e.region.replaceChildren(new Element("h2", "验证成功"), new Element("strong", "0.10 LUX"),
      new Element("a", "查看原推文", [], { href: TARGET }));
  };
  const result = await w.c.completeXTaskWidgetLifecycle(22, w.state().runId, autoSettings);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.executionDialog, true);
  assert.equal(result.completed, undefined, "submission alone is not completion");
  assert.equal(e.verify.clicks, 1);
  assert.equal(w.messages("COMPLETE_X_TASK_WIDGET").length, 0, "no circular wait on the X widget");
  assert.equal(w.state().uncertainAction, undefined);
  const official = await w.c.waitForPassiveTaskCompletion(w.state().runId, autoSettings, 11, () => true);
  assert.equal(official.completed, true);
  assert.equal(w.state().completionEvidence.taskKey, task.taskKey);
  assert.equal(e.verify.clicks, 1);
});

for (const kind of ["no-x-result", "stop-after-read", "new-order-after-read", "storage-failure", "lost-response"]) {
  test(`real worker protects the order on ${kind}`, async t => {
    const { w, e } = await executionWorker(t);
    if (kind === "no-x-result") w.state().lastXResult = null;
    let storageRejected = false;
    if (kind === "storage-failure") w.hooks.set = async values => {
      if (!storageRejected && values.lighthouseAutoRunStateV1?.uncertainAction?.type === "SUBMIT_LIGHTHOUSE_EXECUTION_VERIFICATION") {
        storageRejected = true; throw Error("disk unavailable");
      }
    };
    const send = w.chrome.tabs.sendMessage;
    w.chrome.tabs.sendMessage = async (id, message) => {
      const result = await send(id, message);
      if (message.type === "CHECK_LIGHTHOUSE_EXECUTION_STATE") {
        if (kind === "stop-after-read") Object.assign(w.state(), { running: false, manuallyStopped: true });
        if (kind === "new-order-after-read") w.state().currentTask = { taskKey: "replacement", tweetUrl: OTHER };
      }
      if (message.type === "SUBMIT_LIGHTHOUSE_EXECUTION_VERIFICATION" && kind === "lost-response") throw Error("The message port closed before a response was received");
      return result;
    };
    const result = await w.c.completeXTaskWidgetLifecycle(22, w.state().runId, autoSettings);
    assert.equal(result.ok, false);
    assert.equal(e.verify.clicks, kind === "lost-response" ? 1 : 0);
    assert.equal(w.messages("COMPLETE_X_TASK_WIDGET").length, 0);
    if (kind === "lost-response" || kind === "storage-failure") {
      assert.equal(w.state().uncertainAction.type, "SUBMIT_LIGHTHOUSE_EXECUTION_VERIFICATION");
      assert.equal(w.state().running, false);
      await w.c.completeXTaskWidgetLifecycle(22, w.state().runId, autoSettings);
      assert.equal(e.verify.clicks, kind === "lost-response" ? 1 : 0);
    }
  });
}

// Review regressions: exercise adjacent states with the same production
// worker/content pair. Keep failures visible until the implementation is fixed.
function showOfficialCompletion(e) {
  e.region.replaceChildren(new Element("h2", "验证成功"), new Element("strong", "0.10 LUX"),
    new Element("a", "查看原推文", [], { href: TARGET }));
}

test("review: STOP while focusing Lighthouse prevents verification", async t => {
  const { w, e } = await executionWorker(t);
  const update = w.chrome.tabs.update;
  w.chrome.tabs.update = async (...args) => {
    const result = await update(...args);
    Object.assign(w.state(), { running: false, manuallyStopped: true });
    return result;
  };
  const result = await w.c.completeXTaskWidgetLifecycle(22, w.state().runId, autoSettings);
  assert.equal(result.cancelled, true);
  assert.equal(e.verify.clicks, 0);
  assert.equal(w.messages("SUBMIT_LIGHTHOUSE_EXECUTION_VERIFICATION").length, 0);
});

for (const boundary of ["before-execution-read", "while-focusing"]) {
  test(`review: matching official completion ${boundary} finishes without resubmission`, async t => {
    const { w, e, task } = await executionWorker(t);
    const runId = w.state().runId;
    assert.equal((await w.c.sendToTab(11, { type: "BEGIN_LIGHTHOUSE_COMPLETION_WATCH", runId, task })).ok, true);
    if (boundary === "before-execution-read") showOfficialCompletion(e);
    else {
      const update = w.chrome.tabs.update;
      w.chrome.tabs.update = async (...args) => { const result = await update(...args); showOfficialCompletion(e); return result; };
    }
    const result = await w.c.completeXTaskWidgetLifecycle(22, runId, autoSettings);
    const official = await w.c.sendToTab(11, { type: "CHECK_LIGHTHOUSE_OFFICIAL_COMPLETION", runId, task });
    assert.equal(official.completed, true, "the production completion reader proves this exact order is done");
    assert.equal(e.verify.clicks, 0);
    assert.equal(result.ok, true, result.message);
    assert.equal(w.c.hasLatchedLighthouseCompletion(runId), true);
  });
}

test("review: an already bound target tab still advances the claimed execution dialog", async t => {
  const { w, p, task } = await executionWorker(t);
  const e = installExecution(p, { phase: "claimed" });
  const get = w.chrome.tabs.get;
  w.chrome.tabs.get = async id => id === 22
    ? { id: 22, windowId: 1, status: "complete", url: TARGET } : get(id);
  const adopted = await w.c.waitForLighthouseOpenedTweet(task, 11, "auto", { timeoutMs: 2000 });
  assert.equal(adopted, true);
  const result = await w.c.completeXTaskWidgetLifecycle(22, w.state().runId, autoSettings);
  assert.equal(e.open.clicks, 1, "reusing X must not skip the site's claimed-to-working transition");
  assert.equal(result.ok, true, result.message);
  assert.equal(e.verify.clicks, 1);
});

test("review: a filled but unsent reply is not completion evidence after settings change to post", async t => {
  const { w, e } = await executionWorker(t);
  w.state().lastXResult = { ok: true, mode: "fill", replyText: "unsent draft", tweet: { url: TARGET } };
  const result = await w.c.completeXTaskWidgetLifecycle(22, w.state().runId, autoSettings);
  assert.equal(e.verify.clicks, 0, "current settings cannot turn the previous draft into a posted reply");
  assert.notEqual(result.ok, true);
  assert.equal(w.messages("COMPLETE_X_TASK_WIDGET").length, 0);
});

for (const failure of ["not-ok", "missing-response"]) {
  test(`review: ${failure} execution read cannot fall through to an X submission`, async t => {
    const { w, e } = await executionWorker(t);
    const send = w.chrome.tabs.sendMessage;
    w.chrome.tabs.sendMessage = async (id, message) => message.type === "CHECK_LIGHTHOUSE_EXECUTION_STATE"
      ? (failure === "not-ok" ? { ok: false, message: "execution state unavailable" } : undefined) : send(id, message);
    const result = await w.c.completeXTaskWidgetLifecycle(22, w.state().runId, autoSettings);
    assert.equal(w.messages("COMPLETE_X_TASK_WIDGET").length, 0, "unknown execution state is not an absent dialog");
    assert.equal(e.verify.clicks, 0);
    assert.notEqual(result.ok, true);
  });
}
