const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

// The override runs this same frozen regression against the original read-only
// checkout before production changes are applied in the isolated worktree.
const sourceRoot = process.env.LIGHTHOUSE_TEST_SOURCE_ROOT || path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(sourceRoot, "src", file), "utf8");
const settings = { enableCooldownSniping: true, autoMinTaskBounty: 0.1 };

function pageHarness(cards, onWait = () => {}) {
  const start = 1000000;
  let now = start;
  let listener;
  const observations = [];
  const context = vm.createContext({
    console,
    URL,
    Date: class extends Date { static now() { return now; } },
    window: { addEventListener() {} },
    document: { body: { innerText: "任务广场" } },
    location: { href: "https://app.lhdao.top/campaigns", pathname: "/campaigns" },
    chrome: { runtime: {
      onMessage: { addListener(fn) { listener = fn; } },
      async sendMessage() { return { ok: true }; },
    } },
    fixtureWait: async (ms) => {
      now += ms;
      onWait({ elapsed: now - start, now, stop() {
        listener({ type: "AUTOMATION_PAUSE_CHANGED", paused: true }, {}, () => {});
      } });
    },
    fixtureCollect: (keys) => {
      const attempted = new Set(keys);
      const candidates = cards.map((card) => ({
        isAutomatable: true,
        isBlocked: false,
        cooldownMs: 0,
        bounty: 0.2,
        target: {},
        text: `comment ${card.taskKey}`,
        taskType: "评论",
        title: card.taskKey,
        ...card,
        attempted: [card.taskKey, card.selectionId, card.stableTaskKey].some((key) => key && attempted.has(key)),
      }));
      observations.push({ elapsed: now - start, candidates: candidates.map(({ taskKey, attempted }) => ({ taskKey, attempted })) });
      return candidates;
    },
  });
  const source = read("content/lighthouse.js");
  const end = source.lastIndexOf("})();");
  assert.ok(end > 0);
  const fixture = `
    activeRunId = "expiry-run";
    claimOperation = { runId: activeRunId, claimActionAttempted: false };
    waitForCampaignsReady = async () => {};
    ensureCampaignsPage = async () => {};
    confirmPagePhase = async () => {};
    ensureAllTaskFilter = async () => {};
    isTaskDetailOrRecoverableOverlayOpen = () => false;
    isCampaignsListOpen = () => true;
    getLiveAutoMinTaskBounty = async () => 0.1;
    collectTaskCandidates = fixtureCollect;
    wait = fixtureWait;
    report = () => {};
    openTaskDetailOrFail = async () => {};
    acceptInvitationIfPresent = async () => false;
    buildTask = () => ({ taskType: "评论", taskKey: "detail-key", tweetUrl: "https://x.com/example/status/123" });
    assertSupportedDetailTask = () => {};
    globalThis.page = { selectNextCommentTask, debugOpenFirstCommentTask };
  `;
  vm.runInContext(source.slice(0, end) + fixture + "\n" + source.slice(end), context);
  return { page: context.page, start, observations, elapsed: () => now - start };
}

test("a temporary exclusion expires inside the same continuous plaza scan", async () => {
  const h = pageHarness([{ taskKey: "failed-task" }]);
  const selected = await h.page.selectNextCommentTask(settings, ["failed-task"], [
    { key: "failed-task", expiresAt: h.start + 180000 },
  ]);
  assert.equal(selected.taskKey, "failed-task");
  assert.equal(h.elapsed(), 180000);
  assert.equal(h.observations.at(-2).candidates[0].attempted, true);
  assert.equal(h.observations.at(-1).candidates[0].attempted, false);
});

test("a not-yet-expired failed task stays excluded while another card is selectable", async () => {
  const h = pageHarness([
    { taskKey: "failed-task", bounty: 0.5 },
    { taskKey: "available-task", bounty: 0.2 },
  ]);
  const selected = await h.page.selectNextCommentTask(settings, ["failed-task"], [
    { key: "failed-task", expiresAt: h.start + 180000 },
  ]);
  assert.equal(selected.taskKey, "available-task");
  assert.equal(h.elapsed(), 0);
  assert.equal(h.observations[0].candidates[0].attempted, true);
});

test("expiring a temporary key preserves permanent exclusions", async () => {
  const h = pageHarness([
    { taskKey: "temporary-task", bounty: 0.2 },
    { taskKey: "permanent-task", bounty: 1 },
  ]);
  const selected = await h.page.selectNextCommentTask(settings, ["temporary-task", "permanent-task"], [
    { key: "temporary-task", expiresAt: h.start + 1000 },
  ]);
  assert.equal(selected.taskKey, "temporary-task");
  assert.equal(h.elapsed(), 1000);
  assert.ok(h.observations.every((round) => round.candidates[1].attempted));
});

test("a future deferred retry deadline is not replaced by the ordinary three-minute window", async () => {
  const h = pageHarness([{ taskKey: "deferred-task" }], ({ elapsed, stop }) => {
    if (elapsed === 180500) stop();
  });
  await assert.rejects(
    h.page.selectNextCommentTask(settings, ["deferred-task"], [
      { key: "deferred-task", expiresAt: h.start + 600000 },
    ]),
    /已停止|已取消|旧任务/,
  );
  assert.ok(h.observations.every((round) => round.candidates[0].attempted));
  assert.equal(h.observations.at(-1).elapsed, 180000);
});

test("STOP at the expiry boundary cancels before the newly eligible card is selected", async () => {
  const h = pageHarness([{ taskKey: "failed-task" }], ({ elapsed, stop }) => {
    if (elapsed === 1000) stop();
  });
  await assert.rejects(
    h.page.selectNextCommentTask(settings, ["failed-task"], [
      { key: "failed-task", expiresAt: h.start + 1000 },
    ]),
    /已停止|已取消|旧任务/,
  );
  assert.equal(h.elapsed(), 1000);
  assert.equal(h.observations.at(-1).elapsed, 500);
  assert.ok(h.observations.every((round) => round.candidates[0].attempted));
});

test("the task-opening message forwards expiry records to the continuous scan", async () => {
  const h = pageHarness([{ taskKey: "failed-task" }]);
  const result = await h.page.debugOpenFirstCommentTask(settings, {
    attemptedTaskKeys: ["failed-task"],
    attemptedTaskRecords: [{ key: "failed-task", expiresAt: h.start + 1000 }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.task.taskKey, "failed-task");
  assert.equal(h.elapsed(), 1000);
});

function reloadHarness(waitResult) {
  const source = read("background.js");
  const start = source.indexOf("async function reloadLighthouseCampaignsAfterOrder(");
  const end = source.indexOf("\nasync function ", start + 1);
  assert.ok(start >= 0 && end > start);
  const logs = [];
  let reloads = 0;
  const context = vm.createContext({
    Date,
    lastCampaignsRefreshAt: 0,
    chrome: { tabs: { async reload(tabId) { assert.equal(tabId, 7); reloads++; } } },
    waitForTabComplete: async () => waitResult,
    log: (level, text) => logs.push({ level, text }),
  });
  vm.runInContext(source.slice(start, end), context);
  return { run: context.reloadLighthouseCampaignsAfterOrder, logs, reloads: () => reloads };
}

test("a failed post-order reload wait returns false and does not report a completed refresh", async () => {
  const h = reloadHarness(false);
  assert.equal(await h.run(7, "接单失败，已重新加载任务广场"), false);
  assert.equal(h.reloads(), 1);
  assert.equal(h.logs.some((entry) => entry.level === "info" && entry.text.includes("已重新加载")), false);
  assert.ok(h.logs.some((entry) => /超时|失败/.test(entry.text)));
});

test("a confirmed post-order reload still reports success exactly once", async () => {
  const h = reloadHarness(true);
  assert.equal(await h.run(7, "接单失败，已重新加载任务广场"), true);
  assert.equal(h.reloads(), 1);
  assert.equal(h.logs.filter((entry) => entry.level === "info" && entry.text.includes("已重新加载")).length, 1);
});
