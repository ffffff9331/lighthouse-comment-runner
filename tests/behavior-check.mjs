import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("manifest.json"));
const platform = manifest.name.includes("Lighthouse") ? "lighthouse" : "xinhuo";
const background = read("src/background.js");
const page = read(`src/content/${platform}.js`);
const monitor = platform === "lighthouse" ? read("src/content/lighthouse-monitor.js") : "";
const xPage = read("src/content/x.js");
const engine = read("src/reply-engine.js");
const debugPanel = platform === "lighthouse" ? read("src/debug/debug.js") : "";
let passed = 0;
const test = async (name, action) => {
  await action();
  passed += 1;
  console.log(`PASS ${name}`);
};

// Extract actual production declarations, not a reimplementation of their logic.
function declaration(source, name) {
  const match = new RegExp(`^([ \\t]*)(?:async )?function ${name}\\(`, "m").exec(source);
  assert.ok(match, `Missing function: ${name}`);
  const start = match.index;
  const next = new RegExp(`^${match[1]}(?:async )?function \\w+\\(`, "gm");
  next.lastIndex = start + match[0].length;
  const end = next.exec(source)?.index ?? source.lastIndexOf("})();");
  return source.slice(start, end > start ? end : source.length);
}
function contextFor(source, names, globals = {}) {
  const context = vm.createContext({ console, URL, AbortController, setTimeout, clearTimeout,
    normalize: (s) => String(s).replace(/\s+/g, " ").trim(),
    normalizeText: (s) => String(s).replace(/\s+/g, " ").trim(),
    startTaskWidgetAssist() {}, ...globals });
  for (const name of names) vm.runInContext(declaration(source, name), context);
  return context;
}

await test("stopped and stale messages are never sent, cancellation still reaches page", async () => {
  let sends = 0;
  const context = contextFor(background, ["sendToTab"], {
    runtimeState: { running: false, runId: "current" },
    chrome: { tabs: { async sendMessage() { sends += 1; return { ok: true }; } } },
    async ensureLighthouseAlertBridge() {}
  });
  const stopped = await context.sendToTab(1, { type: "RUN_X_REPLY", runId: "current" });
  assert.equal(stopped.cancelled, true);
  context.runtimeState.running = true;
  const stale = await context.sendToTab(1, { type: "RUN_X_REPLY", runId: "old" });
  assert.equal(stale.cancelled, true);
  assert.equal(sends, 0);
  await context.sendToTab(1, { type: "CANCEL_X_RUN", runId: "old" });
  assert.equal(sends, 1);
});

if (platform === "lighthouse") {
  await test("completion DOM rejects instructions and chooses result panel over page ancestor", () => {
    const make = (text, labels, width = 400, height = 300) => ({
      innerText: text,
      querySelectorAll: () => labels.map((innerText) => ({ innerText })),
      getBoundingClientRect: () => ({ width, height }),
      contains: () => false
    });
    const panel = make("验证成功 · 已通过 奖励已到账 +0.1 LUX", ["验证成功 · 已通过", "奖励已到账"]);
    const instruction = make("任务验证通过后发放 0.1 LUX", ["任务验证通过后发放"]);
    const ancestor = make(panel.innerText, ["奖励已到账"], 1000, 800);
    ancestor.contains = (node) => node === panel;
    const context = contextFor(page, ["isOfficialCompletionMarkerText", "hasOfficialCompletionRewardText", "findOfficialCompletionRoots"], {
      document: { querySelectorAll: () => [ancestor, instruction, panel] },
      isVisible: () => true
    });
    const roots = context.findOfficialCompletionRoots();
    assert.equal(roots.length, 1);
    assert.equal(roots[0], panel);
  });
  await test("paid result overlay is never treated as an open marketplace", () => {
    const context = contextFor(page, ["isCampaignsListOpen"], {
      location: { pathname: "/campaigns" },
      document: { body: { innerText: "任务广场 验证成功 奖励已到账 +0.10 LUX" } },
      hasOfficialCompletionEvidence: () => true,
      isTaskDetailOrRecoverableOverlayOpen: () => false,
      collectVisibleTaskLikeNodes: () => [{ id: "recommended-task" }],
      isTaskDetailOpen: () => false
    });
    assert.equal(context.isCampaignsListOpen(), false);
  });
  await test("recommended campaign links do not invalidate current paid evidence", () => {
    const recommendedRoot = {
      innerText: "验证成功 · 奖励已到账 +0.10 LUX 继续搞钱 · 类似任务 查看全部",
      querySelectorAll: () => [{ href: "https://x.com/other/status/999" }]
    };
    const context = contextFor(page, ["checkOfficialCompletion"], {
      completionContext: {
        runId: "run-1",
        taskKey: "task-1",
        tweetUrl: "https://x.com/test/status/123",
        baseline: new Set(),
        evidence: null
      },
      normalizeTweetUrl: (value) => String(value || "").replace(/\?.*$/, ""),
      findTaskDetailRoot: () => null,
      extractTweetUrl: () => "",
      findOfficialCompletionRoots: () => [recommendedRoot]
    });
    const result = context.checkOfficialCompletion({
      runId: "run-1",
      task: { taskKey: "task-1", tweetUrl: "https://x.com/test/status/123" }
    });
    assert.equal(result.completed, true);
    assert.equal(result.evidence.taskKey, "task-1");
  });
  await test("marketplace transition cannot finish before official evidence arrives", async () => {
    let checks = 0;
    const context = contextFor(page, ["waitForTaskCompletionAndReturn"], {
      Date: { now: (() => { let value = 0; return () => value += 100; })() },
      activeRunId: "run-1",
      assertActiveRun() {},
      checkOfficialCompletion: () => (++checks < 2
        ? { ok: true, completed: false }
        : { ok: true, completed: true, evidence: { runId: "run-1", taskKey: "task-1" } }),
      findCompletionReturnToCampaignsButton: () => null,
      isCampaignsListOpen: () => true,
      wait: async () => {}
    });
    const result = await context.waitForTaskCompletionAndReturn({}, {
      runId: "run-1",
      task: { taskKey: "task-1" }
    });
    assert.equal(checks, 2);
    assert.equal(result.ok, true);
    assert.equal(result.evidence.taskKey, "task-1");
  });
  await test("failed marketplace return preserves already confirmed official evidence", async () => {
    const evidence = { runId: "run-1", taskKey: "task-1" };
    const context = contextFor(page, ["waitForTaskCompletionAndReturn"], {
      Date: { now: (() => { let value = 0; return () => value += 100; })() },
      activeRunId: "run-1",
      assertActiveRun() {},
      checkOfficialCompletion: () => ({ ok: true, completed: true, evidence }),
      findCompletionReturnToCampaignsButton: () => ({ scrollIntoView() {} }),
      clickElement: async () => {},
      waitForCampaignsReturnAfterCompletion: async () => false
    });
    const result = await context.waitForTaskCompletionAndReturn({}, {
      runId: "run-1",
      task: { taskKey: "task-1" }
    });
    assert.equal(result.ok, false);
    assert.equal(result.completed, true);
    assert.equal(result.evidence.taskKey, "task-1");
  });
  await test("AI-prohibited and wallet-address guidance require a human", () => {
    const context = contextFor(page, ["hasUnsupportedCommentGuidance"]);
    assert.equal(context.hasUnsupportedCommentGuidance("评论引导 不要AI评论"), true);
    assert.equal(context.hasUnsupportedCommentGuidance("接单备注 要求填写EVM地址，抽奖"), true);
    assert.equal(context.hasUnsupportedCommentGuidance("评论引导 评价内容观点"), false);
    assert.equal(context.hasUnsupportedCommentGuidance("正文讨论 AI 交易和钱包地址安全"), false);
  });
  await test("unrelated page notes cannot permanently block the current detail", () => {
    const detailRoot = { innerText: "评论任务 验证通过即时到账 结算档位 Tier D 锁定席位" };
    const context = contextFor(page, ["hasUnsupportedCommentGuidance", "assertSupportedDetailTask"], {
      document: {
        body: {
          innerText: `${detailRoot.innerText} 推荐任务 接单备注 不要使用 AI 评论`
        }
      },
      TIER_MISMATCH_PHRASE: "你的F级已满，本次奖励按D级结算",
      findTaskDetailRoot: () => detailRoot,
      detectTaskTypeFromText: () => "评论"
    });
    assert.doesNotThrow(() => context.assertSupportedDetailTask({ taskType: "评论", detailText: detailRoot.innerText }));

    detailRoot.innerText += " 任务备注 不要使用 AI 评论";
    assert.throws(
      () => context.assertSupportedDetailTask({ taskType: "评论", detailText: detailRoot.innerText }),
      (error) => error.permanentIgnore === true && error.ignoredTaskType === "人工评论要求"
    );
  });
  await test("rapid duplicate start is rejected before first asynchronous wait", async () => {
    let releaseSettings;
    const settings = new Promise((resolve) => { releaseSettings = resolve; });
    const context = contextFor(background, ["startAutoRun", "ensureAutoRunKeepalive"], {
      runtimeState: { running: false },
      createInitialState: () => ({}),
      setRuntimeWindow() {}, createRunId: () => "run",
      sanitizeAutoRunStartOptions: () => ({}),
      setStage() {}, log() {}, getSettings: () => settings
    });
    const first = context.startAutoRun({});
    const second = await context.startAutoRun({});
    assert.equal(second.ok, false);
    assert.equal(context.runtimeState.running, true);
    releaseSettings({ replyMode: "fill" });
    await first;
  });
  await test("keepalive tick holds the alarm for an active run and clears it once idle", async () => {
    let cleared = 0;
    let platformPokes = 0;
    const context = contextFor(background, ["handleAutoRunKeepaliveTick", "tryResumeAutoRunAfterInterruption", "clearAutoRunKeepalive"], {
      AUTO_RUN_KEEPALIVE_ALARM: "lighthouseAutoRunKeepaliveV1",
      runtimeStateReady: Promise.resolve(),
      runtimeState: { running: true, mode: "auto" },
      chrome: {
        alarms: { async clear() { cleared += 1; return true; } },
        runtime: { async getPlatformInfo() { platformPokes += 1; return {}; } }
      }
    });
    await context.handleAutoRunKeepaliveTick();
    assert.equal(cleared, 0);
    assert.ok(platformPokes >= 1);
    context.runtimeState.running = false;
    context.runtimeState.mode = "idle";
    context.runtimeState.stage = "finished";
    await context.handleAutoRunKeepaliveTick();
    assert.equal(cleared, 1);
  });
  await test("worker restart resumes an interrupted auto run without a locked seat", async () => {
    let scans = 0;
    let cancelledRunIds = [];
    const context = contextFor(background, ["tryResumeAutoRunAfterInterruption"], {
      runtimeState: {
        running: false,
        mode: "idle",
        stage: "interrupted_not_resumed",
        runId: "old-run",
        lighthouseTabId: 11,
        xTabId: 22,
        currentTask: { taskKey: "a", seatLocked: false },
        completionEvidence: null
      },
      logs: [],
      log() {},
      setStage() {},
      createRunId: () => "resumed-run",
      describeTaskForLog: () => "0.1LUX · @a · t",
      chrome: { tabs: { async sendMessage(tabId, message) { cancelledRunIds.push({ tabId, runId: message.runId }); return { ok: true }; } } },
      async startNextAutoTask(reason) {
        scans += 1;
        assert.equal(reason, "resume_after_service_worker_restart");
        assert.equal(context.runtimeState.running, true);
        assert.equal(context.runtimeState.mode, "auto");
        assert.equal(context.runtimeState.runId, "resumed-run");
      }
    });
    assert.equal(await context.tryResumeAutoRunAfterInterruption(), true);
    assert.equal(scans, 1);
    assert.deepEqual(cancelledRunIds, [{ tabId: 11, runId: "old-run" }]);
    assert.equal(context.runtimeState.xTabId, null);
  });
  await test("worker restart never resumes on top of a locked unfinished seat", async () => {
    let scans = 0;
    const context = contextFor(background, ["tryResumeAutoRunAfterInterruption"], {
      runtimeState: {
        running: false,
        mode: "idle",
        stage: "interrupted_not_resumed",
        runId: "old-run",
        currentTask: { taskKey: "a", seatLocked: true },
        completionEvidence: null
      },
      log() {}, setStage() {}, createRunId: () => "resumed-run",
      describeTaskForLog: () => "0.1LUX · @a · t",
      chrome: { tabs: { async sendMessage() { throw new Error("must not cancel"); } } },
      async startNextAutoTask() { scans += 1; }
    });
    assert.equal(await context.tryResumeAutoRunAfterInterruption(), false);
    assert.equal(scans, 0);
    assert.equal(context.runtimeState.running, false);
  });
  await test("loading state trusts short standalone labels, never tweet excerpts", () => {
    const node = (text) => ({ innerText: text, textContent: text });
    const labeled = contextFor(page, ["hasPageLoadingState"], {
      document: {
        querySelectorAll: () => [node("加载中…"), node("Loading..."), node("任务正文 a refreshing break from the usual we just scaled our stack")],
        querySelector: () => null
      },
      isVisible: () => true
    });
    assert.equal(labeled.hasPageLoadingState(), true);
    const tweetOnly = contextFor(page, ["hasPageLoadingState"], {
      document: {
        querySelectorAll: () => [node("任务正文 a refreshing break from the usual"), node("预计获得 0.1 LUX 评论留言")],
        querySelector: () => null
      },
      isVisible: () => true
    });
    assert.equal(tweetOnly.hasPageLoadingState(), false);
  });
  await test("a visible skeleton node still counts as loading without any label", () => {
    const skeleton = { className: "skeleton-card" };
    const c = contextFor(page, ["hasPageLoadingState"], {
      document: { querySelectorAll: () => [], querySelector: (sel) => (sel.includes("skeleton") ? skeleton : null) },
      isVisible: () => true
    });
    assert.equal(c.hasPageLoadingState(), true);
  });
  await test("detail loading modal requires a real overlay, not header icon plus tweet text", () => {
    const closeButton = { getBoundingClientRect: () => ({ top: 50, left: 1400, width: 30, height: 30 }) };
    const make = (dialog) => contextFor(page, ["hasTaskDetailLoadingModal"], {
      location: { pathname: "/campaigns" },
      hasPageLoadingState: () => true,
      hasCampaignsBackdrop: () => false,
      findTaskDetailCloseButton: () => closeButton,
      document: { querySelector: (sel) => (sel.includes('role="dialog"') ? dialog : null) },
      window: { innerWidth: 1485, innerHeight: 738 }
    });
    assert.equal(make(null).hasTaskDetailLoadingModal(), false);
    assert.equal(make({}).hasTaskDetailLoadingModal(), true);
  });
  await test("scrolled-out header icons are not treated as close buttons", () => {
    const icon = { innerText: "", value: "", getAttribute: () => "接单额度说明", getBoundingClientRect: () => ({ top: -172, left: 706, width: 14, height: 14 }) };
    const cross = { innerText: "×", value: "", getAttribute: () => "", getBoundingClientRect: () => ({ top: 40, left: 1400, width: 24, height: 24 }) };
    const make = (nodes) => contextFor(page, ["findTaskDetailCloseButton", "buttonText"], {
      document: { querySelectorAll: () => nodes },
      isVisible: () => true,
      isDisabled: () => false,
      window: { innerWidth: 1485, innerHeight: 738 }
    });
    assert.equal(make([icon]).findTaskDetailCloseButton(), null);
    assert.equal(make([icon, cross]).findTaskDetailCloseButton(), cross);
  });
  await test("selected start takes over an active automatic run exactly once", async () => {
    let cancelCount = 0;
    let scheduleClearCount = 0;
    let selectedRunCount = 0;
    let releaseSelectedRun;
    const selectedRun = new Promise((resolve) => { releaseSelectedRun = resolve; });
    const context = contextFor(background, ["startSelectedCountdownTask"], {
      runtimeState: { running: true, mode: "auto", scheduledResumeAt: 123, runId: "old-run" },
      selectedStartInFlight: false,
      log() {},
      async cancelCurrentRun() {
        cancelCount += 1;
        context.runtimeState.running = false;
      },
      async clearAutoRunResumeSchedule() { scheduleClearCount += 1; },
      createRunId: () => "cancelled-run",
      async runSelectedCountdownTask(task) {
        selectedRunCount += 1;
        assert.equal(task.selectionId, "task-1");
        return selectedRun;
      }
    });

    const first = context.startSelectedCountdownTask({ selectionId: "task-1" });
    await Promise.resolve();
    const duplicate = await context.startSelectedCountdownTask({ selectionId: "task-1" });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.error, "选中启动正在处理");
    assert.equal(cancelCount, 1);
    assert.equal(scheduleClearCount, 1);
    assert.equal(selectedRunCount, 1);

    releaseSelectedRun({ ok: true });
    assert.equal((await first).ok, true);
  });
  await test("selected start without a task does not stop the active run", async () => {
    let cancelCount = 0;
    const context = contextFor(background, ["startSelectedCountdownTask"], {
      runtimeState: { running: true, mode: "auto", runId: "active-run" },
      selectedStartInFlight: false,
      log() {},
      async cancelCurrentRun() { cancelCount += 1; },
      async clearAutoRunResumeSchedule() {},
      createRunId: () => "unused",
      async runSelectedCountdownTask() { throw new Error("must not start"); }
    });
    const result = await context.startSelectedCountdownTask(null);
    assert.equal(result.ok, false);
    assert.equal(result.error, "未选中任务");
    assert.equal(cancelCount, 0);
    assert.equal(context.runtimeState.running, true);
  });
  await test("manual debug step takes over auto mode without losing task context", async () => {
    const task = { taskKey: "task-1", tweetUrl: "https://x.com/a/status/1" };
    let cancelCount = 0;
    let clearCount = 0;
    let keepaliveClearCount = 0;
    const context = contextFor(background, ["prepareDebugRunForCommand"], {
      runtimeState: {
        running: true,
        mode: "auto",
        runId: "auto-run",
        currentTask: task,
        lighthouseTabId: 10,
        xTabId: 20,
        scheduledResumeAt: 123
      },
      async cancelCurrentRun() {
        cancelCount += 1;
        context.runtimeState.running = false;
      },
      async clearAutoRunResumeSchedule() { clearCount += 1; },
      async clearAutoRunKeepalive() { keepaliveClearCount += 1; },
      createRunId: () => "debug-run",
      setRuntimeWindow(windowId) { context.runtimeState.runtimeWindowId = windowId; },
      setStage(stage) { context.runtimeState.stage = stage; },
      log() {}
    });
    await context.prepareDebugRunForCommand(7, "DEBUG_RUN_X_REPLY");
    assert.equal(cancelCount, 1);
    assert.equal(clearCount, 1);
    assert.equal(keepaliveClearCount, 1);
    assert.equal(context.runtimeState.running, true);
    assert.equal(context.runtimeState.mode, "debug");
    assert.equal(context.runtimeState.runId, "debug-run");
    assert.equal(context.runtimeState.currentTask, task);
    assert.equal(context.runtimeState.lighthouseTabId, 10);
    assert.equal(context.runtimeState.xTabId, 20);
  });
  await test("wrong-window debug command is rejected before takeover starts", async () => {
    let prepareCount = 0;
    let dispatchCount = 0;
    const state = { running: true, mode: "auto", lighthouseWindowId: 1, runId: "auto-run" };
    const context = contextFor(background, ["runManualDebugCommand"], {
      runtimeState: state,
      lockRuntimeWindowForCommand: () => ({ ok: false, error: "wrong window" }),
      async prepareDebugRunForCommand() { prepareCount += 1; return { ok: true }; },
      async debugRunXReply() { dispatchCount += 1; return { ok: true }; }
    });
    const result = await context.runManualDebugCommand({ type: "DEBUG_RUN_X_REPLY" }, 2);
    assert.equal(result.ok, false);
    assert.equal(result.error, "wrong window");
    assert.equal(prepareCount, 0);
    assert.equal(dispatchCount, 0);
    assert.equal(state.running, true);
    assert.equal(state.mode, "auto");
  });
  await test("concurrent manual debug commands are serialized", async () => {
    let active = 0;
    let maxActive = 0;
    const starts = [];
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const context = contextFor(background, ["enqueueManualDebugCommand"], {
      manualDebugCommandTail: Promise.resolve(),
      async runManualDebugCommand(message) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        starts.push(message.type);
        if (message.type === "DEBUG_OPEN_CAMPAIGNS") await firstGate;
        active -= 1;
        return { ok: true };
      }
    });
    const first = context.enqueueManualDebugCommand({ type: "DEBUG_OPEN_CAMPAIGNS" }, 1);
    const second = context.enqueueManualDebugCommand({ type: "DEBUG_RUN_X_REPLY" }, 1);
    await Promise.resolve();
    assert.deepEqual(starts, ["DEBUG_OPEN_CAMPAIGNS"]);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(starts, ["DEBUG_OPEN_CAMPAIGNS", "DEBUG_RUN_X_REPLY"]);
    assert.equal(maxActive, 1);
  });
  await test("workflow buttons continue through the remaining steps", () => {
    assert.match(debugPanel, /stepButtons\.forEach\(\(button, index\)[\s\S]*runStepQueue\(index\)/);
    assert.match(debugPanel, /const queue = stepButtons\.slice\(startIndex\)/);
  });
  await test("workflow queue runs every remaining step in order", async () => {
    const commands = [];
    const statuses = [];
    const buttons = ["A", "B", "C"].map((command) => ({
      dataset: { command },
      querySelector: () => ({ textContent: command })
    }));
    const context = contextFor(debugPanel, ["runStepQueue"], {
      commandQueueRunning: false,
      stepButtons: buttons,
      async saveSettings() {},
      setStepButtonsDisabled() {},
      setButtonRunning() {},
      showCommandStatus(text, kind) { statuses.push({ text, kind }); },
      async sendCommandAndWaitForStage(command) {
        commands.push(command);
        return { ok: true };
      },
      async loadState() {}
    });
    await context.runStepQueue(1);
    assert.deepEqual(commands, ["B", "C"]);
    assert.equal(statuses.at(-1).kind, "success");
  });
  await test("workflow queue stops immediately at the first failed step", async () => {
    const commands = [];
    const statuses = [];
    const buttons = ["A", "B", "C"].map((command) => ({
      dataset: { command },
      querySelector: () => ({ textContent: command })
    }));
    const context = contextFor(debugPanel, ["runStepQueue"], {
      commandQueueRunning: false,
      stepButtons: buttons,
      async saveSettings() {},
      setStepButtonsDisabled() {},
      setButtonRunning() {},
      showCommandStatus(text, kind) { statuses.push({ text, kind }); },
      async sendCommandAndWaitForStage(command) {
        commands.push(command);
        return command === "B" ? { ok: false, error: "B failed" } : { ok: true };
      },
      async loadState() {}
    });
    await context.runStepQueue(0);
    assert.deepEqual(commands, ["A", "B"]);
    assert.deepEqual(statuses.at(-1), { text: "B failed", kind: "error" });
  });
  await test("workflow queue accepts the last step as a boundary start", async () => {
    const commands = [];
    const buttons = ["A", "B", "C"].map((command) => ({
      dataset: { command },
      querySelector: () => ({ textContent: command })
    }));
    const context = contextFor(debugPanel, ["runStepQueue"], {
      commandQueueRunning: false,
      stepButtons: buttons,
      async saveSettings() {},
      setStepButtonsDisabled() {},
      setButtonRunning() {},
      showCommandStatus() {},
      async sendCommandAndWaitForStage(command) {
        commands.push(command);
        return { ok: true };
      },
      async loadState() {}
    });
    await context.runStepQueue(2);
    assert.deepEqual(commands, ["C"]);
  });
}

function xHarness() {
  let listener;
  let count = 0;
  let resolveAction;
  const action = new Promise((resolve) => { resolveAction = resolve; });
  const context = vm.createContext({
    console, URL, location: { href: "https://x.com/test/status/123" },
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
    startTaskWidgetAssist() {},
    runAction() { count += 1; return action; }
  });
  const prefix = xPage.slice(0, xPage.indexOf("  async function runReply("));
  vm.runInContext(`${prefix}
    ${declaration(xPage, "normalizeTweetUrl")}
    ${declaration(xPage, "assertActiveRun")}
    function runReply() { return runAction(); }
    function completeTaskWidgetLifecycle() { return runAction(); }
    function runTaskWidgetClaim() { return runAction(); }
  })();`, context);
  const payload = { platform, type: "RUN_X_REPLY", runId: "run-1",
    task: { taskKey: "task-1", detailPath: "/tasks/task-1", tweetUrl: "https://x.com/test/status/123" }, settings: {} };
  return {
    context, payload, count: () => count, finish: () => resolveAction({ ok: true }),
    send: (patch = {}) => new Promise((resolve) => listener({ ...payload, ...patch }, {}, resolve))
  };
}

await test("concurrent platform claim messages share one claim operation", async () => {
  let listener;
  let count = 0;
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const context = vm.createContext({
    console, URL, window: { addEventListener() {} },
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
    isCurrentInstance: () => true,
    action() { count += 1; return pending; }
  });
  const end = platform === "lighthouse"
    ? page.indexOf("  function isCurrentInstance(")
    : page.indexOf("  async function selectAndClaim(");
  vm.runInContext(`${page.slice(0, end)}
    function runCommentTask() { return action(); }
    function selectAndClaim() { return action(); }
  })();`, context);
  const type = platform === "lighthouse" ? "START_LIGHTHOUSE_COMMENT_TASK" : "XINHUO_SELECT_AND_CLAIM";
  const send = (runId) => new Promise((resolve) => listener({ type, runId, settings: {} }, {}, resolve));
  const first = send("run-1");
  const second = send("run-1");
  const other = await send("run-2");
  assert.equal(other.conflict, true);
  assert.equal(count, 1);
  finish({ ok: true });
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.equal(count, 1);
});

await test("same task concurrent/replayed reply executes exactly once", async () => {
  const h = xHarness();
  const a = h.send();
  const b = h.send();
  await Promise.resolve();
  assert.equal(h.count(), 1);
  h.finish();
  assert.equal((await a).ok, true);
  assert.equal((await b).ok, true);
  assert.equal((await h.send()).ok, true);
  assert.equal(h.count(), 1);
});
await test("wrong platform and wrong tweet perform zero actions", async () => {
  const h = xHarness();
  assert.equal((await h.send({ platform: platform === "xinhuo" ? "lighthouse" : "xinhuo" })).ok, false);
  assert.equal((await h.send({ task: { tweetUrl: "https://x.com/test/status/999" } })).ok, false);
  assert.equal(h.count(), 0);
});
await test("different task cannot overwrite the active operation", async () => {
  const h = xHarness();
  const first = h.send();
  assert.equal((await h.send({ runId: "run-2" })).conflict, true);
  h.finish();
  assert.equal((await first).ok, true);
  assert.equal(h.count(), 1);
});
await test("cancelled in-flight result is not reported as success", async () => {
  const h = xHarness();
  const first = h.send();
  await Promise.resolve();
  await h.send({ type: "CANCEL_X_RUN" });
  h.finish();
  assert.equal((await first).ok, false);
  assert.equal((await h.send()).cancelled, true);
});
await test("navigation during a step invalidates its result", async () => {
  const h = xHarness();
  const first = h.send();
  await Promise.resolve();
  h.context.location.href = "https://x.com/test/status/999";
  h.finish();
  assert.equal((await first).ok, false);
});
await test("only the active reply step may survive a visible X compose route", () => {
  const c = contextFor(xPage, ["assertActiveRun", "isExpectedReplyComposeTransition"], {
    activeTargetUrl: "https://x.com/test/status/123",
    activeRunId: "run-1",
    activeStepName: "RUN_X_REPLY",
    activeStepStartedAt: Date.now(),
    cancelledRunIds: new Set(),
    location: { href: "https://x.com/compose/post" },
    document: { querySelector: () => ({}) },
    normalizeTweetUrl: (value) => /\/status\/\d+/.test(String(value || "")) ? String(value) : ""
  });
  assert.doesNotThrow(() => c.assertActiveRun("run-1"));
  c.activeStepName = "COMPLETE_X_TASK_WIDGET";
  assert.throws(() => c.assertActiveRun("run-1"), /目标推文已变化/);
  c.activeStepName = "RUN_X_REPLY";
  c.document.querySelector = () => null;
  assert.throws(() => c.assertActiveRun("run-1"), /目标推文已变化/);
});
await test("submit aliases share the same single execution", async () => {
  const h = xHarness();
  const a = h.send({ type: "CLICK_X_TASK_VERIFY" });
  const b = h.send({ type: "COMPLETE_X_TASK_WIDGET" });
  h.finish();
  assert.equal((await a).ok, true);
  assert.equal((await b).ok, true);
  assert.equal(h.count(), 1);
});

await test("AI cancellation aborts fetch without a retry", async () => {
  let calls = 0;
  const c = contextFor(engine, ["callAIProvider", "callAIWithSolaRetry", "createReplyDiagnostic", "clipReplyDiagnosticText", "countReplyChineseChars", "describeReplyFailureReason"], {
    MAX_AI_NORMAL_ATTEMPTS: 6,
    AI_PROVIDER_CONFIG: { deepseek: { endpoint: "https://invalid.test", model: "test" } },
    normalizeCustomAIEndpoint: () => "",
    fetch: (_url, { signal }) => {
      calls += 1;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
  });
  const controller = new AbortController();
  const pending = c.callAIWithSolaRetry("deepseek", "test-key", "", "text", { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /任务已停止/);
  assert.equal(calls, 1);
});
await test("AI generation uses a 120s timeout with one controlled timeout retry", () => {
  assert.match(engine, /const DEFAULT_AI_TIMEOUT_MS = 120000/);
  assert.match(engine, /const MAX_AI_NORMAL_ATTEMPTS = 6/);
  assert.match(engine, /const MAX_AI_TIMEOUT_ATTEMPTS = 2/);
  assert.match(background, /timeout: 120000/);
  assert.match(engine, /pickUserFallbackReply\(tweetContent, basePrompt\)/);
});
await test("AI provider failure performs exactly five retries", async () => {
  let calls = 0;
  const c = contextFor(engine, ["callAIProvider", "callAIWithSolaRetry", "isAIRequestTimeoutError", "createReplyDiagnostic", "clipReplyDiagnosticText", "countReplyChineseChars", "describeReplyFailureReason"], {
    MAX_AI_NORMAL_ATTEMPTS: 6,
    AI_PROVIDER_CONFIG: { deepseek: { endpoint: "https://invalid.test", model: "test" } },
    normalizeCustomAIEndpoint: () => "",
    delay: async () => {},
    fetch: async () => {
      calls += 1;
      throw new Error("network down");
    }
  });
  const result = await c.callAIWithSolaRetry("deepseek", "test-key", "prompt", "tweet", {});
  assert.equal(calls, 6);
  assert.equal(result.diagnostics.length, 6);
  assert.ok(result.diagnostics.every((item) => item.reason === "api_error"));
});
await test("AI timeout records two diagnostics before Lighthouse uses its fallback", async () => {
  let calls = 0;
  const c = contextFor(engine, ["callAIWithSolaRetry", "isAIRequestTimeoutError", "createReplyDiagnostic", "clipReplyDiagnosticText", "countReplyChineseChars", "describeReplyFailureReason"], {
    MAX_AI_TIMEOUT_ATTEMPTS: 2,
    callAIProvider: async () => {
      calls += 1;
      throw new Error("AI 请求超时：120000ms");
    },
    delay: async () => {}
  });
  const result = await c.callAIWithSolaRetry("openai", "test-key", "prompt", "tweet", {});
  assert.equal(calls, 2);
  assert.equal(result.replyText, "");
  assert.equal(result.diagnostics.length, 2);
  assert.ok(result.diagnostics.every((item) => item.reason === "timeout"));
  assert.ok(result.diagnostics.every((item) => /AI请求超时/.test(item.reasonText)));
});
await test("AI timeout has an explicit duration diagnostic", async () => {
  const c = contextFor(engine, ["callAIProvider"], {
    AI_PROVIDER_CONFIG: { deepseek: { endpoint: "https://invalid.test", model: "test" } },
    normalizeCustomAIEndpoint: () => "",
    fetch: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)))
  });
  await assert.rejects(c.callAIProvider("deepseek", "test-key", "", "", { timeout: 5 }), /超时：5ms/);
});
await test("manual AI model overrides the provider default", async () => {
  let requestBody = null;
  const c = contextFor(engine, ["callAIProvider", "readJsonResponse"], {
    AI_PROVIDER_CONFIG: { openai: { endpoint: "https://invalid.test/v1/responses", model: "provider-default" } },
    normalizeCustomAIEndpoint: () => "",
    fetch: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        text: async () => JSON.stringify({ output: [{ content: [{ text: "好" }] }] })
      };
    }
  });
  assert.equal(await c.callAIProvider("openai", "test-key", "prompt", "tweet", {
    timeout: 100,
    model: "gpt-5.5"
  }), "好");
  assert.equal(requestBody.model, "gpt-5.5");
});
await test("an invalid custom AI endpoint never falls back to the provider endpoint with the same key", async () => {
  let fetchedUrl = "";
  const c = contextFor(engine, ["normalizeCustomAIEndpoint", "callAIProvider", "readJsonResponse"], {
    AI_PROVIDER_CONFIG: {
      "gpt-5.6-terra": { endpoint: "https://api.openai.com/v1/responses", model: "gpt-5.6-terra" }
    },
    fetch: async (url) => {
      fetchedUrl = url;
      return { ok: true, text: async () => JSON.stringify({ output_text: "不应发送" }) };
    }
  });
  await assert.rejects(
    c.callAIProvider("gpt-5.6-terra", "relay-key", "prompt", "tweet", {
      model: "gpt-5.6-terra",
      apiUrl: "https://relay.example/v1/chat/completions",
      timeout: 1000
    }),
    /自定义|invalid|URL/i
  );
  assert.equal(fetchedUrl, "");
});
await test("stale fallback bag is rebuilt and every returned fallback passes validation", async () => {
  const replies = ["细节很容易被忽略", "角度还挺特别的"];
  const c = contextFor(engine, ["pickUserFallbackReply", "refillFallbackReplyBag", "takeNextValidFallbackReply"], {
    DEFAULT_AI_SYSTEM_PROMPT: "prompt",
    USER_FALLBACK_REPLIES: replies,
    fallbackReplyBag: ["这波稳了"],
    validateFinalReplyText: (text) => ({ ok: replies.includes(text) }),
    chrome: { storage: null }
  });
  const reply = await c.pickUserFallbackReply("tweet", "prompt");
  assert.ok(replies.includes(reply));
});

if (platform === "xinhuo") {
  await test("mocked full order submits once, confirms and returns to its own marketplace", async () => {
    const state = { runId: "r", running: true, completed: 0, attempts: 0 };
    const sent = [];
    const navigations = [];
    const task = { taskKey: "/tasks/a", detailPath: "/tasks/a", claimed: true, tweetUrl: "https://x.com/a/status/1" };
    const c = contextFor(background, ["runNextXinhuoTask", "waitForXinhuoFinalVerification"], {
      runtimeState: state, XINHUO_TASKS_URL: "https://xinhuo123.com/tasks",
      XINHUO_X_HYDRATION_MS: 0, XINHUO_FOREGROUND_MS: 0, XINHUO_VERIFICATION_POLL_MS: 0,
      isActiveRun: (id) => state.running && state.runId === id,
      getSettings: async () => ({ aiApiKey: "test", maxTasksPerRun: 1, maxTaskAttempts: 10, actionDelayMs: 0 }),
      isLimitReached: (count, max) => count >= max,
      finishRun: () => { state.running = false; return { ok: true }; },
      ensureXinhuoMarketplaceTab: async () => ({ id: 1, url: "https://xinhuo123.com/tasks" }),
      assertXinhuoTab() {}, isXinhuoMarketplaceUrl: () => true,
      waitForTabComplete: async () => {}, setStage() {}, log() {}, delay: async () => {},
      beginXinhuoXOpenWatch() {}, getAttemptedTaskKeys: () => [], markAttemptedTask() {},
      getSiteOpenedTargetXTab: async () => ({ id: 2 }), focusXinhuoXTab: async () => {},
      recordReplyHistory: async () => {}, beginXinhuoXSubmission() {}, clearXinhuoXSubmission() {},
      toContentSettings: (s) => s,
      chrome: { tabs: { update: async (id, props) => { navigations.push({ id, ...props }); }, reload: async () => {} } },
      sendToTab: async (id, message) => {
        sent.push(message.type);
        if (message.type === "XINHUO_SELECT_AND_CLAIM") return { ok: true, task };
        if (message.type === "RUN_X_REPLY") return { ok: true };
        if (message.type === "COMPLETE_X_TASK_WIDGET") return { ok: true, submissionAttempted: true };
        if (message.type === "XINHUO_WAIT_FOR_SUBMISSION_RESULT") return { ok: true, final: true };
        throw new Error(`Unexpected command ${message.type}`);
      }
    });
    assert.equal((await c.runNextXinhuoTask("test")).ok, true);
    assert.equal(state.completed, 1);
    assert.equal(state.currentTask, null);
    assert.equal(sent.filter((s) => s === "COMPLETE_X_TASK_WIDGET").length, 1);
    assert.equal(navigations.at(-1).url, "https://xinhuo123.com/tasks");
    assert.ok(navigations.every((n) => !n.url || n.url.startsWith("https://xinhuo123.com/")));
  });
  await test("real candidate parser filters quota, tier and cooldown cards", () => {
    const make = (id, text, label = "", disabled = "false") => ({
      innerText: text, href: `https://xinhuo123.com/tasks/${id}`,
      getAttribute: (name) => name === "aria-label" ? label : disabled
    });
    const nodes = [
      make("a", "评论 可立即接取 0.1 KX"),
      make("b", "评论 可立即接取 0.1 KX", "额度不足"),
      make("c", "评论 可立即接取 当前等级无席位 0.1 KX"),
      make("d", "评论 等待 43 秒 0.1 KX", "", "true")
    ];
    const c = contextFor(page, ["collectCandidates", "isCandidateBlocked", "parseBounty", "parseCooldownMs"], {
      document: { querySelectorAll: () => nodes }
    });
    const tasks = c.collectCandidates();
    assert.deepEqual(Array.from(tasks.filter((t) => t.ready), (t) => t.taskKey), ["/tasks/a"]);
    assert.equal(tasks.find((t) => t.taskKey === "/tasks/d").cooldownMs, 43000);
  });
  await test("missing Xinhuo widget never invokes a Lighthouse button", async () => {
    let time = 0;
    let foreignClicks = 0;
    const c = contextFor(xPage, ["completeTaskWidgetLifecycle"], {
      activeRunId: "r", assertActiveRun() {}, Date: { now: () => time },
      wait: async () => { time += 30000; },
      findXinhuoTaskWidget: () => null,
      findDocumentVerifyActionButton: () => { foreignClicks += 1; return {}; }
    });
    assert.equal((await c.completeTaskWidgetLifecycle({})).ok, false);
    assert.equal(foreignClicks, 0);
  });
  await test("Xinhuo click without acknowledgement is not clicked again", async () => {
    let clicks = 0;
    const c = contextFor(xPage, ["completeTaskWidgetLifecycle"], {
      activeRunId: "r", assertActiveRun() {}, findXinhuoTaskWidget: () => ({}),
      findXinhuoSubmitButton: () => ({}), getNodeActionText: () => "提交任务",
      activateXinhuoSubmitButton: async () => { clicks += 1; },
      waitForXinhuoTaskWidgetSubmission: async () => ""
    });
    const result = await c.completeTaskWidgetLifecycle({});
    assert.equal(result.submissionAttempted, true);
    assert.equal(result.submitted, false);
    assert.equal(clicks, 1);
  });
  await test("detached widget and disabled submit are not submission evidence", () => {
    const c = contextFor(xPage, ["getXinhuoSubmissionState"], {
      isVisible: () => true,
      getXinhuoTaskWidgetControls: () => [{ text: "提交任务" }],
      getNodeActionText: (node) => node.text,
      isButtonDisabled: () => true
    });
    assert.equal(c.getXinhuoSubmissionState({ isConnected: false }), "");
    assert.equal(c.getXinhuoSubmissionState({ isConnected: true, innerText: "前台停留不足" }), "");
    assert.ok(c.getXinhuoSubmissionState({ isConnected: true, innerText: "已提交任务" }));
  });
  await test("official order labels accepted, instructions/other outcomes rejected", () => {
    const c = contextFor(page, ["getSubmissionState"]);
    for (const label of ["已到账奖励", "任务核验已通过，奖励已结算。", "奖励已到账"]) {
      assert.equal(c.getSubmissionState(label).final, true);
    }
    for (const label of ["核验成功后奖励到账，当前任务尚未提交", "审核通过后奖励", "任务已完成处理，请查看审核结果。"]) {
      assert.equal(c.getSubmissionState(label), null);
    }
    assert.equal(c.getSubmissionState("自动核验未能确认，现已转人工复核。").final, false);
  });
  await test("quota/tier block wins over generic ready wording", () => {
    const c = contextFor(page, ["isCandidateBlocked"]);
    assert.equal(c.isCandidateBlocked("可立即接取 当前等级无席位"), true);
    assert.equal(c.isCandidateBlocked("可立即接取 额度不足"), true);
    assert.equal(c.isCandidateBlocked("可立即接取 评论"), false);
  });
  await test("only reward panel status nodes are inspected", () => {
    const c = contextFor(page, ["getCurrentTaskDetailText"], {
      location: { pathname: "/tasks/a" },
      document: {
        body: { innerText: "奖励已到账" },
        querySelector: (selector) => {
          assert.equal(selector, "aside.reward-panel");
          return null;
        }
      }
    });
    assert.equal(c.getCurrentTaskDetailText(), "");
  });
  await test("X submission is followed only by read-only platform checks", () => {
    const flow = declaration(background, "runNextXinhuoTask");
    assert.doesNotMatch(flow, /type: "XINHUO_CONFIRM_AND_WAIT_VERIFICATION"|type: "XINHUO_SUBMIT_VERIFICATION"/);
    assert.match(flow, /type: "XINHUO_WAIT_FOR_SUBMISSION_RESULT"/);
  });
} else {
  await test("missing cooldown is unknown, not zero; 10/19/50 second values stay ordered", () => {
    const c = contextFor(page, ["parseCooldownFromCard", "parseCooldownMs", "hasCooldownState", "parseDurationMs"], {
      COOLDOWN_MARKERS: ["冷却", "等待", "后可"], isVisible: () => true, isOwnedByTaskCard: () => true
    });
    const card = { querySelectorAll: () => [] };
    assert.equal(c.parseCooldownFromCard(card, "冷却中，正在加载").remainingMs, Infinity);
    const values = ["冷却中 50s", "冷却中 10s", "冷却中 19s"].map((s) => c.parseCooldownFromCard(card, s).remainingMs).sort((a, b) => a - b);
    assert.deepEqual(values, [10000, 19000, 50000]);
  });
  await test("automatic selection uses the countdown monitor result as its source of truth", () => {
    const c = contextFor(page, ["parseCooldownFromCard", "parseCooldownMs", "hasCooldownState", "parseDurationMs"], {
      __lighthouseHighBountyMonitor__: {
        parseStatusFromCard: () => ({
          isCooling: true,
          countdownSec: 101,
          countdown: "1分41秒",
          rawText: "冷却中 · 1m 41s"
        })
      },
      COOLDOWN_MARKERS: ["冷却", "等待", "后可"],
      isVisible: () => true,
      isOwnedByTaskCard: () => true
    });
    const card = { querySelectorAll: () => [] };
    const result = c.parseCooldownFromCard(card, "活动周期 1h 9m 冷却中 · 2m 14s");
    assert.equal(result.remainingMs, 101000);
    assert.equal(result.text, "1分41秒");
    assert.equal(result.source, "monitor");
  });
  await test("a full card fallback cannot invent a cooldown from unrelated durations", () => {
    const c = contextFor(page, ["parseCooldownFromCard", "parseCooldownMs", "hasCooldownState", "parseDurationMs"], {
      COOLDOWN_MARKERS: ["冷却", "等待", "后可"],
      isVisible: () => true,
      isOwnedByTaskCard: () => true
    });
    const card = { querySelectorAll: () => [] };
    const longCardText = `活动周期 截止 3d 23h 20m ${"任务正文 ".repeat(20)} 冷却中`;
    assert.equal(c.parseCooldownFromCard(card, longCardText).remainingMs, Infinity);
    assert.equal(c.parseCooldownMs("活动周期 1h 9m 冷却中 · 2m 14s"), 134000);
  });
  await test("a valid card-local cooldown wins over blocked words in the tweet excerpt", () => {
    const card = { innerText: "评论留言 预计获得 0.1 LUX 项目已完成升级 冷却中 · 1m 20s" };
    const c = contextFor(page, ["collectTaskCandidates"], {
      isTaskDetailOrRecoverableOverlayOpen: () => false,
      collectExecutableTaskCards: () => [card],
      isLikelySingleTaskCard: () => true,
      detectCandidateTaskType: () => "评论",
      isCommentEquivalentTaskType: () => true,
      isAutomatableTaskType: () => true,
      parseCandidateBounty: () => 0.1,
      extractCandidateTitle: () => "Branch",
      extractHandle: () => "@yida_w",
      buildSelectionId: () => "selection-1",
      buildStableTaskKey: () => "stable-1",
      buildTaskKey: () => "task-1",
      parseCooldownFromCard: () => ({ remainingMs: 80000, text: "冷却中 · 1m 20s" }),
      BLOCKED_MARKERS: ["进行中", "已完成", "已提交"],
      hasHardFailure: () => false,
      hasUnsupportedCommentGuidance: () => false,
      findOpenTargetInCard: () => ({})
    });
    const [candidate] = c.collectTaskCandidates([]);
    assert.equal(candidate.cooldownMs, 80000);
    assert.equal(candidate.isBlocked, false);
  });
  await test("countdown monitor keeps cooling status when the tweet excerpt contains a blocked word", () => {
    const statusNode = {};
    const card = { innerText: "评论留言 预计获得 0.1 LUX 项目已完成升级 冷却中 · 1m 20s" };
    const c = contextFor(monitor, ["parseStatusFromCard"], {
      getVisibleTextBlocks: () => [{ node: statusNode, text: "冷却中 · 1m 20s" }],
      belongsToTaskCard: () => true,
      COOLING_MARKERS: ["冷却中", "冷却", "后可", "等待"],
      BLOCKED_MARKERS: ["进行中", "已完成", "已提交"],
      READY_MARKERS: ["查看详情", "评论留言"],
      parseCountdownSeconds: () => 80,
      hasUnsupportedCommentGuidance: () => false,
      formatCountdown: () => "1分20秒"
    });
    const status = c.parseStatusFromCard(card);
    assert.equal(status.isBlocked, false);
    assert.equal(status.isCooling, true);
    assert.equal(status.countdownSec, 80);
  });
  await test("automatic run blocks duplicate start, but not state reads", async () => {
    const state = { running: true, mode: "auto", runId: "r" };
    const c = contextFor(background, ["handleMessage"], {
      runtimeState: state, runtimeStateReady: Promise.resolve(),
      getMessageWindowId: () => 1, isWindowScopedCommand: () => false, getSettings: async () => ({})
    });
    assert.equal((await c.handleMessage({ type: "START_RUN" }, {})).ok, false);
    assert.equal((await c.handleMessage({ type: "GET_STATE" }, {})).ok, true);
    assert.equal((await c.handleMessage({ type: "X_REPLY_RESULT" }, {})).ignored, true);
  });
  await test("completion count and next scan remain exactly once with overlapping callbacks", async () => {
    const state = { runId: "r", mode: "auto", running: true, completed: 0, currentTask: { taskKey: "a" }, lighthouseTabId: 1, attemptedTaskRecords: [{ key: "a", expiresAt: Date.now() + 60000 }], attemptedTaskKeys: ["a"] };
    let scans = 0;
    let released = null;
    const c = contextFor(background, ["handleLighthouseDone"], {
      runtimeState: state, hasLatchedLighthouseCompletion: () => true,
      getSettings: async () => ({ maxTasksPerRun: 10, actionDelayMs: 0 }),
      isLimitReached: (count, max) => count >= max, log() {},
      closeLighthouseDetailToCampaigns: async () => true, delay: async () => {},
      releaseAttemptedTask(task) { released = task; state.attemptedTaskRecords = []; state.attemptedTaskKeys = []; },
      startNextAutoTask: async () => { scans += 1; return { ok: true }; }
    });
    await Promise.all([c.handleLighthouseDone({ ok: true }), c.handleLighthouseDone({ ok: true })]);
    assert.equal(state.completed, 1);
    assert.equal(scans, 1);
    assert.equal(state.currentTask, null);
    assert.ok(released && released.taskKey === "a", "completed task must leave the dedupe table");
  });
  await test("only matching run and task can latch completion", () => {
    const state = { running: true, runId: "r", currentTask: { taskKey: "a", tweetUrl: "https://x.com/a/status/1" } };
    const c = contextFor(background, ["latchLighthouseCompletion", "hasLatchedLighthouseCompletion"], {
      runtimeState: state, normalizeTweetUrl: (s) => s
    });
    const e = { runId: "r", taskKey: "a", tweetUrl: state.currentTask.tweetUrl };
    assert.equal(c.latchLighthouseCompletion({ ...e, taskKey: "b" }, "r"), false);
    assert.equal(c.latchLighthouseCompletion({ ...e, runId: "old" }, "r"), false);
    assert.equal(c.latchLighthouseCompletion(e, "r"), true);
    assert.equal(c.hasLatchedLighthouseCompletion("r"), true);
    state.currentTask = { taskKey: "b" };
    assert.equal(c.hasLatchedLighthouseCompletion("r"), false);
  });
  await test("completed tasks leave the dedupe table, other tasks stay", () => {
    const c = contextFor(background, ["releaseAttemptedTask", "getTaskDedupeKeys", "normalizeTweetUrl", "buildStableTaskKey", "buildTaskTextKey", "normalizeInline"], {
      runtimeState: { attemptedTaskRecords: [
        { key: "task-1", expiresAt: Date.now() + 60000 },
        { key: "https://x.com/other/status/9", expiresAt: Date.now() + 60000 },
        { key: "stable|评论|0.10||old", expiresAt: Date.now() + 60000 }
      ], attemptedTaskKeys: ["task-1", "https://x.com/other/status/9"] }
    });
    c.releaseAttemptedTask({ taskKey: "task-1", tweetUrl: "https://x.com/a/status/1" });
    assert.deepEqual([...c.runtimeState.attemptedTaskRecords].map((r) => r.key), ["https://x.com/other/status/9", "stable|评论|0.10||old"]);
  });
  await test("completion-overlay timeout is rescued by plaza income verification", async () => {
    const state = {
      running: true, runId: "r", mode: "auto", completionEvidence: null,
      currentTask: { taskKey: "a", bounty: 0.1, tweetUrl: "https://x.com/a/status/1" },
      incomeAtTaskStart: 0.3
    };
    const c = contextFor(background, ["waitForLighthouseTaskCompletionAndReturn", "verifyCompletionByPlazaIncome", "latchIncomeVerifiedCompletion"], {
      runtimeState: state, LIGHTHOUSE_CAMPAIGNS_URL: "https://app.lhdao.top/campaigns",
      getOrCreateLighthouseTab: async () => ({ id: 1 }), rememberLighthouseTabById: async () => {},
      hasLatchedLighthouseCompletion: () => Boolean(state.completionEvidence),
      setStage() {}, log() {}, touchAutoRunState() {},
      normalizeTweetUrl: (value) => String(value || ""),
      sendToTab: async () => ({ ok: false, timedOut: true, message: "等待 Lighthouse 显示已完成超时，已保留 X 页面" }),
      closeLighthouseDetailToCampaigns: async () => true,
      readPlazaTodayIncome: async () => 0.4
    });
    const result = await c.waitForLighthouseTaskCompletionAndReturn("r", {});
    assert.equal(result.ok, true);
    assert.equal(result.incomeVerified, true);
    assert.equal(state.completionEvidence.incomeVerified, true);
    assert.equal(state.completionEvidence.taskKey, "a");
  });
  await test("income verification never rescues when the bounty did not land", async () => {
    const state = {
      running: true, runId: "r", mode: "auto", completionEvidence: null,
      currentTask: { taskKey: "a", bounty: 0.1, tweetUrl: "https://x.com/a/status/1" },
      incomeAtTaskStart: 0.3
    };
    const c = contextFor(background, ["waitForLighthouseTaskCompletionAndReturn", "verifyCompletionByPlazaIncome", "latchIncomeVerifiedCompletion"], {
      runtimeState: state, LIGHTHOUSE_CAMPAIGNS_URL: "https://app.lhdao.top/campaigns",
      getOrCreateLighthouseTab: async () => ({ id: 1 }), rememberLighthouseTabById: async () => {},
      hasLatchedLighthouseCompletion: () => false,
      setStage() {}, log() {}, touchAutoRunState() {},
      normalizeTweetUrl: (value) => String(value || ""),
      sendToTab: async () => ({ ok: false, timedOut: true, message: "等待 Lighthouse 显示已完成超时，已保留 X 页面" }),
      closeLighthouseDetailToCampaigns: async () => true,
      readPlazaTodayIncome: async () => Number.NaN
    });
    const result = await c.waitForLighthouseTaskCompletionAndReturn("r", {});
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.equal(state.completionEvidence, null);
  });
  await test("latched completion returns to marketplace without rereading vanished modal", async () => {
    let closed = 0;
    const c = contextFor(background, ["waitForLighthouseTaskCompletionAndReturn"], {
      runtimeState: { running: true, runId: "r", completionEvidence: { taskKey: "a" } },
      getOrCreateLighthouseTab: async () => ({ id: 1 }),
      LIGHTHOUSE_CAMPAIGNS_URL: "https://app.lhdao.top/campaigns",
      rememberLighthouseTabById: async () => {}, hasLatchedLighthouseCompletion: () => true,
      closeLighthouseDetailToCampaigns: async () => { closed += 1; return true; },
      sendToTab: () => { throw new Error("Should not reread modal"); }
    });
    assert.equal((await c.waitForLighthouseTaskCompletionAndReturn("r", {})).ok, true);
    assert.equal(closed, 1);
  });
  await test("confirmed completion forces marketplace recovery instead of stopping the locked order", async () => {
    const evidence = { runId: "r", taskKey: "a", tweetUrl: "https://x.com/a/status/1" };
    let recovered = 0;
    const state = {
      running: true,
      runId: "r",
      currentTask: { taskKey: "a", tweetUrl: evidence.tweetUrl, seatLocked: true },
      completionEvidence: null
    };
    const c = contextFor(background, ["waitForLighthouseTaskCompletionAndReturn", "latchLighthouseCompletion", "hasLatchedLighthouseCompletion"], {
      runtimeState: state,
      LIGHTHOUSE_CAMPAIGNS_URL: "https://app.lhdao.top/campaigns",
      getOrCreateLighthouseTab: async () => ({ id: 1 }),
      rememberLighthouseTabById: async () => {},
      sendToTab: async () => ({ ok: false, completed: true, evidence, message: "列表尚未恢复" }),
      normalizeTweetUrl: (s) => s,
      closeLighthouseDetailToCampaigns: async () => { recovered += 1; return true; },
      setStage() {},
      log() {}
    });
    const result = await c.waitForLighthouseTaskCompletionAndReturn("r", {});
    assert.equal(result.ok, true);
    assert.equal(result.completed, true);
    assert.equal(recovered, 1);
    assert.equal(state.completionEvidence.taskKey, "a");
  });
  await test("completion watch rejects pre-existing evidence and keeps newly observed evidence", () => {
    const old = { innerText: "old result", querySelectorAll: () => [] };
    const fresh = { innerText: "new result", querySelectorAll: () => [] };
    let roots = [old];
    const c = contextFor(page, ["getOfficialCompletionRootFingerprint", "beginCompletionWatch", "checkOfficialCompletion"], {
      completionContext: null, normalizeTweetUrl: (s) => s,
      findTaskDetailRoot: () => null,
      findOfficialCompletionRoots: () => roots
    });
    const message = { runId: "r", task: { taskKey: "a", tweetUrl: "https://x.com/a/status/1" } };
    c.beginCompletionWatch(message);
    assert.equal(c.checkOfficialCompletion(message).completed, false);
    roots = [old, fresh];
    assert.equal(c.checkOfficialCompletion(message).completed, true);
    roots = [];
    assert.equal(c.checkOfficialCompletion(message).completed, true);
    assert.equal(c.checkOfficialCompletion({ ...message, task: { taskKey: "b" } }).completed, false);
  });
  await test("completion watch accepts a replacement panel with identical official text", () => {
    const old = { innerText: "验证成功 · 奖励已到账 +0.10 LUX", querySelectorAll: () => [] };
    const replacement = { innerText: old.innerText, querySelectorAll: () => [] };
    let roots = [old];
    const c = contextFor(page, ["getOfficialCompletionRootFingerprint", "beginCompletionWatch", "checkOfficialCompletion"], {
      completionContext: null, normalizeTweetUrl: (s) => s,
      findOfficialCompletionRoots: () => roots
    });
    const message = { runId: "r", task: { taskKey: "a", tweetUrl: "https://x.com/a/status/1" } };
    c.beginCompletionWatch(message);
    roots = [replacement];
    assert.equal(c.checkOfficialCompletion(message).completed, true);
  });
  await test("official completion is not rejected by an unrelated detail link underneath", () => {
    const root = { innerText: "验证通过 · 已通过 +0.10 LUX", querySelectorAll: () => [] };
    let roots = [];
    const c = contextFor(page, ["getOfficialCompletionRootFingerprint", "beginCompletionWatch", "checkOfficialCompletion"], {
      completionContext: null, normalizeTweetUrl: (s) => s,
      findTaskDetailRoot: () => ({ querySelectorAll: () => [], innerText: "https://x.com/other/status/9" }),
      extractTweetUrl: () => "https://x.com/other/status/9",
      findOfficialCompletionRoots: () => roots
    });
    const message = { runId: "r", task: { taskKey: "a", tweetUrl: "https://x.com/a/status/1" } };
    c.beginCompletionWatch(message);
    roots = [root];
    assert.equal(c.checkOfficialCompletion(message).completed, true);
  });
  await test("real Lighthouse success labels and paid reward text are accepted", () => {
    const c = contextFor(page, ["isOfficialCompletionMarkerText", "hasOfficialCompletionRewardText"]);
    assert.equal(c.isOfficialCompletionMarkerText("验证成功 · 奖励已到账"), true);
    assert.equal(c.isOfficialCompletionMarkerText("验证通过 · 已通过"), true);
    assert.equal(c.hasOfficialCompletionRewardText("已入账至钱包 +0.10 LUX"), true);
    assert.equal(c.isOfficialCompletionMarkerText("审核通过后奖励到账"), false);
  });
  await test("completion counter is idempotent for an already counted task", async () => {
    const state = { runId: "r", mode: "auto", running: true, completed: 1, currentTask: { completionCounted: true } };
    const c = contextFor(background, ["handleLighthouseDone"], {
      runtimeState: state, hasLatchedLighthouseCompletion: () => true
    });
    assert.equal((await c.handleLighthouseDone({ ok: true })).duplicate, true);
    assert.equal(state.completed, 1);
  });
  await test("tier restriction is blocked even when another status label says ready", () => {
    const monitor = read("src/content/lighthouse-monitor.js");
    const c = contextFor(monitor, ["parseStatusFromCard", "hasUnsupportedCommentGuidance"], {
      getVisibleTextBlocks: () => [], BLOCKED_MARKERS: ["档位不符", "需灯塔严选资格"],
      COOLING_MARKERS: ["冷却"], READY_MARKERS: ["查看详情"]
    });
    assert.equal(c.parseStatusFromCard({ innerText: "查看详情 档位不符" }).isBlocked, true);
    assert.equal(c.parseStatusFromCard({ innerText: "无法识别的状态" }).isReady, false);
  });
  await test("old default prompt migrates while a user custom prompt is preserved", () => {
    const nextPrompt = "new grounded prompt";
    const c = contextFor(background, ["migrateSettings"], {
      LIGHTHOUSE_DEFAULT_AI_SYSTEM_PROMPT: nextPrompt,
      DEFAULT_SETTINGS: { replyMode: "post" }
    });
    const migrated = c.migrateSettings({ settingsVersion: 10, aiSystemPrompt: "你是普通中文用户，帮我写一条推文回复。像路过随手回一句。" });
    assert.equal(migrated.settings.aiSystemPrompt, nextPrompt);
    assert.equal(migrated.settings.settingsVersion, 13);
    const custom = c.migrateSettings({ settingsVersion: 10, aiSystemPrompt: "保留我的自定义提示词" });
    assert.equal(custom.settings.aiSystemPrompt, "保留我的自定义提示词");
  });
  await test("captured tweet URL survives an empty task response", () => {
    const c = contextFor(background, ["normalizeTweetUrl", "getTaskMergeIdentity", "mergeTaskPreservingCapturedTweetUrl"]);
    const merged = c.mergeTaskPreservingCapturedTweetUrl(
      { taskKey: "task-1", tweetUrl: "https://x.com/test/status/123" },
      { taskKey: "task-1", tweetUrl: "", awaitingXTabAdoption: true }
    );
    assert.equal(merged.tweetUrl, "https://x.com/test/status/123");
    assert.equal(merged.awaitingXTabAdoption, true);
  });
  await test("a new task never inherits the previous task tweet URL", () => {
    const c = contextFor(background, ["normalizeTweetUrl", "getTaskMergeIdentity", "mergeTaskPreservingCapturedTweetUrl"]);
    const merged = c.mergeTaskPreservingCapturedTweetUrl(
      { taskKey: "task-1", tweetUrl: "https://x.com/old/status/123" },
      { taskKey: "task-2", tweetUrl: "", awaitingXTabAdoption: true }
    );
    assert.equal(merged.taskKey, "task-2");
    assert.equal(merged.tweetUrl, "");
  });
  await test("the same stable task keeps its captured URL when a volatile task key changes", () => {
    const c = contextFor(background, ["normalizeTweetUrl", "getTaskMergeIdentity", "mergeTaskPreservingCapturedTweetUrl"]);
    const merged = c.mergeTaskPreservingCapturedTweetUrl(
      { taskKey: "before-lock-text", stableTaskKey: "stable-task-1", tweetUrl: "https://x.com/test/status/123" },
      { taskKey: "after-lock-text", stableTaskKey: "stable-task-1", tweetUrl: "", seatLocked: true }
    );
    assert.equal(merged.tweetUrl, "https://x.com/test/status/123");
  });
  await test("captured target adopts the matching Lighthouse-created tab before fallback", async () => {
    let adopted = null;
    let directOpens = 0;
    const c = contextFor(background, ["recoverPendingXOpenFromCapturedUrl"], {
      capturedTargetRecoveryPromise: null,
      runtimeState: {
        running: true,
        runId: "run-1",
        xTabId: null,
        currentTask: { seatLocked: true, tweetUrl: "https://x.com/test/status/123" },
        pendingXOpen: { lighthouseTabId: 1, windowId: 2, startedAt: 10 }
      },
      normalizeTweetUrl: (value) => String(value || "").replace(/\?.*$/, ""),
      getBoundMatchingTaskXTab: async () => null,
      consumeXOpenCandidate: () => ({ id: 9, windowId: 2, url: "https://x.com/test/status/123" }),
      findRecentTweetTab: async () => null,
      adoptCurrentXTab: (tab, task, source) => { adopted = { tab, task, source }; },
      openDirectTweetTabIfAvailable: async () => { directOpens += 1; return 10; },
      mergeTaskPreservingCapturedTweetUrl: (current, next, overrides) => ({ ...current, ...next, ...overrides }),
      log() {},
      delay: async () => {}
    });
    assert.equal(await c.recoverPendingXOpenFromCapturedUrl("https://x.com/test/status/123"), 9);
    assert.equal(adopted.source, "site");
    assert.equal(directOpens, 0);
  });
  await test("duplicate captured target recovery creates only one direct fallback tab", async () => {
    let directOpens = 0;
    let releaseDelay;
    const firstDelay = new Promise((resolve) => { releaseDelay = resolve; });
    const c = contextFor(background, ["recoverPendingXOpenFromCapturedUrl"], {
      capturedTargetRecoveryPromise: null,
      runtimeState: {
        running: true,
        runId: "run-1",
        xTabId: null,
        currentTask: { seatLocked: true, tweetUrl: "https://x.com/test/status/123" },
        pendingXOpen: { lighthouseTabId: 1, windowId: 2, startedAt: 10 }
      },
      normalizeTweetUrl: (value) => String(value || "").replace(/\?.*$/, ""),
      getBoundMatchingTaskXTab: async () => null,
      consumeXOpenCandidate: () => null,
      findRecentTweetTab: async () => null,
      adoptCurrentXTab() {},
      openDirectTweetTabIfAvailable: async () => { directOpens += 1; return 10; },
      mergeTaskPreservingCapturedTweetUrl: (current, next, overrides) => ({ ...current, ...next, ...overrides }),
      log() {},
      delay: async () => firstDelay
    });
    const first = c.recoverPendingXOpenFromCapturedUrl("https://x.com/test/status/123");
    const second = c.recoverPendingXOpenFromCapturedUrl("https://x.com/test/status/123");
    releaseDelay();
    assert.equal(await first, 10);
    assert.equal(await second, 10);
    assert.equal(directOpens, 1);
  });
  await test("Lighthouse X wait resumes immediately when the exact tab is already bound", async () => {
    let recentSearches = 0;
    const c = contextFor(background, ["waitForLighthouseOpenedTweet"], {
      runtimeState: {
        running: true,
        runId: "run-1",
        mode: "auto",
        currentTask: { tweetUrl: "https://x.com/test/status/123" }
      },
      sendToTab: async () => ({ ok: true }),
      getLighthouseWindowId: async () => 2,
      normalizeTweetUrl: (value) => String(value || "").replace(/\?.*$/, ""),
      getBoundMatchingTaskXTab: async () => ({ id: 9, windowId: 2, url: "https://x.com/test/status/123" }),
      rememberLighthouseTabById: async () => null,
      consumeXOpenCandidate: () => null,
      findRecentTweetTab: async () => { recentSearches += 1; return null; },
      delay: async () => {}
    });
    assert.equal(await c.waitForLighthouseOpenedTweet(
      { tweetUrl: "https://x.com/test/status/123" },
      1,
      "auto",
      { timeoutMs: 1000 }
    ), true);
    assert.equal(recentSearches, 0);
  });
  await test("settings v13 fills Terra model only for Terra and defaults a missing reply mode to post", () => {
    const c = contextFor(background, ["migrateSettings"], {
      LIGHTHOUSE_DEFAULT_AI_SYSTEM_PROMPT: "new prompt",
      DEFAULT_SETTINGS: { replyMode: "post" }
    });
    const terra = c.migrateSettings({ settingsVersion: 12, aiProvider: "gpt-5.6-terra", aiModel: "" });
    assert.equal(terra.settings.aiModel, "gpt-5.6-terra");
    assert.equal(terra.settings.replyMode, "post");
    assert.equal(terra.settings.settingsVersion, 13);
    const deepseek = c.migrateSettings({ settingsVersion: 12, aiProvider: "deepseek", aiModel: "", replyMode: "fill" });
    assert.equal(deepseek.settings.aiModel, "");
    assert.equal(deepseek.settings.replyMode, "fill");
  });
}
console.log(`${platform}: ${passed} behavioral checks passed.`);
