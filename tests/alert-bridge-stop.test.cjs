"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = process.env.LIGHTHOUSE_TEST_SOURCE_ROOT || path.join(__dirname, "../src");
const source = fs.readFileSync(path.join(root, "content/lighthouse-alert-bridge.js"), "utf8");
const warning = "此推文含有未经验证的链接，请 KOL 接单时仔细分辨";
const target = "https://x.com/fixture/status/123";

function page(initialPaused) {
  const alerts = [], opens = [], events = [], listeners = new Map();
  const popup = { fixtureWindow: true };
  const window = {
    alert(message) { alerts.push(message); return "native-alert-result"; },
    open(...args) { opens.push(args); return popup; },
    dispatchEvent(event) { events.push(event); }
  };
  if (initialPaused !== undefined) window.__lighthouseAutomationPaused__ = initialPaused;
  const c = vm.createContext({ window,
    document: { addEventListener(name, listener) { listeners.set(name, listener); } },
    CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } }
  });
  vm.runInContext(source, c);
  return { window, alerts, opens, events, popup, reload: () => vm.runInContext(source, c),
    link: (href) => listeners.get("click")({ target: { closest: () => ({ href }) } }) };
}

test("bridge starts paused and leaves the narrow warning to native alert", () => {
  const p = page();
  assert.equal(p.window.__lighthouseAutomationPaused__, true);
  assert.equal(p.window.alert(warning), "native-alert-result");
  assert.deepEqual(p.alerts, [warning]);
  assert.equal(p.events.length, 0);
});

test("paused bridge preserves window.open arguments and return value without publishing target URLs", () => {
  const p = page(true);
  assert.equal(p.window.open(target, "_blank", "noopener"), p.popup);
  p.link(target);
  assert.deepEqual(p.opens, [[target, "_blank", "noopener"]]);
  assert.equal(p.events.length, 0);
});

test("explicitly active bridge retains only the original narrow alert match and target capture", () => {
  const p = page(false);
  assert.equal(p.window.alert(warning), undefined);
  assert.equal(p.window.alert("需要再次确认接单"), "native-alert-result");
  assert.deepEqual(p.alerts, ["需要再次确认接单"]);
  assert.equal(p.events[0].type, "lighthouse-unverified-link-alert-dismissed");
  assert.equal(p.window.open(target, "target", "features"), p.popup);
  p.link("https://twitter.com/fixture/status/456?s=20");
  assert.deepEqual(p.events.slice(1).map((event) => event.detail.tweetUrl), [target, "https://x.com/fixture/status/456"]);
  assert.deepEqual(p.opens, [[target, "target", "features"]]);
});

test("STOP immediately suppresses alert dismissal and capture on an already active page", () => {
  const p = page(false);
  p.window.__lighthouseAutomationPaused__ = true;
  assert.equal(p.window.alert(warning), "native-alert-result");
  assert.equal(p.window.open(target, "_blank"), p.popup);
  p.link(target);
  assert.deepEqual(p.alerts, [warning]);
  assert.equal(p.events.length, 0);
  assert.equal(p.opens.length, 1);
});

test("explicit resume restores capture and narrow dismissal without swallowing other alerts", () => {
  const p = page(true);
  p.window.__lighthouseAutomationPaused__ = false;
  p.window.alert(warning);
  p.link(target);
  const ordinary = { message: "unrelated warning" };
  assert.equal(p.window.alert(ordinary), "native-alert-result");
  assert.equal(p.alerts[0], ordinary);
  assert.deepEqual(p.events.map((event) => event.type), ["lighthouse-unverified-link-alert-dismissed", "lighthouse-target-tweet-url"]);
});

test("non-target opens remain native and repeated bridge injection does not duplicate capture", () => {
  const p = page(false);
  p.reload();
  assert.equal(p.window.open("https://example.com/help", "_self", "width=800"), p.popup);
  p.link("https://example.com/help");
  assert.equal(p.events.length, 0);
  p.window.open(target);
  assert.equal(p.events.length, 1);
  assert.equal(p.opens.length, 2);
});
