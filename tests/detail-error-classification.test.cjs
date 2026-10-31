const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = readFileSync(path.join(__dirname, "../src/content/lighthouse.js"), "utf8");

function declaration(name) {
  const match = new RegExp(`^([ \\t]*)(?:async )?function ${name}\\(`, "m").exec(source);
  assert.ok(match, `Missing production function: ${name}`);
  const next = new RegExp(`^${match[1]}(?:async )?function \\w+\\(`, "gm");
  next.lastIndex = match.index + match[0].length;
  return source.slice(match.index, next.exec(source)?.index ?? source.lastIndexOf("})();"));
}

function detail(text) {
  const root = { innerText: text };
  const c = vm.createContext({
    document: { body: root },
    location: { pathname: "/campaigns", href: "https://app.lhdao.top/campaigns" },
    activeRunId: "detail-test",
    assertActiveRun() {},
    report() {},
    findTaskDetailRoot: () => root,
    findTaskDetailCloseButton: () => ({}),
    hasTaskDetailOverlayShell: () => true,
    isTaskDetailOpen: () => true,
    hasTaskDetailLoadingModal: () => false,
    hasPageLoadingState: () => false,
    isCampaignsListOpen: () => false,
    TASK_UNAVAILABLE_MARKERS: JSON.parse(source.match(/const TASK_UNAVAILABLE_MARKERS = (\[[^;]+\]);/)[1])
  });
  for (const name of ["normalize", "hasDetailRequestTimeout", "hasTaskUnavailableError",
    "hasRecoverableDetailLoadFailure", "getLighthousePageSnapshot", "describePagePhase", "confirmPagePhase"]) {
    vm.runInContext(declaration(name), c);
  }
  return c;
}

for (const text of [
  "评论任务 2 LUX 在 X 打开 锁定席位 普通任务正文",
  "评论任务 2 LUX 在 X 打开 等待下一批释放 · 02:31 · +2 席 这个视频好，解释了 hyperliquid:native 这类财库公司的业务",
  "评论任务 2 LUX 在 X 打开 锁定席位 任务 id: abc-123"
]) {
  test(`normal detail remains ready: ${text}`, async () => {
    const c = detail(text);
    assert.equal(c.hasRecoverableDetailLoadFailure(), false);
    assert.equal(c.getLighthousePageSnapshot().phase, "detail_ready");
    const snapshot = await c.confirmPagePhase(["detail_ready"], {}, "打开任务详情后");
    assert.equal(snapshot.phase, "detail_ready");
  });
}

for (const error of [
  "详情加载失败",
  "Request timeout id: abc-123",
  "Request timeout",
  "Failed to fetch id: abc-123",
  "任务暂时无法打开"
]) {
  test(`real detail failure still blocks progress: ${error}`, async () => {
    const c = detail(`评论任务 2 LUX 在 X 打开 ${error}`);
    assert.equal(c.hasRecoverableDetailLoadFailure(), true);
    assert.equal(c.getLighthousePageSnapshot().phase, "detail_error");
    await assert.rejects(
      c.confirmPagePhase(["detail_ready"], {}, "打开任务详情后"),
      /打开任务详情后状态确认失败：详情页报错/
    );
  });
}
