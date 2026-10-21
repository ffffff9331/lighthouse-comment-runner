"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function fixture(file, boundary, exported) {
  const source = fs.readFileSync(path.join(__dirname, file), "utf8");
  const end = source.indexOf(boundary);
  assert.ok(end > 0);
  const prefix = source.slice(0, end);
  assert.equal(/^\s*test\s*\(/m.test(prefix), false);
  return new Function("require", "__dirname", `${prefix}\nreturn ${exported};`)(require, __dirname);
}
const { page, Element } = fixture("invitation-popup.test.cjs", 'test("ordinary list selection', "({ page, Element })");
const { connected } = fixture("runner-readiness-audit.test.cjs", "for (const popup of", "({ connected })");

function expire(p) { return p.f.popup.appendChild(new Element("p", "邀请已过期")); }

test("expired invitation is observationally distinct from a live pending invitation", async () => {
  const p = page(); expire(p);
  const result = await p.read();
  assert.equal(result.invitationState, "expired");
  assert.equal(result.invitationPending, false);
  assert.equal(p.f.accept.clicks + p.f.skip.clicks + p.f.popupClose.clicks, 0);
});

for (const disabled of [false, true]) test(`expired invitation yields to a real ordinary claim, disabled=${disabled}`, async () => {
  const p = page({ disabled }); expire(p);
  const expired = p.f;
  const result = await p.run();
  assert.equal(result.ok, true, result.message);
  assert.equal(expired.accept.clicks, 0);
  assert.equal(expired.skip.clicks, 1);
  assert.equal(p.action.clicks, 1);
  assert.equal(result.task.seatLocked, true);
  assert.equal(result.task.tweetUrl, "https://x.com/other/status/2110664701864444363");
});

test("expired invitation can use its own close control when skip is absent", async () => {
  const p = page(); expire(p); p.f.skip.remove();
  const result = await p.run();
  assert.equal(result.ok, true, result.message);
  assert.equal(p.f.popupClose.clicks, 1);
  assert.equal(p.f.accept.clicks, 0);
  assert.equal(p.action.clicks, 1);
});

for (const closeFirst of [false, true]) test(`real auto loop reaches next order without consuming the attempt cap, closeFirst=${closeFirst}`, async t => {
  const { w, p } = await connected(t, {}); expire(p);
  w.stored.settings = { maxTaskAttempts: 3, autoMinTaskBounty: 0.01 };
  if (closeFirst) w.state().stage = "starting";
  w.chrome.tabs.reload = async id => { w.effects.push({ type: "reload", id }); p.f.popup.remove(); };
  let adopted;
  w.c.adoptTargetOpenedTweet = async task => { adopted = task; return { ok: true }; };
  const result = await w.c.startNextAutoTask("expired-invitation-regression");
  assert.equal(result.ok, true, result.message);
  assert.equal(adopted.seatLocked, true);
  assert.equal(adopted.tweetUrl, "https://x.com/other/status/2110664701864444363");
  assert.equal(w.state().failed, 0);
  assert.equal(w.state().running, true);
  assert.equal(w.messages("START_LIGHTHOUSE_COMMENT_TASK").length, 1);
  assert.equal(p.f.accept.clicks, 0);
  assert.equal(w.state().uncertainAction, undefined);
});

test("an unclosable expired popup takes the safe refresh path and reaches an ordinary order", async t => {
  const { w, p } = await connected(t, {}); expire(p);
  p.f.skip.remove(); p.f.popupClose.remove();
  w.stored.settings = { maxTaskAttempts: 3, autoMinTaskBounty: 0.01 };
  w.chrome.tabs.reload = async id => { w.effects.push({ type: "reload", id }); p.f.popup.remove(); };
  let adopted;
  w.c.adoptTargetOpenedTweet = async task => { adopted = task; return { ok: true }; };
  assert.equal((await w.c.startNextAutoTask("unclosable-expired-invitation")).ok, true);
  assert.equal(adopted.seatLocked, true);
  assert.equal(w.reloads().length, 1);
  assert.equal(p.f.accept.clicks, 0);
  assert.ok(w.state().attempts < 3);
});

test("a new invitation appearing after expiry dismissal is processed as a different prompt", async () => {
  const p = page(); expire(p);
  const old = p.f.skip;
  old.onClick = () => p.f.showPopup();
  assert.equal((await p.run()).ok, true);
  assert.equal(old.clicks, 1);
  assert.equal(p.f.accept.clicks, 1);
  assert.equal(p.action.clicks, 0);
});

test("STOP while settings are being read prevents expiry dismissal and ordinary task selection", async () => {
  const p = page(); expire(p);
  const send = p.c.chrome.runtime.sendMessage;
  p.c.chrome.runtime.sendMessage = async message => {
    if (message.type === "GET_CONTENT_SETTINGS") await p.pause();
    return send(message);
  };
  assert.equal((await p.run()).ok, false);
  assert.equal(p.f.skip.clicks + p.f.popupClose.clicks + p.f.accept.clicks + p.action.clicks, 0);
});

test("an acceptance already dispatched remains protected when expiry appears during observation", async () => {
  const p = page({ outcome: "visible" });
  let read;
  p.f.beforeWait = async () => {
    if (!p.f.accept.clicks || read) return;
    expire(p); read = await p.read();
  };
  const result = await p.run();
  assert.equal(result.ok, false);
  assert.equal(result.claimActionAttempted, true);
  assert.equal(read.invitationState, "result_unknown");
  assert.equal(read.invitationPending, true);
  assert.equal(p.f.skip.clicks + p.f.popupClose.clicks + p.action.clicks, 0);
});
