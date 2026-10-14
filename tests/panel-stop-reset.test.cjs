"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(process.env.LIGHTHOUSE_TEST_SOURCE_ROOT || path.join(__dirname, "../src"), "debug/debug.js"), "utf8");
const clone = (v) => JSON.parse(JSON.stringify(v));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const task = { taskKey: "old-order", selectionId: "old-order", taskType: "评论", title: "old countdown", bounty: 0.2, isCooling: true, countdownSec: 120 };

function element(id = "") {
  return { id, value: "", checked: false, dataset: {}, hidden: false, disabled: false, textContent: "", innerHTML: "", children: [], listeners: {},
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    setAttribute(name) { if (name === "aria-busy") this.busy = true; },
    removeAttribute(name) { if (name === "aria-busy") this.busy = false; }, toggleAttribute() {},
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; this.innerHTML = ""; },
    querySelector() { return { textContent: "step" }; }
  };
}

// Run the entire production panel, including its real events and timers.
// Only DOM, Chrome, network and media are offline boundary fixtures.
async function panel(options = {}) {
  const nodes = new Map(), messages = [], intervals = new Map(), timeouts = new Map(), utterances = [], audios = [], fetches = [];
  const hooks = {}, storage = new Map(), history = [{ taskKey: "completed-order" }];
  let listener, timerId = 0, speechCancels = 0;
  const node = (id) => { if (!nodes.has(id)) nodes.set(id, element(id)); return nodes.get(id); };
  const step = element("step"); step.dataset.command = "DEBUG_RUN_X_REPLY";
  const start = element("start"); start.dataset.command = "START_RUN";
  let state = { runId: "old-run", running: !options.stopped, mode: "debug", stage: "x_replied", manuallyStopped: !!options.stopped,
    logs: options.stopped ? [] : [{ level: "info", text: "old log", at: new Date().toISOString() }] };
  const settings = { runMode: "debug", actionDelayMs: 500, autoSubmitLighthouse: true, replyMode: "post", aiModel: "selectable-model",
    aiApiKey: "fixture-only", aiSystemPrompt: "keep settings", runWindowEnabled: false };
  const monitor = { ok: true, enabled: true, voiceEnabled: true, voiceEngine: "browser", voiceRate: 1, voicePitch: 1,
    minBounty: 0.5, mimoBaseUrl: "https://fixture.invalid/v1", mimoApiKey: "fixture-only" };
  const chrome = { permissions: { contains: async () => true }, windows: { getCurrent: async () => ({ id: 1 }) }, runtime: {
    onMessage: { addListener(fn) { listener = fn; } },
    async sendMessage(message) {
      messages.push(clone(message));
      if (message.type === "GET_STATE") return hooks.state ? hooks.state() : { ok: true, state: clone(state), settings: clone(settings) };
      if (message.type === "MONITOR_GET_SETTINGS" || message.type === "MONITOR_GET_STATUS") return { ...monitor, paused: state.manuallyStopped };
      if (message.type === "MONITOR_GET_COUNTDOWNS") return hooks.countdowns ? hooks.countdowns() : { ok: true, tasks: [clone(task)], timestamp: Date.now() };
      if (message.type === "GET_REPLY_RECORDS") return { ok: true, records: clone(history) };
      if (message.type === "STOP_RUN") {
        if (hooks.stop) await hooks.stop();
        state = { runId: "stopped-run", running: false, mode: "idle", stage: "stopped", manuallyStopped: true, logs: [] };
        return { ok: true, state: clone(state) };
      }
      if (message.type === "START_RUN" || message.type.startsWith("DEBUG_")) {
        if (hooks.action) return hooks.action(message);
        state = { runId: "new-run", running: true, mode: message.type === "START_RUN" ? "auto" : "debug", stage: "x_replied", manuallyStopped: false, logs: [] };
        return { ok: true, state: clone(state) };
      }
      if (message.type === "SAVE_SETTINGS") return hooks.save ? hooks.save() : { ok: true, settings: clone(settings) };
      return { ok: true };
    }
  } };
  class FixtureAudio {
    constructor(url) { this.url = url; this.pauses = 0; audios.push(this); }
    play() { this.played = true; return Promise.resolve(); }
    pause() { this.pauses++; }
    removeAttribute() {}
    load() {}
  }
  const speechSynthesis = { getVoices: () => [], cancel() { speechCancels++; }, speak(utterance) { utterances.push(utterance); } };
  class FixtureURL extends URL {}
  FixtureURL.createObjectURL = () => "blob:fixture"; FixtureURL.revokeObjectURL = () => {};
  const c = vm.createContext({ console, URL: FixtureURL, AbortController, Blob, Uint8Array, atob, Promise,
    Audio: FixtureAudio, SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } }, speechSynthesis,
    window: { speechSynthesis },
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    document: { body: element("body"), activeElement: null, getElementById: node, createElement: () => element(),
      querySelectorAll(selector) { if (selector === ".quickActions [data-command]") return [step]; if (selector === "[data-command]") return [step, start]; return []; } },
    setInterval(fn) { const id = ++timerId; intervals.set(id, fn); return id; }, clearInterval(id) { intervals.delete(id); },
    setTimeout(fn) { const id = ++timerId; timeouts.set(id, fn); return id; }, clearTimeout(id) { timeouts.delete(id); },
    chrome, async fetch(url, init) { fetches.push({ url, init }); return hooks.fetch ? hooks.fetch(url, init) : { ok: true, json: async () => ({ choices: [{ message: { audio: { data: "YQ==" } } }] }) }; }
  });
  vm.runInContext(source, c, { filename: "debug.js" });
  await flush();
  return { c, node, messages, intervals, utterances, audios, fetches, hooks, history, settings, startButton: start,
    read: (expression) => vm.runInContext(expression, c),
    emit: (message) => listener(message, {}, () => {}),
    stop: () => node("stopBtn").listeners.click(),
    start: () => start.listeners.click(), step: () => step.listeners.click(),
    tick: async () => { for (const callback of [...intervals.values()]) callback(); await flush(); },
    setState: (next) => { state = next; },
    speechCancels: () => speechCancels,
    countdownReads: () => messages.filter((m) => m.type === "MONITOR_GET_COUNTDOWNS").length
  };
}

function assertCleared(p) {
  assert.equal(p.read("countdownTasks.length"), 0);
  assert.equal(p.read("renderedCountdownTasks.length"), 0);
  assert.equal(p.read("selectedCountdownTask"), null);
  assert.equal(p.read("selectedCountdownKey"), "");
  assert.equal(p.read("panelSpeechQueue.length"), 0);
  assert.match(p.node("countdownList").innerHTML, /停止|暂停/);
}

test("STOP clears cached runtime UI immediately and leaves settings/history intact while its acknowledgement is pending", async () => {
  const p = await panel(), pending = deferred();
  p.c.selectCountdownTask(task);
  p.hooks.stop = () => pending.promise;
  const stopping = p.stop();
  await flush();
  assertCleared(p);
  assert.equal(p.node("logList").children.length, 0);
  const reads = p.countdownReads();
  await p.tick();
  assert.equal(p.countdownReads(), reads);
  assert.equal(p.settings.aiModel, "selectable-model");
  assert.equal(p.history[0].taskKey, "completed-order");
  pending.resolve(); await stopping;
});

test("late countdown response cannot repopulate a stopped panel", async () => {
  const p = await panel(), pending = deferred();
  p.hooks.countdowns = () => pending.promise;
  const reading = p.c.syncCountdowns("manual"); await flush();
  await p.stop();
  pending.resolve({ ok: true, tasks: [task], timestamp: Date.now() });
  await reading;
  assertCleared(p);
});

test("late GET_STATE response cannot restore old logs or reactivate the panel", async () => {
  const p = await panel(), pending = deferred();
  p.hooks.state = () => pending.promise;
  const reading = p.c.loadState(); await flush();
  p.hooks.state = null;
  await p.stop();
  pending.resolve({ ok: true, settings: p.settings, state: { running: true, mode: "auto", stage: "selecting_task", manuallyStopped: false, logs: [{ text: "late old log" }] } });
  await reading;
  assertCleared(p);
  assert.equal(p.node("logList").children.length, 0);
  assert.equal(p.node("stageBadge").textContent, "stopped");
});

test("GET_STATE during a pending STOP cannot resume polling from the pre-stop backend state", async () => {
  const p = await panel(), pending = deferred();
  p.hooks.stop = () => pending.promise;
  const stopping = p.stop(); await flush();
  const reads = p.countdownReads();
  await p.c.loadState(); await p.tick();
  assert.equal(p.countdownReads(), reads);
  assertCleared(p);
  pending.resolve(); await stopping;
});

test("a panel opened after STOP stays silent while read-only state polling continues", async () => {
  const p = await panel({ stopped: true });
  const stateReads = p.messages.filter((m) => m.type === "GET_STATE").length;
  await p.tick();
  p.emit({ type: "PANEL_SPEAK_TEXT", runId: "old-run", text: "late old voice", voiceEngine: "browser" }); await flush();
  assert.equal(p.countdownReads(), 0);
  assert.equal(p.utterances.length, 0);
  assert.ok(p.messages.filter((m) => m.type === "GET_STATE").length > stateReads);
  assertCleared(p);
});

test("STOP cancels active browser speech, drops queued speech and ignores late media callbacks", async () => {
  const p = await panel();
  p.emit({ type: "PANEL_SPEAK_TEXT", runId: "old-run", text: "speaking", voiceEngine: "browser" });
  p.emit({ type: "PANEL_SPEAK_TEXT", runId: "old-run", text: "queued", voiceEngine: "browser" });
  const utterance = p.utterances[0], cancels = p.speechCancels();
  await p.stop();
  assert.ok(p.speechCancels() > cancels);
  const status = p.node("monitorStatus").textContent;
  utterance.onend?.(); await flush();
  assert.equal(p.utterances.length, 1);
  assert.equal(p.node("monitorStatus").textContent, status);
  assertCleared(p);
});

test("STOP aborts an in-flight TTS request and its late result cannot create audio", async () => {
  const p = await panel(), pending = deferred();
  p.hooks.fetch = () => pending.promise;
  p.emit({ type: "PANEL_SPEAK_TEXT", runId: "old-run", text: "tts", voiceEngine: "mimo", mimoApiKey: "fixture-only" });
  await flush();
  await p.stop();
  assert.equal(p.fetches[0].init.signal?.aborted, true);
  pending.resolve({ ok: true, json: async () => ({ choices: [{ message: { audio: { data: "YQ==" } } }] }) });
  await flush();
  assert.equal(p.audios.length, 0);
  assertCleared(p);
});

test("STOP pauses active audio and late ended callbacks cannot replay queued announcements", async () => {
  const p = await panel();
  p.emit({ type: "PANEL_SPEAK_TEXT", runId: "old-run", text: "audio", voiceEngine: "mimo", mimoApiKey: "fixture-only" }); await flush();
  p.emit({ type: "PANEL_SPEAK_TEXT", runId: "old-run", text: "queued", voiceEngine: "browser" });
  assert.equal(p.audios.length, 1);
  await p.stop();
  assert.ok(p.audios[0].pauses > 0);
  p.audios[0].onended?.(); await flush();
  assert.equal(p.utterances.length, 0);
  assertCleared(p);
});

test("pause broadcast stops an already-open second panel", async () => {
  const p = await panel();
  p.emit({ type: "AUTOMATION_PAUSE_CHANGED", paused: true }); await flush();
  assertCleared(p);
  const reads = p.countdownReads();
  await p.c.syncCountdowns();
  assert.equal(p.countdownReads(), reads);
});

for (const command of ["start", "step"]) {
  test(`explicit ${command} resumes the stopped panel and its countdown polling`, async () => {
    const p = await panel({ stopped: true });
    await p[command](); await flush();
    assert.ok(p.messages.some((m) => m.type === (command === "start" ? "START_RUN" : "DEBUG_RUN_X_REPLY")));
    await p.tick();
    assert.ok(p.countdownReads() > 0);
    p.emit({ type: "PANEL_SPEAK_TEXT", runId: "new-run", text: "new voice", voiceEngine: "browser" }); await flush();
    assert.equal(p.utterances.length, 1);
  });
}

test("saving settings or requesting a voice test cannot resume a stopped panel", async () => {
  const p = await panel({ stopped: true });
  await p.c.saveMonitorSettings();
  await p.node("monitorTestVoiceBtn").listeners.click(); await flush();
  assert.equal(p.messages.filter((m) => m.type === "MONITOR_TEST_VOICE").length, 0);
  assert.equal(p.countdownReads(), 0);
  assertCleared(p);
});

test("old TTS completion after a fresh start cannot play or release the new speech owner", async () => {
  const p = await panel(), old = deferred();
  p.hooks.fetch = () => old.promise;
  p.emit({ type: "PANEL_SPEAK_TEXT", runId: "old-run", text: "old tts", voiceEngine: "mimo", mimoApiKey: "fixture-only" }); await flush();
  await p.stop(); await p.start(); await flush();
  p.emit({ type: "PANEL_SPEAK_TEXT", runId: "new-run", text: "new voice", voiceEngine: "browser" }); await flush();
  assert.equal(p.utterances.length, 1);
  old.resolve({ ok: true, json: async () => ({ choices: [{ message: { audio: { data: "YQ==" } } }] }) }); await flush();
  assert.equal(p.audios.length, 0);
  assert.equal(p.read("panelSpeaking"), true);
});

test("STOP during a single-command settings save prevents its late command dispatch", async () => {
  const p = await panel(), saving = deferred();
  p.hooks.save = () => saving.promise;
  const starting = p.start(); await flush();
  await p.stop();
  saving.resolve({ ok: true, settings: p.settings }); await starting;
  assert.equal(p.messages.filter((m) => m.type === "START_RUN").length, 0);
  assertCleared(p);
});

test("STOP releases the full-start button immediately and its late response cannot release a newer command", async () => {
  const p = await panel(), old = deferred(), fresh = deferred();
  p.hooks.action = () => old.promise;
  const first = p.start(); await flush();
  assert.equal(p.startButton.busy, true);
  await p.stop();
  assert.equal(p.startButton.busy, false);
  p.hooks.action = () => fresh.promise;
  const second = p.start(); await flush();
  assert.equal(p.startButton.busy, true);
  old.resolve({ ok: true, state: { runId: "old-run", running: true, mode: "auto", stage: "selecting_task" } }); await first;
  assert.equal(p.startButton.busy, true);
  const state = { runId: "new-run", running: true, manuallyStopped: false, mode: "auto", stage: "selecting_task", logs: [] };
  p.setState(state); fresh.resolve({ ok: true, state }); await second;
});

test("old-run and unbound speech arriving after a fresh start cannot be played", async () => {
  const p = await panel();
  await p.stop(); await p.start();
  p.emit({ type: "PANEL_SPEAK_TEXT", runId: "old-run", text: "late old message", voiceEngine: "browser" });
  p.emit({ type: "PANEL_SPEAK_TEXT", text: "unbound message", voiceEngine: "browser" }); await flush();
  assert.equal(p.utterances.length, 0);
  p.emit({ type: "PANEL_SPEAK_TEXT", runId: "new-run", text: "new message", voiceEngine: "browser" }); await flush();
  assert.equal(p.utterances.length, 1);
});

test("a paused countdown response clears the panel before the next GET_STATE poll", async () => {
  const p = await panel();
  p.hooks.countdowns = async () => ({ ok: true, paused: true, tasks: [], timestamp: 0 });
  await p.c.syncCountdowns();
  assertCleared(p);
  const reads = p.countdownReads();
  await p.c.syncCountdowns();
  assert.equal(p.countdownReads(), reads);
});

test("fresh GET_STATE after another panel manually starts resumes polling and binds new speech", async () => {
  const p = await panel({ stopped: true });
  p.setState({ runId: "new-run", running: true, manuallyStopped: false, mode: "auto", stage: "selecting_task", logs: [] });
  await p.tick();
  assert.ok(p.countdownReads() > 0);
  p.emit({ type: "PANEL_SPEAK_TEXT", runId: "new-run", text: "current message", voiceEngine: "browser" }); await flush();
  assert.equal(p.utterances.length, 1);
});

test("a pre-stop countdown response arriving after restart cannot overwrite the new snapshot", async () => {
  const p = await panel(), old = deferred();
  p.hooks.countdowns = () => old.promise;
  const reading = p.c.syncCountdowns(); await flush();
  await p.stop(); p.hooks.countdowns = null;
  await p.start(); await flush();
  old.resolve({ ok: true, tasks: [{ ...task, taskKey: "late-old-order" }], timestamp: Date.now() }); await reading;
  assert.equal(p.read("countdownTasks[0].taskKey"), task.taskKey);
});
