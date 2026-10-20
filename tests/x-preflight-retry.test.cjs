"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(process.env.LIGHTHOUSE_TEST_SOURCE_ROOT || path.join(__dirname, "../src"), "content/x.js"), "utf8");
const ID = "2111837370354167816";
const ALIAS = `https://x.com/i/status/${ID}`;
const TARGET = `https://x.com/lubihuangdai888/status/${ID}`;
const OTHER = "https://x.com/lubihuangdai888/status/2111837370354167817";
const LIKE = "当前任务 进行中 +0.2LUX 要完成 点赞 待完成 停留时长 15/10s 完成上面步骤解锁";
const COMMENT = LIKE.replace("点赞 待完成", "评论 待完成");
const ALL = LIKE.replace("点赞 待完成", "关注 待完成 点赞 待完成 评论 待完成");
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const clone = value => JSON.parse(JSON.stringify(value));

// Keep the production listener, runReply, requirement polling/parser and step
// cache. Only DOM reads, time and individual browser-action boundaries are fake.
function page(options = {}) {
  let listener;
  const calls = { ready: 0, login: 0, scrape: 0, reading: 0, requirementReads: 0,
    follow: 0, like: 0, dedupe: 0, ai: 0, compose: 0, fill: 0, post: 0 };
  const fixture = { elapsed: 0, panelText: options.panelText ?? LIKE,
    errors: {}, results: {}, gates: {}, location: { href: TARGET }, calls, logs: [] };
  class FakeDate extends Date { static now() { return 100000 + fixture.elapsed; } }
  const body = { innerText: "fixture X page", querySelectorAll: () => [] };
  const panel = { parentElement: body, visible: true, className: "lh-cur-sec",
    get innerText() { calls.requirementReads++; return fixture.panelText; },
    get textContent() { return this.innerText; },
    matches: selector => selector === ".lh-cur-sec", closest: () => panel,
    querySelectorAll: () => [button], querySelector: () => button };
  const button = { parentElement: panel, visible: true, disabled: true,
    innerText: "完成上面步骤解锁", textContent: "完成上面步骤解锁",
    matches: selector => selector.includes("lh-cur-btn"), closest: () => panel,
    getAttribute: () => null };
  const syncBoundary = phase => {
    calls[phase]++;
    if (fixture.errors[phase]) throw new Error(fixture.errors[phase]);
  };
  const boundary = async phase => {
    syncBoundary(phase);
    if (fixture.gates[phase]) await fixture.gates[phase].promise;
    if (fixture.errors[phase]) throw new Error(fixture.errors[phase]);
    return fixture.results[phase] || (phase === "dedupe" ? { replied: false } : { ok: true, message: `${phase} confirmed` });
  };
  const chrome = { runtime: { onMessage: { addListener(fn) { listener = fn; } }, async sendMessage(message) {
    if (message.type === "CONTENT_LOG") { fixture.logs.push(message.text); return { ok: true }; }
    if (message.type === "GENERATE_AI_REPLY") {
      const result = await boundary("ai");
      return { replyText: "fixture reply", ...result };
    }
    throw new Error(`Unexpected runtime message ${message.type}`);
  } } };
  const context = vm.createContext({ console, URL, Date: FakeDate, chrome, fixture,
    location: fixture.location, document: { body, querySelector: () => null }, window: {},
    boundary, syncBoundary, fixturePanel: panel,
    fixtureElements: selector => selector.includes("lh-cur-btn") ? [button] : selector.includes("lh-cur-sec") ? [panel] : [],
    tick: async ms => { fixture.elapsed += ms; },
    fetch: async () => { throw new Error("Network forbidden in preflight retry tests"); },
  });
  const adapters = `
    function startTaskWidgetAssist() {}
    function disableTaskWidgetAssist() {}
    waitForPageReady = () => boundary("ready");
    assertNotLoginWall = () => syncBoundary("login");
    scrapeCurrentTweet = () => { syncBoundary("scrape"); return {url: location.href, text: "fixture tweet"}; };
    simulateReadingBeforeReply = () => boundary("reading");
    queryAccessibleElements = fixtureElements;
    isVisible = node => Boolean(node && node.visible !== false);
    wait = tick;
    followCurrentTweetAuthorIfNeeded = () => boundary("follow");
    likeCurrentTweetIfNeeded = () => boundary("like");
    detectExistingReplyBeforeWriting = () => boundary("dedupe");
    openReplyComposer = () => boundary("compose");
    fillReplyText = () => boundary("fill");
    clickPostButtonAndVerify = () => boundary("post");
  `;
  const end = source.lastIndexOf("})();");
  vm.runInContext(source.slice(0, end) + adapters + source.slice(end), context);
  const base = { type: "RUN_X_REPLY", platform: "lighthouse", runId: "preflight-run",
    task: { taskKey: "preflight-order", tweetUrl: ALIAS, taskType: options.taskType || "点赞" },
    settings: { replyMode: "post", replyProvider: "native" } };
  return { fixture, calls, base,
    send: (patch = {}) => new Promise(resolve => listener({ ...base, ...patch }, {}, resolve)),
  };
}

function assertNoEffects(p) {
  for (const phase of ["follow", "like", "dedupe", "ai", "compose", "fill", "post"]) assert.equal(p.calls[phase], 0, phase);
}

test("normal composite requirements execute each required action once and retain the successful cache", async () => {
  const p = page({ panelText: ALL, taskType: "关注+点赞+评论" });
  const first = await p.send();
  const again = await p.send({ task: { ...p.base.task, tweetUrl: TARGET } });
  assert.equal(first.ok, true, first.message);
  assert.deepEqual(clone(again), clone(first));
  for (const phase of ["ready", "follow", "like", "ai", "compose", "fill", "post"]) assert.equal(p.calls[phase], 1, phase);
});

for (const [name, panelText, taskType, error] of [
  ["timeout", "当前任务 加载中", "点赞", /任务要求超时/],
  ["declared requirement conflict", LIKE, "评论+点赞", /任务要求冲突/],
  ["unsupported action", LIKE.replace("点赞 待完成", "转发 待完成"), "转发", /尚未支持的动作/],
]) {
  test(`proven ${name} before actions can reread requirements on the same run`, async () => {
    const p = page({ panelText, taskType });
    const failed = await p.send();
    assert.equal(failed.ok, false);
    assert.match(failed.message, error);
    assert.equal(failed.actionAttempted, false);
    assertNoEffects(p);
    p.fixture.panelText = ALL;
    const retried = await p.send();
    assert.equal(retried.ok, true, retried.message);
    assert.equal(p.calls.ready, 2);
    assert.equal(p.calls.follow, 1);
    assert.equal(p.calls.like, 1);
    assert.equal(p.calls.post, 1);
    assert.equal((await p.send()).ok, true);
    assert.equal(p.calls.post, 1, "successful retry is cached");
  });
}

for (const phase of ["ready", "login", "scrape", "reading"]) {
  test(`${phase} failure is reported as no-action and allows the same-run retry`, async () => {
    const p = page();
    p.fixture.errors[phase] = `${phase} not ready`;
    const failed = await p.send();
    assert.equal(failed.ok, false);
    assert.equal(failed.actionAttempted, false);
    assert.match(failed.message, new RegExp(`${phase} not ready`));
    assertNoEffects(p);
    delete p.fixture.errors[phase];
    assert.equal((await p.send()).ok, true);
    assert.equal(p.calls.like, 1);
    assert.equal(p.calls.ready, 2);
  });
}

test("concurrent duplicate preflight failures share one attempt; a later alias retry rereads once", async () => {
  const p = page({ panelText: "当前任务 加载中" });
  p.fixture.gates.ready = deferred();
  const first = p.send();
  await flush();
  const second = p.send({ task: { ...p.base.task, tweetUrl: TARGET } });
  assert.equal(p.calls.ready, 1);
  p.fixture.gates.ready.resolve();
  const results = await Promise.all([first, second]);
  assert.equal(results[0].actionAttempted, false);
  assert.deepEqual(clone(results[0]), clone(results[1]));
  assert.equal(p.calls.ready, 1);
  assertNoEffects(p);
  delete p.fixture.gates.ready;
  p.fixture.panelText = LIKE;
  const retried = await Promise.all([p.send(), p.send()]);
  assert.equal(retried[0].ok, true);
  assert.equal(retried[1].ok, true);
  assert.equal(p.calls.ready, 2);
  assert.equal(p.calls.like, 1);
});

for (const phase of ["follow", "like", "ai", "compose", "fill", "post"]) {
  for (const mode of phase === "follow" || phase === "like" || phase === "post" ? ["return", "throw"] : ["throw"]) {
    test(`${phase} ${mode} failure is not relabelled no-action and remains cached`, async () => {
      const p = page({ panelText: ALL, taskType: "关注+点赞+评论" });
      if (mode === "throw") p.fixture.errors[phase] = `${phase} outcome unknown`;
      else p.fixture.results[phase] = { ok: false, message: `${phase} outcome unknown` };
      const failed = await p.send();
      assert.equal(failed.ok, false);
      assert.notEqual(failed.actionAttempted, false);
      assert.equal(p.calls[phase], 1);
      delete p.fixture.errors[phase];
      delete p.fixture.results[phase];
      const duplicate = await p.send();
      assert.deepEqual(clone(duplicate), clone(failed));
      assert.equal(p.calls.ready, 1);
      assert.equal(p.calls[phase], 1);
    });
  }
}

test("AI refusal on a pure-comment task preserves uncertainty despite no prior social click", async () => {
  const p = page({ panelText: COMMENT, taskType: "评论" });
  p.fixture.results.ai = { ok: false, error: "AI unavailable" };
  const failed = await p.send();
  assert.equal(failed.ok, false);
  assert.notEqual(failed.actionAttempted, false);
  assert.equal(p.calls.like, 0);
  assert.equal(p.calls.post, 0);
  delete p.fixture.results.ai;
  assert.equal((await p.send()).ok, false);
  assert.equal(p.calls.ai, 1);
});

test("STOP during preparation blocks late actions and the old run cannot replay after resume", async () => {
  const p = page();
  p.fixture.gates.ready = deferred();
  const pending = p.send();
  await flush();
  await p.send({ type: "AUTOMATION_PAUSE_CHANGED", paused: true });
  p.fixture.gates.ready.resolve();
  const cancelled = await pending;
  assert.equal(cancelled.ok, false);
  assert.notEqual(cancelled.actionAttempted, false);
  assertNoEffects(p);
  assert.equal((await p.send()).cancelled, true);
  await p.send({ type: "AUTOMATION_PAUSE_CHANGED", paused: false });
  assert.equal((await p.send()).cancelled, true);
  assertNoEffects(p);
  assert.equal((await p.send({ runId: "new-run" })).ok, true);
  assert.equal(p.calls.like, 1);
});

test("different run conflicts with an in-flight preparation and can execute after proven no-action settles", async () => {
  const p = page({ panelText: "当前任务 加载中" });
  p.fixture.gates.ready = deferred();
  const pending = p.send();
  await flush();
  const blocked = await p.send({ runId: "another-run" });
  assert.equal(blocked.conflict, true);
  assert.equal(p.calls.ready, 1);
  p.fixture.gates.ready.resolve();
  assert.equal((await pending).actionAttempted, false);
  p.fixture.panelText = LIKE;
  assert.equal((await p.send({ runId: "another-run" })).ok, true);
  assert.equal(p.calls.ready, 2);
  assert.equal(p.calls.like, 1);
});

test("a late cancelled preflight cannot clear the active lock belonging to a new run", async () => {
  const p = page();
  const oldGate = deferred();
  p.fixture.gates.ready = oldGate;
  const oldRun = p.send();
  await flush();
  await p.send({ type: "AUTOMATION_PAUSE_CHANGED", paused: true });
  await p.send({ type: "AUTOMATION_PAUSE_CHANGED", paused: false });
  delete p.fixture.gates.ready;
  p.fixture.gates.like = deferred();
  const newRun = p.send({ runId: "new-run" });
  for (let i = 0; i < 5 && !p.calls.like; i++) await flush();
  assert.equal(p.calls.like, 1);
  oldGate.resolve();
  assert.equal((await oldRun).ok, false);
  assert.equal((await p.send({ runId: "third-run" })).conflict, true);
  const duplicate = p.send({ runId: "new-run" });
  p.fixture.gates.like.resolve();
  assert.equal((await newRun).ok, true);
  assert.equal((await duplicate).ok, true);
  assert.equal(p.calls.like, 1);
});

test("target changes during preparation stay cancelled rather than becoming a retryable preflight error", async () => {
  const p = page();
  p.fixture.gates.ready = deferred();
  const pending = p.send();
  await flush();
  p.fixture.location.href = OTHER;
  p.fixture.gates.ready.resolve();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.message, /目标推文已变化/);
  assert.notEqual(result.actionAttempted, false);
  assertNoEffects(p);
});
