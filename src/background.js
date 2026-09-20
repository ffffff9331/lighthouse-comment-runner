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
  aiProvider: "gpt-5.6-terra",
  aiModel: "gpt-5.6-terra",
  aiApiUrl: "",
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
const runtimeStateReady = restoreAutoRunState();
const activeAIRequests = new Set();
let monitorCountdowns = { tasks: [], timestamp: 0 };
let lastXTaskWidgetNotifyAt = 0;
let lastCampaignsRefreshAt = 0;
let monitorSnapshotPromise = null;
let permanentIgnoredTaskKeysLoaded = false;
let permanentIgnoredTaskKeysCache = new Set();
let lighthouseMonitorLastWriteAt = 0;
let lighthouseMonitorPendingTimer = null;
const lighthouseAlertBridgeUrls = new Map();
let capturedTargetRecoveryPromise = null;
let directTweetOpenPromise = null;
let selectedStartInFlight = false;
let manualDebugCommandTail = Promise.resolve();

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
  try {
    const snapshot = await buildLighthouseMonitorSnapshot(reason);
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

publishLighthouseMonitorSnapshot("startup", { force: true });

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(["settings", "monitorSettings"]);
  if (!stored.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
  if (!stored.monitorSettings) {
    await chrome.storage.local.set({ monitorSettings: DEFAULT_MONITOR_SETTINGS });
  }
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== AUTO_RUN_KEEPALIVE_ALARM) return;
  void handleAutoRunKeepaliveTick();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      log("error", error.message || String(error));
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
  recordPotentialLighthouseOpenedXTab(tab);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && tab.status !== "complete") return;
  recordPotentialLighthouseOpenedXTab(tab || { id: tabId, url: changeInfo.url });
});

async function handleMessage(message, sender) {
  await runtimeStateReady;
  if (!message || !message.type) return { ok: false, error: "Missing message type" };
  const messageWindowId = getMessageWindowId(message, sender);
  if (message.type === "RUN_SELECTED_COUNTDOWN_TASK") {
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
  if (runtimeState.mode === "auto" && ["LIGHTHOUSE_TASK_READY", "X_REPLY_RESULT", "LIGHTHOUSE_TASK_DONE"].includes(message.type)) {
    return { ok: true, ignored: true };
  }
  if (isWindowScopedCommand(message.type)) {
    const lockResult = lockRuntimeWindowForCommand(messageWindowId, message.type);
    if (!lockResult.ok) return { ok: false, error: lockResult.error, state: runtimeState };
  }

  switch (message.type) {
    case "GET_STATE":
      return { ok: true, state: runtimeState, settings: await getSettings() };
    case "SAVE_SETTINGS":
      await chrome.storage.local.set({ settings: normalizeSettings(message.settings) });
      if (runtimeState.running && runtimeState.mode === "auto" && runtimeState.stage === "auto_waiting_schedule") {
        await reconcileWaitingAutoRunSchedule();
      }
      log("info", "配置已保存");
      return { ok: true, settings: await getSettings(), state: runtimeState };
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
      return startAutoRun(message.options || {}, messageWindowId);
    case "STOP_RUN":
      await cancelCurrentRun();
      await clearAutoRunResumeSchedule();
      await clearAutoRunKeepalive();
      runtimeState.running = false;
      runtimeState.scheduledResumeAt = 0;
      runtimeState.runId = createRunId();
      clearXOpenWatch();
      setStage("stopped");
      log("warn", "已停止运行");
      return { ok: true, state: runtimeState };
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
    case "HIGH_BOUNTY_ALERT":
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
      {
        const monitorSettings = await getMonitorSettings();
        const speechText = buildMonitorSpeechText(message.speechData || {}, monitorSettings, message.voiceText || message.text || "");
        await forwardPanelSpeech(speechText, monitorSettings);
      }
      log("info", `高赏金警报：${message.bounty} LUX`);
      return { ok: true, state: runtimeState };
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
      return { ok: true, ...toPublicMonitorSettings(monitorSettings), seenCount: message.seenCount || 0 };
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

async function prepareDebugRunForCommand(windowId, commandType) {
  if (runtimeState.running && runtimeState.mode === "debug") {
    setRuntimeWindow(windowId);
    return;
  }

  const previousMode = runtimeState.mode || "idle";
  if (runtimeState.running) {
    await Promise.all([
      cancelCurrentRun(),
      clearAutoRunResumeSchedule(),
      clearAutoRunKeepalive()
    ]);
  }
  runtimeState.running = true;
  runtimeState.mode = "debug";
  runtimeState.runId = createRunId();
  runtimeState.scheduledResumeAt = 0;
  setRuntimeWindow(windowId);
  setStage("debug_takeover");
  log("info", `单步控制已接管 ${previousMode} 流程：${commandType}`);
}

function enqueueManualDebugCommand(message, windowId) {
  const operation = manualDebugCommandTail.then(() => runManualDebugCommand(message, windowId));
  manualDebugCommandTail = operation.catch(() => {});
  return operation;
}

async function runManualDebugCommand(message, windowId) {
  const lockResult = lockRuntimeWindowForCommand(windowId, message.type);
  if (!lockResult.ok) {
    return { ok: false, error: lockResult.error, state: runtimeState };
  }
  await prepareDebugRunForCommand(windowId, message.type);

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
    log("info", `${title}：${detail || message.tweetUrl || ""}`);
  }
  return { ok: true, state: runtimeState };
}

async function forwardPanelSpeech(text, existingSettings = null) {
  const value = String(text || "").trim();
  if (!value) return false;
  const monitorSettings = existingSettings || await getMonitorSettings();
  if (!monitorSettings.voiceEnabled) return false;
  try {
    await chrome.runtime.sendMessage({
      type: "PANEL_SPEAK_TEXT",
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
  const cacheAge = Date.now() - (monitorCountdowns.timestamp || 0);
  if (monitorCountdowns.tasks.length > 0 && cacheAge < MONITOR_COUNTDOWN_CACHE_TTL_MS) {
    return { ok: true, tasks: monitorCountdowns.tasks, timestamp: monitorCountdowns.timestamp, source: "cache" };
  }

  const snapshot = await requestMonitorCountdownSnapshot(preferredWindowId);
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
  if (monitorSnapshotPromise) return monitorSnapshotPromise;
  monitorSnapshotPromise = (async () => {
    const tabs = await queryLighthouseTabs(preferredWindowId);
    const activeTabs = tabs.filter((tab) => tab.active);
    const candidates = [...activeTabs, ...tabs].filter((tab, index, arr) => arr.findIndex((item) => item.id === tab.id) === index);
    for (const tab of candidates) {
      try {
        let response = await sendMonitorSnapshotMessage(tab.id);
        if (!response?.ok && await ensureMonitorContentScriptInjected(tab.id)) {
          await delay(500);
          response = await sendMonitorSnapshotMessage(tab.id);
        }
        if (response?.ok) return response;
      } catch (_) {}
    }
    return { ok: false };
  })();
  try {
    return await monitorSnapshotPromise;
  } finally {
    monitorSnapshotPromise = null;
  }
}

async function sendMonitorSnapshotMessage(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "MONITOR_GET_COUNTDOWNS_SNAPSHOT" });
  } catch (_) {
    return null;
  }
}

async function ensureMonitorContentScriptInjected(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isLighthouseUrl(tab.url)) return false;
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content/lighthouse-monitor.js"]
    });
    log("warn", "已为 Lighthouse 页面补注入倒计时监控脚本");
    return true;
  } catch (error) {
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

async function startAutoRun(options, windowId = null) {
  if (runtimeState.running) return { ok: false, error: "当前流程仍在执行" };
  runtimeState = createInitialState();
  setRuntimeWindow(windowId);
  runtimeState.runId = createRunId();
  runtimeState.running = true;
  runtimeState.mode = "auto";
  runtimeState.startOptions = sanitizeAutoRunStartOptions(options);
  setStage("auto_starting");
  log("info", "全量检测指令已接收，正在准备 Lighthouse 页面");
  const settings = await getSettings();
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
  // Armed only once every preflight check has passed; a blocked start must
  // not leave a keepalive alarm ticking.
  await ensureAutoRunKeepalive();
  const tab = await getOrCreateLighthouseTab(runtimeState.startOptions?.lighthouseUrl || LIGHTHOUSE_CAMPAIGNS_URL);
  rememberLighthouseTab(tab);
  if (!await focusLighthouseTabForAutoScan(tab.id)) {
    log("warn", "Chrome 正在调整 Lighthouse 标签，稍后继续检测任务广场");
    await delay(Math.max(settings.actionDelayMs, 1000));
    return startNextAutoTask("retry_after_lighthouse_tab_busy");
  }
  await waitForTabComplete(tab.id);
  runtimeState.scheduledResumeAt = 0;
  log("info", "全量检测已启动：按旧任务页锁定流程顺序执行");
  setStage("auto_started");
  await startNextAutoTask("start");
  return { ok: true, state: runtimeState };
}

async function startNextAutoTask(reason) {
  const runId = runtimeState.runId;
  if (!isActiveAutoRun(runId)) return { ok: false, error: "Auto run is not active" };
  const settings = await getSettings();
  const scheduleState = getAutoRunScheduleState(settings);
  if (!scheduleState.inWindow) {
    await enterAutoRunScheduleWait(scheduleState, "当前不在运行时间，等待下一次自动开始");
    return { ok: true, state: runtimeState };
  }
  await clearAutoRunResumeSchedule();
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

  const tabId = (await getOrCreateLighthouseTab(LIGHTHOUSE_CAMPAIGNS_URL)).id;
  if (!isActiveAutoRun(runId)) return { ok: true, state: runtimeState };
  await rememberLighthouseTabById(tabId);
  if (!await focusLighthouseTabForAutoScan(tabId)) {
    log("warn", "Chrome 正在调整 Lighthouse 标签，稍后继续检测任务广场");
    await delay(Math.max(settings.actionDelayMs, 1000));
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
  pruneAttemptedTasks();

  beginXOpenWatch(tabId, "auto");
  const result = await sendToTab(tabId, {
    type: "START_LIGHTHOUSE_COMMENT_TASK",
    runId,
    settings,
    attemptedTaskKeys: getActiveAttemptedTaskKeys()
  });
  if (!isActiveAutoRun(runId)) return { ok: true, state: runtimeState };

  if (!result || !result.ok) {
    clearXOpenWatch();
    if (result?.refreshRequested) {
      const refreshState = await refreshLighthouseCampaignsTab(tabId, result.message || "任务广场陈旧可做列表刷新后继续下一轮");
      if (refreshState.ok) {
        setStage("campaigns_refreshed");
        log("info", result.message || "任务广场陈旧可做列表已刷新，重新寻找下一条评论/点赞互动任务");
        await delay(Math.max(settings.actionDelayMs || 500, 1200));
        return startNextAutoTask("retry_after_campaigns_refresh");
      }
      if (refreshState.skippedCooldown) {
        setStage("selecting_task");
        log("info", refreshState.message || "任务广场刷新冷却中，继续等待列表恢复");
        await delay(Math.max(15000, settings.actionDelayMs * 2));
        return startNextAutoTask("retry_after_campaigns_refresh_cooldown");
      }
      setStage("task_select_failed");
      runtimeState.failed += 1;
      log("warn", "任务广场请求刷新，但刷新失败，按任务选择失败继续恢复");
      await delay(settings.actionDelayMs * 2);
      return startNextAutoTask("retry_after_campaigns_refresh_failed");
    }
    if (result?.permanentIgnore) {
      const ignoredTask = result.task || runtimeState.currentTask || {};
      await markPermanentIgnoredTask(ignoredTask, result.ignoredTaskType || ignoredTask.taskType || "非评论");
      setStage("task_permanently_ignored");
      log("warn", result.message || result.error || "已永久忽略非评论任务，继续寻找下一条评论/点赞互动任务");
      await closeLighthouseTaskDetail(tabId, settings, "永久忽略非评论任务后关闭详情面板");
      await delay(settings.actionDelayMs * 2);
      return startNextAutoTask("retry_after_permanent_ignore");
    }
    const transient = !!result?.transient;
    if (transient) {
      runtimeState.attempts += 1;
    } else {
      runtimeState.failed += 1;
    }
    const failedTask = transient ? null : (result?.task || runtimeState.currentTask)
      ? { ...(runtimeState.currentTask || {}), ...(result?.task || {}) }
      : null;
    if (failedTask) {
      markAttemptedTask(failedTask);
    } else if (!transient) {
      runtimeState.attempts += 1;
    }
    setStage("task_select_failed");
    log(transient ? "info" : "warn", result?.message || result?.error || "任务选择失败，准备尝试下一条");
    await closeLighthouseTaskDetail(tabId, settings, "任务选择失败后关闭详情面板");
    await delay(settings.actionDelayMs * 2);
    return startNextAutoTask("retry_after_task_select_failed");
  }

  if (result.task) {
    markAttemptedTask(result.task);
    runtimeState.currentTask = mergeTaskPreservingCapturedTweetUrl(runtimeState.currentTask, result.task);
  }
  runtimeState.completionEvidence = null;
  await sendToTab(tabId, { type: "BEGIN_LIGHTHOUSE_COMPLETION_WATCH", runId, task: runtimeState.currentTask });
  // The content script has completed the lock step.  Continue the X handoff
  // in this same background flow so the five-second fallback cannot race an
  // unawaited runtime message from the page.
  return adoptTargetOpenedTweet(runtimeState.currentTask, tabId, "auto");
}

async function debugOpenCampaigns(windowId = null) {
  runtimeState = createInitialState();
  setRuntimeWindow(windowId);
  runtimeState.runId = createRunId();
  runtimeState.running = true;
  runtimeState.mode = "debug";

  const activeTab = await getActiveLighthouseTab();
  if (activeTab) {
    rememberLighthouseTab(activeTab);
    await chrome.tabs.update(activeTab.id, { active: true });
    await waitForTabComplete(activeTab.id);
    setStage("lighthouse_page_detected");
    log("info", "已检测到当前 Lighthouse 页面，复用当前页，不重新跳转");
    return { ok: true, state: runtimeState };
  }

  const tab = await getOrCreateLighthouseTab(LIGHTHOUSE_CAMPAIGNS_URL);
  rememberLighthouseTab(tab);
  await chrome.tabs.update(tab.id, { url: LIGHTHOUSE_CAMPAIGNS_URL, active: true });
  await waitForTabComplete(tab.id);
  setStage("campaigns_opened");
  log("info", "已打开任务广场");
  return { ok: true, state: runtimeState };
}

async function debugOpenFirstTask() {
  const tabId = await resolveLighthouseTab();
  const settings = await getSettings();
  await chrome.tabs.update(tabId, { active: true });
  await ensurePermanentIgnoredTaskKeysLoaded();
  let result = await sendToTab(tabId, {
    type: "DEBUG_OPEN_FIRST_COMMENT_TASK",
    runId: runtimeState.runId,
    settings,
    attemptedTaskKeys: getActiveAttemptedTaskKeys()
  });
  if (result?.refreshRequested) {
    const refreshState = await refreshLighthouseCampaignsTab(tabId, result.message || "任务广场陈旧可做列表刷新后重试");
    if (refreshState.ok) {
      result = await sendToTab(tabId, {
        type: "DEBUG_OPEN_FIRST_COMMENT_TASK",
        runId: runtimeState.runId,
        settings,
        attemptedTaskKeys: getActiveAttemptedTaskKeys()
      });
    } else if (refreshState.skippedCooldown) {
      return failStep({ message: refreshState.message }, "任务广场刷新冷却中");
    }
  }
  if (!result || !result.ok) {
    if (result?.permanentIgnore) {
      await markPermanentIgnoredTask(result.task || {}, result.ignoredTaskType || result.task?.taskType || "非评论");
      await closeLighthouseTaskDetail(tabId, settings, "永久忽略非评论任务后关闭详情");
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
  const tabId = await resolveLighthouseTab();
  const settings = await getSettings();
  await chrome.tabs.update(tabId, { active: true });
  setStage("locking_seat");
  beginXOpenWatch(tabId, "debug");
  const result = await sendToTab(tabId, { type: "DEBUG_LOCK_SEAT_AND_EXTRACT", runId: runtimeState.runId, settings });
  if (!result || !result.ok) {
    clearXOpenWatch();
    return failStep(result, "锁定席位或提取推文失败");
  }

  runtimeState.currentTask = mergeTaskPreservingCapturedTweetUrl(runtimeState.currentTask, result.task);
  markAttemptedTask(result.task);
  const adopted = await waitForLighthouseOpenedTweet(result.task, tabId, "debug", {
    waitLogMessage: "锁定席位已点击成功，继续等待平台自动打开 X 推文标签页",
    manualOpenAfterMs: 5000
  });
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
  const tabId = await resolveCurrentXTab({ allowActiveTweetTab: true });
  const settings = await getSettings();
  await chrome.tabs.update(tabId, { active: true });
  await waitForTabComplete(tabId);
  await delay(Math.max(settings.actionDelayMs * 2, 2500));
  const result = await sendToTab(tabId, {
    type: "RUN_X_REPLY",
    runId: runtimeState.runId,
    task: runtimeState.currentTask,
    settings
  });
  if (!result || !result.ok) return failStep(result, "X 回复步骤失败");
  runtimeState.lastXResult = result;
  await recordReplyHistory(result);
  setStage("x_replied");
  log("info", result.message || "X 回复步骤已完成");
  return { ok: true, result, state: runtimeState };
}

async function debugFastXClaimReplyVerify(selectedTask = null, windowId = null) {
  const settings = await getSettings();
  const selected = selectedTask ? { ...selectedTask } : null;
  runtimeState = createInitialState();
  setRuntimeWindow(windowId);
  runtimeState.running = true;
  runtimeState.mode = "debug";

  if (selected && isIgnoredNonCommentTask(selected)) {
    await markPermanentIgnoredTask(selected, selected.taskType || "非评论");
    runtimeState.running = false;
    setStage("original_tweet_ignored");
    log("warn", `已忽略原创/转发任务，不打开详情：${describeTaskForLog(selected)}`);
    return { ok: true, ignored: true, reason: "ignored_non_comment_task", state: runtimeState };
  }

  const tabId = selected
    ? await openSelectedTaskTweetTab(selected, settings)
    : await openNextLighthouseTaskTweetTab(settings);
  runtimeState.xTabId = tabId;
  await waitForTabComplete(tabId);
  setStage("fast_claim_waiting");
  log("info", selected
    ? "新流程：已从 Lighthouse 选中任务进入 X，等待任务控件进入抢单窗口"
    : "新流程：已从 Lighthouse 任务广场打开任务详情并进入 X，等待任务控件进入抢单窗口");

  const claimResult = await sendToTab(tabId, {
    type: "RUN_X_WIDGET_CLAIM",
    runId: runtimeState.runId,
    task: runtimeState.currentTask,
    settings
  });

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
    runId: runtimeState.runId,
    task: runtimeState.currentTask,
    settings: replySettings
  });

  if (!replyResult || !replyResult.ok) {
    runtimeState.failed += 1;
    setStage("fast_reply_failed");
    log("error", replyResult?.message || replyResult?.error || "X 回复失败，已停留当前 X 页面保留现场");
    return { ok: false, result: replyResult, state: runtimeState };
  }

  await recordReplyHistory(replyResult);
  const completionResult = await completeXTaskWidgetLifecycle(tabId, runtimeState.runId, settings);
  if (!completionResult?.ok) {
    runtimeState.failed += 1;
    setStage("fast_completion_failed");
    log("warn", completionResult?.message || completionResult?.error || "X 任务未完成，保留当前页面");
    return { ok: false, result: { claimResult, replyResult, completionResult }, state: runtimeState };
  }

  const campaignsResult = await waitForLighthouseTaskCompletionAndReturn(runtimeState.runId, settings);
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
  if (!selectedTask) {
    log("error", "未选中倒计时任务，请先在任务倒计时列表点击一条任务");
    return { ok: false, error: "未选中任务", state: runtimeState };
  }
  if (selectedStartInFlight) {
    log("warn", "选中启动指令正在处理，请勿重复点击");
    return { ok: false, error: "选中启动正在处理", state: runtimeState };
  }

  selectedStartInFlight = true;
  try {
    if (runtimeState.running) {
      const previousMode = runtimeState.mode || "当前";
      log("info", `选中启动：正在停止 ${previousMode} 流程并接管选中任务`);
      await Promise.all([
        cancelCurrentRun(),
        clearAutoRunResumeSchedule()
      ]);
      runtimeState.scheduledResumeAt = 0;
      runtimeState.runId = createRunId();
    }
    return await runSelectedCountdownTask(selectedTask, windowId);
  } finally {
    selectedStartInFlight = false;
  }
}

async function runSelectedCountdownTask(selectedTask = null, windowId = null) {
  runtimeState = createInitialState();
  setRuntimeWindow(windowId);
  runtimeState.runId = createRunId();
  runtimeState.running = true;
  runtimeState.mode = "selected_once";
  await ensureAutoRunKeepalive();

  if (!selectedTask) {
    runtimeState.running = false;
    setStage("selected_task_missing");
    log("error", "未选中倒计时任务，请先在任务倒计时列表点击一条任务");
    return { ok: false, error: "未选中任务", state: runtimeState };
  }
  if (isIgnoredNonCommentTask(selectedTask)) {
    await markPermanentIgnoredTask(selectedTask, selectedTask.taskType || "非评论");
    runtimeState.running = false;
    setStage("selected_original_tweet_ignored");
    log("warn", `已忽略原创/转发任务，不打开详情：${describeTaskForLog(selectedTask)}`);
    return { ok: true, ignored: true, reason: "ignored_non_comment_task", state: runtimeState };
  }

  const settings = await getSettings();
  if (settings.replyMode !== "post") {
    runtimeState.running = false;
    setStage("selected_task_blocked");
    log("error", "选中启动需要 X 回复模式=自动发送，否则无法安全闭环提交验证");
    return { ok: false, error: "选中启动需要 X 回复模式=自动发送", state: runtimeState };
  }
  if (!settings.autoSubmitLighthouse) {
    runtimeState.running = false;
    setStage("selected_task_blocked");
    log("error", "选中启动需要开启自动提交 Lighthouse，否则回复后不会提交验证");
    return { ok: false, error: "选中启动需要开启自动提交 Lighthouse", state: runtimeState };
  }

  const lighthouseTabId = await resolveLighthouseTab();
  await rememberLighthouseTabById(lighthouseTabId);
  await chrome.tabs.update(lighthouseTabId, { active: true });
  await waitForTabComplete(lighthouseTabId);
  setStage("selected_task_opening");
  log("info", `选中启动：打开任务详情 ${selectedTask.bounty || "?"}LUX · ${selectedTask.title || selectedTask.taskType || "任务"}`);

  const openResult = await sendToTab(lighthouseTabId, {
    type: "OPEN_SELECTED_COUNTDOWN_TASK_DETAIL",
    runId: runtimeState.runId,
    settings,
    selectedTask
  });

  if (!openResult || !openResult.ok) {
    runtimeState.running = false;
    runtimeState.failed += 1;
    setStage("selected_task_open_failed");
    log("error", openResult?.message || openResult?.error || "选中任务详情打开失败");
    await closeLighthouseTaskDetail(lighthouseTabId, settings, "选中任务打开失败后关闭详情");
    return { ok: false, result: openResult, state: runtimeState };
  }

  runtimeState.currentTask = openResult.task || { selectedTask };
  setStage("selected_countdown_waiting");
  log("info", openResult.message || "已打开选中任务详情，等待倒计时窗口");
  const selectedForLock = await waitForSelectedCountdownWindow(selectedTask, settings);

  beginXOpenWatch(lighthouseTabId, "selected_once");
  const lockResult = await sendToTab(lighthouseTabId, {
    type: "WAIT_SELECTED_COUNTDOWN_AND_LOCK",
    runId: runtimeState.runId,
    settings,
    selectedTask: selectedForLock
  });

  if (!lockResult || !lockResult.ok) {
    clearXOpenWatch();
    runtimeState.running = false;
    runtimeState.failed += 1;
    setStage("selected_lock_failed");
    log("warn", lockResult?.message || lockResult?.error || "10 秒内锁定按钮未可点击，关闭详情并结束本次选中启动");
    await closeLighthouseTaskDetail(lighthouseTabId, settings, "选中任务锁定失败后关闭详情");
    return { ok: false, result: lockResult, state: runtimeState };
  }

  runtimeState.currentTask = {
    ...(runtimeState.currentTask || {}),
    ...(lockResult.task || {})
  };
  markAttemptedTask(runtimeState.currentTask);
  log("info", lockResult.message || "已点击锁定，等待平台自动打开 X");

  const adopted = await waitForLighthouseOpenedTweet(runtimeState.currentTask, lighthouseTabId, "selected_once", {
    timeoutMs: 30000,
    logEveryMs: 3000,
    waitLogMessage: "锁定席位已点击成功，继续等待平台自动打开 X 推文标签页",
    manualOpenAfterMs: 5000
  });
  if (!adopted || !runtimeState.xTabId) {
    runtimeState.running = false;
    runtimeState.failed += 1;
    setStage("selected_x_open_failed");
    const message = runtimeState.lastLockFailureReason || "已点击锁定，但 30 秒内未检测到平台自动打开的 X 推文页";
    log("error", message);
    await closeLighthouseTaskDetail(lighthouseTabId, settings, "X 未打开后关闭任务详情");
    return { ok: false, error: message, state: runtimeState };
  }

  setStage("tweet_opened");
  log("info", "已接管平台自动打开的 X 推文页，继续旧流程第 4 步回复");
  await waitForXReadyBeforeReply(runtimeState.xTabId, settings);
  const replyResult = await sendToTab(runtimeState.xTabId, {
    type: "RUN_X_REPLY",
    runId: runtimeState.runId,
    task: runtimeState.currentTask,
    settings
  });

  if (!replyResult || !replyResult.ok) {
    runtimeState.running = false;
    runtimeState.failed += 1;
    setStage("selected_reply_failed");
    log("error", replyResult?.message || replyResult?.error || "选中任务 X 回复失败");
    log("info", "已保留当前 X 页面，方便检查任务状态");
    return { ok: false, result: replyResult, state: runtimeState };
  }

  runtimeState.lastXResult = replyResult;
  await recordReplyHistory(replyResult);
  const completionResult = await completeXTaskWidgetLifecycle(runtimeState.xTabId, runtimeState.runId, settings);
  if (!completionResult?.ok) {
    runtimeState.failed += 1;
    log("warn", completionResult?.message || completionResult?.error || "X 任务闭环未确认，保留当前页面");
    runtimeState.running = false;
    setStage("selected_completion_failed");
    return { ok: false, result: { openResult, lockResult, replyResult, completionResult }, state: runtimeState };
  }

  const campaignsResult = await waitForLighthouseTaskCompletionAndReturn(runtimeState.runId, settings);
  if (!campaignsResult?.ok) {
    runtimeState.failed += 1;
    runtimeState.running = false;
    setStage("selected_completion_failed");
    log("warn", campaignsResult?.message || "Lighthouse 未确认任务完成，保留 X 页面");
    return { ok: false, result: { openResult, lockResult, replyResult, completionResult, campaignsResult }, state: runtimeState };
  }
  runtimeState.completed += 1;

  await closeLighthouseDetailToCampaigns(lighthouseTabId, settings, "选中启动完成后关闭任务详情回到广场");
  runtimeState.running = false;
  setStage("selected_flow_done");
  log("info", "选中启动流程已结束，已回到任务广场");
  return { ok: true, result: { openResult, lockResult, replyResult, completionResult, campaignsResult }, state: runtimeState };
}

async function waitForSelectedCountdownWindow(selectedTask, settings) {
  const remainingMs = Math.max(0, Math.ceil(Number(selectedTask?.countdownSec || 0)) * 1000);
  const waitBeforeWindowMs = Math.max(0, remainingMs - 5000);
  if (waitBeforeWindowMs <= 0) {
    return { ...(selectedTask || {}), countdownSec: Math.min(5, Math.ceil(remainingMs / 1000)) };
  }

  const started = Date.now();
  let lastLogAt = 0;
  while (Date.now() - started < waitBeforeWindowMs) {
    if (!runtimeState.running || runtimeState.mode !== "selected_once") {
      throw new Error("选中启动已停止");
    }
    const leftMs = waitBeforeWindowMs - (Date.now() - started);
    if (Date.now() - lastLogAt > 5000) {
      lastLogAt = Date.now();
      log("info", `选中任务倒计时等待中，约 ${formatDuration(leftMs + 5000)} 后进入锁定窗口`);
    }
    await delay(Math.min(1000, Math.max(250, leftMs)));
  }
  await delay(randomBetween(0, Math.min(500, Math.max(0, settings.cooldownPollMs || 500))));
  return { ...(selectedTask || {}), countdownSec: 5 };
}

async function openNextLighthouseTaskTweetTab(settings) {
  setStage("lighthouse_opening_for_fast_flow");
  const tab = await getOrCreateLighthouseTab(LIGHTHOUSE_CAMPAIGNS_URL);
  const lighthouseTabId = tab.id;
  await rememberLighthouseTabById(lighthouseTabId);
  await chrome.tabs.update(lighthouseTabId, { url: LIGHTHOUSE_CAMPAIGNS_URL, active: true });
  await waitForTabComplete(lighthouseTabId);
  await delay(Math.max(settings.actionDelayMs || 500, 1200));
  log("info", "未选择倒计时任务，已回到 Lighthouse 任务广场准备打开评论/点赞互动任务");
  await ensurePermanentIgnoredTaskKeysLoaded();

  let openResult = await sendToTab(lighthouseTabId, {
    type: "DEBUG_OPEN_FIRST_COMMENT_TASK",
    runId: runtimeState.runId,
    settings,
    attemptedTaskKeys: getActiveAttemptedTaskKeys()
  });
  if (openResult?.refreshRequested) {
    const refreshState = await refreshLighthouseCampaignsTab(lighthouseTabId, openResult.message || "任务广场陈旧可做列表刷新后重试快抢入口");
    if (refreshState.ok) {
      openResult = await sendToTab(lighthouseTabId, {
        type: "DEBUG_OPEN_FIRST_COMMENT_TASK",
        runId: runtimeState.runId,
        settings,
        attemptedTaskKeys: getActiveAttemptedTaskKeys()
      });
    } else if (refreshState.skippedCooldown) {
      throw new Error(refreshState.message || "任务广场刷新冷却中，请稍后再试");
    }
  }
  if (!openResult || !openResult.ok) {
    if (openResult?.permanentIgnore) {
      await markPermanentIgnoredTask(openResult.task || {}, openResult.ignoredTaskType || openResult.task?.taskType || "非评论");
      await closeLighthouseTaskDetail(lighthouseTabId, settings, "永久忽略非评论任务后关闭详情");
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
    runId: runtimeState.runId,
    settings
  });
  if (!targetResult || !targetResult.ok) {
    clearXOpenWatch();
    throw new Error(targetResult?.message || targetResult?.error || "已打开任务详情，但未能点击在 X 打开/前往目标");
  }

  runtimeState.currentTask = mergeTaskPreservingCapturedTweetUrl(runtimeState.currentTask, targetResult.task);
  markAttemptedTask(runtimeState.currentTask);

  const tweetTabId = await ensureTweetTabAfterTargetClick(lighthouseTabId, settings, runtimeState.currentTask, "debug");
  if (tweetTabId) return tweetTabId;
  throw new Error("已点击在 X 打开/前往目标，但多次复核仍未检测到 Lighthouse 打开的 X 推文页");
}

async function openSelectedTaskTweetTab(selectedTask, settings) {
  if (isIgnoredNonCommentTask(selectedTask)) {
    throw new Error("已忽略原创/转发任务，不打开详情");
  }
  setStage("selected_task_opening");
  const lighthouseTabId = await resolveLighthouseTab();
  await rememberLighthouseTabById(lighthouseTabId);
  await chrome.tabs.update(lighthouseTabId, { active: true });
  await waitForTabComplete(lighthouseTabId);
  log("info", `已选择倒计时任务，打开详情提取推文链接：${selectedTask.bounty || "?"}LUX · ${selectedTask.title || selectedTask.taskType || "任务"}`);
  beginXOpenWatch(lighthouseTabId, "debug");

  const result = await sendToTab(lighthouseTabId, {
    type: "OPEN_SELECTED_COUNTDOWN_TASK_TWEET",
    runId: runtimeState.runId,
    settings,
    selectedTask
  });
  if (!result || !result.ok) {
    clearXOpenWatch();
    throw new Error(result?.message || result?.error || "选中任务详情未找到可点击的在 X 打开/前往目标控件");
  }

  runtimeState.currentTask = mergeTaskPreservingCapturedTweetUrl(runtimeState.currentTask, result.task);
  const tweetTabId = await ensureTweetTabAfterTargetClick(lighthouseTabId, settings, result.task, "debug");
  if (tweetTabId) return tweetTabId;
  throw new Error("已点击在 X 打开控件，但多次复核仍未检测到 Lighthouse 打开的 X 推文页");
}

async function ensureTweetTabAfterTargetClick(lighthouseTabId, settings, task, mode) {
  runtimeState.currentTask = mergeTaskPreservingCapturedTweetUrl(runtimeState.currentTask, task);
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const directTabId = await openDirectTweetTabIfAvailable(runtimeState.currentTask, lighthouseTabId);
    if (directTabId) return directTabId;

    const adopted = await waitForLighthouseOpenedTweet(runtimeState.currentTask, lighthouseTabId, mode, {
      timeoutMs: attempt === maxAttempts ? 10000 : 5000,
      logEveryMs: 2500
    });
    if (adopted && runtimeState.xTabId) {
      log("info", `已接管 Lighthouse 打开的 X 推文：${runtimeState.currentTask?.tweetUrl || ""}`);
      return runtimeState.xTabId;
    }

    clearXOpenWatch();
    if (attempt >= maxAttempts) break;

    log("warn", `X 推文标签未出现，第 ${attempt + 1}/${maxAttempts} 次重新点击在 X 打开/前往目标`);
    await chrome.tabs.update(lighthouseTabId, { active: true });
    await waitForTabComplete(lighthouseTabId);
    await delay(Math.max(settings.actionDelayMs || 500, 800));
    beginXOpenWatch(lighthouseTabId, mode);
    const retryResult = await sendToTab(lighthouseTabId, {
      type: "OPEN_CURRENT_DETAIL_TWEET_TARGET",
      runId: runtimeState.runId,
      settings
    });
    if (!retryResult || !retryResult.ok) {
      throw new Error(retryResult?.message || retryResult?.error || "重新点击在 X 打开/前往目标失败");
    }
    runtimeState.currentTask = mergeTaskPreservingCapturedTweetUrl(runtimeState.currentTask, retryResult.task);
  }
  return null;
}

async function openDirectTweetTabIfAvailable(task, lighthouseTabId, options = {}) {
  const tweetUrl = normalizeTweetUrl(task?.tweetUrl);
  if (!tweetUrl || (task?.awaitingXTabAdoption && !options.allowAwaitingXTabAdoption)) return null;
  const existing = await getBoundMatchingTaskXTab(tweetUrl);
  if (existing) return existing.id;
  if (directTweetOpenPromise) return directTweetOpenPromise;

  const runId = runtimeState.runId;
  const opening = (async () => {
    const rebound = await getBoundMatchingTaskXTab(tweetUrl);
    if (rebound) return rebound.id;
    if (runtimeState.runId !== runId || !runtimeState.running) return null;

    const pending = runtimeState.pendingXOpen;
    if (pending?.lighthouseTabId === lighthouseTabId) {
      const siteCandidate = consumeXOpenCandidate(lighthouseTabId, tweetUrl)
        || await findRecentTweetTab(
          pending.startedAt || Date.now(),
          lighthouseTabId,
          pending.windowId,
          tweetUrl
        );
      if (siteCandidate) {
        adoptCurrentXTab(siteCandidate, task, "site");
        return siteCandidate.id;
      }
    }

    clearXOpenWatch();
    const createProperties = { url: tweetUrl, active: true, openerTabId: lighthouseTabId };
    const targetWindowId = getRuntimeWindowId();
    if (Number.isInteger(targetWindowId)) createProperties.windowId = targetWindowId;
    const tweetTab = await chrome.tabs.create(createProperties);
    await focusTaskXTab(tweetTab.id, tweetTab.windowId);
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
  const tabId = await resolveLighthouseTab();
  if (!runtimeState.xTabId) {
    const activeTweetTab = await getActiveTweetTab({ windowId: getRuntimeWindowId() });
    if (activeTweetTab) {
      runtimeState.xTabId = activeTweetTab.id;
      runtimeState.xTabWindowId = activeTweetTab.windowId;
    }
  }

  if (runtimeState.xTabId) {
    const closed = await closeRecordedXTab("调试流程：已关闭 X 标签页");
    if (!closed) return failStep(null, "关闭 X 标签页失败，停止后续流程");
  }

  await chrome.tabs.update(tabId, { active: true });
  setStage("returned_lighthouse");
  log("info", "已关闭 X 并回到 Lighthouse");
  return { ok: true, state: runtimeState };
}

async function debugCompleteXTaskWidget() {
  const tabId = runtimeState.xTabId || (await resolveCurrentXTab({ allowActiveTweetTab: true }));
  const settings = await getSettings();
  const result = await completeXTaskWidgetLifecycle(tabId, runtimeState.runId, settings);
  if (!result?.ok) {
    setStage("x_task_completion_failed");
    log("warn", result?.message || "X 任务提交未确认，保留当前页面");
    return { ok: false, result, state: runtimeState };
  }
  setStage("x_task_completed");
  return { ok: true, result, state: runtimeState };
}

async function debugWaitLighthouseCompletionReturn() {
  const settings = await getSettings();
  const result = await waitForLighthouseTaskCompletionAndReturn(runtimeState.runId, settings);
  if (!result?.ok) {
    setStage("lighthouse_completion_failed");
    log("warn", result?.message || "Lighthouse 未确认任务完成，保留 X 页面");
    return { ok: false, result, state: runtimeState };
  }
  setStage("campaigns_returned");
  return { ok: true, result, state: runtimeState };
}

async function debugClickDone() {
  const tabId = await resolveLighthouseTab();
  const settings = await getSettings();
  await chrome.tabs.update(tabId, { active: true });
  const result = await sendToTab(tabId, { type: "DEBUG_CLICK_I_DONE", runId: runtimeState.runId, settings });
  if (!result || !result.ok) return failStep(result, "点击我已完成失败");
  runtimeState.completed += 1;
  setStage("done_clicked");
  log("info", result.message || "已点击我已完成");
  return { ok: true, result, state: runtimeState };
}

async function debugReturnCampaigns() {
  const tabId = await resolveLighthouseTab();
  const settings = await getSettings();
  await closeLighthouseDetailToCampaigns(tabId, settings, "调试流程：关闭任务详情回到广场");
  setStage("campaigns_returned");
  log("info", "已回到任务广场");
  return { ok: true, state: runtimeState };
}

async function adoptTargetOpenedTweet(task, lighthouseTabId, mode) {
  if (!runtimeState.running) return { ok: false, error: "Run is not active", state: runtimeState };
  const runId = runtimeState.runId;
  runtimeState.currentTask = mergeTaskPreservingCapturedTweetUrl(runtimeState.currentTask, task);
  runtimeState.mode = mode || runtimeState.mode;
  if (lighthouseTabId) await rememberLighthouseTabById(lighthouseTabId);
  const settings = await getSettings();
  // Lighthouse commonly opens the target tweet asynchronously after a seat is
  // locked. Waiting for that tab first avoids opening the same tweet twice.
  let adopted = await waitForLighthouseOpenedTweet(runtimeState.currentTask, runtimeState.lighthouseTabId, runtimeState.mode, {
    timeoutMs: 30000,
    logEveryMs: 3000,
    waitLogMessage: "锁定席位已点击成功，继续等待平台自动打开 X 推文标签页",
    manualOpenAfterMs: SITE_X_OPEN_WAIT_MS
  });
  if (!adopted) {
    const directTweetTabId = await openDirectTweetTabIfAvailable(
      runtimeState.currentTask,
      runtimeState.lighthouseTabId
    );
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
    if (runtimeState.mode === "auto") {
      runtimeState.failed += 1;
      clearXOpenWatch();
      setStage("locked_task_target_unavailable");
      log("error", `${message}；已保留平台进行中订单，停止扫描新任务以避免订单串单`);
      runtimeState.running = false;
      return { ok: false, error: message, state: runtimeState };
    }
    return failStep({ task: runtimeState.currentTask }, message);
  }

  setStage("tweet_opened");
  log("info", runtimeState.currentTask?.xOpenSource === "extension_fallback"
    ? "官网未在 5 秒内打开 X，已使用任务直链兜底打开目标推文页"
    : "已检测到 Lighthouse 官网打开的目标 X 推文页");
  if (runtimeState.mode !== "auto") return { ok: true, state: runtimeState };

  runtimeState.incomeAtTaskStart = await readPlazaTodayIncome(runtimeState.lighthouseTabId, runId);
  await waitForXReadyBeforeReply(runtimeState.xTabId, settings);
  const replyResult = await sendToTab(runtimeState.xTabId, {
    type: "RUN_X_REPLY",
    runId,
    task: runtimeState.currentTask,
    settings
  });
  if (!replyResult || !replyResult.ok) {
    return recoverAndContinue(replyResult?.message || replyResult?.error || "接管当前 X 标签页后回复失败，退回任务广场继续下一单", {
      runId,
      task: runtimeState.currentTask,
      closeX: false
    });
  }
  return handleXReplyResult(replyResult, { runId });
}

async function waitForXReadyBeforeReply(tabId, settings) {
  setStage("waiting_x_ready");
  await focusTaskXTab(tabId);
  log("info", "X 推文页已打开并切到前台，等待页面加载和前端水合后再回复");
  await waitForTabComplete(tabId);
  await delay(Math.max(settings.actionDelayMs * 2, 2500));
}

async function focusTaskXTab(tabId, knownWindowId = null) {
  if (!Number.isInteger(tabId)) throw new Error("缺少当前 X 标签页，无法切到前台");
  const tab = await chrome.tabs.update(tabId, { active: true });
  const windowId = Number.isInteger(knownWindowId) ? knownWindowId : tab.windowId;
  if (Number.isInteger(windowId)) await chrome.windows.update(windowId, { focused: true });
  runtimeState.xTabId = tab.id;
  runtimeState.xTabWindowId = tab.windowId;
  return tab;
}

async function completeXTaskWidgetLifecycle(tabId, runId, settings) {
  if (!tabId) return { ok: false, message: "未记录当前 X 标签页，无法提交任务" };
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
  if (runId !== runtimeState.runId || !runtimeState.running) return { ok: false, cancelled: true };

  if (outcome.source === "lighthouse") {
    // The platform's own verified-and-paid result is stronger evidence than a
    // still-pending X companion widget. Stop that stale wait and finish here.
    await sendToTab(tabId, { type: "CANCEL_X_RUN", runId });
    setStage("lighthouse_official_completion_detected");
    log("info", "Lighthouse 已显示验证通过/奖励到账，不再等待 X 控件，准备返回任务广场");
    return {
      ok: true,
      officialCompletion: true,
      message: "Lighthouse 已验证通过并奖励到账"
    };
  }

  const result = outcome.result;
  if (!result?.ok) {
    const official = await sendToTab(runtimeState.lighthouseTabId, { type: "CHECK_LIGHTHOUSE_OFFICIAL_COMPLETION", runId });
    if (official?.completed && latchLighthouseCompletion(official.evidence, runId)) {
      return { ok: true, officialCompletion: true, message: "X 控件不可读，但本单官网已确认完成" };
    }
  }
  if (result?.ok) {
    setStage("x_task_submitted");
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

async function waitForLighthouseTaskCompletionAndReturn(runId, settings) {
  if (runId !== runtimeState.runId || !runtimeState.running) return { ok: false, cancelled: true };
  const tabId = (await getOrCreateLighthouseTab(LIGHTHOUSE_CAMPAIGNS_URL)).id;
  await rememberLighthouseTabById(tabId);
  if (hasLatchedLighthouseCompletion(runId)) {
    const closed = await closeLighthouseDetailToCampaigns(tabId, settings, "本单官方完成证据已保存，返回广场");
    return { ok: Boolean(closed), evidence: runtimeState.completionEvidence, message: closed ? "本单已确认完成并返回广场" : "本单已完成，但回广场尚未确认" };
  }
  setStage("lighthouse_completion_waiting");
  log("info", "已提交 X 任务，等待 Lighthouse 弹出已完成并返回任务广场");
  const result = await sendToTab(tabId, {
    type: "WAIT_LIGHTHOUSE_COMPLETION_RETURN",
    runId,
    settings
  });
  const evidenceLatched = Boolean(result?.evidence && latchLighthouseCompletion(result.evidence, runId));
  if (result?.ok) {
    setStage("campaigns_returned");
    log("info", result.message || "已从 Lighthouse 完成页返回任务广场");
    return result;
  }
  if ((result?.completed || evidenceLatched) && hasLatchedLighthouseCompletion(runId)) {
    log("warn", result?.message || "官网已确认本单完成，但任务广场尚未恢复，正在强制回到任务广场");
    const returned = await closeLighthouseDetailToCampaigns(tabId, settings, "官网完成证据已保存，强制回到任务广场");
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
    const incomeResult = await verifyCompletionByPlazaIncome(tabId, runId, settings);
    if (incomeResult) return incomeResult;
  }
  return result;
}

// The completion overlay occasionally never renders even though the task was
// paid. Before stopping the whole run on that timeout, compare the plaza's
// own paid-income header against the baseline captured at task start.
async function verifyCompletionByPlazaIncome(tabId, runId, settings) {
  const bounty = Number(runtimeState.currentTask?.bounty || 0);
  const baseline = Number(runtimeState.incomeAtTaskStart);
  if (runId !== runtimeState.runId || !runtimeState.running) return null;
  if (!(bounty > 0) || !Number.isFinite(baseline)) return null;
  await closeLighthouseDetailToCampaigns(tabId, settings, "完成弹窗未出现，先回广场核账");
  const incomeNow = await readPlazaTodayIncome(tabId, runId);
  if (!Number.isFinite(incomeNow) || incomeNow + 1e-9 - baseline < bounty) {
    log("warn", `完成弹窗未出现，且今日收入未见本单赏金（开始 ${baseline}，当前 ${Number.isFinite(incomeNow) ? incomeNow : "不可读"}），仍按未完成处理`);
    return null;
  }
  latchIncomeVerifiedCompletion(runId);
  const returned = await closeLighthouseDetailToCampaigns(tabId, settings, "收入核验通过，返回广场");
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
  runtimeState.completionEvidence = {
    runId,
    taskKey: runtimeState.currentTask.taskKey,
    tweetUrl: normalizeTweetUrl(runtimeState.currentTask.tweetUrl || ""),
    observedAt: new Date().toISOString(),
    text: "任务广场今日收入核验通过",
    incomeVerified: true
  };
  touchAutoRunState();
  return true;
}

function latchLighthouseCompletion(evidence, runId) {
  if (!evidence || runId !== runtimeState.runId || !runtimeState.running
      || evidence.runId !== runId || !evidence.taskKey
      || evidence.taskKey !== runtimeState.currentTask?.taskKey) return false;
  const expectedUrl = normalizeTweetUrl(runtimeState.currentTask?.tweetUrl || "");
  if (evidence.tweetUrl && expectedUrl && normalizeTweetUrl(evidence.tweetUrl) !== expectedUrl) return false;
  runtimeState.completionEvidence = { ...evidence };
  return true;
}

function hasLatchedLighthouseCompletion(runId) {
  const evidence = runtimeState.completionEvidence;
  return Boolean(evidence && evidence.runId === runId && evidence.taskKey === runtimeState.currentTask?.taskKey);
}

async function handleXReplyResult(result, message = {}) {
  if (!isCurrentRunMessage(message)) return { ok: true, state: runtimeState };
  if (!runtimeState.running) return { ok: false, error: "Run is not active" };
  const runId = runtimeState.runId;
  runtimeState.lastXResult = result || null;
  log(result && result.ok ? "info" : "error", result && result.message ? result.message : "X 回复步骤结束");
  if (result?.ok) await recordReplyHistory(result);

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

  const settings = await getSettings();
  const completionResult = await completeXTaskWidgetLifecycle(runtimeState.xTabId, runId, settings);
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

async function handleLighthouseDone(result) {
  const runId = runtimeState.runId;
  if (runtimeState.mode === "auto" && result?.ok && !hasLatchedLighthouseCompletion(runId)) {
    return recoverAndContinue("缺少本单官方完成证据，不计为完成", { runId, task: runtimeState.currentTask, closeX: false });
  }
  if (runtimeState.currentTask?.completionCounted) return { ok: true, duplicate: true };
  if (result && result.ok) {
    if (runtimeState.currentTask) runtimeState.currentTask.completionCounted = true;
    runtimeState.completed += 1;
    // Completed cards are excluded by their own 已完成 state; leaving them in
    // the dedupe table is what made every visible task look "stale" and sent
    // the runner into the reload/cooldown spin right after a finished batch.
    releaseAttemptedTask(runtimeState.currentTask);
    log("info", result.message || "Lighthouse 任务已完成");
  } else {
    runtimeState.failed += 1;
    log("error", result && result.message ? result.message : "Lighthouse 完成步骤失败");
  }

  const settings = await getSettings();
  if (!result?.ok && !settings.autoSubmitLighthouse) {
    runtimeState.running = false;
    setStage("finished");
    log("warn", "自动提交已关闭，正式模式停止，避免回复后任务未提交仍继续下一张");
    return { ok: true, state: runtimeState };
  }
  const canContinue = runtimeState.mode === "auto" && runtimeState.running && !isLimitReached(runtimeState.completed, settings.maxTasksPerRun);
  if (!canContinue) {
    runtimeState.running = false;
    setStage("finished");
    log("info", "运行结束");
    return { ok: true, state: runtimeState };
  }

  await closeLighthouseDetailToCampaigns(runtimeState.lighthouseTabId, settings, "正式模式完成后关闭任务详情回到广场");
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
  if (!isActiveAutoRun(runId)) return { ok: true, state: runtimeState };

  runtimeState.failed += 1;
  if (options.task) markAttemptedTask(options.task);

  const hasExplicitSeatLockState = Object.prototype.hasOwnProperty.call(options.task || {}, "seatLocked");
  const lockedTask = hasExplicitSeatLockState
    ? options.task.seatLocked === true
    : runtimeState.currentTask?.seatLocked === true;
  if (lockedTask) {
    runtimeState.currentTask = {
      ...(runtimeState.currentTask || {}),
      ...(options.task || {})
    };
    clearXOpenWatch();
    setStage("locked_task_recovery_blocked");
    log("error", `${message || "已锁定订单后续步骤异常"}；平台订单仍可能有效，已停止扫描新任务以避免串单`);
    runtimeState.running = false;
    return { ok: false, error: message || "已锁定订单后续步骤异常", state: runtimeState };
  }

  setStage("recovering");
  log("warn", message || "当前任务异常，退回任务广场继续下一单");
  const settings = await getSettings();

  if (options.closeX !== false) {
    await closeRecordedXTab("异常恢复：已关闭本次 X 标签页");
  }

  try {
    const tab = await getOrCreateLighthouseTab(LIGHTHOUSE_CAMPAIGNS_URL);
    rememberLighthouseTab(tab);
    await closeLighthouseTaskDetail(tab.id, settings, "异常恢复时关闭任务详情");
  } catch (error) {
    log("warn", `关闭任务详情失败，稍后重试：${error.message}`);
  }

  await delay(Math.max(settings.actionDelayMs * 2, 2000));
  if (!isActiveAutoRun(runId)) return { ok: true, state: runtimeState };
  return startNextAutoTask("recover_after_failure");
}

async function closeRecordedXTab(message) {
  if (!runtimeState.xTabId) return false;
  const xTabId = runtimeState.xTabId;
  const expectedWindowId = runtimeState.xTabWindowId;
  runtimeState.xTabId = null;
  runtimeState.xTabWindowId = null;

  try {
    const tab = await chrome.tabs.get(xTabId);
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
    const closed = await waitForTabClosed(xTabId, 5000);
    if (!closed) {
      throw new Error("关闭后仍能检测到 X 标签页");
    }
    log("info", message || "已关闭本次 X 标签页");
    return true;
  } catch (error) {
    log("warn", `关闭 X 标签页失败：${error.message}`);
    return false;
  }
}

async function getOrCreateLighthouseTab(url) {
  const safeUrl = isLighthouseUrl(url) ? url : LIGHTHOUSE_CAMPAIGNS_URL;
  if (Number.isInteger(runtimeState.lighthouseTabId)) {
    try {
      const remembered = await chrome.tabs.get(runtimeState.lighthouseTabId);
      if (isLighthouseUrl(remembered.url)) return remembered;
      log("warn", `丢弃非灯塔的残留任务标签：tab=${remembered.id} · ${remembered.url || "about:blank"}`);
    } catch (_) {
      // The remembered tab can disappear while the service worker is asleep.
    }
    runtimeState.lighthouseTabId = null;
  }
  const activeTab = await getActiveLighthouseTab();
  if (activeTab) {
    rememberLighthouseTab(activeTab);
    return activeTab;
  }
  const tabs = await queryLighthouseTabsInRuntimeWindow();
  const campaignsTab = tabs.find((tab) => tab.url && tab.url.includes("/campaigns"));
  if (campaignsTab) {
    rememberLighthouseTab(campaignsTab);
    return campaignsTab;
  }
  const createProperties = { url: safeUrl, active: true };
  const targetWindowId = getRuntimeWindowId();
  if (Number.isInteger(targetWindowId)) createProperties.windowId = targetWindowId;
  const created = await chrome.tabs.create(createProperties);
  rememberLighthouseTab(created);
  return created;
}

async function focusLighthouseTabForAutoScan(tabId) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await chrome.tabs.update(tabId, { active: true });
      return true;
    } catch (error) {
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

async function getActiveLighthouseTab() {
  const query = { active: true };
  const targetWindowId = getRuntimeWindowId();
  if (Number.isInteger(targetWindowId)) {
    query.windowId = targetWindowId;
  } else {
    query.currentWindow = true;
  }
  const tabs = await chrome.tabs.query(query);
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

async function refreshLighthouseCampaignsTab(tabId, reason = "") {
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
    await waitForTabComplete(tabId);
    log("info", reason || "准备刷新 Lighthouse 任务广场");
    await chrome.tabs.reload(tabId);
    await waitForTabComplete(tabId);
    lastCampaignsRefreshAt = Date.now();
    return { ok: true, skippedCooldown: false, message: "" };
  } catch (error) {
    log("warn", `刷新任务广场失败：${error.message}`);
    return { ok: false, skippedCooldown: false, message: error.message || "刷新任务广场失败" };
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

async function closeLighthouseDetailToCampaigns(tabId, settings, reason) {
  if (!tabId) return false;
  const closed = await closeLighthouseTaskDetail(tabId, settings, reason);
  if (closed) return true;
  log("warn", "页面内回广场未确认，本次不刷新页面，交给后续任务选择复核当前状态");
  return false;
}

async function closeLighthouseTaskDetail(tabId, settings, reason) {
  if (!tabId) return false;
  try {
    await chrome.tabs.update(tabId, { active: true });
    await waitForTabComplete(tabId);
    const result = await sendToTab(tabId, {
      type: "CLOSE_LIGHTHOUSE_TASK_DETAIL",
      runId: runtimeState.runId,
      settings
    });
    if (result && result.ok) {
      log("info", result.message || reason || "已关闭任务详情");
      return true;
    }
    log("warn", result?.message || "任务详情关闭未确认");
    // A stuck Lighthouse drawer can remain in the DOM after every close
    // gesture. Reloading the campaigns tab is the reliable recovery path.
    await chrome.tabs.reload(tabId);
    await waitForTabComplete(tabId);
    log("info", "任务详情关闭未确认，已刷新任务广场并继续下一条");
    return true;
  } catch (error) {
    log("warn", `页面内关闭任务详情失败：${error.message}`);
    return false;
  }
}

async function getSettings() {
  const stored = await chrome.storage.local.get(["settings"]);
  const migrated = migrateSettings(stored.settings || {});
  const normalized = normalizeSettings(migrated.settings);
  if (migrated.changed || !stored.settings) {
    await chrome.storage.local.set({ settings: normalized });
  }
  return normalized;
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
    aiProvider: "gpt-5.6-terra",
    aiModel: String(merged.aiModel || "gpt-5.6-terra").trim().slice(0, 128) || "gpt-5.6-terra",
    aiApiUrl: String(merged.aiApiUrl || "").trim(),
    aiApiKey: String(merged.aiApiKey || "").trim(),
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

async function sendToTab(tabId, payload) {
  payload = { ...payload, platform: "lighthouse", task: payload.task || runtimeState.currentTask };
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    if (payload.runId && !payload.type.startsWith("CANCEL_") &&
        (payload.runId !== runtimeState.runId || !runtimeState.running)) {
      return { ok: false, cancelled: true, message: "流程已停止，不再重试旧消息" };
    }
    try {
      await ensureLighthouseAlertBridge(tabId);
      return await chrome.tabs.sendMessage(tabId, payload);
    } catch (error) {
      if (isReceivingEndMissingError(error)) {
        const injected = await ensureContentScriptInjected(tabId);
        if (injected) {
          await delay(300);
          continue;
        }
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

async function cancelCurrentRun() {
  runtimeState.running = false;
  for (const controller of activeAIRequests) controller.abort(new Error("任务已停止"));
  const runId = runtimeState.runId;
  clearXOpenWatch();
  if (runtimeState.lighthouseTabId) {
    try {
      await sendToTab(runtimeState.lighthouseTabId, {
        type: "CANCEL_LIGHTHOUSE_RUN",
        runId
      });
    } catch (error) {
      log("warn", `通知 Lighthouse 停止旧流程失败：${error.message}`);
    }
  }
  if (runtimeState.xTabId) {
    try {
      await sendToTab(runtimeState.xTabId, {
        type: "CANCEL_X_RUN",
        runId
      });
    } catch (error) {
      log("warn", `通知 X 停止旧流程失败：${error.message}`);
    }
  }
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
  return !message?.runId || !runtimeState.runId || message.runId === runtimeState.runId;
}

async function ensureContentScriptInjected(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const file = getContentScriptFileForUrl(tab.url);
    if (!file) return false;
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [file]
    });
    log("warn", `已为当前标签页补注入脚本：${file}`);
    return true;
  } catch (error) {
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
async function ensureLighthouseAlertBridge(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isLighthouseUrl(tab.url)) return false;
    if (lighthouseAlertBridgeUrls.get(tabId) === tab.url) return true;
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const bridgeKey = "__lighthouseUnverifiedLinkAlertBridge__";
        if (window[bridgeKey]) return;
        window[bridgeKey] = true;
        const nativeAlert = window.alert.bind(window);
        window.alert = (message) => {
          const text = String(message || "");
          if (/此推文含有未经验证的链接[\s\S]*KOL\s*接单时仔细分辨/.test(text)) {
            window.dispatchEvent(new CustomEvent("lighthouse-unverified-link-alert-dismissed"));
            return;
          }
          return nativeAlert(message);
        };
      }
    });
    lighthouseAlertBridgeUrls.set(tabId, tab.url);
    return true;
  } catch (error) {
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

async function resolveLighthouseTab() {
  if (runtimeState.lighthouseTabId) {
    try {
      const recorded = await chrome.tabs.get(runtimeState.lighthouseTabId);
      if (isLighthouseUrl(recorded.url)) {
        rememberLighthouseTab(recorded);
        return recorded.id;
      }
    } catch (error) {
      log("warn", `已记录 Lighthouse 标签页不可用：${error.message}`);
    }
    runtimeState.lighthouseTabId = null;
    runtimeState.lighthouseWindowId = null;
  }

  const activeTab = await getActiveLighthouseTab();
  if (activeTab) {
    rememberLighthouseTab(activeTab);
    log("info", "已接管当前 Lighthouse 标签页");
    return activeTab.id;
  }

  const tabs = await queryLighthouseTabsInRuntimeWindow();
  const lighthouseTab = tabs.find((tab) => isLighthouseUrl(tab.url));
  if (lighthouseTab) {
    rememberLighthouseTab(lighthouseTab);
    await chrome.tabs.update(lighthouseTab.id, { active: true });
    log("info", "已接管已有 Lighthouse 标签页");
    return lighthouseTab.id;
  }

  throw new Error("缺少 Lighthouse 标签页：当前窗口没有 app.lhdao.top 页面");
}

async function resolveCurrentXTab(options = {}) {
  if (runtimeState.xTabId) {
    try {
      const tab = await chrome.tabs.get(runtimeState.xTabId);
      if (isTweetTab(tab) && isTabInRuntimeWindow(tab)) {
        runtimeState.xTabWindowId = tab.windowId;
        return runtimeState.xTabId;
      }
    } catch (error) {
      log("warn", `Recorded X tab is unavailable: ${error.message}`);
    }
    runtimeState.xTabId = null;
    runtimeState.xTabWindowId = null;
  }
  if (options.allowActiveTweetTab) {
    const activeTab = await getActiveTweetTab({ windowId: getRuntimeWindowId() });
    if (activeTab) {
      const taskTweetUrl = normalizeTweetUrl(runtimeState.currentTask?.tweetUrl || "");
      const activeTweetUrl = normalizeTweetUrl(activeTab.url || "");
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
  const runId = runtimeState.runId;
  await sendToTab(lighthouseTabId, { type: "BEGIN_LIGHTHOUSE_COMPLETION_WATCH", runId, task });
  const startedAt = Date.now();
  const lighthouseWindowId = await getLighthouseWindowId(lighthouseTabId);
  const expectedTweetUrl = normalizeTweetUrl(task?.tweetUrl || runtimeState.currentTask?.tweetUrl || "");
  const timeoutMs = Number(options.timeoutMs || 30000);
  const logEveryMs = Number(options.logEveryMs || 3000);
  const manualOpenAfterMs = Math.max(0, Number(options.manualOpenAfterMs || 0));
  const waitLogMessage = options.waitLogMessage || "已点击在 X 打开/前往目标，继续等待新 X 推文标签页出现";
  let lastLogAt = 0;
  let fallbackOpened = false;
  let detailFallbackClicked = false;
  while (Date.now() - startedAt < timeoutMs) {
    if (!runtimeState.running || runtimeState.runId !== runId) return false;
    const currentExpectedUrl = normalizeTweetUrl(runtimeState.currentTask?.tweetUrl || expectedTweetUrl);
    const boundTab = await getBoundMatchingTaskXTab(currentExpectedUrl);
    if (boundTab) {
      runtimeState.mode = mode || runtimeState.mode;
      if (lighthouseTabId) await rememberLighthouseTabById(lighthouseTabId);
      return true;
    }
    const candidate = consumeXOpenCandidate(lighthouseTabId, currentExpectedUrl)
      || await findRecentTweetTab(startedAt, lighthouseTabId, lighthouseWindowId, currentExpectedUrl);
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
      if (lighthouseTabId) await rememberLighthouseTabById(lighthouseTabId);
      return true;
    }
    const lockFailure = await checkLighthouseLockFailure(lighthouseTabId);
    if (lockFailure) {
      clearXOpenWatch();
      const message = lockFailure.message || lockFailure.reason || "锁定失败：任务不可做";
      runtimeState.lastLockFailureReason = message;
      runtimeState.currentTask = {
        ...(runtimeState.currentTask || {}),
        ...(task || {}),
        ...(lockFailure.task || {}),
        seatLocked: false,
        seatLockedAt: null,
        lockFailed: true
      };
      log("warn", message);
      return false;
    }
    const waitedMs = Date.now() - startedAt;
    if (manualOpenAfterMs > 0 && !fallbackOpened && waitedMs >= manualOpenAfterMs) {
      fallbackOpened = true;
      log("warn", `平台官网 ${Math.ceil(waitedMs / 1000)} 秒未自动打开 X，使用已校验任务直链兜底`);
      const directTabId = await openDirectTweetTabIfAvailable(
        runtimeState.currentTask || task,
        lighthouseTabId,
        { allowAwaitingXTabAdoption: true, source: "extension_fallback" }
      );
      if (directTabId) {
        clearXOpenWatch();
        log("warn", "官网未跳转，插件已兜底打开精确目标 X 推文");
        return true;
      }
      if (!detailFallbackClicked) {
        detailFallbackClicked = true;
        const clickFallback = await clickCurrentDetailTweetTargetFallback(lighthouseTabId, mode);
        if (clickFallback.ok) {
          runtimeState.currentTask = mergeTaskPreservingCapturedTweetUrl(runtimeState.currentTask, clickFallback.task, {
            taskKey: task?.taskKey || runtimeState.currentTask?.taskKey,
            seatLocked: runtimeState.currentTask?.seatLocked === true
          });
          log("warn", "当前详情未暴露直链，已单次点击“去 X 完成动作”并仅等待匹配目标页出现");
          await delay(1000);
          const clickedExpectedUrl = normalizeTweetUrl(runtimeState.currentTask?.tweetUrl || expectedTweetUrl);
          const clickedBoundTab = await getBoundMatchingTaskXTab(clickedExpectedUrl);
          if (clickedBoundTab) return true;
          const clickedCandidate = consumeXOpenCandidate(lighthouseTabId, clickedExpectedUrl)
            || await findRecentTweetTab(Date.now() - 1500, lighthouseTabId, lighthouseWindowId, clickedExpectedUrl);
          if (clickedCandidate) {
            adoptCurrentXTab(clickedCandidate, runtimeState.currentTask, "site");
            return true;
          }
          const directAfterClick = await openDirectTweetTabIfAvailable(
            runtimeState.currentTask || task,
            lighthouseTabId,
            { allowAwaitingXTabAdoption: true, source: "extension_fallback" }
          );
          if (directAfterClick) {
            clearXOpenWatch();
            log("warn", "单次详情按钮未产生匹配页面，插件已使用新提取的任务直链兜底打开 X");
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
  clearXOpenWatch();
  return false;
}

async function clickCurrentDetailTweetTargetFallback(lighthouseTabId, mode) {
  if (!lighthouseTabId) return { ok: false, message: "缺少 Lighthouse 任务页" };
  try {
    const settings = await getSettings();
    beginXOpenWatch(lighthouseTabId, mode);
    const result = await sendToTab(lighthouseTabId, {
      type: "OPEN_CURRENT_DETAIL_TWEET_TARGET",
      runId: runtimeState.runId,
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
  try {
    const result = await sendToTab(lighthouseTabId, {
      type: "CHECK_LIGHTHOUSE_LOCK_FAILURE",
      runId: runtimeState.runId
    });
    if (result?.ok && result.failed) return result;
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

function recordPotentialLighthouseOpenedXTab(tab) {
  const pending = runtimeState.pendingXOpen;
  if (!pending || !tab || !tab.id) return;
  if (!Number.isInteger(pending.windowId)) return;
  if (Number.isInteger(pending.windowId) && tab.windowId !== pending.windowId) return;
  const openerMatches = tab.openerTabId === pending.lighthouseTabId;
  if (openerMatches && !pending.createdTabIds.includes(tab.id)) {
    pending.createdTabIds.push(tab.id);
  }

  const fromTrackedNewTab = pending.createdTabIds.includes(tab.id);
  if (!fromTrackedNewTab) return;

  const tweetUrl = normalizeTweetUrl(tab.url);
  if (!tweetUrl) return;
  if (!pending.candidates.some((candidate) => candidate.id === tab.id && candidate.url === tab.url)) {
    pending.candidates.push(tab);
  }
}

function consumeXOpenCandidate(lighthouseTabId, expectedTweetUrl = "") {
  const pending = runtimeState.pendingXOpen;
  if (!pending || pending.lighthouseTabId !== lighthouseTabId) return null;
  const expected = normalizeTweetUrl(expectedTweetUrl);
  if (!expected) return null;
  const index = pending.candidates.findIndex((candidate) => normalizeTweetUrl(candidate.url) === expected);
  if (index < 0) return null;
  const [candidate] = pending.candidates.splice(index, 1);
  clearXOpenWatch();
  return candidate;
}

async function recoverPendingXOpenFromCapturedUrl(tweetUrl) {
  const normalizedUrl = normalizeTweetUrl(tweetUrl);
  const pending = runtimeState.pendingXOpen;
  const task = runtimeState.currentTask || {};
  if (!normalizedUrl || !pending) return null;
  if (!runtimeState.running || (task.seatLocked !== true && !task.seatLockedAt)) return null;
  const alreadyBound = await getBoundMatchingTaskXTab(normalizedUrl);
  if (alreadyBound) return alreadyBound.id;
  if (capturedTargetRecoveryPromise) return capturedTargetRecoveryPromise;

  const runId = runtimeState.runId;
  const lighthouseTabId = pending.lighthouseTabId;
  const lighthouseWindowId = pending.windowId;
  const startedAt = pending.startedAt || Date.now();
  const recovery = (async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (!runtimeState.running || runtimeState.runId !== runId) return null;
      const boundTab = await getBoundMatchingTaskXTab(normalizedUrl);
      if (boundTab) return boundTab.id;
      const candidate = consumeXOpenCandidate(lighthouseTabId, normalizedUrl)
        || await findRecentTweetTab(startedAt, lighthouseTabId, lighthouseWindowId, normalizedUrl);
      if (candidate) {
        adoptCurrentXTab(candidate, runtimeState.currentTask, "site");
        log("info", "已根据官网回传的精确地址接管 Lighthouse 打开的 X 标签页");
        return candidate.id;
      }
      await delay(200);
    }

    const directTabId = await openDirectTweetTabIfAvailable(
      mergeTaskPreservingCapturedTweetUrl(runtimeState.currentTask, null, {
        tweetUrl: normalizedUrl,
        awaitingXTabAdoption: false
      }),
      lighthouseTabId,
      { allowAwaitingXTabAdoption: true, source: "extension_fallback" }
    );
    if (directTabId) log("warn", "官网已回传目标地址但未创建可接管标签，插件已只创建一次精确兜底页");
    return directTabId;
  })();
  capturedTargetRecoveryPromise = recovery;
  try {
    return await recovery;
  } finally {
    if (capturedTargetRecoveryPromise === recovery) capturedTargetRecoveryPromise = null;
  }
}

async function findRecentTweetTab(startedAt, lighthouseTabId, windowId, expectedTweetUrl = "") {
  if (!Number.isInteger(windowId)) return null;
  const expected = normalizeTweetUrl(expectedTweetUrl);
  if (!expected) return null;
  const query = { url: ["https://x.com/*", "https://twitter.com/*"] };
  query.windowId = windowId;
  const tabs = await chrome.tabs.query(query);
  const candidates = tabs
    .filter((tab) => tab.id !== lighthouseTabId && isTweetTab(tab))
    .filter((tab) => tab.openerTabId === lighthouseTabId)
    .filter((tab) => !expected || normalizeTweetUrl(tab.url) === expected)
    .filter((tab) => {
      const lastAccessed = Number(tab.lastAccessed || 0);
      if (!lastAccessed) return Date.now() - startedAt < 15000;
      return lastAccessed >= startedAt - 3000;
    })
    .sort((a, b) => Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0));
  return candidates[0] || null;
}

function adoptCurrentXTab(tab, task = null, source = "lighthouse") {
  const tweetUrl = normalizeTweetUrl(tab.url);
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

async function getLighthouseWindowId(lighthouseTabId) {
  if (Number.isInteger(runtimeState.lighthouseWindowId)) return runtimeState.lighthouseWindowId;
  if (!lighthouseTabId) return null;
  try {
    const tab = await chrome.tabs.get(lighthouseTabId);
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

async function rememberLighthouseTabById(tabId) {
  if (!tabId) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (isLighthouseUrl(tab.url)) {
      rememberLighthouseTab(tab);
      return tab;
    }
  } catch (_) {}
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
  return Boolean(tab && tab.id && normalizeTweetUrl(tab.url));
}

function normalizeTweetUrl(url) {
  const value = String(url || "");
  const match = value.match(/https:\/\/(?:x|twitter)\.com\/[A-Za-z0-9_]+\/status\/\d+/i);
  return match ? match[0].replace("twitter.com", "x.com") : "";
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

async function getBoundMatchingTaskXTab(expectedTweetUrl = "") {
  if (!Number.isInteger(runtimeState.xTabId)) return null;
  try {
    const tab = await chrome.tabs.get(runtimeState.xTabId);
    const actualUrl = normalizeTweetUrl(tab?.url);
    const expectedUrl = normalizeTweetUrl(expectedTweetUrl || runtimeState.currentTask?.tweetUrl);
    if (!actualUrl || !isTabInRuntimeWindow(tab) || (expectedUrl && actualUrl !== expectedUrl)) {
      runtimeState.xTabId = null;
      runtimeState.xTabWindowId = null;
      return null;
    }
    runtimeState.xTabWindowId = tab.windowId;
    return tab;
  } catch (_) {
    runtimeState.xTabId = null;
    runtimeState.xTabWindowId = null;
    return null;
  }
}

function releaseAttemptedTask(task) {
  const keys = getTaskDedupeKeys(task);
  if (!keys.length) return;
  const released = new Set(keys);
  runtimeState.attemptedTaskRecords = (runtimeState.attemptedTaskRecords || [])
    .filter((record) => !released.has(record.key));
  runtimeState.attemptedTaskKeys = runtimeState.attemptedTaskRecords.map((record) => record.key);
}

function markAttemptedTask(task) {
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
    log("info", `已登记去重 ${formatDuration(deferMs)}：${describeTaskForLog(task)}`);
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
  await ensurePermanentIgnoredTaskKeysLoaded();
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
  const record = records.find((item) => normalizeTweetUrl(item.tweetUrl || "") === tweetUrl);
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
  log("info", `已记录回复：${record.replyText}`);
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
  const tweetUrl = normalizeTweetUrl(record.tweetUrl || "");
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
  if (explicitTaskType) return explicitTaskType === "原创推文" || explicitTaskType === "转发";

  const text = normalizeInline([task.title, task.candidateTitle, task.text, task.listText, task.detailText].filter(Boolean).join(" "));
  return /原创推文|原创建推文|原创内容|发推|发布推文|创建推文|发一条推文|转发|转推|Repost|Retweet/i.test(text);
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
  runtimeState.stage = stage;
  touchAutoRunState();
  publishLighthouseMonitorSnapshot("stage");
}

function log(level, text, meta = null) {
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
    if (!saved || typeof saved !== "object" || !saved.running || saved.mode !== "auto") return;
    runtimeState = {
      ...createInitialState(),
      ...saved,
      running: false,
      mode: "idle",
      stage: "interrupted_not_resumed",
      logs: Array.isArray(saved.logs) ? saved.logs.slice(0, 120) : [],
      pendingXOpen: null,
      runId: saved.runId || createRunId()
    };
    log("warn", "Chrome 后台恢复了中断的 Lighthouse 状态，等待保活闹钟自动续跑");
    await ensureAutoRunKeepalive();
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

async function handleAutoRunKeepaliveTick() {
  await runtimeStateReady;
  if (runtimeState.running && (runtimeState.mode === "auto" || runtimeState.mode === "selected_once")) {
    // Any extension API call resets the MV3 idle timer; the alarm wake itself
    // already restarted the 30s window, this touch makes it deterministic.
    try { await chrome.runtime.getPlatformInfo(); } catch (_) {}
    if (runtimeState.mode === "auto"
      && runtimeState.stage === "selecting_task"
      && !runtimeState.currentTask
      && Date.now() - Number(runtimeState.lastProgressAt || 0) >= CAMPAIGNS_IDLE_REFRESH_MS
      && !runtimeState.marketplaceRefreshInFlight
      && Number.isInteger(runtimeState.lighthouseTabId)) {
      runtimeState.marketplaceRefreshInFlight = true;
      try {
        const options = runtimeState.startOptions || {};
        const windowId = getRuntimeWindowId();
        log("info", "Lighthouse 任务广场连续 5 分钟无活动，停止当前运行并重新执行全量检测");
        const marketplaceTabId = runtimeState.lighthouseTabId;
        await cancelCurrentRun();
        await clearAutoRunResumeSchedule();
        await clearAutoRunKeepalive();
        runtimeState.running = false;
        runtimeState.scheduledResumeAt = 0;
        runtimeState.runId = createRunId();
        clearXOpenWatch();
        setStage("stopped");
        if (Number.isInteger(marketplaceTabId)) {
          await chrome.tabs.reload(marketplaceTabId);
          await waitForTabComplete(marketplaceTabId);
        }
        void startAutoRun(options, windowId).catch((error) => {
          log("error", `Lighthouse 重新执行全量检测失败：${error.message || String(error)}`);
        });
      } catch (error) {
        log("warn", `Lighthouse 停止并重新检测失败：${error.message || String(error)}`);
      } finally {
        runtimeState.marketplaceRefreshInFlight = false;
      }
    }
    return;
  }
  if (await tryResumeAutoRunAfterInterruption()) return;
  // No active run and nothing safe to resume: stop keeping the worker awake.
  await clearAutoRunKeepalive();
}

async function tryResumeAutoRunAfterInterruption() {
  if (runtimeState.running) return true;
  if (runtimeState.mode !== "idle" || runtimeState.stage !== "interrupted_not_resumed") return false;
  const savedTask = runtimeState.currentTask || {};
  const hasLockedIncompleteSeat = Boolean(
    (savedTask.seatLocked === true || savedTask.seatLockedAt) && !runtimeState.completionEvidence
  );
  if (hasLockedIncompleteSeat) {
    log("error", `service worker 重启后仍有已锁定未完成的订单（${describeTaskForLog(savedTask)}），不自动续跑，请人工处理该订单后重新启动`);
    return false;
  }
  // The old content-script run may still hold its claim with the previous
  // runId; cancel it so the resumed scan is not answered with a conflict.
  if (Number.isInteger(runtimeState.lighthouseTabId)) {
    try {
      await chrome.tabs.sendMessage(runtimeState.lighthouseTabId, {
        type: "CANCEL_LIGHTHOUSE_RUN",
        runId: runtimeState.runId
      });
    } catch (_) {}
  }
  runtimeState.runId = createRunId();
  runtimeState.running = true;
  runtimeState.mode = "auto";
  runtimeState.xTabId = null;
  runtimeState.xTabWindowId = null;
  runtimeState.lastXResult = null;
  setStage("auto_resumed_after_restart");
  log("warn", "service worker 重启，已自动恢复正式模式继续扫描任务广场");
  await startNextAutoTask("resume_after_service_worker_restart");
  return runtimeState.running;
}

function touchAutoRunState() {
  runtimeState.lastProgressAt = Date.now();
  persistAutoRunState();
}

function persistAutoRunState() {
  const snapshot = {
    ...runtimeState,
    pendingXOpen: null,
    logs: Array.isArray(runtimeState.logs) ? runtimeState.logs.slice(0, 120) : []
  };
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
