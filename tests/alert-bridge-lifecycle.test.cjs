"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sourceRoot = process.env.LIGHTHOUSE_TEST_SOURCE_ROOT || path.join(__dirname, "../src");
const version = JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8")).version;
const background = fs.readFileSync(path.join(sourceRoot, "background.js"), "utf8");
const bridge = fs.readFileSync(path.join(sourceRoot, "content/lighthouse-alert-bridge.js"), "utf8");
const warning = "此推文含有未经验证的链接，请 KOL 接单时仔细分辨";

function declaration(name) {
  const start = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(background);
  assert.ok(start, `Missing production function ${name}`);
  const next = /^(?:async )?function \w+\(/gm;
  next.lastIndex = start.index + start[0].length;
  return background.slice(start.index, next.exec(background)?.index ?? background.length);
}

// Run the real background injection and message ordering in separate worker
// and MAIN-world contexts. Reload replaces the page but retains its tab/URL.
function fixture({ manifestBridge = true } = {}) {
  const tab = { id: 11, url: "https://app.lhdao.top/campaigns" };
  const pages = [], effects = [], pending = [];
  let page, deferScripts = false;
  const reload = () => {
    const alerts = [], events = [];
    const window = {
      alert(message) { alerts.push(message); return "native"; },
      open() {}, dispatchEvent(event) { events.push(event); }
    };
    const context = vm.createContext({ window,
      document: { addEventListener() {} },
      CustomEvent: class { constructor(type) { this.type = type; } }
    });
    if (manifestBridge) vm.runInContext(bridge, context);
    page = { window, alerts, events, context };
    pages.push(page);
    return page;
  };
  reload();
  const state = { running: true, runId: "run-1", mode: "auto" };
  const c = vm.createContext({
    console, Date, URL, setTimeout, clearTimeout, runtimeState: state, activeTabActions: new Set(),
    // Kept to exercise the old implementation in regression checks too.
    lighthouseAlertBridgeUrls: new Map(), alertPauseRevision: 0,
    isLighthouseUrl: url => /^https:\/\/app\.lhdao\.top\//.test(url),
    log(level, message) { effects.push({ level, message }); },
    createRunId: () => "fixture-intent", persistAutoRunState: async () => {},
    mergeTaskPreservingCapturedTweetUrl: (...values) => Object.assign({}, ...values),
    chrome: {
      runtime: { getManifest: () => ({ version }) },
      tabs: {
        async get() { return tab; },
        async sendMessage(_id, message) {
          if (message.type === "CHECK_LIGHTHOUSE_RUNNER_READY") {
            return { ok: true, version, instanceId: "fixture-page", url: tab.url, paused: false };
          }
          effects.push({ sent: message.type });
          if (!message.type.startsWith("CANCEL_")) page.window.alert(warning);
          return { ok: true, task: { taskKey: "fixture-task", seatLocked: true } };
        }
      },
      scripting: { async executeScript(options) {
        assert.equal(options.world, "MAIN");
        const targetPage = page;
        const execute = () => {
          targetPage.context.args = options.args;
          return [{ result: vm.runInContext(`(${options.func.toString()})(...args)`, targetPage.context) }];
        };
        if (!deferScripts) return execute();
        return new Promise(resolve => pending.push(() => resolve(execute())));
      } }
    }
  });
  for (const name of ["ensureLighthouseAlertBridge", "pauseLighthouseAlertBridge", "ensureLighthouseRunnerReady", "sendToTab"]) {
    vm.runInContext(declaration(name), c);
  }
  return { c, state, pages, effects, reload, pending,
    page: () => page, defer: value => { deferScripts = value; },
    send: () => c.sendToTab(11, { type: "DEBUG_LOCK_SEAT_AND_EXTRACT", runId: state.runId })
  };
}

test("the first claim enables the document-start bridge before its alert can block", async () => {
  const f = fixture();
  assert.equal(f.page().window.__lighthouseAutomationPaused__, true);
  assert.equal((await f.send()).ok, true);
  assert.deepEqual(f.page().alerts, []);
  assert.deepEqual(f.page().events.map(e => e.type), ["lighthouse-unverified-link-alert-dismissed"]);
});

test("same-tab same-URL reload re-enables automatic confirmation before the next claim", async () => {
  const f = fixture();
  await f.send();
  const refreshed = f.reload();
  assert.equal(refreshed.window.__lighthouseAutomationPaused__, true);
  await f.send();
  assert.deepEqual(refreshed.alerts, []);
  assert.equal(refreshed.events.length, 1);
});

test("STOP restores native notices and explicit restart re-enables the same document", async () => {
  const f = fixture();
  await f.send();
  f.c.pauseLighthouseAlertBridge(11);
  assert.equal(f.page().window.alert(warning), "native");
  f.state.runId = "run-2";
  await f.send();
  assert.deepEqual(f.page().alerts, [warning]);
  assert.equal(f.page().events.length, 2);
});

test("repeated action preparation does not duplicate wrappers or swallow other alerts", async () => {
  const f = fixture();
  await f.send();
  await f.send();
  const unknown = "请确认转账金额";
  assert.equal(f.page().window.alert(unknown), "native");
  assert.deepEqual(f.page().alerts, [unknown]);
  assert.equal(f.page().events.length, 2);
});

test("fallback installation on an existing page also confirms only the known notice", async () => {
  const f = fixture({ manifestBridge: false });
  await f.send();
  assert.deepEqual(f.page().alerts, []);
  assert.equal(f.page().window.alert("其他提示"), "native");
});

test("an old delayed enable cannot override STOP or send a cancelled claim", async () => {
  const f = fixture();
  f.defer(true);
  const sending = f.send();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.pending.length, 1);
  f.state.running = false;
  f.state.manuallyStopped = true;
  f.defer(false);
  f.c.pauseLighthouseAlertBridge(11);
  f.pending.shift()();
  assert.equal((await sending).cancelled, true);
  assert.equal(f.page().window.alert(warning), "native");
  assert.equal(f.effects.some(e => e.sent), false);
});

test("a late pause from the old run cannot disable a newer explicit restart", async () => {
  const f = fixture();
  await f.send();
  f.defer(true);
  f.c.pauseLighthouseAlertBridge(11);
  f.defer(false);
  f.state.runId = "run-2";
  await f.send();
  f.pending.shift()();
  assert.equal(f.page().window.__lighthouseAutomationPaused__, false);
  assert.equal(f.page().window.alert(warning), undefined);
  assert.deepEqual(f.page().alerts, []);
});

test("claim message waits for MAIN-world activation acknowledgement", async () => {
  const f = fixture();
  f.defer(true);
  const sending = f.send();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.effects.some(e => e.sent), false);
  f.pending.shift()();
  await sending;
  assert.deepEqual(f.page().alerts, []);
  assert.equal(f.effects.filter(e => e.sent).length, 1);
});
