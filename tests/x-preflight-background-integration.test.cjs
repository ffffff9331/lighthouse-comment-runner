"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");

// Reuse the existing inert Chrome/DOM fixtures without registering their
// tests. Both fixtures execute complete production files; this suite connects
// the real background sender to the real X listener and preflight workflow.
function fixtureModule(file, boundary, exports) {
  const filename = path.join(__dirname, file);
  const source = fs.readFileSync(filename, "utf8");
  const end = source.indexOf(boundary);
  assert.ok(end > 0, `${file} fixture boundary must remain identifiable`);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(__dirname);
  loaded._compile(`${source.slice(0, end)}\nmodule.exports = { ${exports} };\n`, filename);
  return loaded.exports;
}

const { worker } = fixtureModule("background-tweet-identity.test.cjs", "for (const [name, tab] of [", "worker");
const { page } = fixtureModule("x-preflight-retry.test.cjs", "function assertNoEffects(p)", "page");
const COMPLETE = "当前任务 进行中 +0.2LUX 要完成 评论 待完成 点赞 已完成 停留时长 63/10s 完成上面步骤解锁";
const copy = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function connected(t, options = {}) {
  const w = await worker(t);
  const p = page({ panelText: options.panelText ?? "当前任务 加载中", taskType: "评论+点赞" });
  Object.assign(w.state(), { xTabId: 21, xTabWindowId: 1 });
  w.state().currentTask.taskType = "评论+点赞";
  const intentsAtDispatch = [];
  const deliver = async (id, message) => {
    if (id !== 21) return { ok: true };
    if (message.type === "RUN_X_REPLY") {
      assert.ok(w.state().uncertainAction, "the real sender must persist its intent before dispatch");
      intentsAtDispatch.push(copy(w.state().uncertainAction));
    }
    return p.send(message);
  };
  w.hooks.sendMessage = deliver;
  const send = () => w.c.sendToTab(21, { type: "RUN_X_REPLY", runId: w.state().runId,
    task: w.state().currentTask, settings: { replyMode: "post", replyProvider: "native" } });
  return { w, p, send, deliver, intentsAtDispatch };
}

test("real preflight timeout releases only this intent and preserves a locked order for manual takeover", async t => {
  const { w, p, send, intentsAtDispatch } = await connected(t);
  const taskBefore = copy(w.state().currentTask);
  const result = await send();
  assert.equal(result.ok, false);
  assert.equal(result.actionAttempted, false);
  assert.match(result.message, /任务要求超时/);
  assert.equal(intentsAtDispatch.length, 1);
  assert.equal(intentsAtDispatch[0].type, "RUN_X_REPLY");
  assert.equal(w.state().uncertainAction, undefined);
  assert.deepEqual(copy(w.state().currentTask), taskBefore);
  assert.equal(p.calls.like, 0);
  assert.equal(p.calls.post, 0);

  const recovered = await w.c.recoverAndContinue(result.message,
    { runId: w.state().runId, task: w.state().currentTask, closeX: false });
  assert.equal(recovered.ok, false);
  assert.equal(w.state().running, false);
  assert.equal(w.state().stage, "locked_task_recovery_blocked");
  assert.deepEqual(copy(w.state().currentTask), taskBefore);
  assert.equal(w.created.length, 0);

  const takeover = await w.c.prepareDebugRunForCommand(1, "DEBUG_RUN_X_REPLY");
  assert.equal(takeover.ok, true, takeover.error);
  assert.equal(w.state().running, true);
  assert.equal(w.state().mode, "debug");
  assert.equal(w.state().uncertainAction, undefined);
  assert.deepEqual(copy(w.state().currentTask), taskBefore);
});

test("same-run retry rereads hydrated requirements and executes once through the real sender", async t => {
  const { w, p, send, intentsAtDispatch } = await connected(t);
  const runId = w.state().runId;
  assert.equal((await send()).actionAttempted, false);
  assert.equal(w.state().uncertainAction, undefined);
  p.fixture.panelText = COMPLETE;
  const completed = await send();
  assert.equal(completed.ok, true, completed.message);
  assert.equal(w.state().runId, runId);
  assert.equal(w.state().currentTask.seatLocked, true);
  assert.equal(w.state().uncertainAction, undefined);
  assert.equal(p.calls.ready, 2);
  assert.equal(p.calls.like, 1);
  assert.equal(p.calls.post, 1);
  assert.equal(intentsAtDispatch.length, 2);
  assert.notEqual(intentsAtDispatch[0].intentId, intentsAtDispatch[1].intentId);
  assert.equal((await send()).ok, true);
  assert.equal(p.calls.post, 1, "a successful action remains cached across later sender attempts");
});

for (const phase of ["like", "post"]) {
  test(`${phase} failure after action dispatch remains unknown and cannot be replayed`, async t => {
    const { w, p, send, intentsAtDispatch } = await connected(t, { panelText: COMPLETE });
    p.fixture.errors[phase] = `${phase} outcome unknown`;
    const failed = await send();
    assert.equal(failed.ok, false);
    assert.notEqual(failed.actionAttempted, false);
    assert.equal(w.state().uncertainAction.type, "RUN_X_REPLY");
    assert.equal(w.state().uncertainAction.intentId, intentsAtDispatch[0].intentId);
    assert.equal(w.state().currentTask.seatLocked, true);
    assert.equal(p.calls[phase], 1);
    const priorIntent = copy(w.state().uncertainAction);
    delete p.fixture.errors[phase];
    const blocked = await send();
    assert.equal(blocked.uncertain, true);
    assert.equal(intentsAtDispatch.length, 1);
    assert.equal(p.calls[phase], 1);
    assert.deepEqual(copy(w.state().uncertainAction), priorIntent);
  });
}

for (const transition of ["STOP", "new run"]) {
  test(`a delayed no-action receipt after ${transition} cannot clear or mutate the newer state`, async t => {
    const { w, p, send, deliver } = await connected(t);
    const ready = deferred(), release = deferred();
    w.hooks.sendMessage = async (id, message) => {
      const result = await deliver(id, message);
      if (message.type === "RUN_X_REPLY") {
        assert.equal(result.actionAttempted, false);
        ready.resolve();
        await release.promise;
      }
      return result;
    };
    const pending = send();
    await ready.promise;
    if (transition === "STOP") {
      const stopped = await w.c.handleMessage({ type: "STOP_RUN", clientWindowId: 1 },
        { id: "test", url: "chrome-extension://test/src/debug/debug.html" });
      assert.equal(stopped.ok, true);
    } else {
      vm.runInContext(`runtimeState = { ...createInitialState(), running: true,
        mode: "debug", stage: "new_run_owned", runId: "new-run",
        currentTask: { taskKey: "new-order", seatLocked: true, tweetUrl: "https://x.com/new/status/999" },
        uncertainAction: { type: "RUN_X_REPLY", runId: "new-run", taskKey: "new-order", intentId: "new-intent", tabId: 22 }
      };`, w.c);
    }
    const stateBefore = copy(w.state());
    release.resolve();
    const late = await pending;
    assert.equal(late.cancelled, true);
    assert.deepEqual(copy(w.state()), stateBefore, "the old sender must not clear a new intent, change stage, or restore an old task");
    assert.equal(p.calls.like, 0);
    assert.equal(p.calls.post, 0);
    if (transition === "new run") assert.equal(w.state().uncertainAction.intentId, "new-intent");
    else assert.equal(w.state().manuallyStopped, true);
  });
}
