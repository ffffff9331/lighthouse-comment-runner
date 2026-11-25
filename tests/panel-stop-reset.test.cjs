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
  const hooks = {monitorSettings: options.monitorSettings}, storage = new Map(), history = [{ taskKey: "completed-order" }];
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
      if (message.type === "MONITOR_GET_SETTINGS" && hooks.monitorSettings) return hooks.monitorSettings();
      if (message.type === "MONITOR_GET_SETTINGS" || message.type === "MONITOR_GET_STATUS") return { ...monitor, paused: state.manuallyStopped };
      if (message.type === "MONITOR_GET_COUNTDOWNS") return hooks.countdowns ? hooks.countdowns() : { ok: true, tasks: [clone(task)], timestamp: Date.now() };
      if (message.type === "GET_REPLY_RECORDS") return { ok: true, records: clone(history) };
      if (message.type === "STOP_RUN") {
        if (hooks.stop) {
          const result = await hooks.stop();
          if (result) return result;
        }
        state = { runId: "stopped-run", running: false, mode: "idle", stage: "stopped", manuallyStopped: true, logs: [] };
        return { ok: true, state: clone(state) };
      }
      if (message.type === "START_RUN" || message.type === "RUN_SELECTED_COUNTDOWN_TASK" || message.type.startsWith("DEBUG_")) {
        if (hooks.action) return hooks.action(message);
        state = { runId: "new-run", running: true, mode: message.type === "START_RUN" ? "auto" : "debug", stage: "x_replied", manuallyStopped: false, logs: [] };
        return { ok: true, state: clone(state) };
      }
      if (message.type === "SAVE_SETTINGS") return hooks.save ? hooks.save() : { ok: true, settings: clone(settings) };
      if (message.type === "MONITOR_SAVE_SETTINGS" && hooks.saveMonitor) return hooks.saveMonitor();
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

test("STOP distinguishes a pending request from an acknowledged stop", async () => {
  const p = await panel(), pending = deferred();
  p.hooks.stop = () => pending.promise;
  const stopping = p.stop(); await flush();
  assert.equal(p.node("stageBadge").textContent, "stopping");
  assert.match(p.node("commandStatus").textContent, /正在停止|等待.*停止/);
  pending.resolve(); await stopping;
  assert.equal(p.node("stageBadge").textContent, "stopped");
  assert.match(p.node("commandStatus").textContent, /已停止/);
  assert.doesNotMatch(p.node("monitorStatus").textContent, /等待后台确认/);
  assert.equal(p.node("countdownSyncTime").textContent, "已停止");
});

for (const fault of ["transport", "rejected"]) {
  test(`STOP ${fault} failure remains visible even if the subsequent state read fails`, async () => {
    const p = await panel();
    p.hooks.stop = () => {
      if (fault === "transport") throw Error("message channel closed");
      return {ok: false, error: "停止记录保存失败"};
    };
    p.hooks.state = () => { throw Error("GET_STATE unavailable"); };
    await p.stop();
    assert.equal(p.node("commandStatus").hidden, false);
    assert.equal(p.node("commandStatus").dataset.kind, "error");
    assert.match(p.node("commandStatus").textContent, /未能确认停止|停止.*失败/);
    assert.equal(p.node("stageBadge").textContent, "stop_unconfirmed");
    assert.equal(p.read("panelStopPending"), false);
  });
}

test("a late failure from an older STOP cannot overwrite a newer confirmed stop", async () => {
  const p = await panel(), pending = deferred();
  p.hooks.stop = () => pending.promise;
  const old = p.stop(); await flush();
  p.hooks.stop = null;
  await p.stop();
  pending.resolve({ok: false, error: "旧停止请求失败"}); await old;
  assert.equal(p.node("stageBadge").textContent, "stopped");
  assert.doesNotMatch(p.node("commandStatus").textContent, /旧停止/);
});

for (const command of ["START_RUN", "RUN_SELECTED_COUNTDOWN_TASK", "DEBUG_RUN_X_REPLY"]) {
  test(`a new ${command} takes ownership before the earlier STOP responds`, async () => {
    const p = await panel(), pending = deferred();
    p.hooks.stop = () => pending.promise;
    const stopping = p.stop(); await flush();
    const state = {runId: "fresh-run", running: command === "START_RUN", manuallyStopped: false,
      mode: command === "START_RUN" ? "auto" : "debug",
      stage: command === "START_RUN" ? "selecting_task" : "x_draft_ready", logs: []};
    p.hooks.action = () => { p.setState(state); return {ok: true, state}; };
    if (command === "START_RUN") await p.start();
    else if (command === "DEBUG_RUN_X_REPLY") await p.step();
    else {
      const button = element(); button.dataset.command = command;
      await p.c.runSingleCommand(button);
    }
    assert.equal(p.read("panelStopPending"), false);
    assert.equal(p.read("panelPaused"), false);
    assert.equal(p.node("stageBadge").textContent, state.stage);
    if (command !== "START_RUN") assert.match(p.node("commandStatus").textContent, /草稿.*人工发送/);
    assert.doesNotMatch(p.node("commandStatus").textContent, /等待后台确认|已停止/);
    const feedback = p.node("commandStatus").textContent;
    pending.resolve({ok: true, state: {stage: "stopped", manuallyStopped: true}});
    await stopping;
    assert.equal(p.node("commandStatus").textContent, feedback);
    assert.equal(p.node("stageBadge").textContent, state.stage);
    const reads = p.countdownReads();
    await p.tick();
    assert.ok(p.countdownReads() > reads);
  });
}

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

test("monitor save rejection does not acknowledge the combined panel save", async () => {
  const p = await panel();
  p.hooks.saveMonitor = () => ({ ok: false, error: "fixture storage unavailable" });
  assert.equal(await p.c.saveSettings(), false);
  assert.match(p.node("saveStatus").textContent, /保存失败/);
});

test("the first monitor response initializes stored values despite an edit to another settings group", async () => {
  const initial = deferred();
  const p = await panel({monitorSettings: () => initial.promise});
  p.node("aiModel").value = "new-model";
  p.node("aiModel").listeners.input();
  initial.resolve({ok: true, enabled: true, voiceEnabled: true, minBounty: 2,
    voiceEngine: "mimo", voiceName: "mimo_default", voiceRate: 1.3, voicePitch: 1,
    mimoBaseUrl: "https://fixture.invalid/v1", mimoApiKey: "existing-fixture-key",
    voiceTemplateAppear: "stored-template"});
  await flush();
  assert.equal(p.node("aiModel").value, "new-model");
  assert.equal(p.node("monitorEnabled").checked, true);
  assert.equal(p.node("monitorMimoApiKey").value, "existing-fixture-key");
  p.settings.aiModel = "new-model";
  assert.equal(await p.c.saveSettings(), true);
  const saved = p.messages.find(m => m.type === "MONITOR_SAVE_SETTINGS");
  assert.equal(saved.enabled, true);
  assert.equal(saved.voiceEnabled, true);
  assert.equal(saved.rate, 1.3);
  assert.equal(saved.minBounty, 2);
  assert.equal(saved.mimoApiKey, "existing-fixture-key");
  assert.equal(saved.templateAppear, "stored-template");
});

for (const fault of ["pending", "failed"]) {
  test(`an initial ${fault} monitor read cannot write defaults or start tasks`, async () => {
    const initial = deferred();
    const p = await panel({monitorSettings: () => fault === "pending" ? initial.promise : {ok: false}});
    assert.equal(await p.c.saveSettings(), false);
    await p.start();
    await p.node("monitorTestVoiceBtn").listeners.click();
    assert.equal(p.messages.some(m => ["SAVE_SETTINGS", "MONITOR_SAVE_SETTINGS", "START_RUN", "MONITOR_TEST_VOICE"].includes(m.type)), false);
    assert.equal(p.node("monitorEnabled").disabled, true);
    assert.match(p.node("saveStatus").textContent, /尚未加载|加载失败/);
    // A later successful read releases the controls and permits a normal save.
    p.hooks.monitorSettings = null;
    await p.c.loadMonitorStatus();
    assert.equal(p.node("monitorEnabled").disabled, false);
    assert.equal(await p.c.saveSettings(), true);
    initial.resolve({ok: false});
    await flush();
  });
}

for (const boundary of ["save", "saveMonitor"]) {
  test(`edits during ${boundary} remain visible and unsaved after the old acknowledgement`, async () => {
    const p = await panel(), saving = deferred();
    p.hooks[boundary] = () => saving.promise;
    const operation = p.c.saveSettings(); await flush();
    p.node("aiModel").value = "new-unsaved-model";
    p.node("aiModel").listeners.input();
    saving.resolve({ok: true, settings: p.settings});
    assert.equal(await operation, false);
    assert.equal(p.node("aiModel").value, "new-unsaved-model");
    assert.equal(p.read("settingsDirty"), true);
    assert.match(p.node("saveStatus").textContent, /未保存|尚未保存/);
    await p.c.loadState();
    assert.equal(p.node("aiModel").value, "new-unsaved-model");
  });
}

test("a second save cannot race the in-flight settings and monitor snapshots", async () => {
  const p = await panel(), saving = deferred();
  p.hooks.save = () => saving.promise;
  const first = p.c.saveSettings(); await flush();
  const second = p.c.saveSettings(); await flush();
  assert.equal(p.messages.filter(m => m.type === "SAVE_SETTINGS").length, 1);
  saving.resolve({ok: true, settings: p.settings});
  assert.equal(await first, true);
  assert.equal(await second, false);
  assert.equal(p.node("saveBtn").disabled, false);
});

for (const readReturnsAfterSave of [false, true]) {
  test(`late monitor settings cannot overwrite edited/saved values (afterSave=${readReturnsAfterSave})`, async () => {
    const p = await panel(), reading = deferred(), saving = deferred();
    p.hooks.monitorSettings = () => reading.promise;
    const load = p.c.loadMonitorStatus(); await flush();
    p.node("monitorVoiceRate").value = "1.5";
    p.node("monitorVoiceRate").listeners.input();
    p.hooks.save = () => saving.promise;
    const save = p.c.saveSettings(); await flush();
    if (readReturnsAfterSave) {
      saving.resolve({ok: true, settings: p.settings});
      assert.equal(await save, true);
    }
    reading.resolve({ok: true, voiceRate: 0.5}); await load;
    assert.equal(p.node("monitorVoiceRate").value, "1.5");
    if (!readReturnsAfterSave) {
      saving.resolve({ok: true, settings: p.settings});
      assert.equal(await save, true);
    }
    assert.equal(p.messages.find(m => m.type === "MONITOR_SAVE_SETTINGS").rate, 1.5);
  });
}

for (const readStartsBeforeEdit of [false, true]) {
  test(`late state settings cannot replace a saved edit (beforeEdit=${readStartsBeforeEdit})`, async () => {
    const p = await panel(), reading = deferred();
    const oldSettings = clone(p.settings);
    p.hooks.state = () => reading.promise;
    let load;
    if (readStartsBeforeEdit) { load = p.c.loadState(); await flush(); }
    p.node("aiModel").value = "new-saved-model";
    p.node("aiModel").listeners.input();
    if (!readStartsBeforeEdit) { load = p.c.loadState(); await flush(); }
    p.settings.aiModel = "new-saved-model";
    assert.equal(await p.c.saveSettings(), true);
    assert.equal(p.node("aiModel").value, "new-saved-model");
    reading.resolve({ok: true, settings: oldSettings, state: {
      runId: "old-run", running: true, manuallyStopped: false, stage: "x_replied", logs: []
    }});
    await load;
    assert.equal(p.node("aiModel").value, "new-saved-model");
    assert.equal(p.read("settingsDirty"), false);
  });
}

test("selected order ending in draft mode reports manual sending rather than cancellation or completion", async () => {
  const p = await panel(), action = deferred();
  const button = element();
  button.dataset.command = "RUN_SELECTED_COUNTDOWN_TASK";
  p.hooks.action = () => action.promise;
  const running = p.c.runSingleCommand(button); await flush();
  // Settings can change while the selected order is waiting for its lock.
  p.settings.replyMode = "fill";
  const state = {runId: "selected-run", mode: "selected_once", running: false,
    manuallyStopped: false, stage: "x_draft_ready", logs: []};
  p.setState(state);
  action.resolve({ok: true, pendingManualReply: true, state});
  await running;
  assert.match(p.node("commandStatus").textContent, /草稿.*人工发送/);
  assert.equal(p.node("commandStatus").dataset.kind, "info");
  assert.doesNotMatch(p.node("commandStatus").textContent, /已完成|停止|接管/);
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

test("side-panel recovery history shows the empty state and displays task text safely after STOP", async () => {
  const p = await panel({ stopped: true });
  assert.equal(p.node("recoveryHistoryEmpty").hidden, false);
  p.setState({ running: false, manuallyStopped: true, stage: "stopped", logs: [], autoRecoveryHistory: [{
    taskKey: "order-123", title: "<img src=x onerror=alert(1)>", tweetId: "123",
    stage: "lighthouse_verification_pending", at: 2200000, deadlineAt: 2199000,
    status: "retrying", updatedAt: 2300000
  }] });
  await p.tick();
  assert.equal(p.node("recoveryHistoryEmpty").hidden, true);
  const [item] = p.node("recoveryHistoryList").children;
  const allText = n => [n.textContent, ...n.children.map(allText)].join(" ");
  assert.match(allText(item), /<img src=x onerror=alert\(1\)>/);
  assert.match(allText(item), /123/);
  assert.match(allText(item), /灯塔验证/);
  assert.match(allText(item), /等待重试/);
  assert.match(allText(item), /截止/);
  assert.equal(item.innerHTML, "");
  await p.tick();
  assert.equal(p.node("recoveryHistoryList").children[0], item);
});
