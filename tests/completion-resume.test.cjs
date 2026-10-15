"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = process.env.LIGHTHOUSE_TEST_SOURCE_ROOT || path.join(__dirname, "../src");

function load(file, name, globals) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const match = new RegExp(`^([ \\t]*)(?:async )?function ${name}\\(`, "m").exec(source);
  assert.ok(match);
  const next = new RegExp(`^${match[1]}(?:async )?function \\w+\\(`, "gm");
  next.lastIndex = match.index + match[0].length;
  const end = next.exec(source)?.index ?? source.lastIndexOf("})();");
  const context = vm.createContext({ console, ...globals });
  vm.runInContext(source.slice(match.index, end), context);
  return context;
}

function xPage(text, visible = true) {
  let now = 0;
  const effects = { clicks: 0, waited: 0 };
  const widget = { innerText: text };
  const context = load("content/x.js", "completeTaskWidgetLifecycle", {
    activeRunId: "current", assertActiveRun() {}, Date: { now: () => now },
    normalizeText: value => String(value).replace(/\s+/g, " ").trim(),
    findLighthouseTaskWidget: () => widget, isVisible: () => visible,
    findDocumentVerifyActionButton: () => null, revealTaskWidgetArea: async () => widget,
    findVerifyActionButton: () => null, describeTaskWidgetCompletionBlock: () => "no verified receipt",
    async wait(ms) { now += ms; effects.waited += ms; }
  });
  return { context, effects, run: () => context.completeTaskWidgetLifecycle({}) };
}

test("already completed X widget continues official verification without waiting for a submit button", async () => {
  const p = xPage("当前任务 已完成 验证已提交 · 奖励发放中 打开任务广场");
  const result = await p.run();
  assert.equal(result.ok, true);
  assert.equal(result.submitted, true);
  assert.equal(result.alreadySubmitted, true);
  assert.notEqual(result.officialCompletion, true);
  assert.equal(p.effects.waited, 0);
});

for (const text of ["当前任务 点赞 已完成 评论 待完成", "当前任务 验证中", "当前任务 已完成 验收失败", "已完成 验证已提交 · 奖励发放中"]) {
  test(`incomplete or unrelated widget text cannot become a submission receipt: ${text}`, async () => {
    const p = xPage(text), result = await p.run();
    assert.equal(result.ok, false);
    assert.notEqual(result.submitted, true);
  });
}

test("a hidden completed widget cannot stand in for the current task", async () => {
  assert.equal((await xPage("当前任务 已完成 验证已提交 · 奖励发放中", false).run()).ok, false);
});

function worker(onWatch) {
  const sent = [];
  const state = { running: true, runId: "resumed", lighthouseTabId: 11,
    currentTask: { taskKey: "order", tweetUrl: "https://x.com/fixture/status/123" } };
  const c = load("background.js", "completeXTaskWidgetLifecycle", {
    runtimeState: state, setStage() {}, log() {},
    async sendToTab(id, message) {
      sent.push({ id, type: message.type, runId: message.runId, task: message.task });
      if (message.type === "BEGIN_LIGHTHOUSE_COMPLETION_WATCH") return onWatch ? onWatch(state) : { ok: true };
      if (message.type === "COMPLETE_X_TASK_WIDGET") return { ok: true, submitted: true };
      throw Error("Unexpected message " + message.type);
    },
    waitForOfficialLighthouseCompletionDuringXSubmission: async () => null
  });
  return { sent, state, c, run: () => c.completeXTaskWidgetLifecycle(12, "resumed", {}) };
}

test("a resumed run arms its current-order completion watch before X submission", async () => {
  const w = worker();
  assert.equal((await w.run()).ok, true);
  assert.deepEqual(w.sent.map(e => e.type), ["BEGIN_LIGHTHOUSE_COMPLETION_WATCH", "COMPLETE_X_TASK_WIDGET"]);
  assert.equal(w.sent[0].runId, "resumed");
  assert.equal(w.sent[0].task.taskKey, "order");
});

test("failed completion-watch setup does not submit X or discard the order", async () => {
  const w = worker(() => ({ ok: false }));
  assert.equal((await w.run()).ok, false);
  assert.equal(w.sent.length, 1);
  assert.equal(w.state.currentTask.taskKey, "order");
});

test("STOP while arming completion prevents the old X submission", async () => {
  const w = worker(state => { state.running = false; return { ok: true }; });
  assert.equal((await w.run()).cancelled, true);
  assert.equal(w.sent.length, 1);
});

function completionBadgePage(options = {}) {
  const target = "https://x.com/fixture/status/123";
  const widget = { innerText: options.text ?? "当前任务 已完成 验证已提交 · 奖励发放中 打开任务广场",
    querySelectorAll: selector => { assert.equal(selector, ".lh-cur-head .lh-cur-pill-done,.lh-cur-done-big"); return options.badge === false ? [] : [{innerText: "已完成", visible: options.badgeVisible !== false}]; } };
  const c = load("content/x.js", "readTaskWidgetCompletion", {
    automationPaused: Boolean(options.paused), cancelledRunIds: new Set(options.cancelled ? ["run"] : []),
    location: {href: options.url || target}, normalizeTweetUrl: value => value,
    queryAccessibleElements: selector => {assert.equal(selector, ".lh-cur-sec"); return options.duplicate ? [widget, widget] : [widget];},
    normalizeText: value => String(value).replace(/\s+/g, " ").trim(),
    findLighthouseTaskWidget: () => widget, isVisible: node => node === widget ? options.visible !== false : node.visible,
    Date: {now: () => 1000}
  });
  return c.readTaskWidgetCompletion({platform: "lighthouse", runId: "run", task: {taskKey: "order", tweetUrl: target}});
}

for (const text of ["当前任务 已完成 验证已提交 · 奖励发放中", "当前任务 已完成 打开任务广场"]) {
  test(`current task completion badge finishes without waiting for reward: ${text}`, () => {
    const result = completionBadgePage({text});
    assert.equal(result.completed, true); assert.equal(result.evidence.taskKey, "order");
    assert.equal(result.evidence.source, "lighthouse_x_widget");
  });
}
for (const options of [
  {text: "当前任务 验证已提交", badge: false}, {text: "当前任务 评论 已完成 点赞 待完成"},
  {text: "别的任务 已完成"}, {visible: false}, {badgeVisible: false},
  {url: "https://x.com/other/status/999"}, {paused: true}, {cancelled: true},
  {text: "当前任务 已完成 验证失败"}, {duplicate: true}
]) {
  test(`read-only completion rejects unrelated or unfinished status: ${JSON.stringify(options)}`, () => {
    assert.notEqual(completionBadgePage(options).completed, true);
  });
}

// Production listener + production traversal. Match the observed DOM boundary:
// document -> span.lhdao-inline-task -> open shadow root -> .lh-cur-sec.
// Native document queries cannot see the panel, even while its badge is visible.
async function shadowCompletionPage(options = {}) {
  const target = "https://x.com/0xlove428888/status/2110658204187406601";
  const nodes = [];
  const badge = {innerText: "已完成", visible: true};
  const panel = {
    innerText: "当前任务\n×\n已完成\n已完成\n验证已提交 · 奖励发放中\n打开任务广场",
    visible: true, badges: [badge],
    querySelectorAll(selector) {
      assert.equal(selector, ".lh-cur-head .lh-cur-pill-done,.lh-cur-done-big");
      return this.badges;
    }
  };
  for (const node of [panel, badge]) {
    node.getBoundingClientRect = () => ({width: node.visible ? 566 : 0, height: node.visible ? 40 : 0});
    nodes.push(node);
  }
  const scopedRoot = (panels, elements) => ({querySelectorAll(selector) {
    if (selector === ".lh-cur-sec") return panels;
    if (selector === "*") return elements;
    throw Error("Unexpected DOM query: " + selector);
  }});
  const shadow = scopedRoot([panel], nodes);
  shadow.mode = "open";
  const host = {tagName: "SPAN", className: "lhdao-inline-task", shadowRoot: shadow};
  const outerHost = options.nested ? {tagName: "DIV", shadowRoot: scopedRoot([], [host])} : host;
  const document = scopedRoot(options.lightDom ? [panel] : [], options.lightDom ? nodes : [outerHost]);
  document.body = {};
  let listener;
  const runtimeMessages = [];
  const context = vm.createContext({
    console, URL, document, location: {href: options.url || target + "?s=46"}, window: {},
    getComputedStyle: node => ({display: node.visible === false ? "none" : "block", visibility: "visible"}),
    MutationObserver: class {observe() {} disconnect() {}},
    setTimeout: () => 1, clearTimeout() {},
    chrome: {runtime: {onMessage: {addListener(fn) {listener = fn;}}, async sendMessage(message) {
      runtimeMessages.push(message.type);
      assert.equal(message.type, "GET_CONTENT_SETTINGS");
      return {ok: true, paused: false};
    }}}
  });
  vm.runInContext(fs.readFileSync(path.join(root, "content/x.js"), "utf8"), context);
  await new Promise(resolve => setImmediate(resolve));
  const message = {type: "CHECK_X_TASK_WIDGET_COMPLETION", platform: "lighthouse", runId: "run-shadow",
    task: {taskKey: "order-shadow", tweetUrl: target}};
  function dispatch(payload) {
    let result;
    assert.equal(listener(payload, {}, response => {result = response;}), true);
    assert.ok(result, "Read-only completion responds synchronously");
    return result;
  }
  return {panel, badge, host, shadow, document, runtimeMessages, dispatch, check: () => dispatch(message)};
}

test("production listener reads the completed current-task panel inside its open shadow root", async () => {
  const p = await shadowCompletionPage();
  assert.equal(p.document.querySelectorAll(".lh-cur-sec").length, 0);
  const result = p.check();
  assert.equal(result.completed, true);
  assert.equal(result.evidence.taskKey, "order-shadow");
  assert.equal(result.evidence.tweetUrl, "https://x.com/0xlove428888/status/2110658204187406601");
  assert.equal(result.evidence.rewardPending, true);
  assert.deepEqual(p.runtimeMessages, ["GET_CONTENT_SETTINGS"]);
});

test("nested open shadow roots and ordinary DOM both expose completion", async () => {
  for (const options of [{nested: true}, {lightDom: true}]) {
    assert.equal((await shadowCompletionPage(options)).check().completed, true);
  }
});

test("passive checks see a shadow panel change from an individual completed step to whole-task completion", async () => {
  const p = await shadowCompletionPage();
  const doneText = p.panel.innerText;
  p.panel.innerText = "当前任务 评论 已完成 点赞 待完成";
  p.panel.badges = [];
  assert.equal(p.check().completed, false);
  p.panel.innerText = doneText;
  p.panel.badges = [p.badge];
  assert.equal(p.check().completed, true);
  assert.deepEqual(p.runtimeMessages, ["GET_CONTENT_SETTINGS"]);
});

test("a shadow completion badge alone is sufficient without payment text", async () => {
  const p = await shadowCompletionPage();
  p.panel.innerText = "当前任务 已完成";
  assert.equal(p.check().completed, true);
  assert.equal(p.check().evidence.rewardPending, false);
});

test("hidden shadow panels and inaccessible roots do not produce completion", async () => {
  const p = await shadowCompletionPage();
  p.panel.visible = false;
  assert.equal(p.check().completed, false);
  p.panel.visible = true;
  p.badge.visible = false;
  assert.equal(p.check().completed, false);
  p.badge.visible = true;
  p.host.shadowRoot = null;
  assert.equal(p.check().completed, false);
});

test("completed shadow panel still requires the bound tweet and an active run", async () => {
  assert.equal((await shadowCompletionPage({url: "https://x.com/other/status/999"})).check().completed, false);
  const p = await shadowCompletionPage();
  p.dispatch({type: "CANCEL_X_RUN", runId: "run-shadow"});
  assert.equal(p.check().completed, false);
  const paused = await shadowCompletionPage();
  paused.dispatch({type: "AUTOMATION_PAUSE_CHANGED", paused: true});
  assert.equal(paused.check().completed, false);
});

for (const outcome of ["widget", "lighthouse", "timeout", "stop"]) {
  test(`passive submitted-order wait only reads platform state: ${outcome}`, async () => {
    let now = 0, active = true; const sent = [], latches = [];
    const c = load("background.js", "waitForPassiveTaskCompletion", {
      Date: {now: () => now}, runtimeState: {xTabId: 12, currentTask: {taskKey: "order"}},
      log() {}, delay: async ms => {now += ms;},
      latchLighthouseCompletion(evidence) {latches.push(evidence);return evidence.taskKey === "order";},
      async sendToTab(id, message) {
        sent.push(message.type);
        if (outcome === "stop") active = false;
        if (now >= 8000 && outcome === "widget" && id === 12) return {completed: true, evidence: {taskKey: "order",source: "lighthouse_x_widget"}};
        if (now >= 8000 && outcome === "lighthouse" && id === 11) return {completed: true, evidence: {taskKey: "order"}};
        return {ok: true,completed: false};
      }
    });
    const result = await c.waitForPassiveTaskCompletion("run",{},11,()=>active);
    assert.ok(sent.every(type => ["CHECK_X_TASK_WIDGET_COMPLETION","CHECK_LIGHTHOUSE_OFFICIAL_COMPLETION"].includes(type)));
    if (["widget","lighthouse"].includes(outcome)) {assert.equal(result.completed,true);assert.equal(latches.length,1);}
    if (outcome === "timeout") {assert.equal(result.timedOut,true);assert.equal(latches.length,0);}
    if (outcome === "stop") {assert.equal(result.cancelled,true);assert.equal(sent.length,1);}
  });
}
