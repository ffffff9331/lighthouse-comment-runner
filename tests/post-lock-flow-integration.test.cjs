"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const RUN = "identity-run";
const ID = "2110664701864444362";
const ALIAS = `https://x.com/i/status/${ID}`;
const AUTHOR = `https://x.com/current/status/${ID}`;
const OTHER = "https://x.com/other/status/2110664701864444363";
const NOTICE = "CONFIRM_LIGHTHOUSE_LOCKED_TASK_NOTICE";

// Reuse only the fixture definitions from the three frozen suites, before
// their first registered test. No fixture expectations or production code are
// rewritten. The two explicit adapters expose the existing content listener
// and connect its Chrome runtime boundary to the real worker checkpoint API.
function fixtureFactory(file, marker, returned, replacements = []) {
  const filePath = path.join(__dirname, file);
  const source = fs.readFileSync(filePath, "utf8");
  const end = source.indexOf(marker);
  assert.ok(end > 0, `fixture boundary missing in ${file}`);
  let prefix = source.slice(0, end);
  for (const [before, after] of replacements) {
    assert.equal(prefix.split(before).length, 2, `fixture adapter must match once: ${file}`);
    prefix = prefix.replace(before, after);
  }
  return new Function("require", "__dirname", "fixtureSend", `${prefix}\nreturn ${returned};`);
}

const workerFactory = fixtureFactory("background-tweet-identity.test.cjs", "for (const [name, tab] of [", "worker", [
  ['getManifest: () => ({ version: "test" })', 'getManifest: () => JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8"))'],
]);
const contentFactory = fixtureFactory("post-lock-navigation.test.cjs", 'test("same locked order', "page", [
  ["return { f, showNotice, identity: c.identityApi,", "return { f, showNotice, dispatch, identity: c.identityApi,"],
  ["f.reports.push(message); return { ok: true, paused: false };", "f.reports.push(message); return fixtureSend(message);"],
]);
const xFactory = fixtureFactory("x-tweet-identity.test.cjs", "for (const type of [", "page");

async function flow(t, options = {}) {
  const w = await workerFactory(require, __dirname)(t);
  const upstream = [];
  const x = xFactory(require, __dirname)({ actual: options.siteUrl || AUTHOR, target: ALIAS });
  let createdBySite = false;
  const p = contentFactory(require, __dirname, async message => {
    upstream.push(message.type);
    return w.c.handleMessage(message, { id: "test", tab: { id: 11, windowId: 1, url: "https://app.lhdao.top/campaigns" } });
  })({ noticeOnClaim: !options.delayedNotice, onNavigate() {
    createdBySite = true;
    w.add({ id: 21, windowId: 1, url: options.siteUrl || AUTHOR, status: "complete", openerTabId: 11 });
  } });
  w.hooks.sendMessage = (id, message) => {
    if (id === 11) return p.dispatch(message);
    if (id === 21) return x.send(message);
    throw new Error(`Unexpected local tab boundary ${id}`);
  };
  w.state().currentTask = null;
  const claim = await w.c.sendToTab(11, {
    type: "DEBUG_LOCK_SEAT_AND_EXTRACT", runId: RUN, settings: { actionDelayMs: 500 },
  });
  assert.equal(claim.ok, true, claim.message);
  assert.equal(claim.task.seatLocked, true);
  assert.equal(p.f.claimClicks, 1);
  assert.ok(upstream.includes("LIGHTHOUSE_CLAIM_CHECKPOINT"));
  assert.equal(w.state().uncertainAction, undefined);
  // The official direct link is /i/status while its new tab commits the author
  // path. Re-read the same detail link as an alias before the post-lock watch.
  p.f.nodes.find(node => node.href).href = ALIAS;
  w.state().currentTask.tweetUrl = ALIAS;
  const originalTask = { ...w.state().currentTask };
  w.c.beginXOpenWatch(11, "auto");
  if (options.delayedNotice) {
    w.hooks.delay = now => { if (now >= 1001000 && !p.f.notice) p.showNotice(); };
  }
  return { w, p, x, originalTask, siteOpened: () => createdBySite,
    wait: (overrides = {}) => w.wait({ timeoutMs: 4000, manualOpenAfterMs: 2500, ...overrides }),
  };
}

for (const delayedNotice of [false, true]) {
  test(`worker-to-content-to-X flow handles ${delayedNotice ? "delayed" : "immediate"} post-lock notice without fallback`, async t => {
    const { w, p, x, originalTask, siteOpened, wait } = await flow(t, { delayedNotice });
    assert.equal(await wait(), true);
    assert.equal(siteOpened(), true);
    assert.equal(p.f.navigationClicks, 1);
    assert.equal(p.f.claimClicks, 1);
    assert.equal(w.state().xTabId, 21);
    assert.equal(w.created.length, 0, "the extension must not create a fallback after the official navigation");
    const sequence = w.sent.map(message => message.type);
    assert.ok(sequence.indexOf("BEGIN_LIGHTHOUSE_COMPLETION_WATCH") < sequence.indexOf(NOTICE));
    if (delayedNotice) assert.ok(sequence.filter(type => type === NOTICE).length >= 2);
    const reply = await w.c.sendToTab(21, { type: "RUN_X_REPLY", runId: RUN, task: originalTask, settings: {} });
    assert.equal(reply.ok, true, reply.message);
    assert.equal(x.fixture.actions.length, 1);
    assert.equal(x.fixture.actions[0].task.tweetUrl, ALIAS);
    assert.equal(w.state().uncertainAction, undefined);
    assert.equal(w.sent.some(message => message.type === "OPEN_CURRENT_DETAIL_TWEET_TARGET"), false);
  });
}

test("STOP during the real post-lock entrance wait prevents navigation and X work", async t => {
  const { w, p, x, siteOpened, wait } = await flow(t);
  p.f.beforeWait = async () => {
    p.f.beforeWait = null;
    await w.c.stopAndClearRun();
  };
  assert.equal(await wait(), false);
  assert.equal(w.state().manuallyStopped, true);
  assert.equal(p.f.navigationClicks, 0);
  assert.equal(siteOpened(), false);
  assert.equal(w.created.length, 0);
  assert.equal(x.fixture.actions.length, 0);
  assert.equal(w.sent.some(message => message.type === "RUN_X_REPLY"), false);
});

test("an official navigation to a different tweet is never adopted or executed", async t => {
  const { w, p, x, originalTask, wait } = await flow(t, { siteUrl: OTHER });
  assert.equal(await wait({ timeoutMs: 2000, manualOpenAfterMs: 0 }), false);
  assert.equal(p.f.navigationClicks, 1);
  assert.notEqual(w.state().xTabId, 21);
  assert.equal(w.created.length, 0);
  assert.equal(w.state().currentTask.seatLocked, true);
  assert.equal(w.state().currentTask.tweetUrl, ALIAS);
  const refused = await w.c.sendToTab(21, { type: "RUN_X_REPLY", runId: RUN, task: originalTask, settings: {} });
  assert.equal(refused.ok, false);
  assert.equal(refused.actionAttempted, false);
  assert.equal(x.fixture.actions.length, 0);
  await w.c.recoverAndContinue(refused.message, { runId: RUN, task: originalTask, closeX: false });
  assert.equal(w.state().stage, "locked_task_recovery_blocked");
  assert.equal(w.state().running, false);
  assert.equal(w.state().currentTask.seatLocked, true);
});
