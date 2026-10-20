"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/content/lighthouse.js"), "utf8");
const version = JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8")).version;
async function runner(paused = false) {
  let listener;
  const sent = [];
  const c = vm.createContext({ console, URL, Date, setTimeout, clearTimeout,
    window: { addEventListener() {} },
    location: { href: "https://app.lhdao.top/campaigns" },
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } },
      async sendMessage(message) { sent.push(message.type); return { ok: true, paused, settings: {} }; }
    } }
  });
  const end = source.lastIndexOf("})();");
  vm.runInContext(source.slice(0, end) + `
    globalThis.fixtureReady = automationPauseReady;
    globalThis.inspectRunner = () => ({ activeRunId, automationPaused,
      cancelled: [...cancelledRunIds], claimOperation, settled: settledClaimOperations.size });
  ` + source.slice(end), c);
  await c.fixtureReady;
  const dispatch = message => {
    let response;
    const handled = listener(message, {}, result => { response = result; });
    return { handled, response };
  };
  return { c, sent, dispatch, state: () => JSON.parse(JSON.stringify(c.inspectRunner())) };
}

for (const paused of [false, true]) test(`runner readiness proves this version without starting work, paused=${paused}`, async () => {
  const p = await runner(paused), before = p.state(), messages = [...p.sent];
  const result = p.dispatch({ type: "CHECK_LIGHTHOUSE_RUNNER_READY", platform: "lighthouse", runId: "probe-must-not-start" });
  assert.equal(result.handled, true);
  assert.equal(result.response.ok, true);
  assert.equal(result.response.version, version);
  assert.match(result.response.instanceId, /^lighthouse-/);
  assert.equal(result.response.url, "https://app.lhdao.top/campaigns");
  assert.equal(result.response.paused, paused);
  assert.deepEqual(p.state(), before);
  assert.deepEqual(p.sent, messages, "the handshake must not claim, log or create a checkpoint");
});

test("wrong-platform readiness never reports a usable Lighthouse runner", async () => {
  const p = await runner();
  const result = p.dispatch({ type: "CHECK_LIGHTHOUSE_RUNNER_READY", platform: "xinhuo" });
  assert.equal(result.response?.ok, false);
  assert.equal(p.state().activeRunId, "");
});

test("a replaced content instance cannot acknowledge readiness", async () => {
  const p = await runner();
  vm.runInContext("globalThis.__lighthouseCommentTaskRunnerLighthouseSingleton__.active = false", p.c);
  const result = p.dispatch({ type: "CHECK_LIGHTHOUSE_RUNNER_READY", platform: "lighthouse" });
  assert.equal(result.handled, false);
  assert.equal(result.response, undefined);
});
