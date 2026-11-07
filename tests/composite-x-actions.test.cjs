"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/content/x.js"), "utf8");
const target = "https://x.com/zhangtingt5977/status/123456";
const composite = "当前任务 进行中 加密胖东来 完成下方动作领取奖励 +0.2LUX 要完成 评论 待完成 点赞 已完成 停留时长 245/10s 完成上面步骤解锁";
const likeOnly = "当前任务 进行中 +0.2LUX 要完成 点赞 待完成 停留时长 15/10s 完成上面步骤解锁";
const clone = (value) => JSON.parse(JSON.stringify(value));

function harness(options = {}) {
  let elapsed = 0, listener;
  const calls = { like: 0, follow: 0, dedupe: 0, ai: 0, compose: 0, fill: 0, post: 0, physicalLike: 0, submit: 0 }, logs = [];
  const counters = calls;
  class FakeDate extends Date { static now() { return 100000 + elapsed; } }
  const panel = { parentElement: null,
    get innerText() { return calls.submit ? "当前任务 +0.2LUX 验证中" : options.panel ? options.panel(elapsed) : composite; },
    querySelectorAll: selector => selector.includes("lh-cur-pill-done") ? [] : [button]
  };
  const button = { parentElement: panel,
    get disabled() { return options.verifyReadyAt === undefined || elapsed < options.verifyReadyAt || calls.submit > 0; },
    get innerText() { return this.disabled ? "完成上面步骤解锁" : "验证发奖"; },
    getAttribute: () => null, matches: () => true,
    getBoundingClientRect: () => ({left: 100, top: 100, width: 120, height: 40}),
    click() { calls.submit++; }
  };
  const xinhuoPanel = { innerText: "薪火互动任务助手 当前任务 reid_vale 点赞任务 该任务已完成", querySelectorAll: () => [] };
  const fakeDocument = { body: {}, querySelectorAll: () => [] };
  const chrome = { runtime: { onMessage: { addListener(fn) { listener = fn; } }, async sendMessage(message) {
    if (message.type === "CONTENT_LOG") { logs.push(message.text); return {ok: true}; }
    if (message.type === "GENERATE_AI_REPLY") { calls.ai += 1; return {ok: true, replyText: "这条细节说得挺实在"}; }
    throw Error(`Unexpected runtime message: ${message.type}`);
  } } };
  const c = vm.createContext({ console, URL, Date: FakeDate, chrome, document: fakeDocument,
    location: {href: target}, window: {}, setTimeout, clearTimeout,
    fetch: async () => { throw Error("No network in composite action tests"); },
    options, counters, fixturePanel: panel, fixtureWidget: options.xinhuoCompleted ? xinhuoPanel : panel,
    fixtureVerifyButton: () => button.disabled ? [] : [button],
    fixtureButtons: () => options.noOfficialButton ? [] : (options.twoPanels ? [button, {parentElement: {...panel, innerText: likeOnly}}] : [button]),
    tick: async (ms) => {
      elapsed += ms;
      if (options.cancelAt !== undefined && elapsed >= options.cancelAt) {
        listener({type: "CANCEL_X_RUN", runId: "run-composite"}, {}, () => {});
      }
    }
  });
  const adapters = `
    const originalLike = likeCurrentTweetIfNeeded;
    waitForPageReady = async () => {};
    assertNotLoginWall = () => {};
    scrapeCurrentTweet = () => ({url: location.href, text: "fixture tweet"});
    simulateReadingBeforeReply = async () => {};
    queryAccessibleElements = (selector) => selector === "button.lh-cur-btn" ? fixtureButtons()
      : selector === ".lh-cur-sec" ? [fixturePanel]
      : selector === "button.lh-cur-btn.on" ? fixtureVerifyButton() : [];
    isVisible = () => true;
    wait = tick;
    likeCurrentTweetIfNeeded = async () => { counters.like++; return options.alreadyLiked ? originalLike()
      : options.likeResult || {ok: true, status: "already_liked", message: "当前推文已点赞"}; };
    followCurrentTweetAuthorIfNeeded = async () => { counters.follow++; return {ok: true}; };
    detectExistingReplyBeforeWriting = async () => { counters.dedupe++; return options.dedupe || {replied: false}; };
    openReplyComposer = async () => { counters.compose++; };
    fillReplyText = async () => { counters.fill++; };
    clickPostButtonAndVerify = async () => { counters.post++; return options.postResult || {ok: true, message: "已确认回复发送成功"}; };
    if (!options.lifecycle) findDocumentVerifyActionButton = () => null;
    findLighthouseTaskWidget = () => fixtureWidget;
    revealTaskWidgetArea = async () => fixtureWidget;
    if (!options.lifecycle) findVerifyActionButton = () => null;
    findMainTweetArticle = () => ({querySelector: selector => options.alreadyLiked && selector === '[data-testid="unlike"]' ? {} : null});
    if (!options.alreadyLiked) isTweetAlreadyLiked = () => false;
    findTweetLikeButton = () => ({});
    clickElement = async () => { counters.physicalLike++; };
    waitForLikeApplied = async () => false;
    globalThis.testApi = {inferTaskActions, parseCurrentTaskRequirements, describeTaskWidgetCompletionBlock, originalLike};
  `;
  const withoutObserver = source.replace("  startTaskWidgetAssist();", "  // Observer omitted in this offline VM.");
  const end = withoutObserver.lastIndexOf("})();");
  vm.runInContext(withoutObserver.slice(0, end) + adapters + withoutObserver.slice(end), c);
  function message(type, taskType = "评论+点赞") {
    return new Promise((resolve) => listener({type, runId: "run-composite", platform: "lighthouse",
      task: {taskKey: "claimed-task", taskType, tweetUrl: target, claimed: true, seatLocked: true},
      settings: {replyMode: "post", replyProvider: "native", actionDelayMs: 500}}, {}, resolve));
  }
  return { c, calls, logs, message, elapsed: () => elapsed, actions: () => c.testApi.inferTaskActions() };
}

test("live composite requirements retain both actions even beyond the former 100-character window", () => {
  const h = harness({panel: () => composite.replace("要完成", "要完成 " + "· ".repeat(100))});
  const actions = h.actions();
  assert.equal(actions.complete, true);
  assert.equal(actions.needsComment, true);
  assert.equal(actions.needsLike, true);
  assert.equal(actions.source, "x_current_task");
  assert.deepEqual(clone(actions.steps).map((s) => [s.label, s.completed]), [["评论", false], ["点赞", true]]);
});

test("late and partial widget requirements hydrate before composite actions execute", async () => {
  const h = harness({panel: (ms) => ms < 500 ? "当前任务 加载中" : ms < 1500 ? "当前任务 +0.2LUX 要完成 点赞 已完成" : composite});
  const result = await h.message("RUN_X_REPLY");
  assert.equal(result.ok, true);
  assert.equal(h.calls.like, 1);
  assert.equal(h.calls.post, 1);
  assert.ok(h.elapsed() >= 2250);
  assert.equal(result.taskActions.needsComment, true);
  assert.match(h.logs[0], /官网当前任务面板/);
  assert.match(h.logs[0], /评论.*点赞/);
});

test("a composite list task cannot be downgraded by a briefly complete pure-like widget", async () => {
  const h = harness({panel: (ms) => ms < 2000 ? likeOnly : composite});
  const result = await h.message("RUN_X_REPLY");
  assert.equal(result.ok, true);
  assert.equal(h.calls.post, 1);
  assert.ok(h.elapsed() >= 2750);
});

test("conflicting composite declaration and stable pure-like panel do not silently downgrade or add a comment", async () => {
  const h = harness({panel: () => likeOnly});
  const result = await h.message("RUN_X_REPLY");
  assert.equal(result.ok, false);
  assert.match(result.message, /任务要求冲突/);
  assert.equal(h.calls.like, 0);
  assert.equal(h.calls.ai, 0);
  assert.equal(h.calls.post, 0);
  assert.equal(h.elapsed(), 15000);
});

test("a matching pure-like declaration proceeds after stable official requirements without comment", async () => {
  const h = harness({panel: () => likeOnly});
  const result = await h.message("RUN_X_REPLY", "点赞互动");
  assert.equal(result.ok, true);
  assert.equal(h.calls.post, 0);
  assert.equal(h.elapsed(), 750);
});

test("a matching pure-comment task posts its required comment without adding a like", async () => {
  const h = harness({panel: () => likeOnly.replace("点赞 待完成", "评论 待完成")});
  const result = await h.message("RUN_X_REPLY", "评论");
  assert.equal(result.ok, true);
  assert.equal(h.calls.like, 0);
  assert.equal(h.calls.ai, 1);
  assert.equal(h.calls.post, 1);
  assert.equal(h.elapsed(), 750);
});

for (const options of [{noOfficialButton: true}, {twoPanels: true},
  {panel: () => "当前任务 +0.2LUX 要完成 点赞 待完成"},
  {panel: () => likeOnly.replace("要完成", "要完成 评论 加载中")},
  {panel: () => likeOnly.replace("要完成", "要完成 投票 待完成")}
]) {
  test("untrusted, ambiguous or incomplete requirements block all actions " + JSON.stringify(options), async () => {
    const h = harness(options);
    const result = await h.message("RUN_X_REPLY", "点赞互动");
    assert.equal(result.ok, false);
    assert.match(result.message, /任务要求超时/);
    assert.equal(h.calls.like, 0);
    assert.equal(h.calls.ai, 0);
    assert.equal(h.calls.post, 0);
  });
}

test("a failed required like never becomes composite success or causes a comment", async () => {
  const h = harness({likeResult: {ok: false, message: "点赞未确认"}});
  const result = await h.message("RUN_X_REPLY");
  assert.equal(result.ok, false);
  assert.equal(h.calls.post, 0);
  assert.match(result.message, /点赞未确认/);
});

test("a failed comment result never becomes overall success", async () => {
  const h = harness({postResult: {ok: false, message: "评论未发送"}});
  const result = await h.message("RUN_X_REPLY");
  assert.equal(h.calls.like, 1);
  assert.equal(h.calls.post, 1);
  assert.equal(result.ok, false);
  assert.match(result.message, /评论未发送/);
});

test("reply dedupe skips only the duplicate comment and preserves required like verification", async () => {
  const h = harness({dedupe: {replied: true, source: "local_reply_history", replyText: "existing"}});
  const result = await h.message("RUN_X_REPLY");
  assert.equal(result.ok, true);
  assert.equal(result.deduped, true);
  assert.equal(h.calls.like, 1);
  assert.equal(h.calls.post, 0);
  assert.equal(result.taskActions.needsComment, true);
});

test("officially completed current-task comment is never posted again when local history is empty", async () => {
  const h = harness({panel: () => composite.replace("评论 待完成", "评论 已完成")});
  const result = await h.message("RUN_X_REPLY");
  assert.equal(result.ok, true);
  assert.equal(result.deduped, true);
  assert.equal(result.existingReply.source, "x_current_task");
  assert.equal(h.calls.like, 1);
  assert.equal(h.calls.dedupe, 0);
  assert.equal(h.calls.ai, 0);
  assert.equal(h.calls.post, 0);
});

test("cancellation during requirement hydration performs no actions", async () => {
  const h = harness({panel: () => "当前任务 加载中", cancelAt: 500});
  const result = await h.message("RUN_X_REPLY");
  assert.equal(result.ok, false);
  assert.match(result.message, /取消/);
  assert.equal(h.calls.like, 0);
  assert.equal(h.calls.post, 0);
  assert.equal(h.elapsed(), 500);
});

test("concurrent duplicate composite requests still execute each action once", async () => {
  const h = harness();
  const [first, second] = await Promise.all([h.message("RUN_X_REPLY"), h.message("RUN_X_REPLY")]);
  assert.equal(first.ok, true);
  assert.deepEqual(clone(first), clone(second));
  assert.equal(h.calls.like, 1);
  assert.equal(h.calls.post, 1);
});

test("completion timeout identifies the unfinished comment while dwell has already been satisfied", async () => {
  const h = harness();
  const result = await h.message("COMPLETE_X_TASK_WIDGET");
  assert.equal(result.ok, false);
  assert.match(result.message, /未完成动作：评论（待完成）/);
  assert.match(result.message, /停留时长已满足 245\/10s/);
  assert.doesNotMatch(result.message, /停留时长尚不足/);
});

test("unverified physical like clicks are not reported as successful", async () => {
  const h = harness();
  const result = await h.c.testApi.originalLike({actionDelayMs: 500});
  assert.equal(h.calls.physicalLike, 1);
  assert.equal(result.ok, false);
  assert.equal(result.status, "clicked_unverified");
});

test("an existing X like does not submit or count completion while Lighthouse still marks it pending", async () => {
  const h = harness({alreadyLiked: true, lifecycle: true, panel: () => likeOnly.replace("15/10s", "50/10s")});
  const action = await h.message("RUN_X_REPLY", "点赞互动");
  assert.equal(action.like.status, "already_liked");
  const result = await h.message("COMPLETE_X_TASK_WIDGET", "点赞互动");
  assert.equal(result.ok, false);
  assert.notEqual(result.completed, true);
  assert.match(result.message, /未完成动作：点赞（待完成）/);
  assert.match(result.message, /停留时长已满足 50\/10s/);
  assert.equal(h.calls.physicalLike, 0);
  assert.equal(h.calls.submit, 0);
  assert.equal(h.calls.post, 0);
});

test("an existing X like submits once after Lighthouse recognizes it and unlocks verification", async () => {
  const h = harness({alreadyLiked: true, lifecycle: true, verifyReadyAt: 2250,
    panel: ms => ms < 2250 ? likeOnly : likeOnly.replace("点赞 待完成", "点赞 已完成")});
  await h.message("RUN_X_REPLY", "点赞互动");
  const [first, duplicate] = await Promise.all([
    h.message("COMPLETE_X_TASK_WIDGET", "点赞互动"), h.message("COMPLETE_X_TASK_WIDGET", "点赞互动")
  ]);
  assert.equal(first.ok, true);
  assert.equal(first.submitted, true);
  assert.notEqual(first.completed, true, "a submission receipt alone is not official completion");
  assert.deepEqual(clone(first), clone(duplicate));
  assert.ok(h.elapsed() >= 2250);
  assert.equal(h.calls.physicalLike, 0);
  assert.equal(h.calls.submit, 1);
});

test("a completed Xinhuo widget cannot complete the pending Lighthouse like on the same X page", async () => {
  const h = harness({alreadyLiked: true, lifecycle: true, xinhuoCompleted: true, panel: () => likeOnly});
  await h.message("RUN_X_REPLY", "点赞互动");
  const result = await h.message("COMPLETE_X_TASK_WIDGET", "点赞互动");
  assert.equal(result.ok, false);
  assert.notEqual(result.completed, true);
  assert.notEqual(result.submitted, true);
  assert.match(result.message, /未完成动作：点赞（待完成）/);
  assert.equal(h.calls.physicalLike, 0);
  assert.equal(h.calls.submit, 0);
});
