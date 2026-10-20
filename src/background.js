importScripts("reply-engine.js");

const LIGHTHOUSE_CAMPAIGNS_URL = "https://app.lhdao.top/campaigns";
const DEBUG_PAGE_URL = chrome.runtime.getURL("src/debug/debug.html");
const AUTO_RUN_STATE_KEY = "lighthouseAutoRunStateV1";
// MV3 service workers die after ~30s without extension API traffic, which is
// exactly what happens during long plaza cooldown waits (the Lighthouse tab is
// usually hidden, so its 15s status reports get throttled past the idle timer).
// A 30s alarm keeps the worker alive and, if it died anyway, resumes a safe
// auto run on the next tick.
const AUTO_RUN_KEEPALIVE_ALARM = "lighthouseAutoRunKeepaliveV1";
const CAMPAIGNS_IDLE_RELOAD_ALARM = "lighthouseCampaignsIdleReloadV1";
const SITE_X_OPEN_WAIT_MS = 5000;
const LIGHTHOUSE_PREVIOUS_DEFAULT_AI_SYSTEM_PROMPT = "根据原推文写一句自然的中文回复。像真实用户刷到后随手留下的感受，简短、有一点具体反应，不必完整表达观点。10到15个汉字为主，可保留必要的英文词。避免宣传腔、总结腔、夸张吹捧、复述原文和模板化感叹。只输出回复。";
const LIGHTHOUSE_DEFAULT_AI_SYSTEM_PROMPT = "根据原推文写一句自然的中文回复。像真实用户刷到后随手留下的感受，简短、有一点具体反应，不必完整表达观点。5到20个汉字为主，可保留必要的英文词。避免宣传腔、总结腔、夸张吹捧、复述原文和模板化感叹。只输出回复。";
const MONITOR_COUNTDOWN_CACHE_TTL_MS = 25000;
const ATTEMPTED_TASK_DEDUPE_MS = 3 * 60 * 1000;
const MAX_DEFERRED_TASK_DEDUPE_MS = 6 * 60 * 60 * 1000;
const CAMPAIGNS_REFRESH_COOLDOWN_MS = 3 * 60 * 1000;
const CAMPAIGNS_IDLE_REFRESH_MS = 5 * 60 * 1000;
const PERMANENT_IGNORED_TASK_KEYS_KEY = "permanentIgnoredTaskKeysV4";
const REPLY_HISTORY_RECORDS_KEY = "replyHistoryRecords";
const AI_API_KEY_STORAGE_KEY = "lighthouseAiApiKey";
const LIGHTHOUSE_MONITOR_SNAPSHOT_KEY = "lighthouseMonitorSnapshot";
const MAX_REPLY_HISTORY_RECORDS = 200;
const DEFAULT_MONITOR_APPEAR_TEMPLATE = "牛叔快醒醒，来活了，{bounty}刀的{taskType}任务，{status}";
const DEFAULT_MONITOR_COUNTDOWN_2M_TEMPLATE = "刚刚那个{bounty}刀的活还剩{countdown}了，你准备一下";
const DEFAULT_MONITOR_COUNTDOWN_1M_TEMPLATE = "别玩了还剩一分钟了，快准备抢任务！";
const DEFAULT_MIMO_BASE_URL = "https://api.xiaomimimo.com/v1";
const DEFAULT_MIMO_API_KEY = "";

const DEFAULT_SETTINGS = {
  settingsVersion: 14,
  runMode: "debug",
  actionDelayMs: 1200,
  lockSeatTimeoutMs: 60000,
  autoSubmitLighthouse: true,
  autoMinTaskBounty: 0.1,
  maxTasksPerRun: 9999,
  maxTaskAttempts: 9999,
  enableCooldownSniping: true,
  maxCooldownWaitMs: 600000,
  cooldownPollMs: 500,
  replyMode: "post",
  replyProvider: "native",
  readingSimulationMs: 4000,
  aiProvider: "openai",
  aiModel: "gpt-6.1-sol",
  aiApiUrl: "https://api.vayne.cc.cd/v1/responses",
  aiApiKey: "",
  aiSystemPrompt: LIGHTHOUSE_DEFAULT_AI_SYSTEM_PROMPT,
  runWindowEnabled: false,
  runWindowStart: "11:00",
  runWindowEnd: "01:00"
};

const DEFAULT_MONITOR_SETTINGS = {
  enabled: true,
  minBounty: 0.5,
  voiceEnabled: true,
  voiceEngine: "mimo",
  voiceName: "冰糖",
  voiceRate: 0.9,
  voicePitch: 1.0,
  voiceTemplateAppear: DEFAULT_MONITOR_APPEAR_TEMPLATE,
  voiceTemplateCountdown2m: DEFAULT_MONITOR_COUNTDOWN_2M_TEMPLATE,
  voiceTemplateCountdown1m: DEFAULT_MONITOR_COUNTDOWN_1M_TEMPLATE,
  mimoBaseUrl: DEFAULT_MIMO_BASE_URL,
  mimoApiKey: DEFAULT_MIMO_API_KEY
};

let runIdSequence = 0;
let runtimeState = createInitialState();
const runtimeStateReady = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).then(restoreAutoRunState);
const activeAIRequests = new Set();
const activeTabActions = new Set();
let monitorCountdowns = { tasks: [], timestamp: 0 };
let lastXTaskWidgetNotifyAt = 0;
let lastCampaignsRefreshAt = 0;
let monitorSnapshotPromise = null;
let permanentIgnoredTaskKeysLoaded = false;
let permanentIgnoredTaskKeysCache = new Set();
let lighthouseMonitorLastWriteAt = 0;
let lighthouseMonitorPendingTimer = null;
let capturedTargetRecoveryPromise = null;
let directTweetOpenPromise = null;
let selectedStartInFlight = false;
let manualDebugCommandTail = Promise.resolve();
let manualDebugCommandEpoch = 0;
let manualStopPromise = null;
let alertPauseRevision = 0;
let claimReconciliation = null;
let lastClaimReconciliation = { intent: null, at: 0 };
let settingsOperationTail = Promise.resolve();
let settingsOperationRevision = 0;

async function buildLighthouseMonitorSnapshot(reason = "update") {
  const task = runtimeState.currentTask || {};
  const latestLog = Array.isArray(runtimeState.logs) ? runtimeState.logs[0] : null;
  const countdownTask = Array.isArray(monitorCountdowns.tasks) ? monitorCountdowns.tasks[0] : null;
  let todayOrders = 0;
  let todayIncome = 0;
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const records = await getReplyHistoryRecords();
    for (const record of records) {
      const createdAt = new Date(record.createdAt || 0).getTime();
      if (!Number.isFinite(createdAt) || createdAt < todayStart.getTime()) continue;
      todayOrders += 1;
      todayIncome += Number(record.bounty || 0) || 0;
    }
  } catch (_) {
    todayOrders = 0;
    todayIncome = 0;
  }
  return {
    module: "lighthouse",
    name: "灯塔",
    version: chrome.runtime.getManifest()?.version || "",
    status: runtimeState.running ? "running" : "idle",
    stage: runtimeState.stage || "idle",
    mode: runtimeState.mode || "idle",
    message: latestLog?.text || runtimeState.stage || "空闲",
    currentTask: {
      bounty: task.bounty || "",
      taskType: task.taskType || "",
      title: task.candidateTitle || task.title || task.text || "",
      handle: task.handle || task.author || "",
      tweetUrl: task.tweetUrl || task.url || ""
    },
    completed: runtimeState.completed || 0,
    failed: runtimeState.failed || 0,
    attempts: runtimeState.attempts || 0,
    todayOrders,
    todayIncome: Number(todayIncome.toFixed(4)),
    logs: (Array.isArray(runtimeState.logs) ? runtimeState.logs : []).slice(0, 5),
    scheduledResumeAt: runtimeState.scheduledResumeAt || 0,
    countdownCount: Array.isArray(monitorCountdowns.tasks) ? monitorCountdowns.tasks.length : 0,
    nextCountdown: countdownTask || null,
    updatedAt: Date.now(),
    reason
  };
}

async function writeLighthouseMonitorSnapshot(reason = "update") {
  const snapshotState = runtimeState;
  const snapshotRunId = runtimeState.runId;
  try {
    const snapshot = await buildLighthouseMonitorSnapshot(reason);
    if (runtimeState !== snapshotState || runtimeState.runId !== snapshotRunId) return;
    chrome.storage.local.set({ [LIGHTHOUSE_MONITOR_SNAPSHOT_KEY]: snapshot }, () => {
      void chrome.runtime.lastError;
    });
  } catch (_) {
    // Monitoring snapshots must never interrupt the automation flow.
  }
}

function publishLighthouseMonitorSnapshot(reason = "update", options = {}) {
  const now = Date.now();
  const elapsed = now - lighthouseMonitorLastWriteAt;
  if (options.force || elapsed >= 1000) {
    lighthouseMonitorLastWriteAt = now;
    if (lighthouseMonitorPendingTimer) {
      clearTimeout(lighthouseMonitorPendingTimer);
      lighthouseMonitorPendingTimer = null;
    }
    writeLighthouseMonitorSnapshot(reason);
    return;
  }
  if (lighthouseMonitorPendingTimer) return;
  lighthouseMonitorPendingTimer = setTimeout(() => {
    lighthouseMonitorPendingTimer = null;
    lighthouseMonitorLastWriteAt = Date.now();
    writeLighthouseMonitorSnapshot(reason);
  }, 1000 - elapsed);
}

void runtimeStateReady.then(() => {
  if (!runtimeState.manuallyStopped) publishLighthouseMonitorSnapshot("startup", { force: true });
});

chrome.runtime.onInstalled.addListener(async () => {
  await runtimeStateReady;
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
  await getSettings();
  const stored = await chrome.storage.local.get(["monitorSettings"]);
  if (!stored.monitorSettings) {
    await chrome.storage.local.set({ monitorSettings: DEFAULT_MONITOR_SETTINGS });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_RUN_KEEPALIVE_ALARM || alarm.name === CAMPAIGNS_IDLE_RELOAD_ALARM) {
    const alarmState = runtimeState;
    void handleAutoRunKeepaliveTick().catch((error) => {
      if (runtimeState !== alarmState) return;
      log("error", `Lighthouse 保活检查失败：${error.message || String(error)}`);
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isAuthorizedMessage(message, sender)) {
    sendResponse({ ok: false, error: "消息来源无权执行此操作" });
    return false;
  }
  const messageState = runtimeState;
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      if (runtimeState === messageState) log("error", error.message || String(error));
      sendResponse({ ok: false, error: error.message || String(error), state: runtimeState });
    });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === runtimeState.xTabId) {
    runtimeState.xTabId = null;
    setStage("x_closed");
    log("info", "X 标签页已关闭");
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  recordPotentialLighthouseOpenedXTab(tab, true);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== "loading" && tab.status !== "complete") return;
  recordPotentialLighthouseOpenedXTab(tab || { id: tabId, url: changeInfo.url });
});

async function handleMessage(message, sender) {
  await runtimeStateReady;
  if (!message || !message.type) return { ok: false, error: "Missing message type" };
  const manualStep = /^DEBUG_(?:OPEN_CAMPAIGNS|OPEN_FIRST_TASK|LOCK_SEAT_OPEN_TWEET|RUN_X_REPLY|FAST_X_CLAIM_REPLY_VERIFY|COMPLETE_X_TASK_WIDGET|WAIT_LIGHTHOUSE_COMPLETION_RETURN|CLOSE_X_RETURN_LIGHTHOUSE|CLICK_DONE|RETURN_CAMPAIGNS)$/.test(message.type);
  if (runtimeState.manuallyStopped && (["START_RUN", "RUN_SELECTED_COUNTDOWN_TASK"].includes(message.type) || manualStep) && !message.expectedRunId && manualStopPromise) {
    const requestedEpoch = manualDebugCommandEpoch;
    await manualStopPromise;
    if (requestedEpoch !== manualDebugCommandEpoch) return { ok: false, cancelled: true, state: runtimeState };
  }
  if (runtimeState.manuallyStopped && !["START_RUN", "RUN_SELECTED_COUNTDOWN_TASK", "STOP_RUN", "GET_STATE", "GET_CONTENT_SETTINGS", "GET_REPLY_RECORDS", "SAVE_SETTINGS", "CLEAR_REPLY_RECORDS", "OPEN_DEBUG_PAGE", "MONITOR_GET_COUNTDOWNS", "MONITOR_GET_STATUS", "MONITOR_GET_SETTINGS", "MONITOR_MIGRATE_SETTINGS", "MONITOR_SET_ENABLED", "MONITOR_SET_THRESHOLD", "MONITOR_SET_VOICE"].includes(message.type) && !manualStep) {
    return { ok: true, ignored: true, paused: true };
  }
  if (runtimeState.manuallyStopped && message.type === "MONITOR_GET_COUNTDOWNS") {
    return { ok: true, paused: true, tasks: [], timestamp: 0 };
  }
  const messageWindowId = getMessageWindowId(message, sender);
  if (message.type === "RUN_SELECTED_COUNTDOWN_TASK") {
    if (message.selectedTask && !selectedStartInFlight) manualDebugCommandEpoch += 1;
    return startSelectedCountdownTask(message.selectedTask, messageWindowId);
  }
  if ([
    "DEBUG_OPEN_CAMPAIGNS",
    "DEBUG_OPEN_FIRST_TASK",
    "DEBUG_LOCK_SEAT_OPEN_TWEET",
    "DEBUG_RUN_X_REPLY",
    "DEBUG_FAST_X_CLAIM_REPLY_VERIFY",
    "DEBUG_COMPLETE_X_TASK_WIDGET",
    "DEBUG_WAIT_LIGHTHOUSE_COMPLETION_RETURN",
    "DEBUG_CLOSE_X_RETURN_LIGHTHOUSE",
    "DEBUG_CLICK_DONE",
    "DEBUG_RETURN_CAMPAIGNS"
  ].includes(message.type)) {
    return enqueueManualDebugCommand(message, messageWindowId);
  }
  if (runtimeState.running && runtimeState.mode !== "debug" && (message.type.startsWith("DEBUG_") && message.type !== "DEBUG_TASK_CANDIDATE"
      || message.type === "START_RUN")) {
    return { ok: false, error: "当前流程仍在执行，请勿同时启动调试或另一轮任务", state: runtimeState };
  }
  // Automatic orchestration consumes direct responses, never duplicate legacy events.
  if (["auto", "selected_once"].includes(runtimeState.mode) && ["LIGHTHOUSE_TASK_READY", "X_REPLY_RESULT", "LIGHTHOUSE_TASK_DONE"].includes(message.type)) {
    return { ok: true, ignored: true };
  }
  if (isWindowScopedCommand(message.type)) {
    const lockResult = lockRuntimeWindowForCommand(messageWindowId, message.type);
    if (!lockResult.ok) return { ok: false, error: lockResult.error, state: runtimeState };
  }

  switch (message.type) {
    case "GET_STATE":
      if (sender?.tab && !String(sender.url || "").startsWith("chrome-extension://")) return { ok: false, error: "完整设置仅限扩展界面访问" };
      if (!runtimeState.running && runtimeState.uncertainAction) await reconcileStoppedClaim();
      return { ok: true, state: runtimeState, settings: await getSettings() };
    case "GET_CONTENT_SETTINGS":
      return { ok: true, settings: { autoMinTaskBounty: (await getSettings()).autoMinTaskBounty }, paused: Boolean(runtimeState.manuallyStopped) };
    case "LIGHTHOUSE_CLAIM_CHECKPOINT":
      return recordLighthouseClaimCheckpoint(message, sender);
    case "SAVE_SETTINGS": {
      const savingState = runtimeState;
      const savingRunId = runtimeState.runId;
      const ownsSave = () => runtimeState === savingState && runtimeState.runId === savingRunId;
      const settings = await saveSettingsToStorage(message.settings);
      if (ownsSave() && runtimeState.running && runtimeState.mode === "auto" && runtimeState.stage === "auto_waiting_schedule") {
        await reconcileWaitingAutoRunSchedule();
      }
      if (ownsSave()) log("info", "配置已保存");
      return { ok: true, settings, state: runtimeState };
    }
    case "GET_REPLY_RECORDS":
      return { ok: true, records: await getReplyHistoryRecords() };
    case "QUERY_TWEET_REPLY_HISTORY":
      return queryTweetReplyHistory(message.tweet, message.task);
    case "CLEAR_REPLY_RECORDS":
      await chrome.storage.local.set({ [REPLY_HISTORY_RECORDS_KEY]: [] });
      log("warn", "已清空回复记录");
      return { ok: true, records: [], state: runtimeState };
    case "OPEN_DEBUG_PAGE":
      return openDebugPage(messageWindowId);
    case "START_RUN":
      manualDebugCommandEpoch += 1;
      return startAutoRun(message.options || {}, messageWindowId, true);
    case "STOP_RUN": {
      const operation = stopAndClearRun();
      manualStopPromise = operation;
      try { return await operation; }
      finally { if (manualStopPromise === operation) manualStopPromise = null; }
    }
    case "DEBUG_TASK_CANDIDATE":
      if (!isCurrentRunMessage(message)) return { ok: true, state: runtimeState };
      runtimeState.currentTask = message.task || runtimeState.currentTask;
      log("info", "已暂存任务候选信息");
      return { ok: true, state: runtimeState };
    case "GENERATE_AI_REPLY":
      if (!message.runId || message.runId !== runtimeState.runId || !runtimeState.running) return { ok: false, error: "旧任务已停止，取消生成" };
      return generateAIReplyForTweet(message.tweet, message.task, message.runId);
    case "LIGHTHOUSE_TASK_READY":
      if (!isCurrentRunMessage(message)) return { ok: true, state: runtimeState };
      markAttemptedTask(message.task);
      return adoptTargetOpenedTweet(message.task, sender.tab && sender.tab.id, "auto");
    case "LIGHTHOUSE_TARGET_TWEET_URL": {
      if (!isCurrentRunMessage(message)) return { ok: true, state: runtimeState };
      const tweetUrl = normalizeTweetUrl(message.tweetUrl);
      if (!tweetUrl) return { ok: false, error: "Lighthouse 回传的目标 X 地址无效", state: runtimeState };
      runtimeState.currentTask = mergeTaskPreservingCapturedTweetUrl(runtimeState.currentTask, null, {
        tweetUrl,
        targetUrlCapturedAt: new Date().toISOString(),
        targetUrlSource: "lighthouse_window_open"
      });
      log("info", `已捕获 Lighthouse 任务目标 X：${tweetUrl}`);
      await recoverPendingXOpenFromCapturedUrl(tweetUrl);
      return { ok: true, state: runtimeState };
    }
    case "X_REPLY_RESULT":
      return handleXReplyResult(message.result, message);
    case "LIGHTHOUSE_TASK_DONE":
      if (!isCurrentRunMessage(message)) return { ok: true, state: runtimeState };
      return handleLighthouseDone(message.result);
    case "CONTENT_LOG":
      if (message.runId && runtimeState.runId && message.runId !== runtimeState.runId) {
        return { ok: true, state: runtimeState };
      }
      if (message.page) {
        runtimeState.lighthousePage = message.page;
      }
      if (shouldSuppressContradictoryContentLog(message)) {
        return { ok: true, state: runtimeState };
      }
      log(message.level || "info", message.text || "", {
        source: "lighthouse",
        page: message.page || null
      });
      return { ok: true, state: runtimeState };
    case "X_TASK_WIDGET_HINT":
      return handleXTaskWidgetHint(message, sender);
    case "HIGH_BOUNTY_ALERT": {
      const isCurrent = captureRunGuard();
      try {
        chrome.notifications.create(`bounty-${message.bounty}-${Date.now()}`, {
          type: "basic",
          iconUrl: "src/assets/icons/icon128.png",
          title: `🚨 高赏金任务 ${message.bounty} LUX`,
          message: (message.text || "").slice(0, 200),
          priority: 2,
          requireInteraction: true
        });
      } catch (_) {}
      const monitorSettings = await getMonitorSettings();
      if (!isCurrent()) return { ok: true, ignored: true };
      const speechText = buildMonitorSpeechText(message.speechData || {}, monitorSettings, message.voiceText || message.text || "");
      await forwardPanelSpeech(speechText, monitorSettings);
      if (!isCurrent()) return { ok: true, ignored: true };
      log("info", `高赏金警报：${message.bounty} LUX`);
      return { ok: true, state: runtimeState };
    }
    case "MONITOR_COUNTDOWN_SYNC":
      {
        const incomingTasks = Array.isArray(message.tasks) ? message.tasks : [];
        const cacheAge = Date.now() - (monitorCountdowns.timestamp || 0);
        if (incomingTasks.length > 0 || monitorCountdowns.tasks.length === 0 || cacheAge > MONITOR_COUNTDOWN_CACHE_TTL_MS) {
          monitorCountdowns = { tasks: incomingTasks, timestamp: message.timestamp || Date.now() };
        }
      }
      publishLighthouseMonitorSnapshot("countdown", { force: true });
      return { ok: true };
    case "MONITOR_GET_COUNTDOWNS":
      return getMonitorCountdowns(messageWindowId);
    case "MONITOR_GET_STATUS": {
      const monitorSettings = await getMonitorSettings();
      return { ok: true, ...toPublicMonitorSettings(monitorSettings), paused: Boolean(runtimeState.manuallyStopped), seenCount: message.seenCount || 0 };
    }
    case "MONITOR_GET_SETTINGS": {
      const monitorSettings = await getMonitorSettings();
      return { ok: true, ...monitorSettings };
    }
    case "MONITOR_MIGRATE_SETTINGS": {
      const monitorSettings = await migrateMonitorSettings(message.settings);
      await broadcastMonitorMessage({ type: "MONITOR_APPLY_SETTINGS", settings: toPublicMonitorSettings(monitorSettings) });
      return { ok: true, ...toPublicMonitorSettings(monitorSettings) };
    }
    case "MONITOR_SET_ENABLED": {
      const monitorSettings = await updateMonitorSettings({ enabled: Boolean(message.enabled) });
      await broadcastMonitorMessage({ type: "MONITOR_APPLY_SETTINGS", settings: toPublicMonitorSettings(monitorSettings) });
      return { ok: true, ...monitorSettings };
    }
    case "MONITOR_SET_THRESHOLD": {
      const monitorSettings = await updateMonitorSettings({ minBounty: message.minBounty });
      await broadcastMonitorMessage({ type: "MONITOR_APPLY_SETTINGS", settings: toPublicMonitorSettings(monitorSettings) });
      return { ok: true, ...monitorSettings };
    }
    case "MONITOR_SET_VOICE": {
      const monitorSettings = await updateMonitorSettings({
        voiceEnabled: Boolean(message.voiceEnabled),
        voiceEngine: message.voiceEngine,
        voiceName: message.voiceName,
        voiceRate: message.rate,
        voicePitch: message.pitch,
        voiceTemplateAppear: message.templateAppear,
        voiceTemplateCountdown2m: message.templateCountdown2m,
        voiceTemplateCountdown1m: message.templateCountdown1m,
        mimoBaseUrl: message.mimoBaseUrl,
        mimoApiKey: message.mimoApiKey
      });
      await broadcastMonitorMessage({ type: "MONITOR_APPLY_SETTINGS", settings: toPublicMonitorSettings(monitorSettings) });
      return { ok: true, ...monitorSettings };
    }
    case "MONITOR_TEST_VOICE": {
      const monitorSettings = await getMonitorSettings();
      const testData = {
        bounty: "5",
        status: "当前可做",
        taskType: "评论",
        title: "语音测试",
        countdown: "3分20秒",
        milestone: ""
      };
      await forwardPanelSpeech(buildMonitorSpeechText(testData, monitorSettings), monitorSettings);
      return { ok: true, state: runtimeState };
    }
    case "MONITOR_SPEAK_TEXT": {
      const monitorSettings = await getMonitorSettings();
      await forwardPanelSpeech(message.text || "", monitorSettings);
      return { ok: true, state: runtimeState };
    }
    case "MONITOR_CLEAR_SEEN": {
      await broadcastMonitorMessage(message);
      return { ok: true, state: runtimeState };
    }
    default:
      return { ok: false, error: `Unknown message type: ${message.type}` };
  }
}

function isAuthorizedMessage(message, sender) {
  if (sender?.id !== chrome.runtime.id) return false;
  if (String(sender.url || "").startsWith(chrome.runtime.getURL(""))) return true;
  if (!Number.isInteger(sender?.tab?.id) || (sender.frameId ?? 0) !== 0) return false;
  const url = String(sender.url || "");
  if (/^https:\/\/(?:x|twitter)\.com\//.test(url)) {
    return ["GET_CONTENT_SETTINGS", "GENERATE_AI_REPLY", "QUERY_TWEET_REPLY_HISTORY", "X_TASK_WIDGET_HINT", "X_REPLY_RESULT"].includes(message?.type);
  }
  if (/^https:\/\/app\.lhdao\.top\//.test(url)) {
    return ["GET_CONTENT_SETTINGS", "LIGHTHOUSE_CLAIM_CHECKPOINT", "CONTENT_LOG", "DEBUG_TASK_CANDIDATE", "LIGHTHOUSE_TARGET_TWEET_URL", "LIGHTHOUSE_TASK_READY", "LIGHTHOUSE_TASK_DONE", "HIGH_BOUNTY_ALERT", "MONITOR_COUNTDOWN_SYNC", "MONITOR_GET_STATUS", "MONITOR_MIGRATE_SETTINGS"].includes(message?.type);
  }
  return false;
}

function getMessageWindowId(message, sender) {
  const senderWindowId = sender?.tab?.windowId;
  if (Number.isInteger(senderWindowId)) return senderWindowId;
  const clientWindowId = Number(message?.clientWindowId);
  return Number.isInteger(clientWindowId) ? clientWindowId : null;
}

function isWindowScopedCommand(type) {
  return [
    "START_RUN",
    "RUN_SELECTED_COUNTDOWN_TASK",
    "DEBUG_OPEN_CAMPAIGNS",
    "DEBUG_OPEN_FIRST_TASK",
    "DEBUG_LOCK_SEAT_OPEN_TWEET",
    "DEBUG_RUN_X_REPLY",
    "DEBUG_FAST_X_CLAIM_REPLY_VERIFY",
    "DEBUG_COMPLETE_X_TASK_WIDGET",
    "DEBUG_WAIT_LIGHTHOUSE_COMPLETION_RETURN",
    "DEBUG_CLOSE_X_RETURN_LIGHTHOUSE",
    "DEBUG_CLICK_DONE",
    "DEBUG_RETURN_CAMPAIGNS",
    "LIGHTHOUSE_TASK_READY",
    "MONITOR_GET_COUNTDOWNS"
  ].includes(type);
}

async function stopAndClearRun() {
  const previousRun = runtimeState;
  const stopEpoch = ++manualDebugCommandEpoch;
  runtimeState = {
    ...createInitialState(),
    // Keep the cancellation target until its acknowledgements settle.
    runId: previousRun.runId,
    stopEpoch: Number(previousRun.stopEpoch || 0) + 1,
    manuallyStopped: true,
    stage: "stopped",
    logs: [{ at: new Date().toISOString(), level: "warn", text: "已停止运行", source: "background", pagePhase: "" }]
  };
  const stoppingState = runtimeState;
  const ownsStop = () => runtimeState === stoppingState && manualDebugCommandEpoch === stopEpoch;
  manualDebugCommandTail = Promise.resolve();
  monitorCountdowns = { tasks: [], timestamp: 0 };
  monitorSnapshotPromise = null;
  capturedTargetRecoveryPromise = null;
  directTweetOpenPromise = null;
  selectedStartInFlight = false;
  lastXTaskWidgetNotifyAt = 0;
  lastCampaignsRefreshAt = 0;
  if (lighthouseMonitorPendingTimer) clearTimeout(lighthouseMonitorPendingTimer);
  lighthouseMonitorPendingTimer = null;
  const cancellation = cancelSupersededLighthouseRun(previousRun, true);
  await persistAutoRunState(true);
  await cancellation;
  if (!ownsStop()) return { ok: false, cancelled: true, state: runtimeState };
  await clearAutoRunResumeSchedule();
  if (!ownsStop()) return { ok: false, cancelled: true, state: runtimeState };
  await clearAutoRunKeepalive();
  if (!ownsStop()) return { ok: false, cancelled: true, state: runtimeState };
  await clearCampaignsIdleReloadAlarm();
  if (!ownsStop()) return { ok: false, cancelled: true, state: runtimeState };
  await broadcastAutomationPause(true, ownsStop, [previousRun.lighthouseTabId, previousRun.xTabId, previousRun.uncertainAction?.tabId]);
  if (!ownsStop()) return { ok: false, cancelled: true, state: runtimeState };
  runtimeState.runId = createRunId();
  await persistAutoRunState(true);
  if (ownsStop()) publishLighthouseMonitorSnapshot("stopped", { force: true });
  return { ok: true, state: runtimeState };
}

async function broadcastAutomationPause(paused, isCurrent, alreadyCancelled = []) {
  const message = { type: "AUTOMATION_PAUSE_CHANGED", paused };
  try { if (isCurrent()) await chrome.runtime.sendMessage(message); } catch (_) {}
  if (!isCurrent()) return;
  try {
    let timer;
    let tabs;
    try {
      tabs = await Promise.race([
        chrome.tabs.query({ url: ["https://app.lhdao.top/*", "https://x.com/*", "https://twitter.com/*"] }),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), 1000); })
      ]);
    } finally { clearTimeout(timer); }
    if (!isCurrent() || !tabs) return;
    await Promise.all(tabs.filter(tab => !alreadyCancelled.includes(tab.id)).map(async tab => {
      if (!isCurrent()) return;
      if (paused && isLighthouseUrl(tab.url)) pauseLighthouseAlertBridge(tab.id);
      try { await chrome.tabs.sendMessage(tab.id, message); } catch (_) {}
    }));
  } catch (_) {}
}

async function resumeAfterManualStop(isCurrent) {
  if (!isCurrent()) return false;
  if (!runtimeState.manuallyStopped) return true;
  runtimeState.manuallyStopped = false;
  await persistAutoRunState(true);
  if (!isCurrent()) return false;
  await broadcastAutomationPause(false, isCurrent);
  return isCurrent();
}

async function prepareDebugRunForCommand(windowId, commandType, commandEpoch = manualDebugCommandEpoch) {
  const takeoverState = runtimeState;
  const previousRunId = runtimeState.runId;
  const isCurrent = () => runtimeState === takeoverState && runtimeState.runId === previousRunId && manualDebugCommandEpoch === commandEpoch;
  const cancelled = () => ({ ok: false, cancelled: true, error: "单步接管已取消，旧流程不会继续", state: runtimeState });
  if (!isCurrent()) return cancelled();
  if (runtimeState.running && runtimeState.mode === "debug" && !runtimeState.uncertainAction) {
    setRuntimeWindow(windowId);
    return { ok: true, runId: runtimeState.runId, state: runtimeState };
  }

  const previousMode = runtimeState.mode || "idle";
  if (runtimeState.running || runtimeState.uncertainAction) {
    await cancelCurrentRun(isCurrent);
    if (!isCurrent()) return cancelled();
  }
  await clearAutoRunResumeSchedule();
  if (!isCurrent()) return cancelled();
  await clearAutoRunKeepalive();
  if (!isCurrent()) return cancelled();
  await clearCampaignsIdleReloadAlarm();
  if (!isCurrent()) return cancelled();
  if (runtimeState.uncertainAction) {
    runtimeState.running = false;
    setStage("manual_takeover_blocked");
    const error = `单步接管未执行：旧动作 ${runtimeState.uncertainAction.type || "未知动作"} 尚未取得未点击/未接单的确认，已保留订单，请先核对本单`;
    log("warn", error);
    return { ok: false, uncertain: true, error, state: runtimeState };
  }
  if (runtimeState.manuallyStopped && !await resumeAfterManualStop(isCurrent)) return cancelled();
  runtimeState.running = true;
  runtimeState.mode = "debug";
  runtimeState.runId = createRunId();
  runtimeState.scheduledResumeAt = 0;
  setRuntimeWindow(windowId);
  setStage("debug_takeover");
  log("info", `单步控制已接管 ${previousMode} 流程：${commandType}`);
  return { ok: true, runId: runtimeState.runId, state: runtimeState };
}

function enqueueManualDebugCommand(message, windowId) {
  const commandEpoch = manualDebugCommandEpoch;
  const operation = manualDebugCommandTail.then(async () => {
    if (commandEpoch !== manualDebugCommandEpoch
      || (message.expectedRunId && (message.expectedRunId !== runtimeState.runId || !runtimeState.running || runtimeState.mode !== "debug"))) {
      return { ok: false, cancelled: true, error: "旧单步队列已失效", state: runtimeState };
    }
    const result = await runManualDebugCommand(message, windowId);
    if (result?.cancelled && commandEpoch === manualDebugCommandEpoch) manualDebugCommandEpoch += 1;
    return result;
  });
  manualDebugCommandTail = operation.catch(() => {});
  return operation;
}

async function runManualDebugCommand(message, windowId) {
  if (!runtimeState.running && runtimeState.uncertainAction) await reconcileStoppedClaim(true);
  if (runtimeState.currentTask?.claimReconciled && hasLatchedLighthouseCompletion(runtimeState.runId)
      && ["DEBUG_RUN_X_REPLY", "DEBUG_LOCK_SEAT_OPEN_TWEET", "DEBUG_COMPLETE_X_TASK_WIDGET", "DEBUG_CLICK_DONE"].includes(message.type)) {
    return { ok: false, error: "本单已确认完成，请返回任务广场或启动全量检测，无需再次评论或提交", state: runtimeState };
  }
  if (message.expectedRunId && (message.expectedRunId !== runtimeState.runId || !runtimeState.running || runtimeState.mode !== "debug")) {
    return { ok: false, cancelled: true, error: "旧单步队列已失效", state: runtimeState };
  }
  if (["DEBUG_OPEN_CAMPAIGNS", "DEBUG_OPEN_FIRST_TASK", "DEBUG_FAST_X_CLAIM_REPLY_VERIFY"].includes(message.type)
      && ((runtimeState.currentTask?.invitationAccepted || runtimeState.currentTask?.seatLocked || runtimeState.currentTask?.seatLockedAt || runtimeState.currentTask?.claimed)
        && !hasLatchedLighthouseCompletion(runtimeState.completionEvidence?.runId))) {
    return { ok: false, error: "旧订单尚未核对，不能接管或打开另一任务", state: runtimeState };
  }
  const lockResult = lockRuntimeWindowForCommand(windowId, message.type);
  if (!lockResult.ok) {
    return { ok: false, error: lockResult.error, state: runtimeState };
  }
  const prepared = await prepareDebugRunForCommand(windowId, message.type);
  if (!prepared?.ok) return prepared || { ok: false, error: "单步接管未完成", state: runtimeState };
  if (runtimeState !== prepared.state || runtimeState.runId !== prepared.runId || !runtimeState.running) {
    return { ok: false, cancelled: true, error: "单步接管已取消", state: runtimeState };
  }

  switch (message.type) {
    case "DEBUG_OPEN_CAMPAIGNS":
      return debugOpenCampaigns(windowId);
    case "DEBUG_OPEN_FIRST_TASK":
      return debugOpenFirstTask();
    case "DEBUG_LOCK_SEAT_OPEN_TWEET":
      return debugLockSeatAndOpenTweet();
    case "DEBUG_RUN_X_REPLY":
      return debugRunXReply();
    case "DEBUG_FAST_X_CLAIM_REPLY_VERIFY":
      return debugFastXClaimReplyVerify(message.selectedTask, windowId);
    case "DEBUG_COMPLETE_X_TASK_WIDGET":
      return debugCompleteXTaskWidget();
    case "DEBUG_WAIT_LIGHTHOUSE_COMPLETION_RETURN":
      return debugWaitLighthouseCompletionReturn();
    case "DEBUG_CLOSE_X_RETURN_LIGHTHOUSE":
      return debugCloseXReturnLighthouse();
    case "DEBUG_CLICK_DONE":
      return debugClickDone();
    case "DEBUG_RETURN_CAMPAIGNS":
      return debugReturnCampaigns();
    default:
      return { ok: false, error: `未知调试命令：${message.type}`, state: runtimeState };
  }
}

function lockRuntimeWindowForCommand(windowId, commandType) {
  if (!Number.isInteger(windowId)) {
    if (Number.isInteger(getRuntimeWindowId())) return { ok: true };
    return {
      ok: false,
      error: `缺少窗口归属，拒绝执行 ${commandType}`
    };
  }

  const lockedWindowId = getRuntimeWindowId();
  if (Number.isInteger(lockedWindowId) && lockedWindowId !== windowId) {
    if (!runtimeState.running) {
      runtimeState.runtimeWindowId = windowId;
      runtimeState.lighthouseWindowId = null;
      runtimeState.lighthouseTabId = null;
      return { ok: true };
    }
    return {
      ok: false,
      error: `当前流程已锁定 Chrome 窗口 ${lockedWindowId}，拒绝接管窗口 ${windowId}`
    };
  }

  runtimeState.runtimeWindowId = windowId;
  return { ok: true };
}

function getRuntimeWindowId() {
  if (Number.isInteger(runtimeState.lighthouseWindowId)) return runtimeState.lighthouseWindowId;
  if (Number.isInteger(runtimeState.runtimeWindowId)) return runtimeState.runtimeWindowId;
  return null;
}

function setRuntimeWindow(windowId) {
  if (Number.isInteger(windowId)) runtimeState.runtimeWindowId = windowId;
}

async function handleXTaskWidgetHint(message, sender) {
  const isCurrent = captureRunGuard();
  if (!isCurrent()) return { ok: true, ignored: true };
  const senderTabId = sender?.tab?.id;
  const senderWindowId = sender?.tab?.windowId;
  if (!runtimeState.xTabId || senderTabId !== runtimeState.xTabId || !isWindowIdInRuntime(senderWindowId)) {
    return { ok: true, state: runtimeState, ignored: true };
  }

  const state = message.state || {};
  const now = Date.now();
  const isReady = state.kind === "ready";
  const shouldNotify = isReady || state.kind === "soon";
  const cooldownMs = isReady ? 4000 : 10000;
  if (shouldNotify && now - lastXTaskWidgetNotifyAt > cooldownMs) {
    lastXTaskWidgetNotifyAt = now;
    const title = isReady ? "X 页任务控件已可点" : "X 页任务控件即将可点";
    const detail = [state.actionText, state.countdown].filter(Boolean).join(" · ");
    try {
      await chrome.notifications.create(`x-task-widget-${now}`, {
        type: "basic",
        iconUrl: "src/assets/icons/icon128.png",
        title,
        message: detail || message.tweetUrl || "请回到当前推文页手动确认",
        priority: isReady ? 2 : 1,
        requireInteraction: isReady
      });
    } catch (_) {}
    if (!isCurrent()) return { ok: true, ignored: true };
    log("info", `${title}：${detail || message.tweetUrl || ""}`);
  }
  return { ok: true, state: runtimeState };
}

async function forwardPanelSpeech(text, existingSettings = null) {
  const isCurrent = captureRunGuard();
  if (!isCurrent()) return false;
  const value = String(text || "").trim();
  if (!value) return false;
  const monitorSettings = existingSettings || await getMonitorSettings();
  if (!isCurrent()) return false;
  if (!monitorSettings.voiceEnabled) return false;
  try {
    await chrome.runtime.sendMessage({
      type: "PANEL_SPEAK_TEXT",
      runId: runtimeState.runId,
      text: value,
      voiceEngine: monitorSettings.voiceEngine,
      voiceName: monitorSettings.voiceName,
      voiceRate: monitorSettings.voiceRate,
      voicePitch: monitorSettings.voicePitch,
      mimoBaseUrl: monitorSettings.mimoBaseUrl,
      mimoApiKey: monitorSettings.mimoApiKey
    });
    return true;
  } catch (_) {
    return false;
  }
}

function buildMonitorSpeechText(payload, monitorSettings, fallbackText = "") {
  const milestone = String(payload?.milestone ?? "").trim();
  const isCountdown1m = milestone === "还剩1分钟";
  const isCountdown2m = milestone === "还剩2分钟";
  const template = String(
    isCountdown1m
      ? (monitorSettings.voiceTemplateCountdown1m || DEFAULT_MONITOR_COUNTDOWN_1M_TEMPLATE)
      : isCountdown2m
        ? (monitorSettings.voiceTemplateCountdown2m || DEFAULT_MONITOR_COUNTDOWN_2M_TEMPLATE)
        : (monitorSettings.voiceTemplateAppear || DEFAULT_MONITOR_APPEAR_TEMPLATE)
  ).trim();
  const replacements = {
    bounty: String(payload?.bounty ?? "").trim(),
    status: String(payload?.status ?? "").trim(),
    taskType: String(payload?.taskType ?? "").trim(),
    title: String(payload?.title ?? "").trim(),
    countdown: String(payload?.countdown ?? "").trim(),
    milestone: String(payload?.milestone ?? "").trim()
  };
  replacements.milestoneText = replacements.milestone ? `${replacements.milestone}，` : "";
  replacements.titleText = replacements.title ? `，标题${replacements.title}` : "";

  const rendered = template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key) => replacements[key] ?? "");
  const normalized = rendered
    .replace(/，{2,}/g, "，")
    .replace(/^，+|，+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || String(fallbackText || "").trim() || "高赏金任务提醒";
}

function toPublicMonitorSettings(settings) {
  return {
    enabled: settings.enabled,
    minBounty: settings.minBounty,
    voiceEnabled: settings.voiceEnabled,
    voiceEngine: settings.voiceEngine,
    voiceName: settings.voiceName,
    voiceRate: settings.voiceRate,
    voicePitch: settings.voicePitch,
    voiceTemplateAppear: settings.voiceTemplateAppear,
    voiceTemplateCountdown2m: settings.voiceTemplateCountdown2m,
    voiceTemplateCountdown1m: settings.voiceTemplateCountdown1m
  };
}

async function getMonitorCountdowns(preferredWindowId = null) {
  const isCurrent = captureRunGuard();
  const paused = () => ({ ok: true, paused: true, tasks: [], timestamp: 0 });
  if (!isCurrent()) return paused();
  const cacheAge = Date.now() - (monitorCountdowns.timestamp || 0);
  if (monitorCountdowns.tasks.length > 0 && cacheAge < MONITOR_COUNTDOWN_CACHE_TTL_MS) {
    return { ok: true, tasks: monitorCountdowns.tasks, timestamp: monitorCountdowns.timestamp, source: "cache" };
  }

  const snapshot = await requestMonitorCountdownSnapshot(preferredWindowId);
  if (!isCurrent()) return paused();
  if (snapshot?.ok) {
    const snapshotTasks = snapshot.tasks || [];
    if (snapshotTasks.length > 0 || monitorCountdowns.tasks.length === 0) {
      monitorCountdowns = {
        tasks: snapshotTasks,
        timestamp: snapshot.timestamp || Date.now()
      };
    }
  }

  return {
    ok: true,
    tasks: monitorCountdowns.tasks,
    timestamp: monitorCountdowns.timestamp,
    source: snapshot?.ok ? "page_snapshot" : "cache_stale"
  };
}

async function requestMonitorCountdownSnapshot(preferredWindowId = null) {
  const isCurrent = captureRunGuard();
  if (!isCurrent()) return { ok: false, paused: true };
  if (monitorSnapshotPromise) return monitorSnapshotPromise;
  const request = (async () => {
    const tabs = await queryLighthouseTabs(preferredWindowId);
    if (!isCurrent()) return { ok: false, paused: true };
    const activeTabs = tabs.filter((tab) => tab.active);
    const candidates = [...activeTabs, ...tabs].filter((tab, index, arr) => arr.findIndex((item) => item.id === tab.id) === index);
    for (const tab of candidates) {
      try {
        let response = await sendMonitorSnapshotMessage(tab.id);
        if (!isCurrent()) return { ok: false, paused: true };
        if (!response?.ok && await ensureMonitorContentScriptInjected(tab.id, isCurrent)) {
          if (!isCurrent()) return { ok: false, paused: true };
          await delay(500);
          if (!isCurrent()) return { ok: false, paused: true };
          response = await sendMonitorSnapshotMessage(tab.id);
        }
        if (response?.ok) return response;
      } catch (_) {}
    }
    return { ok: false };
  })();
  monitorSnapshotPromise = request;
  try {
    return await request;
  } finally {
    if (monitorSnapshotPromise === request) monitorSnapshotPromise = null;
  }
}

async function sendMonitorSnapshotMessage(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "MONITOR_GET_COUNTDOWNS_SNAPSHOT" });
  } catch (_) {
    return null;
  }
}

async function ensureMonitorContentScriptInjected(tabId, isCurrent = captureRunGuard()) {
  if (!isCurrent()) return false;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isCurrent()) return false;
    if (!isLighthouseUrl(tab.url)) return false;
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content/lighthouse-monitor.js"]
    });
    if (!isCurrent()) return false;
    log("warn", "已为 Lighthouse 页面补注入倒计时监控脚本");
    return true;
  } catch (error) {
    if (!isCurrent()) return false;
    if (/No tab with id|Tab not found/i.test(error?.message || "")) return false;
    log("warn", `补注入倒计时监控脚本失败：${error.message}`);
    return false;
  }
}

async function openDebugPage(windowId = null) {
  const query = { url: DEBUG_PAGE_URL };
  const targetWindowId = Number.isInteger(windowId) ? windowId : getRuntimeWindowId();
  if (Number.isInteger(targetWindowId)) query.windowId = targetWindowId;
  const tabs = await chrome.tabs.query(query);
  if (tabs[0]) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    return { ok: true, state: runtimeState };
  }
  const createProperties = { url: DEBUG_PAGE_URL, active: true };
  if (Number.isInteger(targetWindowId)) createProperties.windowId = targetWindowId;
  await chrome.tabs.create(createProperties);
  return { ok: true, state: runtimeState };
}

async function startAutoRun(options, windowId = null, manualRestart = false) {
  if (manualRestart && !runtimeState.running && runtimeState.uncertainAction) await reconcileStoppedClaim(true);
  if (runtimeState.currentTask?.claimReconciled && !hasLatchedLighthouseCompletion(runtimeState.runId)) {
    if (manualRestart) return resumeReconciledClaim(windowId);
    return { ok: false, error: "已核对本单席位锁定，请从第 4 步接续本单，完成前不能另接新单", state: runtimeState };
  }
  if (runtimeState.manuallyStopped && !manualRestart) return { ok: false, cancelled: true, error: "已手动停止，请点击全量检测或单步流程" };
  if (runtimeState.running) return { ok: false, error: "当前流程仍在执行" };
  if (runtimeState.currentTask?.invitationAccepted && !hasLatchedLighthouseCompletion(runtimeState.completionEvidence?.runId)) {
    return { ok: false, error: "已接受邀请的订单尚未完成，请继续处理本单", state: runtimeState };
  }
  if (manualRestart && hasIdentifiedUncertainAction(runtimeState)) {
    const restartingState = runtimeState;
    const restartingRunId = runtimeState.runId;
    const commandEpoch = manualDebugCommandEpoch;
    const isCurrent = () => runtimeState === restartingState && runtimeState.runId === restartingRunId && manualDebugCommandEpoch === commandEpoch;
    await cancelCurrentRun(isCurrent);
    if (!isCurrent()) return { ok: false, cancelled: true, state: runtimeState };
    if (runtimeState.uncertainAction) {
      return { ok: false, uncertain: true, error: "旧动作尚未核对，已保留执行记录，不能启动新任务", state: runtimeState };
    }
  }
  if (!manualRestart && (runtimeState.uncertainAction || ((runtimeState.currentTask?.invitationAccepted || runtimeState.currentTask?.seatLocked || runtimeState.currentTask?.seatLockedAt || runtimeState.currentTask?.claimed) && !hasLatchedLighthouseCompletion(runtimeState.completionEvidence?.runId)))) {
    return { ok: false, error: "旧订单尚未核对，请先确认本单结果，不能清空后接新单", state: runtimeState };
  }
  const previousRun = runtimeState;
  runtimeState = createInitialState();
  runtimeState.manuallyStopped = Boolean(previousRun.manuallyStopped);
  runtimeState.stopEpoch = previousRun.stopEpoch;
  setRuntimeWindow(windowId);
  runtimeState.runId = createRunId();
  runtimeState.running = true;
  runtimeState.mode = "auto";
  runtimeState.startOptions = sanitizeAutoRunStartOptions(options);
  const startingState = runtimeState;
  const startingRunId = runtimeState.runId;
  const isCurrent = () => runtimeState === startingState && runtimeState.runId === startingRunId && runtimeState.running;
  const cancelled = () => ({ ok: false, cancelled: true, state: runtimeState });
  if (runtimeState.manuallyStopped && !await resumeAfterManualStop(isCurrent)) return cancelled();
  setStage("auto_starting");
  log("info", "全量检测指令已接收，正在准备 Lighthouse 页面");
  if (manualRestart && (previousRun.currentTask || previousRun.uncertainAction)) {
    const runId = runtimeState.runId;
    await cancelSupersededLighthouseRun(previousRun);
    if (runtimeState.runId !== runId || !runtimeState.running) return { ok: false, cancelled: true, state: runtimeState };
    log("info", "手动重新检测：已重置上一轮本地状态，是否可领取新任务以 Lighthouse 返回结果为准");
  }
  const settings = await getSettingsForRun(isCurrent);
  if (!isCurrent()) return cancelled();
  const keyFailure = blockRunWithoutAIKey(settings);
  if (keyFailure) return keyFailure;
  if (settings.replyMode !== "post") {
    runtimeState.running = false;
    setStage("auto_blocked");
    log("error", "正式模式需要先把 X 回复模式设置为自动发送，避免只填入后误提交 Lighthouse");
    return { ok: false, error: "正式模式需要 X 回复模式=自动发送", state: runtimeState };
  }
  if (!settings.autoSubmitLighthouse) {
    runtimeState.running = false;
    setStage("auto_blocked");
    log("error", "正式模式需要开启自动提交 Lighthouse，否则无法闭环完成任务");
    return { ok: false, error: "正式模式需要开启自动提交 Lighthouse", state: runtimeState };
  }
  const scheduleState = getAutoRunScheduleState(settings);
  if (!scheduleState.inWindow) {
    await enterAutoRunScheduleWait(scheduleState, "未到运行时间，先进入等待");
    return { ok: true, state: runtimeState };
  }
  await clearAutoRunResumeSchedule();
  if (!isCurrent()) return cancelled();
  // Armed only once every preflight check has passed; a blocked start must
  // not leave a keepalive alarm ticking.
  await ensureAutoRunKeepalive();
  if (!isCurrent()) return cancelled();
  await armCampaignsIdleReloadAlarm();
  if (!isCurrent()) return cancelled();
  const tab = await getOrCreateLighthouseTab(runtimeState.startOptions?.lighthouseUrl || LIGHTHOUSE_CAMPAIGNS_URL, isCurrent);
  if (!isCurrent()) return cancelled();
  rememberLighthouseTab(tab);
  const focused = await focusLighthouseTabForAutoScan(tab.id, isCurrent);
  if (!isCurrent()) return cancelled();
  if (!focused) {
    log("warn", "Chrome 正在调整 Lighthouse 标签，稍后继续检测任务广场");
    await delay(Math.max(settings.actionDelayMs, 1000));
    if (!isCurrent()) return cancelled();
    return startNextAutoTask("retry_after_lighthouse_tab_busy");
  }
  await waitForTabComplete(tab.id);
  if (!isCurrent()) return cancelled();
  runtimeState.scheduledResumeAt = 0;
  log("info", "全量检测已启动：按旧任务页锁定流程顺序执行");
  setStage("auto_started");
  await startNextAutoTask("start");
  return { ok: true, state: runtimeState };
}

async function waitForClaimRetryCooldown(runId) {
  const state = runtimeState;
  const remainingMs = Number(state.claimRetryNotBefore || 0) - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return true;
  setStage("claim_retry_cooldown");
  log("info", `平台已拒绝本次锁位，等待 ${Math.ceil(remainingMs / 1000)} 秒后刷新检测`);
  await delay(remainingMs);
  if (runtimeState !== state || !isActiveAutoRun(runId) || state.manuallyStopped) return false;
  delete state.claimRetryNotBefore;
  await persistAutoRunState(true);
  return runtimeState === state && isActiveAutoRun(runId) && !state.manuallyStopped;
}

async function startNextAutoTask(reason) {
  const runId = runtimeState.runId;
  const isCurrent = captureRunGuard();
  const cancelled = () => ({ ok: false, cancelled: true, state: runtimeState });
  if (!isActiveAutoRun(runId)) return { ok: false, error: "Auto run is not active" };
  if (!await waitForClaimRetryCooldown(runId) || !isCurrent()) return cancelled();
  const settings = await getSettingsForRun(isCurrent);
  if (!isCurrent()) return cancelled();
  const keyFailure = blockRunWithoutAIKey(settings);
  if (keyFailure) return keyFailure;
  const scheduleState = getAutoRunScheduleState(settings);
  if (!scheduleState.inWindow) {
    await enterAutoRunScheduleWait(scheduleState, "当前不在运行时间，等待下一次自动开始");
    return { ok: true, state: runtimeState };
  }
  await clearAutoRunResumeSchedule();
  if (!isCurrent()) return cancelled();
  runtimeState.scheduledResumeAt = 0;
  if (isLimitReached(runtimeState.completed, settings.maxTasksPerRun)) {
    runtimeState.running = false;
    setStage("finished");
    log("info", "已达到正式模式任务上限，运行结束");
    return { ok: true, state: runtimeState };
  }
  if (isLimitReached(runtimeState.attempts, settings.maxTaskAttempts)) {
    runtimeState.running = false;
    setStage("attempt_limit_reached");
    log("warn", "已达到任务尝试上限，停止正式模式");
    return { ok: true, state: runtimeState };
  }

  const tab = await getOrCreateLighthouseTab(LIGHTHOUSE_CAMPAIGNS_URL, isCurrent);
  if (!isCurrent() || !isActiveAutoRun(runId)) return cancelled();
  const tabId = tab.id;
  await rememberLighthouseTabById(tabId, isCurrent);
  if (!isCurrent()) return cancelled();
  const focused = await focusLighthouseTabForAutoScan(tabId, isCurrent);
  if (!isCurrent()) return cancelled();
  if (!focused) {
    log("warn", "Chrome 正在调整 Lighthouse 标签，稍后继续检测任务广场");
    await delay(Math.max(settings.actionDelayMs, 1000));
    if (!isCurrent()) return cancelled();
    return startNextAutoTask("retry_after_lighthouse_tab_busy");
  }
  await waitForTabComplete(tabId);
  await delay(settings.actionDelayMs);
  if (!isActiveAutoRun(runId)) return { ok: true, state: runtimeState };
  // A run that just returned cleanly from a completed task has no residual
  // detail to close; the extra close round-trip and settle delay only added
  // seconds to every round boundary.
  if (runtimeState.stage !== "campaigns_returned") {
    await closeLighthouseTaskDetail(tabId, settings, "开始选择下一单前关闭残留任务详情");
    await delay(Math.max(settings.actionDelayMs || 500, 800));
  }
  if (!isActiveAutoRun(runId)) return { ok: true, state: runtimeState };
  setStage("selecting_task");
  log("info", `开始寻找下一条评论/点赞互动任务：${reason || "continue"}`);
  await ensurePermanentIgnoredTaskKeysLoaded();
  if (!isCurrent()) return cancelled();
  pruneAttemptedTasks();

  beginXOpenWatch(tabId, "auto");
  const result = await sendToTab(tabId, {
    type: "START_LIGHTHOUSE_COMMENT_TASK",
    runId,
    settings,
    attemptedTaskKeys: getActiveAttemptedTaskKeys(),
    attemptedTaskRecords: (runtimeState.attemptedTaskRecords || [])
      .filter(record => !permanentIgnoredTaskKeysCache.has(record.key)).map(record => ({ ...record }))
  });
  if (!isActiveAutoRun(runId)) return { ok: true, state: runtimeState };

  if (!result || !result.ok) {
    // A late no-click receipt cannot negate an order established meanwhile.
    if (runtimeState.uncertainAction || runtimeState.completionEvidence || runtimeState.lastXResult
        || [runtimeState.currentTask, result?.task].some(task => task && (
          task.invitationAccepted || task.claimed || task.seatLocked || task.seatLockedAt))) {
      return recoverAndContinue(result?.message || result?.error || "接单结果与当前订单状态冲突", {
        runId, task: runtimeState.currentTask || result?.task, closeX: false, preserveOrder: true
      });
    }
    clearXOpenWatch();
    if (result?.refreshRequested) {
      const refreshingState = runtimeState;
      const ownsRefresh = () => runtimeState === refreshingState && runtimeState.runId === runId;
      const isCurrentRefresh = () => ownsRefresh() && isActiveAutoRun(runId);
      // sendToTab takes this lock before it releases the claim intent, so an
      // alarm cannot cancel the run between the safe receipt and this branch.
      refreshingState.marketplaceRefreshInFlight = true;
      let nextReason;
      try {
        const refreshState = await refreshLighthouseCampaignsTab(tabId, result.message || "任务广场陈旧可做列表刷新后继续下一轮", isCurrentRefresh);
        if (!isCurrentRefresh() || refreshState.cancelled) return { ok: false, cancelled: true, state: runtimeState };
        if (refreshState.ok) {
          // A successful plaza reload starts a new idle interval; ordinary
          // stage transitions must still leave the no-order timer untouched.
          runtimeState.lastProgressAt = Date.now();
          setStage("campaigns_refreshed");
          log("info", result.message || "任务广场陈旧可做列表已刷新，重新寻找下一条评论/点赞互动任务");
          await delay(Math.max(settings.actionDelayMs || 500, 1200));
          nextReason = "retry_after_campaigns_refresh";
        } else if (refreshState.skippedCooldown) {
          setStage("selecting_task");
          log("info", refreshState.message || "任务广场刷新冷却中，继续等待列表恢复");
          await delay(Math.max(15000, settings.actionDelayMs * 2));
          nextReason = "retry_after_campaigns_refresh_cooldown";
        } else {
          runtimeState.running = false;
          runtimeState.failed += 1;
          setStage("campaigns_reload_failed");
          log("error", `任务广场刷新失败，已停止扫描：${refreshState.message || "未确认页面重新加载完成"}`);
          return { ok: false, error: "任务广场刷新失败，已停止扫描", state: runtimeState };
        }
        if (!isCurrentRefresh()) return { ok: false, cancelled: true, state: runtimeState };
      } finally {
        if (ownsRefresh()) refreshingState.marketplaceRefreshInFlight = false;
      }
      if (!isCurrentRefresh()) return { ok: false, cancelled: true, state: runtimeState };
      return startNextAutoTask(nextReason);
    }
    if (result?.permanentIgnore) {
      const ignoredTask = result.task || runtimeState.currentTask || {};
      await markPermanentIgnoredTask(ignoredTask, result.ignoredTaskType || ignoredTask.taskType || "非评论");
      if (!isCurrent()) return cancelled();
      setStage("task_permanently_ignored");
      log("warn", result.message || result.error || "已永久忽略非评论任务，继续寻找下一条评论/点赞互动任务");
      await closeLighthouseTaskDetail(tabId, settings, "永久忽略非评论任务后关闭详情面板");
      await delay(settings.actionDelayMs * 2);
      if (!isCurrent()) return cancelled();
      return startNextAutoTask("retry_after_permanent_ignore");
    }
    const deferredRelease = result?.deferredRelease === true;
    const retryAfterMs = Number(result?.retryAfterMs);
    const confirmedCooldown = result?.claimRejectionConfirmed === true
      && Number.isFinite(retryAfterMs) && retryAfterMs > 0;
    const batchUnavailable = result?.claimRejectionConfirmed === true && result.claimRetryScope === "task";
    const transient = !!result?.transient && !deferredRelease;
    if (transient) {
      runtimeState.attempts += 1;
    } else if (!deferredRelease) {
      runtimeState.failed += 1;
    }
    const failedTask = transient ? null : (result?.task || runtimeState.currentTask)
      ? { ...(runtimeState.currentTask || {}), ...(result?.task || {}) }
      : null;
    if (failedTask) {
      // A late receipt can arrive after its rescan deadline. Keep it eligible
      // almost immediately instead of applying normal failure deduplication.
      const retryNow = Date.now();
      if (deferredRelease && Number(failedTask.deferUntil) <= retryNow) {
        failedTask.deferUntil = retryNow + 250;
      }
      if ((result?.claimActionAttempted === false || result?.claimRejectionConfirmed === true)
          && !runtimeState.uncertainAction && !runtimeState.completionEvidence
          && !failedTask.invitationAccepted && !failedTask.claimed
          && !failedTask.seatLocked && !failedTask.seatLockedAt) {
        runtimeState.attempts += 1;
        releaseAttemptedTask(runtimeState.currentTask);
        releaseAttemptedTask(failedTask);
        runtimeState.currentTask = null;
        log("info", batchUnavailable
          ? "本批未接到单，不加入去重；返回广场读取平台新的倒计时"
          : "已确认未接到单，不加入去重；刷新任务广场后重新检测");
      } else {
        markAttemptedTask(failedTask);
      }
    } else if (!transient) {
      runtimeState.attempts += 1;
    }
    setStage(deferredRelease ? "task_release_deferred" : "task_select_failed");
    log(transient || deferredRelease ? "info" : "warn", result?.message || result?.error || "任务选择失败，准备尝试下一条");
    await closeLighthouseTaskDetail(tabId, settings, deferredRelease ? "等待下一批放号，关闭详情继续扫描任务广场" : "任务选择失败后关闭详情面板");
    if (!isCurrent() || !isActiveAutoRun(runId)) return cancelled();
    if (confirmedCooldown && !batchUnavailable) {
      runtimeState.claimRetryNotBefore = Date.now() + retryAfterMs;
      await persistAutoRunState(true);
      if (!isCurrent() || !isActiveAutoRun(runId)) return cancelled();
      if (!await waitForClaimRetryCooldown(runId) || !isCurrent()) return cancelled();
    }
    const reloaded = await reloadLighthouseCampaignsAfterOrder(tabId, deferredRelease ? "未接到单，重新加载任务广场并按平台倒计时继续检测" : "接单失败，已重新加载任务广场", isCurrent);
    if (!isCurrent()) return cancelled();
    if (reloaded === false) {
      runtimeState.running = false;
      setStage("campaigns_reload_failed");
      return { ok: false, error: "接单失败后重新加载任务广场失败，已停止扫描", state: runtimeState };
    }
    await delay(settings.actionDelayMs * 2);
    if (!isCurrent()) return cancelled();
    return startNextAutoTask(deferredRelease ? "retry_after_deferred_release" : "retry_after_task_select_failed");
  }

  if (result.task) {
    markAttemptedTask(result.task);
    runtimeState.currentTask = mergeTaskPreservingCapturedTweetUrl(runtimeState.currentTask, result.task);
    // The five-minute watchdog measures time since the last real order event,
    // not time since an internal stage transition.
    touchAutoRunState();
  }
  runtimeState.completionEvidence = null;
  await sendToTab(tabId, { type: "BEGIN_LIGHTHOUSE_COMPLETION_WATCH", runId, task: runtimeState.currentTask });
  if (!isCurrent()) return cancelled();
  // The content script has completed the lock step.  Continue the X handoff
  // in this same background flow so the five-second fallback cannot race an
  // unawaited runtime message from the page.
  return adoptTargetOpenedTweet(runtimeState.currentTask, tabId, "auto");
}

async function debugOpenCampaigns(windowId = null) {
  if (runtimeState.uncertainAction || ((runtimeState.currentTask?.invitationAccepted || runtimeState.currentTask?.seatLocked || runtimeState.currentTask?.seatLockedAt || runtimeState.currentTask?.claimed) && !hasLatchedLighthouseCompletion(runtimeState.completionEvidence?.runId))) {
    return { ok: false, error: "旧订单尚未核对，已保留当前订单和页面", state: runtimeState };
  }
  runtimeState = createInitialState();
  setRuntimeWindow(windowId);
  runtimeState.runId = createRunId();
  runtimeState.running = true;
  runtimeState.mode = "debug";
  const commandState = runtimeState;
  const runId = runtimeState.runId;
  const isCurrent = () => runtimeState === commandState && runtimeState.runId === runId && runtimeState.running;
  const cancelled = () => ({ ok: false, cancelled: true, error: "旧打开广场步骤已取消", state: runtimeState });

  const activeTab = await getActiveLighthouseTab(isCurrent);
  if (!isCurrent()) return cancelled();
  if (activeTab) {
    rememberLighthouseTab(activeTab);
    await chrome.tabs.update(activeTab.id, { active: true });
    if (!isCurrent()) return cancelled();
    await waitForTabComplete(activeTab.id);
    if (!isCurrent()) return cancelled();
    setStage("lighthouse_page_detected");
    log("info", "已检测到当前 Lighthouse 页面，复用当前页，不重新跳转");
    return { ok: true, state: runtimeState };
  }

  const tab = await getOrCreateLighthouseTab(LIGHTHOUSE_CAMPAIGNS_URL, isCurrent);
  if (!isCurrent()) return cancelled();
  rememberLighthouseTab(tab);
  await chrome.tabs.update(tab.id, { url: LIGHTHOUSE_CAMPAIGNS_URL, active: true });
  if (!isCurrent()) return cancelled();
  await waitForTabComplete(tab.id);
  if (!isCurrent()) return cancelled();
  setStage("campaigns_opened");
  log("info", "已打开任务广场");
  return { ok: true, state: runtimeState };
}

async function debugOpenFirstTask() {
  if (runtimeState.uncertainAction || ((runtimeState.currentTask?.invitationAccepted || runtimeState.currentTask?.seatLocked || runtimeState.currentTask?.seatLockedAt || runtimeState.currentTask?.claimed) && !hasLatchedLighthouseCompletion(runtimeState.completionEvidence?.runId))) {
    return { ok: false, error: "旧订单尚未核对，不能打开另一任务", state: runtimeState };
  }
  const commandState = runtimeState;
  const runId = runtimeState.runId;
  const isCurrent = () => runtimeState === commandState && runtimeState.runId === runId && runtimeState.running;
  const cancelled = () => ({ ok: false, cancelled: true, error: "旧打开任务步骤已取消", state: runtimeState });
  const tabId = await resolveLighthouseTab(isCurrent);
  if (!isCurrent()) return cancelled();
  const settings = await getSettingsForRun(isCurrent);
  if (!isCurrent()) return cancelled();
  await chrome.tabs.update(tabId, { active: true });
  if (!isCurrent()) return cancelled();
  await ensurePermanentIgnoredTaskKeysLoaded();
  if (!isCurrent()) return cancelled();
  let result = await sendToTab(tabId, {
    type: "DEBUG_OPEN_FIRST_COMMENT_TASK",
    runId,
    settings,
    attemptedTaskKeys: getActiveAttemptedTaskKeys(),
    attemptedTaskRecords: (runtimeState.attemptedTaskRecords || [])
      .filter(record => !permanentIgnoredTaskKeysCache.has(record.key)).map(record => ({ ...record }))
  });
  if (!isCurrent()) return cancelled();
  if (result?.refreshRequested) {
    const refreshState = await refreshLighthouseCampaignsTab(tabId, result.message || "任务广场陈旧可做列表刷新后重试", isCurrent);
    if (!isCurrent()) return cancelled();
    if (refreshState.ok) {
      result = await sendToTab(tabId, {
        type: "DEBUG_OPEN_FIRST_COMMENT_TASK",
        runId,
        settings,
        attemptedTaskKeys: getActiveAttemptedTaskKeys(),
        attemptedTaskRecords: (runtimeState.attemptedTaskRecords || [])
          .filter(record => !permanentIgnoredTaskKeysCache.has(record.key)).map(record => ({ ...record }))
      });
      if (!isCurrent()) return cancelled();
    } else if (refreshState.skippedCooldown) {
      return failStep({ message: refreshState.message }, "任务广场刷新冷却中");
    }
  }
  if (!result || !result.ok) {
    if (result?.permanentIgnore) {
      await markPermanentIgnoredTask(result.task || {}, result.ignoredTaskType || result.task?.taskType || "非评论");
      if (!isCurrent()) return cancelled();
      await closeLighthouseTaskDetail(tabId, settings, "永久忽略非评论任务后关闭详情", isCurrent);
      if (!isCurrent()) return cancelled();
      setStage("task_permanently_ignored");
      log("warn", result.message || "已永久忽略非评论任务");
      return { ok: true, result, state: runtimeState };
    }
    return failStep(result, "打开第一个评论/点赞互动任务失败");
  }
  if (result.task) {
    runtimeState.currentTask = result.task;
  }
  setStage("task_detail_opened");
  log("info", result.message || "已打开第一个评论/点赞互动任务");
  return { ok: true, result, state: runtimeState };
}

async function debugLockSeatAndOpenTweet() {
  const commandState = runtimeState;
  const runId = runtimeState.runId;
  const isCurrent = () => runtimeState === commandState && runtimeState.runId === runId && runtimeState.running;
  const cancelled = () => ({ ok: false, cancelled: true, error: "旧锁定席位步骤已取消", state: runtimeState });
  const tabId = await resolveLighthouseTab(isCurrent);
  if (!isCurrent()) return cancelled();
  const settings = await getSettingsForRun(isCurrent);
  if (!isCurrent()) return cancelled();
  const keyFailure = blockRunWithoutAIKey(settings, runtimeState.currentTask);
  if (keyFailure) return keyFailure;
  await chrome.tabs.update(tabId, { active: true });
  if (!isCurrent()) return cancelled();
  setStage("locking_seat");
  beginXOpenWatch(tabId, "debug");
  const result = await sendToTab(tabId, { type: "DEBUG_LOCK_SEAT_AND_EXTRACT", runId, settings });
  if (!isCurrent()) return cancelled();
  if (!result || !result.ok) {
    clearXOpenWatch();
    return failStep(result, "锁定席位或提取推文失败");
  }

  runtimeState.currentTask = mergeTaskPreservingCapturedTweetUrl(runtimeState.currentTask, result.task);
  markAttemptedTask(result.task);
  const adopted = await waitForLighthouseOpenedTweet(result.task, tabId, "debug", {
    waitLogMessage: "已确认本单锁位，等待平台自动打开 X 推文标签页",
    manualOpenAfterMs: 5000
  });
  if (!isCurrent()) return cancelled();
  if (!adopted) return failStep(result, runtimeState.lastLockFailureReason || "已点击锁定席位，但未检测到 Lighthouse 自己打开的 X 推文页");
  setStage("tweet_opened");
  log("info", result.message || "已锁定席位并打开 X 推文");
  return { ok: true, result, state: runtimeState };
}

async function debugOpenCurrentDetailTweet() {
  const tabId = await resolveLighthouseTab();
  const settings = await getSettings();
  await chrome.tabs.update(tabId, { active: true });
  setStage("opening_tweet_target");
  beginXOpenWatch(tabId, "debug");
  const result = await sendToTab(tabId, { type: "OPEN_CURRENT_DETAIL_TWEET_TARGET", runId: runtimeState.runId, settings });
  if (!result || !result.ok) {
    clearXOpenWatch();
    return failStep(result, "打开 X 推文入口失败");
  }

  runtimeState.currentTask = mergeTaskPreservingCapturedTweetUrl(runtimeState.currentTask, result.task);
  markAttemptedTask(result.task);

  const tweetTabId = await ensureTweetTabAfterTargetClick(tabId, settings, runtimeState.currentTask, "debug");
  if (!tweetTabId) return failStep(result, "已点击在 X 打开/前往目标，但未检测到 Lighthouse 自己打开的 X 推文页");
  setStage("tweet_opened");
  log("info", result.message || "已打开 X 推文");
  return { ok: true, result, state: runtimeState };
}

async function debugRunXReply() {
  const commandState = runtimeState;
  const runId = runtimeState.runId;
  const isCurrent = () => runtimeState === commandState && runtimeState.runId === runId && runtimeState.running;
  const cancelled = () => ({ ok: false, cancelled: true, error: "旧回复步骤已取消", state: runtimeState });
  const tabId = await resolveCurrentXTab({ allowActiveTweetTab: true }, isCurrent);
  if (!isCurrent()) return cancelled();
  const settings = await getSettingsForRun(isCurrent);
  if (!isCurrent()) return cancelled();
  await chrome.tabs.update(tabId, { active: true });
  if (!isCurrent()) return cancelled();
  await waitForTabComplete(tabId);
  if (!isCurrent()) return cancelled();
  await delay(Math.max(settings.actionDelayMs * 2, 2500));
  if (!isCurrent()) return cancelled();
  const result = await sendToTab(tabId, {
    type: "RUN_X_REPLY",
    runId,
    task: runtimeState.currentTask,
    settings
  });
  if (!isCurrent()) return cancelled();
  if (!result || !result.ok) return failStep(result, "X 回复步骤失败");
  runtimeState.lastXResult = result;
  await recordReplyHistory(result);
  if (!isCurrent()) return cancelled();
  setStage("x_replied");
  log("info", result.message || "X 回复步骤已完成");
  return { ok: true, result, state: runtimeState };
}

async function debugFastXClaimReplyVerify(selectedTask = null, windowId = null) {
  const requestedState = runtimeState;
  const requestedRunId = runtimeState.runId;
  const ownsRequest = () => runtimeState === requestedState && runtimeState.runId === requestedRunId
    && runtimeState.running && !runtimeState.manuallyStopped;
  const cancelled = () => ({ ok: false, cancelled: true, state: runtimeState });
  if (!ownsRequest()) return cancelled();
  if (runtimeState.uncertainAction || ((runtimeState.currentTask?.invitationAccepted || runtimeState.currentTask?.seatLocked || runtimeState.currentTask?.seatLockedAt || runtimeState.currentTask?.claimed) && !hasLatchedLighthouseCompletion(runtimeState.completionEvidence?.runId))) {
    return { ok: false, error: "旧订单尚未核对，不能清空后启动快速流程", state: runtimeState };
  }
  const settings = await getSettingsForRun(ownsRequest);
  if (!ownsRequest()) return cancelled();
  const keyFailure = blockRunWithoutAIKey(settings, selectedTask);
  if (keyFailure) return keyFailure;
  const selected = selectedTask ? { ...selectedTask } : null;
  runtimeState = createInitialState();
  runtimeState.stopEpoch = requestedState.stopEpoch;
  setRuntimeWindow(windowId);
  runtimeState.running = true;
  runtimeState.mode = "debug";
  const fastState = runtimeState;
  const runId = runtimeState.runId;
  const isCurrent = () => runtimeState === fastState && runtimeState.runId === runId
    && runtimeState.running && !runtimeState.manuallyStopped;

  if (selected && isIgnoredNonCommentTask(selected)) {
    await markPermanentIgnoredTask(selected, selected.taskType || "非评论");
    if (!isCurrent()) return cancelled();
    runtimeState.running = false;
    setStage("original_tweet_ignored");
    log("warn", `已忽略原创/转发任务，不打开详情：${describeTaskForLog(selected)}`);
    return { ok: true, ignored: true, reason: "ignored_non_comment_task", state: runtimeState };
  }

  const tabId = selected
    ? await openSelectedTaskTweetTab(selected, settings, isCurrent)
    : await openNextLighthouseTaskTweetTab(settings, isCurrent);
  if (!isCurrent()) return cancelled();
  runtimeState.xTabId = tabId;
  await waitForTabComplete(tabId);
  if (!isCurrent()) return cancelled();
  setStage("fast_claim_waiting");
  log("info", selected
    ? "新流程：已从 Lighthouse 选中任务进入 X，等待任务控件进入抢单窗口"
    : "新流程：已从 Lighthouse 任务广场打开任务详情并进入 X，等待任务控件进入抢单窗口");

  const claimResult = await sendToTab(tabId, {
    type: "RUN_X_WIDGET_CLAIM",
    runId,
    task: runtimeState.currentTask,
    settings
  });
  if (!isCurrent()) return cancelled();

  if (!claimResult || !claimResult.ok) {
    runtimeState.failed += 1;
    setStage("fast_claim_failed");
    log("warn", claimResult?.message || "X 抢单失败，已停留当前 X 页面保留现场");
    return { ok: false, result: claimResult, state: runtimeState };
  }

  setStage("fast_claimed");
  log("info", claimResult.message || "X 已抢成功，开始回复");

  const replySettings = { ...settings, replyMode: "post" };
  const replyResult = await sendToTab(tabId, {
    type: "RUN_X_REPLY",
    runId,
    task: runtimeState.currentTask,
    settings: replySettings
  });
  if (!isCurrent()) return cancelled();

  if (!replyResult || !replyResult.ok) {
    runtimeState.failed += 1;
    setStage("fast_reply_failed");
    log("error", replyResult?.message || replyResult?.error || "X 回复失败，已停留当前 X 页面保留现场");
    return { ok: false, result: replyResult, state: runtimeState };
  }

  await recordReplyHistory(replyResult);
  if (!isCurrent()) return cancelled();
  const completionResult = await completeXTaskWidgetLifecycle(tabId, runId, settings, isCurrent);
  if (!isCurrent()) return cancelled();
  if (!completionResult?.ok) {
    runtimeState.failed += 1;
    setStage("fast_completion_failed");
    log("warn", completionResult?.message || completionResult?.error || "X 任务未完成，保留当前页面");
    return { ok: false, result: { claimResult, replyResult, completionResult }, state: runtimeState };
  }

  const campaignsResult = await waitForLighthouseTaskCompletionAndReturn(runId, settings, isCurrent);
  if (!isCurrent()) return cancelled();
  if (!campaignsResult?.ok) {
    runtimeState.failed += 1;
    setStage("fast_completion_failed");
    log("warn", campaignsResult?.message || "Lighthouse 未确认任务完成，保留 X 页面");
    return { ok: false, result: { claimResult, replyResult, completionResult, campaignsResult }, state: runtimeState };
  }

  runtimeState.completed += 1;
  setStage("fast_flow_done");
  return { ok: true, result: { claimResult, replyResult, completionResult, campaignsResult }, state: runtimeState };
}

async function startSelectedCountdownTask(selectedTask = null, windowId = null) {
  if (!runtimeState.running && runtimeState.uncertainAction) await reconcileStoppedClaim(true);
  if (runtimeState.currentTask?.claimReconciled && !hasLatchedLighthouseCompletion(runtimeState.runId)) {
    return { ok: false, error: "本单席位已锁定，请先完成本单，不能切换到另一个选中任务", state: runtimeState };
  }
  if (!selectedTask) {
    log("error", "未选中倒计时任务，请先在任务倒计时列表点击一条任务");
    return { ok: false, error: "未选中任务", state: runtimeState };
  }
  if (selectedStartInFlight) {
    log("warn", "选中启动指令正在处理，请勿重复点击");
    return { ok: false, error: "选中启动正在处理", state: runtimeState };
  }
  if (runtimeState.currentTask?.invitationAccepted && !hasLatchedLighthouseCompletion(runtimeState.completionEvidence?.runId)) {
    return { ok: false, error: "已接受邀请的订单尚未完成，请继续处理本单", state: runtimeState };
  }

  const selectedStartOwner = {};
  selectedStartInFlight = selectedStartOwner;
  const stopEpoch = runtimeState.stopEpoch;
  try {
    if (runtimeState.running || runtimeState.currentTask || runtimeState.uncertainAction) {
      const previousState = runtimeState;
      const previousRunId = runtimeState.runId;
      const isCurrent = () => runtimeState === previousState && runtimeState.runId === previousRunId && runtimeState.stopEpoch === stopEpoch;
      const previousMode = runtimeState.mode || "当前";
      log("info", `选中启动：正在停止 ${previousMode} 流程并接管选中任务`);
      await Promise.all([
        cancelCurrentRun(isCurrent),
        clearAutoRunResumeSchedule()
      ]);
      if (!isCurrent()) return { ok: false, cancelled: true, state: runtimeState };
      if (runtimeState.uncertainAction && hasIdentifiedUncertainAction(runtimeState)) {
        return { ok: false, uncertain: true, error: "旧动作尚未核对，已保留执行记录，不能启动选中任务", state: runtimeState };
      }
      runtimeState.scheduledResumeAt = 0;
      runtimeState.runId = createRunId();
    }
    return await runSelectedCountdownTask(selectedTask, windowId);
  } finally {
    if (selectedStartInFlight === selectedStartOwner) selectedStartInFlight = false;
  }
}

async function runSelectedCountdownTask(selectedTask = null, windowId = null) {
  const previous = runtimeState;
  runtimeState = createInitialState();
  runtimeState.stopEpoch = previous.stopEpoch;
  runtimeState.manuallyStopped = Boolean(previous.manuallyStopped);
  setRuntimeWindow(windowId);
  runtimeState.running = true;
  runtimeState.mode = "selected_once";
  // Persist the selection identity, never use its old clock as execution state.
  runtimeState.selectedTask = selectedTask ? { ...selectedTask } : null;
  const state = runtimeState;
  const runId = state.runId;
  const ownsRun = () => runtimeState === state && runtimeState.runId === runId;
  const isCurrent = () => ownsRun() && runtimeState.running;
  const cancelled = () => ({ ok: false, cancelled: true, state: runtimeState });
  const interrupted = result => ownsRun() && !state.manuallyStopped
    ? { ok: false, uncertain: Boolean(state.uncertainAction), result, error: result?.message || result?.error, state }
    : cancelled();
  if (state.manuallyStopped && !await resumeAfterManualStop(isCurrent)) return cancelled();
  const settings = await getSettingsForRun(isCurrent);
  if (!isCurrent()) return cancelled();
  if (!selectedTask) return finishSelectedRun("selected_task_missing", "未选中任务", null, settings, isCurrent);
  if (isIgnoredNonCommentTask(selectedTask)) {
    await markPermanentIgnoredTask(selectedTask, selectedTask.taskType || "非评论");
    if (!isCurrent()) return cancelled();
    return finishSelectedRun("selected_original_tweet_ignored", "已忽略原创/转发任务", null, settings, isCurrent);
  }
  const keyFailure = blockRunWithoutAIKey(settings, selectedTask);
  if (keyFailure) return keyFailure;
  if (settings.replyMode !== "post" || !settings.autoSubmitLighthouse) {
    return finishSelectedRun("selected_task_blocked", "选中启动需要自动发送回复并开启自动提交 Lighthouse", null, settings, isCurrent);
  }
  await ensureAutoRunKeepalive();
  if (!isCurrent()) return cancelled();
  const lighthouseTabId = await resolveLighthouseTab(isCurrent);
  if (!isCurrent()) return cancelled();
  await rememberLighthouseTabById(lighthouseTabId, isCurrent);
  if (!isCurrent()) return cancelled();
  await chrome.tabs.update(lighthouseTabId, { active: true });
  if (!isCurrent()) return cancelled();
  await waitForTabComplete(lighthouseTabId);
  if (!isCurrent()) return cancelled();

  try {
    while (isCurrent()) {
      setStage("selected_task_opening");
      log("info", `选中启动：打开任务详情 ${selectedTask.bounty || "?"}LUX · ${selectedTask.title || selectedTask.taskType || "任务"}`);
      const openResult = await sendToTab(lighthouseTabId, {
        type: "OPEN_SELECTED_COUNTDOWN_TASK_DETAIL", runId, settings, selectedTask
      });
      if (!isCurrent()) return interrupted(openResult);
      if (!openResult?.ok) {
        if (openResult?.claimActionAttempted === false && (openResult.transient || openResult.refreshRequested)
            && !runtimeState.uncertainAction && !runtimeState.currentTask?.invitationAccepted) {
          runtimeState.attempts += 1;
          if (!isLimitReached(runtimeState.attempts, settings.maxTaskAttempts)) {
            setStage("selected_retry_waiting");
            const ready = await reloadLighthouseCampaignsAfterOrder(lighthouseTabId, "未接单页面中断，刷新后继续选中任务", isCurrent);
            if (!isCurrent()) return cancelled();
            if (ready !== false) continue;
          }
        }
        return finishSelectedRun("selected_task_open_failed", openResult?.message || openResult?.error || "选中任务已不可用", lighthouseTabId, settings, isCurrent);
      }
      runtimeState.currentTask = mergeTaskPreservingCapturedTweetUrl(runtimeState.currentTask, openResult.task);
      setStage("selected_countdown_waiting");
      log("info", "已进入选中任务详情，按页面实时放号状态等待；不使用侧栏旧倒计时");
      beginXOpenWatch(lighthouseTabId, "selected_once");
      const lockResult = await sendToTab(lighthouseTabId, {
        type: "WAIT_SELECTED_COUNTDOWN_AND_LOCK", runId, settings, selectedTask
      });
      if (!isCurrent()) return interrupted(lockResult);
      if (lockResult?.ok) {
        runtimeState.currentTask = mergeTaskPreservingCapturedTweetUrl(runtimeState.currentTask, lockResult.task);
        markAttemptedTask(runtimeState.currentTask);
        // Both automatic entry points now use the same X handoff, reply,
        // completion proof, return, durable count and finalization path.
        return await adoptTargetOpenedTweet(runtimeState.currentTask, lighthouseTabId, "selected_once");
      }
      const protectedOrder = runtimeState.uncertainAction || runtimeState.completionEvidence || runtimeState.lastXResult
        || [runtimeState.currentTask, lockResult?.task].some(task => task && (
          task.invitationAccepted || task.claimed || task.seatLocked || task.seatLockedAt));
      if (protectedOrder) {
        return recoverAndContinue(lockResult?.message || "本单接单结果尚未核对", { runId, preserveOrder: true, closeX: false });
      }
      clearXOpenWatch();
      const safelyUnclaimed = lockResult?.claimRejectionConfirmed === true || lockResult?.claimActionAttempted === false;
      const retryable = safelyUnclaimed && (lockResult?.claimRejectionConfirmed || lockResult?.deferredRelease
        || lockResult?.transient || lockResult?.refreshRequested);
      runtimeState.attempts += 1;
      if (!retryable || isLimitReached(runtimeState.attempts, settings.maxTaskAttempts)) {
        return finishSelectedRun("selected_lock_failed", lockResult?.message || "选中任务无法领取", lighthouseTabId, settings, isCurrent);
      }
      // No order exists. Close and refresh while the run still owns its
      // command permit; stopping first would cancel its own cleanup.
      setStage("selected_retry_waiting");
      log("info", `${lockResult.message || "本次未接到单"}；保留选中任务，刷新平台状态后继续等待`);
      await closeLighthouseTaskDetail(lighthouseTabId, settings, "未接到单，返回广场重新核对选中任务", isCurrent);
      if (!isCurrent()) return cancelled();
      runtimeState.currentTask = null;
      if (lockResult.claimRetryScope === "global" && Number(lockResult.retryAfterMs) > 0) {
        await delay(Number(lockResult.retryAfterMs));
        if (!isCurrent()) return cancelled();
      }
      const reloaded = await reloadLighthouseCampaignsAfterOrder(lighthouseTabId, "已刷新选中任务的实时状态", isCurrent);
      if (!isCurrent()) return cancelled();
      if (reloaded === false) return finishSelectedRun("campaigns_reload_failed", "平台任务列表未恢复，已停止本次选中任务", null, settings, isCurrent);
      await delay(Math.max(1000, settings.actionDelayMs || 0));
    }
    return cancelled();
  } catch (error) {
    if (!isCurrent()) return cancelled();
    if (runtimeState.uncertainAction || runtimeState.currentTask?.seatLocked || runtimeState.currentTask?.invitationAccepted) {
      return recoverAndContinue(error.message || String(error), { runId, preserveOrder: true, closeX: false });
    }
    return finishSelectedRun("selected_task_failed", error.message || String(error), lighthouseTabId, settings, isCurrent);
  }
}

async function finishSelectedRun(stage, message, tabId, settings, isCurrent) {
  if (!isCurrent()) return { ok: false, cancelled: true, state: runtimeState };
  if (tabId && !runtimeState.uncertainAction) {
    await closeLighthouseTaskDetail(tabId, settings, message, isCurrent);
    if (!isCurrent()) return { ok: false, cancelled: true, state: runtimeState };
  }
  clearXOpenWatch();
  runtimeState.running = false;
  runtimeState.failed += 1;
  setStage(stage);
  log("warn", message);
  await persistAutoRunState(true);
  return { ok: false, error: message, state: runtimeState };
}

async function openNextLighthouseTaskTweetTab(settings, stillCurrent = null) {
  const openingState = runtimeState;
  const runId = runtimeState.runId;
  const isCurrent = () => runtimeState === openingState && runtimeState.runId === runId
    && runtimeState.running && !runtimeState.manuallyStopped && (!stillCurrent || stillCurrent());
  if (!isCurrent()) return null;
  setStage("lighthouse_opening_for_fast_flow");
  const tab = await getOrCreateLighthouseTab(LIGHTHOUSE_CAMPAIGNS_URL, isCurrent);
  if (!isCurrent()) return null;
  const lighthouseTabId = tab.id;
  await rememberLighthouseTabById(lighthouseTabId, isCurrent);
  if (!isCurrent()) return null;
  await chrome.tabs.update(lighthouseTabId, { url: LIGHTHOUSE_CAMPAIGNS_URL, active: true });
  if (!isCurrent()) return null;
  await waitForTabComplete(lighthouseTabId);
  if (!isCurrent()) return null;
  await delay(Math.max(settings.actionDelayMs || 500, 1200));
  if (!isCurrent()) return null;
  log("info", "未选择倒计时任务，已回到 Lighthouse 任务广场准备打开评论/点赞互动任务");
  await ensurePermanentIgnoredTaskKeysLoaded();
  if (!isCurrent()) return null;

  let openResult = await sendToTab(lighthouseTabId, {
    type: "DEBUG_OPEN_FIRST_COMMENT_TASK",
    runId,
    settings,
    attemptedTaskKeys: getActiveAttemptedTaskKeys(),
    attemptedTaskRecords: (runtimeState.attemptedTaskRecords || [])
      .filter(record => !permanentIgnoredTaskKeysCache.has(record.key)).map(record => ({ ...record }))
  });
  if (!isCurrent()) return null;
  if (openResult?.refreshRequested) {
    const refreshState = await refreshLighthouseCampaignsTab(lighthouseTabId, openResult.message || "任务广场陈旧可做列表刷新后重试快抢入口", isCurrent);
    if (!isCurrent()) return null;
    if (refreshState.ok) {
      openResult = await sendToTab(lighthouseTabId, {
        type: "DEBUG_OPEN_FIRST_COMMENT_TASK",
        runId,
        settings,
        attemptedTaskKeys: getActiveAttemptedTaskKeys(),
        attemptedTaskRecords: (runtimeState.attemptedTaskRecords || [])
          .filter(record => !permanentIgnoredTaskKeysCache.has(record.key)).map(record => ({ ...record }))
      });
      if (!isCurrent()) return null;
    } else if (refreshState.skippedCooldown) {
      throw new Error(refreshState.message || "任务广场刷新冷却中，请稍后再试");
    }
  }
  if (!openResult || !openResult.ok) {
    if (openResult?.permanentIgnore) {
      await markPermanentIgnoredTask(openResult.task || {}, openResult.ignoredTaskType || openResult.task?.taskType || "非评论");
      if (!isCurrent()) return null;
      await closeLighthouseTaskDetail(lighthouseTabId, settings, "永久忽略非评论任务后关闭详情", isCurrent);
      if (!isCurrent()) return null;
    }
    throw new Error(openResult?.message || openResult?.error || "未能从 Lighthouse 任务广场打开评论/点赞互动任务详情");
  }
  if (openResult.task) {
    runtimeState.currentTask = openResult.task;
  }

  setStage("task_detail_opened_for_fast_flow");
  log("info", openResult.message || "已打开评论/点赞互动任务详情，准备点击在 X 打开/前往目标");

  beginXOpenWatch(lighthouseTabId, "debug");
  const targetResult = await sendToTab(lighthouseTabId, {
    type: "OPEN_CURRENT_DETAIL_TWEET_TARGET",
    runId,
    settings
  });
  if (!isCurrent()) return null;
  if (!targetResult || !targetResult.ok) {
    clearXOpenWatch();
    throw new Error(targetResult?.message || targetResult?.error || "已打开任务详情，但未能点击在 X 打开/前往目标");
  }

  runtimeState.currentTask = mergeTaskPreservingCapturedTweetUrl(runtimeState.currentTask, targetResult.task);
  markAttemptedTask(runtimeState.currentTask);

  const tweetTabId = await ensureTweetTabAfterTargetClick(lighthouseTabId, settings, runtimeState.currentTask, "debug", isCurrent);
  if (!isCurrent()) return null;
  if (tweetTabId) return tweetTabId;
  throw new Error("已点击在 X 打开/前往目标，但多次复核仍未检测到 Lighthouse 打开的 X 推文页");
}

async function openSelectedTaskTweetTab(selectedTask, settings, stillCurrent = null) {
  const openingState = runtimeState;
  const runId = runtimeState.runId;
  const isCurrent = () => runtimeState === openingState && runtimeState.runId === runId
    && runtimeState.running && !runtimeState.manuallyStopped && (!stillCurrent || stillCurrent());
  if (!isCurrent()) return null;
  if (isIgnoredNonCommentTask(selectedTask)) {
    throw new Error("已忽略原创/转发任务，不打开详情");
  }
  setStage("selected_task_opening");
  const lighthouseTabId = await resolveLighthouseTab(isCurrent);
  if (!isCurrent()) return null;
  await rememberLighthouseTabById(lighthouseTabId, isCurrent);
  if (!isCurrent()) return null;
  await chrome.tabs.update(lighthouseTabId, { active: true });
  if (!isCurrent()) return null;
  await waitForTabComplete(lighthouseTabId);
  if (!isCurrent()) return null;
  log("info", `已选择倒计时任务，打开详情提取推文链接：${selectedTask.bounty || "?"}LUX · ${selectedTask.title || selectedTask.taskType || "任务"}`);
  beginXOpenWatch(lighthouseTabId, "debug");

  const result = await sendToTab(lighthouseTabId, {
    type: "OPEN_SELECTED_COUNTDOWN_TASK_TWEET",
    runId,
    settings,
    selectedTask
  });
  if (!isCurrent()) return null;
  if (!result || !result.ok) {
    clearXOpenWatch();
    throw new Error(result?.message || result?.error || "选中任务详情未找到可点击的在 X 打开/前往目标控件");
  }

  runtimeState.currentTask = mergeTaskPreservingCapturedTweetUrl(runtimeState.currentTask, result.task);
  const tweetTabId = await ensureTweetTabAfterTargetClick(lighthouseTabId, settings, result.task, "debug", isCurrent);
  if (!isCurrent()) return null;
  if (tweetTabId) return tweetTabId;
  throw new Error("已点击在 X 打开控件，但多次复核仍未检测到 Lighthouse 打开的 X 推文页");
}

async function ensureTweetTabAfterTargetClick(lighthouseTabId, settings, task, mode, stillCurrent = null) {
  const openingState = runtimeState;
  const runId = runtimeState.runId;
  const isCurrent = () => runtimeState === openingState && runtimeState.runId === runId
    && runtimeState.running && !runtimeState.manuallyStopped && (!stillCurrent || stillCurrent());
  if (!isCurrent()) return null;
  runtimeState.currentTask = mergeTaskPreservingCapturedTweetUrl(runtimeState.currentTask, task);
  if (runtimeState.currentTask?.seatLocked === true) {
    const adopted = await waitForLighthouseOpenedTweet(runtimeState.currentTask, lighthouseTabId, mode, {
      timeoutMs: 30000, manualOpenAfterMs: SITE_X_OPEN_WAIT_MS
    });
    if (!isCurrent()) return null;
    return adopted ? runtimeState.xTabId : null;
  }
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const directTabId = await openDirectTweetTabIfAvailable(runtimeState.currentTask, lighthouseTabId, { isCurrent });
    if (!isCurrent()) return null;
    if (directTabId) return directTabId;

    const adopted = await waitForLighthouseOpenedTweet(runtimeState.currentTask, lighthouseTabId, mode, {
      timeoutMs: attempt === maxAttempts ? 10000 : 5000,
      logEveryMs: 2500
    });
    if (!isCurrent()) return null;
    if (adopted && runtimeState.xTabId) {
      log("info", `已接管 Lighthouse 打开的 X 推文：${runtimeState.currentTask?.tweetUrl || ""}`);
      return runtimeState.xTabId;
    }

    const navigating = runtimeState.pendingXOpen && await hasPendingSiteXNavigation(lighthouseTabId, isCurrent);
    if (!isCurrent() || navigating) return null;
    clearXOpenWatch();
    if (attempt >= maxAttempts) break;

    log("warn", `X 推文标签未出现，第 ${attempt + 1}/${maxAttempts} 次重新点击在 X 打开/前往目标`);
    await chrome.tabs.update(lighthouseTabId, { active: true });
    if (!isCurrent()) return null;
    await waitForTabComplete(lighthouseTabId);
    if (!isCurrent()) return null;
    await delay(Math.max(settings.actionDelayMs || 500, 800));
    if (!isCurrent()) return null;
    beginXOpenWatch(lighthouseTabId, mode);
    const retryResult = await sendToTab(lighthouseTabId, {
      type: "OPEN_CURRENT_DETAIL_TWEET_TARGET",
      runId,
      settings
    });
    if (!isCurrent()) return null;
    if (!retryResult || !retryResult.ok) {
      throw new Error(retryResult?.message || retryResult?.error || "重新点击在 X 打开/前往目标失败");
    }
    runtimeState.currentTask = mergeTaskPreservingCapturedTweetUrl(runtimeState.currentTask, retryResult.task);
  }
  return null;
}

async function openDirectTweetTabIfAvailable(task, lighthouseTabId, options = {}) {
  const openingState = runtimeState;
  const openingRunId = runtimeState.runId;
  const openingTask = runtimeState.currentTask;
  const isCurrent = () => runtimeState === openingState && runtimeState.runId === openingRunId
    && runtimeState.running
    && runtimeState.currentTask === openingTask
    && !runtimeState.currentTask?.claimRejected && !runtimeState.currentTask?.lockFailed
    && !runtimeState.manuallyStopped && (!options.isCurrent || options.isCurrent());
  if (!isCurrent()) return null;
  if (task?.claimRejected || task?.lockFailed) return null;
  const tweetUrl = normalizeTweetUrl(task?.tweetUrl);
  if (!tweetUrl || (task?.awaitingXTabAdoption && !options.allowAwaitingXTabAdoption)) return null;
  const existing = await getBoundMatchingTaskXTab(tweetUrl, isCurrent);
  if (!isCurrent()) return null;
  if (existing) return existing.id;
  if (directTweetOpenPromise) return directTweetOpenPromise;

  const runId = runtimeState.runId;
  const opening = (async () => {
    const rebound = await getBoundMatchingTaskXTab(tweetUrl, isCurrent);
    if (!isCurrent()) return null;
    if (rebound) return rebound.id;
    if (runtimeState.runId !== runId || !runtimeState.running) return null;

    const pending = runtimeState.pendingXOpen;
    let siteCandidate = consumeXOpenCandidate(lighthouseTabId, tweetUrl);
    if (!siteCandidate) {
      const queriedCandidate = await findRecentTweetTab(
        pending?.startedAt || Date.now(), lighthouseTabId, getRuntimeWindowId(), tweetUrl
      );
      if (!isCurrent()) return null;
      // A tab event can arrive while tabs.query is still returning its snapshot.
      siteCandidate = consumeXOpenCandidate(lighthouseTabId, tweetUrl) || queriedCandidate;
    }
    if (!isCurrent()) return null;
    if (siteCandidate) {
      adoptCurrentXTab(siteCandidate, task, "site");
      return siteCandidate.id;
    }

    const navigating = await hasPendingSiteXNavigation(lighthouseTabId, isCurrent);
    if (!isCurrent() || navigating) return null;
    const lateCandidate = consumeXOpenCandidate(lighthouseTabId, tweetUrl);
    if (lateCandidate) {
      adoptCurrentXTab(lateCandidate, task, "site");
      return lateCandidate.id;
    }
    clearXOpenWatch();
    const createProperties = { url: tweetUrl, active: true, openerTabId: lighthouseTabId };
    const targetWindowId = getRuntimeWindowId();
    if (Number.isInteger(targetWindowId)) createProperties.windowId = targetWindowId;
    const tweetTab = await chrome.tabs.create(createProperties);
    if (!isCurrent()) return null;
    await focusTaskXTab(tweetTab.id, tweetTab.windowId);
    if (!isCurrent()) return null;
    runtimeState.xTabId = tweetTab.id;
    runtimeState.xTabWindowId = tweetTab.windowId;
    runtimeState.currentTask = mergeTaskPreservingCapturedTweetUrl(runtimeState.currentTask, task, {
      tweetUrl,
      xOpenSource: options.source || "extension_fallback",
      currentPageAdopted: false
    });
    log("info", `已通过任务详情直链打开 X 推文：${tweetUrl}`);
    return tweetTab.id;
  })();
  directTweetOpenPromise = opening;
  try {
    return await opening;
  } finally {
    if (directTweetOpenPromise === opening) directTweetOpenPromise = null;
  }
}

async function generateAIReplyForTweet(tweet, task, runId = runtimeState.runId) {
  const controller = new AbortController();
  activeAIRequests.add(controller);
  try {
    const settings = await getSettings();
    if (controller.signal.aborted || runId !== runtimeState.runId || !runtimeState.running) throw new Error("任务已停止，未请求 AI 回复");
    const result = await generateLighthouseAIReply(
      {
        provider: settings.aiProvider,
        model: settings.aiModel,
        apiUrl: settings.aiApiUrl,
        apiKey: settings.aiApiKey,
        systemPrompt: settings.aiSystemPrompt
      },
      {
        ...(tweet || {}),
        url: (tweet && tweet.url) || (task && task.tweetUrl) || ""
      },
      { signal: controller.signal, timeout: 120000 }
    );
    if (controller.signal.aborted || runId !== runtimeState.runId || !runtimeState.running) throw new Error("任务已停止，丢弃 AI 结果");
    runtimeState.currentTask = {
      ...(runtimeState.currentTask || task || {}),
      generatedReplyText: result.replyText,
      tweetContent: result.tweetContent,
      aiReplyDiagnostics: Array.isArray(result.diagnostics) ? result.diagnostics : []
    };
    const failedDiagnostics = (result.diagnostics || []).filter((item) => item && !item.ok);
    if (result.fallback) {
      logReplyDiagnostics(result.diagnostics);
      log("warn", `AI 请求失败，使用用户兜底回复：${result.replyText}`);
    } else {
      if (failedDiagnostics.length) logReplyDiagnostics(result.diagnostics);
      log("info", `AI 已生成回复：${result.replyText}`);
    }
    return { ok: true, replyText: result.replyText, tweetContent: result.tweetContent, provider: result.provider, state: runtimeState };
  } catch (error) {
    if (Array.isArray(error?.diagnostics) && error.diagnostics.length) {
      logReplyDiagnostics(error.diagnostics);
    }
    throw error;
  } finally {
    activeAIRequests.delete(controller);
  }
}

function logReplyDiagnostics(diagnostics = []) {
  const items = Array.isArray(diagnostics) ? diagnostics : [];
  if (!items.length) {
    log("warn", "AI失败详情：未收到诊断信息");
    return;
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index] || {};
    const level = item.ok ? "info" : "warn";
    log(level, formatReplyDiagnosticLogLine(item));
  }
}

function formatReplyDiagnosticLogLine(item) {
  const raw = item.raw || "<空>";
  const normalized = item.normalized || "<空>";
  const reasonText = item.reasonText || item.reason || "未知原因";
  const countText = Number.isFinite(item.charCount) ? `，中文字数=${item.charCount}` : "";
  const prefix = item.ok ? "AI生成通过" : "AI生成失败";
  return `${prefix} ${item.stage || "未知轮次"}：生成「${raw}」，清洗后「${normalized}」${countText}，原因：${reasonText}`;
}

async function debugCloseXReturnLighthouse() {
  const commandState = runtimeState;
  const runId = runtimeState.runId;
  const isCurrent = () => runtimeState === commandState && runtimeState.runId === runId && runtimeState.running;
  const cancelled = () => ({ ok: false, cancelled: true, error: "旧关闭 X 步骤已取消", state: runtimeState });
  const tabId = await resolveLighthouseTab(isCurrent);
  if (!isCurrent()) return cancelled();
  if (!runtimeState.xTabId) {
    const activeTweetTab = await getActiveTweetTab({ windowId: getRuntimeWindowId() });
    if (!isCurrent()) return cancelled();
    if (activeTweetTab) {
      runtimeState.xTabId = activeTweetTab.id;
      runtimeState.xTabWindowId = activeTweetTab.windowId;
    }
  }

  if (runtimeState.xTabId) {
    const closed = await closeRecordedXTab("调试流程：已关闭 X 标签页", isCurrent);
    if (!isCurrent()) return cancelled();
    if (!closed) return failStep(null, "关闭 X 标签页失败，停止后续流程");
  }

  await chrome.tabs.update(tabId, { active: true });
  if (!isCurrent()) return cancelled();
  setStage("returned_lighthouse");
  log("info", "已关闭 X 并回到 Lighthouse");
  return { ok: true, state: runtimeState };
}

async function debugCompleteXTaskWidget() {
  const commandState = runtimeState;
  const runId = runtimeState.runId;
  const isCurrent = () => runtimeState === commandState && runtimeState.runId === runId && runtimeState.running;
  const cancelled = () => ({ ok: false, cancelled: true, error: "旧提交步骤已取消", state: runtimeState });
  const tabId = runtimeState.xTabId || (await resolveCurrentXTab({ allowActiveTweetTab: true }, isCurrent));
  if (!isCurrent()) return cancelled();
  const settings = await getSettingsForRun(isCurrent);
  if (!isCurrent()) return cancelled();
  const result = await completeXTaskWidgetLifecycle(tabId, runId, settings);
  if (!isCurrent()) return cancelled();
  if (!result?.ok) {
    setStage("x_task_completion_failed");
    log("warn", result?.message || "X 任务提交未确认，保留当前页面");
    return { ok: false, result, state: runtimeState };
  }
  setStage("x_task_completed");
  return { ok: true, result, state: runtimeState };
}

async function debugWaitLighthouseCompletionReturn() {
  const commandState = runtimeState;
  const runId = runtimeState.runId;
  const isCurrent = () => runtimeState === commandState && runtimeState.runId === runId && runtimeState.running;
  const cancelled = () => ({ ok: false, cancelled: true, error: "旧核对步骤已取消", state: runtimeState });
  const settings = await getSettingsForRun(isCurrent);
  if (!isCurrent()) return cancelled();
  const result = await waitForLighthouseTaskCompletionAndReturn(runId, settings, isCurrent);
  if (!isCurrent()) return cancelled();
  if (!result?.ok) {
    setStage("lighthouse_completion_failed");
    log("warn", result?.message || "Lighthouse 未确认任务完成，保留 X 页面");
    return { ok: false, result, state: runtimeState };
  }
  setStage("campaigns_returned");
  return { ok: true, result, state: runtimeState };
}

async function debugClickDone() {
  const commandState = runtimeState;
  const runId = runtimeState.runId;
  const isCurrent = () => runtimeState === commandState && runtimeState.runId === runId && runtimeState.running;
  const cancelled = () => ({ ok: false, cancelled: true, error: "旧完成步骤已取消", state: runtimeState });
  const tabId = await resolveLighthouseTab(isCurrent);
  if (!isCurrent()) return cancelled();
  const settings = await getSettingsForRun(isCurrent);
  if (!isCurrent()) return cancelled();
  await chrome.tabs.update(tabId, { active: true });
  if (!isCurrent()) return cancelled();
  const result = await sendToTab(tabId, { type: "DEBUG_CLICK_I_DONE", runId, settings });
  if (!isCurrent()) return cancelled();
  if (!result || !result.ok) return failStep(result, "点击我已完成失败");
  runtimeState.completed += 1;
  setStage("done_clicked");
  log("info", result.message || "已点击我已完成");
  return { ok: true, result, state: runtimeState };
}

async function debugReturnCampaigns() {
  const commandState = runtimeState;
  const runId = runtimeState.runId;
  const isCurrent = () => runtimeState === commandState && runtimeState.runId === runId && runtimeState.running;
  const cancelled = () => ({ ok: false, cancelled: true, error: "旧返回广场步骤已取消", state: runtimeState });
  const tabId = await resolveLighthouseTab(isCurrent);
  if (!isCurrent()) return cancelled();
  const settings = await getSettingsForRun(isCurrent);
  if (!isCurrent()) return cancelled();
  const closed = await closeLighthouseDetailToCampaigns(tabId, settings, "调试流程：关闭任务详情回到广场", isCurrent);
  if (!isCurrent()) return cancelled();
  if (!closed) return failStep({ message: "未确认任务详情已关闭，已保留当前页面" }, "返回任务广场失败");
  setStage("campaigns_returned");
  log("info", "已回到任务广场");
  return { ok: true, state: runtimeState };
}

async function adoptTargetOpenedTweet(task, lighthouseTabId, mode) {
  if (!runtimeState.running) return { ok: false, error: "Run is not active", state: runtimeState };
  const adoptingState = runtimeState;
  const runId = runtimeState.runId;
  const isCurrent = () => runtimeState === adoptingState && runtimeState.runId === runId && runtimeState.running;
  const cancelled = () => ({ ok: false, cancelled: true, state: runtimeState });
  runtimeState.currentTask = mergeTaskPreservingCapturedTweetUrl(runtimeState.currentTask, task);
  runtimeState.mode = mode || runtimeState.mode;
  if (lighthouseTabId) await rememberLighthouseTabById(lighthouseTabId, isCurrent);
  if (!isCurrent()) return cancelled();
  const settings = await getSettingsForRun(isCurrent);
  if (!isCurrent()) return cancelled();
  // Lighthouse commonly opens the target tweet asynchronously after a seat is
  // locked. Waiting for that tab first avoids opening the same tweet twice.
  let adopted = await waitForLighthouseOpenedTweet(runtimeState.currentTask, runtimeState.lighthouseTabId, runtimeState.mode, {
    timeoutMs: 30000,
    logEveryMs: 3000,
    waitLogMessage: "已确认本单锁位，等待平台自动打开 X 推文标签页",
    manualOpenAfterMs: SITE_X_OPEN_WAIT_MS
  });
  if (!isCurrent()) return cancelled();
  if (!adopted && !runtimeState.currentTask?.claimRejected && !runtimeState.currentTask?.lockFailed) {
    const directTweetTabId = await openDirectTweetTabIfAvailable(
      runtimeState.currentTask,
      runtimeState.lighthouseTabId
    );
    if (!isCurrent()) return cancelled();
    if (directTweetTabId) {
      runtimeState.xTabId = directTweetTabId;
      adopted = true;
      log("info", "平台未在等待期打开 X，已使用详情页推文直链兜底打开");
    }
  }
  if (!adopted || !runtimeState.xTabId) {
    const message = runtimeState.lastLockFailureReason || "点击锁定席位后仍未检测到平台自动打开的 X 推文页";
    if (runtimeState.currentTask?.lockFailed || runtimeState.lastLockFailureReason) {
      return recoverAndContinue(message, {
        runId,
        task: { ...(runtimeState.currentTask || {}), seatLocked: false, lockFailed: true },
        closeX: false
      });
    }
    if (["auto", "selected_once"].includes(runtimeState.mode)) {
      runtimeState.failed += 1;
      clearXOpenWatch();
      runtimeState.running = false;
      setStage("locked_task_target_unavailable");
      log("error", `${message}；已保留平台进行中订单，停止扫描新任务以避免订单串单`);
      return { ok: false, error: message, state: runtimeState };
    }
    return failStep({ task: runtimeState.currentTask }, message);
  }

  setStage("tweet_opened");
  log("info", runtimeState.currentTask?.xOpenSource === "extension_fallback"
    ? "官网未在 5 秒内打开 X，已使用任务直链兜底打开目标推文页"
    : "已检测到 Lighthouse 官网打开的目标 X 推文页");
  if (!["auto", "selected_once"].includes(runtimeState.mode)) return { ok: true, state: runtimeState };

  const incomeAtTaskStart = await readPlazaTodayIncome(runtimeState.lighthouseTabId, runId);
  if (!isCurrent()) return cancelled();
  runtimeState.incomeAtTaskStart = incomeAtTaskStart;
  const xTabId = runtimeState.xTabId;
  await waitForXReadyBeforeReply(xTabId, settings, isCurrent);
  if (!isCurrent()) return cancelled();
  const replyResult = await sendToTab(xTabId, {
    type: "RUN_X_REPLY",
    runId,
    task: runtimeState.currentTask,
    settings
  });
  if (!isCurrent()) return cancelled();
  if (!replyResult || !replyResult.ok) {
    return recoverAndContinue(replyResult?.message || replyResult?.error || "接管当前 X 标签页后回复失败，退回任务广场继续下一单", {
      runId,
      task: runtimeState.currentTask,
      closeX: false
    });
  }
  return handleXReplyResult(replyResult, { runId });
}

async function waitForXReadyBeforeReply(tabId, settings, stillCurrent = null) {
  const waitingState = runtimeState;
  const runId = runtimeState.runId;
  const isCurrent = () => runtimeState === waitingState && runtimeState.runId === runId
    && runtimeState.running && (!stillCurrent || stillCurrent());
  if (!isCurrent()) return false;
  setStage("waiting_x_ready");
  await focusTaskXTab(tabId);
  if (!isCurrent()) return false;
  log("info", "X 推文页已打开并切到前台，等待页面加载和前端水合后再回复");
  await waitForTabComplete(tabId);
  if (!isCurrent()) return false;
  await delay(Math.max(settings.actionDelayMs * 2, 2500));
  return isCurrent();
}

async function focusTaskXTab(tabId, knownWindowId = null, stillCurrent = null) {
  const focusingState = runtimeState;
  const runId = runtimeState.runId;
  const isCurrent = () => runtimeState === focusingState && runtimeState.runId === runId
    && runtimeState.running && (!stillCurrent || stillCurrent());
  if (!isCurrent()) return null;
  if (!Number.isInteger(tabId)) throw new Error("缺少当前 X 标签页，无法切到前台");
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (!isCurrent()) return null;
  const windowId = Number.isInteger(knownWindowId) ? knownWindowId : tab.windowId;
  if (Number.isInteger(windowId)) await chrome.windows.update(windowId, { focused: true });
  if (!isCurrent()) return null;
  runtimeState.xTabId = tab.id;
  runtimeState.xTabWindowId = tab.windowId;
  return tab;
}

async function completeXTaskWidgetLifecycle(tabId, runId, settings, stillCurrent = null) {
  const completingState = runtimeState;
  const isCurrent = () => runtimeState === completingState && runtimeState.runId === runId
    && runtimeState.running && (!stillCurrent || stillCurrent());
  const cancelled = () => ({ ok: false, cancelled: true });
  if (!isCurrent()) return cancelled();
  if (!tabId) return { ok: false, message: "未记录当前 X 标签页，无法提交任务" };
  // A manual takeover changes runId, and a refreshed Lighthouse document
  // loses its local watcher. Arm this run before the X submission can finish.
  if (Number.isInteger(runtimeState.lighthouseTabId) && runtimeState.currentTask?.taskKey) {
    const watch = await sendToTab(runtimeState.lighthouseTabId, {
      type: "BEGIN_LIGHTHOUSE_COMPLETION_WATCH", runId, task: runtimeState.currentTask
    });
    if (!isCurrent()) return cancelled();
    if (!watch?.ok) return { ok: false, message: "本单完成监测未就绪，保留订单，尚未提交 X 验证" };
  }
  setStage("x_task_completion_waiting");
  log("info", "X 动作已完成，按任务实际停留进度等待控件解锁提交");
  const completionWatch = { cancelled: false };
  const xSubmission = sendToTab(tabId, {
    type: "COMPLETE_X_TASK_WIDGET",
    runId,
    settings
  }).then((result) => ({ source: "x", result }));
  const officialCompletion = waitForOfficialLighthouseCompletionDuringXSubmission(runId, settings, completionWatch)
    .then((result) => result ? { source: "lighthouse", result } : new Promise(() => {}));
  const outcome = await Promise.race([xSubmission, officialCompletion]);
  completionWatch.cancelled = true;
  if (!isCurrent()) return cancelled();

  if (outcome.source === "lighthouse") {
    // The platform's own verified-and-paid result is stronger evidence than a
    // still-pending X companion widget. Stop that stale wait and finish here.
    await sendToTab(tabId, { type: "CANCEL_X_RUN", runId });
    if (!isCurrent()) return cancelled();
    setStage("lighthouse_official_completion_detected");
    log("info", "Lighthouse 已显示验证通过，准备返回任务广场；到账状态以平台为准");
    return {
      ok: true,
      officialCompletion: true,
      message: "Lighthouse 已验证通过，奖励状态以平台为准"
    };
  }

  const result = outcome.result;
  if (result?.completed && result.evidence?.source === "lighthouse_x_widget"
      && latchLighthouseCompletion(result.evidence, runId)) {
    await persistAutoRunState(true);
    if (!isCurrent()) return cancelled();
    return result;
  }
  if (!result?.ok) {
    const official = await sendToTab(runtimeState.lighthouseTabId, { type: "CHECK_LIGHTHOUSE_OFFICIAL_COMPLETION", runId });
    if (!isCurrent()) return cancelled();
    if (official?.completed && latchLighthouseCompletion(official.evidence, runId)) {
      return { ok: true, officialCompletion: true, message: "X 控件不可读，但本单官网已确认完成" };
    }
  }
  if (result?.ok) {
    setStage(result.submissionResultUnknown ? "x_task_verification_pending" : "x_task_submitted");
    log("info", result.message || "X 任务已提交，等待 Lighthouse 显示完成页");
  }
  return result;
}

async function waitForOfficialLighthouseCompletionDuringXSubmission(runId, settings, control = {}) {
  const tabId = runtimeState.lighthouseTabId;
  if (!Number.isInteger(tabId)) return null;
  const timeoutMs = Math.max(60000, Number(settings.lockSeatTimeoutMs || 0));
  const startedAt = Date.now();
  while (!control.cancelled && runtimeState.running && runtimeState.runId === runId && Date.now() - startedAt < timeoutMs) {
    const result = await sendToTab(tabId, {
      type: "CHECK_LIGHTHOUSE_OFFICIAL_COMPLETION",
      runId
    });
    if (result?.ok && result.completed && latchLighthouseCompletion(result.evidence, runId)) return result;
    await delay(500);
  }
  return null;
}

async function waitForLighthouseTaskCompletionAndReturn(runId, settings, isCurrent = () => runId === runtimeState.runId && runtimeState.running) {
  const cancelled = () => ({ ok: false, cancelled: true });
  if (!isCurrent()) return cancelled();
  const tab = await getOrCreateLighthouseTab(LIGHTHOUSE_CAMPAIGNS_URL, isCurrent);
  if (!isCurrent()) return cancelled();
  const tabId = tab.id;
  await rememberLighthouseTabById(tabId, isCurrent);
  if (!isCurrent()) return cancelled();
  if (!hasLatchedLighthouseCompletion(runId) && Number.isInteger(runtimeState.xTabId)) {
    setStage("lighthouse_completion_waiting");
    log("info", "已提交，原地等待平台自动验证；只读取本单状态，不进入进行中查单");
    const passive = await waitForPassiveTaskCompletion(runId, settings, tabId, isCurrent);
    if (!isCurrent()) return cancelled();
    if (!passive?.completed) return passive;
  }
  if (hasLatchedLighthouseCompletion(runId)) {
    const closed = await closeLighthouseDetailToCampaigns(tabId, settings, "本单官方完成证据已保存，返回广场", isCurrent);
    if (!isCurrent()) return cancelled();
    return { ok: Boolean(closed), evidence: runtimeState.completionEvidence, message: closed ? "本单已确认完成并返回广场" : "本单已完成，但回广场尚未确认" };
  }
  setStage("lighthouse_completion_waiting");
  log("info", "已提交，等待平台自动验证；保持页面，不进入进行中查单");
  const result = await sendToTab(tabId, {
    type: "WAIT_LIGHTHOUSE_COMPLETION_RETURN",
    runId,
    settings
  });
  if (!isCurrent()) return cancelled();
  const evidenceLatched = Boolean(result?.evidence && latchLighthouseCompletion(result.evidence, runId));
  if (result?.ok) {
    setStage("campaigns_returned");
    log("info", result.message || "已从 Lighthouse 完成页返回任务广场");
    return result;
  }
  if ((result?.completed || evidenceLatched) && hasLatchedLighthouseCompletion(runId)) {
    log("warn", result?.message || "官网已确认本单完成，但任务广场尚未恢复，正在强制回到任务广场");
    const returned = await closeLighthouseDetailToCampaigns(tabId, settings, "官网完成证据已保存，强制回到任务广场", isCurrent);
    if (!isCurrent()) return cancelled();
    if (returned) {
      setStage("campaigns_returned");
      log("info", "本单官方完成证据已保存，已恢复任务广场并准备继续扫描");
      return {
        ok: true,
        completed: true,
        evidence: runtimeState.completionEvidence,
        message: "Lighthouse 已确认完成，任务广场已恢复"
      };
    }
  }
  if (result && !result.ok && result.timedOut) {
    const incomeResult = await verifyCompletionByPlazaIncome(tabId, runId, settings, isCurrent);
    if (!isCurrent()) return cancelled();
    if (incomeResult) return incomeResult;
  }
  return result;
}

async function waitForPassiveTaskCompletion(runId, settings, lighthouseTabId, isCurrent) {
  const deadline = Date.now() + Math.max(60000, Number(settings.lockSeatTimeoutMs || 0));
  while (isCurrent()) {
    const xResult = await sendToTab(runtimeState.xTabId, {
      type: "CHECK_X_TASK_WIDGET_COMPLETION", runId, task: runtimeState.currentTask
    });
    if (!isCurrent()) return { ok: false, cancelled: true };
    if (xResult?.completed && xResult.evidence?.source === "lighthouse_x_widget"
        && latchLighthouseCompletion(xResult.evidence, runId)) {
      log("info", "X 当前任务面板已显示已完成，本单结束，返回广场继续接单");
      return xResult;
    }
    const official = await sendToTab(lighthouseTabId, { type: "CHECK_LIGHTHOUSE_OFFICIAL_COMPLETION", runId });
    if (!isCurrent()) return { ok: false, cancelled: true };
    if (official?.completed && latchLighthouseCompletion(official.evidence, runId)) return official;
    if (Date.now() >= deadline) break;
    await delay(500);
  }
  return { ok: false, timedOut: true, message: "等待平台自动验证超时，已保留本单和原页面，未切换进行中或重复提交" };
}

// Aggregate income is supplementary only: delayed payment for another order
// must never manufacture completion evidence for the current task.
async function verifyCompletionByPlazaIncome(tabId, runId, settings, isCurrent = () => runId === runtimeState.runId && runtimeState.running) {
  if (!isCurrent()) return null;
  const evidence = runtimeState.completionEvidence;
  if (!evidence || evidence.runId !== runId
      || evidence.taskKey !== runtimeState.currentTask?.taskKey
      || (evidence.incomeVerified && !evidence.officialCompletion)) return null;
  const bounty = Number(runtimeState.currentTask?.bounty || 0);
  const baseline = Number(runtimeState.incomeAtTaskStart);
  if (runId !== runtimeState.runId || !runtimeState.running) return null;
  if (!(bounty > 0) || !Number.isFinite(baseline)) return null;
  await closeLighthouseDetailToCampaigns(tabId, settings, "完成弹窗未出现，先回广场核账", isCurrent);
  if (!isCurrent()) return null;
  const incomeNow = await readPlazaTodayIncome(tabId, runId);
  if (!isCurrent()) return null;
  if (!Number.isFinite(incomeNow) || incomeNow + 1e-9 - baseline < bounty) {
    log("warn", `完成弹窗未出现，且今日收入未见本单赏金（开始 ${baseline}，当前 ${Number.isFinite(incomeNow) ? incomeNow : "不可读"}），仍按未完成处理`);
    return null;
  }
  if (!latchIncomeVerifiedCompletion(runId)) return null;
  const returned = await closeLighthouseDetailToCampaigns(tabId, settings, "收入核验通过，返回广场", isCurrent);
  if (!isCurrent()) return null;
  setStage("campaigns_returned");
  log("warn", `官网完成弹窗未出现，但任务广场今日收入已入账本单赏金（+${bounty} LUX），按已到账处理并返回广场`);
  return {
    ok: true,
    completed: true,
    incomeVerified: true,
    evidence: runtimeState.completionEvidence,
    message: returned ? "收入核验通过，本单按已完成处理并返回广场" : "收入核验通过，本单按已完成处理"
  };
}

async function readPlazaTodayIncome(tabId, runId = runtimeState.runId) {
  const result = await sendToTab(tabId, { type: "READ_LIGHTHOUSE_TODAY_INCOME", runId });
  if (result?.ok && Number.isFinite(Number(result.income))) return Number(result.income);
  return Number.NaN;
}

function latchIncomeVerifiedCompletion(runId) {
  if (runId !== runtimeState.runId || !runtimeState.running || !runtimeState.currentTask?.taskKey) return false;
  const evidence = runtimeState.completionEvidence;
  if (!evidence || evidence.runId !== runId
      || evidence.taskKey !== runtimeState.currentTask.taskKey
      || (evidence.incomeVerified && !evidence.officialCompletion)) return false;
  runtimeState.completionEvidence = {
    ...evidence,
    officialCompletion: true,
    incomeVerified: true
  };
  touchAutoRunState();
  return true;
}

function latchLighthouseCompletion(evidence, runId) {
  if (!evidence || runId !== runtimeState.runId || !runtimeState.running
      || evidence.runId !== runId || !evidence.taskKey
      || evidence.taskKey !== runtimeState.currentTask?.taskKey) return false;
  const expectedUrl = normalizeTweetUrl(runtimeState.currentTask?.tweetUrl || "", true);
  if (evidence.tweetUrl && expectedUrl && normalizeTweetUrl(evidence.tweetUrl, true) !== expectedUrl) return false;
  runtimeState.completionEvidence = { ...evidence };
  runtimeState.uncertainAction = null;
  return true;
}

function hasLatchedLighthouseCompletion(runId) {
  const evidence = runtimeState.completionEvidence;
  return Boolean(evidence && evidence.runId === runId && evidence.taskKey === runtimeState.currentTask?.taskKey
    && (!evidence.incomeVerified || evidence.officialCompletion));
}

async function handleXReplyResult(result, message = {}) {
  if (!isCurrentRunMessage(message)) return { ok: true, state: runtimeState };
  if (!runtimeState.running) return { ok: false, error: "Run is not active" };
  const runId = runtimeState.runId;
  const replyState = runtimeState;
  const isCurrent = () => runtimeState === replyState && runtimeState.runId === runId && runtimeState.running;
  runtimeState.lastXResult = result || null;
  log(result && result.ok ? "info" : "error", result && result.message ? result.message : "X 回复步骤结束");
  if (result?.ok) await recordReplyHistory(result);
  if (!isCurrent()) return { ok: false, cancelled: true };

  if (runtimeState.mode === "debug") {
    setStage(result && result.ok ? "x_replied" : "x_reply_failed");
    if (!result || !result.ok) runtimeState.failed += 1;
    return { ok: true, state: runtimeState };
  }

  if (!result || !result.ok) {
    return recoverAndContinue("X 回复失败，退回任务广场继续下一单", {
      runId,
      task: runtimeState.currentTask,
      closeX: false
    });
  }

  const settings = await getSettingsForRun(isCurrent);
  if (!isCurrent()) return { ok: false, cancelled: true };
  const completionResult = await completeXTaskWidgetLifecycle(runtimeState.xTabId, runId, settings);
  if (!isCurrent()) return { ok: false, cancelled: true };
  if (!completionResult?.ok) {
    return recoverAndContinue(
      completionResult?.message || completionResult?.error || "X 任务闭环未确认",
      { runId, task: runtimeState.currentTask, closeX: false }
    );
  }

  const campaignsResult = await waitForLighthouseTaskCompletionAndReturn(runId, settings);
  if (runId !== runtimeState.runId || !runtimeState.running) return { ok: false, cancelled: true };
  if (!campaignsResult?.ok) {
    return recoverAndContinue(
      campaignsResult?.message || "Lighthouse 未确认任务完成",
      { runId, task: runtimeState.currentTask, closeX: false }
    );
  }
  if (campaignsResult.pendingVerification) {
    markPendingVerification(runtimeState.currentTask);
    setStage("verification_pending");
    runtimeState.running = false;
    log("warn", `${campaignsResult.message || "已回到任务广场，当前订单仍待 Lighthouse 官方验证"}；已保留订单并停止扫描，等待人工重新核对官方结果`);
    return { ok: true, pendingVerification: true, state: runtimeState };
  }
  return handleLighthouseDone({ ok: true, message: campaignsResult.message || "Lighthouse 任务已完成并已返回任务广场" });
}

function markPendingVerification(task) {
  const record = {
    taskKey: task?.taskKey || task?.tweetUrl || `pending-${Date.now()}`,
    tweetUrl: normalizeTweetUrl(task?.tweetUrl || ""),
    title: task?.candidateTitle || task?.title || "Lighthouse 任务",
    createdAt: new Date().toISOString()
  };
  const prior = Array.isArray(runtimeState.pendingVerifications) ? runtimeState.pendingVerifications : [];
  runtimeState.pendingVerifications = [record, ...prior.filter((item) => item.taskKey !== record.taskKey)].slice(0, 50);
}

async function handleLighthouseDone(result, resumeCountedCompletion = false) {
  const runId = runtimeState.runId;
  const doneState = runtimeState;
  const isCurrent = () => runtimeState === doneState && runtimeState.runId === runId && !runtimeState.manuallyStopped;
  if (!isCurrent()) return { ok: false, cancelled: true };
  if (["auto", "selected_once"].includes(runtimeState.mode) && result?.ok && !hasLatchedLighthouseCompletion(runId)) {
    return recoverAndContinue("缺少本单官方完成证据，不计为完成", { runId, task: runtimeState.currentTask, closeX: false });
  }
  const alreadyCounted = Boolean(runtimeState.currentTask?.completionCounted);
  if (alreadyCounted && !resumeCountedCompletion) return { ok: true, duplicate: true };
  const hasLockedTask = Boolean(
    runtimeState.currentTask
    && (runtimeState.currentTask.seatLocked === true || runtimeState.currentTask.seatLockedAt)
  );
  if (result && result.ok) {
    if (!alreadyCounted) {
      if (runtimeState.currentTask) runtimeState.currentTask.completionCounted = true;
      runtimeState.completed += 1;
    }
    touchAutoRunState();
    // Completed cards are excluded by their own 已完成 state; leaving them in
    // the dedupe table is what made every visible task look "stale" and sent
    // the runner into the reload/cooldown spin right after a finished batch.
    releaseAttemptedTask(runtimeState.currentTask);
    log("info", result.message || "Lighthouse 任务已完成");
  } else {
    runtimeState.failed += 1;
    log("error", result && result.message ? result.message : "Lighthouse 完成步骤失败");
  }

  const settings = await getSettingsForRun(isCurrent);
  if (!isCurrent()) return { ok: false, cancelled: true };
  const orderReloadReason = result?.ok ? "接单完成，已重新加载任务广场" : "接单失败，已重新加载任务广场";
  if (result?.ok || !hasLockedTask) {
    await closeLighthouseDetailToCampaigns(
      runtimeState.lighthouseTabId,
      settings,
      "正式模式订单结束后关闭任务详情回到广场",
      isCurrent
    );
    if (!isCurrent()) return { ok: false, cancelled: true };
    const reloaded = await reloadLighthouseCampaignsAfterOrder(runtimeState.lighthouseTabId, orderReloadReason, isCurrent);
    if (!isCurrent()) return { ok: false, cancelled: true };
    if (reloaded === false) {
      runtimeState.running = false;
      setStage("campaigns_reload_failed");
      return { ok: false, error: "订单结束后重新加载任务广场失败，已停止扫描", state: runtimeState };
    }
  }
  if (!result?.ok && !settings.autoSubmitLighthouse) {
    runtimeState.running = false;
    setStage("finished");
    log("warn", "自动提交已关闭，正式模式停止，避免回复后任务未提交仍继续下一张");
    return { ok: true, state: runtimeState };
  }
  const canContinue = runtimeState.mode === "auto" && runtimeState.running && !isLimitReached(runtimeState.completed, settings.maxTasksPerRun);
  if (!canContinue) {
    runtimeState.running = false;
    setStage(runtimeState.mode === "selected_once" ? "selected_flow_done" : "finished");
    log("info", runtimeState.mode === "selected_once" ? "选中任务已完成，已回到任务广场；本次只完成这一单" : "运行结束");
    return { ok: true, state: runtimeState };
  }

  await delay(settings.actionDelayMs * 2);
  if (runId !== runtimeState.runId || !runtimeState.running) return { ok: false, cancelled: true };
  runtimeState.currentTask = null;
  runtimeState.xTabId = null;
  runtimeState.lastXResult = null;
  runtimeState.completionEvidence = null;
  return startNextAutoTask(result && result.ok ? "after_success" : "after_submit_failed");
}

async function recoverAndContinue(message, options = {}) {
  const runId = options.runId || runtimeState.runId;
  const isCurrent = captureRunGuard();
  const cancelled = () => ({ ok: false, cancelled: true, state: runtimeState });
  if (runId !== runtimeState.runId || !runtimeState.running || !["auto", "selected_once"].includes(runtimeState.mode)) return { ok: false, cancelled: true, state: runtimeState };

  runtimeState.failed += 1;
  const task = options.task || runtimeState.currentTask;
  const hasExplicitSeatLockState = Object.prototype.hasOwnProperty.call(task || {}, "seatLocked");
  const protectedOrder = Boolean(options.preserveOrder || runtimeState.uncertainAction || runtimeState.completionEvidence
    || [task, runtimeState.currentTask].some(value => value && (
      value.invitationAccepted || value.claimed || value.seatLocked || value.seatLockedAt)));
  const unclaimed = !protectedOrder
    && ((hasExplicitSeatLockState && task.seatLocked === false) || task?.claimRejected === true);
  if (unclaimed) {
    releaseAttemptedTask(runtimeState.currentTask);
    releaseAttemptedTask(task);
    // A provisional lock was already counted when its click was returned.
    if (!task.claimRejected) runtimeState.attempts += 1;
    runtimeState.currentTask = null;
    runtimeState.lastXResult = null;
    log("info", "已确认未接到单，已解除本任务去重；刷新任务广场后重新检测");
  } else if (options.task) {
    markAttemptedTask(options.task);
  }

  const lockedTask = protectedOrder;
  if (lockedTask) {
    runtimeState.currentTask = {
      ...(runtimeState.currentTask || {}),
      ...(options.task || {})
    };
    clearXOpenWatch();
    runtimeState.running = false;
    setStage("locked_task_recovery_blocked");
    log("error", `${message || "已锁定订单后续步骤异常"}；平台订单仍可能有效，已停止扫描新任务以避免串单`);
    return { ok: false, error: message || "已锁定订单后续步骤异常", state: runtimeState };
  }

  setStage("recovering");
  log("warn", message || "当前任务异常，退回任务广场继续下一单");
  const settings = await getSettingsForRun(isCurrent);
  if (!isCurrent()) return cancelled();

  if (options.closeX !== false) {
    await closeRecordedXTab("异常恢复：已关闭本次 X 标签页", isCurrent);
    if (!isCurrent()) return cancelled();
  }

  try {
    const tab = await getOrCreateLighthouseTab(LIGHTHOUSE_CAMPAIGNS_URL, isCurrent);
    if (!isCurrent()) return cancelled();
    rememberLighthouseTab(tab);
    await closeLighthouseTaskDetail(tab.id, settings, "异常恢复时关闭任务详情", isCurrent);
    if (!isCurrent()) return cancelled();
    const reloaded = await reloadLighthouseCampaignsAfterOrder(tab.id, "接单失败，已重新加载任务广场", isCurrent);
    if (!isCurrent()) return cancelled();
    if (reloaded === false) {
      runtimeState.running = false;
      setStage("campaigns_reload_failed");
      return { ok: false, error: "接单失败后重新加载任务广场失败，已停止扫描", state: runtimeState };
    }
  } catch (error) {
    if (!isCurrent()) return cancelled();
    log("warn", `关闭任务详情失败，稍后重试：${error.message}`);
  }

  if (runtimeState.mode === "selected_once") {
    return finishSelectedRun("selected_task_failed", message || "选中任务未完成", null, settings, isCurrent);
  }
  await delay(Math.max(settings.actionDelayMs * 2, 2000));
  if (!isActiveAutoRun(runId)) return { ok: true, state: runtimeState };
  return startNextAutoTask("recover_after_failure");
}

async function closeRecordedXTab(message, isCurrent = captureRunGuard()) {
  if (!isCurrent()) return false;
  if (!runtimeState.xTabId) return false;
  const xTabId = runtimeState.xTabId;
  const expectedWindowId = runtimeState.xTabWindowId;
  runtimeState.xTabId = null;
  runtimeState.xTabWindowId = null;

  try {
    const tab = await chrome.tabs.get(xTabId);
    if (!isCurrent()) return false;
    if (!Number.isInteger(expectedWindowId) && !Number.isInteger(runtimeState.lighthouseWindowId)) {
      log("warn", `拒绝关闭窗口归属不明的 X 标签页：tab=${xTabId}`);
      return false;
    }
    const sameRecordedWindow = !Number.isInteger(expectedWindowId) || tab.windowId === expectedWindowId;
    const sameLighthouseWindow = isTabInRuntimeWindow(tab);
    if (!sameRecordedWindow || !sameLighthouseWindow) {
      log("warn", `拒绝关闭非本窗口 X 标签页：tab=${xTabId}, window=${tab.windowId}`);
      return false;
    }
    await chrome.tabs.remove(xTabId);
    if (!isCurrent()) return false;
    const closed = await waitForTabClosed(xTabId, 5000);
    if (!isCurrent()) return false;
    if (!closed) {
      throw new Error("关闭后仍能检测到 X 标签页");
    }
    log("info", message || "已关闭本次 X 标签页");
    return true;
  } catch (error) {
    if (!isCurrent()) return false;
    log("warn", `关闭 X 标签页失败：${error.message}`);
    return false;
  }
}

async function getOrCreateLighthouseTab(url, isCurrent = () => true) {
  if (!isCurrent()) return null;
  const safeUrl = isLighthouseUrl(url) ? url : LIGHTHOUSE_CAMPAIGNS_URL;
  if (Number.isInteger(runtimeState.lighthouseTabId)) {
    try {
      const remembered = await chrome.tabs.get(runtimeState.lighthouseTabId);
      if (!isCurrent()) return null;
      if (isLighthouseUrl(remembered.url)) return remembered;
      log("warn", `丢弃非灯塔的残留任务标签：tab=${remembered.id} · ${remembered.url || "about:blank"}`);
    } catch (_) {
      // The remembered tab can disappear while the service worker is asleep.
    }
    if (!isCurrent()) return null;
    runtimeState.lighthouseTabId = null;
  }
  const activeTab = await getActiveLighthouseTab(isCurrent);
  if (!isCurrent()) return null;
  if (activeTab) {
    rememberLighthouseTab(activeTab);
    return activeTab;
  }
  const tabs = await queryLighthouseTabsInRuntimeWindow();
  if (!isCurrent()) return null;
  const campaignsTab = tabs.find((tab) => tab.url && tab.url.includes("/campaigns"));
  if (campaignsTab) {
    rememberLighthouseTab(campaignsTab);
    return campaignsTab;
  }
  const createProperties = { url: safeUrl, active: true };
  const targetWindowId = getRuntimeWindowId();
  if (Number.isInteger(targetWindowId)) createProperties.windowId = targetWindowId;
  const created = await chrome.tabs.create(createProperties);
  if (!isCurrent()) return null;
  rememberLighthouseTab(created);
  return created;
}

async function focusLighthouseTabForAutoScan(tabId, isCurrent = () => true) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (!isCurrent()) return false;
    try {
      await chrome.tabs.update(tabId, { active: true });
      if (!isCurrent()) return false;
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      if (!isTabEditTemporarilyBlocked(error)) throw error;
      if (attempt >= maxAttempts) {
        log("warn", `Lighthouse 标签暂时无法激活（Chrome 正在调整标签）：${error.message || String(error)}`);
        return false;
      }
      log("info", `Lighthouse 标签正在被 Chrome 调整，第 ${attempt}/${maxAttempts} 次稍后重试`);
      await delay(350 * attempt);
    }
  }
  return false;
}

function isTabEditTemporarilyBlocked(error) {
  return /Tabs cannot be edited right now|user may be dragging a tab/i.test(String(error?.message || error || ""));
}

async function getActiveLighthouseTab(isCurrent = () => true) {
  if (!isCurrent()) return null;
  const query = { active: true };
  const targetWindowId = getRuntimeWindowId();
  if (Number.isInteger(targetWindowId)) {
    query.windowId = targetWindowId;
  } else {
    query.currentWindow = true;
  }
  const tabs = await chrome.tabs.query(query);
  if (!isCurrent()) return null;
  const tab = tabs[0];
  if (tab && isLighthouseUrl(tab.url)) {
    rememberLighthouseTab(tab);
    return tab;
  }
  return null;
}

function isLighthouseUrl(url) {
  return /^https:\/\/app\.lhdao\.top\//i.test(String(url || ""));
}

async function queryLighthouseTabsInRuntimeWindow() {
  return queryLighthouseTabs(getRuntimeWindowId());
}

async function queryLighthouseTabs(preferredWindowId = null) {
  const query = { url: "https://app.lhdao.top/*" };
  const targetWindowId = Number.isInteger(preferredWindowId) ? preferredWindowId : getRuntimeWindowId();
  if (Number.isInteger(targetWindowId)) {
    query.windowId = targetWindowId;
  } else {
    query.currentWindow = true;
  }
  return chrome.tabs.query(query);
}

async function returnLighthouseToCampaigns(tabId) {
  if (!tabId) return false;
  await chrome.tabs.update(tabId, { url: LIGHTHOUSE_CAMPAIGNS_URL, active: true });
  await waitForTabComplete(tabId);
  const tab = await chrome.tabs.get(tabId);
  if (!isLighthouseUrl(tab.url)) {
    throw new Error(`回到任务广场复核失败，当前 URL=${tab.url || ""}`);
  }
  return true;
}

async function refreshLighthouseCampaignsTab(tabId, reason = "", isCurrent = () => true) {
  const cancelled = () => ({ ok: false, cancelled: true, skippedCooldown: false, message: "流程已变化，取消旧任务广场刷新" });
  if (!isCurrent()) return cancelled();
  if (!tabId) {
    return { ok: false, skippedCooldown: false, message: "缺少 Lighthouse 标签页，无法刷新任务广场" };
  }
  try {
    const now = Date.now();
    if (now - lastCampaignsRefreshAt < CAMPAIGNS_REFRESH_COOLDOWN_MS) {
      const leftMs = CAMPAIGNS_REFRESH_COOLDOWN_MS - (now - lastCampaignsRefreshAt);
      return {
        ok: false,
        skippedCooldown: true,
        message: `任务广场刷新冷却中，约 ${formatDuration(leftMs)} 后可再次刷新`
      };
    }
    await chrome.tabs.update(tabId, { active: true });
    if (!isCurrent()) return cancelled();
    const readyBeforeReload = await waitForTabComplete(tabId);
    if (!isCurrent()) return cancelled();
    if (readyBeforeReload === false && !await waitForCampaignsReloadReadiness(tabId, isCurrent)) throw new Error("刷新前 Lighthouse 页面加载超时");
    if (!isCurrent()) return cancelled();
    log("info", reason || "准备刷新 Lighthouse 任务广场");
    await chrome.tabs.reload(tabId);
    if (!isCurrent()) return cancelled();
    const readyAfterReload = await waitForTabComplete(tabId);
    if (!isCurrent()) return cancelled();
    if (readyAfterReload === false && !await waitForCampaignsReloadReadiness(tabId, isCurrent)) throw new Error("刷新后 Lighthouse 页面加载超时");
    if (!isCurrent()) return cancelled();
    lastCampaignsRefreshAt = Date.now();
    return { ok: true, skippedCooldown: false, message: "" };
  } catch (error) {
    if (!isCurrent()) return cancelled();
    log("warn", `刷新任务广场失败：${error.message}`);
    return { ok: false, skippedCooldown: false, message: error.message || "刷新任务广场失败" };
  }
}

async function reloadLighthouseCampaignsAfterOrder(tabId, reason = "", isCurrent = () => true) {
  if (!isCurrent()) return false;
  if (!Number.isInteger(tabId)) {
    log("warn", "订单结束后缺少 Lighthouse 任务广场标签页，无法重新加载");
    return false;
  }
  try {
    await chrome.tabs.reload(tabId);
    if (!isCurrent()) return false;
    const loaded = await waitForTabComplete(tabId);
    if (!isCurrent()) return false;
    if (loaded === false && !await waitForCampaignsReloadReadiness(tabId, isCurrent)) throw new Error("刷新后 Lighthouse 页面加载超时");
    if (!isCurrent()) return false;
    lastCampaignsRefreshAt = Date.now();
    log("info", reason || "订单结束，已重新加载 Lighthouse 任务广场");
    return true;
  } catch (error) {
    if (!isCurrent()) return false;
    log("warn", `订单结束后重新加载任务广场失败：${error.message || String(error)}`);
    return false;
  }
}

async function safeReturnLighthouseToCampaigns(tabId) {
  try {
    if (tabId) {
      await returnLighthouseToCampaigns(tabId);
      return true;
    }
  } catch (error) {
    log("warn", `回到任务广场失败：${error.message}`);
  }

  try {
    const tab = await getOrCreateLighthouseTab(LIGHTHOUSE_CAMPAIGNS_URL);
    rememberLighthouseTab(tab);
    await returnLighthouseToCampaigns(tab.id);
    return true;
  } catch (error) {
    log("warn", `重新打开任务广场失败：${error.message}`);
    return false;
  }
}

async function closeLighthouseDetailToCampaigns(tabId, settings, reason, isCurrent = () => true) {
  if (!tabId || !isCurrent()) return false;
  const closed = await closeLighthouseTaskDetail(tabId, settings, reason, isCurrent);
  if (!isCurrent()) return false;
  if (closed) return true;
  log("warn", "页面内回广场未确认，本次不刷新页面，交给后续任务选择复核当前状态");
  return false;
}

async function closeLighthouseTaskDetail(tabId, settings, reason, isCurrent = () => true) {
  if (!tabId || !isCurrent()) return false;
  const runId = runtimeState.runId;
  try {
    await chrome.tabs.update(tabId, { active: true });
    if (!isCurrent()) return false;
    await waitForTabComplete(tabId);
    if (!isCurrent()) return false;
    const result = await sendToTab(tabId, {
      type: "CLOSE_LIGHTHOUSE_TASK_DETAIL",
      runId,
      settings
    });
    if (!isCurrent() || result?.cancelled) return false;
    if (result && result.ok) {
      log("info", result.message || reason || "已关闭任务详情");
      return true;
    }
    log("warn", result?.message || "任务详情关闭未确认");
    // A stuck Lighthouse drawer can remain in the DOM after every close
    // gesture. Reloading the campaigns tab is the reliable recovery path.
    await chrome.tabs.reload(tabId);
    if (!isCurrent()) return false;
    await waitForTabComplete(tabId);
    if (!isCurrent()) return false;
    log("info", "任务详情关闭未确认，已刷新任务广场并继续下一条");
    return true;
  } catch (error) {
    if (!isCurrent()) return false;
    log("warn", `页面内关闭任务详情失败：${error.message}`);
    return false;
  }
}

async function getSettings() {
  // Slow reads must not hold the write queue: STOP and a new START must remain
  // independent of an old run's suspended settings lookup.
  while (true) {
    const revision = settingsOperationRevision;
    const snapshot = await readSettingsSnapshot();
    const settings = await enqueueSettingsOperation(() => readSettingsWithApiKey(snapshot), revision);
    if (settings !== null) return settings;
  }
}

async function getSettingsForRun(isCurrent) {
  try {
    return await getSettings();
  } catch (error) {
    if (isCurrent()) {
      runtimeState.running = false;
      setStage("settings_error");
      log("error", error.message || "无法读取配置，流程已停止");
    }
    throw error;
  }
}

function missingAIKeyMessage(settings, task) {
  if (String(settings?.aiApiKey || "").trim()) return "";
  const types = String(task?.taskType || "").trim().split(/[+＋、/,&，\s]+/).filter(Boolean);
  if (types.length && types.every(type => /^(?:点赞|关注|like|follow)$/i.test(type))) return "";
  // Both native and sola_bridge comment paths generate text in this worker.
  // Unknown automatic selections may include comments and need the same check.
  return "尚未保存 API Key，请输入并保存后再接取评论任务";
}

function blockRunWithoutAIKey(settings, task) {
  const error = missingAIKeyMessage(settings, task);
  if (!error) return null;
  runtimeState.running = false;
  setStage("ai_key_required");
  log("error", error);
  return { ok: false, error, state: runtimeState };
}

function enqueueSettingsOperation(operation, expectedRevision = null) {
  const guarded = async () => {
    // Retry stale snapshots outside the queue without invalidating other readers.
    if (expectedRevision !== null && expectedRevision !== settingsOperationRevision) return null;
    try { return await operation(); }
    finally { settingsOperationRevision += 1; }
  };
  const result = settingsOperationTail.then(guarded, guarded);
  // Unavailable storage must reject this request without poisoning later
  // explicit retries or the independent STOP lifecycle.
  settingsOperationTail = result.catch(() => {});
  return result;
}

function settingsWithoutApiKey(settings) {
  const { aiApiKey: _dedicatedKey, ...persistent } = settings;
  return persistent;
}

async function readStoredApiKey() {
  try {
    const local = chrome.storage.local;
    if (!local?.get || !local?.set || !local?.setAccessLevel) throw new Error("local unavailable");
    await local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    return await local.get([AI_API_KEY_STORAGE_KEY]);
  } catch (_) {
    throw new Error("无法读取本地 API Key，请检查扩展后重试");
  }
}

async function readLegacySessionApiKey() {
  try {
    const session = chrome.storage.session;
    if (!session) return {};
    if (!session.get || !session.setAccessLevel) throw new Error("session unavailable");
    await session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    return await session.get([AI_API_KEY_STORAGE_KEY]);
  } catch (_) {
    throw new Error("无法读取旧会话 API Key，请检查扩展后重试迁移");
  }
}

async function writeStoredApiKey(value) {
  try {
    await chrome.storage.local.set({ [AI_API_KEY_STORAGE_KEY]: value });
  } catch (_) {
    throw new Error("无法保存本地 API Key，配置未保存");
  }
}

async function readSettingsSnapshot() {
  const credential = await readStoredApiKey();
  const session = Object.hasOwn(credential, AI_API_KEY_STORAGE_KEY) ? {} : await readLegacySessionApiKey();
  const stored = await chrome.storage.local.get(["settings"]);
  return { credential, session, stored };
}

async function readSettingsWithApiKey(snapshot = null) {
  const { credential, session, stored } = snapshot || await readSettingsSnapshot();
  const migrated = migrateSettings(stored.settings || {});
  const normalized = normalizeSettings(migrated.settings);
  const hasStoredKey = Object.hasOwn(credential, AI_API_KEY_STORAGE_KEY);
  const hasSessionKey = Object.hasOwn(session, AI_API_KEY_STORAGE_KEY);
  const hasLegacyKey = Object.hasOwn(stored.settings || {}, "aiApiKey");
  const apiKey = hasStoredKey ? String(credential[AI_API_KEY_STORAGE_KEY] || "").trim()
    : hasSessionKey ? String(session[AI_API_KEY_STORAGE_KEY] || "").trim()
      : (hasLegacyKey ? normalized.aiApiKey : "");
  // The dedicated local item, including an explicit empty clear, is authoritative.
  // Persist legacy credentials before removing their only local settings copy.
  if (!hasStoredKey && (hasSessionKey || hasLegacyKey)) await writeStoredApiKey(apiKey);
  const persistent = settingsWithoutApiKey(normalized);
  if (migrated.changed || !stored.settings || hasLegacyKey || stored.settings.aiApiUrl !== normalized.aiApiUrl) {
    await chrome.storage.local.set({ settings: persistent });
  }
  return { ...persistent, aiApiKey: apiKey };
}

async function saveSettingsToStorage(patch = {}) {
  return enqueueSettingsOperation(async () => {
    const current = await readSettingsWithApiKey();
    const hasApiKey = Object.hasOwn(patch || {}, "aiApiKey");
    const normalized = normalizeSettings({ ...current, ...(patch || {}) });
    if (hasApiKey) await writeStoredApiKey(normalized.aiApiKey);
    else normalized.aiApiKey = current.aiApiKey;
    await chrome.storage.local.set({ settings: settingsWithoutApiKey(normalized) });
    return normalized;
  });
}

async function getMonitorSettings() {
  const stored = await chrome.storage.local.get(["monitorSettings"]);
  const normalized = normalizeMonitorSettings(stored.monitorSettings || {});
  if (JSON.stringify(stored.monitorSettings || {}) !== JSON.stringify(normalized)) {
    await chrome.storage.local.set({ monitorSettings: normalized });
  }
  return normalized;
}

async function updateMonitorSettings(patch) {
  const current = await getMonitorSettings();
  const next = normalizeMonitorSettings({ ...current, ...(patch || {}) });
  await chrome.storage.local.set({ monitorSettings: next });
  return next;
}

async function migrateMonitorSettings(legacySettings) {
  const stored = await chrome.storage.local.get(["monitorSettings"]);
  if (stored.monitorSettings && !isDefaultMonitorSettings(stored.monitorSettings)) return getMonitorSettings();
  const next = normalizeMonitorSettings(legacySettings || {});
  await chrome.storage.local.set({ monitorSettings: next });
  return next;
}

function isDefaultMonitorSettings(settings) {
  return JSON.stringify(normalizeMonitorSettings(settings || {})) === JSON.stringify(normalizeMonitorSettings(DEFAULT_MONITOR_SETTINGS));
}

function normalizeMonitorSettings(settings) {
  const merged = { ...DEFAULT_MONITOR_SETTINGS, ...(settings || {}) };
  const minBounty = Number(merged.minBounty);
  const voiceRate = Number(merged.voiceRate ?? merged.rate);
  const voicePitch = Number(merged.voicePitch ?? merged.pitch);
  const voiceEngine = merged.voiceEngine === "browser" ? "browser" : "mimo";
  const voiceName = String(merged.voiceName || "").trim();
  const voiceTemplateAppear = String(
    merged.voiceTemplateAppear || merged.voiceTemplate || DEFAULT_MONITOR_APPEAR_TEMPLATE
  ).trim() || DEFAULT_MONITOR_APPEAR_TEMPLATE;
  const voiceTemplateCountdown2m = String(
    merged.voiceTemplateCountdown2m || merged.voiceTemplateCountdown || DEFAULT_MONITOR_COUNTDOWN_2M_TEMPLATE
  ).trim() || DEFAULT_MONITOR_COUNTDOWN_2M_TEMPLATE;
  const voiceTemplateCountdown1m = String(
    merged.voiceTemplateCountdown1m || DEFAULT_MONITOR_COUNTDOWN_1M_TEMPLATE
  ).trim() || DEFAULT_MONITOR_COUNTDOWN_1M_TEMPLATE;
  const mimoBaseUrl = String(merged.mimoBaseUrl || DEFAULT_MIMO_BASE_URL).trim() || DEFAULT_MIMO_BASE_URL;
  const mimoApiKey = String(merged.mimoApiKey || DEFAULT_MIMO_API_KEY).trim() || DEFAULT_MIMO_API_KEY;
  return {
    enabled: Boolean(merged.enabled),
    minBounty: Number.isFinite(minBounty) ? Math.max(0.1, minBounty) : DEFAULT_MONITOR_SETTINGS.minBounty,
    voiceEnabled: Boolean(merged.voiceEnabled),
    voiceEngine,
    voiceName,
    voiceRate: Number.isFinite(voiceRate) ? Math.max(0.5, Math.min(2, voiceRate)) : DEFAULT_MONITOR_SETTINGS.voiceRate,
    voicePitch: Number.isFinite(voicePitch) ? Math.max(0.5, Math.min(2, voicePitch)) : DEFAULT_MONITOR_SETTINGS.voicePitch,
    voiceTemplateAppear,
    voiceTemplateCountdown2m,
    voiceTemplateCountdown1m,
    mimoBaseUrl,
    mimoApiKey
  };
}

async function broadcastMonitorMessage(message) {
  const lighthouseTabs = await queryLighthouseTabsInRuntimeWindow();
  for (const tab of lighthouseTabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, message);
    } catch (_) {}
  }
}

function migrateSettings(settings) {
  const next = { ...(settings || {}) };
  let changed = false;
  const version = Number.parseInt(next.settingsVersion, 10) || 0;
  if (version < 2) {
    const maxTasks = Number.parseInt(next.maxTasksPerRun, 10);
    const maxAttempts = Number.parseInt(next.maxTaskAttempts, 10);
    if (!Number.isFinite(maxTasks) || maxTasks === 10) {
      next.maxTasksPerRun = 9999;
      changed = true;
    }
    if (!Number.isFinite(maxAttempts) || maxAttempts === 5) {
      next.maxTaskAttempts = 9999;
      changed = true;
    }
    next.settingsVersion = 2;
    changed = true;
  }
  if (version < 3) {
    const currentPrompt = String(next.aiSystemPrompt || "").trim();
    const isLegacyDefaultPrompt = !currentPrompt
      || /加密货币领域KOL/.test(currentPrompt)
      || /生成5-20字/.test(currentPrompt)
      || /中英文为主/.test(currentPrompt);
    if (isLegacyDefaultPrompt) {
      next.aiSystemPrompt = LIGHTHOUSE_DEFAULT_AI_SYSTEM_PROMPT;
      changed = true;
    }
    next.settingsVersion = 3;
    changed = true;
  }
  if (version < 4) {
    const currentPrompt = String(next.aiSystemPrompt || "").trim();
    const isStrictPureChinesePrompt = !currentPrompt
      || /只用中文/.test(currentPrompt)
      || /不要英文/.test(currentPrompt)
      || /不要.*标点/.test(currentPrompt)
      || /生成5到15个汉字/.test(currentPrompt);
    if (isStrictPureChinesePrompt) {
      next.aiSystemPrompt = LIGHTHOUSE_DEFAULT_AI_SYSTEM_PROMPT;
      changed = true;
    }
    next.settingsVersion = 4;
    changed = true;
  }
  if (version < 5) {
    if (!/^\d{2}:\d{2}$/.test(String(next.runWindowStart || "").trim())) {
      next.runWindowStart = DEFAULT_SETTINGS.runWindowStart;
      changed = true;
    }
    if (!/^\d{2}:\d{2}$/.test(String(next.runWindowEnd || "").trim())) {
      next.runWindowEnd = DEFAULT_SETTINGS.runWindowEnd;
      changed = true;
    }
    if (typeof next.runWindowEnabled !== "boolean") {
      next.runWindowEnabled = DEFAULT_SETTINGS.runWindowEnabled;
      changed = true;
    }
    next.settingsVersion = 5;
    changed = true;
  }
  if (version < 6) {
    const parsedMinTaskBounty = Number(next.autoMinTaskBounty);
    if (!Number.isFinite(parsedMinTaskBounty)) {
      next.autoMinTaskBounty = DEFAULT_SETTINGS.autoMinTaskBounty;
      changed = true;
    }
    next.settingsVersion = 6;
    changed = true;
  }
  if (version < 8) {
    delete next.accountTier;
    next.settingsVersion = 8;
    changed = true;
  }
  if (version < 11) {
    const currentPrompt = String(next.aiSystemPrompt || "").trim();
    const isPriorDefaultPrompt = !currentPrompt
      || /像路过随手回一句/.test(currentPrompt)
      || /你是普通中文用户，帮我写一条推文回复/.test(currentPrompt);
    if (isPriorDefaultPrompt) {
      next.aiSystemPrompt = LIGHTHOUSE_DEFAULT_AI_SYSTEM_PROMPT;
      changed = true;
    }
    next.settingsVersion = 11;
    changed = true;
  }
  if (version < 12) {
    if (typeof next.aiModel !== "string") {
      next.aiModel = "";
      changed = true;
    }
    next.settingsVersion = 12;
    changed = true;
  }
  if (version < 13) {
    const currentPrompt = String(next.aiSystemPrompt || "").trim();
    const isPriorDefaultPrompt = !currentPrompt
      || /只回应原文中的一个具体点/.test(currentPrompt)
      || /不要编造持仓、经历、到场、使用效果/.test(currentPrompt);
    if (isPriorDefaultPrompt) {
      next.aiSystemPrompt = LIGHTHOUSE_DEFAULT_AI_SYSTEM_PROMPT;
      changed = true;
    }
    if (next.aiProvider === "gpt-5.6-terra" && !String(next.aiModel || "").trim()) {
      next.aiModel = "gpt-5.6-terra";
      changed = true;
    }
    if (next.replyMode !== "fill" && next.replyMode !== "post") {
      next.replyMode = DEFAULT_SETTINGS.replyMode;
      changed = true;
    }
    next.settingsVersion = 13;
    changed = true;
  }
  if (version < 14) {
    const currentPrompt = String(next.aiSystemPrompt || "").trim();
    if (currentPrompt === LIGHTHOUSE_PREVIOUS_DEFAULT_AI_SYSTEM_PROMPT) {
      next.aiSystemPrompt = LIGHTHOUSE_DEFAULT_AI_SYSTEM_PROMPT;
      changed = true;
    }
    next.settingsVersion = 14;
    changed = true;
  }
  return { settings: next, changed };
}

function normalizeSettings(settings) {
  const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const aiApiUrl = "https://api.vayne.cc.cd/v1/responses";
  const aiApiKey = String(settings?.aiApiUrl || "").trim() === aiApiUrl
    ? String(merged.aiApiKey || "").trim() : "";
  const parsedMax = Number.parseInt(merged.maxTasksPerRun, 10);
  const parsedAttempts = Number.parseInt(merged.maxTaskAttempts, 10);
  const parsedDelay = Number.parseInt(merged.actionDelayMs, 10);
  const parsedLockTimeout = Number.parseInt(merged.lockSeatTimeoutMs, 10);
  const parsedCooldownWait = Number.parseInt(merged.maxCooldownWaitMs, 10);
  const parsedCooldownPoll = Number.parseInt(merged.cooldownPollMs, 10);
  const parsedAutoMinTaskBounty = Number(merged.autoMinTaskBounty);

  return {
    ...merged,
    settingsVersion: 14,
    runMode: merged.runMode === "auto" ? "auto" : "debug",
    actionDelayMs: Number.isFinite(parsedDelay) ? Math.max(500, parsedDelay) : DEFAULT_SETTINGS.actionDelayMs,
    lockSeatTimeoutMs: Number.isFinite(parsedLockTimeout) ? Math.min(Math.max(parsedLockTimeout, 5000), 300000) : DEFAULT_SETTINGS.lockSeatTimeoutMs,
    autoSubmitLighthouse: Boolean(merged.autoSubmitLighthouse),
    autoMinTaskBounty: Number.isFinite(parsedAutoMinTaskBounty) ? Math.min(Math.max(parsedAutoMinTaskBounty, 0), 9999) : DEFAULT_SETTINGS.autoMinTaskBounty,
    maxTasksPerRun: Number.isFinite(parsedMax) ? Math.min(Math.max(parsedMax, 1), 9999) : DEFAULT_SETTINGS.maxTasksPerRun,
    maxTaskAttempts: Number.isFinite(parsedAttempts) ? Math.min(Math.max(parsedAttempts, 1), 9999) : DEFAULT_SETTINGS.maxTaskAttempts,
    enableCooldownSniping: Boolean(merged.enableCooldownSniping),
    maxCooldownWaitMs: Number.isFinite(parsedCooldownWait) ? Math.min(Math.max(parsedCooldownWait, 0), 3600000) : DEFAULT_SETTINGS.maxCooldownWaitMs,
    cooldownPollMs: Number.isFinite(parsedCooldownPoll) ? Math.min(Math.max(parsedCooldownPoll, 200), 5000) : DEFAULT_SETTINGS.cooldownPollMs,
    replyMode: merged.replyMode === "post" ? "post" : "fill",
    replyProvider: merged.replyProvider === "sola_bridge" ? "sola_bridge" : "native",
    readingSimulationMs: Number.isFinite(Number(merged.readingSimulationMs))
      ? Math.min(Math.max(Math.round(Number(merged.readingSimulationMs)), 500), 20000)
      : 4000,
    aiProvider: "openai",
    aiModel: String(merged.aiModel || DEFAULT_SETTINGS.aiModel).trim().slice(0, 128) || DEFAULT_SETTINGS.aiModel,
    aiApiUrl,
    aiApiKey,
    aiSystemPrompt: String(merged.aiSystemPrompt || LIGHTHOUSE_DEFAULT_AI_SYSTEM_PROMPT).trim(),
    runWindowEnabled: false,
    runWindowStart: normalizeClockTime(merged.runWindowStart, DEFAULT_SETTINGS.runWindowStart),
    runWindowEnd: normalizeClockTime(merged.runWindowEnd, DEFAULT_SETTINGS.runWindowEnd)
  };
}

function isLimitReached(count, limit) {
  const parsedLimit = Number.parseInt(limit, 10);
  if (!Number.isFinite(parsedLimit) || parsedLimit >= 9999) return false;
  return count >= parsedLimit;
}

async function recordLighthouseClaimCheckpoint(message, sender) {
  const state = runtimeState;
  const intent = state.uncertainAction;
  const ownsIntent = () => runtimeState === state && state.running && !state.manuallyStopped
    && state.runId === message.runId && state.uncertainAction === intent;
  if (!intent || !ownsIntent() || intent.checkpointRequired !== true || message.version !== 1
      || !message.instanceId || sender?.tab?.id !== intent.tabId || (sender.frameId ?? 0) !== 0
      || message.runId !== intent.runId || message.operationType !== intent.type
      || !message.claimIntentId || message.claimIntentId !== intent.intentId) {
    return { ok: false, error: "接单检查点与当前流程不匹配，未允许点击" };
  }
  if (message.phase === "ready") {
    if (intent.contentInstanceId && intent.contentInstanceId !== message.instanceId) {
      return { ok: false, error: "旧页面的接单意图不能交给另一页面执行" };
    }
    if (intent.checkpointVersion !== 1) {
      intent.checkpointVersion = 1;
      intent.contentInstanceId = message.instanceId;
      intent.claimActionAttempted = false;
    }
  } else if (message.phase === "before_click" && intent.checkpointVersion === 1
      && intent.contentInstanceId === message.instanceId) {
    const settings = await getSettings();
    if (!ownsIntent()) return { ok: false, cancelled: true };
    const error = missingAIKeyMessage(settings, state.currentTask || state.selectedTask);
    if (error) return { ok: false, error };
    // Set in memory before yielding, then persist before acknowledging. A
    // refresh during either await must never release an authorized click.
    intent.claimActionAttempted = true;
  } else {
    return { ok: false, error: "接单检查点未就绪，未允许点击" };
  }
  await persistAutoRunState(true);
  if (!ownsIntent()) return { ok: false, cancelled: true };
  return { ok: true, checkpointRegistered: true, permitClaimClick: message.phase === "before_click",
    claimIntentId: intent.intentId, instanceId: intent.contentInstanceId };
}

function canResumeInterruptedClaimScan(intent, state = runtimeState) {
  const resumableCommand = state.mode === "auto" && intent?.type === "START_LIGHTHOUSE_COMMENT_TASK"
    || state.mode === "selected_once" && state.selectedTask
      && ["OPEN_SELECTED_COUNTDOWN_TASK_DETAIL", "WAIT_SELECTED_COUNTDOWN_AND_LOCK"].includes(intent?.type);
  return state.running === true && !state.manuallyStopped && resumableCommand
    && state.uncertainAction === intent && intent.checkpointRequired === true && intent.checkpointVersion === 1
    && intent.runId === state.runId && intent.tabId === state.lighthouseTabId && Boolean(intent.intentId)
    && intent.claimActionAttempted === false && Boolean(intent.contentInstanceId)
    && !state.completionEvidence && !state.lastXResult
    && ![state.currentTask].some(task => task && (
      task.invitationAccepted || task.claimed || task.seatLocked || task.seatLockedAt));
}

async function sendToTab(tabId, payload) {
  if (runtimeState.manuallyStopped && !payload.type.startsWith("CANCEL_")) return { ok: false, cancelled: true, message: "已手动停止" };
  payload = { ...payload, platform: "lighthouse", task: payload.task || runtimeState.currentTask };
  const claimsOrder = ["START_LIGHTHOUSE_COMMENT_TASK", "DEBUG_OPEN_FIRST_COMMENT_TASK", "OPEN_SELECTED_COUNTDOWN_TASK_DETAIL", "OPEN_SELECTED_COUNTDOWN_TASK_TWEET", "DEBUG_LOCK_SEAT_AND_EXTRACT", "WAIT_SELECTED_COUNTDOWN_AND_LOCK", "RUN_X_WIDGET_CLAIM"].includes(payload.type);
  let claimIntent = null;
  let actionIntent = null;
  let ownsMarketplaceRefresh = false;
  const sentState = runtimeState;
  const sentRunId = runtimeState.runId;
  const stale = () => runtimeState !== sentState || runtimeState.runId !== sentRunId;
  const readOnlyOrCancel = /^(?:CANCEL_|CHECK_|READ_|MONITOR_GET_)/.test(payload.type)
    || ["BEGIN_LIGHTHOUSE_COMPLETION_WATCH", "WAIT_LIGHTHOUSE_COMPLETION_RETURN"].includes(payload.type);
  if (runtimeState.uncertainAction && !readOnlyOrCancel) {
    return { ok: false, uncertain: true, message: "旧动作结果未知，禁止重复执行，请先核对本单" };
  }
  if (payload.settings) {
    const allowed = ["actionDelayMs", "lockSeatTimeoutMs", "autoSubmitLighthouse", "autoMinTaskBounty", "enableCooldownSniping", "maxCooldownWaitMs", "cooldownPollMs", "replyMode", "replyProvider", "readingSimulationMs", "taskDetailLoadTimeoutMs", "detailOverlayStaleMs"];
    payload.settings = Object.fromEntries(allowed.filter((key) => Object.hasOwn(payload.settings, key)).map((key) => [key, payload.settings[key]]));
  }
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    if (payload.runId && !payload.type.startsWith("CANCEL_") &&
        (payload.runId !== runtimeState.runId || !runtimeState.running)) {
      return { ok: false, cancelled: true, message: "流程已停止，不再重试旧消息" };
    }
    try {
      if (!payload.type.startsWith("CANCEL_")) {
        await ensureLighthouseAlertBridge(tabId, () => !stale() && !runtimeState.manuallyStopped);
      }
      if (!payload.type.startsWith("CANCEL_") && (stale() || (payload.runId && !runtimeState.running))) {
        return { ok: false, cancelled: true, message: "流程已变化，未发送旧消息" };
      }
      if (runtimeState.uncertainAction && runtimeState.uncertainAction !== claimIntent
          && runtimeState.uncertainAction !== actionIntent && !readOnlyOrCancel) {
        return { ok: false, uncertain: true, message: "旧动作结果未知，禁止重复执行，请先核对本单" };
      }
      if (claimsOrder && !claimIntent) {
        claimIntent = { type: payload.type, taskKey: payload.task?.taskKey || "", runId: payload.runId, tabId, intentId: createRunId(),
          checkpointRequired: payload.type !== "RUN_X_WIDGET_CLAIM" };
        payload.claimIntentId = claimIntent.intentId;
        payload.claimCheckpointRequired = claimIntent.checkpointRequired;
        runtimeState.uncertainAction = claimIntent;
        // A terminated worker must retain an unanswered claim, even before its task is known.
        await persistAutoRunState(true);
        if (stale() || payload.runId !== runtimeState.runId || !runtimeState.running) {
          if (runtimeState.uncertainAction === claimIntent) {
            delete runtimeState.uncertainAction;
            await persistAutoRunState(true);
          }
          return { ok: false, cancelled: true, message: "流程已停止，未发送接单动作" };
        }
      }
      const irreversible = ["RUN_X_REPLY", "RUN_X_WIDGET_CLAIM", "COMPLETE_X_TASK_WIDGET", "CLICK_X_TASK_VERIFY", "DEBUG_CLICK_I_DONE", "COMPLETE_LIGHTHOUSE_COMMENT_TASK"].includes(payload.type);
      if (irreversible && !claimIntent && !actionIntent) {
        // The worker can disappear while the page is executing. Persist the
        // intent before sending, not only after a channel error is reported.
        actionIntent = { type: payload.type, runId: payload.runId, tabId,
          taskKey: payload.task?.taskKey || "", intentId: createRunId() };
        runtimeState.uncertainAction = actionIntent;
        await persistAutoRunState(true);
        if (stale() || !runtimeState.running || runtimeState.manuallyStopped) return { ok: false, cancelled: true };
      }
      const activeAction = irreversible ? { state: sentState, type: payload.type, runId: payload.runId, tabId, taskKey: payload.task?.taskKey || "" } : null;
      let result;
      if (activeAction) activeTabActions.add(activeAction);
      try {
        result = await chrome.tabs.sendMessage(tabId, payload);
      } finally {
        if (activeAction) activeTabActions.delete(activeAction);
      }
      if (!payload.type.startsWith("CANCEL_") && (stale() || (payload.runId && !runtimeState.running))) {
        return { ok: false, cancelled: true, message: "流程已变化，未采用旧回执" };
      }
      if (actionIntent && runtimeState.uncertainAction === actionIntent
          && (result?.ok === true || result?.actionAttempted === false)) {
        delete runtimeState.uncertainAction;
        await persistAutoRunState(true);
        if (stale() || !runtimeState.running) return { ok: false, cancelled: true };
      }
      if (claimIntent && runtimeState.uncertainAction === claimIntent) {
        const claimedTask = result?.task?.seatLocked || result?.task?.claimed || result?.task?.seatLockedAt;
        const detailProof = result?.detailConfirmation;
        const confirmedDetail = ["DEBUG_OPEN_FIRST_COMMENT_TASK", "OPEN_SELECTED_COUNTDOWN_TASK_DETAIL", "OPEN_SELECTED_COUNTDOWN_TASK_TWEET"].includes(payload.type)
          && result?.ok === true && detailProof?.phase === "detail_ready" && detailProof.invitationResolved === true
          && detailProof.runId === claimIntent.runId && detailProof.type === claimIntent.type
          && detailProof.claimIntentId === claimIntent.intentId
          && Boolean(detailProof.taskKey) && detailProof.taskKey === result.task?.taskKey;
        const rejection = result?.claimRejection;
        const confirmedRejection = result?.ok === false && result.claimActionAttempted === true
          && ["START_LIGHTHOUSE_COMMENT_TASK", "DEBUG_LOCK_SEAT_AND_EXTRACT", "WAIT_SELECTED_COUNTDOWN_AND_LOCK"].includes(payload.type)
          && rejection?.runId === claimIntent.runId && rejection.type === claimIntent.type
          && rejection.claimIntentId === claimIntent.intentId
          && Boolean(rejection.taskKey) && rejection.taskKey === result.task?.taskKey
          && result.task?.seatLocked === false && result.task.claimRejected === true
          && result.claimed !== true && !runtimeState.completionEvidence && !runtimeState.lastXResult
          && ![runtimeState.currentTask, result.task].some(task => task && (
            task.invitationAccepted || task.claimed || task.seatLocked || task.seatLockedAt));
        if (confirmedRejection) result.claimRejectionConfirmed = true;
        // A click can be released only by its own explicit refusal receipt.
        // Older content scripts retain their narrower no-click retry rules.
        const safelyUnclaimed = confirmedRejection || result?.claimActionAttempted === false
          || (result?.ok === false && result.claimActionAttempted !== true
            && (result.transient || result.permanentIgnore || result.refreshRequested || (result.claimed === false && result.clicks === 0)));
        if (confirmedDetail && result.claimActionAttempted === true) {
          // A confirmed invitation may continue on this task, but does not
          // prove a seat lock or authorize abandoning it for another order.
          result.task = { ...result.task, invitationAccepted: { ...claimIntent, taskKey: result.task.taskKey } };
          runtimeState.currentTask = mergeTaskPreservingCapturedTweetUrl(runtimeState.currentTask, result.task);
        }
        if (claimedTask || result?.claimed === true) {
          runtimeState.currentTask = mergeTaskPreservingCapturedTweetUrl(runtimeState.currentTask, result.task || payload.task,
            result.claimed === true ? { claimed: true, seatLocked: true } : {});
        } else if (!safelyUnclaimed && !confirmedDetail) {
          runtimeState.running = false;
          setStage("action_result_unknown");
          // Reconcile a delayed receipt inside the original orchestration,
          // rather than leaving continuation dependent on status polling.
          if (["auto", "selected_once"].includes(sentState.mode)) {
            await reconcileStoppedClaim(true);
            if (stale() || runtimeState.manuallyStopped) return { ok: false, cancelled: true };
            if (!runtimeState.running && runtimeState.stage === "claim_locked_reconciled"
                && runtimeState.currentTask?.claimReconciled && !runtimeState.uncertainAction
                && !runtimeState.lastXResult && !runtimeState.completionEvidence) {
              runtimeState.running = true;
              setStage("claim_confirmed_after_recheck");
              await persistAutoRunState(true);
              if (stale() || !runtimeState.running) return { ok: false, cancelled: true };
              log("info", "已核对本单完整锁位回执，原自动流程继续处理本单");
              return { ok: true, task: runtimeState.currentTask, message: "本单锁位已核对，继续自动流程" };
            }
          }
          log("error", `接单动作 ${payload.type} 未确认订单状态，已停止并保留执行意图；不会自动重试，请先核对本单${result?.message ? `。页面回执：${result.message}` : ""}`);
          return { ok: false, uncertain: true, message: result?.message || "接单回执未确认订单状态，已保留执行意图，请先核对本单" };
        }
        if (safelyUnclaimed && !claimedTask && result?.claimed !== true
          && result.refreshRequested && payload.type === "START_LIGHTHOUSE_COMMENT_TASK"
          && runtimeState.mode === "auto") {
          runtimeState.marketplaceRefreshInFlight = true;
          ownsMarketplaceRefresh = true;
        }
        delete runtimeState.uncertainAction;
        await persistAutoRunState(true);
        if (stale() || (payload.runId && !runtimeState.running)) {
          if (ownsMarketplaceRefresh && !stale()) sentState.marketplaceRefreshInFlight = false;
          return { ok: false, cancelled: true, message: "流程已变化，订单已保存但不再继续旧流程" };
        }
      }
      return result;
    } catch (error) {
      if (ownsMarketplaceRefresh && !stale()) {
        sentState.marketplaceRefreshInFlight = false;
        ownsMarketplaceRefresh = false;
      }
      if (!payload.type.startsWith("CANCEL_") && (stale() || (payload.runId && !runtimeState.running))) {
        return { ok: false, cancelled: true, message: "流程已变化，未将旧错误写入当前任务" };
      }
      if (claimIntent && canResumeInterruptedClaimScan(claimIntent)) {
        // Revoking the intent synchronously also rejects any late permission
        // request from the old document. Its scan may not click without it.
        delete runtimeState.uncertainAction;
        runtimeState.marketplaceRefreshInFlight = true;
        ownsMarketplaceRefresh = true;
        await persistAutoRunState(true);
        if (stale() || !runtimeState.running || runtimeState.manuallyStopped) {
          if (!stale()) sentState.marketplaceRefreshInFlight = false;
          return { ok: false, cancelled: true };
        }
        log("info", "网页连接中断，已确认本轮尚未点击接单；页面恢复后继续扫描");
        return { ok: false, transient: true, refreshRequested: true, claimActionAttempted: false,
          message: "未接单扫描被网页刷新中断，重新加载任务广场后继续检测" };
      }
      if (isReceivingEndMissingError(error)) {
        if (actionIntent && runtimeState.uncertainAction === actionIntent) {
          // No receiver means no dispatch. Only this transport error permits
          // another send; a closed channel after delivery remains unknown.
          delete runtimeState.uncertainAction;
          await persistAutoRunState(true);
          actionIntent = null;
        }
        if (claimIntent && runtimeState.uncertainAction === claimIntent) {
          delete runtimeState.uncertainAction;
          await persistAutoRunState(true);
          claimIntent = null;
        }
        const injected = await ensureContentScriptInjected(tabId, () => !stale() && !runtimeState.manuallyStopped);
        if (injected) {
          await delay(300);
          continue;
        }
      } else if (!readOnlyOrCancel) {
        runtimeState.uncertainAction = claimIntent || actionIntent || { type: payload.type, taskKey: payload.task?.taskKey || "", runId: payload.runId, tabId };
        if (payload.type === "COMPLETE_X_TASK_WIDGET" && ["auto", "selected_once"].includes(sentState.mode)
            && payload.runId === sentState.runId && tabId === sentState.xTabId
            && payload.task?.taskKey && payload.task.taskKey === sentState.currentTask?.taskKey
            && sentState.lastXResult?.ok === true) {
          // Losing the submission reply is not permission to submit again.
          // Preserve the pending action and allow only the existing read-only
          // verification path to resolve it from this order's completion.
          try { await persistAutoRunState(true); }
          catch (_) {
            if (!stale()) {
              sentState.running = false;
              setStage("action_result_unknown");
            }
            return { ok: false, uncertain: true, message: "提交回执丢失且状态保存失败，已保留本单并停止" };
          }
          if (stale() || !sentState.running || sentState.manuallyStopped) return {ok: false, cancelled: true};
          log("warn", "提交连接中断，保留本单并原地只读等待完成状态；不会重复提交");
          return {ok: true, submitted: false, submissionResultUnknown: true,
            message: "提交回执丢失，原地等待平台完成状态，不重复提交"};
        }
        runtimeState.running = false;
        runtimeState.stage = "action_result_unknown";
        log("error", `动作 ${payload.type} 的回执丢失，结果未知；已停止，禁止自动重发，请先核对本单`);
        return { ok: false, uncertain: true, message: "动作可能已执行，回执丢失，未自动重试" };
      }
      if (attempt === 8) {
        log("error", `标签页消息失败：${error.message}`);
        return null;
      }
      await delay(500);
    }
  }
  return null;
}

async function cancelSupersededLighthouseRun(previousRun, paused = false) {
  // Cancel only the captured old run; the new run already owns runtimeState.
  for (const controller of activeAIRequests) controller.abort(new Error("已手动启动新一轮任务"));
  const targets = [[previousRun.lighthouseTabId, "CANCEL_LIGHTHOUSE_RUN"], [previousRun.xTabId, "CANCEL_X_RUN"]];
  if (paused && Number.isInteger(previousRun.uncertainAction?.tabId) && !targets.some(([id]) => id === previousRun.uncertainAction.tabId)) {
    targets.push([previousRun.uncertainAction.tabId, /^(?:RUN_X_|COMPLETE_X_|CLICK_X_)/.test(previousRun.uncertainAction.type) ? "CANCEL_X_RUN" : "CANCEL_LIGHTHOUSE_RUN"]);
  }
  await Promise.all(targets.filter(([tabId]) => Number.isInteger(tabId)).map(async ([tabId, type]) => {
    let timer;
    try {
      const runId = previousRun.uncertainAction?.tabId === tabId ? previousRun.uncertainAction.runId : previousRun.runId;
      if (paused && type === "CANCEL_LIGHTHOUSE_RUN") pauseLighthouseAlertBridge(tabId);
      await Promise.race([
        chrome.tabs.sendMessage(tabId, { type, platform: "lighthouse", runId, ...(paused ? { paused: true } : {}) }),
        new Promise(resolve => { timer = setTimeout(resolve, 2250); })
      ]);
    } catch (_) {
      // Old tabs may have closed since this snapshot was saved.
    } finally { clearTimeout(timer); }
  }));
}

function hasIdentifiedUncertainAction(state) {
  const action = state.uncertainAction;
  return Boolean(action?.type && action.runId && Number.isInteger(action.tabId));
}

// A missing reply is not a permanent order state. Re-read the bound order
// while stopped, using the same content-side receipt reader as initial claim
// confirmation. This never clicks, posts, verifies, or starts another order.
async function reconcileStoppedClaim(force = false) {
  const state = runtimeState;
  const intent = state.uncertainAction;
  const task = state.currentTask;
  const tweetUrl = normalizeTweetUrl(task?.tweetUrl);
  const claimTypes = ["START_LIGHTHOUSE_COMMENT_TASK", "DEBUG_LOCK_SEAT_AND_EXTRACT", "WAIT_SELECTED_COUNTDOWN_AND_LOCK"];
  if (state.running || state.manuallyStopped || !hasIdentifiedUncertainAction(state)
      || !claimTypes.includes(intent.type) || !task?.taskKey || !tweetUrl
      || intent.tabId !== state.lighthouseTabId || intent.runId !== state.runId) return false;
  if (claimReconciliation) return claimReconciliation;
  if (!force && lastClaimReconciliation.intent === intent && Date.now() - lastClaimReconciliation.at < 5000) return false;
  lastClaimReconciliation = { intent, at: Date.now() };
  const epoch = manualDebugCommandEpoch;
  const isCurrent = () => runtimeState === state && !state.running && !state.manuallyStopped
    && state.uncertainAction === intent && state.runId === intent.runId
    && state.currentTask === task && normalizeTweetUrl(task.tweetUrl, true) === normalizeTweetUrl(tweetUrl, true)
    && manualDebugCommandEpoch === epoch;
  const operation = (async () => {
    try {
      const tab = await chrome.tabs.get(intent.tabId);
      if (!isCurrent() || !isLighthouseUrl(tab.url) || !isTabInRuntimeWindow(tab)) return false;
      const payload = { type: "CHECK_LIGHTHOUSE_ORDER_OUTCOME", platform: "lighthouse",
        runId: intent.runId, claimIntentId: intent.intentId || "", task: { taskKey: task.taskKey, tweetUrl } };
      const read = async () => {
        let timer;
        try {
          return await Promise.race([chrome.tabs.sendMessage(intent.tabId, payload),
            new Promise(resolve => { timer = setTimeout(() => resolve(null), 2000); })]);
        } catch (_) { return null; }
        finally { clearTimeout(timer); }
      };
      let result = await read();
      if (!isCurrent()) return false;
      if (!result && await ensureContentScriptInjected(intent.tabId, isCurrent)) result = await read();
      if (!isCurrent() || result?.ok !== true || result.runId !== intent.runId
          || result.claimIntentId !== (intent.intentId || "") || result.taskKey !== task.taskKey
          || normalizeTweetUrl(result.tweetUrl, true) !== normalizeTweetUrl(tweetUrl, true)
          || !["locked", "completed"].includes(result.outcome)) return false;
      const completed = result.outcome === "completed";
      const text = completed
        ? "已按原推文核对本单验证成功，解除旧接单未知状态；可继续全量检测，不重复评论或验证"
        : "已按原推文核对本单席位锁定，解除旧接单未知状态；请从第 4 步接续本单";
      const next = { ...state, running: false, uncertainAction: null,
        currentTask: { ...task, claimReconciled: true, seatLocked: true,
          seatLockedAt: task.seatLockedAt || new Date().toISOString() },
        stage: completed ? "claim_completed_reconciled" : "claim_locked_reconciled",
        completionEvidence: completed ? { runId: state.runId, taskKey: task.taskKey, tweetUrl,
          observedAt: result.observedAt, officialCompletion: true, source: "bound_order_reconciliation" } : state.completionEvidence,
        logs: [{ at: new Date().toISOString(), level: "info", text, source: "background", pagePhase: "" }, ...(state.logs || [])].slice(0, 120) };
      // Persist before releasing the pending intent. A failed save preserves
      // the stopped state; a newer stop/run always wins over this result.
      await chrome.storage.local.set({ [AUTO_RUN_STATE_KEY]: { ...next, pendingXOpen: null } });
      if (!isCurrent()) { await persistAutoRunState(true); return false; }
      Object.assign(state, next);
      publishLighthouseMonitorSnapshot("order_reconciled");
      return true;
    } catch (_) { return false; }
  })();
  claimReconciliation = operation;
  try { return await operation; }
  finally { if (claimReconciliation === operation) claimReconciliation = null; }
}

// An explicit restart of a reconciled order continues that order through the
// common automatic pipeline. Never clear it and acquire another seat.
async function resumeReconciledClaim(windowId) {
  const state = runtimeState;
  const task = state.currentTask;
  const runId = state.runId;
  const epoch = manualDebugCommandEpoch;
  const current = () => runtimeState === state && state.runId === runId
    && state.currentTask === task && manualDebugCommandEpoch === epoch && !state.manuallyStopped;
  const stopped = () => current() && !state.running;
  const cancelled = () => ({ ok: false, cancelled: true, state: runtimeState });
  if (state.running || state.manuallyStopped || state.uncertainAction || state.lastXResult
      || state.completionEvidence || !task?.claimReconciled || !task.taskKey
      || !normalizeTweetUrl(task.tweetUrl) || !Number.isInteger(state.lighthouseTabId)) {
    return { ok: false, error: "本单仍有未核对的后续动作，不能自动重发", state };
  }
  const tab = await chrome.tabs.get(state.lighthouseTabId);
  if (!stopped()) return cancelled();
  if (!isLighthouseUrl(tab.url) || !isTabInRuntimeWindow(tab)
      || (Number.isInteger(windowId) && windowId !== tab.windowId)) {
    return { ok: false, error: "本单页面或运行窗口不匹配，已保留订单", state };
  }
  await ensureContentScriptInjected(tab.id, stopped);
  if (!stopped()) return cancelled();
  const outcome = await chrome.tabs.sendMessage(tab.id, { type: "CHECK_LIGHTHOUSE_ORDER_OUTCOME",
    platform: "lighthouse", runId, task: { taskKey: task.taskKey, tweetUrl: task.tweetUrl } });
  if (!stopped()) return cancelled();
  if (!outcome?.ok || outcome.runId !== runId || outcome.taskKey !== task.taskKey
      || normalizeTweetUrl(outcome.tweetUrl, true) !== normalizeTweetUrl(task.tweetUrl, true) || outcome.outcome !== "locked") {
    return { ok: false, error: "未重新确认本单仍处于锁位状态，保留订单等待核对", state };
  }
  const settings = await getSettings();
  if (!stopped()) return cancelled();
  if (settings.replyMode !== "post" || !settings.autoSubmitLighthouse) {
    return { ok: false, error: "接续本单需要自动发送回复并开启自动提交 Lighthouse", state };
  }
  state.running = true;
  state.mode = "auto";
  setStage("claim_resuming");
  try { await persistAutoRunState(true); }
  catch (_) {
    if (current()) {
      state.running = false;
      setStage("claim_resume_failed");
    }
    return { ok: false, error: "本单接续状态保存失败，已停止并保留订单", state: runtimeState };
  }
  if (!current() || !state.running) return cancelled();
  await ensureAutoRunKeepalive();
  if (!current() || !state.running) return cancelled();
  log("info", "已重新核对本单锁位，接续原订单的自动回复与验证");
  return adoptTargetOpenedTweet(task, tab.id, "auto");
}

async function cancelCurrentRun(isCurrent = () => true) {
  if (!isCurrent()) return false;
  const cancellingState = runtimeState;
  const runId = runtimeState.runId;
  const ownsCancellation = () => isCurrent() && runtimeState === cancellingState && runtimeState.runId === runId;
  runtimeState.running = false;
  for (const controller of activeAIRequests) controller.abort(new Error("任务已停止"));
  clearXOpenWatch();
  // X cancellation cannot prove that a post/submission did not happen. Keep
  // any still-pending irreversible action before its old response is ignored.
  const pendingAction = Array.from(activeTabActions).find((action) => action.state === cancellingState && action.runId === runId);
  if (!cancellingState.uncertainAction && pendingAction) {
    cancellingState.uncertainAction = { type: pendingAction.type, runId: pendingAction.runId, tabId: pendingAction.tabId, taskKey: pendingAction.taskKey };
    await persistAutoRunState(true);
    if (!ownsCancellation()) return false;
  }
  const intent = cancellingState.uncertainAction;
  const identifiedIntent = hasIdentifiedUncertainAction(cancellingState);
  const xIntent = identifiedIntent && /^(?:RUN_X_|COMPLETE_X_|CLICK_X_)/.test(intent.type);
  const lighthouseTabId = identifiedIntent && !xIntent ? intent.tabId : cancellingState.lighthouseTabId;
  const xTabId = xIntent ? intent.tabId : cancellingState.xTabId;
  const cancellableClaim = intent && ["START_LIGHTHOUSE_COMMENT_TASK", "DEBUG_OPEN_FIRST_COMMENT_TASK", "OPEN_SELECTED_COUNTDOWN_TASK_DETAIL", "OPEN_SELECTED_COUNTDOWN_TASK_TWEET", "DEBUG_LOCK_SEAT_AND_EXTRACT", "WAIT_SELECTED_COUNTDOWN_AND_LOCK"].includes(intent.type)
    && intent.tabId === cancellingState.lighthouseTabId;
  const cancelTab = async (tabId, type, targetRunId, extra = {}) => {
    let timer;
    try {
      return await Promise.race([
        chrome.tabs.sendMessage(tabId, { type, platform: "lighthouse", runId: targetRunId, ...extra }),
        new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, timedOut: true }), 2250); })
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const lighthouseCancellation = lighthouseTabId
    ? cancelTab(lighthouseTabId, "CANCEL_LIGHTHOUSE_RUN", identifiedIntent && !xIntent ? intent.runId : runId,
      cancellableClaim ? { expectedOperationType: intent.type, claimIntentId: intent.intentId || "" } : {})
    : Promise.resolve(null);
  const xRunId = intent?.tabId === xTabId ? intent.runId : runId;
  const xCancellation = xTabId
    ? cancelTab(xTabId, "CANCEL_X_RUN", xRunId).catch((error) => {
      if (ownsCancellation()) log("warn", `通知 X 停止旧流程失败：${error.message}`);
    }) : Promise.resolve();
  if (lighthouseTabId) {
    try {
      const reply = await lighthouseCancellation;
      if (!ownsCancellation()) return false;
      const proof = reply?.cancellationProof;
      if (cancellableClaim && cancellingState.uncertainAction === intent && reply?.ok === true
        && proof?.settled === true && proof.runId === intent.runId && proof.type === intent.type
        && proof.claimIntentId === (intent.intentId || "") && proof.claimActionAttempted === false && proof.claimed === false) {
        delete cancellingState.uncertainAction;
        await persistAutoRunState(true);
        if (!ownsCancellation()) return false;
        log("info", "已确认旧接单流程在点击前结束，可安全停止或接管");
      }
    } catch (error) {
      if (ownsCancellation()) log("warn", `通知 Lighthouse 停止旧流程失败：${error.message}`);
    }
  }
  if (!ownsCancellation()) return false;
  await xCancellation;
  return ownsCancellation();
}

async function reconcileWaitingAutoRunSchedule() {
  if (!(runtimeState.running && runtimeState.mode === "auto" && runtimeState.stage === "auto_waiting_schedule")) return;
  const settings = await getSettings();
  const scheduleState = getAutoRunScheduleState(settings);
  if (scheduleState.inWindow) {
    await clearAutoRunResumeSchedule();
    runtimeState.scheduledResumeAt = 0;
    log("info", "运行时间配置已命中当前时段，正式模式立即开始");
    await resumeAutoRunFromSchedule();
    return;
  }
  await enterAutoRunScheduleWait(scheduleState, "运行时间配置已更新，重新等待");
}

async function resumeAutoRunFromSchedule() {
  if (!(runtimeState.running && runtimeState.mode === "auto")) return;
  const settings = await getSettings();
  const scheduleState = getAutoRunScheduleState(settings);
  if (!scheduleState.inWindow) {
    await enterAutoRunScheduleWait(scheduleState, "到点复核仍未进入运行时间，继续等待");
    return;
  }
  await clearAutoRunResumeSchedule();
  runtimeState.scheduledResumeAt = 0;
  const hasStartedBefore = Boolean(runtimeState.lighthouseTabId || runtimeState.completed || runtimeState.attempts || runtimeState.failed);
  if (hasStartedBefore) {
    log("info", "已到运行时间，继续正式模式");
    setStage("auto_started");
    await startNextAutoTask("resume_from_schedule");
    return;
  }
  log("info", "已到运行时间，正式模式开始启动 Lighthouse 页面");
  setStage("auto_starting");
  const tab = await getOrCreateLighthouseTab(runtimeState.startOptions?.lighthouseUrl || LIGHTHOUSE_CAMPAIGNS_URL);
  rememberLighthouseTab(tab);
  if (!await focusLighthouseTabForAutoScan(tab.id)) {
    log("warn", "Chrome 正在调整 Lighthouse 标签，稍后继续检测任务广场");
    await delay(Math.max(settings.actionDelayMs, 1000));
    await startNextAutoTask("retry_after_lighthouse_tab_busy");
    return;
  }
  await waitForTabComplete(tab.id);
  log("info", "全量检测已启动：按旧任务页锁定流程顺序执行");
  setStage("auto_started");
  await startNextAutoTask("start");
}

async function enterAutoRunScheduleWait(scheduleState, reason = "") {
  if (!runtimeState.running || runtimeState.mode !== "auto") return;
  const nextStartAt = Number(scheduleState?.nextStartAt) || 0;
  const changed = runtimeState.scheduledResumeAt !== nextStartAt || runtimeState.stage !== "auto_waiting_schedule";
  runtimeState.scheduledResumeAt = nextStartAt;
  setStage("auto_waiting_schedule");
  await scheduleAutoRunResume(nextStartAt);
  if (changed) {
    const prefix = reason ? `${reason}：` : "";
    log("info", `${prefix}当前不在运行时间，等待至 ${formatScheduleDateTime(nextStartAt)} 自动开始`);
  }
}

async function scheduleAutoRunResume(whenMs) {
  await clearAutoRunResumeSchedule();
  return true;
}

async function clearAutoRunResumeSchedule() {
  runtimeState.scheduledResumeAt = 0;
}

function sanitizeAutoRunStartOptions(options = {}) {
  const lighthouseUrl = String(options?.lighthouseUrl || "").trim();
  return {
    lighthouseUrl: isLighthouseUrl(lighthouseUrl) ? lighthouseUrl : ""
  };
}

function getAutoRunScheduleState(settings) {
  const start = normalizeClockTime(settings?.runWindowStart || DEFAULT_SETTINGS.runWindowStart);
  const end = normalizeClockTime(settings?.runWindowEnd || DEFAULT_SETTINGS.runWindowEnd);
  // Run windows are hard-disabled: the keepalive alarm only guards an
  // already-running run, it does not schedule future starts, so a scheduled
  // resume would still be lost across service worker restarts. The window
  // fields are kept only for display.
  return { enabled: false, start, end, inWindow: true, nextStartAt: 0 };
}

function normalizeClockTime(value, fallback = "00:00") {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const hour = Math.min(Math.max(Number(match[1]), 0), 23);
  const minute = Math.min(Math.max(Number(match[2]), 0), 59);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function formatScheduleDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function createRunId() {
  runIdSequence += 1;
  return `${Date.now()}-${runIdSequence}`;
}

function isActiveAutoRun(runId) {
  return Boolean(runtimeState.running && runtimeState.mode === "auto" && runtimeState.runId === runId);
}

function isCurrentRunMessage(message) {
  return !runtimeState.manuallyStopped && (!message?.runId || !runtimeState.runId || message.runId === runtimeState.runId);
}

function captureRunGuard() {
  const state = runtimeState;
  const runId = state.runId;
  return () => runtimeState === state && runtimeState.runId === runId && !runtimeState.manuallyStopped;
}

async function ensureContentScriptInjected(tabId, isCurrent = () => true) {
  if (!isCurrent()) return false;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isCurrent()) return false;
    const file = getContentScriptFileForUrl(tab.url);
    if (!file) return false;
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [file]
    });
    if (!isCurrent()) return false;
    log("warn", `已为当前标签页补注入脚本：${file}`);
    return true;
  } catch (error) {
    if (!isCurrent()) return false;
    log("error", `补注入 content script 失败：${error.message}`);
    return false;
  }
}

function getContentScriptFileForUrl(url) {
  const value = String(url || "");
  if (/^https:\/\/app\.lhdao\.top\//i.test(value)) return "src/content/lighthouse.js";
  if (/^https:\/\/(?:x|twitter)\.com\//i.test(value)) return "src/content/x.js";
  return "";
}

// Installs the page-world alert bridge. Risk acceptance (reviewed 2026-09-11):
// it dismisses only the unverified-link warning for accepted orders; all other
// alerts stay visible to the user.
function pauseLighthouseAlertBridge(tabId) {
  const revision = alertPauseRevision = Math.max(Date.now(), alertPauseRevision + 1);
  try {
    void chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", args: [revision],
      func: revision => {
        if (Number(window.__lighthouseAlertPauseRevision__ || 0) > revision) return;
        window.__lighthouseAlertPauseRevision__ = revision;
        window.__lighthouseAutomationPaused__ = true;
      }
    }).catch(() => {});
  } catch (_) {}
}

async function ensureLighthouseAlertBridge(tabId, isCurrent = () => true) {
  if (!isCurrent()) return false;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isCurrent()) return false;
    if (!isLighthouseUrl(tab.url)) return false;
    // A URL does not identify a document: reloading the marketplace installs
    // a fresh, paused bridge at the same URL. Always re-enable MAIN world
    // before sending an action, including the first claim after a reload.
    const revision = alertPauseRevision = Math.max(Date.now(), alertPauseRevision + 1);
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [revision],
      func: revision => {
        if (Number(window.__lighthouseAlertPauseRevision__ || 0) > revision) return;
        window.__lighthouseAlertPauseRevision__ = revision;
        window.__lighthouseAutomationPaused__ = false;
        const bridgeKey = "__lighthouseUnverifiedLinkAlertBridge__";
        if (window[bridgeKey]) return;
        window[bridgeKey] = true;
        const nativeAlert = window.alert.bind(window);
        window.alert = (message) => {
          const text = String(message || "");
          if (!window.__lighthouseAutomationPaused__ && /此推文含有未经验证的链接[\s\S]*KOL\s*接单时仔细分辨/.test(text)) {
            window.dispatchEvent(new CustomEvent("lighthouse-unverified-link-alert-dismissed"));
            return;
          }
          return nativeAlert(message);
        };
      }
    });
    if (!isCurrent()) return false;
    return true;
  } catch (error) {
    if (!isCurrent()) return false;
    log("warn", `安装 Lighthouse 链接提示自动确认失败：${error.message}`);
    return false;
  }
}

function isReceivingEndMissingError(error) {
  const message = String(error?.message || error || "");
  return message.includes("Could not establish connection") || message.includes("Receiving end does not exist");
}

async function waitForTabComplete(tabId) {
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return true;
    await delay(250);
  }
  return false;
}

async function waitForCampaignsReloadReadiness(tabId, isCurrent) {
  const deadline = Date.now() + 50000;
  log("info", "Chrome 仍在加载页面资源，继续只读核对任务广场是否已就绪");
  while (isCurrent() && Date.now() <= deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (!isCurrent()) return false;
    const url = tab.pendingUrl || tab.url;
    if (!isLighthouseUrl(url) || new URL(url).pathname.replace(/\/$/, "") !== "/campaigns") return false;
    if (tab.status === "complete") return true;
    let timer;
    try {
      const ready = await Promise.race([
        chrome.tabs.sendMessage(tabId, {type: "CHECK_LIGHTHOUSE_CAMPAIGNS_READY", platform: "lighthouse"}),
        new Promise(resolve => {timer = setTimeout(() => resolve(null), 1500);})
      ]);
      if (!isCurrent()) return false;
      if (ready?.ok && ready.ready === true && isLighthouseUrl(ready.url)
          && new URL(ready.url).pathname.replace(/\/$/, "") === "/campaigns") {
        log("info", "任务广场已就绪，页面附属资源仍在加载，继续扫描");
        return true;
      }
    } catch (_) {
      // The new document may not have installed its content listener yet.
    } finally {clearTimeout(timer);}
    if (!isCurrent()) return false;
    await delay(1000);
  }
  return false;
}

async function waitForTabClosed(tabId, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await chrome.tabs.get(tabId);
    } catch (_) {
      return true;
    }
    await delay(200);
  }
  return false;
}

function createInitialState() {
  return {
    running: false,
    mode: "idle",
    stage: "idle",
    completed: 0,
    failed: 0,
    attempts: 0,
    lighthouseTabId: null,
    lighthouseWindowId: null,
    runtimeWindowId: null,
    lighthousePage: null,
    xTabId: null,
    xTabWindowId: null,
    currentTask: null,
    lastXResult: null,
    lastLockFailureReason: "",
    scheduledResumeAt: 0,
    startOptions: null,
    pendingXOpen: null,
    pendingVerifications: [],
    attemptedTaskKeys: [],
    attemptedTaskRecords: [],
    lastProgressAt: Date.now(),
    runId: createRunId(),
    logs: []
  };
}

async function resolveLighthouseTab(isCurrent = () => true) {
  if (!isCurrent()) return null;
  if (runtimeState.lighthouseTabId) {
    try {
      const recorded = await chrome.tabs.get(runtimeState.lighthouseTabId);
      if (!isCurrent()) return null;
      if (isLighthouseUrl(recorded.url)) {
        rememberLighthouseTab(recorded);
        return recorded.id;
      }
    } catch (error) {
      if (!isCurrent()) return null;
      log("warn", `已记录 Lighthouse 标签页不可用：${error.message}`);
    }
    runtimeState.lighthouseTabId = null;
    runtimeState.lighthouseWindowId = null;
  }

  const activeTab = await getActiveLighthouseTab(isCurrent);
  if (!isCurrent()) return null;
  if (activeTab) {
    rememberLighthouseTab(activeTab);
    log("info", "已接管当前 Lighthouse 标签页");
    return activeTab.id;
  }

  const tabs = await queryLighthouseTabsInRuntimeWindow();
  if (!isCurrent()) return null;
  const lighthouseTab = tabs.find((tab) => isLighthouseUrl(tab.url));
  if (lighthouseTab) {
    rememberLighthouseTab(lighthouseTab);
    await chrome.tabs.update(lighthouseTab.id, { active: true });
    if (!isCurrent()) return null;
    log("info", "已接管已有 Lighthouse 标签页");
    return lighthouseTab.id;
  }

  throw new Error("缺少 Lighthouse 标签页：当前窗口没有 app.lhdao.top 页面");
}

async function resolveCurrentXTab(options = {}, isCurrent = () => true) {
  if (!isCurrent()) return null;
  const recordedTabId = runtimeState.xTabId;
  if (recordedTabId) {
    try {
      const tab = await chrome.tabs.get(recordedTabId);
      if (!isCurrent()) return null;
      if (isTweetTab(tab) && isTabInRuntimeWindow(tab)) {
        runtimeState.xTabWindowId = tab.windowId;
        return recordedTabId;
      }
    } catch (error) {
      if (!isCurrent()) return null;
      log("warn", `Recorded X tab is unavailable: ${error.message}`);
    }
    runtimeState.xTabId = null;
    runtimeState.xTabWindowId = null;
  }
  if (options.allowActiveTweetTab) {
    const activeTab = await getActiveTweetTab({ windowId: getRuntimeWindowId() });
    if (!isCurrent()) return null;
    if (activeTab) {
      const taskTweetUrl = normalizeTweetUrl(runtimeState.currentTask?.tweetUrl || "", true);
      const activeTweetUrl = normalizeTweetUrl(activeTab.url || "", true);
      if (!runtimeState.currentTask || (taskTweetUrl && taskTweetUrl !== activeTweetUrl)) {
        throw new Error("拒绝接管当前活动 X 页：缺少本轮任务上下文或推文链接不匹配");
      }
      runtimeState.xTabId = activeTab.id;
      runtimeState.xTabWindowId = activeTab.windowId;
      runtimeState.currentTask = {
        ...(runtimeState.currentTask || {}),
        source: "debug_current_x",
        tweetUrl: normalizeTweetUrl(activeTab.url),
        currentPageAdopted: true,
        adoptedAfterClickAt: new Date().toISOString()
      };
      log("warn", `调试模式直接使用当前 X 推文页：${runtimeState.currentTask.tweetUrl}`);
      return activeTab.id;
    }
  }
  throw new Error("缺少本任务 X 标签页：只允许使用 Lighthouse 点击后新打开的 X 推文页");
}

async function getActiveTweetTab(options = {}) {
  const query = { active: true };
  if (Object.prototype.hasOwnProperty.call(options, "windowId")) {
    if (!Number.isInteger(options.windowId)) return null;
    query.windowId = options.windowId;
  } else {
    query.currentWindow = true;
  }
  const tabs = await chrome.tabs.query(query);
  const tab = tabs[0];
  return isTweetTab(tab) ? tab : null;
}

async function waitForLighthouseOpenedTweet(task, lighthouseTabId, mode, options = {}) {
  const waitingState = runtimeState;
  const runId = runtimeState.runId;
  const isCurrent = () => runtimeState === waitingState && runtimeState.runId === runId && runtimeState.running;
  const blockNotice = message => {
    runtimeState.running = false;
    setStage("locked_task_recovery_blocked");
    log("error", message);
    throw new Error(message);
  };
  await sendToTab(lighthouseTabId, { type: "BEGIN_LIGHTHOUSE_COMPLETION_WATCH", runId, task });
  if (!isCurrent()) return false;
  const startedAt = Date.now();
  const lighthouseWindowId = await getLighthouseWindowId(lighthouseTabId, isCurrent);
  if (!isCurrent()) return false;
  const expectedTweetUrl = normalizeTweetUrl(task?.tweetUrl || runtimeState.currentTask?.tweetUrl || "");
  const timeoutMs = Number(options.timeoutMs || 30000);
  const logEveryMs = Number(options.logEveryMs || 3000);
  const manualOpenAfterMs = Math.max(0, Number(options.manualOpenAfterMs || 0));
  const waitLogMessage = options.waitLogMessage || "已点击在 X 打开/前往目标，继续等待新 X 推文标签页出现";
  let lastLogAt = 0;
  let fallbackOpened = false;
  let detailFallbackClicked = false;
  let navigationWaitLogged = false;
  let noticePending = false;
  let noticeClickedAt = 0;
  while (Date.now() - startedAt < timeoutMs) {
    if (!isCurrent()) return false;
    const currentExpectedUrl = normalizeTweetUrl(runtimeState.currentTask?.tweetUrl || expectedTweetUrl);
    const boundTab = await getBoundMatchingTaskXTab(currentExpectedUrl, isCurrent);
    if (!isCurrent()) return false;
    if (boundTab) {
      runtimeState.mode = mode || runtimeState.mode;
      if (lighthouseTabId) await rememberLighthouseTabById(lighthouseTabId, isCurrent);
      if (!isCurrent()) return false;
      return true;
    }
    const candidate = consumeXOpenCandidate(lighthouseTabId, currentExpectedUrl)
      || await findRecentTweetTab(startedAt, lighthouseTabId, lighthouseWindowId, currentExpectedUrl);
    if (!isCurrent()) return false;
    if (candidate && candidate.id === lighthouseTabId) {
      await delay(500);
      continue;
    }
    if (candidate && !isTabInWindow(candidate, lighthouseWindowId)) {
      log("warn", `忽略非本窗口 X 标签页：tab=${candidate.id}`);
      await delay(500);
      continue;
    }
    if (candidate) {
      adoptCurrentXTab(candidate, task, "site");
      runtimeState.mode = mode || runtimeState.mode;
      if (lighthouseTabId) await rememberLighthouseTabById(lighthouseTabId, isCurrent);
      if (!isCurrent()) return false;
      return true;
    }
    const noticeTask = runtimeState.currentTask;
    if (!runtimeState.uncertainAction && noticeTask?.seatLocked === true && !noticeTask.claimRejected && !noticeTask.lockFailed
        && noticeTask.taskKey && normalizeTweetUrl(noticeTask.tweetUrl)) {
      const noticeTaskKey = noticeTask.taskKey;
      const noticeTarget = normalizeTweetUrl(noticeTask.tweetUrl, true);
      const notice = await sendToTab(lighthouseTabId, {
        type: "CONFIRM_LIGHTHOUSE_LOCKED_TASK_NOTICE", runId, task: noticeTask
      });
      const currentTask = runtimeState.currentTask;
      if (!isCurrent() || currentTask?.taskKey !== noticeTaskKey || currentTask.seatLocked !== true
          || currentTask.claimRejected || currentTask.lockFailed
          || normalizeTweetUrl(currentTask.tweetUrl, true) !== noticeTarget) return false;
      if (!notice?.ok) blockNotice(notice?.message || "未确认本单锁位后的前往 X 提醒，已保留订单");
      if (notice.noticePresent && (notice.runId !== runId || notice.taskKey !== noticeTaskKey
          || normalizeTweetUrl(notice.tweetUrl, true) !== noticeTarget)) {
        blockNotice("锁位后提醒回执与当前订单不匹配，已保留订单");
      }
      noticePending = notice.pending === true;
      if (notice.noticeClicked) {
        noticeClickedAt = Date.now();
        log("info", "已确认本单锁位后提醒，等待官网打开目标 X 页面");
      }
      // A late-mounted reminder is checked each round. Let the site's click
      // open/navigate its own tab before considering any direct fallback.
      if (noticePending || notice.noticeClicked) {
        await delay(500);
        const afterWaitTask = runtimeState.currentTask;
        if (!isCurrent() || afterWaitTask?.taskKey !== noticeTaskKey || afterWaitTask.seatLocked !== true
            || afterWaitTask.claimRejected || afterWaitTask.lockFailed
            || normalizeTweetUrl(afterWaitTask.tweetUrl, true) !== noticeTarget) return false;
        continue;
      }
    }
    const lockFailure = await checkLighthouseLockFailure(lighthouseTabId);
    if (!isCurrent()) return false;
    if (lockFailure) {
      clearXOpenWatch();
      const message = lockFailure.message || lockFailure.reason || "锁定失败：任务不可做";
      runtimeState.lastLockFailureReason = message;
      releaseAttemptedTask(runtimeState.currentTask);
      releaseAttemptedTask(task);
      releaseAttemptedTask(lockFailure.task);
      runtimeState.currentTask = {
        ...(runtimeState.currentTask || {}),
        ...(task || {}),
        ...(lockFailure.task || {}),
        taskKey: task.taskKey,
        selectionId: task.selectionId,
        stableTaskKey: task.stableTaskKey,
        seatLocked: false,
        seatLockedAt: null,
        lockFailed: true,
        claimRejected: true
      };
      log("warn", message);
      return false;
    }
    const waitedMs = Date.now() - Math.max(startedAt, noticeClickedAt);
    if (manualOpenAfterMs > 0 && !fallbackOpened && waitedMs >= manualOpenAfterMs) {
      const navigating = await hasPendingSiteXNavigation(lighthouseTabId, isCurrent);
      if (!isCurrent()) return false;
      if (navigating) {
        if (!navigationWaitLogged) log("info", "检测到本轮新标签仍在导航，等待目标 X 地址，不重复打开");
        navigationWaitLogged = true;
        await delay(500);
        continue;
      }
      fallbackOpened = true;
      log("info", `已等待 ${Math.ceil(waitedMs / 1000)} 秒，复查目标标签页后决定是否使用直链兜底`);
      const directTabId = await openDirectTweetTabIfAvailable(
        runtimeState.currentTask || task,
        lighthouseTabId,
        { allowAwaitingXTabAdoption: true, source: "extension_fallback", isCurrent }
      );
      if (!isCurrent()) return false;
      if (directTabId) {
        clearXOpenWatch();
        if (runtimeState.currentTask?.xOpenSource === "extension_fallback") {
          log("warn", "官网未跳转，插件已兜底打开精确目标 X 推文");
        }
        return true;
      }
      // A concurrent recovery or a new navigation may have made the direct
      // opener return null. Recheck before clicking a second website control.
      const concurrentTab = await getBoundMatchingTaskXTab(currentExpectedUrl, isCurrent);
      if (!isCurrent()) return false;
      if (concurrentTab) return true;
      const navigationStarted = await hasPendingSiteXNavigation(lighthouseTabId, isCurrent);
      if (!isCurrent()) return false;
      if (navigationStarted) {
        fallbackOpened = false;
        await delay(500);
        continue;
      }
      if (!detailFallbackClicked) {
        detailFallbackClicked = true;
        const clickFallback = await clickCurrentDetailTweetTargetFallback(lighthouseTabId, mode, isCurrent);
        if (!isCurrent()) return false;
        if (clickFallback.ok) {
          runtimeState.currentTask = mergeTaskPreservingCapturedTweetUrl(runtimeState.currentTask, clickFallback.task, {
            taskKey: task?.taskKey || runtimeState.currentTask?.taskKey,
            seatLocked: runtimeState.currentTask?.seatLocked === true
          });
          log("warn", "当前详情未暴露直链，已单次点击“去 X 完成动作”并仅等待匹配目标页出现");
          await delay(1000);
          if (!isCurrent()) return false;
          const clickedExpectedUrl = normalizeTweetUrl(runtimeState.currentTask?.tweetUrl || expectedTweetUrl);
          const clickedBoundTab = await getBoundMatchingTaskXTab(clickedExpectedUrl, isCurrent);
          if (!isCurrent()) return false;
          if (clickedBoundTab) return true;
          const clickedCandidate = consumeXOpenCandidate(lighthouseTabId, clickedExpectedUrl)
            || await findRecentTweetTab(Date.now() - 1500, lighthouseTabId, lighthouseWindowId, clickedExpectedUrl);
          if (!isCurrent()) return false;
          if (clickedCandidate) {
            adoptCurrentXTab(clickedCandidate, runtimeState.currentTask, "site");
            return true;
          }
          const directAfterClick = await openDirectTweetTabIfAvailable(
            runtimeState.currentTask || task,
            lighthouseTabId,
            { allowAwaitingXTabAdoption: true, source: "extension_fallback", isCurrent }
          );
          if (!isCurrent()) return false;
          if (directAfterClick) {
            clearXOpenWatch();
            if (runtimeState.currentTask?.xOpenSource === "extension_fallback") {
              log("warn", "单次详情按钮未产生匹配页面，插件已使用新提取的任务直链兜底打开 X");
            }
            return true;
          }
        } else {
          log("warn", `当前详情未暴露直链，且单次点击“去 X 完成动作”失败：${clickFallback.message}`);
        }
      }
    }
    if (Date.now() - startedAt > logEveryMs && Date.now() - lastLogAt > logEveryMs) {
      lastLogAt = Date.now();
      log("info", waitLogMessage);
    }
    await delay(500);
  }
  if (!isCurrent()) return false;
  if (noticePending) blockNotice("本单锁位后提醒仍未确认，已保留订单，不使用直链绕过");
  // Preserve navigation observations for the caller's final fallback check.
  return false;
}

async function clickCurrentDetailTweetTargetFallback(lighthouseTabId, mode, isCurrent = () => true) {
  if (!lighthouseTabId) return { ok: false, message: "缺少 Lighthouse 任务页" };
  const runId = runtimeState.runId;
  try {
    const settings = await getSettings();
    if (!isCurrent()) return { ok: false, cancelled: true };
    beginXOpenWatch(lighthouseTabId, mode);
    const result = await sendToTab(lighthouseTabId, {
      type: "OPEN_CURRENT_DETAIL_TWEET_TARGET",
      runId,
      settings,
      taskTypeHint: runtimeState.currentTask?.taskType || "",
      task: runtimeState.currentTask || null
    });
    if (!result?.ok) {
      return { ok: false, message: result?.message || result?.error || "未找到去 X 完成动作/前往 X 完成动作控件" };
    }
    return { ok: true, task: result.task || null };
  } catch (error) {
    return { ok: false, message: error?.message || String(error) };
  }
}

async function checkLighthouseLockFailure(lighthouseTabId) {
  if (!lighthouseTabId) return null;
  const state = runtimeState;
  const task = state.currentTask;
  if (!task?.taskKey || !task.seatLockedAt || state.uncertainAction || state.completionEvidence
      || task.claimed || task.invitationAccepted || state.lastXResult) return null;
  try {
    const result = await sendToTab(lighthouseTabId, {
      type: "CHECK_LIGHTHOUSE_LOCK_FAILURE",
      runId: state.runId,
      task
    });
    const proof = result?.claimRejection;
    if (runtimeState === state && state.currentTask === task && state.running
        && !state.uncertainAction && !state.completionEvidence && !state.lastXResult
        && result?.ok && result.failed && proof?.runId === state.runId
        && proof.taskKey === task.taskKey && proof.seatLockedAt === task.seatLockedAt) return result;
  } catch (_) {}
  return null;
}

function beginXOpenWatch(lighthouseTabId, mode) {
  runtimeState.lastLockFailureReason = "";
  runtimeState.pendingXOpen = {
    lighthouseTabId,
    windowId: getRuntimeWindowId(),
    mode,
    startedAt: Date.now(),
    createdTabIds: [],
    candidates: []
  };
}

function clearXOpenWatch() {
  runtimeState.pendingXOpen = null;
}

function recordPotentialLighthouseOpenedXTab(tab, created = false) {
  const pending = runtimeState.pendingXOpen;
  if (!pending || !tab || !tab.id) return;
  if (!Number.isInteger(pending.windowId)) return;
  if (Number.isInteger(pending.windowId) && tab.windowId !== pending.windowId) return;
  const openerMatches = tab.openerTabId === pending.lighthouseTabId;
  const tweetUrl = normalizeTweetUrl(tab.pendingUrl || tab.url, true);
  const expected = normalizeTweetUrl(runtimeState.currentTask?.tweetUrl, true);
  if ((created || openerMatches || (expected && tweetUrl === expected)) && !pending.createdTabIds.includes(tab.id)) {
    pending.createdTabIds.push(tab.id);
  }

  const fromTrackedNewTab = pending.createdTabIds.includes(tab.id);
  if (!fromTrackedNewTab) return;

  // Replace a previous URL for this tab, including navigation away from X.
  pending.candidates = pending.candidates.filter(candidate => candidate.id !== tab.id);
  if (!tweetUrl) return;
  pending.candidates.push(tab);
}

function consumeXOpenCandidate(lighthouseTabId, expectedTweetUrl = "") {
  const pending = runtimeState.pendingXOpen;
  if (!pending || pending.lighthouseTabId !== lighthouseTabId) return null;
  const expected = normalizeTweetUrl(expectedTweetUrl, true);
  if (!expected) return null;
  const index = pending.candidates.findIndex((candidate) => normalizeTweetUrl(candidate.pendingUrl || candidate.url, true) === expected);
  if (index < 0) return null;
  const [candidate] = pending.candidates.splice(index, 1);
  clearXOpenWatch();
  return candidate;
}

async function recoverPendingXOpenFromCapturedUrl(tweetUrl) {
  const recoveryState = runtimeState;
  const recoveryRunId = runtimeState.runId;
  const isCurrent = () => runtimeState === recoveryState && runtimeState.runId === recoveryRunId && runtimeState.running;
  const normalizedUrl = normalizeTweetUrl(tweetUrl);
  const pending = runtimeState.pendingXOpen;
  const task = runtimeState.currentTask || {};
  if (!normalizedUrl || !pending) return null;
  if (!runtimeState.running || (task.seatLocked !== true && !task.seatLockedAt)) return null;
  const alreadyBound = await getBoundMatchingTaskXTab(normalizedUrl, isCurrent);
  if (!isCurrent()) return null;
  if (alreadyBound) return alreadyBound.id;
  if (capturedTargetRecoveryPromise) return capturedTargetRecoveryPromise;

  const runId = runtimeState.runId;
  const lighthouseTabId = pending.lighthouseTabId;
  const lighthouseWindowId = pending.windowId;
  const startedAt = pending.startedAt || Date.now();
  const recovery = (async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (!isCurrent()) return null;
      const boundTab = await getBoundMatchingTaskXTab(normalizedUrl, isCurrent);
      if (!isCurrent()) return null;
      if (boundTab) return boundTab.id;
      const candidate = consumeXOpenCandidate(lighthouseTabId, normalizedUrl)
        || await findRecentTweetTab(startedAt, lighthouseTabId, lighthouseWindowId, normalizedUrl);
      if (!isCurrent()) return null;
      if (candidate) {
        adoptCurrentXTab(candidate, runtimeState.currentTask, "site");
        log("info", "已根据官网回传的精确地址接管 Lighthouse 打开的 X 标签页");
        return candidate.id;
      }
      await delay(1000);
    }

    const directTabId = await openDirectTweetTabIfAvailable(
      mergeTaskPreservingCapturedTweetUrl(runtimeState.currentTask, null, {
        tweetUrl: normalizedUrl,
        awaitingXTabAdoption: false
      }),
      lighthouseTabId,
      { allowAwaitingXTabAdoption: true, source: "extension_fallback", isCurrent }
    );
    if (!isCurrent()) return null;
    if (directTabId && runtimeState.currentTask?.xOpenSource === "extension_fallback") {
      log("warn", "官网已回传目标地址但未创建可接管标签，插件已只创建一次精确兜底页");
    }
    return directTabId;
  })();
  capturedTargetRecoveryPromise = recovery;
  try {
    return await recovery;
  } finally {
    if (capturedTargetRecoveryPromise === recovery) capturedTargetRecoveryPromise = null;
  }
}

async function hasPendingSiteXNavigation(lighthouseTabId, isCurrent = () => true) {
  const pending = runtimeState.pendingXOpen;
  if (!pending || pending.lighthouseTabId !== lighthouseTabId || !Number.isInteger(pending.windowId)) return false;
  const tabs = await chrome.tabs.query({ windowId: pending.windowId });
  if (!isCurrent() || runtimeState.pendingXOpen !== pending) return false;
  return tabs.some(tab => {
    if (tab.id === lighthouseTabId || tab.windowId !== pending.windowId
        || !(pending.createdTabIds || []).includes(tab.id)) return false;
    const destination = tab.pendingUrl || tab.url || "";
    return tab.status === "loading" && !normalizeTweetUrl(destination)
      && (!destination || destination === "about:blank" || /^https:\/\/(?:x\.com|twitter\.com|t\.co)\//i.test(destination));
  });
}

async function findRecentTweetTab(startedAt, lighthouseTabId, windowId, expectedTweetUrl = "") {
  if (!Number.isInteger(windowId)) return null;
  const expected = normalizeTweetUrl(expectedTweetUrl, true);
  if (!expected) return null;
  const searchingState = runtimeState;
  const searchingRunId = runtimeState.runId;
  const isCurrent = () => runtimeState === searchingState && runtimeState.runId === searchingRunId && runtimeState.running;
  const fromLighthouse = tab => tab.openerTabId === lighthouseTabId;
  // Reuse the exact target in this window regardless of opener or focus time.
  const select = tabs => tabs
    .filter((tab) => tab.id !== lighthouseTabId && tab.windowId === windowId && isTweetTab(tab))
    .filter((tab) => normalizeTweetUrl(tab.pendingUrl || tab.url, true) === expected)
    .sort((a, b) => Number(fromLighthouse(b)) - Number(fromLighthouse(a))
      || Number(Number(b.lastAccessed) >= startedAt) - Number(Number(a.lastAccessed) >= startedAt)
      || Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0));
  const committedTabs = await chrome.tabs.query({ windowId, url: ["https://x.com/*", "https://twitter.com/*"] });
  if (!isCurrent()) return null;
  const committed = select(committedTabs)[0];
  if (committed) return committed;
  // The narrow query omits about:blank tabs whose target is in pendingUrl.
  const allTabs = await chrome.tabs.query({ windowId });
  if (!isCurrent()) return null;
  return select(allTabs)[0] || null;
}

function adoptCurrentXTab(tab, task = null, source = "lighthouse") {
  const tweetUrl = normalizeTweetUrl(tab.pendingUrl || tab.url);
  runtimeState.xTabId = tab.id;
  runtimeState.xTabWindowId = tab.windowId;
  runtimeState.currentTask = mergeTaskPreservingCapturedTweetUrl(runtimeState.currentTask, task, {
    source: source === "site" ? "lighthouse" : source,
    tweetUrl,
    xOpenSource: source,
    currentPageAdopted: source !== "site",
    adoptedAfterClickAt: new Date().toISOString(),
    createdAt: runtimeState.currentTask?.createdAt || task?.createdAt || new Date().toISOString()
  });
  setStage("current_x_tab_adopted");
  log(source === "site" ? "info" : "warn", source === "debug_current_x"
    ? `调试模式使用当前活动 X 推文页：${tweetUrl}`
    : (source === "site"
      ? `已检测到 Lighthouse 官网打开的目标 X 推文页：${tweetUrl}`
      : `已接管人工打开的匹配 X 推文页：${tweetUrl}`));
  return tab.id;
}

async function getLighthouseWindowId(lighthouseTabId, isCurrent = () => true) {
  if (!isCurrent()) return null;
  if (Number.isInteger(runtimeState.lighthouseWindowId)) return runtimeState.lighthouseWindowId;
  if (!lighthouseTabId) return null;
  try {
    const tab = await chrome.tabs.get(lighthouseTabId);
    if (!isCurrent()) return null;
    if (isLighthouseUrl(tab.url)) {
      rememberLighthouseTab(tab);
      return tab.windowId;
    }
  } catch (_) {}
  return null;
}

function rememberLighthouseTab(tab) {
  if (!tab || !tab.id) return;
  runtimeState.lighthouseTabId = tab.id;
  runtimeState.lighthouseWindowId = tab.windowId;
  runtimeState.runtimeWindowId = tab.windowId;
}

async function rememberLighthouseTabById(tabId, isCurrent = () => true) {
  if (!tabId || !isCurrent()) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isCurrent()) return null;
    if (isLighthouseUrl(tab.url)) {
      rememberLighthouseTab(tab);
      return tab;
    }
  } catch (_) {}
  if (!isCurrent()) return null;
  if (runtimeState.lighthouseTabId === tabId) {
    runtimeState.lighthouseTabId = null;
    runtimeState.lighthouseWindowId = null;
  }
  return null;
}

function isTabInRuntimeWindow(tab) {
  if (!tab) return false;
  return isWindowIdInRuntime(tab.windowId);
}

function isWindowIdInRuntime(windowId) {
  const targetWindowId = getRuntimeWindowId();
  if (!Number.isInteger(targetWindowId)) return false;
  return windowId === targetWindowId;
}

function isTabInWindow(tab, windowId) {
  if (!Number.isInteger(windowId)) return false;
  return tab && tab.windowId === windowId;
}

function isTweetTab(tab) {
  return Boolean(tab && tab.id && normalizeTweetUrl(tab.pendingUrl || tab.url));
}

function normalizeTweetUrl(url, identityOnly = false) {
  try {
    const parsed = new URL(String(url || ""));
    if (parsed.protocol !== "https:" || !["x.com", "twitter.com"].includes(parsed.hostname)
        || parsed.port || parsed.username || parsed.password) return "";
    const match = parsed.pathname.match(/^\/([A-Za-z0-9_]+)\/status\/([0-9]+)(?:\/(?:photo|video)\/[1-9][0-9]*)?\/?$/);
    // X rewrites /i/status/:id to the author path. Compare the complete ID
    // without replacing the navigation URL retained for the current task.
    return match ? `https://x.com/${identityOnly ? "i" : match[1]}/status/${match[2]}` : "";
  } catch (_) {
    return "";
  }
}

function mergeTaskPreservingCapturedTweetUrl(currentTask, nextTask, overrides = {}) {
  const currentUrl = normalizeTweetUrl(currentTask?.tweetUrl);
  const nextUrl = normalizeTweetUrl(nextTask?.tweetUrl);
  const overrideUrl = normalizeTweetUrl(overrides?.tweetUrl);
  const currentIdentity = getTaskMergeIdentity(currentTask);
  const nextIdentity = getTaskMergeIdentity(nextTask);
  const sharedIdentityField = ["stableTaskKey", "selectionId", "taskKey", "detailPath", "id"]
    .find((field) => currentIdentity[field] && nextIdentity[field]);
  const sameTask = !nextTask || Boolean(
    sharedIdentityField && currentIdentity[sharedIdentityField] === nextIdentity[sharedIdentityField]
  );
  return {
    ...(currentTask || {}),
    ...(nextTask || {}),
    ...(overrides || {}),
    tweetUrl: overrideUrl || nextUrl || (sameTask ? currentUrl : "")
  };
}

function getTaskMergeIdentity(task) {
  if (!task) return {};
  return {
    stableTaskKey: String(task.stableTaskKey || "").trim(),
    selectionId: String(task.selectionId || "").trim(),
    taskKey: String(task.taskKey || "").trim(),
    detailPath: String(task.detailPath || "").trim(),
    id: String(task.id || "").trim()
  };
}

async function getBoundMatchingTaskXTab(expectedTweetUrl = "", isCurrent = () => true) {
  if (!isCurrent()) return null;
  if (!Number.isInteger(runtimeState.xTabId)) return null;
  try {
    const tab = await chrome.tabs.get(runtimeState.xTabId);
    if (!isCurrent()) return null;
    const actualUrl = normalizeTweetUrl(tab?.pendingUrl || tab?.url, true);
    const expectedUrl = normalizeTweetUrl(expectedTweetUrl || runtimeState.currentTask?.tweetUrl, true);
    if (!actualUrl || !isTabInRuntimeWindow(tab) || (expectedUrl && actualUrl !== expectedUrl)) {
      runtimeState.xTabId = null;
      runtimeState.xTabWindowId = null;
      return null;
    }
    runtimeState.xTabWindowId = tab.windowId;
    return tab;
  } catch (_) {
    if (!isCurrent()) return null;
    runtimeState.xTabId = null;
    runtimeState.xTabWindowId = null;
    return null;
  }
}

function releaseAttemptedTask(task) {
  if (!task) return;
  const keys = getTaskDedupeKeys(task);
  if (!keys.length) return;
  const released = new Set(keys);
  runtimeState.attemptedTaskRecords = (runtimeState.attemptedTaskRecords || [])
    .filter((record) => !released.has(record.key));
  runtimeState.attemptedTaskKeys = runtimeState.attemptedTaskRecords.map((record) => record.key);
}

function markAttemptedTask(task) {
  // Unclaimed tasks follow the live plaza countdown. Only an actual order
  // needs local duplicate-action protection; tier exclusions are separate.
  const protectedCurrentTask = task?.taskKey && task.taskKey === runtimeState.currentTask?.taskKey
    && (runtimeState.completionEvidence || runtimeState.lastXResult || runtimeState.uncertainAction);
  if (!task || !(protectedCurrentTask || task.invitationAccepted || task.claimed || task.seatLocked || task.seatLockedAt)) return;
  const keys = getTaskDedupeKeys(task);
  if (!keys.length) return;

  pruneAttemptedTasks();
  const active = new Set(getActiveAttemptedTaskKeys());
  const now = Date.now();
  const requestedDeferUntil = Number(task?.deferUntil || 0);
  const hasDeferredRescan = requestedDeferUntil > now;
  const expiresAt = hasDeferredRescan
    ? Math.min(requestedDeferUntil, now + MAX_DEFERRED_TASK_DEDUPE_MS)
    : now + ATTEMPTED_TASK_DEDUPE_MS;
  const newKeys = keys.filter((key) => key && !active.has(key));
  if (newKeys.length) {
    runtimeState.attempts += 1;
    runtimeState.attemptedTaskRecords.push(...newKeys.map((key) => ({ key, expiresAt })));
    pruneAttemptedTasks();
    const deferMs = Math.max(0, expiresAt - now);
    if (hasDeferredRescan) {
      log("info", `已登记延后重试 ${formatDuration(deferMs)}：${describeTaskForLog(task)}`);
    } else if (task?.seatLocked === true) {
      log("info", `已登记已锁定订单，完成前不重复抢单：${describeTaskForLog(task)}`);
    } else {
      log("info", `已登记失败任务临时去重 ${formatDuration(deferMs)}：${describeTaskForLog(task)}`);
    }
  }
}

async function ensurePermanentIgnoredTaskKeysLoaded() {
  if (permanentIgnoredTaskKeysLoaded) return permanentIgnoredTaskKeysCache;
  try {
    const stored = await chrome.storage.local.get([PERMANENT_IGNORED_TASK_KEYS_KEY]);
    const values = Array.isArray(stored[PERMANENT_IGNORED_TASK_KEYS_KEY]) ? stored[PERMANENT_IGNORED_TASK_KEYS_KEY] : [];
    permanentIgnoredTaskKeysCache = new Set(values.map((key) => String(key || "").trim()).filter(Boolean));
    try {
      const cleanup = chrome.storage.local.remove(["permanentIgnoredTaskKeys", "permanentIgnoredTaskKeysV2", "permanentIgnoredTaskKeysV3"]);
      if (cleanup && typeof cleanup.catch === "function") cleanup.catch(() => {});
    } catch (_) {}
  } catch (_) {
    permanentIgnoredTaskKeysCache = new Set();
  }
  permanentIgnoredTaskKeysLoaded = true;
  return permanentIgnoredTaskKeysCache;
}

async function markPermanentIgnoredTask(task, taskType = "") {
  const isCurrent = captureRunGuard();
  if (!isCurrent()) return false;
  await ensurePermanentIgnoredTaskKeysLoaded();
  if (!isCurrent()) return false;
  const inputTask = task || {};
  const normalizedTask = { ...inputTask, taskType: inputTask.taskType || taskType || "非评论" };
  const keys = getTaskDedupeKeys(normalizedTask);
  if (!keys.length) return false;

  let changed = false;
  keys.forEach((key) => {
    if (permanentIgnoredTaskKeysCache.has(key)) return;
    permanentIgnoredTaskKeysCache.add(key);
    changed = true;
  });
  if (!changed) return true;

  const values = Array.from(permanentIgnoredTaskKeysCache).slice(-1000);
  permanentIgnoredTaskKeysCache = new Set(values);
  await chrome.storage.local.set({ [PERMANENT_IGNORED_TASK_KEYS_KEY]: values });
  if (!isCurrent()) return false;
  log("warn", `已永久忽略${taskType || normalizedTask.taskType || "非评论"}任务：${describeTaskForLog(normalizedTask)}`);
  return true;
}

async function getReplyHistoryRecords() {
  try {
    const stored = await chrome.storage.local.get([REPLY_HISTORY_RECORDS_KEY]);
    return normalizeReplyHistoryRecords(stored[REPLY_HISTORY_RECORDS_KEY]);
  } catch (_) {
    return [];
  }
}

async function queryTweetReplyHistory(tweet = {}, task = {}) {
  const tweetUrl = normalizeTweetUrl(tweet?.url || task?.tweetUrl || "");
  if (!tweetUrl) return { ok: true, replied: false, reason: "missing_tweet_url" };

  const records = await getReplyHistoryRecords();
  const record = records.find((item) => normalizeTweetUrl(item.tweetUrl || "", true) === normalizeTweetUrl(tweetUrl, true));
  if (!record) return { ok: true, replied: false, tweetUrl };

  return {
    ok: true,
    replied: true,
    source: "local_reply_history",
    tweetUrl,
    record,
    message: "本地回复记录显示该推文已回复"
  };
}

async function recordReplyHistory(result = {}) {
  const isCurrent = captureRunGuard();
  const replyText = String(result.replyText || "").trim();
  if (!replyText) return false;

  const task = runtimeState.currentTask || {};
  const tweet = result.tweet || {};
  const record = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
    tweetUrl: normalizeTweetUrl(tweet.url || task.tweetUrl || ""),
    authorName: trimRecordText(tweet.authorName || task.authorName || "", 80),
    authorHandle: trimRecordText(tweet.authorHandle || task.handle || "", 40),
    tweetText: trimRecordText(tweet.text || task.tweetText || task.tweetContent || task.detailText || task.listText || "", 500),
    replyText: trimRecordText(replyText, 280),
    mode: trimRecordText(result.mode || "", 20),
    taskTitle: trimRecordText(task.candidateTitle || task.title || "", 120),
    bounty: resolveTaskBounty(task)
  };

  const records = await getReplyHistoryRecords();
  const dedupeKey = buildReplyHistoryDedupeKey(record);
  const filtered = records.filter((item) => buildReplyHistoryDedupeKey(item) !== dedupeKey);
  const next = [record, ...filtered].slice(0, MAX_REPLY_HISTORY_RECORDS);
  await chrome.storage.local.set({ [REPLY_HISTORY_RECORDS_KEY]: next });
  if (isCurrent()) log("info", `已记录回复：${record.replyText}`);
  return true;
}

function resolveTaskBounty(task = {}) {
  const direct = Number(task.bounty || task.reward || task.lux || 0);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const text = [
    task.text,
    task.listText,
    task.detailText,
    task.candidateTitle,
    task.title,
    task.taskKey,
    task.selectionId
  ].map((item) => String(item || "")).join(" ");
  const patterns = [
    /预计获得\s*([0-9]+(?:\.[0-9]+)?)\s*LUX/i,
    /([0-9]+(?:\.[0-9]+)?)\s*LUX/i,
    /bounty["':\s]+([0-9]+(?:\.[0-9]+)?)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = Number(match?.[1] || 0);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return "";
}

function normalizeReplyHistoryRecords(value) {
  const list = Array.isArray(value) ? value : [];
  return list
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      id: String(item.id || `${item.createdAt || Date.now()}-${Math.random().toString(16).slice(2)}`),
      createdAt: String(item.createdAt || ""),
      tweetUrl: normalizeTweetUrl(item.tweetUrl || ""),
      authorName: trimRecordText(item.authorName || "", 80),
      authorHandle: trimRecordText(item.authorHandle || "", 40),
      tweetText: trimRecordText(item.tweetText || "", 500),
      replyText: trimRecordText(item.replyText || "", 280),
      mode: trimRecordText(item.mode || "", 20),
      taskTitle: trimRecordText(item.taskTitle || "", 120),
      bounty: item.bounty || ""
    }))
    .filter((item) => item.replyText)
    .slice(0, MAX_REPLY_HISTORY_RECORDS);
}

function buildReplyHistoryDedupeKey(record = {}) {
  const tweetUrl = normalizeTweetUrl(record.tweetUrl || "", true);
  if (tweetUrl) return `tweet|${tweetUrl}`;
  return [
    "",
    normalizeInline(record.replyText || "")
  ].join("|");
}

function trimRecordText(value, maxLength) {
  const normalized = normalizeInline(value);
  const chars = Array.from(normalized);
  const limit = Math.max(10, Number(maxLength) || 120);
  return chars.length <= limit ? normalized : `${chars.slice(0, limit).join("")}...`;
}

function getActiveAttemptedTaskKeys() {
  pruneAttemptedTasks();
  const temporaryKeys = (runtimeState.attemptedTaskRecords || []).map((record) => record.key);
  return Array.from(new Set([...temporaryKeys, ...permanentIgnoredTaskKeysCache]));
}

function pruneAttemptedTasks() {
  const now = Date.now();
  const records = Array.isArray(runtimeState.attemptedTaskRecords)
    ? runtimeState.attemptedTaskRecords
    : (runtimeState.attemptedTaskKeys || []).map((key) => ({ key, expiresAt: now + ATTEMPTED_TASK_DEDUPE_MS }));
  const seen = new Set();
  runtimeState.attemptedTaskRecords = records
    .filter((record) => record && record.key && Number(record.expiresAt || 0) > now)
    .filter((record) => {
      if (seen.has(record.key)) return false;
      seen.add(record.key);
      return true;
    })
    .slice(-240);
  runtimeState.attemptedTaskKeys = runtimeState.attemptedTaskRecords.map((record) => record.key).slice(-240);
}

function getTaskDedupeKeys(task = {}) {
  const keys = [
    task.taskKey,
    task.selectionId,
    task.stableTaskKey,
    task.tweetUrl && normalizeTweetUrl(task.tweetUrl),
    buildStableTaskKey(task),
    task.listText && buildTaskTextKey(task.listText),
    task.detailText && buildTaskTextKey(task.detailText)
  ];
  return Array.from(new Set(keys.map((key) => String(key || "").trim()).filter(Boolean)));
}

function buildStableTaskKey(task = {}) {
  const taskType = task.taskType || "评论";
  const bounty = Number(task.bounty || 0);
  const handle = normalizeInline(task.handle || "");
  const title = normalizeInline(task.candidateTitle || task.title || "");
  if (!handle && !title && !bounty) return "";
  return ["stable", taskType, bounty.toFixed(2), handle.toLowerCase(), title.slice(0, 80)].join("|");
}

function buildTaskTextKey(text) {
  return `text|${normalizeInline(text).slice(0, 220)}`;
}

function normalizeInline(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function describeTaskForLog(task = {}) {
  return [
    task.bounty ? `${task.bounty}LUX` : "",
    task.handle || "",
    task.candidateTitle || task.title || ""
  ].filter(Boolean).join(" · ") || "当前任务";
}

function isIgnoredNonCommentTask(task = {}) {
  const explicitTaskType = normalizeInline(task.taskType || "");
  if (explicitTaskType) return explicitTaskType === "原创推文" || explicitTaskType === "转发" || explicitTaskType === "关注" || explicitTaskType === "Follow";

  const text = normalizeInline([task.title, task.candidateTitle, task.text, task.listText, task.detailText].filter(Boolean).join(" "));
  return /原创推文|原创建推文|原创内容|发推|发布推文|创建推文|发一条推文|转发|转推|Repost|Retweet|关注任务|\bFollow\b/i.test(text);
}

function failStep(result, fallbackMessage) {
  runtimeState.failed += 1;
  const message = result && (result.message || result.error) ? result.message || result.error : fallbackMessage;
  log("error", message);
  return { ok: false, error: message, result, state: runtimeState };
}

function shouldSuppressContradictoryContentLog(message) {
  const text = normalizeForLogFilter(message.text || "");
  const phase = message.page?.phase || "";
  if (!text || !phase) return false;

  if (phase === "detail_loading" || phase === "detail_ready" || phase === "detail_error") {
    return [
      "任务入口未打开详情",
      "仍停留在任务广场",
      "尝试下一个入口",
      "暂停扫描任务广场",
      "任务广场暂无",
      "未找到可执行",
      "准备打开评论任务"
    ].some((needle) => text.includes(needle));
  }

  if (phase === "campaigns") {
    return [
      "等待任务详情加载完成",
      "任务详情加载中",
      "任务入口点击已生效"
    ].some((needle) => text.includes(needle));
  }

  return false;
}

function normalizeForLogFilter(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function setStage(stage) {
  if (runtimeState.manuallyStopped) return;
  runtimeState.stage = stage;
  persistAutoRunState();
  publishLighthouseMonitorSnapshot("stage");
}

function log(level, text, meta = null) {
  if (runtimeState.manuallyStopped) return;
  runtimeState.logs = runtimeState.logs || [];
  runtimeState.logs.unshift({
    at: new Date().toISOString(),
    level,
    text,
    source: meta?.source || "background",
    pagePhase: meta?.page?.phase || ""
  });
  runtimeState.logs = runtimeState.logs.slice(0, 120);
  persistAutoRunState();
  publishLighthouseMonitorSnapshot("log");
}

async function restoreAutoRunState() {
  try {
    const stored = await chrome.storage.local.get([AUTO_RUN_STATE_KEY]);
    const saved = stored[AUTO_RUN_STATE_KEY];
    if (!saved || typeof saved !== "object") return;
    if (saved.manuallyStopped) {
      runtimeState = { ...createInitialState(), manuallyStopped: true, stage: "stopped", runId: saved.runId || createRunId(), stopEpoch: saved.stopEpoch, logs: Array.isArray(saved.logs) ? saved.logs.filter(entry => entry.text === "已停止运行").slice(0, 1) : [] };
      return;
    }
    const resumableScan = canResumeInterruptedClaimScan(saved.uncertainAction, saved);
    const automaticMode = saved.mode === "auto" || saved.mode === "selected_once" && saved.selectedTask;
    const mayResume = saved.running === true && automaticMode && (!saved.uncertainAction || resumableScan);
    runtimeState = {
      ...createInitialState(),
      ...saved,
      running: false,
      mode: "idle",
      stage: mayResume ? "interrupted_not_resumed" : "stopped",
      resumeMode: saved.mode,
      logs: Array.isArray(saved.logs) ? saved.logs.slice(0, 120) : [],
      pendingXOpen: null,
      // Only the live worker owns a refresh; no in-flight operation survives
      // a service-worker restart, even if its snapshot was persisted mid-way.
      marketplaceRefreshInFlight: false,
      completionEvidence: saved.completionEvidence?.incomeVerified && !saved.completionEvidence.officialCompletion ? null : (saved.completionEvidence || null),
      runId: saved.runId || createRunId()
    };
    if (resumableScan) {
      // Revoke the old document's permit before accepting any new messages.
      // A persisted no-click checkpoint is valid across worker lifetimes;
      // a recorded click (or a legacy intent) must remain protected.
      delete runtimeState.uncertainAction;
      try { await persistAutoRunState(true); }
      catch (_) {
        runtimeState.uncertainAction = saved.uncertainAction;
        runtimeState.stage = "stopped";
        return;
      }
    }
    const protectedOrder = runtimeState.uncertainAction || runtimeState.completionEvidence || runtimeState.lastXResult
      || [runtimeState.currentTask].some(task => task && (
        task.invitationAccepted || task.claimed || task.seatLocked || task.seatLockedAt));
    if (!protectedOrder) {
      // Older releases cached unclaimed tasks and even treated a batch
      // estimate as an account-wide wait. The plaza is authoritative for
      // unclaimed availability; permanent tier exclusions live separately.
      runtimeState.attemptedTaskRecords = [];
      runtimeState.attemptedTaskKeys = [];
      const refusal = runtimeState.logs.find(entry => /^(?:\[详情页\]\s*)?平台明确拒绝本次锁位：/.test(entry.text || ""));
      const batch = String(refusal?.text || "").replace(/\s+/g, "")
        .match(/^(?:\[详情页\])?平台明确拒绝本次锁位：本批名额暂不可领取，请约([1-9]\d{0,3})分钟后重试[。.]?$/);
      const refusalAt = Date.parse(refusal?.at || "");
      const deadline = Number(runtimeState.claimRetryNotBefore);
      const expectedDeadline = refusalAt + Number(batch?.[1] || 0) * 60000;
      if (batch && Number.isFinite(refusalAt) && deadline >= expectedDeadline
          && deadline - expectedDeadline <= 60000) {
        delete runtimeState.claimRetryNotBefore;
        log("info", "已移除旧版误设的批次等待；恢复后读取任务广场最新倒计时");
      }
    }
    // Reading an already-stopped snapshot is not a new run event. Logging it
    // here would append and persist another warning on every worker wakeup.
    if (saved.running === true) {
      log("warn", mayResume ? "Chrome 后台恢复了中断的 Lighthouse 状态，等待保活闹钟自动续跑（先核对订单）" : "已恢复 Lighthouse 订单记录，保持停止状态");
    }
    if (mayResume) await ensureAutoRunKeepalive();
  } catch (_) {
    // A corrupt or stale snapshot must never prevent a fresh run.
  }
}

async function ensureAutoRunKeepalive() {
  try {
    if (typeof chrome === "undefined" || !chrome.alarms) return;
    await chrome.alarms.create(AUTO_RUN_KEEPALIVE_ALARM, {
      delayInMinutes: 0.5,
      periodInMinutes: 0.5
    });
  } catch (_) {
    // Keepalive is best-effort; the run itself must never fail because of it.
  }
}

async function clearAutoRunKeepalive() {
  try {
    if (typeof chrome === "undefined" || !chrome.alarms) return;
    await chrome.alarms.clear(AUTO_RUN_KEEPALIVE_ALARM);
  } catch (_) {}
}

async function armCampaignsIdleReloadAlarm() {
  try {
    if (typeof chrome === "undefined" || !chrome.alarms) return;
    await chrome.alarms.create(CAMPAIGNS_IDLE_RELOAD_ALARM, {
      delayInMinutes: CAMPAIGNS_IDLE_REFRESH_MS / 60000
    });
  } catch (_) {
    // The keepalive watchdog remains as a fallback when this alarm is unavailable.
  }
}

async function clearCampaignsIdleReloadAlarm() {
  try {
    if (typeof chrome === "undefined" || !chrome.alarms) return;
    await chrome.alarms.clear(CAMPAIGNS_IDLE_RELOAD_ALARM);
  } catch (_) {}
}

async function handleAutoRunKeepaliveTick() {
  await runtimeStateReady;
  if (runtimeState.manuallyStopped) {
    const stoppedState = runtimeState;
    await clearAutoRunKeepalive();
    if (runtimeState === stoppedState && runtimeState.manuallyStopped) await clearCampaignsIdleReloadAlarm();
    return;
  }
  const tickState = runtimeState;
  const tickRunId = runtimeState.runId;
  const tickStopEpoch = runtimeState.stopEpoch;
  const isCurrentTick = () => runtimeState === tickState && runtimeState.runId === tickRunId && runtimeState.stopEpoch === tickStopEpoch;
  if (runtimeState.running && (runtimeState.mode === "auto" || runtimeState.mode === "selected_once")) {
    // Any extension API call resets the MV3 idle timer; the alarm wake itself
    // already restarted the 30s window, this touch makes it deterministic.
    try { await chrome.runtime.getPlatformInfo(); } catch (_) {}
    if (!isCurrentTick() || !runtimeState.running) return;
    const currentTask = runtimeState.currentTask || {};
    const noCurrentTask = !runtimeState.currentTask;
    const hasLockedTask = Boolean(
      runtimeState.currentTask
      && (currentTask.invitationAccepted || currentTask.seatLocked === true || currentTask.seatLockedAt || currentTask.claimed === true)
    );
    const hasUnclaimedTask = Boolean(runtimeState.currentTask && !hasLockedTask);
    const noActiveOrder = noCurrentTask || hasUnclaimedTask;
    const isSelectingTaskStage = runtimeState.stage === "selecting_task";
    if (runtimeState.mode === "auto"
      && noActiveOrder
      // An unanswered scan can already have clicked a claim. Only the page's
      // structured receipt may release its intent and request a safe reload.
      && !runtimeState.uncertainAction
      && !(Number(runtimeState.claimRetryNotBefore) > Date.now())
      && Date.now() - Number(runtimeState.lastProgressAt || 0) >= CAMPAIGNS_IDLE_REFRESH_MS
      && !runtimeState.marketplaceRefreshInFlight
      && Number.isInteger(runtimeState.lighthouseTabId)) {
      const recoveringState = runtimeState;
      let recoveringRunId = runtimeState.runId;
      const ownsRecovery = () => runtimeState === recoveringState && runtimeState.runId === recoveringRunId && runtimeState.stopEpoch === tickStopEpoch;
      recoveringState.marketplaceRefreshInFlight = true;
      try {
        const options = runtimeState.startOptions || {};
        const windowId = getRuntimeWindowId();
        log("info", `Lighthouse 任务广场连续 5 分钟无活动（${isSelectingTaskStage ? "任务选择阶段" : "流程空闲阶段"}），停止当前运行并重新执行全量检测`);
        const marketplaceTabId = runtimeState.lighthouseTabId;
        await cancelCurrentRun(ownsRecovery);
        if (!ownsRecovery()) return;
        await clearAutoRunResumeSchedule();
        if (!ownsRecovery()) return;
        await clearAutoRunKeepalive();
        if (!ownsRecovery()) return;
        await clearCampaignsIdleReloadAlarm();
        if (!ownsRecovery()) return;
        runtimeState.running = false;
        runtimeState.scheduledResumeAt = 0;
        recoveringRunId = runtimeState.runId = createRunId();
        clearXOpenWatch();
        setStage("stopped");
        if (Number.isInteger(marketplaceTabId)) {
          await chrome.tabs.reload(marketplaceTabId);
          if (!ownsRecovery()) return;
          const reloaded = await waitForTabComplete(marketplaceTabId);
          if (!ownsRecovery()) return;
          if (reloaded === false && !await waitForCampaignsReloadReadiness(marketplaceTabId, ownsRecovery)) throw new Error("重新检测前 Lighthouse 页面加载超时");
        }
        if (!ownsRecovery()) return;
        // startAutoRun can keep scanning for hours. Observe its refusal/error
        // without holding the old recovery lock for that entire run.
        const restartPromise = startAutoRun(options, windowId);
        const restartedState = runtimeState;
        const restartedRunId = runtimeState.runId;
        const restartStopEpoch = runtimeState.stopEpoch;
        const ownsRestart = () => runtimeState === restartedState && runtimeState.runId === restartedRunId && runtimeState.stopEpoch === restartStopEpoch;
        void restartPromise.then((result) => {
          if (ownsRestart() && result?.ok === false && !result.cancelled) {
            log("error", `Lighthouse 重新执行全量检测被拒绝：${result.error || result.message || "启动条件未满足"}`);
          }
        }).catch((error) => {
          if (!ownsRestart()) return;
          runtimeState.running = false;
          setStage("auto_restart_failed");
          log("error", `Lighthouse 重新执行全量检测失败：${error.message || String(error)}`);
        });
      } catch (error) {
        if (!ownsRecovery()) return;
        runtimeState.running = false;
        setStage("campaigns_reload_failed");
        log("error", `Lighthouse 停止并重新检测失败，已保持停止：${error.message || String(error)}`);
      } finally {
        if (ownsRecovery()) recoveringState.marketplaceRefreshInFlight = false;
      }
    }
    return;
  }
  if (await tryResumeAutoRunAfterInterruption()) return;
  if (runtimeState !== tickState || runtimeState.running) return;
  // Recovery may rotate this same state's runId before failing safely. Its
  // stopped alarms still need cleanup, without clearing a later run's alarms.
  const idleRunId = runtimeState.runId;
  const isCurrentIdle = () => runtimeState === tickState && runtimeState.runId === idleRunId && !runtimeState.running && runtimeState.stopEpoch === tickStopEpoch;
  // No active run and nothing safe to resume: stop keeping the worker awake.
  await clearAutoRunKeepalive();
  if (!isCurrentIdle()) return;
  await clearCampaignsIdleReloadAlarm();
}

async function tryResumeAutoRunAfterInterruption() {
  if (runtimeState.manuallyStopped) return false;
  if (runtimeState.running) return true;
  if (runtimeState.uncertainAction) return false;
  if (runtimeState.mode !== "idle" || runtimeState.stage !== "interrupted_not_resumed") return false;
  const savedTask = runtimeState.currentTask || {};
  const completedOrder = hasLatchedLighthouseCompletion(runtimeState.runId);
  const hasLockedIncompleteSeat = Boolean(
    (savedTask.invitationAccepted || savedTask.claimed || savedTask.seatLocked === true || savedTask.seatLockedAt
      || runtimeState.lastXResult || runtimeState.completionEvidence) && !completedOrder
  );
  if (hasLockedIncompleteSeat) {
    log("error", `service worker 重启后仍有已锁定未完成的订单（${describeTaskForLog(savedTask)}），不自动续跑，请人工处理该订单后重新启动`);
    return false;
  }
  const recoveringState = runtimeState;
  let recoveringRunId = runtimeState.runId;
  const isCurrentRecovery = () => runtimeState === recoveringState && runtimeState.runId === recoveringRunId;
  try {
    // Persisted window IDs may no longer exist after Chrome closes or restarts.
    const windowId = Number.isInteger(runtimeState.lighthouseWindowId)
      ? runtimeState.lighthouseWindowId : runtimeState.runtimeWindowId;
    if (Number.isInteger(windowId)) await chrome.windows.get(windowId);
    if (!isCurrentRecovery() || runtimeState.running || runtimeState.stage !== "interrupted_not_resumed") return runtimeState.running;

    // Cancel the old content-script run before resuming in the same window.
    if (Number.isInteger(runtimeState.lighthouseTabId)) {
      try {
        await chrome.tabs.sendMessage(runtimeState.lighthouseTabId, {
          type: "CANCEL_LIGHTHOUSE_RUN",
          runId: runtimeState.runId
        });
      } catch (_) {}
    }
    if (!isCurrentRecovery() || runtimeState.running || runtimeState.stage !== "interrupted_not_resumed") return runtimeState.running;
    if (completedOrder && Number.isInteger(runtimeState.xTabId)) {
      try { await chrome.tabs.sendMessage(runtimeState.xTabId, {type: "CANCEL_X_RUN", runId: runtimeState.runId}); }
      catch (_) {}
      if (!isCurrentRecovery() || runtimeState.running || runtimeState.stage !== "interrupted_not_resumed") return runtimeState.running;
    }
    if (runtimeState.resumeMode === "selected_once" && !completedOrder) {
      const selectedTask = runtimeState.selectedTask;
      if (!selectedTask) return false;
      await runSelectedCountdownTask(selectedTask, windowId);
      return runtimeState.running;
    }
    recoveringRunId = runtimeState.runId = createRunId();
    runtimeState.running = true;
    runtimeState.mode = runtimeState.resumeMode === "selected_once" ? "selected_once" : "auto";
    if (completedOrder) runtimeState.completionEvidence = { ...runtimeState.completionEvidence, runId: recoveringRunId };
    await armCampaignsIdleReloadAlarm();
    if (!isCurrentRecovery() || !runtimeState.running) return runtimeState.running;
    if (completedOrder) {
      setStage("completion_resumed_after_restart");
      log("info", "后台恢复了本单完成证据，继续返回广场；不重复评论、提交或计数");
      await handleLighthouseDone({ok: true, message: "已恢复完成订单，继续接单"}, true);
      return runtimeState.running;
    }
    runtimeState.xTabId = null;
    runtimeState.xTabWindowId = null;
    runtimeState.lastXResult = null;
    setStage("auto_resumed_after_restart");
    log("warn", "service worker 重启，已自动恢复正式模式继续扫描任务广场");
    await startNextAutoTask("resume_after_service_worker_restart");
    return runtimeState.running;
  } catch (error) {
    if (!isCurrentRecovery()) return runtimeState.running;
    runtimeState.running = false;
    const windowMissing = /No window with id|Window not found/i.test(error?.message || String(error));
    setStage(windowMissing ? "runtime_window_missing" : "auto_resume_failed");
    log("warn", windowMissing
      ? "原运行窗口已关闭，已停止自动恢复并保留订单；请在目标窗口核对后重新启动"
      : `Lighthouse 自动恢复失败，已停止并保留订单：${error.message || String(error)}`);
    return false;
  }
}

function touchAutoRunState() {
  runtimeState.lastProgressAt = Date.now();
  persistAutoRunState();
  if (runtimeState.running && runtimeState.mode === "auto") {
    void armCampaignsIdleReloadAlarm();
  }
}

function persistAutoRunState(requireSuccess = false) {
  const snapshot = {
    ...runtimeState,
    pendingXOpen: null,
    logs: Array.isArray(runtimeState.logs) ? runtimeState.logs.slice(0, 120) : []
  };
  if (requireSuccess) return chrome.storage.local.set({ [AUTO_RUN_STATE_KEY]: snapshot });
  chrome.storage.local.set({ [AUTO_RUN_STATE_KEY]: snapshot }, () => {
    void chrome.runtime.lastError;
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  const low = Math.min(Number(min) || 0, Number(max) || 0);
  const high = Math.max(Number(min) || 0, Number(max) || 0);
  return Math.floor(low + Math.random() * (high - low + 1));
}

function formatDuration(ms) {
  const total = Math.max(0, Math.ceil(Number(ms || 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
