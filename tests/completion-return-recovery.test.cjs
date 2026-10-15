"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Run unchanged assertions against the saved pre-fix source when requested.
// Both production listeners and the entire background consumer remain real;
// only DOM, Chrome APIs, and the clock are fixtures. No network is permitted.
const sourceRoot = process.env.LIGHTHOUSE_TEST_SOURCE_ROOT || path.join(__dirname, "../src");
const read = (file) => fs.readFileSync(path.join(sourceRoot, file), "utf8");
const copy = (value) => JSON.parse(JSON.stringify(value));
const event = { addListener() {} };
const task = { taskKey: "completion-order", candidateTitle: "当前订单标题", tweetUrl: "https://x.com/current/status/123", taskType: "评论", bounty: 0.2, seatLocked: true };
const runId = "completion-run";
const settings = { actionDelayMs: 500, lockSeatTimeoutMs: 60000 };
const noNetwork = async () => { throw Error("Network forbidden in completion recovery tests"); };

function contentPage(options = {}) {
  let now = 1000000, listener;
  const state = { root: null, plaza: false, clicks: 0, waited: 0, receipts: [], logs: [], ongoingClicks: 0, progressClicks: 0, detailCloses: 0,
    listOpen: Boolean(options.listInitiallyOpen), ongoingSince: 0, scrolled: false, staleProgressClicks: 0 };
  let resultDialog;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  function node(text, width = 100, height = 30) {
    return { innerText: text, textContent: text, disabled: false, isConnected: true,
      getBoundingClientRect: () => ({ left: 100, top: 180, right: 100 + width, bottom: 180 + height, width, height }),
      getAttribute: () => "", classList: { contains: () => false }, scrollIntoView() {},
      querySelectorAll: () => [], contains(other) { return other === this; }, closest() { return this; }
    };
  }
  const button = node("打开任务广场", 140, 40);
  button.click = () => { state.clicks++; if (options.buttonWorks !== false) { state.plaza = true; state.root = null; } };
  const heading = node("任务广场");
  const filters = ["全部", "可抢 0", "进行中 1"].map((text) => node(text));
  const ongoing = node("进行中 1");
  ongoing.getAttribute = name => name === "data-tab" ? "ongoing" : "";
  ongoing.classList.contains = name => name === "on" && state.listOpen;
  ongoing.click = () => { state.ongoingClicks++; state.listOpen = !options.neverOpens; state.ongoingSince = state.waited; options.onOngoing?.(state); };
  const cardTitle = node(task.candidateTitle);
  cardTitle.getAttribute = (name) => name === "title" ? options.cardTitle || task.candidateTitle : "";
  const progress = node("查看进度");
  progress.click = () => { state.progressClicks++; if (!options.progressDoesNothing) showCompletion(options.reconcileTarget || task.tweetUrl); };
  const replacementProgress = node("查看进度");
  replacementProgress.click = progress.click;
  const progressRect = progress.getBoundingClientRect;
  progress.getBoundingClientRect = () => options.offscreenProgress && !state.scrolled ? { width: 0, height: 0 } : progressRect();
  const card = node(`待到账 ${task.candidateTitle} 待到账奖励 ${options.cardBounty ?? 0.2} LUX 查看进度`, 500, 200);
  card.scrollIntoView = () => {
    state.scrolled = true;
    if (options.replaceProgressAfterScroll) {
      progress.isConnected = false;
      progress.click = () => { state.staleProgressClicks++; };
    }
  };
  card.querySelectorAll = selector => selector === "[title]" ? [cardTitle] : selector === "button"
    ? options.replaceProgressAfterScroll && state.scrolled ? [replacementProgress] : [progress] : [];
  const cardRect = card.getBoundingClientRect;
  card.getBoundingClientRect = () => options.hiddenCard || !state.listOpen ? { width: 0, height: 0 } : cardRect();
  const close = node("Close");
  const staleDetail = node("任务详情 席位已锁定", 500, 300);
  staleDetail.querySelectorAll = () => [close];
  close.click = () => { state.detailCloses++; staleDetail.isConnected = false; };
  const document = {
    body: { get innerText() { return state.plaza ? "任务广场 全部 可抢 0 进行中 1" : state.root?.innerText || "等待任务验证"; } },
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === "[role='dialog']") return resultDialog ? [resultDialog] : options.staleDetail && staleDetail.isConnected ? [staleDetail] : [];
      if (selector === "main button") return options.reconcile ? [ongoing] : [];
      if (selector === "main article[role='button']") return options.reconcile && (state.ongoingClicks || state.listOpen)
        && state.waited - state.ongoingSince >= (options.cardsDelayMs || 0)
        ? options.duplicateCards ? [card, card] : [card] : [];
      if (selector === "[role='dialog'],main,section,article,div" || selector === "[role='dialog'],section,article,div") return state.root ? [state.root] : [];
      if (selector === "h1,h2,[role='heading']") return state.plaza ? [heading] : [];
      if (selector === "body *") return [];
      if (selector.includes("button") || selector === "div,span,p,button") {
        return state.plaza ? filters : state.root && options.returnButton ? [button] : [];
      }
      return [];
    },
    createTreeWalker: () => ({ nextNode: () => false })
  };
  function showCompletion(tweetUrl = task.tweetUrl) {
    const markerText = options.markerText || "任务验证通过";
    const marker = node(markerText);
    const root = node(`${markerText} ${options.rewardText || "已到账奖励"} 0.2 LUX${options.returnButton ? " 打开任务广场" : ""}`, 500, 300);
    const link = { href: tweetUrl, innerText: options.missingOriginalLink ? "" : "查看原推文" };
    const identityScope = node(`任务详情 ${markerText}`);
    identityScope.querySelectorAll = () => [link];
    if (state.progressClicks) resultDialog = identityScope;
    root.closest = () => identityScope;
    root.querySelectorAll = (selector) => selector === "a[href]" ? options.linkOutsideResult ? [] : [link] : selector === "h1,h2,h3,p,span,div" ? [marker] : [];
    root.contains = (other) => other === root || other === marker || other === link;
    state.root = root;
    return root;
  }
  const c = vm.createContext({ console, URL, Date: Clock, setTimeout, clearTimeout, fetch: noNetwork,
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    window: { innerWidth: 1400, innerHeight: 1000, addEventListener() {} }, document,
    location: { pathname: "/campaigns", href: "https://app.lhdao.top/campaigns" },
    getComputedStyle: () => ({ visibility: "visible", display: "block", position: "static", zIndex: "auto" }),
    fixtureWait: async (ms) => {
      now += ms; state.waited += ms;
      await options.afterWait?.(state, ms);
      if (state.waited > 70000) throw Error("Fixture exceeded completion timeout boundary");
    },
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } },
      sendMessage: async (message) => { state.logs.push(copy(message)); return { ok: true }; }
    } }
  });
  const source = read("content/lighthouse.js"), end = source.lastIndexOf("})();");
  vm.runInContext(source.slice(0, end) + "\nwait = fixtureWait;\n" + source.slice(end), c);
  const dispatch = (message) => new Promise((resolve) => {
    assert.equal(listener({ runId, task, settings, ...message }, {}, (result) => {
      state.receipts.push({ type: message.type, result: copy(result) }); resolve(result);
    }), true);
  });
  return { state, Clock, showCompletion, dispatch,
    begin: (overrides = {}) => dispatch({ type: "BEGIN_LIGHTHOUSE_COMPLETION_WATCH", ...overrides }),
    check: (overrides = {}) => dispatch({ type: "CHECK_LIGHTHOUSE_OFFICIAL_COMPLETION", ...overrides }),
    wait: (overrides = {}) => dispatch({ type: "WAIT_LIGHTHOUSE_COMPLETION_RETURN", ...overrides })
  };
}

async function background(page, responseEdit, options = {}) {
  const stored = {}, sent = [], reloads = [], updates = [];
  const tab = { id: 11, windowId: 1, url: "https://app.lhdao.top/campaigns", status: "complete", active: options.active ?? true };
  const chrome = {
    runtime: { id: "test", getURL: (p) => `chrome-extension://test/${p}`, getManifest: () => ({ version: "test" }), onInstalled: event, onMessage: event },
    storage: { local: { setAccessLevel: async () => {},
      get: async (keys) => Object.fromEntries(keys.map((key) => [key, stored[key]])),
      set: async (values, callback) => { Object.assign(stored, copy(values)); callback?.(); }
    } },
    alarms: { onAlarm: event, create: async () => {}, clear: async () => {} },
    scripting: { executeScript: async () => [] },
    tabs: { onCreated: event, onUpdated: event, onRemoved: event,
      get: async () => ({ ...tab }), query: async () => [{ ...tab }],
      update: async (id, patch) => { updates.push({ id, ...patch }); Object.assign(tab, patch); await options.onUpdate?.(id, patch); return { ...tab }; },
      reload: async (id) => { reloads.push(id); page.state.plaza = true; page.state.root = null; },
      sendMessage: async (_id, message) => {
        sent.push(copy(message));
        if (message.type === "WAIT_LIGHTHOUSE_COMPLETION_RETURN") {
          const result = await page.dispatch(message);
          return responseEdit ? responseEdit(result, message) : result;
        }
        // The close UI can fail independently of official completion. Keep
        // the real worker's fallback reload logic under test at this API edge.
        if (message.type === "CLOSE_LIGHTHOUSE_TASK_DETAIL") return { ok: false, message: "页面内关闭未确认" };
        throw Error("Unexpected Chrome message: " + message.type);
      }
    }
  };
  const c = vm.createContext({ chrome, console, URL, Date: page.Clock, AbortController,
    importScripts() {}, fetch: noNetwork, clearTimeout,
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; }
  });
  for (const file of ["reply-engine.js", "background.js"]) vm.runInContext(read(file), c, { filename: file });
  await vm.runInContext("runtimeStateReady", c);
  c.fixtureTask = copy(task);
  vm.runInContext(`Object.assign(runtimeState, { running: true, mode: "auto", stage: "x_task_submitted", runId: "${runId}",
    lighthouseTabId: 11, lighthouseWindowId: 1, runtimeWindowId: 1, currentTask: fixtureTask,
    completionEvidence: null, incomeAtTaskStart: 1,
    uncertainAction: {type: "COMPLETE_X_TASK_WIDGET", runId: "${runId}", taskKey: fixtureTask.taskKey} })`, c);
  return { c, stored, sent, reloads, updates, state: () => vm.runInContext("runtimeState", c),
    run: () => c.waitForLighthouseTaskCompletionAndReturn(runId, settings) };
}

function assertCurrentEvidence(evidence) {
  assert.ok(evidence, "the receipt must preserve observed official completion evidence");
  assert.equal(evidence.runId, runId);
  assert.equal(evidence.taskKey, task.taskKey);
  assert.equal(evidence.tweetUrl, task.tweetUrl);
  assert.match(evidence.text, /任务验证通过/);
}
function assertUnconfirmed(result) {
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.notEqual(result.completed, true);
  assert.equal(result.evidence, undefined);
}
const closed = (w) => w.sent.filter((message) => message.type === "CLOSE_LIGHTHOUSE_TASK_DETAIL");

test("confirmed current-order result without a return control preserves completed evidence", async () => {
  const p = contentPage();
  await p.begin(); p.showCompletion();
  const result = await p.wait();
  assert.equal(result.ok, false);
  assert.equal(result.completed, true);
  assertCurrentEvidence(result.evidence);
  assert.equal(p.state.plaza, false);
  assert.equal(p.state.clicks, 0);
});

for (const markerText of ["验证成功 · 奖励托管中", "验证通过 · 已通过"]) {
  test(`platform approval in escrow is recognized: ${markerText}`, async () => {
    const p = contentPage({ markerText, rewardText: "奖励托管中，尚未到账" });
    await p.begin(); p.showCompletion();
    const result = await p.wait();
    assert.equal(result.completed, true);
    assert.equal(result.evidence.taskKey, task.taskKey);
    assert.match(result.evidence.text, /尚未到账/);
  });
}

test("real content receipt lets the background recover the plaza after a completed order", async () => {
  const p = contentPage();
  await p.begin(); p.showCompletion();
  const w = await background(p), result = await w.run();
  assert.equal(result.ok, true);
  assert.equal(result.completed, true);
  assertCurrentEvidence(result.evidence);
  assert.equal(w.state().stage, "campaigns_returned");
  assert.equal(w.state().running, true);
  assert.equal(w.state().uncertainAction, null);
  assert.equal(closed(w).length, 1);
  assert.deepEqual(w.reloads, [11]);
  assert.equal(p.state.plaza, true);
});

test("observed completion survives its panel disappearing before any return control appears", async () => {
  const p = contentPage();
  await p.begin(); p.showCompletion();
  const observed = await p.check();
  assert.equal(observed.completed, true);
  p.state.root = null;
  const result = await p.wait();
  assert.equal(result.completed, true);
  assertCurrentEvidence(result.evidence);
  assert.deepEqual(copy(result.evidence), copy(observed.evidence));
});

test("normal return-button success retains real completion proof and needs no forced reload", async () => {
  const p = contentPage({ returnButton: true });
  await p.begin(); p.showCompletion();
  const w = await background(p), result = await w.run();
  assert.equal(result.ok, true);
  assertCurrentEvidence(result.evidence);
  assertCurrentEvidence(w.state().completionEvidence);
  assert.equal(w.state().stage, "campaigns_returned");
  assert.equal(w.state().uncertainAction, null);
  assert.equal(p.state.clicks, 1);
  assert.equal(closed(w).length, 0);
  assert.deepEqual(w.reloads, []);
});

test("a confirmed completion with an ineffective return button still permits background recovery", async () => {
  const p = contentPage({ returnButton: true, buttonWorks: false });
  await p.begin(); p.showCompletion();
  const w = await background(p), result = await w.run();
  assert.equal(result.ok, true);
  assertCurrentEvidence(result.evidence);
  assert.equal(p.state.clicks, 1);
  assert.equal(closed(w).length, 1);
  assert.deepEqual(w.reloads, [11]);
});

test("a timeout that never observed official completion cannot clear the pending order or reload", async () => {
  const p = contentPage(); await p.begin();
  const w = await background(p), intent = w.state().uncertainAction;
  const result = await w.run();
  assertUnconfirmed(result);
  assert.ok(p.state.waited >= 60000);
  assert.equal(w.state().completionEvidence, null);
  assert.equal(w.state().uncertainAction, intent);
  assert.equal(closed(w).length, 0);
  assert.deepEqual(w.reloads, []);
});

test("a pre-existing unchanged official result panel is old evidence and cannot release this order", async () => {
  const p = contentPage({ returnButton: true });
  p.showCompletion(); await p.begin();
  const w = await background(p), intent = w.state().uncertainAction;
  assertUnconfirmed(await w.run());
  assert.equal(p.state.clicks, 0);
  assert.equal(w.state().uncertainAction, intent);
  assert.equal(w.state().completionEvidence, null);
  assert.deepEqual(w.reloads, []);
});

test("a fresh official result with a different target tweet cannot release this order", async () => {
  const p = contentPage({ returnButton: true });
  await p.begin(); p.showCompletion("https://x.com/other/status/999");
  const w = await background(p), intent = w.state().uncertainAction;
  assertUnconfirmed(await w.run());
  assert.equal(p.state.clicks, 0);
  assert.equal(w.state().uncertainAction, intent);
  assert.equal(w.state().completionEvidence, null);
  assert.deepEqual(w.reloads, []);
});

for (const [name, beginOverride] of [
  ["different order", { task: { ...task, taskKey: "other-order" } }],
  ["previous run", { runId: "previous-run" }]
]) {
  test(`content cannot reuse cached completion evidence from a ${name}`, async () => {
    const p = contentPage({ returnButton: true });
    await p.begin(beginOverride); p.showCompletion();
    assert.equal((await p.check(beginOverride)).completed, true);
    assertUnconfirmed(await p.wait());
    assert.equal(p.state.clicks, 0);
  });
}

for (const [name, edit] of [
  ["different order", (evidence) => { evidence.taskKey = "other-order"; }],
  ["previous run", (evidence) => { evidence.runId = "previous-run"; }],
  ["different tweet", (evidence) => { evidence.tweetUrl = "https://x.com/other/status/999"; }]
]) {
  test(`background independently rejects an API completion receipt from a ${name}`, async () => {
    const p = contentPage(); await p.begin(); p.showCompletion();
    const observed = await p.check(); assert.equal(observed.completed, true);
    const wrongEvidence = copy(observed.evidence); edit(wrongEvidence);
    const w = await background(p, () => ({ ok: false, completed: true, evidence: wrongEvidence }));
    const intent = w.state().uncertainAction, result = await w.run();
    assert.equal(result.ok, false);
    assert.equal(w.state().completionEvidence, null);
    assert.equal(w.state().uncertainAction, intent);
    assert.notEqual(w.state().stage, "campaigns_returned");
    assert.equal(closed(w).length, 0);
    assert.deepEqual(w.reloads, []);
  });
}


test("submitted task waits without focusing another tab or entering ongoing", async () => {
  let p;
  p = contentPage({ returnButton: true, reconcile: true, afterWait(state) {
    assert.equal(state.ongoingClicks, 0); assert.equal(state.progressClicks, 0);
    if (state.waited >= 8000 && !state.root) p.showCompletion();
  }});
  await p.begin();
  const w = await background(p, undefined, { active: false });
  const result = await w.run();
  assert.equal(result.ok, true); assertCurrentEvidence(result.evidence);
  assert.equal(w.updates.length, 0);
  assert.equal(p.state.clicks, 1);
});

test("STOP during passive validation preserves the order without navigation", async () => {
  let p;
  p = contentPage({ reconcile: true, afterWait(state) {
    if (state.waited >= 5000) p.dispatch({type: "AUTOMATION_PAUSE_CHANGED", paused: true});
  }});
  await p.begin();
  const result = await p.wait();
  assert.notEqual(result.ok, true);
  assert.equal(p.state.ongoingClicks, 0); assert.equal(p.state.progressClicks, 0);
  assert.equal(p.state.detailCloses, 0); assert.equal(p.state.clicks, 0);
});

test("official success appearing at the timeout boundary is inspected before giving up", async () => {
  let p;
  p = contentPage({ returnButton: true, afterWait(state) {
    if (state.waited >= 60000 && !state.root) p.showCompletion();
  }});
  await p.begin();
  const result = await p.wait();
  assert.equal(result.ok, true);
  assertCurrentEvidence(result.evidence);
  assert.equal(p.state.clicks, 1);
});

test("an unrelated result at the timeout boundary cannot release the current order", async () => {
  let p;
  p = contentPage({ returnButton: true, afterWait(state) {
    if (state.waited >= 60000 && !state.root) p.showCompletion("https://x.com/other/status/999");
  }});
  await p.begin();
  assertUnconfirmed(await p.wait());
  assert.equal(p.state.clicks, 0);
});

for (const staleDetail of [false, true]) {
  for (const delayMs of [8000, 30000, 60000]) {
    test(`passive platform verification arrives after ${delayMs}ms with stale detail ${staleDetail}`, async () => {
      let p;
      p = contentPage({returnButton: true, reconcile: true, staleDetail, afterWait(state) {
        assert.equal(state.ongoingClicks, 0); assert.equal(state.progressClicks, 0);
        assert.equal(state.detailCloses, 0);
        if (state.waited >= delayMs && !state.root) p.showCompletion();
      }});
      await p.begin();
      const result = await p.wait();
      assert.equal(result.ok, true); assertCurrentEvidence(result.evidence);
      assert.equal(p.state.clicks, 1);
    });
  }
}

for (const options of [{}, {staleDetail: true}, {listInitiallyOpen: true}, {duplicateCards: true}, {offscreenProgress: true}]) {
  test(`missing automatic result never opens progress or manufactures success: ${JSON.stringify(options)}`, async () => {
    const p = contentPage({reconcile: true, ...options}); await p.begin();
    assertUnconfirmed(await p.wait());
    assert.equal(p.state.ongoingClicks, 0); assert.equal(p.state.progressClicks, 0);
    assert.equal(p.state.detailCloses, 0); assert.equal(p.state.clicks, 0);
  });
}

test("original tweet in the enclosing dialog rejects another order even outside the small result panel", async () => {
  const p = contentPage({returnButton: true, linkOutsideResult: true});
  await p.begin(); p.showCompletion("https://x.com/other/status/999");
  assertUnconfirmed(await p.wait()); assert.equal(p.state.clicks, 0);
});
