const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = readFileSync(path.join(__dirname, "../src/debug/debug.js"), "utf8");
const html = readFileSync(path.join(__dirname, "../src/debug/debug.html"), "utf8");
const commands = [...html.matchAll(/data-command="([^"]+)"/g)]
  .map((match) => match[1]).filter((command) => command.startsWith("DEBUG_"));
const stageDeclaration = source.match(/const STEP_COMPLETION_STAGES = \{[\s\S]*?\n\};/)[0];

// Execute the production functions, including their actual STOP event binding.
function declaration(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(source);
  assert.ok(match, `Missing production function ${name}`);
  const next = /^(?:async )?function \w+\(/gm;
  next.lastIndex = match.index + match[0].length;
  return source.slice(match.index, next.exec(source)?.index ?? source.length);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(options = {}) {
  const statuses = [];
  const messages = [];
  let now = 0;
  let waits = 0;
  let stopHandler;
  const buttons = commands.map((command, index) => ({
    dataset: { command }, disabled: false, busy: false, running: false,
    querySelector: () => ({ textContent: `步骤 ${index + 1}` }),
    setAttribute(name) { if (name === "aria-busy") this.busy = true; },
    removeAttribute(name) { if (name === "aria-busy") this.busy = false; },
    classList: { toggle(_name, value) { buttons[index].running = value; } }
  }));
  const context = vm.createContext({
    console, Promise,
    Date: { now: () => now },
    commandQueueRunning: false,
    activeStepQueue: null,
    stepButtons: buttons,
    showCommandStatus: (text, kind) => statuses.push({ text, kind }),
    saveSettings: options.saveSettings || (async () => true),
    loadState: options.loadState || (async () => {}),
    resolveSelectedCountdownTask: () => null,
    wait: async (ms) => { now += ms; waits += 1; if (options.wait) await options.wait(ms); },
    document: { getElementById: (id) => {
      assert.equal(id, "stopBtn");
      return { addEventListener: (event, handler) => { assert.equal(event, "click"); stopHandler = handler; } };
    } },
    chrome: {
      windows: { getCurrent: options.getCurrent || (async () => ({ id: 5 })) },
      runtime: { sendMessage: async (message) => {
        messages.push({ ...message });
        if (message.type === "STOP_RUN") return { ok: true };
        if (options.sendMessage) return options.sendMessage(message, context);
        return responseFor(message.type);
      } }
    }
  });
  vm.runInContext(stageDeclaration, context);
  for (const name of ["runPanelTask", "runStepQueue", "cancelStepQueue", "sendCommandAndWaitForStage",
    "withClientWindowId", "waitForStateStage", "getStepWaitTimeoutMs", "setStepButtonsDisabled", "setButtonRunning"]) {
    vm.runInContext(declaration(name), context);
  }
  const stopBinding = source.slice(source.indexOf('document.getElementById("stopBtn").addEventListener'),
    source.indexOf('document.getElementById("clearReplyRecordsBtn").addEventListener'));
  vm.runInContext(stopBinding, context);
  function responseFor(command, runId = "run-A", extraState = {}) {
    const stage = vm.runInContext(`STEP_COMPLETION_STAGES[${JSON.stringify(command)}]?.[0]`, context) || "manual_done";
    return { ok: true, state: { runId, running: true, stage, ...extraState } };
  }
  return {
    context, buttons, statuses, messages, responseFor,
    stop: () => stopHandler(),
    actions: () => messages.filter((message) => message.type.startsWith("DEBUG_")),
    successes: () => statuses.filter((status) => status.kind === "success"),
    waits: () => waits
  };
}

function assertUnlocked(h) {
  assert.equal(h.context.commandQueueRunning, false);
  assert.equal(h.context.activeStepQueue, null);
  assert.ok(h.buttons.every((button) => !button.disabled && !button.busy && !button.running));
}

test("all seven steps complete in order and continuations carry the owning runId", async () => {
  const h = harness();
  await h.context.runStepQueue(0);
  assert.deepEqual(h.actions().map((message) => message.type), commands);
  assert.equal(h.actions()[0].expectedRunId, undefined);
  assert.ok(h.actions().slice(1).every((message) => message.expectedRunId === "run-A"));
  assert.ok(h.actions().every((message) => message.clientWindowId === 5));
  assert.equal(h.successes().length, 1);
  assertUnlocked(h);
});

test("starting at step 04 still completes the remaining steps", async () => {
  const h = harness();
  await h.context.runStepQueue(3);
  assert.deepEqual(h.actions().map((message) => message.type), commands.slice(3));
  assert.equal(h.successes().length, 1);
  assertUnlocked(h);
});

test("a failed step stops its queue, displays the backend reason, and releases buttons", async () => {
  const h = harness({ sendMessage: async (message) => message.type === "DEBUG_RUN_X_REPLY"
    ? { ok: false, error: "旧动作结果未知" } : h.responseFor(message.type) });
  await h.context.runStepQueue(0);
  assert.deepEqual(h.actions().map((message) => message.type), commands.slice(0, 4));
  assert.ok(h.statuses.some((status) => status.kind === "error" && status.text === "旧动作结果未知"));
  assert.equal(h.successes().length, 0);
  assertUnlocked(h);
});

test("a settings save exception releases the queue and permits another attempt", async () => {
  let saves = 0;
  const h = harness({ saveSettings: async () => { if (++saves === 1) throw new Error("配置保存失败"); return true; } });
  await h.context.runStepQueue(3);
  assert.equal(h.actions().length, 0);
  assert.equal(h.successes().length, 0);
  assert.ok(h.statuses.some((status) => status.text === "配置保存失败"));
  assertUnlocked(h);
  await h.context.runStepQueue(3);
  assert.deepEqual(h.actions().map((message) => message.type), commands.slice(3));
  assert.equal(h.successes().length, 1);
  assertUnlocked(h);
});

test("STOP during settings save cancels before the first command", async () => {
  const saving = deferred();
  const entered = deferred();
  const h = harness({ saveSettings: async () => { entered.resolve(); await saving.promise; return true; } });
  const pending = h.context.runStepQueue(3);
  await entered.promise;
  await h.stop();
  assertUnlocked(h);
  saving.resolve();
  await pending;
  assert.equal(h.actions().length, 0);
  assert.equal(h.successes().length, 0);
  assert.equal(h.messages.filter((message) => message.type === "STOP_RUN").length, 1);
});

test("STOP during window lookup prevents a late command dispatch", async () => {
  const lookup = deferred();
  const entered = deferred();
  const h = harness({ getCurrent: async () => { entered.resolve(); return lookup.promise; } });
  const pending = h.context.runStepQueue(3);
  await entered.promise;
  await h.stop();
  lookup.resolve({ id: 5 });
  await pending;
  assert.equal(h.actions().length, 0);
  assert.equal(h.successes().length, 0);
  assertUnlocked(h);
});

test("STOP during the step response prevents all remaining commands and success", async () => {
  const response = deferred();
  const entered = deferred();
  const h = harness({ sendMessage: async () => { entered.resolve(); return response.promise; } });
  const pending = h.context.runStepQueue(3);
  await entered.promise;
  await h.stop();
  response.resolve(h.responseFor(commands[3]));
  await pending;
  assert.deepEqual(h.actions().map((message) => message.type), [commands[3]]);
  assert.equal(h.successes().length, 0);
  assertUnlocked(h);
});

test("STOP between steps while refreshing state prevents the next step", async () => {
  const refresh = deferred();
  const entered = deferred();
  let loads = 0;
  const h = harness({ loadState: async () => {
    if (++loads === 1) { entered.resolve(); await refresh.promise; }
  } });
  const pending = h.context.runStepQueue(3);
  await entered.promise;
  await h.stop();
  refresh.resolve();
  await pending;
  assert.deepEqual(h.actions().map((message) => message.type), [commands[3]]);
  assert.equal(h.successes().length, 0);
  assertUnlocked(h);
});

test("STOP during the final refresh cannot report completed success", async () => {
  const refresh = deferred();
  const entered = deferred();
  let loads = 0;
  const h = harness({ loadState: async () => {
    if (++loads === 2) { entered.resolve(); await refresh.promise; }
  } });
  const pending = h.context.runStepQueue(6);
  await entered.promise;
  await h.stop();
  refresh.resolve();
  await pending;
  assert.equal(h.successes().length, 0);
  assertUnlocked(h);
});

test("a final refresh exception does not produce a false success or leave buttons locked", async () => {
  let loads = 0;
  const h = harness({ loadState: async () => { if (++loads === 2) throw new Error("状态读取失败"); } });
  await h.context.runStepQueue(6);
  assert.equal(h.successes().length, 0);
  assert.ok(h.statuses.some((status) => status.kind === "error" && status.text === "状态读取失败"));
  assertUnlocked(h);
});

test("an old response cannot clear or unlock a newly started queue", async () => {
  const oldResponse = deferred();
  const newResponse = deferred();
  const oldEntered = deferred();
  const newEntered = deferred();
  let calls = 0;
  const h = harness({ sendMessage: async () => {
    if (++calls === 1) { oldEntered.resolve(); return oldResponse.promise; }
    newEntered.resolve();
    return newResponse.promise;
  } });
  const oldPending = h.context.runStepQueue(6);
  await oldEntered.promise;
  await h.stop();
  const newPending = h.context.runStepQueue(6);
  await newEntered.promise;
  const newOwner = h.context.activeStepQueue;
  oldResponse.resolve(h.responseFor(commands[6], "run-old"));
  await oldPending;
  assert.equal(h.context.activeStepQueue, newOwner);
  assert.equal(h.context.commandQueueRunning, true);
  assert.ok(h.buttons.every((button) => button.disabled));
  assert.equal(h.buttons[6].busy, true);
  assert.equal(h.successes().length, 0);
  newResponse.resolve(h.responseFor(commands[6], "run-new"));
  await newPending;
  assert.equal(h.successes().length, 1);
  assertUnlocked(h);
});

test("a different run in a continuation response cannot advance the queue", async () => {
  let calls = 0;
  const h = harness({ sendMessage: async (message) => h.responseFor(message.type, ++calls === 1 ? "run-A" : "run-B") });
  await h.context.runStepQueue(3);
  assert.deepEqual(h.actions().map((message) => message.type), commands.slice(3, 5));
  assert.equal(h.actions()[1].expectedRunId, "run-A");
  assert.equal(h.successes().length, 0);
  assertUnlocked(h);
});

test("a response without run ownership cannot start a continuation", async () => {
  const h = harness({ sendMessage: async (message) => {
    const response = h.responseFor(message.type);
    delete response.state.runId;
    return response;
  } });
  await h.context.runStepQueue(3);
  assert.equal(h.actions().length, 1);
  assert.equal(h.successes().length, 0);
  assertUnlocked(h);
});

test("stage polling rejects another run even when that run has the expected stage", async () => {
  const h = harness({ sendMessage: async () => ({ ok: true, state: { runId: "run-new", running: true, stage: "x_replied" } }) });
  const response = await h.context.waitForStateStage(["x_replied"], 90000, "run-old");
  assert.equal(response.ok, false);
  assert.equal(response.cancelled, true);
  assert.equal(h.messages.length, 1);
  assert.equal(h.waits(), 0);
});

test("stage polling exits promptly when its run is stopped", async () => {
  const h = harness({ sendMessage: async () => ({ ok: true, state: { runId: "run-A", running: false, stage: "stopped" } }) });
  const response = await h.context.waitForStateStage(["x_replied"], 90000, "run-A");
  assert.equal(response.cancelled, true);
  assert.equal(h.messages.length, 1);
  assert.equal(h.waits(), 0);
});

test("same-run polling returns the actual completed state", async () => {
  let polls = 0;
  const h = harness({ sendMessage: async (message) => message.type === "GET_STATE"
    ? { ok: true, state: { runId: "run-A", running: true, stage: ++polls === 1 ? "replying" : "x_replied" } }
    : { ok: true, state: { runId: "run-A", running: true, stage: "replying" } } });
  const response = await h.context.sendCommandAndWaitForStage("DEBUG_RUN_X_REPLY");
  assert.equal(response.ok, true);
  assert.equal(response.state.stage, "x_replied");
  assert.equal(response.state.runId, "run-A");
  assert.equal(polls, 2);
  assert.equal(h.waits(), 1);
});

test("cancellation during an in-flight poll overrides a late completed state", async () => {
  const response = deferred();
  const entered = deferred();
  let current = true;
  const h = harness({ sendMessage: async () => { entered.resolve(); return response.promise; } });
  const pending = h.context.waitForStateStage(["x_replied"], 90000, "run-A", () => current);
  await entered.promise;
  current = false;
  response.resolve({ ok: true, state: { runId: "run-A", running: true, stage: "x_replied" } });
  assert.equal((await pending).cancelled, true);
  assert.equal(h.waits(), 0);
});

test("the same run may finish at its terminal stage with running false", async () => {
  const h = harness({ sendMessage: async () => ({ ok: true, state: { runId: "run-A", running: false, stage: "selected_flow_done" } }) });
  const response = await h.context.waitForStateStage(["selected_flow_done"], 90000, "run-A");
  assert.equal(response.ok, true);
  assert.equal(response.state.running, false);
  assert.equal(h.waits(), 0);
});

test("the last queued step can finish successfully with running false", async () => {
  const h = harness({ sendMessage: async (message) => h.responseFor(message.type, "run-A", { running: false }) });
  await h.context.runStepQueue(6);
  assert.deepEqual(h.actions().map((message) => message.type), [commands[6]]);
  assert.equal(h.successes().length, 1);
  assertUnlocked(h);
});


test("successful full automatic completion is not reported as a cancelled step queue", async () => {
  const completed = {ok: true, state: {runId: "auto-finished", running: false, mode: "auto", stage: "finished"}};
  const h = harness({sendMessage: async (message) => {
    assert.equal(message.type, "START_RUN");
    return completed;
  }});
  const result = await h.context.sendCommandAndWaitForStage("START_RUN");
  assert.equal(result.ok, true, "the completed full run must preserve its successful result");
  assert.equal(result.cancelled, undefined);
  assert.equal(result.state.stage, "finished");
});
