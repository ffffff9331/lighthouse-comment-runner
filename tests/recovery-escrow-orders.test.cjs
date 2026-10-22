"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function page(options = {}) {
  let listener;
  const state = { open: options.open !== false, clicks: 0, loading: false };
  const node = (innerText, extra = {}) => ({ innerText, visible: true, ...extra });
  const cards = (options.statuses || ["待到账", "待到账", "待到账"]).map(status => node(
    `${status} 互动任务 待到账奖励 0.05 LUX 预计到账时间 2026/10/23 GMT+8 11:32:16 查看进度`, {
      querySelectorAll(selector) {
        if (selector === "button") return [node("查看进度")];
        if (selector === "span,p,div") return [node(status), node("待到账奖励"), node("预计到账时间")];
        return [];
      }
    }));
  const counter = node(`进行中 ${options.count ?? cards.length}`, {
    click() { state.clicks++; state.open = true; },
    classList: { contains: name => name === "on" && state.open }
  });
  const document = { body: {}, querySelectorAll(selector) {
    if (selector === "button[data-tab='ongoing']") return [counter];
    if (selector === "h1,h2,[role='heading']") return state.open ? [node("我的进行中任务")] : [];
    if (selector === "main article[role='button']") return state.open ? cards : [];
    if (selector === "main [role='combobox'],main select") return state.open ? [node(options.filter || "全部")] : [];
    return [];
  }};
  const context = vm.createContext({ console, URL, setTimeout, clearTimeout, document, fixture: state,
    location: { pathname: "/campaigns", href: "https://app.lhdao.top/campaigns" },
    window: { addEventListener() {} }, chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } },
      async sendMessage() { return { ok: true, paused: false }; } } } });
  const source = fs.readFileSync(path.join(__dirname, "../src/content/lighthouse.js"), "utf8");
  const end = source.lastIndexOf("})();");
  vm.runInContext(source.slice(0, end) + `
    isVisible = node => node.visible;
    hasPageLoadingState = () => fixture.loading;
    hasLoadedCampaignListShell = () => !fixture.open && !fixture.loading;
    readBoundOrderOutcome = () => ({ outcome: "unknown" });
    findExecutionDialog = () => ({ present: ${Boolean(options.execution)} });
    findTaskDetailRoot = () => null;
    getStandaloneInvitationState = () => "absent";
  ` + source.slice(end), context);
  const dispatch = message => { let result; listener({ platform: "lighthouse", runId: "recovery", recoveryId: "recovery", ...message }, {}, value => { result = value; }); return result; };
  return { state, dispatch, read: () => dispatch({ type: "CHECK_LIGHTHOUSE_RECOVERY_STATE" }) };
}

test("complete unfiltered pending-payout list proves no unfinished work, not task completion", () => {
  const result = page().read();
  assert.equal(result.activeCount, 0);
  assert.equal(result.listedCount, 3);
  assert.equal(result.ongoingReady, true);
  assert.equal(result.outcome, "unknown");
});
test("one unfinished order among escrow records remains a recovery blocker", () => {
  const result = page({ statuses: ["待到账", "待完成", "待到账"] }).read();
  assert.equal(result.activeCount, 3);
});
for (const options of [{ count: 4 }, { filter: "待到账" }, { statuses: ["未知状态"] }]) {
  test(`partial, filtered or unknown lists cannot release an intent: ${JSON.stringify(options)}`, () => {
    assert.notEqual(page(options).read().activeCount, 0);
  });
}
test("loading list cannot authorize recovery", () => {
  const fixture = page(); fixture.state.loading = true;
  assert.notEqual(fixture.read().activeCount, 0);
});
test("recovery can open only the ongoing list without touching an order", () => {
  const fixture = page({ open: false });
  const before = fixture.read();
  const opened = fixture.dispatch({ type: "OPEN_LIGHTHOUSE_RECOVERY_ORDERS", instanceId: before.instanceId });
  assert.equal(opened.ok, true);
  assert.equal(fixture.state.clicks, 1);
  assert.equal(fixture.read().activeCount, 0);
});
test("manual pause rejects recovery navigation", () => {
  const fixture = page({ open: false });
  const before = fixture.read();
  fixture.dispatch({ type: "AUTOMATION_PAUSE_CHANGED", paused: true });
  const opened = fixture.dispatch({ type: "OPEN_LIGHTHOUSE_RECOVERY_ORDERS", instanceId: before.instanceId });
  assert.equal(opened.ok, false);
  assert.equal(fixture.state.clicks, 0);
});
test("an execution dialog blocks navigating away to inspect escrow records", () => {
  const fixture = page({ open: false, execution: true });
  const before = fixture.read();
  const opened = fixture.dispatch({ type: "OPEN_LIGHTHOUSE_RECOVERY_ORDERS", instanceId: before.instanceId });
  assert.equal(opened.ok, false);
  assert.equal(fixture.state.clicks, 0);
});
