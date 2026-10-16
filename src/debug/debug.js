const fields = {
  runMode: document.getElementById("runMode"),
  actionDelayMs: document.getElementById("actionDelayMs"),
  autoSubmitLighthouse: document.getElementById("autoSubmitLighthouse"),
  runWindowEnabled: document.getElementById("runWindowEnabled"),
  runWindowStart: document.getElementById("runWindowStart"),
  runWindowEnd: document.getElementById("runWindowEnd"),
  autoMinTaskBounty: document.getElementById("autoMinTaskBounty"),
  enableCooldownSniping: document.getElementById("enableCooldownSniping"),
  lockSeatTimeoutMs: document.getElementById("lockSeatTimeoutMs"),
  maxCooldownWaitMs: document.getElementById("maxCooldownWaitMs"),
  cooldownPollMs: document.getElementById("cooldownPollMs"),
  maxTasksPerRun: document.getElementById("maxTasksPerRun"),
  maxTaskAttempts: document.getElementById("maxTaskAttempts"),
  replyMode: document.getElementById("replyMode"),
  replyProvider: document.getElementById("replyProvider"),
  aiModel: document.getElementById("aiModel"),
  aiApiKey: document.getElementById("aiApiKey"),
  aiSystemPrompt: document.getElementById("aiSystemPrompt"),
  monitorEnabled: document.getElementById("monitorEnabled"),
  monitorMinBounty: document.getElementById("monitorMinBounty"),
  monitorVoiceEnabled: document.getElementById("monitorVoiceEnabled"),
  monitorVoiceEngine: document.getElementById("monitorVoiceEngine"),
  monitorVoiceName: document.getElementById("monitorVoiceName"),
  monitorVoiceRate: document.getElementById("monitorVoiceRate"),
  monitorVoicePitch: document.getElementById("monitorVoicePitch"),
  monitorMimoBaseUrl: document.getElementById("monitorMimoBaseUrl"),
  monitorMimoApiKey: document.getElementById("monitorMimoApiKey"),
  monitorVoiceTemplateAppear: document.getElementById("monitorVoiceTemplateAppear"),
  monitorVoiceTemplateCountdown2m: document.getElementById("monitorVoiceTemplateCountdown2m"),
  monitorVoiceTemplateCountdown1m: document.getElementById("monitorVoiceTemplateCountdown1m"),
};

const monitorFields = ["monitorEnabled", "monitorMinBounty", "monitorVoiceEnabled", "monitorVoiceEngine", "monitorVoiceName", "monitorVoiceRate", "monitorVoicePitch", "monitorMimoBaseUrl", "monitorMimoApiKey", "monitorVoiceTemplateAppear", "monitorVoiceTemplateCountdown2m", "monitorVoiceTemplateCountdown1m"];
const MIMO_DEFAULT_VOICES = [
  { id: "mimo_default", label: "mimo_default · 默认音色 · 中性清晰" },
  { id: "冰糖", label: "冰糖 · 中文女声 · 温暖甜润" },
  { id: "茉莉", label: "茉莉 · 中文女声 · 端庄大方" },
  { id: "苏打", label: "苏打 · 中文女声 · 活泼明亮" },
  { id: "白桦", label: "白桦 · 中文男声 · 沉稳磁性" },
  { id: "Mia", label: "Mia · 英文女声 · clear & natural" },
  { id: "Chloe", label: "Chloe · 英文女声 · soft & warm" },
  { id: "Milo", label: "Milo · 英文男声 · friendly & casual" },
  { id: "Dean", label: "Dean · 英文男声 · deep & authoritative" }
];
const MONITOR_TEMPLATE_PREVIEW_DATA = {
  bounty: "5",
  countdown: "2分钟",
  status: "倒计时2分钟",
  taskType: "评论",
  title: "Comment on the tweet",
  milestone: "还剩2分钟",
  milestoneText: "还剩2分钟，",
  titleText: "，标题Comment on the tweet"
};

const modeBadge = document.getElementById("modeBadge");
const stageBadge = document.getElementById("stageBadge");
const runModeHint = document.getElementById("runModeHint");
const runWindowHint = document.getElementById("runWindowHint");
const countdownList = document.getElementById("countdownList");
const countdownSyncTime = document.getElementById("countdownSyncTime");
const logList = document.getElementById("logList");
const replyRecordList = document.getElementById("replyRecordList");
const replyRecordCount = document.getElementById("replyRecordCount");
const viewButtons = Array.from(document.querySelectorAll("[data-view]"));
const viewPanels = Array.from(document.querySelectorAll("[data-view-panel]"));
const stepButtons = Array.from(document.querySelectorAll(".quickActions [data-command]"));
const saveBtn = document.getElementById("saveBtn");
const commandStatus = document.getElementById("commandStatus");
let settingsDirty = false;
let saveStatusTimer = null;
let commandStatusTimer = null;
let commandQueueRunning = false;
let activeStepQueue = null;
const COUNTDOWN_TICK_MS = 1000;
const COUNTDOWN_CALIBRATION_MS = 1000;
const COUNTDOWN_BOOTSTRAP_RETRY_MS = 1000;
const COUNTDOWN_BOOTSTRAP_MAX_ATTEMPTS = 12;
const COUNTDOWN_EMPTY_RETRY_MS = 5000;
const COUNTDOWN_EXPIRED_GRACE_MS = 5000;
let countdownTasks = [];
let countdownSyncedAt = 0;
let countdownSyncInFlight = false;
let countdownBootstrapAttempts = 0;
let countdownBootstrapTimer = null;
let selectedCountdownTask = null;
let selectedCountdownKey = "";
let renderedCountdownTasks = [];
let panelSpeechQueue = [];
let panelSpeaking = false;
let panelPaused = true;
let panelPauseKnown = false;
let panelEpoch = 0;
let panelStopEpoch = 0;
let panelStopPending = false;
let panelRunId = "";
let countdownTickTimer = null;
let countdownCalibrationTimer = null;
let activePanelSpeech = null;

const STEP_COMPLETION_STAGES = {
  DEBUG_OPEN_CAMPAIGNS: ["campaigns_opened", "lighthouse_page_detected"],
  DEBUG_OPEN_FIRST_TASK: ["task_detail_opened"],
  DEBUG_LOCK_SEAT_OPEN_TWEET: ["tweet_opened"],
  DEBUG_FAST_X_CLAIM_REPLY_VERIFY: ["fast_flow_done"],
  RUN_SELECTED_COUNTDOWN_TASK: ["selected_flow_done", "selected_lock_failed"],
  DEBUG_RUN_X_REPLY: ["x_replied"],
  DEBUG_CLOSE_X_RETURN_LIGHTHOUSE: ["returned_lighthouse"],
  DEBUG_CLICK_DONE: ["done_clicked"],
  DEBUG_RETURN_CAMPAIGNS: ["campaigns_returned"]
};

saveBtn.addEventListener("click", () => runPanelTask(saveSettings));
document.getElementById("stopBtn").addEventListener("click", () => {
  cancelStepQueue();
  const stopEpoch = typeof pausePanelActivity === "function" ? pausePanelActivity() : null;
  return runPanelTask(async () => {
    await chrome.runtime.sendMessage({ type: "STOP_RUN" });
    if (typeof finishPanelStop === "function") finishPanelStop(stopEpoch);
    await loadState();
  });
});
document.getElementById("clearReplyRecordsBtn").addEventListener("click", () => runPanelTask(clearReplyRecords));

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "AUTOMATION_PAUSE_CHANGED") {
    if (message.paused === true || !panelStopPending) {
      applyPanelPause(message.paused === true);
      if (message.paused === false) runPanelTask(loadState);
    }
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "PANEL_SPEAK_TEXT") {
    speakFromPanel(message);
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

Object.values(fields).forEach((field) => {
  field.addEventListener("input", markSettingsDirty);
  field.addEventListener("change", markSettingsDirty);
});

viewButtons.forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view));
});

stepButtons.forEach((button, index) => {
  button.addEventListener("click", () => runPanelTask(() => runStepQueue(index)));
});

countdownList.addEventListener("click", async (event) => {
  const item = event.target.closest("[data-countdown-index]");
  if (!item) return;
  const task = renderedCountdownTasks[Number(item.dataset.countdownIndex)];
  if (!task) return;
  selectCountdownTask(task);
});

Array.from(document.querySelectorAll("[data-command]"))
  .filter((button) => !stepButtons.includes(button))
  .forEach((button) => {
    button.addEventListener("click", () => runPanelTask(() => runSingleCommand(button)));
  });

setView(localStorage.getItem("lighthouseDebugView") || "tasks");
runPanelTask(loadState);
setInterval(() => runPanelTask(loadState), 1000);
runPanelTask(loadMonitorStatus);
initMonitorButtons();
if ("speechSynthesis" in window) {
  speechSynthesis.getVoices();
  speechSynthesis.onvoiceschanged = () => populateVoiceOptions(fields.monitorVoiceName.value);
}

function pausePanelActivity() {
  panelStopPending = true;
  applyPanelPause(true, true);
  return panelEpoch;
}

function finishPanelStop(epoch) {
  if (epoch === panelEpoch) panelStopPending = false;
}

function applyPanelPause(paused, force = false) {
  if (panelPauseKnown && panelPaused === paused && !force) return;
  panelPauseKnown = true;
  panelPaused = paused;
  panelEpoch += 1;
  countdownSyncInFlight = false;
  if (!paused) {
    countdownTickTimer = setInterval(tickCountdowns, COUNTDOWN_TICK_MS);
    countdownCalibrationTimer = setInterval(() => syncCountdowns("calibration"), COUNTDOWN_CALIBRATION_MS);
    startCountdownBootstrapSync();
    return;
  }
  panelStopEpoch += 1;
  panelRunId = "";
  cancelStepQueue();
  document.querySelectorAll("[data-command]").forEach((button) => setButtonRunning(button, false));
  clearInterval(countdownTickTimer);
  clearInterval(countdownCalibrationTimer);
  countdownTickTimer = null;
  countdownCalibrationTimer = null;
  stopCountdownBootstrapSync();
  countdownTasks = [];
  renderedCountdownTasks = [];
  countdownSyncedAt = 0;
  selectedCountdownTask = null;
  selectedCountdownKey = "";
  panelSpeechQueue = [];
  const speech = activePanelSpeech;
  activePanelSpeech = null;
  panelSpeaking = false;
  speech?.controller.abort();
  speech?.cancel?.();
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  countdownList.innerHTML = '<p class="countdownEmpty">已停止，等待手动启动</p>';
  countdownSyncTime.textContent = "已停止";
  document.getElementById("monitorStatus").textContent = "已停止，等待手动启动";
  logList.replaceChildren();
  modeBadge.textContent = "idle";
  stageBadge.textContent = "stopped";
  document.body.dataset.mode = "idle";
  document.body.dataset.stage = "stopped";
}

function runPanelTask(action) {
  return Promise.resolve()
    .then(action)
    .catch((error) => {
      const message = String(error?.message || error || "");
      if (/message channel closed|Extension context invalidated|Receiving end does not exist/i.test(message)) return;
      console.warn("[LighthousePanel] async action failed:", error);
    });
}

async function loadState() {
  const epoch = panelEpoch;
  const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  if (epoch !== panelEpoch || panelStopPending) return;
  if (!response || !response.ok) return;
  applyPanelPause(response.state?.manuallyStopped === true);
  panelRunId = panelPaused ? "" : (response.state?.runId || "");
  if (!settingsDirty) {
    renderSettings(response.settings);
  }
  renderState(response.state, response.settings);
  if (getActiveView() === "records") await loadReplyRecords();
}

async function saveSettings() {
  const settings = readSettings();
  if (!(await requestCustomAIHostPermission(settings.aiApiUrl))) return;
  const response = await chrome.runtime.sendMessage({
    type: "SAVE_SETTINGS",
    settings
  });
  if (response && response.ok) {
    settingsDirty = false;
    renderSettings(response.settings);
    showSaveStatus("已保存");
  }
  await saveMonitorSettings();
}

async function requestCustomAIHostPermission(apiUrl) {
  const raw = String(apiUrl || "").trim();
  if (!raw) return true;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") {
      showSaveStatus("API URL 必须使用 https");
      return false;
    }
    const origin = `${url.protocol}//${url.host}/*`;
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (granted) return true;
    showSaveStatus("未授予该 API 域名访问权限，配置未保存");
    return false;
  } catch (_) {
    showSaveStatus("API URL 格式无效，请填写完整接口地址");
    return false;
  }
}

async function saveMonitorSettings() {
  const ms = readMonitorSettings();
  try {
    await chrome.runtime.sendMessage({ type: "MONITOR_SET_ENABLED", enabled: ms.enabled });
    await chrome.runtime.sendMessage({ type: "MONITOR_SET_THRESHOLD", minBounty: ms.minBounty });
    await chrome.runtime.sendMessage({
      type: "MONITOR_SET_VOICE",
      voiceEnabled: ms.voiceEnabled,
      voiceEngine: ms.voiceEngine,
      voiceName: ms.voiceName,
      rate: ms.rate,
      pitch: ms.pitch,
      mimoBaseUrl: ms.mimoBaseUrl,
      mimoApiKey: ms.mimoApiKey,
      templateAppear: ms.templateAppear,
      templateCountdown2m: ms.templateCountdown2m,
      templateCountdown1m: ms.templateCountdown1m
    });
  } catch (_) {}
}

async function runSingleCommand(button) {
  if (commandQueueRunning) return;
  const commandEpoch = panelStopEpoch;
  const isCurrent = () => commandEpoch === panelStopEpoch;
  await saveSettings();
  if (!isCurrent()) return;
  setButtonRunning(button, true);
  if (button.dataset.command === "RUN_SELECTED_COUNTDOWN_TASK") {
    showCommandStatus("正在停止当前流程并启动选中任务", "info", 0);
  }
  try {
    const response = await sendCommandAndWaitForStage(button.dataset.command, { isCurrent });
    if (!isCurrent()) return;
    if (!response?.ok) {
      showCommandStatus(response?.error || response?.result?.message || "指令未执行", "error");
    } else if (button.dataset.command === "RUN_SELECTED_COUNTDOWN_TASK") {
      showCommandStatus("选中任务流程已完成", "success");
    }
  } finally {
    if (isCurrent()) {
      setButtonRunning(button, false);
      await loadState();
    }
  }
}

function showCommandStatus(text, kind = "info", timeoutMs = 5000) {
  if (!commandStatus) return;
  if (commandStatusTimer) clearTimeout(commandStatusTimer);
  commandStatus.textContent = text || "";
  commandStatus.dataset.kind = kind;
  commandStatus.hidden = !text;
  commandStatusTimer = null;
  if (text && timeoutMs > 0) {
    commandStatusTimer = setTimeout(() => {
      commandStatus.textContent = "";
      commandStatus.hidden = true;
      commandStatusTimer = null;
    }, timeoutMs);
  }
}

async function runStepQueue(startIndex) {
  if (commandQueueRunning) return;
  const queueRun = { cancelled: false, runId: "" };
  activeStepQueue = queueRun;
  const ownsQueue = () => activeStepQueue === queueRun;
  const isCurrent = () => ownsQueue() && !queueRun.cancelled;
  commandQueueRunning = true;
  let completed = true;
  try {
    setStepButtonsDisabled(true);
    await saveSettings();
    if (!isCurrent()) return;
    showCommandStatus(`从第 ${startIndex + 1} 步开始连续执行`, "info", 0);
    const queue = stepButtons.slice(startIndex);
    for (const button of queue) {
      if (!isCurrent()) return;
      setButtonRunning(button, true);
      const label = button.querySelector("strong")?.textContent || "步骤";
      try {
        const response = await sendCommandAndWaitForStage(button.dataset.command, { queueRun, isCurrent });
        if (!isCurrent()) return;
        if (!response?.ok) {
          completed = false;
          showCommandStatus(response?.error || response?.result?.message || `${label}未完成`, "error");
          break;
        }
      } finally {
        if (ownsQueue()) {
          setButtonRunning(button, false);
          await loadState();
        }
      }
    }
  } catch (error) {
    completed = false;
    if (isCurrent()) showCommandStatus(error?.message || "步骤执行失败", "error");
  } finally {
    if (ownsQueue()) {
      commandQueueRunning = false;
      setStepButtonsDisabled(false);
      try {
        await loadState();
      } catch (error) {
        completed = false;
        if (isCurrent()) showCommandStatus(error?.message || "读取流程状态失败", "error");
      } finally {
        if (ownsQueue()) {
          activeStepQueue = null;
          if (completed && !queueRun.cancelled) showCommandStatus("后续流程已连续执行完成", "success");
        }
      }
    }
  }
}

function cancelStepQueue() {
  if (!activeStepQueue) return;
  activeStepQueue.cancelled = true;
  activeStepQueue = null;
  commandQueueRunning = false;
  setStepButtonsDisabled(false);
  stepButtons.forEach((button) => setButtonRunning(button, false));
  showCommandStatus("步骤队列已停止", "info");
}

async function sendCommandAndWaitForStage(command, control = {}) {
  const isCurrent = control.isCurrent || (() => true);
  const cancelled = () => ({ ok: false, cancelled: true, error: "单步流程已停止或被新流程接管" });
  if (!isCurrent()) return cancelled();
  const payload = await withClientWindowId({ type: command });
  if (!isCurrent()) return cancelled();
  if (control.queueRun?.runId) payload.expectedRunId = control.queueRun.runId;
  if (command === "DEBUG_FAST_X_CLAIM_REPLY_VERIFY" || command === "RUN_SELECTED_COUNTDOWN_TASK") {
    const task = resolveSelectedCountdownTask();
    if (task) payload.selectedTask = task;
  }
  const response = await chrome.runtime.sendMessage(payload);
  if (!isCurrent()) return cancelled();
  if (!response || response.ok === false) return response || { ok: false };

  const state = response.state || {};
  if (control.queueRun?.runId && state.runId !== control.queueRun.runId) return cancelled();
  if (control.queueRun && !state.runId) return { ok: false, error: `无法确认步骤所属流程：${command}` };
  if (control.queueRun && state.runId) control.queueRun.runId = state.runId;

  const expectedStages = STEP_COMPLETION_STAGES[command];
  if (!expectedStages || expectedStages.length === 0) {
    const completedAutoRun = command === "START_RUN" && state.mode === "auto" && state.stage === "finished";
    return state.running === false && !completedAutoRun ? cancelled() : response;
  }

  if (expectedStages.includes(state.stage)) return response;
  if (state.running === false) return cancelled();
  if (!state.runId) return { ok: false, error: `无法确认步骤所属流程：${command}` };

  const completion = await waitForStateStage(expectedStages, getStepWaitTimeoutMs(command), state.runId, isCurrent);
  if (!isCurrent()) return cancelled();
  return completion.ok ? { ...response, state: completion.state } : completion;
}

async function withClientWindowId(payload) {
  try {
    const currentWindow = await chrome.windows.getCurrent();
    if (Number.isInteger(currentWindow?.id)) {
      return { ...payload, clientWindowId: currentWindow.id };
    }
  } catch (_) {}
  return payload;
}

async function waitForStateStage(expectedStages, timeoutMs, runId, isCurrent = () => true) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isCurrent()) return { ok: false, cancelled: true, error: "单步流程已停止" };
    const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });
    if (!isCurrent()) return { ok: false, cancelled: true, error: "单步流程已停止" };
    const state = response?.state;
    if (response?.ok && state?.runId !== runId) return { ok: false, cancelled: true, error: "流程已变化，停止旧步骤队列" };
    if (response?.ok && expectedStages.includes(state?.stage)) return { ok: true, state };
    if (response?.ok && state?.running === false) return { ok: false, cancelled: true, error: "运行已停止，停止步骤等待" };
    await wait(250);
  }
  return { ok: false, error: "等待步骤完成超时" };
}

function getStepWaitTimeoutMs(command) {
  if (command === "DEBUG_FAST_X_CLAIM_REPLY_VERIFY") return 300000;
  if (command === "RUN_SELECTED_COUNTDOWN_TASK") return 300000;
  if (command === "DEBUG_LOCK_SEAT_OPEN_TWEET") return 90000;
  if (command === "DEBUG_RUN_X_REPLY") return 90000;
  if (command === "DEBUG_CLICK_DONE") return 30000;
  return 15000;
}

function setStepButtonsDisabled(disabled) {
  stepButtons.forEach((button) => {
    button.disabled = disabled;
  });
}

function setButtonRunning(button, running) {
  button.disabled = running || (commandQueueRunning && stepButtons.includes(button));
  button.classList.toggle("is-running", running);
  if (running) {
    button.setAttribute("aria-busy", "true");
  } else {
    button.removeAttribute("aria-busy");
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readSettings() {
  return {
    runMode: fields.runMode.value,
    actionDelayMs: Number(fields.actionDelayMs.value),
    autoSubmitLighthouse: fields.autoSubmitLighthouse.checked,
    runWindowEnabled: fields.runWindowEnabled.checked,
    runWindowStart: fields.runWindowStart.value,
    runWindowEnd: fields.runWindowEnd.value,
    autoMinTaskBounty: Number(fields.autoMinTaskBounty.value),
    enableCooldownSniping: fields.enableCooldownSniping.checked,
    lockSeatTimeoutMs: Number(fields.lockSeatTimeoutMs.value),
    maxCooldownWaitMs: Number(fields.maxCooldownWaitMs.value),
    cooldownPollMs: Number(fields.cooldownPollMs.value),
    maxTasksPerRun: Number(fields.maxTasksPerRun.value),
    maxTaskAttempts: Number(fields.maxTaskAttempts.value),
    replyMode: fields.replyMode.value,
    replyProvider: fields.replyProvider.value,
    aiProvider: "gpt-5.6-terra",
    aiModel: fields.aiModel.value.trim(),
    aiApiUrl: "https://api.vayne.cc.cd/v1/responses",
    aiApiKey: fields.aiApiKey.value.trim(),
    aiSystemPrompt: fields.aiSystemPrompt.value.trim()
  };
}

function readMonitorSettings() {
  return {
    enabled: fields.monitorEnabled.checked,
    minBounty: Number(fields.monitorMinBounty.value) || 0.5,
    voiceEnabled: fields.monitorVoiceEnabled.checked,
    voiceEngine: fields.monitorVoiceEngine.value === "browser" ? "browser" : "mimo",
    voiceName: fields.monitorVoiceName.value,
    rate: Number(fields.monitorVoiceRate.value) || 0.9,
    pitch: Number(fields.monitorVoicePitch.value) || 1.0,
    mimoBaseUrl: fields.monitorMimoBaseUrl.value.trim(),
    mimoApiKey: fields.monitorMimoApiKey.value.trim(),
    templateAppear: fields.monitorVoiceTemplateAppear.value.trim(),
    templateCountdown2m: fields.monitorVoiceTemplateCountdown2m.value.trim(),
    templateCountdown1m: fields.monitorVoiceTemplateCountdown1m.value.trim()
  };
}

function renderSettings(settings) {
  const active = document.activeElement;
  if (Object.values(fields).includes(active)) return;

  fields.runMode.value = settings.runMode || "debug";
  fields.actionDelayMs.value = settings.actionDelayMs;
  fields.autoSubmitLighthouse.checked = settings.autoSubmitLighthouse;
  fields.runWindowEnabled.checked = settings.runWindowEnabled !== false;
  fields.runWindowStart.value = settings.runWindowStart || "11:00";
  fields.runWindowEnd.value = settings.runWindowEnd || "01:00";
  fields.autoMinTaskBounty.value = settings.autoMinTaskBounty ?? 0.1;
  fields.enableCooldownSniping.checked = settings.enableCooldownSniping;
  fields.lockSeatTimeoutMs.value = settings.lockSeatTimeoutMs;
  fields.maxCooldownWaitMs.value = settings.maxCooldownWaitMs;
  fields.cooldownPollMs.value = settings.cooldownPollMs;
  fields.maxTasksPerRun.value = settings.maxTasksPerRun;
  fields.maxTaskAttempts.value = settings.maxTaskAttempts;
  fields.replyMode.value = settings.replyMode;
  fields.replyProvider.value = settings.replyProvider;
  fields.aiModel.value = settings.aiModel || "gpt-5.6-terra";
  fields.aiApiKey.value = settings.aiApiKey || "";
  fields.aiSystemPrompt.value = settings.aiSystemPrompt || "";
  renderRunModeHint(settings.runMode || "debug");
}

function renderState(state, settings = {}) {
  const mode = state.mode || "idle";
  const stage = state.stage || "idle";
  document.body.dataset.mode = mode;
  document.body.dataset.stage = stage;
  document.body.dataset.runMode = settingsDirty ? (fields.runMode.value || "debug") : (settings.runMode || "debug");
  modeBadge.textContent = mode;
  stageBadge.textContent = stage;
  renderRunModeHint(settingsDirty ? (fields.runMode.value || "debug") : (settings.runMode || "debug"));
  renderRunWindowHint(state, settingsDirty ? readSettings() : settings);

  logList.replaceChildren(...(state.logs || []).slice(0, 60).map(renderLogEntry));
}

function renderRunModeHint(runMode) {
  runModeHint.textContent = runMode === "auto" ? "正式模式" : "调试模式";
}

function renderRunWindowHint(state = {}, settings = {}) {
  const enabled = settings.runWindowEnabled !== false;
  const start = settings.runWindowStart || "11:00";
  const end = settings.runWindowEnd || "01:00";
  if (!enabled) {
    runWindowHint.textContent = "运行时段 已关闭";
    return;
  }
  if (state?.stage === "auto_waiting_schedule" && state?.scheduledResumeAt) {
    runWindowHint.textContent = `等待 ${formatDateTime(state.scheduledResumeAt)}`;
    return;
  }
  runWindowHint.textContent = `运行时段 ${start}-${end}`;
}

function markSettingsDirty() {
  settingsDirty = true;
  renderRunModeHint(fields.runMode.value || "debug");
  renderMonitorTemplatePreviews();
  showSaveStatus("保存配置");
}

function showSaveStatus(text) {
  saveBtn.textContent = text;
  if (saveStatusTimer) clearTimeout(saveStatusTimer);
  if (text !== "保存配置") {
    saveStatusTimer = setTimeout(() => {
      saveBtn.textContent = "保存配置";
      saveStatusTimer = null;
    }, 1200);
  }
}

function renderLogEntry(entry) {
  const item = document.createElement("li");
  const time = document.createElement("time");
  const text = document.createElement("span");
  item.className = entry.level || "info";
  time.textContent = formatTime(entry.at);
  const phase = formatLogPagePhase(entry.pagePhase);
  text.textContent = `[${entry.level || "info"}]${phase ? ` [${phase}]` : ""} ${entry.text}`;
  item.append(time, text);
  return item;
}

async function loadReplyRecords() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_REPLY_RECORDS" });
    if (response?.ok) {
      renderReplyRecords(response.records || []);
      return;
    }
  } catch (_) {}
  renderReplyRecords([]);
}

async function clearReplyRecords() {
  await chrome.runtime.sendMessage({ type: "CLEAR_REPLY_RECORDS" });
  await loadReplyRecords();
}

function renderReplyRecords(records) {
  const list = Array.isArray(records) ? records : [];
  replyRecordCount.textContent = `${list.length} 条`;
  if (!list.length) {
    replyRecordList.innerHTML = '<p class="recordEmpty">暂无回复记录</p>';
    return;
  }
  replyRecordList.replaceChildren(...list.map(renderReplyRecordItem));
}

function renderReplyRecordItem(record) {
  const item = document.createElement("article");
  item.className = "replyRecordItem";

  const meta = document.createElement("div");
  meta.className = "replyRecordMeta";
  const time = document.createElement("time");
  time.textContent = formatDateTime(record.createdAt);
  const source = document.createElement("span");
  source.textContent = [record.authorHandle || record.authorName || "", record.mode ? `模式 ${record.mode}` : ""].filter(Boolean).join(" · ") || "回复记录";
  meta.append(time, source);

  const tweet = document.createElement("p");
  tweet.className = "replyRecordTweet";
  tweet.textContent = record.tweetText || record.taskTitle || "未记录到推文正文";

  const reply = document.createElement("p");
  reply.className = "replyRecordReply";
  reply.textContent = record.replyText || "";

  item.append(meta, tweet, reply);
  if (record.tweetUrl) {
    const link = document.createElement("a");
    link.className = "replyRecordLink";
    link.href = record.tweetUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "打开推文";
    item.append(link);
  }
  return item;
}

function formatLogPagePhase(phase) {
  const labels = {
    campaigns: "广场",
    campaigns_loading: "广场加载",
    detail_loading: "详情加载",
    detail_ready: "详情页",
    detail_error: "详情报错",
    unknown: "",
    snapshot_error: "快照失败"
  };
  return labels[phase] || "";
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function setView(view) {
  const nextView = ["tasks", "settings", "records"].includes(view) ? view : "tasks";
  localStorage.setItem("lighthouseDebugView", nextView);
  viewButtons.forEach((button) => {
    const active = button.dataset.view === nextView;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  viewPanels.forEach((panel) => {
    const active = panel.dataset.viewPanel === nextView;
    panel.classList.toggle("is-active", active);
    panel.toggleAttribute("hidden", !active);
  });
  if (nextView === "records") loadReplyRecords();
}

function getActiveView() {
  return localStorage.getItem("lighthouseDebugView") || "tasks";
}

async function loadMonitorStatus() {
  const epoch = panelEpoch;
  try {
    const response = await chrome.runtime.sendMessage({ type: "MONITOR_GET_SETTINGS" });
    if (response && response.ok) {
      fields.monitorEnabled.checked = response.enabled;
      fields.monitorMinBounty.value = response.minBounty;
      fields.monitorVoiceEnabled.checked = response.voiceEnabled;
      fields.monitorVoiceEngine.value = response.voiceEngine || "mimo";
      populateVoiceOptions(response.voiceName || "", fields.monitorVoiceEngine.value);
      fields.monitorVoiceRate.value = response.voiceRate;
      fields.monitorVoicePitch.value = response.voicePitch;
      fields.monitorMimoBaseUrl.value = response.mimoBaseUrl || "";
      fields.monitorMimoApiKey.value = response.mimoApiKey || "";
      fields.monitorVoiceTemplateAppear.value = response.voiceTemplateAppear || "";
      fields.monitorVoiceTemplateCountdown2m.value = response.voiceTemplateCountdown2m || "";
      fields.monitorVoiceTemplateCountdown1m.value = response.voiceTemplateCountdown1m || "";
      renderMonitorTemplatePreviews();
      document.getElementById("monitorVoiceRateValue").textContent = response.voiceRate;
      document.getElementById("monitorVoicePitchValue").textContent = response.voicePitch;
      if (!panelPaused && epoch === panelEpoch) document.getElementById("monitorStatus").textContent = `已通知 ${response.seenCount || 0} 条`;
      return;
    }
  } catch (_) {}
  if (!panelPaused && epoch === panelEpoch) document.getElementById("monitorStatus").textContent = "未连接（请先打开灯塔页面）";
}

function initMonitorButtons() {
  const rateSlider = fields.monitorVoiceRate;
  const pitchSlider = fields.monitorVoicePitch;
  const engineSelect = fields.monitorVoiceEngine;
  const voiceSelect = fields.monitorVoiceName;
  const rateValue = document.getElementById("monitorVoiceRateValue");
  const pitchValue = document.getElementById("monitorVoicePitchValue");

  populateVoiceOptions(voiceSelect.value, engineSelect.value);
  engineSelect.addEventListener("change", () => {
    populateVoiceOptions("", engineSelect.value);
    markSettingsDirty();
  });
  voiceSelect.addEventListener("change", markSettingsDirty);
  rateSlider.addEventListener("input", () => { rateValue.textContent = rateSlider.value; markSettingsDirty(); });
  pitchSlider.addEventListener("input", () => { pitchValue.textContent = pitchSlider.value; markSettingsDirty(); });

  document.getElementById("monitorTestVoiceBtn").addEventListener("click", async () => {
    if (panelPaused) return;
    const epoch = panelEpoch;
    try {
      await saveMonitorSettings();
      if (panelPaused || epoch !== panelEpoch) return;
      document.getElementById("monitorStatus").textContent = "语音测试中...";
      await chrome.runtime.sendMessage({ type: "MONITOR_TEST_VOICE" });
    } catch (e) {
      if (!panelPaused && epoch === panelEpoch) document.getElementById("monitorStatus").textContent = `语音失败: ${e?.message || "unknown"}`;
    }
  });

  document.getElementById("monitorClearSeenBtn").addEventListener("click", async () => {
    try {
      await chrome.runtime.sendMessage({ type: "MONITOR_CLEAR_SEEN" });
      document.getElementById("monitorStatus").textContent = "已清除";
      setTimeout(loadMonitorStatus, 500);
    } catch (_) {}
  });

  renderMonitorTemplatePreviews();
}

function renderMonitorTemplatePreviews() {
  const appearPreview = document.getElementById("monitorVoiceTemplateAppearPreview");
  const countdown2mPreview = document.getElementById("monitorVoiceTemplateCountdown2mPreview");
  const countdown1mPreview = document.getElementById("monitorVoiceTemplateCountdown1mPreview");
  if (appearPreview) {
    appearPreview.textContent = renderMonitorTemplate(fields.monitorVoiceTemplateAppear.value.trim());
  }
  if (countdown2mPreview) {
    countdown2mPreview.textContent = renderMonitorTemplate(fields.monitorVoiceTemplateCountdown2m.value.trim());
  }
  if (countdown1mPreview) {
    countdown1mPreview.textContent = renderMonitorTemplate(fields.monitorVoiceTemplateCountdown1m.value.trim(), {
      ...MONITOR_TEMPLATE_PREVIEW_DATA,
      countdown: "1分钟",
      status: "倒计时1分钟",
      milestone: "还剩1分钟",
      milestoneText: "还剩1分钟，"
    });
  }
}

function renderMonitorTemplate(template, data = MONITOR_TEMPLATE_PREVIEW_DATA) {
  const source = String(template || "").trim();
  if (!source) return "--";
  return source.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key) => data[key] ?? "")
    .replace(/，{2,}/g, "，")
    .replace(/\s+/g, " ")
    .trim();
}

function populateVoiceOptions(selectedName = "", engine = fields.monitorVoiceEngine.value) {
  const select = fields.monitorVoiceName;
  if (!select) return;
  const current = selectedName || select.value || "";
  const options = [];

  if (engine === "mimo") {
    if (current && !MIMO_DEFAULT_VOICES.some((voice) => voice.id === current)) {
      options.push(`<option value="${escapeHtml(current)}">${escapeHtml(current)}（未配置）</option>`);
    }
    for (const voice of MIMO_DEFAULT_VOICES) {
      options.push(`<option value="${escapeHtml(voice.id)}">${escapeHtml(voice.label)}</option>`);
    }
  } else {
    if (!("speechSynthesis" in window)) return;
    const voices = rankVoices(speechSynthesis.getVoices());
    options.push('<option value="">自动选择中文音色</option>');

    if (current && !voices.some((voice) => voice.name === current)) {
      options.push(`<option value="${escapeHtml(current)}">${escapeHtml(current)}（未加载）</option>`);
    }

    for (const voice of voices) {
      const label = `${voice.name} · ${voice.lang}${voice.localService ? " · 本机" : ""}`;
      options.push(`<option value="${escapeHtml(voice.name)}">${escapeHtml(label)}</option>`);
    }
  }

  select.innerHTML = options.join("");
  select.value = current || (engine === "mimo" ? "冰糖" : "");
}

function rankVoices(voices) {
  return [...(voices || [])].sort((a, b) => scoreVoice(b) - scoreVoice(a) || a.name.localeCompare(b.name));
}

function scoreVoice(voice) {
  const value = `${voice.name} ${voice.lang}`.toLowerCase();
  let score = 0;
  if (/zh|chinese|普通话|中文|mandarin/.test(value)) score += 100;
  if (/natural|xiaoxiao|yunxi|huihui|yaoyao|ting|premium|online/.test(value)) score += 30;
  if (/google|microsoft/.test(value)) score += 10;
  if (voice.localService) score += 3;
  return score;
}

function chooseVoice(preferredName = "") {
  const voices = rankVoices(speechSynthesis.getVoices());
  if (preferredName) {
    const exact = voices.find((voice) => voice.name === preferredName);
    if (exact) return exact;
  }
  return voices.find((voice) => /zh|chinese|普通话|中文|mandarin/i.test(`${voice.name} ${voice.lang}`)) || voices[0] || null;
}

function speakFromPanel(message) {
  if (panelPaused || !panelRunId || message.runId !== panelRunId) return;
  const text = String(message.text || "").trim();
  if (!text) return;

  if (panelSpeechQueue.length >= 3) {
    panelSpeechQueue = panelSpeechQueue.slice(-2);
  }
  panelSpeechQueue.push({
    text,
    voiceEngine: message.voiceEngine || fields.monitorVoiceEngine.value || "mimo",
    voiceName: message.voiceName || fields.monitorVoiceName.value || "",
    rate: Number(message.voiceRate || fields.monitorVoiceRate.value) || 0.9,
    pitch: Number(message.voicePitch || fields.monitorVoicePitch.value) || 1.0,
    mimoBaseUrl: message.mimoBaseUrl || fields.monitorMimoBaseUrl.value || "",
    mimoApiKey: message.mimoApiKey || fields.monitorMimoApiKey.value || ""
  });
  document.getElementById("monitorStatus").textContent = "收到播报，准备发声";
  processPanelSpeechQueue();
}

async function processPanelSpeechQueue() {
  if (panelPaused || panelSpeaking || panelSpeechQueue.length === 0) return;
  panelSpeaking = true;
  const item = panelSpeechQueue.shift();
  const speech = { epoch: panelEpoch, controller: new AbortController(), cancel: null };
  activePanelSpeech = speech;

  try {
    if (item.voiceEngine === "mimo") {
      const voiceLabel = item.voiceName || "冰糖";
      document.getElementById("monitorStatus").textContent = `播报中 · MiMo ${voiceLabel}`;
      await playMimoSpeech(item, speech);
      if (isCurrentPanelSpeech(speech)) document.getElementById("monitorStatus").textContent = `播报完成 · MiMo ${voiceLabel}`;
    } else {
      await playBrowserSpeech(item, speech);
    }
  } catch (error) {
    if (isCurrentPanelSpeech(speech)) document.getElementById("monitorStatus").textContent = `播报失败: ${error?.message || "unknown"}`;
  } finally {
    if (activePanelSpeech === speech) {
      activePanelSpeech = null;
      panelSpeaking = false;
      processPanelSpeechQueue();
    }
  }
}

function isCurrentPanelSpeech(speech) {
  return !panelPaused && activePanelSpeech === speech && speech.epoch === panelEpoch;
}

function playBrowserSpeech(item, speech) {
  return new Promise((resolve, reject) => {
    if (!("speechSynthesis" in window)) {
      reject(new Error("浏览器不支持本机语音"));
      return;
    }

    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(item.text);
    utterance.lang = "zh-CN";
    utterance.rate = item.rate;
    utterance.pitch = item.pitch;
    utterance.volume = 1.0;

    const chosen = chooseVoice(item.voiceName);
    if (chosen) utterance.voice = chosen;
    document.getElementById("monitorStatus").textContent = `播报中 · ${chosen?.name || "默认音色"}`;
    speech.cancel = () => {
      utterance.onend = null;
      utterance.onerror = null;
      resolve();
    };
    utterance.onend = () => {
      if (isCurrentPanelSpeech(speech)) document.getElementById("monitorStatus").textContent = `播报完成 · ${chosen?.name || "默认音色"}`;
      resolve();
    };
    utterance.onerror = (event) => reject(new Error(event.error || "browser_tts_failed"));
    speechSynthesis.speak(utterance);
  });
}

async function playMimoSpeech(item, speech) {
  const apiKey = String(item.mimoApiKey || "").trim();
  const baseUrl = normalizeMimoBaseUrl(item.mimoBaseUrl || "");
  if (!apiKey) throw new Error("缺少 MiMo API Key");

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    signal: speech.controller.signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "mimo-v2.5-tts",
      messages: [{ role: "assistant", content: item.text }],
      audio: {
        voice: item.voiceName || "冰糖",
        format: "mp3",
        speed: item.rate
      },
      modalities: ["text", "audio"]
    })
  });

  if (!isCurrentPanelSpeech(speech)) return;
  const payload = await response.json().catch(() => ({}));
  if (!isCurrentPanelSpeech(speech)) return;
  if (!response.ok) {
    const detail = payload?.error?.message || payload?.detail || response.statusText || "mimo_request_failed";
    throw new Error(detail);
  }

  const audioData = payload?.choices?.[0]?.message?.audio?.data;
  if (!audioData) throw new Error("MiMo 未返回音频数据");

  const url = createObjectUrlFromBase64(audioData, "audio/mpeg");
  try {
    await playAudioUrl(url, speech);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function normalizeMimoBaseUrl(value) {
  const base = String(value || "").trim() || "https://api.xiaomimimo.com/v1";
  return base.replace(/\/+$/, "");
}

function createObjectUrlFromBase64(base64, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

function playAudioUrl(url, speech) {
  return new Promise((resolve, reject) => {
    if (!isCurrentPanelSpeech(speech)) { resolve(); return; }
    const audio = new Audio(url);
    speech.cancel = () => {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      resolve();
    };
    audio.onended = () => resolve();
    audio.onerror = () => reject(new Error("audio_play_failed"));
    audio.play().catch((error) => reject(new Error(error?.message || "audio_play_failed")));
  });
}

async function syncCountdowns(reason = "manual") {
  if (panelPaused || countdownSyncInFlight) return;
  const epoch = panelEpoch;
  countdownSyncInFlight = true;
  try {
    const payload = await withClientWindowId({ type: "MONITOR_GET_COUNTDOWNS" });
    if (panelPaused || epoch !== panelEpoch) return;
    const response = await chrome.runtime.sendMessage(payload);
    if (panelPaused || epoch !== panelEpoch) return;
    if (response?.paused) { applyPanelPause(true); return; }
    if (response && response.ok) {
      countdownSyncedAt = Number(response.timestamp) || Date.now();
      countdownTasks = normalizeCountdownTasks(response.tasks || [], countdownSyncedAt);
      renderCountdowns(countdownTasks, countdownSyncedAt, reason);
      if (countdownTasks.length > 0) stopCountdownBootstrapSync();
    } else {
      countdownSyncTime.textContent = "无数据";
    }
  } catch (e) {
    if (!panelPaused && epoch === panelEpoch) countdownSyncTime.textContent = "错误";
  } finally {
    if (epoch === panelEpoch) countdownSyncInFlight = false;
  }
}

function startCountdownBootstrapSync() {
  if (panelPaused || countdownBootstrapTimer) return;
  countdownBootstrapAttempts = 0;
  syncCountdowns("bootstrap");
  scheduleCountdownBootstrapRetry(COUNTDOWN_BOOTSTRAP_RETRY_MS);
}

function scheduleCountdownBootstrapRetry(delayMs) {
  if (panelPaused) return;
  const epoch = panelEpoch;
  if (countdownBootstrapTimer) clearInterval(countdownBootstrapTimer);
  countdownBootstrapTimer = setInterval(async () => {
    if (panelPaused || epoch !== panelEpoch) return;
    if (countdownTasks.length > 0) {
      stopCountdownBootstrapSync();
      return;
    }
    countdownBootstrapAttempts += 1;
    await syncCountdowns("bootstrap");
    if (panelPaused || epoch !== panelEpoch) return;
    if (countdownBootstrapAttempts === COUNTDOWN_BOOTSTRAP_MAX_ATTEMPTS) {
      scheduleCountdownBootstrapRetry(COUNTDOWN_EMPTY_RETRY_MS);
    }
  }, delayMs);
}

function stopCountdownBootstrapSync() {
  if (!countdownBootstrapTimer) return;
  clearInterval(countdownBootstrapTimer);
  countdownBootstrapTimer = null;
}

function tickCountdowns() {
  if (panelPaused || !countdownTasks.length) return;
  renderCountdowns(countdownTasks, countdownSyncedAt, "local");
}

function normalizeCountdownTasks(tasks, timestamp) {
  return tasks.map((task) => {
    const countdownSec = Math.max(0, Number(task.countdownSec) || 0);
    return {
      ...task,
      countdownSec,
      syncedAt: timestamp,
      expiresAt: task.isCooling && countdownSec > 0 ? timestamp + countdownSec * 1000 : 0
    };
  });
}

function deriveLocalCountdownTask(task) {
  if (!task.isCooling || !task.expiresAt) return task;

  const remainingSec = Math.max(0, Math.floor((task.expiresAt - Date.now()) / 1000));
  return {
    ...task,
    countdownSec: remainingSec,
    countdown: remainingSec > 0 ? formatCountdown(remainingSec) : "可抢",
    isCooling: remainingSec > 0,
    isReady: remainingSec <= 0
  };
}

function shouldShowCountdownTask(task) {
  if (!task.expiresAt) return true;
  return Date.now() <= task.expiresAt + COUNTDOWN_EXPIRED_GRACE_MS;
}

function renderCountdowns(tasks, timestamp, reason = "local") {
  const visibleTasks = (tasks || [])
    .map(deriveLocalCountdownTask)
    .filter(shouldShowCountdownTask);

  if (visibleTasks.length !== countdownTasks.length) {
    countdownTasks = visibleTasks;
  }

  if (!visibleTasks.length) {
    countdownList.innerHTML = '<p class="countdownEmpty">正在同步任务倒计时（请保持灯塔任务广场页面打开）</p>';
    countdownSyncTime.textContent = reason === "bootstrap" ? `同步中 ${countdownBootstrapAttempts}s` : "--";
    return;
  }

  const age = Date.now() - (timestamp || 0);
  countdownSyncTime.textContent = reason === "local"
    ? `${selectedCountdownTask ? "已选 · " : ""}本地 ${Math.floor(age / 1000)}s`
    : reason === "bootstrap"
      ? "启动同步"
      : "已校准";

  renderedCountdownTasks = visibleTasks;
  countdownList.innerHTML = visibleTasks.map((task, index) => {
    const statusClass = task.isBlocked ? "blocked" : task.isCooling ? "cooling" : task.isReady ? "ready" : "unknown";
    const bountyColor = task.bounty >= 1 ? "bountyHigh" : task.bounty >= 0.5 ? "bountyMid" : "bountyLow";
    const countdownText = task.isBlocked ? "不可接" : task.isCooling ? (task.countdown || "冷却中") : task.isReady ? "可做" : "待确认";
    const tweetUrl = normalizeTweetUrl(task.tweetUrl);
    const taskKey = buildCountdownSelectionKey(task);
    const selectedClass = taskKey && taskKey === selectedCountdownKey ? " isSelected" : "";
    const clickableClass = " isSelectable" + (tweetUrl ? " hasTweetUrl" : "");
    const tweetTitle = tweetUrl ? ` · 已有推文链接 ${tweetUrl}` : "";
    const taskAttrs = ` data-countdown-index="${index}" role="button" tabindex="0" title="选择任务${escapeHtml(tweetTitle)}"`;
    const linkBadge = tweetUrl ? '<span class="cdLink">X</span>' : "";
    const progressHTML = task.progress > 0
      ? `<div class="cdProgress" title="进度 ${task.progress}%"><div class="cdProgressBar" style="width:${task.progress}%"></div></div>`
      : "";
    const title = task.title ? escapeHtml(task.title) : "";
    return `
      <div class="cdItem ${statusClass}${clickableClass}${selectedClass}"${taskAttrs}>
        <span class="cdBounty ${bountyColor}">${task.bounty}L</span>
        <span class="cdType">${task.taskType}</span>
        <span class="cdTimer">${countdownText}</span>
        <span class="cdTitle" title="${title}">${title}</span>
        ${linkBadge}
        ${progressHTML}
      </div>
    `;
  }).join("");
}

function selectCountdownTask(task) {
  if (panelPaused) return;
  selectedCountdownTask = { ...task };
  selectedCountdownKey = buildCountdownSelectionKey(task);
  renderCountdowns(countdownTasks, countdownSyncedAt, "local");
}

function resolveSelectedCountdownTask() {
  // Selection stores identity only. A refreshed list replaces availability;
  // an expired snapshot must never resurrect a removed or postponed task.
  const key = selectedCountdownKey || (selectedCountdownTask && buildCountdownSelectionKey(selectedCountdownTask));
  if (!key) return null;
  const found = [...renderedCountdownTasks, ...countdownTasks]
    .find(task => buildCountdownSelectionKey(task) === key);
  if (!found) return null;
  selectedCountdownTask = { ...found };
  return deriveLocalCountdownTask(found);
}

function buildCountdownSelectionKey(task) {
  if (task.selectionId) return task.selectionId;
  return [
    task.taskType || "任务",
    Number(task.bounty || 0).toFixed(2),
    String(task.title || "").slice(0, 80),
    normalizeTweetUrl(task.tweetUrl || "")
  ].join("|");
}

function normalizeTweetUrl(url) {
  const match = String(url || "").match(/https:\/\/(?:x|twitter)\.com\/[A-Za-z0-9_]+\/status\/\d+/i);
  return match ? match[0].replace("twitter.com", "x.com") : "";
}

function formatCountdown(seconds) {
  const total = Math.max(0, Math.ceil(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}小时${m}分${s}秒`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
