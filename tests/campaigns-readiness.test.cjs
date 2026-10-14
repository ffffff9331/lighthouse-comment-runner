"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/content/lighthouse.js"), "utf8");
function declaration(name) {
  const start = source.search(new RegExp(`^  (?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, `Missing ${name}`);
  const next = /^  (?:async )?function \w+\(/gm;
  next.lastIndex = start + 1;
  return source.slice(start, next.exec(source)?.index ?? source.lastIndexOf("})();"));
}

function page({ loading = false, overlay = false, completed = false, heading = true,
  controls = ["可抢 0", "进行中 36", "全部", "评论"], pathname = "/campaigns", cards = [] } = {}) {
  let now = 0;
  const reports = [];
  const node = (text) => ({ innerText: text, textContent: text, visible: true });
  const c = vm.createContext({
    document: {
      body: { innerText: "任务广场 今日任务收入 全部 评论 原创推文 总奖池 3,000 LUX 档位不符" },
      querySelectorAll(selector) {
        if (selector === "h1,h2,[role='heading']") return heading ? [node("任务广场")] : [];
        if (selector === "button,[role='button']") return controls.map(node);
        return [];
      },
    },
    location: { pathname }, Date: { now: () => now }, activeRunId: "readiness-run",
    COMMENT_MARKERS: ["评论"], COMMENT_EQUIVALENT_MARKERS: ["点赞"],
    normalize: (value) => String(value).replace(/\s+/g, " ").trim(),
    buttonText: (value) => value.innerText,
    isVisible: (value) => value.visible,
    hasPageLoadingState: () => loading,
    hasOfficialCompletionEvidence: () => completed,
    isTaskDetailOrRecoverableOverlayOpen: () => overlay,
    isTaskDetailOpen: () => overlay,
    collectVisibleTaskLikeNodes: () => cards,
    assertActiveRun() {},
    report: (_level, message) => reports.push(message),
    formatDuration: (ms) => `${ms}ms`,
    wait: async (ms) => { now += ms; },
  });
  for (const name of ["hasLoadedCampaignListShell", "isCampaignsListOpen", "waitForCampaignsReady"])
    vm.runInContext(declaration(name), c);
  return { c, reports, now: () => now };
}

test("loaded plaza with only unsupported cards is ready without waiting for comment cards", async () => {
  const p = page({ controls: ["可抢 1", "进行中 36", "全部", "原创推文"] });
  assert.equal(p.c.isCampaignsListOpen(), true);
  assert.equal(await p.c.waitForCampaignsReady(1000), true);
  assert.equal(p.now(), 0);
  assert.deepEqual(p.reports, []);
});

test("loaded empty plaza is ready to wait for new eligible tasks", async () => {
  const p = page();
  assert.equal(p.c.isCampaignsListOpen(), true);
  assert.equal(await p.c.waitForCampaignsReady(1000), true);
});

test("sidebar text or incomplete tab data alone cannot prove the list has loaded", async () => {
  for (const options of [{ heading: false }, { controls: ["全部", "评论", "可抢"] }]) {
    const p = page(options);
    assert.equal(p.c.isCampaignsListOpen(), false);
    await assert.rejects(p.c.waitForCampaignsReady(1000), /等待任务广场加载超时/);
  }
});

test("loading skeleton, task overlay and completion overlay remain outside the ready list", async () => {
  for (const options of [{ loading: true }, { overlay: true }, { completed: true }]) {
    const p = page(options);
    assert.equal(p.c.isCampaignsListOpen(), false);
    await assert.rejects(p.c.waitForCampaignsReady(1000), /等待任务广场加载超时/);
  }
});

test("detail routes cannot use the empty-list readiness fallback", async () => {
  const p = page({ pathname: "/campaigns/order-123" });
  assert.equal(p.c.isCampaignsListOpen(), false);
  await assert.rejects(p.c.waitForCampaignsReady(1000), /等待任务广场加载超时/);
});
