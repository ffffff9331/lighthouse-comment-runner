(function () {
  const SINGLETON_KEY = "__lighthouseCommentTaskRunnerLighthouseSingleton__";
  const SCRIPT_VERSION = "0.7.83";
  const INSTANCE_ID = `lighthouse-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const existingSingleton = globalThis[SINGLETON_KEY];
  if (existingSingleton?.active && existingSingleton.version === SCRIPT_VERSION) {
    return;
  }
  if (existingSingleton) {
    existingSingleton.active = false;
    existingSingleton.replacedBy = INSTANCE_ID;
  }
  globalThis[SINGLETON_KEY] = {
    active: true,
    version: SCRIPT_VERSION,
    instanceId: INSTANCE_ID,
    installedAt: Date.now()
  };

  const DETAIL_BUTTON_TEXTS = ["查看详情", "详情", "评论留言", "去完成", "开始任务", "领取任务", "查看推文", "前往目标", "打开目标"];
  const LOCK_BUTTON_TEXTS = ["锁定席位", "锁定名额", "抢占席位", "领取任务", "开始任务", "去评论"];
  const DONE_BUTTON_TEXTS = ["我已评论", "提交验证", "提交验证任务", "我已完成", "已完成", "完成任务", "提交任务", "验证任务", "领取奖励"];
  const COMMENT_MARKERS = ["评论留言", "评论", "回复"];
  const COMMENT_EQUIVALENT_MARKERS = ["点赞互动", "点赞", "Like"];
  const FOLLOW_MARKERS = ["关注", "Follow"];
  const ORIGINAL_TWEET_MARKERS = ["原创推文", "原创建推文", "原创内容", "发推", "发布推文", "创建推文", "发一条推文", "Create Tweet", "Post Tweet", "Original Post"];
  const RETWEET_MARKERS = ["转发", "转推", "Repost", "Retweet"];
  const DETAIL_MARKERS = [
    "TARGET TWEET",
    "目标推文",
    "SLOT POOL",
    "席位池",
    "进度 Timeline",
    "奖励明细",
    "前往目标",
    "在 X 打开",
    "锁定席位",
    "请先锁定席位",
    "我已评论",
    "提交验证",
    "AI 内容审核"
  ];
  const DETAIL_TASK_MARKERS = ["评论任务", "Comment", "评论留言", "点赞互动", "点赞", "Like", "关注", "Follow", "完成后回来点击", "Twitter API", "原创推文", "原创建推文", "原创内容", "发推", "转发", "转推", "Repost", "Retweet"];
  const BLOCKED_MARKERS = ["进行中", "已完成", "已提交", "档位不符", "需灯塔严选资格", "当前等级不可", "额度不足"];
  const HARD_FAIL_MARKERS = ["席位已满或无法锁定", "席位已满", "位置已满", "名额已满", "任务已满", "已抢完", "不可领取", "不能参与", "无法参与", "无法锁定", "已结束", "任务失败"];
  const TASK_UNAVAILABLE_MARKERS = ["任务暂时无法打开", "请返回任务广场后重试"];
  const TIER_MISMATCH_PHRASE = "档位不符，无法领取";
  const COOLDOWN_MARKERS = ["冷却中", "冷却", "等待", "后可"];
  const AUTO_DETAIL_PRELOAD_MS = 60000;
  const AUTO_DETAIL_MAX_RELEASE_WAIT_MS = 60000;
  const STALE_READY_REFRESH_THRESHOLD = 3;
  const STALE_READY_REFRESH_HITS = 2;
  let activeRunId = "";
  const cancelledRunIds = new Set();
  let claimOperation = null;
  let completionContext = null;
  let lastOriginalSkipReportAt = 0;
  let lastReportedMinTaskBounty = null;

  window.addEventListener("lighthouse-unverified-link-alert-dismissed", () => {
    report("info", "已自动确认未验证链接提示，继续执行任务");
  });

  window.addEventListener("lighthouse-target-tweet-url", (event) => {
    const tweetUrl = normalizeTweetUrl(event?.detail?.tweetUrl || "");
    if (!tweetUrl || !activeRunId) return;
    sendRuntimeMessage({
      type: "LIGHTHOUSE_TARGET_TWEET_URL",
      runId: activeRunId,
      tweetUrl
    });
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isCurrentInstance()) return false;

    const routes = {
      CANCEL_LIGHTHOUSE_RUN: () => cancelRun(message),
      START_LIGHTHOUSE_COMMENT_TASK: () => runCommentTask(message.settings, message),
      COMPLETE_LIGHTHOUSE_COMMENT_TASK: () => completeTask(message.settings),
      DEBUG_OPEN_FIRST_COMMENT_TASK: () => debugOpenFirstCommentTask(message.settings, message),
      OPEN_SELECTED_COUNTDOWN_TASK_DETAIL: () => openSelectedCountdownTaskDetail(message.settings, message.selectedTask),
      OPEN_SELECTED_COUNTDOWN_TASK_TWEET: () => openSelectedCountdownTaskTweet(message.settings, message.selectedTask),
      OPEN_CURRENT_DETAIL_TWEET_TARGET: () => openCurrentDetailTweetTarget(
        message.settings,
        message.taskTypeHint || message.task?.taskType || ""
      ),
      WAIT_SELECTED_COUNTDOWN_AND_LOCK: () => waitSelectedCountdownAndLock(message.settings, message.selectedTask),
      CHECK_LIGHTHOUSE_LOCK_FAILURE: () => checkLighthouseLockFailure(),
      BEGIN_LIGHTHOUSE_COMPLETION_WATCH: () => beginCompletionWatch(message),
      CHECK_LIGHTHOUSE_OFFICIAL_COMPLETION: () => checkOfficialCompletion(message),
      DEBUG_LOCK_SEAT_AND_EXTRACT: () => debugLockSeatAndExtract(message.settings),
      DEBUG_CLICK_I_DONE: () => debugClickDone(message.settings),
      WAIT_LIGHTHOUSE_COMPLETION_RETURN: () => waitForTaskCompletionAndReturn(message.settings, message),
      READ_LIGHTHOUSE_TODAY_INCOME: () => readPlazaTodayIncome(),
      CLOSE_LIGHTHOUSE_TASK_DETAIL: () => closeTaskDetailPanel(message.settings)
    };

    const handler = routes[message.type];
    if (!handler) return false;
    if (message.type !== "CANCEL_LIGHTHOUSE_RUN" && cancelledRunIds.has(message.runId)) {
      sendResponse({ ok: false, cancelled: true, message: "旧任务已取消" });
      return true;
    }

    const claimRoute = [
      "START_LIGHTHOUSE_COMMENT_TASK", "DEBUG_OPEN_FIRST_COMMENT_TASK",
      "OPEN_SELECTED_COUNTDOWN_TASK_DETAIL", "OPEN_SELECTED_COUNTDOWN_TASK_TWEET",
      "WAIT_SELECTED_COUNTDOWN_AND_LOCK", "DEBUG_LOCK_SEAT_AND_EXTRACT"
    ].includes(message.type);
    if (claimRoute && claimOperation) {
      const key = JSON.stringify([message.runId, message.type, message.selectedTask || null]);
      if (claimOperation.key === key) claimOperation.promise.then(sendResponse);
      else sendResponse({ ok: false, conflict: true, message: "另一接单操作尚未结束" });
      return true;
    }
    if (message.type !== "CANCEL_LIGHTHOUSE_RUN") {
      activeRunId = message.runId || `manual-${Date.now()}`;
    }

    const operation = claimRoute ? {
      key: JSON.stringify([message.runId, message.type, message.selectedTask || null])
    } : null;
    if (operation) claimOperation = operation;
    const resultPromise = Promise.resolve().then(handler);
    if (operation) {
      operation.promise = resultPromise
        .catch((error) => ({ ok: false, message: error.message || String(error) }))
        .finally(() => { if (claimOperation === operation) claimOperation = null; });
    }
    resultPromise
      .then((result) => {
        if (isCurrentInstance()) sendResponse(result);
      })
      .catch((error) => {
        if (!isCurrentInstance()) return;
        const messageText = error.message || String(error);
        const transient = Boolean(error.transient) || isTransientLoadError(messageText) || hasDetailRequestTimeout();
        report(error.permanentIgnore ? "warn" : (transient ? "info" : "error"), messageText);
        sendResponse({
          ok: false,
          message: messageText,
          transient,
          refreshRequested: Boolean(error.refreshRequested),
          permanentIgnore: Boolean(error.permanentIgnore),
          ignoredTaskType: error.ignoredTaskType || "",
          task: error.task || buildTask(message.settings)
        });
      });
    return true;
  });

  function isCurrentInstance() {
    const singleton = globalThis[SINGLETON_KEY];
    return Boolean(singleton?.active && singleton.version === SCRIPT_VERSION && singleton.instanceId === INSTANCE_ID);
  }

  function cancelRun(message) {
    if (message.runId) cancelledRunIds.add(message.runId);
    if (!message.runId || !activeRunId || message.runId === activeRunId) {
      activeRunId = `cancelled-${Date.now()}`;
    }
    return { ok: true };
  }

  async function runCommentTask(settings, message = {}) {
    const openResult = await debugOpenFirstCommentTask(settings, message);
    const lockResult = await debugLockSeatAndExtract(settings);
    const task = {
      ...(lockResult.task || {}),
      taskType: openResult.task?.taskType || lockResult.task?.taskType || "评论",
      taskKey: openResult.task?.taskKey || lockResult.task?.taskKey,
      selectionId: openResult.task?.selectionId || lockResult.task?.selectionId,
      stableTaskKey: openResult.task?.stableTaskKey || lockResult.task?.stableTaskKey,
      bounty: openResult.task?.bounty || lockResult.task?.bounty,
      handle: openResult.task?.handle || lockResult.task?.handle,
      candidateTitle: openResult.task?.candidateTitle || lockResult.task?.candidateTitle
    };
    return { ok: true, message: "已提取评论任务并打开推文", task, openResult };
  }

  async function debugOpenFirstCommentTask(settings, message = {}) {
    report("info", "准备打开评论、点赞或关注互动任务");
    await ensureCampaignsPage(settings);
    await confirmPagePhase(["campaigns"], settings, "打开评论任务前");
    await ensureAllTaskFilter(settings);
    await confirmPagePhase(["campaigns"], settings, "全部筛选后");

    const selection = await selectNextCommentTask(settings, message.attemptedTaskKeys || []);
    if (!selection || !selection.target) {
      throw new Error("未找到可执行或可等待的评论、点赞或关注互动任务");
    }

    const task = {
      source: "lighthouse_list",
      title: "任务广场",
      taskKey: selection.taskKey,
      selectionId: selection.selectionId,
      stableTaskKey: selection.stableTaskKey,
      taskType: selection.taskType,
      bounty: selection.bounty,
      handle: selection.handle,
      candidateTitle: selection.title,
      listText: selection.text.slice(0, 500),
      cooldownMs: selection.cooldownMs || 0,
      cooldownSniping: selection.cooldownSniping || false
    };

    try {
      await openTaskDetailOrFail(selection, settings);
      await confirmPagePhase(["detail_ready"], settings, "打开任务详情后");
    } catch (error) {
      error.task = task;
      throw error;
    }

    const detectedDetailTask = buildTask(settings, selection.taskType);
    const detailTask = {
      ...task,
      ...detectedDetailTask,
      taskKey: selection.taskKey,
      selectionId: selection.selectionId,
      stableTaskKey: selection.stableTaskKey,
      taskType: selection.taskType || detectedDetailTask.taskType,
      bounty: selection.bounty,
      handle: selection.handle,
      candidateTitle: selection.title,
      listText: selection.text.slice(0, 500),
      cooldownMs: selection.cooldownMs || 0,
      cooldownSniping: selection.cooldownSniping || false
    };
    assertSupportedDetailTask(detailTask, settings);

    Object.assign(task, detailTask, {
      taskKey: selection.taskKey,
      selectionId: selection.selectionId,
      stableTaskKey: selection.stableTaskKey,
      taskType: selection.taskType,
      bounty: selection.bounty,
      handle: selection.handle,
      candidateTitle: selection.title,
      listText: selection.text.slice(0, 500),
      cooldownMs: selection.cooldownMs || 0,
      cooldownSniping: selection.cooldownSniping || false
    });
    chrome.runtime.sendMessage({ type: "DEBUG_TASK_CANDIDATE", runId: activeRunId, task });

    return {
      ok: true,
      message: selection.cooldownSniping
        ? "已在任务广场等待到可执行评论、点赞或关注互动任务并打开详情"
        : "已打开第一个可执行评论、点赞或关注互动任务详情",
      task
    };
  }

  async function openSelectedCountdownTaskTweet(settings, selectedTask) {
    if (!selectedTask) {
      throw new Error("未选择倒计时任务");
    }

    report("info", `准备打开选中任务详情：${selectedTask.bounty || "?"}LUX · ${selectedTask.title || selectedTask.taskType || "任务"}`);
    await ensureCampaignsPage(settings);
    await confirmPagePhase(["campaigns"], settings, "打开选中任务前");
    const selection = await findSelectedCountdownCandidate(settings, selectedTask);
    await openTaskDetailOrFail(selection, settings);
    await confirmPagePhase(["detail_ready"], settings, "打开选中详情后");

    const detailTask = await waitForSelectedTaskTweetTarget(settings, selectedTask.taskType || selection.taskType);
    return {
      ok: true,
      message: detailTask.awaitingXTabAdoption ? "已点击选中任务详情的在 X 打开控件" : "已从选中任务详情提取推文链接",
      task: {
        ...detailTask,
        source: "selected_countdown_task",
        selectedTask,
        listText: selection.text.slice(0, 500),
        cooldownMs: selection.cooldownMs || 0,
        taskKey: selection.taskKey || detailTask.taskKey
      }
    };
  }

  async function openSelectedCountdownTaskDetail(settings, selectedTask) {
    if (!selectedTask) {
      throw new Error("未选择倒计时任务");
    }

    report("info", `准备打开选中任务详情：${selectedTask.bounty || "?"}LUX · ${selectedTask.title || selectedTask.taskType || "任务"}`);
    await ensureCampaignsPage(settings);
    await confirmPagePhase(["campaigns"], settings, "打开选中任务前");
    const selection = await findSelectedCountdownCandidate(settings, selectedTask);
    await openTaskDetailOrFail(selection, settings);
    await confirmPagePhase(["detail_ready"], settings, "打开选中详情后");

    const detailTask = await waitForTaskDetailReady(settings, selectedTask.taskType || selection.taskType);
    assertSupportedDetailTask(detailTask, settings);
    return {
      ok: true,
      message: "已打开选中任务详情，等待倒计时窗口锁定",
      task: {
        ...detailTask,
        source: "selected_countdown_detail",
        selectedTask,
        listText: selection.text.slice(0, 500),
        cooldownMs: selection.cooldownMs || 0,
        taskKey: selection.taskKey || detailTask.taskKey
      }
    };
  }

  async function openCurrentDetailTweetTarget(settings, taskTypeHint = "") {
    // This command is the post-lock fallback.  Do not wait for the full page
    // timeout here: the background retries it and can use an extracted URL.
    const detailTask = await waitForSelectedTaskTweetTarget(settings, taskTypeHint, 1800);
    return {
      ok: true,
      message: detailTask.awaitingXTabAdoption ? "已点击当前任务详情的在 X 打开控件" : "已从当前任务详情提取推文链接",
      task: {
        ...detailTask,
        source: "current_lighthouse_detail"
      }
    };
  }

  async function findSelectedCountdownCandidate(settings, selectedTask) {
    await waitForCampaignsReady(getPageWaitMs(settings));
    const candidates = collectTaskCandidates([]);
    const selectableCandidates = candidates.filter((candidate) =>
      isSelectableAutomatableCandidate(candidate)
    );
    const ignoredCount = candidates.length - selectableCandidates.length;
    const ranked = selectableCandidates
      .map((candidate) => ({ candidate, score: scoreSelectedTaskCandidate(candidate, selectedTask) }))
      .filter((entry) => entry.score >= 140 && entry.candidate.target)
      .sort((a, b) => b.score - a.score);

    if (!ranked[0]) {
      const topSource = selectableCandidates.length ? selectableCandidates : candidates;
      const top = topSource
        .map((candidate) => ({ candidate, score: scoreSelectedTaskCandidate(candidate, selectedTask) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map((entry) => formatCandidateMatchDebug(entry.candidate, entry.score))
        .join(" / ");
      throw new Error(`未严格匹配到选中评论、点赞或关注互动任务：${selectedTask.title || selectedTask.taskType || "未知任务"}；已排除原创/转发候选 ${ignoredCount} 条；候选=${top || "无"}`);
    }

    report("info", `选中任务匹配成功：${formatCandidateMatchDebug(ranked[0].candidate, ranked[0].score)}`);
    return ranked[0].candidate;
  }

  function isSelectableAutomatableCandidate(candidate) {
    return Boolean(candidate
      && candidate.target
      && candidate.isAutomatable
      && !candidate.isOriginalTweet
      && !candidate.isRetweet);
  }

  function canonicalSupportedTaskType(taskType) {
    const value = normalize(taskType);
    if (value === "点赞" || value === "Like") return "点赞互动";
    if (value === "评论留言" || value === "回复") return "评论";
    if (FOLLOW_MARKERS.some((marker) => value.includes(marker))) return "关注";
    return value;
  }

  function formatCandidateMatchDebug(candidate, score) {
    return [
      `score=${score}`,
      candidate.taskType || "未知类型",
      candidate.bounty ? `${candidate.bounty}LUX` : "",
      candidate.handle || "-",
      candidate.title || candidate.text?.slice(0, 40) || ""
    ].filter(Boolean).join(" · ");
  }

  function scoreSelectedTaskCandidate(candidate, selectedTask) {
    const text = normalize(candidate.text || "");
    const selectedText = normalize(selectedTask.text || "");
    const title = normalize(selectedTask.title || "");
    const taskType = canonicalSupportedTaskType(selectedTask.taskType || "");
    const candidateTaskType = canonicalSupportedTaskType(candidate.taskType || "");
    const bounty = Number(selectedTask.bounty || 0);
    const selectionId = normalize(selectedTask.selectionId || "");
    const handle = normalize(selectedTask.handle || extractHandle(selectedTask.text || ""));
    const candidateHandle = normalize(candidate.handle || "");
    if (!isSelectableAutomatableCandidate(candidate)) return 0;
    if (taskType && !isAutomatableTaskType(taskType)) return 0;
    if (taskType && candidateTaskType && taskType !== candidateTaskType) return 0;
    if (selectionId && selectionId === candidate.selectionId) return 1000;
    if (selectedTask.taskKey && selectedTask.taskKey === candidate.taskKey) return 900;

    let score = 0;

    if (taskType && candidateTaskType === taskType) score += 35;
    if (title && candidate.title === title) score += 70;
    if (handle && candidateHandle && handle === candidateHandle) score += 45;
    else if (handle && text.includes(handle)) score += 25;
    if (bounty > 0 && Math.abs((candidate.bounty || 0) - bounty) < 0.001) score += 35;
    if (selectedText) {
      const chunks = selectedText
        .split(/\s+/)
        .filter((part) => part.length >= 3)
        .slice(0, 8);
      score += chunks.filter((part) => text.includes(part)).length * 6;
    }
    if (selectedTask.isBlocked && candidate.isBlocked) score += 8;
    if (Number(selectedTask.countdownSec) > 0 && candidate.cooldownMs > 0) {
      const delta = Math.abs(candidate.cooldownMs / 1000 - Number(selectedTask.countdownSec));
      if (delta <= 90) score += 12;
    }

    return score;
  }

  async function waitForSelectedTaskTweetTarget(settings, taskTypeHint = "", timeoutOverrideMs = 0) {
    const started = Date.now();
    const requestedTimeoutMs = Number(timeoutOverrideMs || 0);
    const timeoutMs = requestedTimeoutMs > 0
      ? Math.min(Math.max(requestedTimeoutMs, 500), 60000)
      : Math.min(getPageWaitMs(settings), 60000);
    while (Date.now() - started < timeoutMs) {
      if (hasDetailRequestTimeout()) {
        throw new Error("选中任务详情加载失败：Request timeout");
      }
      if (isTaskDetailOpen()) {
        const task = buildTask(settings, taskTypeHint);
        assertSupportedDetailTask(task, settings);
        const target = findOpenTweetTargetButton();
        if (target) {
          target.scrollIntoView({ block: "center", inline: "center" });
          await wait(settings.actionDelayMs || 500);
          await clickElement(target);
          await wait(Math.max(1200, settings.actionDelayMs || 500));
          return {
            ...task,
            awaitingXTabAdoption: true
          };
        }
        if (task.tweetUrl) return task;
      }
      await wait(settings.cooldownPollMs || 500);
    }

    throw new Error("选中任务详情未暴露 X/Twitter 推文链接，且未找到在 X 打开控件");
  }

  async function waitForTaskDetailReady(settings, taskTypeHint = "") {
    const started = Date.now();
    const timeoutMs = Math.min(getPageWaitMs(settings), 60000);
    while (Date.now() - started < timeoutMs) {
      if (hasDetailRequestTimeout()) {
        throw new Error("选中任务详情加载失败：Request timeout");
      }
      if (isTaskDetailOpen()) {
        const task = buildTask(settings, taskTypeHint);
        assertSupportedDetailTask(task, settings);
        return task;
      }
      await wait(settings.cooldownPollMs || 500);
    }
    throw new Error("选中任务详情加载超时");
  }

  function checkLighthouseLockFailure() {
    const text = normalize(document.body?.innerText || "");
    if (!hasHardFailure(text)) return { ok: true, failed: false };
    return {
      ok: true,
      failed: true,
      reason: extractHardFailureReason(text),
      message: `锁定失败：${extractHardFailureReason(text)}`,
      task: buildTask({}, "")
    };
  }

  async function waitSelectedCountdownAndLock(settings, selectedTask = {}) {
    if (!isTaskDetailOpen()) {
      throw new Error("当前未进入任务详情页，无法等待锁定按钮");
    }

    const taskBeforeClick = buildTask(settings, selectedTask.taskType || "");
    assertSupportedDetailTask(taskBeforeClick, settings);
    const started = Date.now();
    const timeoutMs = getPageWaitMs(settings);
    const deadline = started + timeoutMs;
    let lastReason = "";
    let lastWaitReportAt = 0;
    let lastReleaseText = "";

    while (Date.now() < deadline) {
      assertActiveRun(activeRunId);
      if (!isTaskDetailOpen()) {
        throw new Error("等待锁定期间任务详情已关闭");
      }

      const detailRoot = findTaskDetailRoot();
      const detailText = normalize(`${detailRoot?.innerText || ""} ${document.body?.innerText || ""}`);
      if (hasBlockingTaskFailure(detailText, settings)) {
        throw new Error(`任务不可做：${extractHardFailureReason(detailText)}`);
      }

      const lockButton = findLockButton();
      if (lockButton) {
        const hrefBeforeClick = lockButton.href || lockButton.getAttribute("href") || "";
        const candidateUrl = normalizeTweetUrl(hrefBeforeClick || taskBeforeClick.tweetUrl);
        lockButton.scrollIntoView({ block: "center", inline: "center" });
        await wait(Math.max(settings.actionDelayMs || 500, 500));
        await clickElement(lockButton, { randomDelay: false });
        report("info", `已点击锁定席位按钮：${buttonText(lockButton)}，等待按钮状态变化`);
        await confirmLighthouseGuidanceBeforeClaim();
        await verifyLockClickAccepted(settings, lockButton);
        report("info", "锁定席位状态已变化，继续等待平台自动打开 X");
        const afterClickText = normalize(document.body.innerText || "");
        if (hasBlockingTaskFailure(afterClickText, settings)) {
          throw new Error(`锁定点击后失败：${extractHardFailureReason(afterClickText)}`);
        }
        const taskAfterClick = buildTask(settings, selectedTask.taskType || "");
        return {
          ok: true,
          message: `已点击锁定席位：${buttonText(lockButton)}`,
          task: {
            ...taskAfterClick,
            taskKey: taskBeforeClick.taskKey || taskAfterClick.taskKey,
            tweetUrl: normalizeTweetUrl(taskAfterClick.tweetUrl || candidateUrl),
            seatLocked: true,
            seatLockedAt: new Date().toISOString(),
            awaitingXTabAdoption: true
          }
        };
      }

      const releaseCountdown = parseDetailReleaseCountdown(detailText);
      if (releaseCountdown && releaseCountdown.remainingMs > AUTO_DETAIL_MAX_RELEASE_WAIT_MS) {
        throw createDeferredReleaseError(taskBeforeClick, releaseCountdown);
      }
      if (releaseCountdown && releaseCountdown.remainingMs > 5000) {
        if (releaseCountdown.text !== lastReleaseText) {
          lastReleaseText = releaseCountdown.text;
          report("info", `详情页放号倒计时：${formatDuration(releaseCountdown.remainingMs)}，到最后 5 秒再监控锁定按钮`);
        }
        const waitMs = Math.min(releaseCountdown.remainingMs - 5000, 30000);
        await waitWithDetailHealthCheck(waitMs, settings);
        continue;
      }

      if (releaseCountdown) {
        if (releaseCountdown.text !== lastReleaseText) {
          lastReleaseText = releaseCountdown.text;
          report("info", `进入详情页最后 5 秒锁定窗口：${formatDuration(releaseCountdown.remainingMs)}`);
        }
      }

      lastReason = extractDetailUnavailableReason(detailText);
      if (Date.now() - lastWaitReportAt > 2000) {
        lastWaitReportAt = Date.now();
        report("info", `等待锁定席位按钮可用：${lastReason || "按钮暂未出现"}`);
      }
      await wait(Math.min(randomBetween(250, 500), Math.max(250, deadline - Date.now())));
    }

    return {
      ok: false,
      message: `详情页等待锁定按钮超时：${lastReason || "未找到可点击锁定按钮"}`,
      task: taskBeforeClick
    };
  }

  function parseDetailReleaseCountdown(text) {
    const value = normalize(text);
    if (!value) return null;

    const patterns = [
      /等待(?:下一批)?(?:释放|开放)?\s*[·:：-]?\s*(\d{1,2}:\d{2}(?::\d{2})?)/i,
      /(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:下一波|下一批).{0,40}(?:席|释放|开放)/i,
      /(?:下一波|下一批).{0,40}?(\d{1,2}:\d{2}(?::\d{2})?)/i
    ];

    for (const pattern of patterns) {
      const match = value.match(pattern);
      if (!match) continue;
      const remainingMs = parseDurationMs(match[1]);
      if (remainingMs > 0) return { remainingMs, text: match[0] };
    }

    return null;
  }

  function createDeferredReleaseError(task, releaseCountdown) {
    const remainingMs = Math.max(0, Number(releaseCountdown?.remainingMs || 0));
    const rescanInMs = Math.max(250, remainingMs - AUTO_DETAIL_PRELOAD_MS);
    const error = new Error(`详情页下一批放号仍需 ${formatDuration(remainingMs)}，返回广场并在剩余 1 分钟时重新扫描本任务`);
    error.task = {
      ...(task || {}),
      deferUntil: Date.now() + rescanInMs
    };
    return error;
  }

  async function waitWithDetailHealthCheck(timeoutMs, settings) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (hasDetailRequestTimeout()) {
        throw new Error("选中任务详情加载失败：Request timeout");
      }
      if (!isTaskDetailOpen() && !hasRecoverableDetailLoadFailure()) {
        throw new Error("等待倒计时期间任务详情已关闭");
      }
      const text = normalize(document.body.innerText || "");
      if (hasBlockingTaskFailure(text, settings)) {
        throw new Error(`任务不可做：${extractHardFailureReason(text)}`);
      }
      await wait(Math.min(1000, Math.max(250, timeoutMs - (Date.now() - started))));
    }
  }

  function randomBetween(min, max) {
    const low = Math.min(min, max);
    const high = Math.max(min, max);
    return Math.floor(low + Math.random() * (high - low + 1));
  }

  function findOpenTweetTargetButton() {
    const texts = ["去 X 完成动作", "前往 X 完成动作", "在 X 打开", "前往目标", "查看推文", "打开目标", "查看原文", "Open in X", "View on X"];
    const candidates = collectOpenTweetTargetCandidates()
      .filter((entry) => {
        const value = `${entry.text} ${entry.href}`;
        return texts.some((text) => value.includes(text)) || /(?:x|twitter)\.com/i.test(value);
      })
      .sort((a, b) => scoreOpenTweetTarget(b) - scoreOpenTweetTarget(a));
    return candidates[0]?.node || null;
  }

  function collectOpenTweetTargetCandidates() {
    const nodes = new Set();
    document.querySelectorAll("button,a,[role='button'],[aria-label],[title],[tabindex],div,span").forEach((node) => {
      if (!isVisible(node)) return;
      const text = normalize([
        node.innerText,
        node.textContent,
        node.getAttribute?.("aria-label"),
        node.getAttribute?.("title"),
        node.href,
        node.getAttribute?.("href")
      ].filter(Boolean).join(" "));
      if (/去 X 完成动作|前往 X 完成动作|在 X 打开|前往目标|查看推文|打开目标|查看原文|Open in X|View on X|(?:x|twitter)\.com/i.test(text)) {
        nodes.add(resolveClickableFromNode(node));
      }
    });

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = normalize(node.nodeValue || "");
        return /去 X 完成动作|前往 X 完成动作|在 X 打开|前往目标|查看推文|打开目标|查看原文|Open in X|View on X|(?:x|twitter)\.com/i.test(text)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      }
    });
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (parent && isVisible(parent)) nodes.add(resolveClickableFromNode(parent));
    }

    return [...nodes]
      .filter((node) => node && isVisible(node) && !isDisabled(node))
      .map((node) => ({
        node,
        text: buttonText(node),
        href: node.href || node.getAttribute("href") || ""
      }));
  }

  function resolveClickableFromNode(node) {
    if (!node) return null;
    const direct = node.closest?.("a[href],button,[role='button'],[tabindex]");
    if (direct && isVisible(direct)) return direct;
    const rect = node.getBoundingClientRect?.();
    if (rect && rect.width > 0 && rect.height > 0) {
      const points = [
        [rect.left + rect.width / 2, rect.top + rect.height / 2],
        [rect.left + Math.min(rect.width - 1, 8), rect.top + rect.height / 2],
        [rect.right - Math.min(rect.width - 1, 8), rect.top + rect.height / 2]
      ];
      for (const [x, y] of points) {
        const hit = document.elementFromPoint(x, y);
        const clickable = hit?.closest?.("a[href],button,[role='button'],[tabindex]");
        if (clickable && isVisible(clickable)) return clickable;
      }
    }
    return node;
  }

  function scoreOpenTweetTarget(entry) {
    let score = 0;
    if (entry.text.includes("去 X 完成动作")) score += 140;
    if (entry.text.includes("前往 X 完成动作")) score += 140;
    if (entry.text.includes("在 X 打开")) score += 100;
    if (entry.text.includes("前往目标")) score += 80;
    if (entry.text.includes("查看推文")) score += 70;
    if (/x\.com|twitter\.com/i.test(entry.href)) score += 60;
    const context = normalize(entry.node.closest?.("section,article,div")?.innerText || "");
    if (context.includes("TARGET TWEET") || context.includes("目标推文")) score += 30;
    return score;
  }

  async function debugLockSeatAndExtract(settings) {
    report("info", "详情页已加载，检查是否可立即锁定席位");
    await confirmPagePhase(["detail_ready"], settings, "锁定席位前");

    const taskBeforeClick = buildTask(settings);
    if (taskBeforeClick.tweetUrl) {
      chrome.runtime.sendMessage({ type: "DEBUG_TASK_CANDIDATE", runId: activeRunId, task: taskBeforeClick });
    }

    const detailText = normalize(document.body.innerText);
    if (hasBlockingTaskFailure(detailText, settings)) {
      throw new Error(`任务不可做：${extractHardFailureReason(detailText)}`);
    }

    const lockButton = await findLockButtonAfterHydration(settings);
    const hrefBeforeClick = lockButton.href || lockButton.getAttribute("href") || "";
    const candidateUrl = normalizeTweetUrl(hrefBeforeClick || taskBeforeClick.tweetUrl);
    if (candidateUrl) {
      chrome.runtime.sendMessage({
        type: "DEBUG_TASK_CANDIDATE",
        runId: activeRunId,
        task: {
          ...taskBeforeClick,
          tweetUrl: candidateUrl
        }
      });
    }

    lockButton.scrollIntoView({ block: "center", inline: "center" });
    await clickLockButtonWithRetry(settings, lockButton);
    await confirmLighthouseGuidanceBeforeClaim();
    await verifyLockClickAccepted(settings, lockButton);
    await confirmPagePhase(["detail_ready"], settings, "锁定席位后", { timeoutMs: 2500 });

    const afterText = normalize(document.body.innerText);
    if (hasBlockingTaskFailure(afterText, settings)) {
      throw new Error(`锁定失败：${extractHardFailureReason(afterText)}`);
    }

    const taskAfterClick = buildTask(settings);
    const tweetUrl = normalizeTweetUrl(taskAfterClick.tweetUrl || hrefBeforeClick || taskBeforeClick.tweetUrl);

    return {
      ok: true,
      message: tweetUrl
        ? "已锁定席位并提取推文链接"
        : "已点击锁定席位，等待后台接管 Lighthouse 自己打开的 X 推文页",
      task: {
        ...taskAfterClick,
        taskKey: taskBeforeClick.taskKey || taskAfterClick.taskKey,
        tweetUrl,
        seatLocked: true,
        seatLockedAt: new Date().toISOString(),
        awaitingXTabAdoption: !tweetUrl
      }
    };
  }

  async function completeTask(settings) {
    if (!settings.autoSubmitLighthouse) {
      return finish(false, "已回到 Lighthouse，但配置为不自动提交");
    }

    const result = await debugClickDone(settings);
    await finish(result.ok, result.message);
    return result;
  }

  async function debugClickDone(settings) {
    const button = await waitForDoneButton(settings.lockSeatTimeoutMs || 60000, settings);
    const beforeText = normalize(document.body.innerText || "");
    button.scrollIntoView({ block: "center", inline: "center" });
    await wait(settings.actionDelayMs);
    await clickElement(button);
    await verifyDoneClickAccepted(settings, beforeText);
    return { ok: true, message: `已点击：${buttonText(button)}` };
  }

  async function ensureCampaignsPage(settings = {}) {
    const timeoutMs = getPageWaitMs(settings);
    if (!location.pathname.includes("/campaigns")) {
      location.href = "https://app.lhdao.top/campaigns";
      await waitFor(() => location.pathname.includes("/campaigns"), timeoutMs, "等待任务广场加载超时");
    }
    await waitForCampaignsReady(timeoutMs);
  }

  async function ensureAllTaskFilter(settings) {
    const allButton = findClickableByText("全部", true) || findVisibleControlByText("全部", true);
    if (!allButton) {
      report("warn", "未找到全部筛选按钮，继续从当前列表识别评论/点赞互动任务");
      return;
    }
    if (isDisabled(allButton)) {
      report("info", "任务广场已处于全部筛选");
      return;
    }
    allButton.scrollIntoView({ block: "center", inline: "center" });
    await wait(settings.actionDelayMs);
    await clickElement(allButton);
    await verifyAllFilterAccepted(settings);
  }

  async function selectNextCommentTask(settings, attemptedTaskKeys) {
    const runId = activeRunId;
    await waitForCampaignsReady(getPageWaitMs(settings));
    let lastReportAt = 0;
    let overlaySince = 0;
    let overlayReported = false;
    let staleReadyHitCount = 0;
    let lastLowBountyReportAt = 0;
    // Re-read the live plaza countdown frequently so the runner enters a
    // detail as soon as it reaches the one-minute pre-lock window.
    const pollMs = 500;

    while (true) {
      assertActiveRun(runId);
      if (isTaskDetailOrRecoverableOverlayOpen()) {
        if (!overlaySince) overlaySince = Date.now();
        if (Date.now() - overlaySince > getDetailOverlayStaleMs(settings)) {
          throw new Error("任务详情仍在加载，等待超时，返回任务广场重新选择任务");
        }
        if (!overlayReported) {
          overlayReported = true;
          lastReportAt = Date.now();
          report("info", "任务详情加载中，等待完成");
        }
        await wait(pollMs);
        continue;
      }
      overlaySince = 0;
      overlayReported = false;
      const minTaskBounty = await getLiveAutoMinTaskBounty(settings);
      if (minTaskBounty !== lastReportedMinTaskBounty) {
        lastReportedMinTaskBounty = minTaskBounty;
        report("info", `当前全量检测最低赏金：${minTaskBounty.toFixed(3)} LUX`);
      }
      const candidates = collectTaskCandidates(attemptedTaskKeys, settings);
      const lowBountyCandidates = candidates.filter((candidate) => candidate.isAutomatable && isBelowMinTaskBounty(candidate.bounty, minTaskBounty));
      const ignoredNonCommentCandidates = candidates.filter((candidate) => (candidate.isOriginalTweet || candidate.isRetweet) && !candidate.isBlocked);
      if (ignoredNonCommentCandidates.length && Date.now() - lastOriginalSkipReportAt > 15000) {
        lastOriginalSkipReportAt = Date.now();
        report("info", `已忽略原创/转发任务 ${ignoredNonCommentCandidates.length} 条，只等待评论、点赞或关注互动任务`);
      }
      if (lowBountyCandidates.length && Date.now() - lastLowBountyReportAt > 15000) {
        lastLowBountyReportAt = Date.now();
        report("info", `已按赏金阈值过滤 ${lowBountyCandidates.length} 条低于 ${minTaskBounty.toFixed(1)}LUX 的评论、点赞或关注互动任务`);
      }
      const visibleReadyCandidates = candidates
        .filter((candidate) => candidate.isAutomatable && !candidate.isBlocked && candidate.cooldownMs <= AUTO_DETAIL_PRELOAD_MS && candidate.target)
        .map((candidate) => ({
          ...candidate,
          cooldownSniping: candidate.cooldownMs > 0,
          detailPreloadMs: Math.max(0, candidate.cooldownMs || 0)
        }));
      const filteredCandidates = candidates.filter((candidate) => !candidate.isAutomatable || !isBelowMinTaskBounty(candidate.bounty, minTaskBounty));
      const readyCandidates = filteredCandidates
        .filter((candidate) => candidate.isAutomatable && !candidate.isBlocked && candidate.cooldownMs <= AUTO_DETAIL_PRELOAD_MS && candidate.target)
        .map((candidate) => ({
          ...candidate,
          cooldownSniping: candidate.cooldownMs > 0,
          detailPreloadMs: Math.max(0, candidate.cooldownMs || 0)
        }));
      const skippedReadyCount = readyCandidates.filter((candidate) => candidate.attempted).length;
      const ready = readyCandidates
        .filter((candidate) => !candidate.attempted)
        .sort((a, b) => a.cooldownMs - b.cooldownMs || b.bounty - a.bounty)[0];
      if (ready) {
        staleReadyHitCount = 0;
        if (ready.detailPreloadMs > 0) {
          report("info", `任务剩余 ${ready.cooldownText || formatDuration(ready.detailPreloadMs)}，提前进入详情准备锁定`);
        }
        return ready;
      }

      // Reloading the plaza cannot change the in-memory dedupe table, so when
      // every visible ready candidate is merely dedupe-skipped, a refresh
      // request would only burn the reload and then trip its own cooldown.
      const dedupeIsOnlyBlocker = visibleReadyCandidates.length > 0
        && visibleReadyCandidates.every((candidate) => candidate.attempted);
      const shouldRefreshStaleReady = visibleReadyCandidates.length >= STALE_READY_REFRESH_THRESHOLD
        && !ready
        && !dedupeIsOnlyBlocker
        && isCampaignsListOpen();
      if (shouldRefreshStaleReady) {
        staleReadyHitCount += 1;
        if (staleReadyHitCount >= STALE_READY_REFRESH_HITS) {
          const lowBountyReadyCount = visibleReadyCandidates.filter((candidate) => isBelowMinTaskBounty(candidate.bounty, minTaskBounty)).length;
          const dedupedReadyCount = visibleReadyCandidates.filter((candidate) => candidate.attempted).length;
          throw buildCampaignsRefreshRequestError(`任务广场连续 ${staleReadyHitCount} 轮出现 ${visibleReadyCandidates.length} 条可做评论、点赞或关注互动任务，但当前都无法进入自动执行（去重 ${dedupedReadyCount} 条，低赏金 ${lowBountyReadyCount} 条），请求刷新任务广场`);
        }
      } else {
        staleReadyHitCount = 0;
      }

      const cooldownCandidates = filteredCandidates
        .filter((candidate) => candidate.isAutomatable && !candidate.isBlocked
          && Number.isFinite(candidate.cooldownMs) && candidate.cooldownMs > AUTO_DETAIL_PRELOAD_MS && candidate.target)
        .sort((a, b) => a.cooldownMs - b.cooldownMs);

      if (!settings.enableCooldownSniping) {
        throw new Error("当前没有可做评论、点赞或关注互动任务，且未启用任务广场等待");
      }

      const shortest = cooldownCandidates.find((candidate) => !candidate.attempted) || cooldownCandidates[0];
      if (Date.now() - lastReportAt > 15000) {
        lastReportAt = Date.now();
        if (visibleReadyCandidates.length > 0 && !ready) {
          const lowBountyReadyCount = visibleReadyCandidates.filter((candidate) => isBelowMinTaskBounty(candidate.bounty, minTaskBounty)).length;
          const dedupedReadyCount = visibleReadyCandidates.filter((candidate) => candidate.attempted).length;
          report("info", `当前可做评论、点赞或关注互动任务共有 ${visibleReadyCandidates.length} 条，但暂无可执行候选（去重 ${dedupedReadyCount} 条，低赏金 ${lowBountyReadyCount} 条），跳过并等待新任务`);
        } else if (shortest) {
          report("info", `任务广场最近任务仍在冷却：${formatDuration(shortest.cooldownMs)}，到可抢后再打开详情`);
        } else {
          report("info", "任务广场暂无可识别评论、点赞或关注互动任务，继续等待列表刷新");
        }
      }

      await wait(pollMs);
    }
  }

  function collectTaskCandidates(attemptedTaskKeys, settings = {}) {
    if (isTaskDetailOrRecoverableOverlayOpen()) return [];
    const attempted = new Set(attemptedTaskKeys || []);
    const cards = collectExecutableTaskCards();
    const seenCards = new Set();
    const candidates = [];

    for (const card of cards) {
      if (!card || seenCards.has(card)) continue;
      seenCards.add(card);
      const rawText = card.innerText || "";
      const text = normalize(rawText);
      if (!isLikelySingleTaskCard(card)) continue;
      const taskType = detectCandidateTaskType(card, rawText);
      const isOriginalTweet = taskType === "原创推文";
      const isRetweet = taskType === "转发";
      const isComment = isCommentEquivalentTaskType(taskType);
      const isAutomatable = isAutomatableTaskType(taskType);
      const bounty = parseCandidateBounty(text);
      const title = extractCandidateTitle(rawText, taskType);
      const handle = extractHandle(rawText);
      const selectionId = buildSelectionId({ taskType, bounty, title, handle, text });
      const stableTaskKey = buildStableTaskKey({ taskType, bounty, title, handle });
      const taskKey = buildTaskKey(text);
      const cooldown = parseCooldownFromCard(card, rawText);
      const cooldownMs = cooldown.remainingMs;
      const hasCardCooldown = Number.isFinite(cooldownMs) && cooldownMs > 0;
      const isBlocked = Boolean(cooldown.isBlocked) || (!hasCardCooldown && (
        BLOCKED_MARKERS.some((marker) => text.includes(marker))
        || hasHardFailure(text)
        || hasUnsupportedCommentGuidance(text)
      ));
      const detailTarget = findOpenTargetInCard(card);
      candidates.push({
        card,
        target: detailTarget || card,
        text,
        taskKey,
        selectionId,
        stableTaskKey,
        taskType,
        bounty,
        title,
        handle,
        attempted: attempted.has(taskKey) || attempted.has(selectionId) || attempted.has(stableTaskKey),
        isComment,
        isAutomatable,
        isOriginalTweet,
        isRetweet,
        isBlocked,
        cooldownMs,
        cooldownText: cooldown.text
      });
    }

    return candidates;
  }

  function hasBlockingTaskFailure(text, settings = {}) {
    const value = normalize(text);
    const compact = value.replace(/\s+/g, "").replace(/[，,]/g, "，");
    if (compact.includes(TIER_MISMATCH_PHRASE)) return true;
    return hasHardFailure(value);
  }

  function hasUnsupportedCommentGuidance(text) {
    const value = normalize(text);
    const guidance = value.match(/(?:评论引导|买家希望|任务备注|接单备注|接单前)[\s\S]{0,160}/i)?.[0] || "";
    if (!guidance) return false;
    return /(?:不要|禁止|不得|不可)\s*(?:使用)?\s*AI(?:评论|回复)?/i.test(guidance)
      || /(?:要求填写|请填写|评论(?:你的)?|回复(?:你的)?)[\s\S]{0,40}(?:EVM|钱包|收款)地址/i.test(guidance);
  }

  function collectExecutableTaskCards() {
    const cards = [];
    const seen = new Set();
    for (const anchor of findRewardAnchors()) {
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
        const text = normalize(node.nodeValue || "");
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
    for (let depth = 0; current && depth < 9; depth += 1) {
      if (isLikelySingleTaskCard(current)) return current;
      current = current.parentElement;
    }
    return null;
  }

  function isLikelySingleTaskCard(node) {
    if (!isVisible(node)) return false;
    const text = normalize(node.innerText || "");
    if (!text.includes("预计获得") || !/\bLUX\b/i.test(text)) return false;
    if (countMatches(text, "预计获得") !== 1) return false;
    if (!detectCandidateTaskType(node, node.innerText || "")) return false;
    if (!hasTaskCardActionOrState(node, text)) return false;

    const rect = node.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 120) return false;
    if (rect.width > Math.min(window.innerWidth * 0.5, 640)) return false;
    if (rect.height > Math.min(window.innerHeight * 0.75, 620)) return false;
    return true;
  }

  function hasTaskCardActionOrState(card, text) {
    const hasActionText = DETAIL_BUTTON_TEXTS
      .concat(BLOCKED_MARKERS, HARD_FAIL_MARKERS, COOLDOWN_MARKERS)
      .some((marker) => text.includes(marker));
    if (hasActionText) return true;
    return Array.from(card.querySelectorAll?.("button,a,[role='button']") || [])
      .filter(isVisible)
      .some((node) => {
        const value = buttonText(node);
        return DETAIL_BUTTON_TEXTS.some((marker) => value.includes(marker))
          || COMMENT_MARKERS.concat(COMMENT_EQUIVALENT_MARKERS, FOLLOW_MARKERS, ORIGINAL_TWEET_MARKERS, RETWEET_MARKERS).some((marker) => value.includes(marker));
      });
  }

  function countMatches(text, needle) {
    if (!needle) return 0;
    return String(text || "").split(needle).length - 1;
  }

  function isOriginalTweetTaskText(text) {
    const value = normalize(text);
    if (!value) return false;
    return ORIGINAL_TWEET_MARKERS.some((marker) => value.includes(marker));
  }

  function isRetweetTaskText(text) {
    const value = normalize(text);
    if (!value) return false;
    return RETWEET_MARKERS.some((marker) => value.includes(marker));
  }

  function detectCandidateTaskType(card, rawText) {
    return detectScopedTaskType(collectTaskTypeBadgeText(card))
      || detectScopedTaskType(extractCardHeaderText(rawText));
  }

  function detectScopedTaskType(text) {
    const value = normalize(text);
    if (!value) return "";
    if (COMMENT_EQUIVALENT_MARKERS.some((marker) => value.includes(marker))) return "点赞互动";
    if (COMMENT_MARKERS.some((marker) => value.includes(marker))) return "评论";
    if (FOLLOW_MARKERS.some((marker) => value.includes(marker))) return "关注";
    if (isOriginalTweetTaskText(value)) return "原创推文";
    if (isRetweetTaskText(value)) return "转发";
    return "";
  }

  function collectTaskTypeBadgeText(card) {
    const markerText = COMMENT_MARKERS.concat(COMMENT_EQUIVALENT_MARKERS, FOLLOW_MARKERS, ORIGINAL_TWEET_MARKERS, RETWEET_MARKERS);
    return Array.from(card.querySelectorAll?.("button,a,[role='button'],span,p,strong,b,small") || [])
      .filter(isVisible)
      .map((node) => normalize(node.innerText || node.textContent || node.getAttribute("aria-label") || ""))
      .filter((text) => text && text.length <= 32 && markerText.some((marker) => text.includes(marker)))
      .join(" ");
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

  function detectTaskTypeFromText(text) {
    if (isOriginalTweetTaskText(text)) return "原创推文";
    if (isRetweetTaskText(text)) return "转发";
    const value = normalize(text);
    if (COMMENT_EQUIVALENT_MARKERS.some((marker) => value.includes(marker))) return "点赞互动";
    if (COMMENT_MARKERS.some((marker) => value.includes(marker))) return "评论";
    if (FOLLOW_MARKERS.some((marker) => value.includes(marker))) return "关注";
    return "";
  }

  function isCommentEquivalentTaskType(taskType) {
    const value = normalize(taskType);
    return value === "评论" || value === "点赞互动" || value === "点赞";
  }

  function isAutomatableTaskType(taskType) {
    const value = normalize(taskType);
    return isCommentEquivalentTaskType(value) || value === "关注" || value === "Follow";
  }

  function assertSupportedDetailTask(task, settings = {}) {
    const explicitTaskType = normalize(task.taskType || "");
    const detailRoot = findTaskDetailRoot();
    const detailText = normalize(detailRoot?.innerText || "");
    const taskType = explicitTaskType || detectTaskTypeFromText(detailText || task.detailText || "");
    const tierMismatch = detailText.replace(/\s+/g, "").replace(/[，,]/g, "，").includes(TIER_MISMATCH_PHRASE);
    const unsupportedGuidance = hasUnsupportedCommentGuidance(detailText);
    if (!tierMismatch && !unsupportedGuidance && taskType !== "原创推文" && taskType !== "转发") return;
    const reason = tierMismatch
      ? `平台提示：${TIER_MISMATCH_PHRASE}`
      : (unsupportedGuidance ? "任务备注要求人工提供内容" : `已识别为${taskType}任务`);
    const error = new Error(`${reason}，永久忽略不再打开`);
    error.permanentIgnore = true;
    error.ignoredTaskType = tierMismatch ? TIER_MISMATCH_PHRASE : (unsupportedGuidance ? "人工评论要求" : taskType);
    error.task = { ...(task || {}), taskType };
    throw error;
  }

  function findOpenTargetInCard(card) {
    const clickables = Array.from(card.querySelectorAll?.("button,a,[role='button']") || [])
      .filter(isVisible);
    return clickables.find((node) => !isDisabled(node) && DETAIL_BUTTON_TEXTS.some((text) => buttonText(node).includes(text)))
      || clickables.find((node) => !isDisabled(node))
      || clickables[0]
      || card;
  }

  function parseCandidateBounty(text) {
    const value = normalize(text);
    const match = value.match(/预计获得\s*([0-9]+(?:\.[0-9]+)?)\s*LUX/i)
      || value.match(/([0-9]+(?:\.[0-9]+)?)\s*LUX/i);
    return match ? Number(match[1]) : 0;
  }

  function extractCandidateTitle(text, taskType) {
    const lines = String(text || "")
      .split(/\n+/)
      .map((line) => normalize(line))
      .filter((line) => isCandidateTitleLine(line, taskType));
    return (lines[0] || taskType || "任务").slice(0, 80);
  }

  function isCandidateTitleLine(line, taskType) {
    if (!line || line === taskType) return false;
    if (line.length < 2 || line.length > 120) return false;
    if (/活动周期|长期有效|预计获得|LUX|冷却|查看详情|评论留言|已完成|进行中|席位|PROMO|官方/.test(line)) return false;
    if (/^\d+(?:\.\d+)?$/.test(line)) return false;
    return true;
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

  function buildStableTaskKey(info) {
    return [
      "stable",
      info.taskType || "任务",
      Number(info.bounty || 0).toFixed(2),
      normalize(info.handle || "").toLowerCase(),
      normalize(info.title || "").slice(0, 80)
    ].join("|");
  }

  function extractHandle(text) {
    const match = String(text || "").match(/@[A-Za-z0-9_]{1,20}/);
    return match ? match[0] : "";
  }

  async function openTaskDetailOrFail(selection, settings) {
    const runId = activeRunId;
    const targets = getOpenTargetsInCard(selection.card, selection.target);
    if (!targets.length) throw new Error("未找到任务卡片入口");

    let lastError = "";
    for (const target of targets) {
      assertActiveRun(runId);
      try {
        await tryOpenTaskDetailTarget(target, settings);
        report("info", "已打开选中任务详情，开始查找在 X 打开/前往目标控件");
        return;
      } catch (error) {
        lastError = error.message || String(error);
        if (isTaskDetailOpen()) {
          report("info", "已打开选中任务详情，开始查找在 X 打开/前往目标控件");
          return;
        }
        if (isRecoverableDetailLoadError(lastError)) throw error;
        report("warn", `任务入口未打开详情，尝试下一个入口：${formatShortLog(lastError, 120)}`);
      }
    }

    throw new Error(lastError || "任务详情页加载超时，返回任务广场重新选择任务");
  }

  async function tryOpenTaskDetailTarget(target, settings) {
    const runId = activeRunId;
    const beforeUrl = location.href;
    target.scrollIntoView({ block: "center", inline: "center" });
    await wait(settings.actionDelayMs);

    const timeoutMs = getTaskDetailLoadTimeoutMs(settings);
    const started = Date.now();
    let detailNavigationStarted = false;
    let lastClickAt = 0;
    let clickCount = 0;
    const maxClickAttempts = 3;
    let lastReportAt = 0;
    let loadingReported = false;
    while (Date.now() - started < timeoutMs) {
      assertActiveRun(runId);
      if (hasTaskUnavailableError()) {
        throw new Error("任务暂时无法打开，已跳过本条任务");
      }
      if (isTaskDetailOpen()) return true;
      if (hasDetailRequestTimeout()) {
        throw new Error("详情页加载失败：Request timeout，返回任务广场重新选择任务");
      }

      if (!detailNavigationStarted && hasEnteredDetailLoadingFlow(beforeUrl)) {
        detailNavigationStarted = true;
        if (!loadingReported) {
          loadingReported = true;
          report("info", "任务入口点击已生效，等待任务详情加载完成");
        }
      }

      if (!detailNavigationStarted && clickCount < maxClickAttempts && isCampaignsListOpen() && Date.now() - lastClickAt >= getTaskEntryRetryWaitMs(settings)) {
        clickCount += 1;
        lastClickAt = Date.now();
        await clickElement(target);
        report("info", `已点击任务入口，第 ${clickCount} 次，等待点击后复核`);
        await wait(250);
        continue;
      }

      if (!detailNavigationStarted && clickCount > 0 && Date.now() - lastClickAt >= getNoOpClickWaitMs(settings) && location.href === beforeUrl && isCampaignsListOpen()) {
        if (clickCount >= maxClickAttempts) {
          throw new Error(`任务入口点击未生效，仍停留在任务广场，已重试 ${clickCount} 次：${formatShortLog(buttonText(target) || "未知入口", 80)}`);
        }
        await wait(getTaskEntryRetryWaitMs(settings));
        continue;
      }

      if (detailNavigationStarted && isCampaignsListOpen() && !hasActiveDetailLoadingOrOverlay()) {
        throw new Error("任务详情加载中断，已回到任务广场，返回任务广场重新选择任务");
      }

      if (!detailNavigationStarted && Date.now() - lastReportAt > 5000) {
        lastReportAt = Date.now();
        report("info", `已点击任务入口，仍在复核入口点击是否生效，已等待 ${formatDuration(Date.now() - started)}`);
      }
      await wait(settings.cooldownPollMs || 500);
    }

    throw new Error("任务详情页加载超时，返回任务广场重新选择任务");
  }

  function hasDetailRequestTimeout() {
    const text = normalize(document.body?.innerText || "");
    return text.includes("详情加载失败") || /request\s*timeout/i.test(text);
  }

  function hasPageLoadingState() {
    // Whole-body text scans match tweet excerpts (e.g. "a refreshing break")
    // and fake a perpetual loading state. Only trust short standalone status
    // labels plus real busy/skeleton nodes.
    const loadingText = Array.from(document.querySelectorAll("div,span,p,button"))
      .some((node) => {
        const own = normalize(node.innerText || node.textContent || "");
        return own.length > 0
          && own.length <= 12
          && /^(?:加载中|刷新中|请求中|请稍候|loading|refreshing)[\s….!！]{0,3}$/i.test(own);
      });
    const busyNode = document.querySelector('[aria-busy="true"], [role="progressbar"], .loading, .spinner, [class*="loading"], [class*="Loading"], [class*="spinner"], [class*="skeleton"], [class*="Skeleton"]');
    return Boolean(loadingText || (busyNode && isVisible(busyNode)));
  }

  function hasEnteredDetailLoadingFlow(beforeUrl) {
    if (location.href !== beforeUrl) return true;
    if (isTaskDetailOpen()) return true;
    if (hasRecoverableDetailLoadFailure()) return true;
    if (hasActiveDetailLoadingOrOverlay()) return true;
    if (isCampaignsListOpen()) return false;
    if (hasTaskDetailOverlayShell()) return true;
    if (isBlankOrSparsePage()) return true;
    if (hasPageLoadingState()) return true;
    return !isCampaignsListOpen();
  }

  function isBlankOrSparsePage() {
    const text = normalize(document.body?.innerText || "");
    const visibleTaskNodes = collectVisibleTaskLikeNodes();
    return text.length < 80 || visibleTaskNodes.length === 0;
  }

  function getNoOpClickWaitMs(settings = {}) {
    return Math.min(Math.max((settings.actionDelayMs || 500) * 3, 1500), 3000);
  }

  function getTaskEntryRetryWaitMs(settings = {}) {
    return Math.min(Math.max((settings.actionDelayMs || 500) * 2, 1000), 2000);
  }

  function isTransientLoadError(text) {
    const value = normalize(text);
    return value.includes("加载超时")
      || value.includes("等待超时")
      || value.includes("状态确认失败")
      || value.includes("详情加载中断")
      || value.includes("返回任务广场重新选择任务")
      || value.includes("Request timeout")
      || value.includes("详情加载失败")
      || value.includes("任务详情页加载超时")
      || value.includes("等待任务广场加载超时");
  }

  function isRecoverableDetailLoadError(text) {
    const value = normalize(text);
    return value.includes("详情页加载超时")
      || value.includes("详情加载失败")
      || value.includes("详情仍在加载")
      || value.includes("详情加载中断")
      || value.includes("返回任务广场重新选择任务")
      || value.includes("Request timeout")
      || value.includes("Failed to fetch")
      || value.includes("页面已进入详情加载流程");
  }

  function getOpenTargetsInCard(card, preferredTarget) {
    const clickables = Array.from(card?.querySelectorAll?.("button,a,[role='button']") || [])
      .filter((node) => isVisible(node) && !isDisabled(node));
    const preferred = preferredTarget ? [preferredTarget] : [];
    const detailTargets = clickables.filter((node) => DETAIL_BUTTON_TEXTS.some((text) => buttonText(node).includes(text)));
    const targets = [...detailTargets, ...preferred, ...clickables, card].filter(Boolean);
    return Array.from(new Set(targets)).filter(isVisible);
  }

  function isTaskDetailOpen() {
    const text = normalize(document.body?.innerText || "");
    if (!text) return false;
    const hasDetailMarker = DETAIL_MARKERS.some((marker) => text.includes(marker));
    const hasTaskMarker = DETAIL_TASK_MARKERS.some((marker) => text.includes(marker));
    const hasDetailShell = hasTaskDetailOverlayShell() || Boolean(findTaskDetailCloseButton() && hasCampaignsBackdrop());
    return hasDetailMarker && (hasTaskMarker || hasDetailShell);
  }

  function isTaskDetailOrRecoverableOverlayOpen() {
    if (isTaskDetailOpen()) return true;
    if (hasDetailRequestTimeout()) return true;
    if (hasRecoverableDetailLoadFailure()) return true;
    if (hasTaskDetailLoadingModal()) return true;
    if (hasTaskDetailOverlayShell() && hasPageLoadingState()) return true;
    return Boolean(findTaskDetailCloseButton() && hasCampaignsBackdrop());
  }

  function hasRecoverableDetailLoadFailure() {
    const text = normalize(document.body?.innerText || "");
    return text.includes("详情加载失败")
      || text.includes("Failed to fetch")
      || text.includes("Request timeout")
      || text.includes("id:")
      || TASK_UNAVAILABLE_MARKERS.some((marker) => text.includes(marker));
  }

  function hasTaskUnavailableError() {
    const text = normalize(document.body?.innerText || "");
    return TASK_UNAVAILABLE_MARKERS.some((marker) => text.includes(marker));
  }

  function hasTaskDetailOverlayShell() {
    return Boolean(findTaskDetailCloseButton() && hasCampaignsBackdrop());
  }

  function hasActiveDetailLoadingOrOverlay() {
    // A bare "close-like button + loading text" pair used to be enough here.
    // On the live plaza that pairs a 14x14 header icon (aria 接单额度说明)
    // with tweet words like "refreshing", blocking every task-entry click.
    // Loading must now ride on a real modal or overlay shell.
    return hasTaskDetailLoadingModal()
      || hasTaskDetailOverlayShell();
  }

  function hasTaskDetailLoadingModal() {
    if (!location.pathname.includes("/campaigns")) return false;
    if (!hasPageLoadingState()) return false;
    // Tweet text plus a top-right header icon is not a modal; require a real
    // overlay before treating a loading label as the detail loading modal.
    if (!document.querySelector('[role="dialog"]') && !hasCampaignsBackdrop()) return false;
    const closeButton = findTaskDetailCloseButton();
    if (!closeButton) return false;
    const rect = closeButton.getBoundingClientRect();
    return rect.top >= 0
      && rect.top < Math.max(100, window.innerHeight * 0.16)
      && rect.left > window.innerWidth * 0.45;
  }

  function hasCampaignsBackdrop() {
    const text = normalize(document.body?.innerText || "");
    if (!location.pathname.includes("/campaigns")) return false;
    if (!(text.includes("任务广场") || text.includes("Task Hall") || text.includes("LUX"))) return false;
    return Array.from(document.querySelectorAll("body *"))
      .filter(isVisible)
      .some((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        const fixedLike = style.position === "fixed" || style.position === "sticky";
        const largePanel = rect.width > window.innerWidth * 0.45 && rect.height > window.innerHeight * 0.45;
        const centered = rect.left > window.innerWidth * 0.08 && rect.right < window.innerWidth * 0.98;
        const highLayer = Number(style.zIndex || 0) >= 10;
        return fixedLike && largePanel && centered && (highLayer || rect.top < window.innerHeight * 0.15);
      });
  }

  function isCampaignsListOpen() {
    const text = normalize(document.body?.innerText || "");
    return location.pathname.includes("/campaigns")
      && text.includes("任务广场")
      && !hasOfficialCompletionEvidence()
      && !isTaskDetailOrRecoverableOverlayOpen()
      && collectVisibleTaskLikeNodes().length > 0
      && !isTaskDetailOpen();
  }

  async function closeTaskDetailPanel(settings = {}) {
    const completionReturnButton = findCompletionReturnToCampaignsButton();
    if (completionReturnButton) {
      completionReturnButton.scrollIntoView({ block: "center", inline: "center" });
      await wait(settings.actionDelayMs || 500);
      await clickElement(completionReturnButton);
      if (await waitForCampaignsReturnAfterCompletion(settings)) {
        return { ok: true, message: "任务已完成，已点击打开任务广场并确认列表已恢复" };
      }
    }

    const unavailableReturnButton = findUnavailableReturnToCampaignsButton();
    if (unavailableReturnButton) {
      unavailableReturnButton.scrollIntoView({ block: "center", inline: "center" });
      await wait(settings.actionDelayMs || 500);
      await clickElement(unavailableReturnButton);
      if (await waitForTaskPanelClosed(settings, "任务不可打开提示的返回任务广场按钮")) {
        return { ok: true, message: "任务详情无法打开，已返回任务广场" };
      }
    }

    if (!isTaskDetailOrRecoverableOverlayOpen()) {
      return { ok: true, message: "未检测到任务详情弹层，保持当前页面继续" };
    }

    const closeButton = findTaskDetailCloseButton();
    if (closeButton) {
      closeButton.scrollIntoView({ block: "center", inline: "center" });
      await wait(settings.actionDelayMs || 500);
      await clickElement(closeButton);
      if (await waitForTaskPanelClosed(settings, "右上角关闭按钮")) {
        return { ok: true, message: "已通过右上角关闭任务详情" };
      }
    }

    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      keyCode: 27,
      which: 27,
      bubbles: true,
      cancelable: true
    }));
    if (await waitForTaskPanelClosed(settings, "Esc")) {
      return { ok: true, message: "已通过 Esc 关闭任务详情" };
    }

    await clickTaskPanelOutside();
    if (await waitForTaskPanelClosed(settings, "左侧空白区域")) {
      return { ok: true, message: "已通过点击左侧空白区域关闭任务详情" };
    }

    return { ok: false, message: "任务详情关闭复核失败，仍停留在详情页" };
  }

  function beginCompletionWatch(message) {
    if (!message.runId || !message.task?.taskKey) return { ok: false, message: "缺少完成监测的订单身份" };
    if (completionContext?.runId === message.runId && completionContext.taskKey === message.task.taskKey) return { ok: true };
    const baselineRoots = findOfficialCompletionRoots();
    completionContext = {
      runId: message.runId,
      taskKey: message.task.taskKey,
      tweetUrl: normalizeTweetUrl(message.task.tweetUrl || ""),
      baseline: new Map(baselineRoots.map((node) => [node, getOfficialCompletionRootFingerprint(node)])),
      evidence: null
    };
    return { ok: true };
  }

  function checkOfficialCompletion(message) {
    const context = completionContext;
    if (!context || context.runId !== message.runId || context.taskKey !== message.task?.taskKey) return { ok: true, completed: false };
    if (context.evidence) return { ok: true, completed: true, evidence: context.evidence };
    const root = findOfficialCompletionRoots().find((node) => {
      if (!context.baseline.has(node)) return true;
      return context.baseline.get(node) !== getOfficialCompletionRootFingerprint(node);
    });
    if (!root) return { ok: true, completed: false };
    const target = normalizeTweetUrl(message.task?.tweetUrl || context.tweetUrl);
    const rootText = normalize(root.innerText || "");
    const links = Array.from(root.querySelectorAll("a[href]"))
      .map((node) => normalizeTweetUrl(node.href))
      .filter(Boolean);
    // The paid-result overlay also contains unrelated recommended campaigns.
    // Only use X links as an identity check when the result panel has no
    // recommendation section; the completion watch itself is already scoped
    // to the current run and task and rejects pre-existing result panels.
    const hasRecommendedCampaigns = /继续搞钱|类似任务|推荐任务|查看全部/.test(rootText);
    if (!hasRecommendedCampaigns && links.length && (!target || !links.includes(target))) {
      return { ok: true, completed: false };
    }
    context.evidence = { runId: context.runId, taskKey: context.taskKey, tweetUrl: target, observedAt: Date.now(), text: normalize(root.innerText || "").slice(0, 500) };
    return { ok: true, completed: true, evidence: context.evidence };
  }

  async function waitForTaskCompletionAndReturn(settings = {}, message = {}) {
    const started = Date.now();
    const timeoutMs = Math.max(60000, Number(settings.lockSeatTimeoutMs || 0));
    while (Date.now() - started < timeoutMs) {
      assertActiveRun(message.runId || activeRunId);
      const completion = checkOfficialCompletion(message);
      const completionConfirmed = completion.completed;
      const completionReturnButton = findCompletionReturnToCampaignsButton();
      if (completionConfirmed && completionReturnButton) {
        completionReturnButton.scrollIntoView({ block: "center", inline: "center" });
        await clickElement(completionReturnButton);
        if (await waitForCampaignsReturnAfterCompletion(settings)) {
          return { ok: true, evidence: completion.evidence, message: "Lighthouse 已显示已完成，已点击打开任务广场" };
        }
        return {
          ok: false,
          completed: true,
          evidence: completion.evidence,
          message: "官网已确认任务完成；已点击打开任务广场，但列表尚未恢复"
        };
      }
      if (completionConfirmed && isCampaignsListOpen()) {
        return { ok: true, evidence: completion.evidence, message: "Lighthouse 已确认完成并回到任务广场" };
      }
      await wait(250);
    }
    return { ok: false, timedOut: true, message: "等待 Lighthouse 显示已完成超时，已保留 X 页面" };
  }

  // Read-only fallback for the rare case where the official completion
  // overlay never renders: the plaza's own paid-income header still moves.
  function readPlazaTodayIncome() {
    const text = normalize(document.body?.innerText || "");
    const match = text.match(/今日任务收入\s*\+?([0-9]+(?:\.[0-9]+)?)\s*LUX/i);
    if (!match) return { ok: false, message: "任务广场未显示今日任务收入" };
    const income = Number(match[1]);
    if (!Number.isFinite(income)) return { ok: false, message: "今日任务收入无法解析" };
    return { ok: true, income };
  }

  function findCompletionReturnToCampaignsButton() {
    if (!hasOfficialCompletionEvidence()) return null;

    const labels = /打开任务广场|返回任务广场|回到任务广场|Open Task Hall/i;
    const entries = Array.from(document.querySelectorAll("button,a,[role='button'],[tabindex],div,span"))
      .filter((node) => isVisible(node))
      .map((node) => ({
        node: node.closest?.("button,a,[role='button'],[tabindex]") || node,
        text: normalize(buttonText(node))
      }))
      .filter((entry) => entry.text && entry.text.length <= 40 && labels.test(entry.text))
      .filter((entry) => isVisible(entry.node) && !isDisabled(entry.node));

    return entries
      .sort((a, b) => {
        const aExact = /打开任务广场/.test(a.text) ? 1 : 0;
        const bExact = /打开任务广场/.test(b.text) ? 1 : 0;
        return bExact - aExact;
      })[0]?.node || null;
  }

  function hasOfficialCompletionEvidence() {
    const completionRoot = findOfficialCompletionRoot();
    const text = normalize(completionRoot?.innerText || "");
    return /任务验证通过|验证成功|奖励已到账|已到账奖励|任务已完成|奖励已结算/.test(text);
  }

  function findOfficialCompletionRoot() {
    return findOfficialCompletionRoots()[0] || null;
  }

  function getOfficialCompletionRootFingerprint(node) {
    return normalize(node?.innerText || node?.textContent || "");
  }

  function isOfficialCompletionMarkerText(text) {
    const value = normalize(text);
    if (!value || value.length > 80) return false;
    return /^(?:任务验证通过|验证(?:成功|通过)(?:\s*[·•]\s*(?:已通过|奖励已到账))?|奖励已到账|已到账奖励|任务已完成|奖励已结算)[！!。.]?$/.test(value);
  }

  function hasOfficialCompletionRewardText(text) {
    const value = normalize(text);
    return /(?:^|\s)\+?\d+(?:\.\d+)?\s*LUX(?:\s|$)/i.test(value)
      || /已入账至钱包|入账/.test(value)
      || /已到账奖励|奖励已到账|奖励已结算/.test(value);
  }

  function findOfficialCompletionRoots() {
    const candidates = Array.from(document.querySelectorAll("[role='dialog'],main,section,article,div"))
      .filter(isVisible)
      .map((node) => ({ node, text: normalize(node.innerText || node.textContent || ""), rect: node.getBoundingClientRect() }))
      .filter((entry) => entry.text.length < 5000 && [entry.node, ...Array.from(entry.node.querySelectorAll("h1,h2,h3,p,span,div"))]
        .some((node) => isVisible(node) && isOfficialCompletionMarkerText(node.innerText || node.textContent || "")))
      .filter((entry) => hasOfficialCompletionRewardText(entry.text))
      .filter((entry) => entry.rect.width > 240 && entry.rect.height > 120)
      .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));
    // Prefer the actual result panel, never its page-wide ancestors.
    return candidates.filter((entry) => !candidates.some((other) => other.node !== entry.node && entry.node.contains(other.node))).map((entry) => entry.node);
  }

  function findUnavailableReturnToCampaignsButton() {
    if (!hasTaskUnavailableError()) return null;
    const labels = /返回任务广场|打开任务广场|回到任务广场|Open Task Hall/i;
    return Array.from(document.querySelectorAll("button,a,[role='button']"))
      .filter((node) => isVisible(node) && !isDisabled(node))
      .find((node) => labels.test(buttonText(node))) || null;
  }

  async function waitForCampaignsReturnAfterCompletion(settings = {}) {
    const started = Date.now();
    const timeoutMs = Math.min(Math.max((settings.actionDelayMs || 500) * 8, 4000), 10000);
    while (Date.now() - started < timeoutMs) {
      if (isCampaignsListOpen()) return true;
      await wait(250);
    }
    report("warn", "点击打开任务广场后未确认列表恢复");
    return false;
  }

  function findTaskDetailCloseButton() {
    const selector = "button,[role='button'],a";
    const candidates = Array.from(document.querySelectorAll(selector))
      .filter((node) => isVisible(node) && !isDisabled(node))
      .map((node) => ({ node, text: buttonText(node), rect: node.getBoundingClientRect() }))
      .filter((entry) => {
        const aria = normalize(entry.node.getAttribute("aria-label") || "");
        const value = `${entry.text} ${aria}`;
        const looksClose = value.includes("关闭") || value.includes("Close") || value === "×" || value === "x" || value === "X";
        // Controls scrolled out above the viewport (negative top) are gone,
        // not "near the top" — the plaza header icon failed exactly this way.
        const nearTopRight = entry.rect.top >= 0
          && entry.rect.top < Math.max(120, window.innerHeight * 0.18)
          && entry.rect.left > window.innerWidth * 0.45;
        return looksClose || (nearTopRight && entry.rect.width <= 60 && entry.rect.height <= 60);
      })
      .sort((a, b) => (b.rect.left - a.rect.left) || (a.rect.top - b.rect.top));
    return candidates[0]?.node || null;
  }

  async function waitForTaskPanelClosed(settings, actionName) {
    const started = Date.now();
    const timeoutMs = Math.min(Math.max((settings.actionDelayMs || 500) * 4, 2000), 5000);
    while (Date.now() - started < timeoutMs) {
      if (!isTaskDetailOrRecoverableOverlayOpen() && isCampaignsListOpen()) return true;
      await wait(250);
    }
    report("warn", `${actionName} 后仍未确认任务详情关闭`);
    return false;
  }

  async function clickTaskPanelOutside() {
    const x = Math.max(24, Math.floor(window.innerWidth * 0.12));
    const y = Math.max(120, Math.floor(window.innerHeight * 0.5));
    const target = document.elementFromPoint(x, y) || document.body;
    await randomClickDelay();
    for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
      target.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        view: window
      }));
    }
  }

  async function verifyDoneClickAccepted(settings, beforeText) {
    const runId = activeRunId;
    const started = Date.now();
    const timeoutMs = Math.min(Math.max(settings.actionDelayMs * 5, 5000), 12000);
    while (Date.now() - started < timeoutMs) {
      assertActiveRun(runId);
      const currentText = normalize(document.body.innerText || "");
      if (currentText !== beforeText && /审核|验证|提交|完成|成功|已提交|奖励|Timeline|进度/i.test(currentText)) return true;
      if (isCampaignsListOpen()) return true;
      await wait(500);
    }
    throw new Error("点击我已评论/提交验证后未观察到页面状态变化，判定提交点击未生效");
  }

  async function verifyAllFilterAccepted(settings) {
    const runId = activeRunId;
    const started = Date.now();
    const timeoutMs = Math.min(Math.max(settings.actionDelayMs * 2, 1500), 4000);
    while (Date.now() - started < timeoutMs) {
      assertActiveRun(runId);
      if (isCampaignsListOpen()) return true;
      await wait(250);
    }
    report("warn", "全部筛选点击后未观察到明确列表状态，继续按当前列表识别评论任务");
    return false;
  }

  async function findLockButtonAfterHydration(settings) {
    const runId = activeRunId;
    const started = Date.now();
    const timeoutMs = getPageWaitMs(settings);
    const pollMs = Math.min(Math.max(settings.cooldownPollMs || 500, 250), 500);
    let lastReportAt = 0;
    let lastReleaseText = "";
    while (Date.now() - started < timeoutMs) {
      assertActiveRun(runId);
      if (!isTaskDetailOpen()) {
        throw new Error("等待锁定期间任务详情已关闭");
      }

      const detailRoot = findTaskDetailRoot();
      const detailText = normalize(detailRoot?.innerText || document.body.innerText || "");
      if (hasHardFailure(detailText)) {
        throw new Error(extractHardFailureReason(detailText));
      }

      const lockButton = findLockButton();
      if (lockButton) {
        report("info", `检测到可点击锁定席位按钮：${buttonText(lockButton)}，立即执行`);
        return lockButton;
      }

      const releaseCountdown = parseDetailReleaseCountdown(detailText);
      const waitingForRelease = /等待(?:下一批)?(?:释放|开放)|下一波|下一批/.test(detailText);
      const urgentWindow = waitingForRelease && (!releaseCountdown || releaseCountdown.remainingMs <= 2000);
      if (releaseCountdown && releaseCountdown.remainingMs > AUTO_DETAIL_MAX_RELEASE_WAIT_MS) {
        throw createDeferredReleaseError(buildTask(settings), releaseCountdown);
      }
      if (releaseCountdown && releaseCountdown.remainingMs > 5000) {
        if (releaseCountdown.text !== lastReleaseText) {
          lastReleaseText = releaseCountdown.text;
          report("info", `详情页放号倒计时：${formatDuration(releaseCountdown.remainingMs)}，到最后 5 秒再监控锁定按钮`);
        }
        await waitWithDetailHealthCheck(Math.min(releaseCountdown.remainingMs - 5000, 30000), settings);
        continue;
      }

      if (releaseCountdown && releaseCountdown.text !== lastReleaseText) {
        lastReleaseText = releaseCountdown.text;
        report("info", `进入详情页最后 5 秒锁定窗口：${formatDuration(releaseCountdown.remainingMs)}`);
      }
      if (!urgentWindow && Date.now() - lastReportAt > 1500) {
        lastReportAt = Date.now();
        report("info", `等待锁定席位按钮可用：${extractDetailUnavailableReason(detailText)}`);
      }
      await wait(urgentWindow ? 50 : pollMs);
    }
    throw new Error(`任务详情等待锁定按钮超时：${extractDetailUnavailableReason(normalize(document.body.innerText || ""))}`);
  }

  async function clickLockButtonWithRetry(settings, lockButton) {
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (!isVisible(lockButton) || isDisabled(lockButton)) return;
      await clickElement(lockButton, { randomDelay: false });
      await confirmLighthouseGuidanceBeforeClaim();
      const started = Date.now();
      while (Date.now() - started < 250) {
        if (hasLockClickStateChanged(lockButton)) return;
        await wait(50);
      }
      if (hasLockClickStateChanged(lockButton)) return;
      if (attempt + 1 < maxAttempts) await wait(50);
    }
  }

  function hasLockClickStateChanged(lockButton) {
    if (!lockButton.isConnected || isDisabled(lockButton) || !isVisible(lockButton)) return true;
    const text = normalize(document.body.innerText || "");
    return Boolean(extractTweetUrl() || /已锁定|已领取|进行中|前往目标|在 X 打开|请先前往目标/.test(text));
  }

  async function verifyLockClickAccepted(settings, clickedButton) {
    const runId = activeRunId;
    const started = Date.now();
    const timeoutMs = Math.min(Math.max(settings.actionDelayMs * 4, 4000), 8000);
    while (Date.now() - started < timeoutMs) {
      assertActiveRun(runId);
      await confirmLighthouseGuidanceBeforeClaim();
      const text = normalize(document.body.innerText || "");
      if (hasHardFailure(text)) throw new Error(`锁定点击后失败：${extractHardFailureReason(text)}`);
      if (extractTweetUrl()) return true;
      if (!clickedButton.isConnected || isDisabled(clickedButton) || !isVisible(clickedButton)) return true;
      if (/已锁定|已领取|进行中|前往目标|在 X 打开|请先前往目标/.test(text)) return true;
      await wait(300);
    }
    throw new Error("锁定点击后未观察到按钮状态变化或推文链接，判定点击未生效");
  }

  async function confirmLighthouseGuidanceBeforeClaim() {
    const buttons = Array.from(document.querySelectorAll("button,a,[role='button']"))
      .filter((node) => isVisible(node) && !isDisabled(node))
      .filter((node) => normalize(buttonText(node)) === "确认接单");

    for (const button of buttons) {
      let scope = button;
      let guidanceText = "";
      for (let depth = 0; scope && depth < 8; depth += 1) {
        if (scope === document.body || scope === document.documentElement) break;
        const text = normalize(scope.innerText || scope.textContent || "");
        if (/接单前|评论引导|买家希望|任务备注|接单备注/.test(text)) {
          guidanceText = text;
          break;
        }
        scope = scope.parentElement;
      }
      if (!guidanceText) continue;

      if (hasUnsupportedCommentGuidance(guidanceText)) {
        const task = buildTask({}, "评论");
        const error = new Error("任务备注要求人工提供内容，永久忽略不再打开");
        error.permanentIgnore = true;
        error.ignoredTaskType = "人工评论要求";
        error.task = task;
        throw error;
      }

      await clickElement(button, { randomDelay: false });
      report("info", "检测到 Lighthouse 接单备注引导，已点击确认接单");
      await wait(150);
      return true;
    }
    return false;
  }

  function extractDetailUnavailableReason(text) {
    if (hasHardFailure(text)) return extractHardFailureReason(text);
    if (hasCooldownState(text)) return "详情页仍在等待席位释放";
    const disabledLockText = Array.from(document.querySelectorAll("button,a,[role='button']"))
      .map((node) => buttonText(node))
      .find((value) => LOCK_BUTTON_TEXTS.some((marker) => value.includes(marker)));
    if (disabledLockText) return `锁定按钮不可点击：${disabledLockText}`;
    return "未找到可点击锁定席位按钮";
  }

  function findLockButton() {
    for (const text of LOCK_BUTTON_TEXTS) {
      const node = findClickableByText(text);
      if (node) return node;
    }
    return null;
  }

  async function waitForCampaignsReady(timeoutMs) {
    const runId = activeRunId;
    const started = Date.now();
    let lastReportAt = 0;
    while (Date.now() - started < timeoutMs) {
      assertActiveRun(runId);
      const text = document.body?.innerText || "";
      const hasCampaignShell = location.pathname.includes("/campaigns");
      const hasTaskList = COMMENT_MARKERS.concat(COMMENT_EQUIVALENT_MARKERS).some((marker) => text.includes(marker)) || text.includes("任务广场") || text.includes("Task Hall");
      const hasCards = collectVisibleTaskLikeNodes().length > 0;
      if (hasCampaignShell && hasTaskList && hasCards) return true;
      if (Date.now() - lastReportAt > 5000) {
        lastReportAt = Date.now();
        report("info", `任务广场仍在加载，继续等待，已等待 ${formatDuration(Date.now() - started)}`);
      }
      await wait(500);
    }
    throw new Error("等待任务广场加载超时");
  }

  function collectVisibleTaskLikeNodes() {
    return collectExecutableTaskCards();
  }

  function buildTask(settings, taskTypeHint = "") {
    const detailRoot = findTaskDetailRoot() || document.body;
    const detailText = normalize(detailRoot.innerText || document.body.innerText).slice(0, 1800);
    const normalizedTaskTypeHint = normalize(taskTypeHint);
    return {
      source: "lighthouse",
      title: extractTitle(detailRoot),
      tweetUrl: extractTweetUrl(detailRoot),
      taskType: normalizedTaskTypeHint || detectTaskTypeFromText(detailText) || "评论",
      taskKey: buildTaskKey(detailText),
      detailText,
      createdAt: new Date().toISOString()
    };
  }

  function findTaskDetailRoot() {
    const closeButton = findTaskDetailCloseButton();
    if (closeButton) {
      let current = closeButton;
      for (let depth = 0; current && depth < 10; depth += 1) {
        const text = normalize(current.innerText || current.textContent || "");
        if (text && text.includes("LUX") && DETAIL_MARKERS.some((marker) => text.includes(marker))) {
          return current;
        }
        current = current.parentElement;
      }
    }

    const candidates = Array.from(document.querySelectorAll("[role='dialog'],section,article,div"))
      .filter(isVisible)
      .map((node) => ({ node, text: normalize(node.innerText || node.textContent || ""), rect: node.getBoundingClientRect() }))
      .filter((entry) => entry.text.includes("LUX") && DETAIL_MARKERS.some((marker) => entry.text.includes(marker)))
      .filter((entry) => entry.rect.width > 240 && entry.rect.height > 180)
      .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));
    return candidates[0]?.node || null;
  }

  function extractTweetUrl(root = document) {
    const anchorUrl = Array.from(root.querySelectorAll?.("a[href]") || [])
      .map((anchor) => anchor.href)
      .find((href) => /https:\/\/(x|twitter)\.com\/[^/]+\/status\/\d+/i.test(href));
    if (anchorUrl) return normalizeTweetUrl(anchorUrl);

    const textUrl = normalize(root.innerText || root.textContent || "").match(/https:\/\/(?:x|twitter)\.com\/[A-Za-z0-9_]+\/status\/\d+/i);
    return textUrl ? normalizeTweetUrl(textUrl[0]) : "";
  }

  function normalizeTweetUrl(url) {
    const value = String(url || "");
    const match = value.match(/https:\/\/(?:x|twitter)\.com\/[A-Za-z0-9_]+\/status\/\d+/i);
    return match ? match[0].replace("twitter.com", "x.com") : "";
  }

  function extractTitle(root = document) {
    const heading = Array.from(root.querySelectorAll?.("h1,h2,h3,[role='heading']") || [])
      .map((node) => normalize(node.innerText))
      .find(Boolean);
    return heading || "Lighthouse 评论任务";
  }

  function findClickableByText(text, exact) {
    return findAllClickableByText(text, exact)[0] || null;
  }

  function findVisibleControlByText(text, exact) {
    const selector = "button,a,[role='button'],input[type='button'],input[type='submit']";
    return Array.from(document.querySelectorAll(selector)).find((node) => {
      const nodeText = buttonText(node);
      const textMatches = exact ? nodeText === text : nodeText.includes(text);
      return textMatches && isVisible(node);
    }) || null;
  }

  function findAllClickableByText(text, exact) {
    const selector = "button,a,[role='button'],input[type='button'],input[type='submit']";
    return Array.from(document.querySelectorAll(selector)).filter((node) => {
      const nodeText = buttonText(node);
      const textMatches = exact ? nodeText === text : nodeText.includes(text);
      return textMatches && isVisible(node) && !isDisabled(node);
    });
  }

  function waitForClickableByTexts(texts, timeoutMs) {
    return waitFor(() => {
      for (const text of texts) {
        const node = findClickableByText(text);
        if (node) return node;
      }
      return null;
    }, timeoutMs, `等待可点击控件超时：${texts.join("/")}`);
  }

  async function waitForDoneButton(timeoutMs, settings) {
    const runId = activeRunId;
    const started = Date.now();
    const pollMs = settings.cooldownPollMs || 500;
    let lastReportAt = 0;
    while (Date.now() - started < timeoutMs) {
      assertActiveRun(runId);
      const node = findBestDoneButton();
      if (node) return node;
      if (Date.now() - lastReportAt > 5000) {
        lastReportAt = Date.now();
        report("info", `仍在定位我已评论/提交验证按钮，已等待 ${formatDuration(Date.now() - started)}`);
      }
      await wait(pollMs);
    }
    throw new Error(`等待完成提交控件超时：${DONE_BUTTON_TEXTS.join("/")}`);
  }

  function findBestDoneButton() {
    const selector = "button,a,[role='button'],input[type='button'],input[type='submit']";
    const candidates = Array.from(document.querySelectorAll(selector))
      .filter((node) => isVisible(node) && !isDisabled(node))
      .map((node) => ({ node, score: scoreDoneButton(node) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);
    return candidates[0]?.node || null;
  }

  function scoreDoneButton(node) {
    const text = buttonText(node);
    const aria = normalize(node.getAttribute("aria-label") || "");
    const value = `${text} ${aria}`;
    let score = 0;
    if (value.includes("我已评论")) score += 100;
    if (value.includes("提交验证")) score += 95;
    if (value.includes("提交") && value.includes("验证")) score += 90;
    if (value.includes("我已完成")) score += 85;
    if (value.includes("完成任务")) score += 75;
    if (value.includes("验证任务")) score += 70;
    if (value.includes("领取奖励")) score += 45;
    if (!score && DONE_BUTTON_TEXTS.some((matcher) => value.includes(matcher))) score += 40;

    const context = normalize(node.closest?.("section,article,aside,div")?.innerText || "");
    if (context.includes("Timeline") || context.includes("进度") || context.includes("验证") || context.includes("奖励明细")) score += 20;
    if (context.includes("TARGET TWEET") || context.includes("目标推文")) score -= 20;
    if (context.includes("前往目标") || context.includes("在 X 打开")) score -= 15;
    return score;
  }

  function closestTaskCard(node) {
    let current = node;
    for (let depth = 0; current && depth < 7; depth += 1) {
      const text = normalize(current.innerText || "");
      if (text.includes("预计获得") || text.includes("活动周期") || text.includes("LUX")) {
        return current;
      }
      current = current.parentElement;
    }
    return node.closest?.("article,li,section,[class*='card'],[class*='Card']") || node.parentElement;
  }

  function buttonText(node) {
    return normalize(node.innerText || node.value || node.getAttribute("aria-label") || "");
  }

  function formatShortLog(text, limit = 120) {
    const value = normalize(text);
    return value.length > limit ? `${value.slice(0, limit)}...` : value;
  }

  function isDisabled(node) {
    return node.disabled || node.getAttribute("aria-disabled") === "true" || node.classList.contains("disabled");
  }

  function isVisible(node) {
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function hasHardFailure(text) {
    return HARD_FAIL_MARKERS.some((marker) => text.includes(marker));
  }

  function extractHardFailureReason(text) {
    return HARD_FAIL_MARKERS.find((marker) => text.includes(marker)) || "任务不可做";
  }

  function parseCooldownFromCard(card, fallbackText) {
    const monitorParser = globalThis.__lighthouseHighBountyMonitor__?.parseStatusFromCard;
    if (typeof monitorParser === "function") {
      try {
        const status = monitorParser(card);
        if (status?.isCooling) {
          const countdownSec = Math.max(0, Number(status.countdownSec) || 0);
          return {
            remainingMs: countdownSec > 0 ? countdownSec * 1000 : Number.POSITIVE_INFINITY,
            text: status.countdown || status.rawText || "冷却中",
            source: "monitor"
          };
        }
        if (status?.isBlocked) {
          return { remainingMs: 0, text: status.rawText || "不可接", source: "monitor", isBlocked: true };
        }
        if (status?.isReady) {
          return { remainingMs: 0, text: status.rawText || "可做", source: "monitor", isReady: true };
        }
      } catch (_) {}
    }

    const labels = Array.from(card?.querySelectorAll?.("*") || [])
      .filter(isVisible)
      .map((node) => ({
        node,
        text: normalize(node.innerText || node.textContent || "")
      }))
      .filter((entry) => isOwnedByTaskCard(entry.node, card))
      .filter((entry) => entry.text.length <= 48 && hasCooldownState(entry.text) && parseDurationMs(entry.text) > 0)
      .sort((a, b) => {
        const ar = a.node.getBoundingClientRect();
        const br = b.node.getBoundingClientRect();
        return (br.top - ar.top) || a.text.length - b.text.length;
      });

    for (const entry of labels) {
      const remainingMs = parseCooldownMs(entry.text);
      if (remainingMs > 0) return { remainingMs, text: entry.text, source: "card_local" };
    }

    const fallbackValue = normalize(fallbackText || "");
    const fallbackMs = fallbackValue.length <= 80 ? parseCooldownMs(fallbackValue) : 0;
    return {
      remainingMs: fallbackMs || (hasCooldownState(fallbackText || "") ? Number.POSITIVE_INFINITY : 0),
      text: fallbackMs ? fallbackValue : "",
      source: fallbackMs ? "short_fallback" : "unknown"
    };
  }

  function isOwnedByTaskCard(node, card) {
    let current = node;
    for (let depth = 0; current && depth < 10; depth += 1) {
      if (current === card) return true;
      if (current !== node && isLikelySingleTaskCard(current)) return false;
      current = current.parentElement;
    }
    return false;
  }

  function parseCooldownMs(text) {
    const value = normalize(text);
    if (!hasCooldownState(value)) return 0;
    const markerMatch = /冷却|等待|后可/.exec(value);
    if (!markerMatch) return 0;
    const markerIndex = markerMatch.index;
    const afterMarker = value.slice(markerIndex, markerIndex + 80);
    const afterMs = parseDurationMs(afterMarker);
    if (afterMs > 0) return afterMs;
    if (markerMatch[0] !== "后可") return 0;
    return parseDurationMs(value.slice(Math.max(0, markerIndex - 24), markerIndex));
  }

  function hasCooldownState(text) {
    const value = normalize(text);
    return COOLDOWN_MARKERS.some((marker) => value.includes(marker));
  }

  function parseDurationMs(text) {
    const value = String(text || "");
    const colon = value.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (colon) {
      const parts = colon.slice(1).filter(Boolean).map(Number);
      if (parts.length === 3) return ((parts[0] * 3600) + (parts[1] * 60) + parts[2]) * 1000;
      return ((parts[0] * 60) + parts[1]) * 1000;
    }

    let total = 0;
    const hour = value.match(/(\d+)\s*(?:h(?![A-Za-z])|hr|hour|小时|时)/);
    const minute = value.match(/(\d+)\s*(?:min|m(?![A-Za-z])|分钟|分)/);
    const second = value.match(/(\d+)\s*(?:sec|s(?![A-Za-z])|秒)/);
    if (hour) total += Number(hour[1]) * 3600000;
    if (minute) total += Number(minute[1]) * 60000;
    if (second) total += Number(second[1]) * 1000;
    return total;
  }

  function formatDuration(ms) {
    const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
  }

  function getPageWaitMs(settings = {}) {
    return Math.max(settings.maxCooldownWaitMs || 0, settings.lockSeatTimeoutMs || 0, 180000);
  }

  function getTaskDetailLoadTimeoutMs(settings = {}) {
    return Math.min(getPageWaitMs(settings), Math.max(settings.taskDetailLoadTimeoutMs || 0, 60000));
  }

  function getAutoMinTaskBounty(settings = {}) {
    const parsed = Number(settings.autoMinTaskBounty);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0.1;
  }

  function isBelowMinTaskBounty(bounty, minimum) {
    return Number(bounty || 0) + 0.000001 < Number(minimum || 0);
  }

  async function getLiveAutoMinTaskBounty(fallbackSettings = {}) {
    try {
      const stored = await chrome.storage.local.get(["settings"]);
      return getAutoMinTaskBounty({
        ...(fallbackSettings || {}),
        ...(stored?.settings || {})
      });
    } catch (_) {
      return getAutoMinTaskBounty(fallbackSettings);
    }
  }

  function buildCampaignsRefreshRequestError(message) {
    const error = new Error(message || "任务广场可做列表疑似陈旧，请求刷新任务广场");
    error.transient = true;
    error.refreshRequested = true;
    return error;
  }

  function getDetailOverlayStaleMs(settings = {}) {
    return Math.min(getTaskDetailLoadTimeoutMs(settings), Math.max(settings.detailOverlayStaleMs || 0, 30000));
  }

  function buildTaskKey(text) {
    return normalize(text).slice(0, 220);
  }

  async function clickElement(node, options = {}) {
    if (options.randomDelay !== false) {
      await randomClickDelay();
    }
    try {
      node.click();
      return;
    } catch (_) {}
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  }

  function randomClickDelay() {
    return wait(500 + Math.floor(Math.random() * 1001));
  }

  async function finish(ok, message) {
    const result = { ok, message };
    chrome.runtime.sendMessage({ type: "LIGHTHOUSE_TASK_DONE", runId: activeRunId, result });
    return result;
  }

  async function confirmPagePhase(allowedPhases, settings = {}, label = "步骤", options = {}) {
    const runId = activeRunId;
    const allowed = new Set(allowedPhases || []);
    const started = Date.now();
    const timeoutMs = options.timeoutMs || Math.min(Math.max((settings.actionDelayMs || 500) * 4, 2500), 8000);
    let lastSnapshot = null;

    while (Date.now() - started < timeoutMs) {
      assertActiveRun(runId);
      const snapshot = getLighthousePageSnapshot();
      lastSnapshot = snapshot;
      if (allowed.has(snapshot.phase)) {
        report("info", `${label}状态确认：${describePagePhase(snapshot.phase)}`);
        return snapshot;
      }
      if (snapshot.phase === "detail_error") {
        throw new Error(`${label}状态确认失败：详情页报错`);
      }
      await wait(Math.min(Math.max(settings.cooldownPollMs || 500, 250), 500));
    }

    const current = lastSnapshot?.phase || "unknown";
    throw new Error(`${label}状态确认失败：当前是${describePagePhase(current)}`);
  }

  function describePagePhase(phase) {
    const labels = {
      campaigns: "任务广场",
      campaigns_loading: "任务广场加载中",
      detail_loading: "任务详情加载中",
      detail_ready: "任务详情页",
      detail_error: "任务详情报错",
      unknown: "未知页面",
      snapshot_error: "页面快照失败"
    };
    return labels[phase] || phase || "未知页面";
  }

  function report(level, text) {
    sendRuntimeMessage({
      type: "CONTENT_LOG",
      level,
      text,
      runId: activeRunId,
      page: getLighthousePageSnapshot()
    });
  }

  function sendRuntimeMessage(message) {
    try {
      if (!chrome?.runtime?.sendMessage) return;
      const request = chrome.runtime.sendMessage(message);
      request?.catch?.(() => {});
    } catch (_) {
      // The page can outlive an extension reload; stale content scripts must
      // not throw while trying to report after their runtime context is gone.
    }
  }

  function getLighthousePageSnapshot() {
    try {
      const text = normalize(document.body?.innerText || "");
      let phase = "unknown";
      if (hasDetailRequestTimeout() || hasRecoverableDetailLoadFailure()) {
        phase = "detail_error";
      } else if (isTaskDetailOpen()) {
        phase = "detail_ready";
      } else if (hasTaskDetailLoadingModal() || (hasTaskDetailOverlayShell() && hasPageLoadingState())) {
        phase = "detail_loading";
      } else if (isCampaignsListOpen()) {
        phase = "campaigns";
      } else if (location.pathname.includes("/campaigns") && hasPageLoadingState()) {
        phase = "campaigns_loading";
      }
      return {
        phase,
        path: location.pathname,
        url: location.href,
        hasClose: Boolean(findTaskDetailCloseButton()),
        textLength: text.length
      };
    } catch (error) {
      return {
        phase: "snapshot_error",
        path: location.pathname,
        url: location.href,
        error: error.message || String(error)
      };
    }
  }

  function assertActiveRun(runId) {
    if (runId && (cancelledRunIds.has(runId) || activeRunId !== runId)) {
      throw new Error("运行已停止，旧流程已取消");
    }
  }

  function normalize(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function wait(ms) {
    const runId = activeRunId;
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        try {
          assertActiveRun(runId);
        } catch (error) {
          reject(error);
          return;
        }
        if (Date.now() - started >= ms) {
          resolve();
          return;
        }
        setTimeout(tick, Math.min(250, Math.max(25, ms - (Date.now() - started))));
      };
      tick();
    });
  }

  function waitFor(predicate, timeoutMs, timeoutMessage) {
    const started = Date.now();
    const runId = activeRunId;
    return new Promise((resolve, reject) => {
      const tick = () => {
        try {
          assertActiveRun(runId);
        } catch (error) {
          reject(error);
          return;
        }
        const value = predicate();
        if (value) {
          resolve(value);
          return;
        }
        if (Date.now() - started > timeoutMs) {
          reject(new Error(timeoutMessage || "等待页面状态超时"));
          return;
        }
        setTimeout(tick, 250);
      };
      tick();
    });
  }
})();
