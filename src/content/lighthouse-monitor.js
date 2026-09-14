(function () {
  const SINGLETON_KEY = "__lighthouseHighBountyMonitor__";
  const SCRIPT_VERSION = "0.7.83";
  const existingSingleton = globalThis[SINGLETON_KEY];
  if (existingSingleton?.active && existingSingleton.version === SCRIPT_VERSION) return;
  if (existingSingleton?.stop) existingSingleton.stop();
  globalThis[SINGLETON_KEY] = { active: true, version: SCRIPT_VERSION };

  const MIN_BOUNTY_THRESHOLD = 0.5;
  const CHECK_DEBOUNCE_MS = 120;
  const COUNTDOWN_CALIBRATION_MS = 1000;
  const ANNOUNCE_SCAN_MS = 5000;
  const FORCED_SYNC_THROTTLE_MS = 5000;
  const SNAPSHOT_RETRY_MS = 300;
  const SNAPSHOT_MAX_ATTEMPTS = 6;
  const ANNOUNCE_MILESTONES = [
    { id: "appear", thresholdSec: null, label: "出现" },
    { id: "2m", thresholdSec: 120, label: "还剩2分钟" },
    { id: "1m", thresholdSec: 60, label: "还剩1分钟" }
  ];
  const SEEN_KEY = "__lh_seen_tasks__";
  const LEGACY_SETTINGS_KEY = "__lh_monitor_settings__";
  const MAX_MONITOR_TASKS = 20;

  const TASK_TYPES = [
    { markers: ["评论留言", "评论", "回复", "Comment"], label: "评论" },
    { markers: ["点赞互动", "点赞", "Like"], label: "点赞互动" },
    { markers: ["转发", "转推", "Repost", "Retweet"], label: "转发" },
    { markers: ["关注", "Follow"], label: "关注" },
    { markers: ["原创推文", "原创建推文", "原创内容", "发推", "发布推文", "创建推文", "发一条推文", "Create Tweet", "Post Tweet", "Original Post"], label: "原创推文" }
  ];
  const ACTION_MARKERS = ["查看详情", "评论留言", "冷却中", "进行中", "已完成", "已提交", "席位已满", "去完成", "开始任务", "领取任务"];
  const BLOCKED_MARKERS = ["进行中", "已完成", "已提交", "席位已满", "名额已满", "已结束", "不可领取", "无法参与", "档位不符", "需灯塔严选资格", "当前等级不可", "额度不足"];
  const COOLING_MARKERS = ["冷却中", "冷却", "后可", "等待"];
  const READY_MARKERS = ["查看详情", "评论留言", "去完成", "开始任务", "领取任务"];

  let settings = createDefaultSettings();
  let seenTasks = loadSeen();
  let debounceTimer = null;
  let observer = null;
  let speechQueue = [];
  let isSpeaking = false;
  let countdownSyncTimer = null;
  let announceScanTimer = null;
  let lastCountdownData = [];
  let lastSyncAt = 0;
  let lastForcedSyncAt = 0;
  let extensionContextRetired = false;

  function isExtensionContextInvalidated(error) {
    return /Extension context invalidated|context invalidated/i.test(String(error?.message || error || ""));
  }

  function retireInvalidExtensionContext() {
    if (extensionContextRetired) return;
    extensionContextRetired = true;
    const singleton = globalThis[SINGLETON_KEY];
    if (singleton) singleton.active = false;
    stop();
  }

  function sendRuntimeMessage(message, warningLabel = "同步失败") {
    if (extensionContextRetired) return;
    try {
      const request = chrome.runtime.sendMessage(message);
      if (request?.catch) {
        request.catch((error) => {
          if (isExtensionContextInvalidated(error)) {
            retireInvalidExtensionContext();
            return;
          }
          console.warn(`[LighthouseMonitor] ${warningLabel}:`, error);
        });
      }
    } catch (error) {
      if (isExtensionContextInvalidated(error)) {
        retireInvalidExtensionContext();
        return;
      }
      console.warn(`[LighthouseMonitor] ${warningLabel}:`, error);
    }
  }

  function loadLegacySettings() {
    try {
      const raw = localStorage.getItem(LEGACY_SETTINGS_KEY);
      return raw ? normalizeMonitorSettings(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  function createDefaultSettings() {
    return {
      enabled: true,
      minBounty: MIN_BOUNTY_THRESHOLD,
      voiceEnabled: true,
      voiceEngine: "mimo",
      voiceName: "",
      voiceRate: 0.9,
      voicePitch: 1.0,
      voiceTemplateAppear: "",
      voiceTemplateCountdown2m: "",
      voiceTemplateCountdown1m: ""
    };
  }

  async function loadPersistentSettings() {
    const legacy = loadLegacySettings();
    try {
      const response = await chrome.runtime.sendMessage({
        type: legacy ? "MONITOR_MIGRATE_SETTINGS" : "MONITOR_GET_STATUS",
        settings: legacy || undefined
      });
      if (response?.ok) {
        settings = normalizeMonitorSettings(response);
      }
      if (legacy) {
        try {
          localStorage.removeItem(LEGACY_SETTINGS_KEY);
        } catch (_) {}
      }
    } catch (error) {
      if (isExtensionContextInvalidated(error)) retireInvalidExtensionContext();
      settings = legacy || createDefaultSettings();
    }
    return settings;
  }

  function applySettings(nextSettings) {
    settings = normalizeMonitorSettings(nextSettings);
  }

  function loadSeen() {
    try {
      const raw = localStorage.getItem(SEEN_KEY);
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch {
      return new Set();
    }
  }

  function saveSeen() {
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify([...seenTasks].slice(-300)));
    } catch (_) {}
  }

  function collectTaskInfos() {
    const cards = collectTaskCards();
    const primaryTasks = cards
      .map(extractTaskInfo)
      .filter((task) => task && task.sourceConfidence >= 60);
    const fallbackTasks = collectFallbackTaskInfos();
    const tasks = dedupeTasks([...primaryTasks, ...fallbackTasks]).sort(sortTasksForDisplay);

    return tasks.slice(0, MAX_MONITOR_TASKS);
  }

  function collectTaskCards() {
    const anchors = findRewardAnchors();
    const cards = [];
    const seen = new Set();

    for (const anchor of anchors) {
      const card = findSmallestValidTaskCard(anchor);
      if (!card || seen.has(card)) continue;
      seen.add(card);
      cards.push(card);
    }

    return cards;
  }

  function findRewardAnchors() {
    const anchors = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = normalize(node.nodeValue);
        return text.includes("预计获得") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });

    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (parent && isVisible(parent)) anchors.push(parent);
    }

    return anchors;
  }

  function findSmallestValidTaskCard(anchor) {
    let current = anchor;
    let best = null;

    for (let depth = 0; current && depth < 8; depth += 1) {
      if (isLikelySingleTaskCard(current)) {
        best = current;
        break;
      }
      current = current.parentElement;
    }

    return best;
  }

  function isLikelySingleTaskCard(node) {
    if (!isVisible(node)) return false;

    const text = normalize(node.innerText || "");
    if (!text.includes("预计获得") || !/\bLUX\b/i.test(text)) return false;
    if (!detectTaskType(node)) return false;
    if (!ACTION_MARKERS.some((marker) => text.includes(marker))) return false;
    if (countMatches(text, "预计获得") !== 1) return false;

    const rect = node.getBoundingClientRect();
    if (rect.width < 160 || rect.height < 140) return false;
    if (rect.width > Math.min(window.innerWidth * 0.55, 680)) return false;
    if (rect.height > Math.min(window.innerHeight * 0.75, 620)) return false;

    return true;
  }

  function extractTaskInfo(card) {
    const text = normalize(card.innerText || "");
    const taskType = detectTaskType(card);
    const bounty = parseBountyFromCard(card);
    const statusInfo = parseStatusFromCard(card);
    const title = extractTitle(card, taskType);
    const tweetUrl = extractTweetUrlFromNode(card);
    const handle = extractHandle(text);
    const sourceConfidence = scoreTaskInfo({ text, taskType, bounty, statusInfo, title });

    if (!taskType || !bounty || sourceConfidence < 70) return null;

    const taskKey = [
      taskType,
      bounty,
      title,
      normalize(statusInfo.rawText || "").slice(0, 80),
      text.slice(0, 160)
    ].join("|");
    const selectionId = buildSelectionId({ taskType, bounty, title, handle, text });

    return {
      bounty,
      countdown: statusInfo.countdown,
      countdownSec: statusInfo.countdownSec,
      taskType,
      isCooling: statusInfo.isCooling,
      isBlocked: statusInfo.isBlocked,
      isReady: statusInfo.isReady,
      progress: parseProgress(card),
      title,
      handle,
      tweetUrl,
      taskKey,
      selectionId,
      text: text.slice(0, 300),
      sourceConfidence
    };
  }

  function collectFallbackTaskInfos() {
    const actionNodes = Array.from(document.querySelectorAll("button,a,[role='button']"))
      .filter((node) => isVisible(node))
      .filter((node) => READY_MARKERS.concat(COOLING_MARKERS, BLOCKED_MARKERS).some((marker) => normalize(node.innerText || node.textContent || "").includes(marker)));
    const cards = [];
    const seen = new Set();

    for (const node of actionNodes) {
      const card = findFallbackCard(node);
      if (!card || seen.has(card)) continue;
      seen.add(card);
      cards.push(card);
    }

    return cards
      .map(extractFallbackTaskInfo)
      .filter(Boolean);
  }

  function findFallbackCard(node) {
    let current = node;
    for (let depth = 0; current && depth < 7; depth += 1) {
      const text = normalize(current.innerText || "");
      if (text.includes("预计获得") && /\bLUX\b/i.test(text)) return current;
      current = current.parentElement;
    }
    return null;
  }

  function extractFallbackTaskInfo(card) {
    const text = normalize(card.innerText || "");
    const bounty = parseBountyFromCard(card);
    if (!bounty) return null;
    const taskType = detectTaskType(card) || "任务";
    const statusInfo = parseStatusFromCard(card);
    const title = extractTitle(card, taskType);
    const tweetUrl = extractTweetUrlFromNode(card);
    const handle = extractHandle(text);
    const selectionId = buildSelectionId({ taskType, bounty, title, handle, text });
    return {
      bounty,
      countdown: statusInfo.countdown,
      countdownSec: statusInfo.countdownSec,
      taskType,
      isCooling: statusInfo.isCooling,
      isBlocked: statusInfo.isBlocked,
      isReady: statusInfo.isReady,
      progress: parseProgress(card),
      title,
      handle,
      tweetUrl,
      taskKey: `${taskType}|${bounty}|${title}|${text.slice(0, 120)}`,
      selectionId,
      text: text.slice(0, 300),
      sourceConfidence: 55
    };
  }

  function parseBountyFromCard(card) {
    const rewardNode = findBestTextNode(card, (text) => text.includes("预计获得"));
    const rewardText = collectLocalText(rewardNode || card, 4);
    const match = rewardText.match(/预计获得\s*([0-9]+(?:\.[0-9]+)?)\s*LUX/i)
      || rewardText.match(/([0-9]+(?:\.[0-9]+)?)\s*LUX/i);
    return match ? Number(match[1]) : 0;
  }

  function buildSelectionId(info) {
    return [
      info.taskType || "任务",
      Number(info.bounty || 0).toFixed(2),
      normalize(info.handle || ""),
      normalize(info.title || "").slice(0, 80),
      normalize(info.text || "").slice(0, 220)
    ].join("|");
  }

  function extractHandle(text) {
    const match = String(text || "").match(/@[A-Za-z0-9_]{1,20}/);
    return match ? match[0] : "";
  }

  function parseStatusFromCard(card) {
    const candidates = getVisibleTextBlocks(card)
      .filter((entry) => {
        const text = entry.text;
        return belongsToTaskCard(entry.node, card)
          && text.length <= 80
          && (COOLING_MARKERS.some((marker) => text.includes(marker))
          || BLOCKED_MARKERS.some((marker) => text.includes(marker))
          || READY_MARKERS.some((marker) => text.includes(marker)));
      })
      .sort((a, b) => {
        const aTimed = parseCountdownSeconds(a.text) > 0 ? 1 : 0;
        const bTimed = parseCountdownSeconds(b.text) > 0 ? 1 : 0;
        if (aTimed !== bTimed) return bTimed - aTimed;
        const ar = a.node.getBoundingClientRect();
        const br = b.node.getBoundingClientRect();
        return (br.top - ar.top) || (br.width * br.height - ar.width * ar.height);
      });

    const statusText = candidates[0]?.text || "";
    const cardText = normalize(card.innerText || "");
    const hasCoolingStatus = COOLING_MARKERS.some((marker) => statusText.includes(marker));
    const isBlocked = !hasCoolingStatus && (
      BLOCKED_MARKERS.some((marker) => cardText.includes(marker))
      || hasUnsupportedCommentGuidance(cardText)
    );
    const isCooling = !isBlocked && hasCoolingStatus;
    const isReady = !isBlocked && !isCooling && READY_MARKERS.some((marker) => statusText.includes(marker));
    const countdownSec = isCooling ? parseCountdownSeconds(statusText) : 0;

    return {
      rawText: statusText,
      isBlocked,
      isCooling,
      isReady,
      countdownSec,
      countdown: isCooling ? formatCountdown(countdownSec, statusText) : ""
    };
  }

  function hasUnsupportedCommentGuidance(text) {
    const value = normalize(text);
    const guidance = value.match(/(?:评论引导|买家希望|任务备注|接单备注|接单前)[\s\S]{0,160}/i)?.[0] || "";
    if (!guidance) return false;
    return /(?:不要|禁止|不得|不可)\s*(?:使用)?\s*AI(?:评论|回复)?/i.test(guidance)
      || /(?:要求填写|请填写|评论(?:你的)?|回复(?:你的)?)[\s\S]{0,40}(?:EVM|钱包|收款)地址/i.test(guidance);
  }

  function belongsToTaskCard(node, card) {
    let current = node;
    for (let depth = 0; current && depth < 10; depth += 1) {
      if (current === card) return true;
      if (current !== node && isLikelySingleTaskCard(current)) return false;
      current = current.parentElement;
    }
    return false;
  }

  function parseCountdownSeconds(text) {
    const value = normalize(text);
    if (!value) return 0;

    const colon = value.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (colon) {
      const parts = colon.slice(1).filter(Boolean).map(Number);
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
      if (parts.length === 2) return parts[0] * 60 + parts[1];
    }

    let total = 0;
    const hour = value.match(/(\d+)\s*(?:h(?![A-Za-z])|hr|hour|小时|时)/i);
    const minute = value.match(/(\d+)\s*(?:min(?![A-Za-z])|分钟|分)/i)
      || value.match(/(\d+)\s*m(?![A-Za-z])/);
    const second = value.match(/(\d+)\s*(?:sec|s(?![A-Za-z])|秒)/i);

    if (hour) total += Number(hour[1]) * 3600;
    if (minute) total += Number(minute[1]) * 60;
    if (second) total += Number(second[1]);
    return total;
  }

  function formatCountdown(seconds, rawText) {
    if (!seconds) return COOLING_MARKERS.some((marker) => rawText.includes(marker)) ? "冷却中" : "";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h) return `${h}小时${m}分${s}秒`;
    if (m) return `${m}分${s}秒`;
    return `${s}秒`;
  }

  function detectTaskType(source) {
    const text = typeof source === "string" ? normalize(source) : getTaskTypeScopeText(source);
    for (const entry of TASK_TYPES) {
      if (entry.markers.some((marker) => text.includes(marker))) return entry.label;
    }
    return "";
  }

  function getTaskTypeScopeText(card) {
    if (!card) return "";
    const explicit = getVisibleTextBlocks(card)
      .map((entry) => entry.text)
      .filter((text) => text && text.length <= 32 && hasTaskTypeMarker(text))
      .join(" ");
    if (explicit) return explicit;
    return extractCardHeaderText(card.innerText || card.textContent || "");
  }

  function hasTaskTypeMarker(text) {
    return TASK_TYPES.some((entry) => entry.markers.some((marker) => text.includes(marker)));
  }

  function extractCardHeaderText(rawText) {
    const lines = String(rawText || "")
      .split(/\n+/)
      .map((line) => normalize(line))
      .filter(Boolean);
    const header = [];
    for (const line of lines) {
      if (/预计获得|LUX|冷却|查看详情|活动周期|长期有效/i.test(line)) break;
      header.push(line);
      if (header.length >= 8) break;
    }
    return header.join(" ");
  }

  function extractTitle(card, taskType) {
    const blocks = getVisibleTextBlocks(card)
      .map((entry) => entry.text)
      .filter((text) => isUsefulTitle(text, taskType));

    const preferred = blocks.find((text) => !text.includes("预计获得") && !/\bLUX\b/i.test(text));
    return (preferred || blocks[0] || taskType || "任务").slice(0, 80);
  }

  function isUsefulTitle(text, taskType) {
    if (!text || text.length < 2 || text.length > 120) return false;
    if (text === taskType) return false;
    if (/活动周期|长期有效|预计获得|LUX|冷却|查看详情|评论留言|已完成|进行中|席位|PROMO|官方/.test(text)) return false;
    if (/^\d+(?:\.\d+)?$/.test(text)) return false;
    return true;
  }

  function parseProgress(card) {
    const statusText = getVisibleTextBlocks(card)
      .map((entry) => entry.text)
      .find((text) => /\b\d{1,3}%\b/.test(text));
    const match = statusText && statusText.match(/\b(\d{1,3})%\b/);
    return match ? Math.min(Number(match[1]), 100) : 0;
  }

  function extractTweetUrlFromNode(root) {
    const anchorUrl = Array.from(root.querySelectorAll?.("a[href]") || [])
      .map((anchor) => anchor.href || anchor.getAttribute("href") || "")
      .map(normalizeTweetUrl)
      .find(Boolean);
    if (anchorUrl) return anchorUrl;

    const textUrl = normalize(root.innerText || root.textContent || "").match(/https:\/\/(?:x|twitter)\.com\/[A-Za-z0-9_]+\/status\/\d+/i);
    return textUrl ? normalizeTweetUrl(textUrl[0]) : "";
  }

  function normalizeTweetUrl(url) {
    const match = String(url || "").match(/https:\/\/(?:x|twitter)\.com\/[A-Za-z0-9_]+\/status\/\d+/i);
    return match ? match[0].replace("twitter.com", "x.com") : "";
  }

  function scoreTaskInfo(info) {
    let score = 0;
    if (info.text.includes("预计获得")) score += 25;
    if (info.bounty > 0 && info.bounty < 100) score += 25;
    if (info.taskType) score += 20;
    if (info.statusInfo.isCooling || info.statusInfo.isBlocked || info.statusInfo.isReady) score += 20;
    if (info.title) score += 10;
    return score;
  }

  function getVisibleTextBlocks(root) {
    const nodes = Array.from(root.querySelectorAll("button,a,[role='button'],span,p,div,strong,b,small"));
    const entries = [];
    const seen = new Set();

    for (const node of nodes) {
      if (!isVisible(node)) continue;
      const text = normalize(node.innerText || node.textContent || "");
      if (!text || seen.has(text)) continue;
      seen.add(text);
      entries.push({ node, text });
    }

    return entries;
  }

  function findBestTextNode(root, predicate) {
    const entries = getVisibleTextBlocks(root);
    return entries.find((entry) => predicate(entry.text))?.node || null;
  }

  function collectLocalText(node, maxDepth) {
    let current = node;
    let text = "";
    for (let depth = 0; current && depth <= maxDepth; depth += 1) {
      text = normalize(current.innerText || current.textContent || "");
      if (text.includes("预计获得") && /\bLUX\b/i.test(text)) return text;
      current = current.parentElement;
    }
    return text;
  }

  function dedupeTasks(tasks) {
    const seen = new Set();
    const result = [];
    for (const task of tasks) {
      const key = `${task.taskType}|${task.bounty}|${task.title}|${task.countdownSec}|${task.isBlocked}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(task);
    }
    return result;
  }

  function sortTasksForDisplay(a, b) {
    if (a.isReady !== b.isReady) return a.isReady ? -1 : 1;
    if (a.isCooling !== b.isCooling) return a.isCooling ? 1 : -1;
    if (a.isCooling && b.isCooling && a.countdownSec !== b.countdownSec) return a.countdownSec - b.countdownSec;
    return b.bounty - a.bounty;
  }

  function syncCountdowns(options = {}) {
    if (extensionContextRetired) return;
    const force = Boolean(options.force);
    if (!settings.enabled && !force) return;

    const tasks = collectTaskInfos();
    // SPA reloads briefly expose an incomplete card tree. Keep the last useful
    // snapshot during that gap so the panel does not flicker to "无数据".
    if (tasks.length > 0 || lastCountdownData.length === 0) {
      lastCountdownData = tasks;
    }
    lastSyncAt = Date.now();
    if (settings.debugLogging) {
      console.log(`[LighthouseMonitor] 同步倒计时: ${tasks.length} 个可信任务`);
    }

    sendRuntimeMessage({
      type: "MONITOR_COUNTDOWN_SYNC",
      tasks,
      timestamp: lastSyncAt
    });
  }

  async function collectCountdownSnapshot(options = {}) {
    const force = Boolean(options.force);
    const allowRetry = Boolean(options.allowRetry);
    if (force) {
      syncCountdowns({ force: true });
    }
    if (!allowRetry || lastCountdownData.length > 0) {
      return { ok: true, tasks: lastCountdownData, timestamp: lastSyncAt || Date.now() };
    }

    for (let attempt = 1; attempt <= SNAPSHOT_MAX_ATTEMPTS; attempt += 1) {
      await wait(SNAPSHOT_RETRY_MS);
      syncCountdowns({ force: true });
      if (lastCountdownData.length > 0) break;
    }

    return { ok: true, tasks: lastCountdownData, timestamp: lastSyncAt || Date.now() };
  }

  function scanForHighBounty() {
    if (extensionContextRetired) return;
    if (!settings.enabled) return;

    const hits = [];
    for (const info of collectTaskInfos()) {
      if (info.bounty < settings.minBounty) continue;
      if (info.isBlocked) continue;

      const milestone = getNextAnnounceMilestone(info);
      if (!milestone) continue;

      seenTasks.add(buildAnnounceSeenKey(info, milestone.id));
      hits.push({ info, milestone });
    }

    saveSeen();
    hits.forEach(({ info, milestone }) => notifyHighBounty(info, milestone));
  }

  function getNextAnnounceMilestone(info) {
    const stableKey = buildStableAnnounceKey(info);
    if (!stableKey) return null;

    if (isIgnoredNonCommentTaskInfo(info)) {
      const appear = ANNOUNCE_MILESTONES[0];
      return seenTasks.has(`${stableKey}|${appear.id}`) ? null : appear;
    }

    for (const milestone of ANNOUNCE_MILESTONES) {
      if (seenTasks.has(`${stableKey}|${milestone.id}`)) continue;
      if (milestone.thresholdSec === null) return milestone;
      if (info.isCooling && info.countdownSec > 0 && info.countdownSec <= milestone.thresholdSec) return milestone;
    }

    return null;
  }

  function isIgnoredNonCommentTaskInfo(info) {
    const taskType = normalize(info?.taskType || "");
    return taskType === "原创推文"
      || taskType === "转发";
  }

  function buildAnnounceSeenKey(info, milestoneId) {
    return `${buildStableAnnounceKey(info)}|${milestoneId}`;
  }

  function buildStableAnnounceKey(info) {
    return [
      info.taskType || "任务",
      Number(info.bounty || 0).toFixed(2),
      normalize(info.title || "").slice(0, 80) || normalize(info.text || "").slice(0, 80)
    ].join("|");
  }

  function notifyHighBounty(info, milestone) {
    const title = `高赏金任务 ${info.bounty} LUX`;
    const body = buildTaskSummary(info, milestone);
    const speechData = buildSpeechData(info, milestone);
    const voiceText = buildSpeechText(info, milestone);

    sendRuntimeMessage({ type: "HIGH_BOUNTY_ALERT", bounty: info.bounty, text: body, voiceText, speechData }, "高赏金通知失败");

    console.log(`[LighthouseMonitor] ${title} - ${body}`);
  }

  function buildTaskSummary(info, milestone) {
    const status = info.isBlocked
      ? "不可做"
      : info.isCooling
        ? `冷却${info.countdown || "中"}`
        : "可做";
    const milestoneText = milestone?.label ? `${milestone.label} · ` : "";
    return `${milestoneText}${info.taskType} · ${status} · ${info.title || "任务"} · 置信度${info.sourceConfidence}`;
  }

  function speakTask(info, milestone) {
    enqueueSpeech(buildSpeechText(info, milestone));
  }

  function buildSpeechText(info, milestone) {
    const payload = buildSpeechData(info, milestone);
    return `${payload.milestoneText}赏金${payload.bounty}LUX，${payload.status}，任务类型${payload.taskType}${payload.titleText}`;
  }

  function buildSpeechData(info, milestone) {
    const statusText = info.isBlocked
      ? "当前不可做"
      : info.isCooling
        ? `倒计时${info.countdown || "冷却中"}`
        : "当前可做";
    return {
      bounty: String(info.bounty ?? ""),
      status: statusText,
      taskType: String(info.taskType || ""),
      title: String(info.title || ""),
      countdown: String(info.countdown || ""),
      milestone: String(milestone?.label || ""),
      milestoneText: milestone?.label ? `${milestone.label}，` : "",
      titleText: info.title ? `，标题${info.title}` : ""
    };
  }

  function enqueueSpeech(text) {
    if (speechQueue.length >= 3) {
      speechQueue = speechQueue.slice(-2);
    }
    speechQueue.push(text);
    if (!isSpeaking) processSpeechQueue();
  }

  function processSpeechQueue() {
    if (isSpeaking || speechQueue.length === 0) return;
    isSpeaking = true;
    const text = speechQueue.shift();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    utterance.rate = settings.voiceRate || 0.9;
    utterance.pitch = settings.voicePitch || 1.0;
    utterance.volume = 1.0;

    const chosen = chooseVoice(settings.voiceName);
    if (chosen) utterance.voice = chosen;

    utterance.onend = () => {
      isSpeaking = false;
      processSpeechQueue();
    };
    utterance.onerror = () => {
      isSpeaking = false;
      processSpeechQueue();
    };

    speechSynthesis.speak(utterance);
  }

  function isVisible(node) {
    if (!node || !(node instanceof Element)) return false;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0
      && rect.height > 0
      && style.visibility !== "hidden"
      && style.display !== "none"
      && Number(style.opacity || 1) !== 0;
  }

  function chooseVoice(preferredName = "") {
    const voices = rankVoices(speechSynthesis.getVoices());
    if (preferredName) {
      const exact = voices.find((voice) => voice.name === preferredName);
      if (exact) return exact;
    }
    return voices.find((voice) => /zh|chinese|普通话|中文|mandarin/i.test(`${voice.name} ${voice.lang}`)) || voices[0] || null;
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

  function countMatches(text, needle) {
    return String(text || "").split(needle).length - 1;
  }

  function normalize(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function onDomChange() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      scanForHighBounty();
      syncCountdowns({ force: true });
    }, CHECK_DEBOUNCE_MS);
  }

  function startCountdownSync() {
    if (countdownSyncTimer) return;
    syncCountdowns({ force: true });
    countdownSyncTimer = setInterval(() => syncCountdowns({ force: true }), COUNTDOWN_CALIBRATION_MS);
  }

  function startAnnounceScan() {
    if (announceScanTimer) return;
    announceScanTimer = setInterval(scanForHighBounty, ANNOUNCE_SCAN_MS);
  }

  function stopCountdownSync() {
    if (!countdownSyncTimer) return;
    clearInterval(countdownSyncTimer);
    countdownSyncTimer = null;
  }

  function stopAnnounceScan() {
    if (!announceScanTimer) return;
    clearInterval(announceScanTimer);
    announceScanTimer = null;
  }

  function start() {
    if (extensionContextRetired || observer) return;
    observer = new MutationObserver(onDomChange);
    observer.observe(document.body, { childList: true, subtree: true });
    scanForHighBounty();
    startCountdownSync();
    startAnnounceScan();
    console.log("[LighthouseMonitor] 被动监控已启动，阈值:", settings.minBounty, "LUX，语音:", settings.voiceEnabled ? "开启" : "关闭");
  }

  window.addEventListener("pageshow", () => syncCountdowns({ force: true }));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) syncCountdowns({ force: true });
  });

  function stop() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    stopCountdownSync();
    stopAnnounceScan();
    console.log("[LighthouseMonitor] 监控已停止");
  }

  if ("speechSynthesis" in window) {
    speechSynthesis.getVoices();
    speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
  }

  globalThis[SINGLETON_KEY] = {
    ...(globalThis[SINGLETON_KEY] || {}),
    active: true,
    version: SCRIPT_VERSION,
    stop,
    parseStatusFromCard
  };

  chrome.runtime?.onMessage?.addListener?.((msg, _sender, sendResponse) => {
    if (msg.type === "MONITOR_GET_STATUS") {
      sendResponse({ ok: true, enabled: settings.enabled, minBounty: settings.minBounty, voiceEnabled: settings.voiceEnabled, voiceName: settings.voiceName, seenCount: seenTasks.size });
      return;
    }
    if (msg.type === "MONITOR_APPLY_SETTINGS") {
      applySettings(msg.settings);
      settings.enabled ? start() : stop();
      sendResponse({ ok: true, ...settings });
      return;
    }
    if (msg.type === "MONITOR_SET_ENABLED") {
      settings.enabled = Boolean(msg.enabled);
      settings.enabled ? start() : stop();
      sendResponse({ ok: true, enabled: settings.enabled });
      return;
    }
    if (msg.type === "MONITOR_SET_THRESHOLD") {
      settings.minBounty = Math.max(0.1, Number(msg.minBounty) || MIN_BOUNTY_THRESHOLD);
      sendResponse({ ok: true, minBounty: settings.minBounty });
      return;
    }
    if (msg.type === "MONITOR_SET_VOICE") {
      settings.voiceEnabled = Boolean(msg.voiceEnabled);
      settings.voiceName = String(msg.voiceName || "").trim();
      if (msg.rate !== undefined) settings.voiceRate = Math.max(0.5, Math.min(2, Number(msg.rate) || 1));
      if (msg.pitch !== undefined) settings.voicePitch = Math.max(0.5, Math.min(2, Number(msg.pitch) || 1));
      sendResponse({ ok: true, voiceEnabled: settings.voiceEnabled, voiceName: settings.voiceName, voiceRate: settings.voiceRate, voicePitch: settings.voicePitch });
      return;
    }
    if (msg.type === "MONITOR_TEST_VOICE") {
      enqueueSpeech(`语音播报测试，当前阈值${settings.minBounty}LUX`);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "MONITOR_CLEAR_SEEN") {
      seenTasks.clear();
      saveSeen();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "MONITOR_SPEAK_TEXT") {
      if (msg.text) enqueueSpeech(msg.text);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "MONITOR_GET_COUNTDOWNS") {
      collectCountdownSnapshot({ force: false, allowRetry: true }).then(sendResponse);
      return true;
    }
    if (msg.type === "MONITOR_GET_COUNTDOWNS_SNAPSHOT") {
      const shouldForce = !lastSyncAt || lastCountdownData.length === 0 || Date.now() - lastForcedSyncAt > FORCED_SYNC_THROTTLE_MS;
      if (shouldForce) {
        lastForcedSyncAt = Date.now();
      }
      collectCountdownSnapshot({ force: shouldForce, allowRetry: true }).then(sendResponse);
      return true;
    }
  });

  if (location.pathname.includes("/campaigns")) {
    loadPersistentSettings().finally(start);
  }

  function normalizeMonitorSettings(value) {
    const merged = { ...createDefaultSettings(), ...(value || {}) };
  const minBounty = Number(merged.minBounty);
  const voiceRate = Number(merged.voiceRate ?? merged.rate);
  const voicePitch = Number(merged.voicePitch ?? merged.pitch);
  const voiceEngine = merged.voiceEngine === "browser" ? "browser" : "mimo";
  const voiceName = String(merged.voiceName || "").trim();
  return {
    enabled: Boolean(merged.enabled),
    minBounty: Number.isFinite(minBounty) ? Math.max(0.1, minBounty) : MIN_BOUNTY_THRESHOLD,
    voiceEnabled: Boolean(merged.voiceEnabled),
    voiceEngine,
    voiceName,
    voiceRate: Number.isFinite(voiceRate) ? Math.max(0.5, Math.min(2, voiceRate)) : 0.9,
      voicePitch: Number.isFinite(voicePitch) ? Math.max(0.5, Math.min(2, voicePitch)) : 1.0,
      voiceTemplateAppear: String(merged.voiceTemplateAppear || ""),
      voiceTemplateCountdown2m: String(merged.voiceTemplateCountdown2m || merged.voiceTemplateCountdown || ""),
      voiceTemplateCountdown1m: String(merged.voiceTemplateCountdown1m || "")
    };
  }
})();
