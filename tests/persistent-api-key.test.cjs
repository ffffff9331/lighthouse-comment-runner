"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const fixture = path.join(__dirname, "session-api-key.test.cjs");
const source = fs.readFileSync(fixture, "utf8");
const loaded = new Module(fixture, module);
loaded.filename = fixture;
loaded._compile(source.slice(0, source.indexOf('test("legacy key'))
  + "\nmodule.exports={worker,SESSION_KEY};", fixture);
const { worker, SESSION_KEY } = loaded.exports;

test("persistent key survives a fresh browser session and extension reload", async () => {
  const first = await worker();
  assert.equal((await first.message("SAVE_SETTINGS", { aiApiKey: "fixture-persistent", aiModel: "chosen-model" })).ok, true);
  const fresh = await worker({ local: first.local, session: {} });
  delete fresh.chrome.storage.session;
  const settings = await fresh.c.getSettings();
  assert.equal(settings.aiApiKey, "fixture-persistent");
  assert.equal(settings.aiModel, "chosen-model");
  assert.equal(Object.hasOwn(fresh.local.settings, "aiApiKey"), false);
});

for (const value of ["fixture-current", ""]) {
  test(`saved local key wins over old session and settings (${value ? "present" : "explicit clear"})`, async () => {
    const w = await worker({ local: { [SESSION_KEY]: value, settings: {
      aiApiUrl: "https://api.vayne.cc.cd/v1/responses", aiApiKey: "fixture-obsolete-settings"
    } }, session: { [SESSION_KEY]: "fixture-obsolete-session" } });
    w.hooks.sessionGet = async () => { throw Error("must not read old session"); };
    const settings = await w.c.getSettings();
    assert.equal(settings.aiApiKey, value);
    assert.equal(w.local[SESSION_KEY], value);
    assert.equal(Object.hasOwn(w.local.settings, "aiApiKey"), false);
  });
}

test("persistent key write failure cannot report success or replace the prior key", async () => {
  const w = await worker({ local: { [SESSION_KEY]: "fixture-old" } });
  await w.c.getSettings();
  const before = JSON.stringify(w.local.settings);
  w.hooks.localSet = async values => {
    if (Object.hasOwn(values, SESSION_KEY)) throw Error("fixture-new failed to persist");
  };
  await assert.rejects(w.message("SAVE_SETTINGS", { aiApiKey: "fixture-new", aiModel: "not-saved" }), error => {
    assert.match(error.message, /保存|持久|本地/);
    assert.equal(error.message.includes("fixture-new"), false);
    return true;
  });
  assert.equal(w.local[SESSION_KEY], "fixture-old");
  assert.equal(JSON.stringify(w.local.settings), before);
});

test("explicit clearing persists across browser sessions without resurrecting old credentials", async () => {
  const first = await worker({ session: { [SESSION_KEY]: "fixture-old-session" } });
  await first.c.getSettings();
  await first.message("SAVE_SETTINGS", { aiApiKey: "" });
  const fresh = await worker({ local: first.local, session: { [SESSION_KEY]: "fixture-stale-session" } });
  assert.equal((await fresh.c.getSettings()).aiApiKey, "");
  assert.equal(fresh.local[SESSION_KEY], "");
});

test("API Key fields remain password inputs with persistent storage wording", () => {
  for (const file of ["debug/debug.html", "popup/popup.html"]) {
    const html = fs.readFileSync(path.join(__dirname, "../src", file), "utf8");
    const field = html.match(/<input\b[^>]*\bid="aiApiKey"[^>]*>/);
    assert.ok(field, file);
    assert.match(field[0], /\btype="password"/);
    assert.match(field[0], /\bautocomplete="off"/);
    assert.match(html, /API Key[\s\S]{0,100}本地保存/);
    assert.doesNotMatch(html, /重载后需重新输入|仅本次会话|仅保存在本次浏览器会话/);
  }
});
