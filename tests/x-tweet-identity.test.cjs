"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ID = "2111837370354167816";
const ALIAS = `https://x.com/i/status/${ID}`;
const CANONICAL = `https://x.com/lubihuangdai888/status/${ID}`;
const OTHER = "https://x.com/lubihuangdai888/status/2111837370354167817";
const source = fs.readFileSync(path.join(process.env.LIGHTHOUSE_TEST_SOURCE_ROOT || path.join(__dirname, "../src"), "content/x.js"), "utf8");
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

// Exercise the production listener, step cache, target guard and completion
// reader. Only browser actions, widget DOM and observer startup are local fakes.
function page(options = {}) {
  let listener;
  const done = { innerText: "已完成", visible: true };
  const widget = { innerText: "当前任务 已完成", visible: true, querySelectorAll: () => [done] };
  const fixture = { location: { href: options.actual || CANONICAL }, panels: [widget], composer: false, actions: [] };
  const context = vm.createContext({
    console, URL, Date, fixture, location: fixture.location,
    document: { querySelector: () => fixture.composer ? {} : null },
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
    fetch: async () => { throw new Error("Network forbidden in tweet identity tests"); },
    fixtureAction: async (step, task) => {
      fixture.actions.push({ step, task });
      return options.onAction ? options.onAction(fixture, step, task) : { ok: true };
    },
  });
  const adapters = `
    function startTaskWidgetAssist() {}
    function runReply(task) { return fixtureAction("reply", task); }
    function runTaskWidgetClaim(task) { return fixtureAction("claim", task); }
    function completeTaskWidgetLifecycle(_settings, task) { return fixtureAction("complete", task); }
    function queryAccessibleElements(selector) { return selector === ".lh-cur-sec" ? fixture.panels : []; }
    function isVisible(node) { return Boolean(node && node.visible !== false); }
    globalThis.testApi = { normalizeTweetUrl, assertActiveRun };
  `;
  const end = source.lastIndexOf("})();");
  vm.runInContext(source.slice(0, end) + adapters + source.slice(end), context);
  fixture.hooks = context.testApi;
  const base = { type: "RUN_X_REPLY", platform: "lighthouse", runId: "identity-run",
    task: { taskKey: "identity-order", tweetUrl: options.target || ALIAS }, settings: {} };
  return { fixture, hooks: context.testApi, base,
    send: (patch = {}) => new Promise(resolve => listener({ ...base, ...patch }, {}, resolve)),
  };
}

for (const type of ["RUN_X_REPLY", "RUN_X_WIDGET_CLAIM", "CLICK_X_TASK_VERIFY", "COMPLETE_X_TASK_WIDGET"]) {
  test(`${type}: observed i/status to author redirect executes once`, async () => {
    const p = page();
    const result = await p.send({ type });
    assert.equal(result.ok, true, result.message);
    assert.equal(p.fixture.actions.length, 1);
    assert.equal(p.fixture.actions[0].task.tweetUrl, ALIAS, "the stored navigation URL is preserved");
  });
}

test("normalization preserves navigation handles and exposes a stable identity only on request", () => {
  const p = page();
  assert.equal(p.hooks.normalizeTweetUrl(CANONICAL), CANONICAL);
  assert.equal(p.hooks.normalizeTweetUrl(CANONICAL, true), ALIAS);
  assert.equal(p.hooks.normalizeTweetUrl(ALIAS), ALIAS);
  assert.equal(p.hooks.normalizeTweetUrl(`https://twitter.com/lubihuangdai888/status/${ID}?s=20#reply`), CANONICAL);
  assert.equal(p.hooks.normalizeTweetUrl(`${CANONICAL}/photo/1`, true), ALIAS);
});

for (const actual of [CANONICAL, `https://twitter.com/lubihuangdai888/status/${ID}`, `${CANONICAL}/photo/1?s=20`]) {
  test(`the same complete status ID is accepted at ${actual}`, async () => {
    const p = page({ actual });
    assert.equal((await p.send()).ok, true);
    assert.equal(p.fixture.actions.length, 1);
  });
}

for (const [name, url] of [
  ["different ID", OTHER],
  ["non-HTTPS", CANONICAL.replace("https:", "http:")],
  ["lookalike host", CANONICAL.replace("x.com", "x.com.example.org")],
  ["embedded X URL", `https://example.org/next?target=${CANONICAL}`],
  ["non-default port", CANONICAL.replace("x.com", "x.com:444")],
  ["URL credentials", CANONICAL.replace("x.com", "someone@x.com")],
  ["partial numeric ID", `${CANONICAL}abc`],
  ["extra path", `${CANONICAL}/unrelated`],
]) {
  for (const side of ["target", "actual"]) {
    test(`${name} in ${side} is rejected before an action`, async () => {
      const p = page({ target: CANONICAL, actual: CANONICAL, [side]: url });
      const result = await p.send();
      assert.equal(result.ok, false);
      assert.equal(result.actionAttempted, false);
      assert.equal(p.fixture.actions.length, 0);
    });
  }
}

for (const patch of [{ platform: "xinhuo" }, { runId: "" }, { task: {} }]) {
  test(`invalid request identity is a proven pre-action refusal: ${JSON.stringify(patch)}`, async () => {
    const p = page({ target: CANONICAL });
    const result = await p.send(patch);
    assert.equal(result.ok, false);
    assert.equal(result.actionAttempted, false);
    assert.equal(p.fixture.actions.length, 0);
  });
}

for (const taskKey of ["identity-order", ""]) {
  test(`settled step cannot replay under another handle (taskKey: ${taskKey || "absent"})`, async () => {
    const p = page({ actual: ALIAS });
    assert.equal((await p.send({ task: { taskKey, tweetUrl: ALIAS } })).ok, true);
    p.fixture.location.href = CANONICAL;
    assert.equal((await p.send({ task: { taskKey, tweetUrl: CANONICAL } })).ok, true);
    assert.equal(p.fixture.actions.length, 1);
  });
}

test("a canonical redirect during an in-flight step shares its existing result", async () => {
  const gate = deferred();
  const p = page({ actual: ALIAS, onAction: () => gate.promise });
  const first = p.send();
  await flush();
  assert.equal(p.fixture.actions.length, 1);
  p.fixture.location.href = CANONICAL;
  const duplicate = p.send({ task: { ...p.base.task, tweetUrl: CANONICAL } });
  gate.resolve({ ok: true });
  assert.equal((await first).ok, true);
  assert.equal((await duplicate).ok, true);
  assert.equal(p.fixture.actions.length, 1);
});

test("the active-run guard accepts a same-ID canonical redirect", async () => {
  const p = page({ actual: ALIAS, onAction(f) { f.location.href = CANONICAL; return { ok: true }; } });
  assert.equal((await p.send()).ok, true);
  assert.equal(p.fixture.actions.length, 1);
});

for (const destination of [OTHER, `https://example.org/?target=${CANONICAL}`]) {
  test(`a navigation to another target remains blocked after work starts: ${destination}`, async () => {
    const p = page({ target: CANONICAL, onAction(f) { f.location.href = destination; return { ok: true }; } });
    const result = await p.send();
    assert.equal(result.ok, false);
    assert.match(result.message, /目标推文已变化/);
    assert.notEqual(result.actionAttempted, false, "post-action failure cannot claim no action occurred");
    assert.equal(p.fixture.actions.length, 1);
  });
}

test("completion evidence accepts aliases but stays bound to the original task URL", async () => {
  const p = page();
  const result = await p.send({ type: "CHECK_X_TASK_WIDGET_COMPLETION" });
  assert.equal(result.completed, true);
  assert.equal(result.evidence.taskKey, p.base.task.taskKey);
  assert.equal(result.evidence.tweetUrl, ALIAS);
  assert.equal(p.fixture.actions.length, 0);
});

for (const patch of [{ task: { taskKey: "identity-order", tweetUrl: OTHER } }, { platform: "xinhuo" }]) {
  test(`completion evidence rejects mismatching identity: ${JSON.stringify(patch)}`, async () => {
    const p = page();
    const result = await p.send({ type: "CHECK_X_TASK_WIDGET_COMPLETION", ...patch });
    assert.equal(result.completed, false);
    assert.equal(p.fixture.actions.length, 0);
  });
}

for (const type of ["RUN_X_REPLY", "COMPLETE_X_TASK_WIDGET"]) {
  test(`reply-compose exception keeps its existing step restriction: ${type}`, async () => {
    const p = page({ target: CANONICAL, onAction(f) {
      f.location.href = "https://x.com/compose/post";
      f.composer = true;
      return { ok: true };
    } });
    const result = await p.send({ type });
    assert.equal(result.ok, type === "RUN_X_REPLY");
    assert.equal(p.fixture.actions.length, 1);
  });
}

test("STOP cancels in-flight work and an alias cannot replay the cancelled run", async () => {
  const gate = deferred();
  const p = page({ actual: ALIAS, onAction: () => gate.promise });
  const pending = p.send();
  await flush();
  await p.send({ type: "AUTOMATION_PAUSE_CHANGED", paused: true });
  gate.resolve({ ok: true });
  assert.equal((await pending).ok, false);
  p.fixture.location.href = CANONICAL;
  const stopped = await p.send({ task: { ...p.base.task, tweetUrl: CANONICAL } });
  assert.equal(stopped.cancelled, true);
  await p.send({ type: "AUTOMATION_PAUSE_CHANGED", paused: false });
  const cancelled = await p.send({ task: { ...p.base.task, tweetUrl: CANONICAL } });
  assert.equal(cancelled.cancelled, true);
  assert.equal(p.fixture.actions.length, 1);
});
