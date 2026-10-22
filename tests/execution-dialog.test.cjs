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

for (const transition of ["missing-target", "previous-target", "previous-detail"]) {
  test(`invitation waits for ${transition} to settle before opening the same claimed task`, async t => {
    const { w, p } = await connected(t, { popup: true });
    let execution, elapsed = 0;
    p.f.accept.onClick = () => {
      if (transition === "previous-detail") p.f.installDetail(OTHER);
      else execution = installExecution(p, { target: transition === "missing-target" ? "" : OTHER });
    };
    p.f.beforeWait = ms => {
      if (!p.f.accept.clicks) return;
      elapsed += ms;
      if (elapsed >= 5000 && !execution?.settled) {
        if (transition === "previous-detail") execution = installExecution(p);
        else execution.link.href = TARGET;
        execution.settled = true;
      }
    };
    const runId = w.state().runId;
    const result = await w.c.sendToTab(11, { type: "START_LIGHTHOUSE_COMMENT_TASK", runId,
      settings: { actionDelayMs: 150, cooldownPollMs: 250, lockSeatTimeoutMs: 5000 } });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.task.seatLocked, true);
    assert.equal(result.task.tweetUrl, TARGET);
    assert.equal(w.state().running, true, "the original auto flow must remain active");
    assert.ok(!w.state().uncertainAction);
    assert.equal(p.f.accept.clicks, 1);
    assert.equal(p.f.lock?.clicks || 0, 0);
    assert.equal(p.action.clicks, 0);
    const message = { type: "CONFIRM_LIGHTHOUSE_LOCKED_TASK_NOTICE", runId, task: result.task };
    const opened = await w.c.sendToTab(11, message);
    assert.equal(opened.ok, true, opened.message);
    await w.c.sendToTab(11, message);
    assert.equal(execution.open.clicks, 1);
    assert.equal(execution.verify.clicks, 0);
  });
}

for (const failure of ["wrong-target", "missing-target", "manual-stop"]) {
  test(`invitation ${failure} during execution transition preserves the order without opening or re-claiming`, async () => {
    const p = page(); let execution, interrupted = false;
    p.f.accept.onClick = () => { execution = installExecution(p, { target: failure === "missing-target" ? "" : OTHER }); };
    p.f.beforeWait = async () => {
      if (failure === "manual-stop" && p.f.accept.clicks && !interrupted) {
        interrupted = true;
        await p.pause();
        execution.link.href = TARGET;
      }
    };
    const result = await p.run();
    assert.equal(result.ok, false);
    assert.equal(result.claimActionAttempted, true);
    assert.equal(p.f.accept.clicks, 1);
    assert.equal(p.action.clicks, 0);
    assert.equal(p.f.lock?.clicks || 0, 0);
    assert.equal(execution.open.clicks + execution.verify.clicks, 0);
    if (failure === "manual-stop") assert.equal(interrupted, true);
  });
}

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
      return message.type === "COMPLETE_X_TASK_WIDGET"
        ? { ok: true, submitted: true } : { ok: true, completed: false };
    }
    return send(id, message);
  };
  return { w, p, e, task };
}
const autoSettings = { replyMode: "post", autoSubmitLighthouse: true, actionDelayMs: 150 };

test("real worker submits X before Lighthouse, persists each intent and waits for official completion", async t => {
  const { w, p, e, task } = await executionWorker(t);
  const send = w.chrome.tabs.sendMessage;
  w.chrome.tabs.sendMessage = async (id, message) => {
    if (message.type === "COMPLETE_X_TASK_WIDGET") {
      assert.equal(w.stored.lighthouseAutoRunStateV1.uncertainAction.type, "COMPLETE_X_TASK_WIDGET");
      assert.equal(e.verify.clicks, 0);
    }
    return send(id, message);
  };
  e.verify.onClick = () => {
    assert.equal(w.stored.lighthouseAutoRunStateV1.uncertainAction.type, "SUBMIT_LIGHTHOUSE_EXECUTION_VERIFICATION");
    assert.equal(w.messages("COMPLETE_X_TASK_WIDGET").length, 1, "X verification must precede the Lighthouse click");
    e.region.replaceChildren(new Element("h2", "验证成功"), new Element("strong", "0.10 LUX"),
      new Element("a", "查看原推文", [], { href: TARGET }));
  };
  const result = await w.c.completeXTaskWidgetLifecycle(22, w.state().runId, autoSettings);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.executionDialog, true);
  assert.equal(result.completed, undefined, "submission alone is not completion");
  assert.equal(e.verify.clicks, 1);
  assert.equal(w.messages("COMPLETE_X_TASK_WIDGET").length, 1);
  assert.deepEqual(w.effects.filter(effect => effect.type === "message")
    .map(effect => effect.message.type).filter(type => ["COMPLETE_X_TASK_WIDGET", "SUBMIT_LIGHTHOUSE_EXECUTION_VERIFICATION"].includes(type)),
  ["COMPLETE_X_TASK_WIDGET", "SUBMIT_LIGHTHOUSE_EXECUTION_VERIFICATION"]);
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
    assert.equal(w.messages("COMPLETE_X_TASK_WIDGET").length, ["storage-failure", "lost-response"].includes(kind) ? 1 : 0);
    if (kind === "lost-response" || kind === "storage-failure") {
      assert.equal(w.state().uncertainAction.type, "SUBMIT_LIGHTHOUSE_EXECUTION_VERIFICATION");
      assert.equal(w.state().running, false);
      await w.c.completeXTaskWidgetLifecycle(22, w.state().runId, autoSettings);
      assert.equal(e.verify.clicks, kind === "lost-response" ? 1 : 0);
    }
  });
}

for (const failure of ["failed", "missing", "no-submission", "lost-receipt", "stop", "changed-task"]) {
  test(`X verification ${failure} prevents Lighthouse verification and any next order`, async t => {
    const { w, e, task } = await executionWorker(t);
    const send = w.chrome.tabs.sendMessage;
    w.chrome.tabs.sendMessage = async (id, message) => {
      if (message.type !== "COMPLETE_X_TASK_WIDGET") return send(id, message);
      w.effects.push({ type: "message", id, message: structuredClone(message) });
      if (failure === "lost-receipt") throw Error("The message port closed before a response was received");
      if (failure === "stop") Object.assign(w.state(), { running: false, manuallyStopped: true });
      if (failure === "changed-task") w.state().currentTask = { taskKey: "replacement", tweetUrl: OTHER };
      if (failure === "missing") return undefined;
      if (failure === "failed") return { ok: false, message: "X verify button is disabled" };
      return failure === "no-submission" ? { ok: true } : { ok: true, submitted: true };
    };
    const result = await w.c.completeXTaskWidgetLifecycle(22, w.state().runId, autoSettings);
    assert.equal(result.ok, false);
    assert.equal(w.messages("COMPLETE_X_TASK_WIDGET").length, 1);
    assert.equal(w.messages("SUBMIT_LIGHTHOUSE_EXECUTION_VERIFICATION").length, 0);
    assert.equal(e.verify.clicks, 0);
    assert.equal(w.reloads().length, 0);
    assert.equal(w.messages("START_LIGHTHOUSE_COMMENT_TASK").length, 0);
    assert.equal(w.messages("RUN_X_REPLY").length, 0);
    if (failure !== "changed-task") assert.equal(w.state().currentTask.taskKey, task.taskKey);
    if (failure === "lost-receipt") assert.equal(w.state().uncertainAction.type, "COMPLETE_X_TASK_WIDGET");
  });
}

test("an attempted X verification with no final website result continues to the separate Lighthouse verification", async t => {
  const { w, e } = await executionWorker(t);
  const send = w.chrome.tabs.sendMessage;
  w.chrome.tabs.sendMessage = async (id, message) => message.type === "COMPLETE_X_TASK_WIDGET"
    ? { ok: true, submitted: false, submissionAttempted: true } : send(id, message);
  const result = await w.c.completeXTaskWidgetLifecycle(22, w.state().runId, autoSettings);
  assert.equal(result.ok, true, result.message);
  assert.equal(e.verify.clicks, 1);
  assert.ok(!w.state().completionEvidence, "a button click is not completion evidence");
});

// Review regressions: exercise adjacent states with the same production
// worker/content pair. Keep failures visible until the implementation is fixed.
function showOfficialCompletion(e) {
  e.region.replaceChildren(new Element("h2", "验证成功"), new Element("strong", "0.10 LUX"),
    new Element("a", "查看原推文", [], { href: TARGET }));
}

for (const officialCompleted of [true, false]) {
  test(`invitation flow preserves the complete click order and refreshes only after official completion=${officialCompleted}`, async t => {
    const { w, p } = await connected(t, { popup: true });
    const sequence = []; let e;
    p.f.accept.onClick = () => {
      sequence.push("accept-invitation");
      e = installExecution(p);
      const open = e.open.onClick;
      e.open.onClick = () => { sequence.push("go-complete"); open(); };
      e.verify.onClick = () => {
        sequence.push("lighthouse-verify");
        if (officialCompleted) showOfficialCompletion(e);
      };
    };
    const get = w.chrome.tabs.get;
    w.chrome.tabs.get = async id => id === 22
      ? { id: 22, windowId: 1, status: "complete", url: TARGET } : get(id);
    const send = w.chrome.tabs.sendMessage;
    w.chrome.tabs.sendMessage = async (id, message) => {
      if (id === 22) {
        w.effects.push({ type: "message", id, message: structuredClone(message) });
        if (message.type === "RUN_X_REPLY") {
          sequence.push("reply");
          return { ok: true, mode: "post", posted: true, replyText: "offline fixture reply" };
        }
        if (message.type === "COMPLETE_X_TASK_WIDGET") {
          sequence.push("x-verify");
          return { ok: true, submitted: true };
        }
        return { ok: true, completed: false };
      }
      const result = await send(id, message);
      if (message.type === "CHECK_LIGHTHOUSE_OFFICIAL_COMPLETION" && result.completed) sequence.push("official-completed");
      return result;
    };
    w.c.getSettingsForRun = async () => ({ ...autoSettings, maxTasksPerRun: 5 });
    w.c.recordReplyHistory = async () => {};
    w.c.closeLighthouseDetailToCampaigns = async () => {
      assert.equal(w.c.hasLatchedLighthouseCompletion(w.state().runId), true);
      return true;
    };
    w.chrome.tabs.reload = async () => { sequence.push("reload"); };
    w.c.startNextAutoTask = async () => { sequence.push("next-order"); return { ok: true }; };
    const runId = w.state().runId;
    const claim = await w.c.sendToTab(11, { type: "START_LIGHTHOUSE_COMMENT_TASK", runId,
      settings: { actionDelayMs: 150, cooldownPollMs: 250 } });
    assert.equal(claim.ok, true, claim.message);
    Object.assign(w.state(), { xTabId: 22, xTabWindowId: 1 });
    assert.equal(await w.c.waitForLighthouseOpenedTweet(claim.task, 11, "auto", { timeoutMs: 2000 }), true);
    const reply = await w.c.sendToTab(22, { type: "RUN_X_REPLY", runId, task: claim.task, settings: autoSettings });
    const result = await w.c.handleXReplyResult(reply, { runId });
    assert.deepEqual(sequence, ["accept-invitation", "go-complete", "reply", "x-verify", "lighthouse-verify",
      ...(officialCompleted ? ["official-completed", "reload", "next-order"] : [])]);
    assert.equal(result.ok, officialCompleted);
    assert.equal(w.state().completed, officialCompleted ? 1 : 0);
    if (!officialCompleted) {
      assert.equal(w.state().running, false);
      assert.equal(w.state().currentTask.taskKey, claim.task.taskKey);
    }
  });
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
