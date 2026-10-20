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
  + "\nmodule.exports = { worker, deferred, flush, SESSION_KEY };", fixture);
const { worker, deferred, flush, SESSION_KEY } = loaded.exports;

test("STOP followed by START does not wait for an old GET revision reread", async () => {
  const w = await worker({ session: { [SESSION_KEY]: "fixture-session-key" } });
  await w.c.getSettings();
  const firstRead = deferred();
  const revisionRead = deferred();
  let phase = "initial";
  let initialReadHeld = false;
  let revisionReadHeld = false;
  let startSettled = false;
  let scans = 0;
  let oldGet;
  let starting;

  w.hooks.localGet = async keys => {
    if (keys.length !== 1 || keys[0] !== "settings") return;
    if (phase === "initial" && !initialReadHeld) {
      initialReadHeld = true;
      await firstRead.promise;
    } else if (phase === "release-old") {
      revisionReadHeld = true;
      await revisionRead.promise;
    }
  };

  try {
    oldGet = w.c.getSettings();
    await flush();
    assert.equal(initialReadHeld, true);

    // Replace the credential while the old snapshot is pending. The old read
    // must revalidate instead of returning its captured credential.
    assert.equal((await w.message("SAVE_SETTINGS", { aiApiKey: "fixture-new-key" })).ok, true);
    phase = "release-old";
    firstRead.resolve();
    await flush();
    assert.equal(revisionReadHeld, true);
    phase = "new-start";

    assert.equal((await w.message("STOP_RUN")).ok, true);
    w.c.startNextAutoTask = async () => { scans += 1; return { ok: true }; };
    starting = w.message("START_RUN").then(result => {
      startSettled = true;
      return result;
    });
    await flush();
    await flush();

    assert.equal(startSettled, true, "new START must finish while the old GET revision reread is still pending");
    assert.equal(scans, 1, "new START must reach its first scan independently of the old GET");
    assert.equal((await starting).ok, true);
  } finally {
    // Release both gates even on a failed assertion so RED is a test failure,
    // not a cancelled test caused by an unresolved fixture promise.
    phase = "cleanup";
    firstRead.resolve();
    revisionRead.resolve();
    await Promise.allSettled([oldGet, starting].filter(Boolean));
  }
});
