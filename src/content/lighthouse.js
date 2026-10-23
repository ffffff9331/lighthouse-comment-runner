(function () {
  const SINGLETON_KEY = "__lighthouseCommentTaskRunnerLighthouseSingleton__";
  const SCRIPT_VERSION = "0.7.123";
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
  const INVITATION_MARKERS = ["邀请接单", "邀请任务", "接单邀请", "受邀任务", "邀请单", "被邀请", "专属任务邀请"];
  const INVITATION_ACCEPT_BUTTON_TEXTS = ["接受邀请", "确认邀请", "同意接单", "接受接单", "立即接单", "接受并开始"];
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
    "AI 内容审核",
    "邀请接单"
  ];
  const DETAIL_TASK_MARKERS = ["评论任务", "Comment", "评论留言", "点赞互动", "点赞", "Like", "关注", "Follow", "完成后回来点击", "Twitter API", "原创推文", "原创建推文", "原创内容", "发推", "转发", "转推", "Repost", "Retweet", "邀请接单", "邀请任务", "接单邀请", "受邀任务", "邀请单", "被邀请"];
  const ELIGIBILITY_BLOCK_MARKERS = ["档位不符", "需灯塔严选资格", "当前等级不可", "额度不足", "暂不可接单"];
  const BLOCKED_MARKERS = ["进行中", "已完成", "已提交", ...ELIGIBILITY_BLOCK_MARKERS];
  const HARD_FAIL_MARKERS = ["席位已满或无法锁定", "席位已满", "位置已满", "名额已满", "任务已满", "已抢完", "不可领取", "不能参与", "无法参与", "无法锁定", "已结束", "任务失败"];
  const ACCOUNT_RISK_REVIEW_MARKERS = ["账户风险中", "等待审核", "风险审核"];
  const TASK_UNAVAILABLE_MARKERS = ["任务暂时无法打开", "请返回任务广场后重试"];
  const COOLDOWN_MARKERS = ["冷却中", "冷却", "等待", "后可"];
  const AUTO_DETAIL_PRELOAD_MS = 60000;
  const AUTO_DETAIL_MAX_RELEASE_WAIT_MS = 60000;
  const CAMPAIGNS_IDLE_REFRESH_MS = 5 * 60 * 1000;
  const STALE_READY_REFRESH_THRESHOLD = 3;
  const STALE_READY_REFRESH_HITS = 2;
  let activeRunId = "";
  const cancelledRunIds = new Set();
  let claimOperation = null;
  const settledClaimOperations = new Map();
  const lockedTaskNotices = new Map();
  let completionContext = null;
  let lastOriginalSkipReportAt = 0;
  let lastReportedMinTaskBounty = null;
  let automationPaused = false;
  let automationPauseEpoch = 0;
  let automationPauseReady = null;

  function applyAutomationPause(paused) {
    automationPauseEpoch += 1;
    automationPaused = Boolean(paused);
    globalThis[SINGLETON_KEY].paused = automationPaused;
    if (!automationPaused) return;
    if (activeRunId) cancelledRunIds.add(activeRunId);
    if (claimOperation?.runId) cancelledRunIds.add(claimOperation.runId);
    // Explicit STOP abandons this local slot. The old operation retains its
    // cancelled run identity, and its finally only releases its own slot.
    claimOperation = null;
    activeRunId = "";
    completionContext = null;
    settledClaimOperations.clear();
    lockedTaskNotices.clear();
    lastOriginalSkipReportAt = 0;
    lastReportedMinTaskBounty = null;
  }

  async function loadAutomationPause() {
    const epoch = automationPauseEpoch;
    try {
      const status = await chrome.runtime.sendMessage({ type: "GET_CONTENT_SETTINGS" });
      if (epoch === automationPauseEpoch && status?.ok) applyAutomationPause(status.paused === true);
    } catch (_) {}
  }

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
    if (message.type === "CHECK_LIGHTHOUSE_RUNNER_READY") {
      sendResponse({ ok: message.platform === "lighthouse", version: SCRIPT_VERSION,
        instanceId: INSTANCE_ID, url: location.href, paused: automationPaused });
      return true;
    }
    // Order reconciliation is observational. It must also work after the run
    // was cancelled or the worker restarted, without reviving that run.
    if (message.type === "CHECK_LIGHTHOUSE_ORDER_OUTCOME") {
      const outcome = message.platform === "lighthouse" ? readBoundOrderOutcome(message.task) : { outcome: "unknown" };
      sendResponse({ ok: message.platform === "lighthouse", ...outcome,
        runId: message.runId, claimIntentId: message.claimIntentId });
      return true;
    }
    if (message.type === "CHECK_LIGHTHOUSE_RECOVERY_STATE") {
      const counters = Array.from(document.querySelectorAll("button[data-tab='ongoing']"));
      const counter = counters.length === 1 ? counters[0] : null;
      const countText = counter && isVisible(counter) ? normalize(counter.innerText || "") : "";
      const count = hasLoadedCampaignListShell() ? countText.match(/^进行中\s*(\d+)$/) : null;
      const outcome = readBoundOrderOutcome(message.task);
      const execution = findExecutionDialog();
      const detail = findTaskDetailRoot();
      // The plaza count can lag behind a successful lock. A detail receipt or
      // an in-flight lock must protect the order even without a known target.
      const protectedDetail = detail && (hasPositiveClaimState(normalize(detail.innerText || ""), detail)
        || Array.from(detail.querySelectorAll("button,[role='button']")).some(node =>
          isVisible(node) && isDisabled(node) && /正在(?:预定|锁定)席位/.test(buttonText(node))));
      const listedCount = count ? Number(count[1]) : null;
      const orders = readRecoveryEscrowOrders(counter, listedCount);
      sendResponse({ ok: message.platform === "lighthouse" && location.pathname === "/campaigns",
        ...outcome, runId: message.runId, recoveryId: message.recoveryId, instanceId: INSTANCE_ID,
        listedCount: orders.listedCount ?? listedCount,
        activeCount: orders.pendingOnly ? 0 : orders.listedCount ?? listedCount,
        ongoingReady: orders.ready,
        executionPresent: execution.present || Boolean(protectedDetail),
        invitationPending: !["absent", "expired"].includes(getStandaloneInvitationState()) });
      return true;
    }
    if (message.type === "OPEN_LIGHTHOUSE_RECOVERY_ORDERS") {
      const buttons = Array.from(document.querySelectorAll("button[data-tab='ongoing']")).filter(isVisible);
      const allowed = message.platform === "lighthouse" && location.pathname === "/campaigns"
        && message.runId && message.recoveryId === message.runId && message.instanceId === INSTANCE_ID
        && !automationPaused && !findTaskDetailRoot() && !findExecutionDialog().present
        && ["absent", "expired"].includes(getStandaloneInvitationState())
        && buttons.length === 1;
      if (allowed && !buttons[0].classList.contains("on")) buttons[0].click();
      sendResponse({ ok: Boolean(allowed), runId: message.runId, recoveryId: message.recoveryId, instanceId: INSTANCE_ID });
      return true;
    }
    if (message.type === "CHECK_LIGHTHOUSE_INVITATION") {
      const invitationState = message.platform === "lighthouse" ? getStandaloneInvitationState() : "absent";
      const pending = !["absent", "expired"].includes(invitationState);
      sendResponse({ ok: message.platform === "lighthouse",
        pending, invitationPending: pending, invitationState });
      return true;
    }
    if (message.type === "AUTOMATION_PAUSE_CHANGED") {
      applyAutomationPause(message.paused);
      sendResponse({ ok: true, paused: automationPaused });
      return true;
    }
    if (message.type === "CANCEL_LIGHTHOUSE_RUN") {
      if (message.paused === true) applyAutomationPause(true);
      // Mark the run cancelled before yielding, then wait only for its own
      // operation's terminal receipt. An acknowledgement alone proves nothing.
      cancelRun(message).then((result) => { if (isCurrentInstance()) sendResponse(result); });
      return true;
    }
    if (message.type === "CHECK_LIGHTHOUSE_CAMPAIGNS_READY") {
      sendResponse({ ok: message.platform === "lighthouse", url: location.href,
        ready: message.platform === "lighthouse" && !automationPaused && isCampaignsListOpen() });
      return true;
    }
    if (automationPaused) {
      sendResponse({ ok: false, cancelled: true, paused: true });
      return true;
    }

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
      CHECK_LIGHTHOUSE_LOCK_FAILURE: () => checkLighthouseLockFailure(message),
      CHECK_LIGHTHOUSE_EXECUTION_STATE: () => readExecutionState(message),
      SUBMIT_LIGHTHOUSE_EXECUTION_VERIFICATION: () => performExecutionAction(message, "verify"),
      CONFIRM_LIGHTHOUSE_LOCKED_TASK_NOTICE: () => confirmLockedTaskNotice(message),
      BEGIN_LIGHTHOUSE_COMPLETION_WATCH: () => beginCompletionWatch(message),
      CHECK_LIGHTHOUSE_OFFICIAL_COMPLETION: () => checkOfficialCompletion(message),
      DEBUG_LOCK_SEAT_AND_EXTRACT: () => debugLockSeatAndExtract(message.settings,
        message.task?.source === "lighthouse_invitation" ? message.task : null),
      DEBUG_CLICK_I_DONE: () => debugClickDone(message.settings),
      WAIT_LIGHTHOUSE_COMPLETION_RETURN: () => waitForTaskCompletionAndReturn(message.settings, message),
      READ_LIGHTHOUSE_TODAY_INCOME: () => readPlazaTodayIncome(),
      CLOSE_LIGHTHOUSE_TASK_DETAIL: () => closeTaskDetailPanel(message.settings, message)
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
      key: JSON.stringify([message.runId, message.type, message.selectedTask || null]),
      runId: message.runId,
      type: message.type,
      claimIntentId: message.claimIntentId || "",
      checkpointRequired: message.claimCheckpointRequired === true,
      boundTask: message.task || message.selectedTask || null,
      claimActionAttempted: false
    } : null;
    if (operation) claimOperation = operation;
    const resultPromise = Promise.resolve().then(async () => {
      if (automationPauseReady) await automationPauseReady;
      assertActiveRun(message.runId || activeRunId);
      if (operation) assertActiveRun(operation.runId);
      if (operation?.checkpointRequired) await writeClaimCheckpoint(operation, "ready");
      return handler();
    })
      .then((result) => {
        if (automationPaused || (message.runId && message.runId !== activeRunId)) {
          return { ok: false, cancelled: true, ...(operation ? { claimActionAttempted: operation.claimActionAttempted } : {}) };
        }
        if (!operation) return result;
        const { detailConfirmed, ...receipt } = result || {};
        if (receipt.ok === true && receipt.task?.seatLocked === true) {
          operation.navigationBinding = createLockedNavigationBinding(receipt.task);
        }
        if (receipt.ok === true && operation.claimActionAttempted && receipt.task?.seatLocked
            && receipt.task.taskKey && receipt.task.seatLockedAt) {
          const root = findTaskDetailRoot();
          const text = normalize(root?.innerText || "");
          operation.lockObservation = {
            root,
            taskKey: receipt.task.taskKey,
            seatLockedAt: receipt.task.seatLockedAt,
            detailSignature: claimDetailSignature(root),
            rejectionAbsent: !hasHardFailure(text),
            positiveStateAbsent: !hasPositiveClaimState(text, root) && !lockConfirmationEvidence(root).length
          };
        }
        if (detailConfirmed === true && receipt.ok === true && receipt.task?.taskKey
            && ["DEBUG_OPEN_FIRST_COMMENT_TASK", "OPEN_SELECTED_COUNTDOWN_TASK_DETAIL", "OPEN_SELECTED_COUNTDOWN_TASK_TWEET"].includes(operation.type)) {
          // This confirms the requested detail transition, not a locked seat.
          // Bind it here so a handler cannot reuse another operation's receipt.
          receipt.detailConfirmation = {
            runId: operation.runId,
            type: operation.type,
            claimIntentId: operation.claimIntentId,
            taskKey: receipt.task.taskKey,
            phase: "detail_ready",
            invitationResolved: true
          };
        }
        return { ...receipt, claimActionAttempted: operation.claimActionAttempted };
      })
      .catch((error) => {
        if (automationPaused || (message.runId && message.runId !== activeRunId)) return { ok: false, cancelled: true, ...(operation ? { claimActionAttempted: operation.claimActionAttempted } : {}) };
        const messageText = error.message || String(error);
        const transient = Boolean(error.transient) || isTransientLoadError(messageText) || hasDetailRequestTimeout();
        const deferredRelease = Boolean(error.deferredRelease);
        const safeDeferredRelease = deferredRelease && operation?.claimActionAttempted === false;
        const task = error.task || buildTask(message.settings);
        if (isCurrentInstance()) report(error.permanentIgnore ? "warn" : (transient || safeDeferredRelease ? "info" : "error"), messageText);
        return {
          ok: false,
          message: messageText,
          transient,
          deferredRelease,
          refreshRequested: Boolean(error.refreshRequested),
          permanentIgnore: Boolean(error.permanentIgnore),
          ignoredTaskType: error.ignoredTaskType || "",
          ...(operation ? { claimActionAttempted: operation.claimActionAttempted } : {}),
          ...(error.confirmedClaimRejection && operation?.claimActionAttempted && task?.taskKey ? {
            claimRejection: { runId: operation.runId, type: operation.type,
              claimIntentId: operation.claimIntentId, taskKey: task.taskKey },
            retryAfterMs: error.retryAfterMs || 0,
            claimRetryScope: error.claimRetryScope || "global"
          } : {}),
          task
        };
      });
    // Duplicates must receive the same structured receipt, including whether
    // a claim action happened and when an unclaimed task may be rescanned.
    if (operation) {
      operation.promise = resultPromise.then((result) => {
        operation.result = result;
        operation.settled = true;
        const proofKey = JSON.stringify([operation.runId, operation.type, operation.claimIntentId]);
        if (!automationPaused && !cancelledRunIds.has(operation.runId)) settledClaimOperations.set(proofKey, operation);
        if (settledClaimOperations.size > 40) settledClaimOperations.delete(settledClaimOperations.keys().next().value);
        return result;
      }).finally(() => { if (claimOperation === operation) claimOperation = null; });
    }
    (operation?.promise || resultPromise).then((result) => {
      if (isCurrentInstance()) sendResponse(result);
    });
    return true;
  });

  function isCurrentInstance() {
    const singleton = globalThis[SINGLETON_KEY];
    return Boolean(singleton?.active && singleton.version === SCRIPT_VERSION && singleton.instanceId === INSTANCE_ID);
  }

  async function cancelRun(message) {
    if (message.runId) cancelledRunIds.add(message.runId);
    if (!message.runId || !activeRunId || message.runId === activeRunId) {
      activeRunId = `cancelled-${Date.now()}`;
    }
    const matches = (operation) => operation && operation.runId === message.runId
      && operation.type === message.expectedOperationType
      && operation.claimIntentId === (message.claimIntentId || "");
    const proofKey = JSON.stringify([message.runId, message.expectedOperationType, message.claimIntentId || ""]);
    const operation = matches(claimOperation) ? claimOperation : settledClaimOperations.get(proofKey);
    if (!matches(operation)) return { ok: true, cancelled: true, cancellationProof: null };
    if (!operation.settled) {
      let timer;
      try {
        await Promise.race([
          operation.promise.catch(() => {}),
          new Promise((resolve) => { timer = setTimeout(resolve, 2000); })
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    if (!operation.settled) return { ok: true, cancelled: true, timedOut: true, cancellationProof: null };
    const result = operation.result || {};
    return { ok: true, cancelled: true, cancellationProof: {
      runId: operation.runId,
      type: operation.type,
      claimIntentId: operation.claimIntentId,
      settled: true,
      claimActionAttempted: operation.claimActionAttempted,
      claimed: Boolean(result.claimed || result.task?.claimed || result.task?.seatLocked || result.task?.seatLockedAt)
    } };
  }

  async function runCommentTask(settings, message = {}) {
    const runId = activeRunId;
    const openResult = await debugOpenFirstCommentTask(settings, message);
    assertActiveRun(runId);
    let lockResult;
    try {
      lockResult = await debugLockSeatAndExtract(settings,
        openResult.task?.source === "lighthouse_invitation" ? openResult.task : null);
    } catch (error) {
      // Detail text and its taskKey can change with the countdown. Preserve
      // the selected list identity so deferred retries exclude the same card.
      error.task = mergeSelectedTaskIdentity(openResult.task, error.task || buildTask(settings));
      throw error;
    }
    const task = mergeSelectedTaskIdentity(openResult.task, lockResult.task);
    return { ok: true, message: lockResult.message, task, openResult };
  }

  function mergeSelectedTaskIdentity(selectedTask = {}, detailTask = {}) {
    return {
      ...detailTask,
      taskType: mergeTaskTypes(selectedTask?.taskType, detailTask?.taskType) || "评论",
      taskKey: selectedTask?.taskKey || detailTask?.taskKey,
      selectionId: selectedTask?.selectionId || detailTask?.selectionId,
      stableTaskKey: selectedTask?.stableTaskKey || detailTask?.stableTaskKey,
      bounty: selectedTask?.bounty || detailTask?.bounty,
      handle: selectedTask?.handle || detailTask?.handle,
      candidateTitle: selectedTask?.candidateTitle || detailTask?.candidateTitle
    };
  }

  async function debugOpenFirstCommentTask(settings, message = {}) {
    const runId = activeRunId;
    report("info", "准备打开评论、点赞或转发任务");
    let invitation = findStandaloneInvitation();
    if (invitation) return await openStandaloneInvitation(settings, invitation)
      || debugOpenFirstCommentTask(settings, message);
    await ensureCampaignsPage(settings);
    assertActiveRun(runId);
    await confirmPagePhase(["campaigns"], settings, "打开评论任务前", { allowInvitation: true });
    assertActiveRun(runId);
    invitation = findStandaloneInvitation();
    if (invitation) return await openStandaloneInvitation(settings, invitation)
      || debugOpenFirstCommentTask(settings, message);
    await ensureAllTaskFilter(settings);
    assertActiveRun(runId);
    await confirmPagePhase(["campaigns"], settings, "全部筛选后", { allowInvitation: true });

    const selection = await selectNextCommentTask(settings, message.attemptedTaskKeys || [], message.attemptedTaskRecords || []);
    assertActiveRun(runId);
    if (selection?.invitation) return await openStandaloneInvitation(settings, selection.invitation)
      || debugOpenFirstCommentTask(settings, message);
    if (!selection || !selection.target) {
      throw new Error("未找到可执行或可等待的评论、点赞或转发任务");
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
      await acceptInvitationIfPresent(settings);
      await confirmPagePhase(["detail_ready"], settings, "打开任务详情后", { requireInvitationResolved: true });
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
      taskType: mergeTaskTypes(selection.taskType, detectedDetailTask.taskType),
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
      taskType: detailTask.taskType,
      bounty: selection.bounty,
      handle: selection.handle,
      candidateTitle: selection.title,
      listText: selection.text.slice(0, 500),
      cooldownMs: selection.cooldownMs || 0,
      cooldownSniping: selection.cooldownSniping || false
    });
    sendRuntimeMessage({ type: "DEBUG_TASK_CANDIDATE", runId: activeRunId, task });

    return {
      ok: true,
      detailConfirmed: true,
      message: selection.cooldownSniping
        ? "已在任务广场等待到可执行评论、点赞或转发任务并打开详情"
        : "已打开第一个可执行评论、点赞或转发任务详情",
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
    await acceptInvitationIfPresent(settings);
    await confirmPagePhase(["detail_ready"], settings, "打开选中详情后", { requireInvitationResolved: true });

    const detailTask = await waitForSelectedTaskTweetTarget(settings, mergeTaskTypes(selectedTask.taskType, selection.taskType));
    return {
      ok: true,
      detailConfirmed: true,
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
    await acceptInvitationIfPresent(settings);
    await confirmPagePhase(["detail_ready"], settings, "打开选中详情后", { requireInvitationResolved: true });

    const detailTask = await waitForTaskDetailReady(settings, mergeTaskTypes(selectedTask.taskType, selection.taskType));
    assertSupportedDetailTask(detailTask, settings);
    return {
      ok: true,
      detailConfirmed: true,
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
      throw new Error(`未严格匹配到选中评论、点赞或转发任务：${selectedTask.title || selectedTask.taskType || "未知任务"}；已排除不支持候选 ${ignoredCount} 条；候选=${top || "无"}`);
    }

    report("info", `选中任务匹配成功：${formatCandidateMatchDebug(ranked[0].candidate, ranked[0].score)}`);
    return ranked[0].candidate;
  }

  function isSelectableAutomatableCandidate(candidate) {
    return Boolean(candidate
      && candidate.target
      && candidate.isAutomatable
      && !candidate.isOriginalTweet);
  }

  function canonicalSupportedTaskType(taskType) {
    const value = normalize(taskType);
    return detectScopedTaskType(value) || value;
  }

  function mergeTaskTypes(selectedType, detailType) {
    const selected = canonicalSupportedTaskType(selectedType || "");
    const detail = canonicalSupportedTaskType(detailType || "");
    const unsupported = [selected, detail].find((type) => ["原创推文", "引用", "关注"].includes(type));
    if (unsupported) return unsupported;
    // Only a bare detail comment can be the legacy fallback. Preserve explicit
    // list requirements and detail composites when either view adds a repost.
    if (selected.includes("转发") || detail.includes("转发")) {
      const explicit = [selected, detail === "评论" ? "" : detail];
      return [explicit.some(type => type.includes("评论")) && "评论",
        explicit.some(type => type.includes("点赞")) && "点赞", "转发"].filter(Boolean).join("+");
    }
    if (selected === "评论+点赞" || detail === "评论+点赞") return "评论+点赞";
    // A later detail read may only carry buildTask's legacy comment default.
    // Keep the selected explicit type unless either view proves a composite.
    return selected || detail;
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

  function hasPositiveClaimState(text, root = null) {
    // The target tweet is third-party content, not an order receipt. Exclude
    // only its semantic section; keep all status text elsewhere in the detail.
    const previews = new Set(Array.from(root?.querySelectorAll?.("section") || []).filter(section =>
      Array.from(section.querySelectorAll?.("h2") || []).some(heading =>
        heading.closest?.("section") === section
        && /^(?:TARGET TWEET(?:\s+LIVE)?|目标推文)$/.test(normalize(heading.innerText || "")))));
    if (previews.size && root?.childNodes) {
      const read = node => {
        if (previews.has(node)) return "";
        if (node.nodeType === 3) return node.nodeValue || "";
        if (node.childNodes?.length) return Array.from(node.childNodes).map(read).join("");
        return node.innerText || node.textContent || "";
      };
      text = normalize(read(root));
    }
    // These are pre-claim instructions, not a receipt for this order.
    const stateText = text.replace(/验证通过\s*(?:即到账|LUX\s*即时到账)/g, "");
    return /已锁定|已领取|进行中|已完成|已提交|验证通过|验证成功|奖励到账|任务完成/.test(stateText);
  }

  function claimDetailSignature(root) {
    if (!root || root === document.body) return "";
    let text = normalize(root.innerText || "").replace(/锁定(?:点击后)?失败[:：]?\s*/g, " ");
    for (const marker of [...HARD_FAIL_MARKERS, ...LOCK_BUTTON_TEXTS, "目标推文"].sort((a, b) => b.length - a.length)) {
      text = text.split(marker).join(" ");
    }
    text = normalize(text);
    return text ? JSON.stringify([normalizeTweetUrl(extractTweetUrl(root)), text]) : "";
  }

  function checkLighthouseLockFailure(message = {}) {
    const root = findTaskDetailRoot();
    const task = message.task;
    const operation = Array.from(settledClaimOperations.values()).reverse().find(value =>
      value.runId === message.runId && value.claimActionAttempted && value.result?.ok === true
      && value.lockObservation?.taskKey === task?.taskKey
      && value.lockObservation?.seatLockedAt === task?.seatLockedAt);
    const observation = operation?.lockObservation;
    // Only a new refusal from this exact visible detail and lock attempt can
    // revoke the provisional lock. Other cards, old pages and success evidence
    // never authorize abandoning an order.
    if (!observation || !task?.taskKey || !task.seatLockedAt
        || !root || root === document.body || root !== observation.root
        || root.isConnected === false || !isVisible(root) || !isTaskDetailOpen()
        || !observation.rejectionAbsent || !observation.positiveStateAbsent
        || !observation.detailSignature || observation.detailSignature !== claimDetailSignature(root))
      return { ok: true, failed: false };
    const text = normalize(root.innerText || "");
    if (!hasHardFailure(text) || hasPositiveClaimState(text, root)) return { ok: true, failed: false };
    return {
      ok: true,
      failed: true,
      reason: extractHardFailureReason(text),
      message: `锁定失败：${extractHardFailureReason(text)}`,
      task: { ...task, detailText: text.slice(0, 1800) },
      claimRejection: {
        runId: operation.runId,
        taskKey: observation.taskKey,
        seatLockedAt: observation.seatLockedAt,
        claimIntentId: operation.claimIntentId
      }
    };
  }

  async function waitSelectedCountdownAndLock(settings, selectedTask = {}) {
    if (!isTaskDetailOpen()) {
      throw new Error("当前未进入任务详情页，无法等待锁定按钮");
    }

    const taskBeforeClick = buildTask(settings, selectedTask.taskType || "");
    assertSupportedDetailTask(taskBeforeClick, settings);
    await acceptInvitationIfPresent(settings);
    const started = Date.now();
    const timeoutMs = getPageWaitMs(settings);
    let deadline = started + timeoutMs;
    const maxDeadline = started + Math.max(timeoutMs, Number(settings.maxCooldownWaitMs) || 600000);
    let lastReason = "";
    let lastWaitReportAt = 0;
    let lastReleaseText = "";

    while (Date.now() < deadline) {
      assertActiveRun(activeRunId);
      if (!isTaskDetailOpen()) {
        throw new Error("等待锁定期间任务详情已关闭");
      }

      const detailRoot = findTaskDetailRoot();
      const detailText = normalize(detailRoot?.innerText || "");
      if (hasBlockingTaskFailure(detailText, settings)) {
        throw new Error(`任务不可做：${extractHardFailureReason(detailText)}`);
      }

      if (await acceptInvitationIfPresent(settings)) {
        continue;
      }

      const lockButton = findLockButton();
      if (lockButton) {
        const hrefBeforeClick = lockButton.href || lockButton.getAttribute("href") || "";
        const candidateUrl = normalizeTweetUrl(hrefBeforeClick || taskBeforeClick.tweetUrl);
        lockButton.scrollIntoView({ block: "center", inline: "center" });
        await wait(Math.max(settings.actionDelayMs || 500, 500));
        const lockObservation = observeLockAttempt(taskBeforeClick);
        await clickAndVerifyLock(lockButton, settings, lockObservation);
        report("info", "已确认本单锁位，继续等待平台自动打开 X");
        const afterClickText = normalize(lockObservation.root?.innerText || "");
        if (hasBlockingTaskFailure(afterClickText, settings)) {
          throw new Error(`锁定点击后失败：${extractHardFailureReason(afterClickText)}`);
        }
        const taskAfterClick = buildTask(settings, selectedTask.taskType || "");
        return {
          ok: true,
          message: "已确认本单锁位，等待目标 X 页面",
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
      if (releaseCountdown) {
        // The visible order owns release time. Sidebar snapshots are display
        // data and may already belong to a previous batch.
        if (Date.now() + releaseCountdown.remainingMs > maxDeadline) {
          throw createDeferredReleaseError(taskBeforeClick, releaseCountdown);
        }
        deadline = Math.min(maxDeadline, Math.max(deadline, Date.now() + releaseCountdown.remainingMs + timeoutMs));
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
    const error = new Error(`详情页下一批放号仍需 ${formatDuration(remainingMs)}，返回广场读取平台最新倒计时`);
    error.deferredRelease = true;
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
      const text = normalize(findTaskDetailRoot()?.innerText || "");
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

  async function debugLockSeatAndExtract(settings, expectedInvitation = null) {
    report("info", "详情页已加载，检查是否可立即锁定席位");
    await confirmPagePhase(["detail_ready"], settings, "锁定席位前");

    let taskBeforeClick = buildTask(settings);
    if (expectedInvitation) {
      assertInvitationTarget(expectedInvitation);
      // Candidate messages also update the worker. Keep the persisted invitation
      // identity through both candidate reports and the later lock checkpoint.
      taskBeforeClick = { ...taskBeforeClick, ...expectedInvitation,
        taskType: mergeTaskTypes(expectedInvitation.taskType, taskBeforeClick.taskType),
        detailText: taskBeforeClick.detailText };
    }
    if (taskBeforeClick.tweetUrl) {
      sendRuntimeMessage({ type: "DEBUG_TASK_CANDIDATE", runId: activeRunId, task: taskBeforeClick });
    }

    const detailText = normalize(findTaskDetailRoot()?.innerText || "");
    if (hasBlockingTaskFailure(detailText, settings)) {
      throw new Error(`任务不可做：${extractHardFailureReason(detailText)}`);
    }

    // Resume only a currently locked detail with an explicit target and no
    // claim control. An old badge beside an available lock button is not enough.
    if (hasConfirmedLockedDetail(findTaskDetailRoot(), taskBeforeClick.tweetUrl)) {
      report("info", "当前详情已确认席位锁定，沿用本单并接续 X 流程");
      return { ok: true, message: "已核对当前锁定订单，接续处理本单", task: {
        ...taskBeforeClick, seatLocked: true, seatLockedAt: new Date().toISOString(), resumedLockedTask: true
      } };
    }

    const lockButton = await findLockButtonAfterHydration(settings);
    const hrefBeforeClick = lockButton.href || lockButton.getAttribute("href") || "";
    const candidateUrl = normalizeTweetUrl(hrefBeforeClick || taskBeforeClick.tweetUrl);
    if (candidateUrl) {
      sendRuntimeMessage({
        type: "DEBUG_TASK_CANDIDATE",
        runId: activeRunId,
        task: {
          ...taskBeforeClick,
          tweetUrl: candidateUrl
        }
      });
    }

    lockButton.scrollIntoView({ block: "center", inline: "center" });
    if (expectedInvitation) assertInvitationTarget(expectedInvitation);
    const lockObservation = observeLockAttempt(taskBeforeClick);
    await clickAndVerifyLock(lockButton, settings, lockObservation, expectedInvitation);
    await confirmPagePhase(["detail_ready"], settings, "锁定席位后", { timeoutMs: 2500 });
    if (!isSameLockDetail(lockObservation)) {
      const error = new Error("锁位确认期间任务详情已变化，未确认当前订单状态，请核对本单");
      error.task = lockObservation.task;
      throw error;
    }

    const afterText = normalize(lockObservation.root?.innerText || "");
    if (hasBlockingTaskFailure(afterText, settings)) {
      throw new Error(`锁定失败：${extractHardFailureReason(afterText)}`);
    }

    const taskAfterClick = buildTask(settings);
    const tweetUrl = normalizeTweetUrl(taskAfterClick.tweetUrl || hrefBeforeClick || taskBeforeClick.tweetUrl);

    return {
      ok: true,
      message: tweetUrl
        ? "已锁定席位并提取推文链接"
        : "已确认本单锁位，等待后台接管 Lighthouse 自己打开的 X 推文页",
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
    assertActiveRun(activeRunId);
    const timeoutMs = getPageWaitMs(settings);
    if (!location.pathname.includes("/campaigns")) {
      location.href = "https://app.lhdao.top/campaigns";
      await waitFor(() => location.pathname.includes("/campaigns"), timeoutMs, "等待任务广场加载超时");
    }
    await waitForCampaignsReady(timeoutMs);
  }

  async function ensureAllTaskFilter(settings) {
    if (findStandaloneInvitation()) return;
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
    if (findStandaloneInvitation()) return;
    await clickElement(allButton, { beforeClick: assertNoStandaloneInvitation });
    await verifyAllFilterAccepted(settings);
  }

  async function selectNextCommentTask(settings, attemptedTaskKeys, attemptedTaskRecords = []) {
    const runId = activeRunId;
    await waitForCampaignsReady(getPageWaitMs(settings));
    const waitingSince = Date.now();
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
      const invitation = findStandaloneInvitation();
      if (invitation) return { invitation };
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
      assertActiveRun(runId);
      if (minTaskBounty !== lastReportedMinTaskBounty) {
        lastReportedMinTaskBounty = minTaskBounty;
        report("info", `当前全量检测最低赏金：${minTaskBounty.toFixed(3)} LUX`);
      }
      // Temporary exclusions expire during this scan, not only after a reload.
      // Keys without a timed record are permanent or legacy exclusions.
      const expiryByKey = new Map(attemptedTaskRecords.map(record => [record.key, Number(record.expiresAt)]));
      const activeAttemptedKeys = attemptedTaskKeys.filter(key => !expiryByKey.has(key)
        || !Number.isFinite(expiryByKey.get(key)) || expiryByKey.get(key) > Date.now());
      const candidates = collectTaskCandidates(activeAttemptedKeys, settings);
      const lowBountyCandidates = candidates.filter((candidate) => candidate.isAutomatable && isBelowMinTaskBounty(candidate.bounty, minTaskBounty));
      const ignoredNonCommentCandidates = candidates.filter((candidate) => !candidate.isAutomatable && !candidate.isBlocked);
      if (ignoredNonCommentCandidates.length && Date.now() - lastOriginalSkipReportAt > 15000) {
        lastOriginalSkipReportAt = Date.now();
        report("info", `已忽略不支持任务 ${ignoredNonCommentCandidates.length} 条，只等待评论、点赞或转发任务`);
      }
      if (lowBountyCandidates.length && Date.now() - lastLowBountyReportAt > 15000) {
        lastLowBountyReportAt = Date.now();
        report("info", `已按赏金阈值过滤 ${lowBountyCandidates.length} 条低于 ${minTaskBounty.toFixed(1)}LUX 的评论、点赞或转发任务`);
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

      // Finish the pending scan with an explicit no-claim receipt before the
      // background reloads. Cancelling this request would lose that evidence.
      if (Date.now() - waitingSince >= CAMPAIGNS_IDLE_REFRESH_MS
          && claimOperation?.claimActionAttempted === false
          && isCampaignsListOpen()) {
        throw buildCampaignsRefreshRequestError("任务广场连续 5 分钟未找到可执行任务，已确认未尝试接单，刷新后继续检测");
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
          throw buildCampaignsRefreshRequestError(`任务广场连续 ${staleReadyHitCount} 轮出现 ${visibleReadyCandidates.length} 条可做评论、点赞或转发任务，但当前都无法进入自动执行（去重 ${dedupedReadyCount} 条，低赏金 ${lowBountyReadyCount} 条），请求刷新任务广场`);
        }
      } else {
        staleReadyHitCount = 0;
      }

      const cooldownCandidates = filteredCandidates
        .filter((candidate) => candidate.isAutomatable && !candidate.isBlocked
          && Number.isFinite(candidate.cooldownMs) && candidate.cooldownMs > AUTO_DETAIL_PRELOAD_MS && candidate.target)
        .sort((a, b) => a.cooldownMs - b.cooldownMs);

      if (!settings.enableCooldownSniping) {
        throw new Error("当前没有可做评论、点赞或转发任务，且未启用任务广场等待");
      }

      const shortest = cooldownCandidates.find((candidate) => !candidate.attempted) || cooldownCandidates[0];
      if (Date.now() - lastReportAt > 15000) {
        lastReportAt = Date.now();
        if (visibleReadyCandidates.length > 0 && !ready) {
          const lowBountyReadyCount = visibleReadyCandidates.filter((candidate) => isBelowMinTaskBounty(candidate.bounty, minTaskBounty)).length;
          const dedupedReadyCount = visibleReadyCandidates.filter((candidate) => candidate.attempted).length;
          report("info", `当前可做评论、点赞或转发任务共有 ${visibleReadyCandidates.length} 条，但暂无可执行候选（去重 ${dedupedReadyCount} 条，低赏金 ${lowBountyReadyCount} 条），跳过并等待新任务`);
        } else if (shortest) {
          report("info", `任务广场最近任务仍在冷却：${formatDuration(shortest.cooldownMs)}，到可抢后再打开详情`);
        } else {
          report("info", "任务广场暂无可识别评论、点赞或转发任务，继续等待列表刷新");
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
      const isInvitation = isInvitationTaskText(rawText);
      const bounty = parseCandidateBounty(text);
      const title = extractCandidateTitle(rawText, taskType);
      const handle = extractHandle(rawText);
      const selectionId = buildSelectionId({ taskType, bounty, title, handle, text });
      const stableTaskKey = buildStableTaskKey({ taskType, bounty, title, handle });
      const taskKey = buildTaskKey(text);
      const cooldown = parseCooldownFromCard(card, rawText);
      const cooldownMs = cooldown.remainingMs;
      const hasCardCooldown = Number.isFinite(cooldownMs) && cooldownMs > 0;
      const isBlocked = Boolean(getCardUnavailableReason(card)) || Boolean(cooldown.isBlocked) || /账户风险中|等待审核|风险审核/.test(text) || (!hasCardCooldown && (
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
        isInvitation,
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
    if (getEligibilityBlockReason(value)) return true;
    if (hasAccountRiskReviewBlock(value)) return true;
    return hasHardFailure(value);
  }

  function getEligibilityBlockReason(text) {
    const compact = normalize(text).replace(/\s+/g, "");
    return ELIGIBILITY_BLOCK_MARKERS.find((marker) => compact.includes(marker)) || "";
  }

  function getCardUnavailableReason(card) {
    if (!card) return "";
    if (card.isConnected === false) return "任务卡片已更新，请重新检测";
    const text = normalize(card.innerText || "");
    const restriction = getEligibilityBlockReason(text);
    if (restriction) return restriction;
    if (hasAccountRiskReviewBlock(text)) return extractHardFailureReason(text);
    // The article itself remains clickable when the site's action is disabled.
    // A real release timer is waitable; an unknown disabled action is not.
    const actionRoot = card.querySelector?.('[data-mobile-card-slot="action"]') || card;
    const controls = Array.from(actionRoot.querySelectorAll?.("button,a,[role='button']") || [])
      .filter((node) => isVisible(node) && isOwnedByTaskCard(node, card));
    const blockedControl = controls.find((node) => isDisabled(node) && !hasCooldownState(buttonText(node)));
    if (blockedControl && controls.every(isDisabled)) {
      return buttonText(blockedControl) || "任务操作按钮不可用";
    }
    return "";
  }

  function assertCardAvailable(card) {
    const reason = getCardUnavailableReason(card);
    if (!reason) return;
    const error = new Error(`任务当前不可接：${reason}`);
    error.taskUnavailable = true;
    throw error;
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
      .concat(INVITATION_MARKERS, INVITATION_ACCEPT_BUTTON_TEXTS, BLOCKED_MARKERS, HARD_FAIL_MARKERS, COOLDOWN_MARKERS)
      .some((marker) => text.includes(marker));
    if (hasActionText) return true;
    return Array.from(card.querySelectorAll?.("button,a,[role='button']") || [])
      .filter(isVisible)
      .some((node) => {
        const value = buttonText(node);
        return DETAIL_BUTTON_TEXTS.some((marker) => value.includes(marker))
          || INVITATION_ACCEPT_BUTTON_TEXTS.some((marker) => value.includes(marker))
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
    const value = normalize(text).replace(/\s+/g, "");
    if (!value) return "";
    const labels = value.match(/原创推文|原创建推文|原创内容|发布推文|创建推文|发一条推文|CreateTweet|PostTweet|OriginalPost|发推|引用转发|引用转推|引用推文|引用|Quote(?:Post|Tweet)?|转发互动|转发|转推|转帖|Repost|Retweet|关注|Follow|评论留言|评论|回复|Comment|Reply|点赞互动|点赞|Like|赞/gi) || [];
    const remainder = value.replace(/原创推文|原创建推文|原创内容|发布推文|创建推文|发一条推文|CreateTweet|PostTweet|OriginalPost|发推|引用转发|引用转推|引用推文|引用|Quote(?:Post|Tweet)?|转发互动|转发|转推|转帖|Repost|Retweet|关注|Follow|评论留言|评论|回复|Comment|Reply|点赞互动|点赞|Like|赞/gi, "").replace(/任务|[+＋&＆、,/／·|与和]/g, "");
    if (remainder || !labels.length) return "";
    if (labels.some((label) => /原创|发推|发布推文|创建推文|发一条推文|CreateTweet|PostTweet|OriginalPost/i.test(label))) return "原创推文";
    if (labels.some((label) => /引用|Quote/i.test(label))) return "引用";
    if (labels.some((label) => /关注|Follow/i.test(label))) return "关注";
    const comment = labels.some((label) => /评论|回复|Comment|Reply/i.test(label));
    const like = labels.some((label) => /赞|Like/i.test(label));
    const repost = labels.some((label) => /转发|转推|转帖|Repost|Retweet/i.test(label));
    if (repost) return [comment && "评论", like && "点赞", "转发"].filter(Boolean).join("+");
    return comment && like ? "评论+点赞" : comment ? "评论" : like ? "点赞互动" : "";
  }

  function collectTaskTypeBadgeText(card) {
    return Array.from(card?.querySelectorAll?.("button,a,[role='button'],span,p,strong,b,small") || [])
      .filter(isVisible)
      .map((node) => normalize(node.innerText || node.textContent || node.getAttribute("aria-label") || ""))
      .filter((text) => text && text.length <= 32 && detectScopedTaskType(text))
      .join(" ");
  }

  function extractCardHeaderText(rawText) {
    const lines = String(rawText || "")
      .split(/\n+/)
      .map((line) => normalize(line))
      .filter(Boolean);
    const header = [];
    for (const line of lines) {
      if (/预计获得|LUX|冷却|查看详情|活动周期|长期有效|TARGET TWEET|目标推文/i.test(line)) break;
      if (detectScopedTaskType(line)) header.push(line);
      if (header.length >= 8) break;
    }
    return header.join(" ");
  }

  function detectTaskTypeFromText(text) {
    return detectScopedTaskType(text) || detectScopedTaskType(extractCardHeaderText(text));
  }

  function isInvitationTaskText(text) {
    const value = normalize(text);
    return INVITATION_MARKERS.some((marker) => value.includes(marker));
  }

  function isInvitationAcceptLabel(text) {
    const value = normalize(text);
    return INVITATION_ACCEPT_BUTTON_TEXTS.some((marker) => value === marker || value.includes(marker));
  }

  function findInvitationAcceptButton(options = {}) {
    const selector = "button,a,[role='button'],input[type='button'],input[type='submit']";
    return Array.from(document.querySelectorAll(selector))
      .filter((node) => isVisible(node) && (options.includeDisabled || !isDisabled(node)))
      .filter((node) => isInvitationAcceptLabel(buttonText(node)))
      .find((node) => {
        let scope = node;
        for (let depth = 0; scope && depth < 8; depth += 1) {
          if (scope === document.body || scope === document.documentElement) break;
          const text = normalize(scope.innerText || scope.textContent || "");
          if (isInvitationTaskText(text)) return true;
          scope = scope.parentElement;
        }
        return false;
      }) || null;
  }

  function findStandaloneInvitation() {
    const prompts = [];
    const buttons = Array.from(document.querySelectorAll?.("button,a,[role='button'],input[type='button'],input[type='submit']") || [])
      .filter((node) => isVisible(node) && buttonText(node).replace(/[→↗]/g, "").trim() === "接受并开始");
    for (const button of buttons) {
      let root = button.parentElement;
      for (let depth = 0; root && depth < 12; depth += 1, root = root.parentElement) {
        if (root === document.body || root === document.documentElement) break;
        const rawText = root.innerText || root.textContent || "";
        if (!normalize(rawText).includes("专属任务邀请")) continue;
        const overlay = root.closest?.("[role='dialog'],[role='alertdialog'],[aria-modal='true']");
        if (!overlay && getComputedStyle(root).position !== "fixed") continue;
        const links = Array.from(root.querySelectorAll?.("a[href]") || []);
        const targetLinks = links.filter(node => /查看目标推文|目标推文/.test(buttonText(node)));
        const targetUrls = (targetLinks.length ? targetLinks : links)
          .map(node => normalizeTweetUrl(node.href || node.getAttribute("href") || "")).filter(Boolean);
        const targets = [...new Set(targetUrls.map(url => normalizeTweetUrl(url, true)))];
        const tweetUrl = targets.length === 1 ? targetUrls[0] : "";
        const header = rawText.split(/目标推文|TARGET TWEET/i)[0];
        const nodes = Array.from(root.querySelectorAll("*"));
        const targetIndex = nodes.findIndex(node => targetLinks.includes(node)
          || /^(?:查看)?目标推文$|^TARGET TWEET$/i.test(buttonText(node)));
        const badges = nodes.slice(0, Math.max(targetIndex, 0)).filter(isVisible)
          .map(node => buttonText(node)).filter(text => text.length <= 32);
        const taskType = detectScopedTaskType([...header.split(/\n+/), ...badges]
          .map(detectScopedTaskType).filter(Boolean).join("+"));
        const task = {
          source: "lighthouse_invitation", title: extractTitle(root),
          taskKey: tweetUrl ? `invitation:${targets[0]}` : "", tweetUrl, taskType,
          bounty: parseCandidateBounty(header), handle: extractHandle(rawText),
          detailText: normalize(rawText).slice(0, 1800), createdAt: new Date().toISOString()
        };
        if (!prompts.some(prompt => prompt.root === root)) prompts.push({ root, button, task });
        break;
      }
    }
    if (prompts.length > 1) return { ...prompts[0], ambiguous: true };
    return prompts[0] || null;
  }

  function getStandaloneInvitationState(invitation = findStandaloneInvitation(), protectClaim = true) {
    if (!invitation) return "absent";
    if (invitation.ambiguous) return "unknown";
    // A visible expiry must never undo an already permitted acceptance.
    if (protectClaim && claimOperation?.claimActionAttempted) return "result_unknown";
    const expired = Array.from(invitation.root.querySelectorAll("p,span,div,[role='status'],[role='alert']"))
      .filter(isVisible).some(node => /^(?:(?:本次|该)?(?:专属|任务)?邀请|任务邀请)(?:已|已经)?(?:过期|失效|结束|撤销)(?:[，。！!\s]|$)/
        .test(normalize(node.innerText || node.textContent || "")));
    if (expired) return "expired";
    if (!invitation.task.taskKey || !invitation.task.tweetUrl) return "unknown";
    return isDisabled(invitation.button) ? "waiting" : "ready";
  }

  function assertNoStandaloneInvitation() {
    if (!findStandaloneInvitation()) return;
    const error = new Error("专属任务邀请已出现，保留弹窗并重新识别，不操作底层任务");
    error.transient = true;
    throw error;
  }

  function hasMatchingInvitationTarget(task) {
    const root = findTaskDetailRoot();
    const expected = normalizeTweetUrl(task.tweetUrl, true);
    return Boolean(!findStandaloneInvitation() && root && root !== document.body
      && expected && normalizeTweetUrl(extractTweetUrl(root), true) === expected);
  }

  function assertInvitationTarget(task) {
    if (!hasMatchingInvitationTarget(task)) {
      const error = new Error("邀请接单后的目标任务不匹配，已保留本单等待核对");
      error.task = task;
      throw error;
    }
  }

  async function openStandaloneInvitation(settings, invitation) {
    const runId = activeRunId;
    const operation = claimOperation;
    const task = invitation.task;
    const fail = (message, details = {}) => {
      const error = new Error(message);
      Object.assign(error, details);
      error.task = task;
      throw error;
    };
    if (!operation || !["START_LIGHTHOUSE_COMMENT_TASK", "DEBUG_OPEN_FIRST_COMMENT_TASK"].includes(operation.type)
        || operation.claimActionAttempted || operation.invitationTask || operation.boundTask) {
      fail("当前接单操作已绑定其他任务，未接受新的专属邀请");
    }
    const isSamePrompt = (allowExpired = false) => {
      assertActiveRun(runId);
      const current = findStandaloneInvitation();
      if (claimOperation !== operation || !current || current.ambiguous
          || current.root !== invitation.root || current.button !== invitation.button
          || current.task.taskKey !== task.taskKey || current.task.taskType !== task.taskType
          || current.task.bounty !== task.bounty) fail("专属任务邀请已变化，未操作旧邀请");
      if (!allowExpired && getStandaloneInvitationState(current, false) === "expired") {
        fail("专属任务邀请已失效，未点击接受");
      }
      return current;
    };
    const minBounty = await getLiveAutoMinTaskBounty(settings);
    const current = isSamePrompt(true);
    if (getStandaloneInvitationState(current) === "expired") {
      const dismiss = Array.from(current.root.querySelectorAll("button,[role='button']"))
        .find(node => isVisible(node) && !isDisabled(node) && buttonText(node) === "跳过")
        || Array.from(current.root.querySelectorAll("button,[role='button']"))
          .find(node => isVisible(node) && !isDisabled(node)
            && /^(?:关闭|关闭邀请)$/.test(buttonText(node) || node.getAttribute("aria-label") || ""));
      if (!dismiss) fail("过期邀请没有可用关闭入口，等待安全刷新任务广场", { refreshRequested: true });
      await clickElement(dismiss, { randomDelay: false, beforeClick: () => {
        const fresh = isSamePrompt(true);
        if (operation.claimActionAttempted || getStandaloneInvitationState(fresh) !== "expired"
            || !fresh.root.contains(dismiss) || dismiss.isConnected === false || isDisabled(dismiss)) {
          fail("邀请状态已变化，保留页面重新核对");
        }
      } });
      await wait(Math.max(150, settings.actionDelayMs || 150));
      assertActiveRun(runId);
      if (findStandaloneInvitation()?.root === invitation.root) fail("过期邀请关闭尚未确认，等待安全刷新", { refreshRequested: true });
      report("info", "已关闭明确过期且未接受的邀请，继续扫描任务广场");
      return null;
    }
    if (invitation.ambiguous || !task.taskKey || !task.tweetUrl) fail("专属任务邀请缺少唯一目标推文，未接受任务");
    const restriction = getEligibilityBlockReason(normalize(current.root.innerText || ""));
    const blocked = restriction || (!isAutomatableTaskType(task.taskType) ? "任务类型不支持自动执行" : "")
      || (hasUnsupportedCommentGuidance(current.root.innerText || "") ? "任务要求人工提供内容" : "")
      || (isBelowMinTaskBounty(task.bounty, minBounty) ? "低于设置的最低赏金" : "");
    if (blocked) {
      const skip = Array.from(current.root.querySelectorAll("button,[role='button']"))
        .find(node => isVisible(node) && !isDisabled(node) && buttonText(node) === "跳过");
      if (!skip) fail(`专属任务邀请${blocked}，未接受任务`);
      await clickElement(skip, { randomDelay: false, beforeClick: () => { isSamePrompt(); } });
      await wait(Math.max(150, settings.actionDelayMs || 150));
      assertActiveRun(runId);
      if (findStandaloneInvitation()?.root === invitation.root) fail("跳过邀请后弹窗仍存在，未重复操作");
      report("info", `已跳过专属任务邀请：${blocked}`);
      return null;
    }
    if (isDisabled(current.button)) fail("专属任务邀请的接受按钮尚不可用，未重复操作");
    operation.invitationTask = task;
    await clickElement(current.button, { randomDelay: false, claimAction: true, beforeClick: () => {
      const fresh = isSamePrompt();
      if (isDisabled(fresh.button) || getEligibilityBlockReason(normalize(fresh.root.innerText || ""))
          || hasUnsupportedCommentGuidance(fresh.root.innerText || "")) {
        fail("专属任务邀请已不可接受，未点击");
      }
    } });
    report("info", "已点击接受专属任务邀请，核对同一任务后继续执行");
    const started = Date.now();
    while (Date.now() - started < Math.min(getPageWaitMs(settings), 30000)) {
      assertActiveRun(runId);
      // The execution shell can render before its target, or briefly retain
      // the previous detail. Wait within this claim's existing deadline so
      // the original flow can continue once the same-order receipt arrives.
      if (!findInvitationAcceptButton({ includeDisabled: true }) && isTaskDetailOpen()
          && hasMatchingInvitationTarget(task)) {
        assertInvitationTarget(task);
        const detail = buildTask(settings, task.taskType);
        assertSupportedDetailTask(detail, settings);
        return { ok: true, detailConfirmed: true, message: "已接受专属邀请并核对本单详情",
          task: { ...detail, ...task, detailText: detail.detailText } };
      }
      await wait(Math.min(Math.max(settings.cooldownPollMs || 250, 100), 500));
    }
    fail("专属任务邀请接受结果尚未确认，已保留本单，不重复接受");
  }

  async function acceptInvitationIfPresent(settings = {}) {
    assertNoStandaloneInvitation();
    const invitationButton = findInvitationAcceptButton();
    if (!invitationButton) return false;
    await clickElement(invitationButton, { randomDelay: false, claimAction: true });
    report("info", `检测到邀请接单，已点击：${buttonText(invitationButton)}`);
    await wait(Math.min(Math.max(Number(settings.actionDelayMs) || 150, 150), 500));
    return true;
  }

  function isCommentEquivalentTaskType(taskType) {
    const value = normalize(taskType);
    return value === "评论" || value === "评论+点赞" || value === "评论+赞" || value === "点赞互动" || value === "点赞";
  }

  function isAutomatableTaskType(taskType) {
    const value = normalize(taskType);
    return isCommentEquivalentTaskType(value)
      || /^(?:(?:评论(?:\+点赞)?|点赞)\+)?(?:转发(?:互动)?|转推|转帖|Repost|Retweet)$/i.test(value);
  }

  function assertSupportedDetailTask(task, settings = {}) {
    const explicitTaskType = normalize(task.taskType || "");
    const detailRoot = findTaskDetailRoot();
    const detailText = normalize(detailRoot?.innerText || "");
    const taskType = explicitTaskType || detectTaskTypeFromText(detailText || task.detailText || "");
    const restriction = getEligibilityBlockReason(detailText);
    if (restriction) {
      const error = new Error(`任务当前不可接：${restriction}`);
      error.task = { ...(task || {}), taskType };
      throw error;
    }
    const unsupportedGuidance = hasUnsupportedCommentGuidance(detailText);
    if (!unsupportedGuidance && (["评论", "评论+点赞", "评论+赞", "点赞互动", "点赞"].includes(taskType)
      || /^(?:(?:评论(?:\+点赞)?|点赞)\+)?(?:转发(?:互动)?|转推|转帖|Repost|Retweet)$/i.test(taskType))) return;
    const reason = unsupportedGuidance ? "任务备注要求人工提供内容" : `已识别为${taskType || "非回复"}任务`;
    const error = new Error(`${reason}，永久忽略不再打开`);
    error.permanentIgnore = true;
    error.ignoredTaskType = unsupportedGuidance ? "人工评论要求" : taskType;
    error.task = { ...(task || {}), taskType };
    throw error;
  }

  function findOpenTargetInCard(card) {
    const clickables = Array.from(card.querySelectorAll?.("button,a,[role='button']") || [])
      .filter(isVisible);
    return clickables.find((node) => !isDisabled(node) && DETAIL_BUTTON_TEXTS.some((text) => buttonText(node).includes(text)))
      || clickables.find((node) => !isDisabled(node) && isInvitationAcceptLabel(buttonText(node)))
      || clickables.find((node) => !isDisabled(node))
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
    if (detectScopedTaskType(line)) return false;
    if (line.length < 2 || line.length > 120) return false;
    if (/活动周期|长期有效|预计获得|LUX|冷却|查看详情|评论留言|已完成|进行中|席位|PROMO|官方/.test(line)) return false;
    if (/^\d+(?:\.\d+)?$/.test(line)) return false;
    return true;
  }

  function buildSelectionId(info) {
    return [
      canonicalSupportedTaskType(info.taskType || "") || "任务",
      Number(info.bounty || 0).toFixed(2),
      normalize(info.handle || ""),
      normalize(info.title || "").slice(0, 80),
      normalize(info.text || "").slice(0, 220)
    ].join("|");
  }

  function buildStableTaskKey(info) {
    return [
      "stable",
      canonicalSupportedTaskType(info.taskType || "") || "任务",
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
    assertNoStandaloneInvitation();
    assertCardAvailable(selection.card);
    const targets = getOpenTargetsInCard(selection.card, selection.target);
    if (!targets.length) throw new Error("未找到任务卡片入口");

    let lastError = "";
    for (const target of targets) {
      assertActiveRun(runId);
      try {
        await tryOpenTaskDetailTarget(target, settings, selection.card);
        report("info", "已打开选中任务详情，开始查找在 X 打开/前往目标控件");
        return;
      } catch (error) {
        if (findStandaloneInvitation()) throw error;
        if (error.taskUnavailable) throw error;
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

  async function tryOpenTaskDetailTarget(target, settings, card = null) {
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
      assertNoStandaloneInvitation();
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
        assertCardAvailable(card);
        clickCount += 1;
        lastClickAt = Date.now();
        // A list entry can accept/claim directly. Match its complete label;
        // a fallback card's prose can mention these words without claiming.
        const entryLabels = [buttonText(target), target.getAttribute?.("aria-label")].map(normalize);
        const claimAction = entryLabels.some((label) => INVITATION_ACCEPT_BUTTON_TEXTS.includes(label) || LOCK_BUTTON_TEXTS.includes(label));
        await clickElement(target, { claimAction, beforeClick: () => {
          assertNoStandaloneInvitation();
          assertCardAvailable(card);
        } });
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
    const detailRoot = findTaskDetailRoot();
    const text = detailRoot
      ? normalize(detailRoot.innerText || detailRoot.textContent || "")
      : (hasTaskDetailOverlayShell() ? normalize(document.body?.innerText || "") : "");
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
    return Array.from(new Set(targets)).filter((node) => isVisible(node) && !isDisabled(node));
  }

  function isTaskDetailOpen() {
    const execution = findExecutionDialog();
    if (execution.present) return Boolean(execution.root);
    const text = normalize(findTaskDetailRoot()?.innerText || "");
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
    const detailRoot = findTaskDetailRoot();
    const text = detailRoot
      ? normalize(detailRoot.innerText || detailRoot.textContent || "")
      : (hasTaskDetailOverlayShell() ? normalize(document.body?.innerText || "") : "");
    return text.includes("详情加载失败")
      || text.includes("Failed to fetch")
      || text.includes("Request timeout")
      || text.includes("id:")
      || hasTaskUnavailableError();
  }

  function hasTaskUnavailableError() {
    const detailRoot = findTaskDetailRoot();
    const text = detailRoot
      ? normalize(detailRoot.innerText || detailRoot.textContent || "")
      : (hasTaskDetailOverlayShell() ? normalize(document.body?.innerText || "") : "");
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
      && (collectVisibleTaskLikeNodes().length > 0 || hasLoadedCampaignListShell())
      && !isTaskDetailOpen();
  }

  function hasLoadedCampaignListShell() {
    // A loaded plaza can contain only unsupported cards, or no cards at all.
    // Its heading, filters and counted tabs prove readiness without treating
    // navigation/sidebar text alone as a loaded task list.
    if (!/^\/campaigns\/?$/.test(location.pathname) || hasPageLoadingState()) return false;
    const hasHeading = Array.from(document.querySelectorAll("h1,h2,[role='heading']"))
      .some((node) => isVisible(node) && /^(?:任务广场|Task Hall)$/i.test(normalize(node.innerText || node.textContent || "")));
    if (!hasHeading) return false;
    const controls = Array.from(document.querySelectorAll("button,[role='button']"))
      .filter(isVisible)
      .map(buttonText);
    return controls.includes("全部")
      && controls.some((text) => /^可抢\s*\d+$/.test(text))
      && controls.some((text) => /^进行中\s*\d+$/.test(text));
  }

  function readRecoveryEscrowOrders(counter, listedCount) {
    const unknown = { ready: false, pendingOnly: false };
    if (!counter?.classList?.contains("on") || hasPageLoadingState()) return unknown;
    const heading = Array.from(document.querySelectorAll("h1,h2,[role='heading']"))
      .some(node => isVisible(node) && normalize(node.innerText || "") === "我的进行中任务");
    const filters = Array.from(document.querySelectorAll("main [role='combobox'],main select")).filter(isVisible);
    const filterText = filters.length === 1 ? normalize(filters[0].selectedOptions?.[0]?.textContent || filters[0].innerText || "") : "";
    if (!heading || filterText !== "全部") return unknown;
    const count = normalize(counter.innerText || "").match(/^进行中\s*(\d+)$/);
    const total = count ? Number(count[1]) : listedCount;
    const cards = Array.from(document.querySelectorAll("main article[role='button']")).filter(isVisible);
    // The total includes verified 24-hour escrow payouts. Only an exhaustive,
    // unfiltered list may prove that none still needs an action or submission.
    if (!Number.isInteger(total) || total <= 0 || cards.length !== total) return unknown;
    const pendingOnly = cards.every(card => {
      const text = normalize(card.innerText || "");
      const labels = Array.from(card.querySelectorAll("span,p,div")).filter(isVisible).map(node => normalize(node.innerText || ""));
      const controls = Array.from(card.querySelectorAll("button")).filter(isVisible).map(buttonText);
      return /^待到账\s/.test(text) && labels.includes("待到账奖励") && labels.includes("预计到账时间")
        && /预计到账时间\s+\d{4}\/\d{1,2}\/\d{1,2}\s+GMT\+8\s+\d{1,2}:\d{2}:\d{2}\s+查看进度$/.test(text)
        && controls.length === 1 && controls[0] === "查看进度";
    });
    return { ready: true, pendingOnly, listedCount: total };
  }

  async function closeTaskDetailPanel(settings = {}, message = {}) {
    const runId = activeRunId;
    const invitationPending = Symbol("invitationPending");
    const expiredInvitation = Symbol("expiredInvitation");
    const completionChanged = Symbol("completionChanged");
    const assertCanClose = () => {
      assertActiveRun(runId);
      if (!isCompletionCloseCurrent(message)) throw completionChanged;
      const state = getStandaloneInvitationState();
      if (state === "expired") throw expiredInvitation;
      if (state !== "absent") throw invitationPending;
    };
    try {
      assertCanClose();
      const completionReturnButton = findCompletionReturnToCampaignsButton(message);
      if (completionReturnButton) {
        completionReturnButton.scrollIntoView({ block: "center", inline: "center" });
        await wait(settings.actionDelayMs || 500);
        await clickElement(completionReturnButton, { beforeClick: () => {
          assertCanClose();
          if (findCompletionReturnToCampaignsButton(message) !== completionReturnButton) {
            throw completionChanged;
          }
        } });
        if (await waitForCampaignsReturnAfterCompletion(settings, assertCanClose)) {
          return { ok: true, message: "已关闭任务完成结果，并确认任务广场列表已恢复" };
        }
      }

      assertCanClose();
      const unavailableReturnButton = findUnavailableReturnToCampaignsButton();
      if (unavailableReturnButton) {
        unavailableReturnButton.scrollIntoView({ block: "center", inline: "center" });
        await wait(settings.actionDelayMs || 500);
        await clickElement(unavailableReturnButton, { beforeClick: assertCanClose });
        if (await waitForTaskPanelClosed(settings, "任务不可打开提示的返回任务广场按钮", assertCanClose)) {
          return { ok: true, message: "任务详情无法打开，已返回任务广场" };
        }
      }

      assertCanClose();
      if (!isTaskDetailOrRecoverableOverlayOpen()) {
        return { ok: true, message: "未检测到任务详情弹层，保持当前页面继续" };
      }

      const closeButton = findTaskDetailCloseButton();
      if (closeButton) {
        closeButton.scrollIntoView({ block: "center", inline: "center" });
        await wait(settings.actionDelayMs || 500);
        await clickElement(closeButton, { beforeClick: assertCanClose });
        if (await waitForTaskPanelClosed(settings, "右上角关闭按钮", assertCanClose)) {
          return { ok: true, message: "已通过右上角关闭任务详情" };
        }
      }

      assertCanClose();
      document.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        keyCode: 27,
        which: 27,
        bubbles: true,
        cancelable: true
      }));
      if (await waitForTaskPanelClosed(settings, "Esc", assertCanClose)) {
        return { ok: true, message: "已通过 Esc 关闭任务详情" };
      }

      assertCanClose();
      await clickTaskPanelOutside(assertCanClose);
      if (await waitForTaskPanelClosed(settings, "左侧空白区域", assertCanClose)) {
        return { ok: true, message: "已通过点击左侧空白区域关闭任务详情" };
      }

      assertCanClose();
      return { ok: false, message: "任务详情关闭复核失败，仍停留在详情页" };
    } catch (error) {
      if (error === completionChanged) return { ok: false, cancelled: true,
        message: "完成结果或关闭按钮已变化，已取消收尾并保留当前页面" };
      if (error === expiredInvitation) return { ok: false, expiredInvitation: true,
        message: "邀请已明确过期且尚未接受，允许后台核对后刷新广场" };
      if (error !== invitationPending) throw error;
      return { ok: true, invitationPending: true, message: "保留专属任务邀请，等待接单流程识别" };
    }
  }

  function beginCompletionWatch(message) {
    if (!message.runId || !message.task?.taskKey) return { ok: false, message: "缺少完成监测的订单身份" };
    if (completionContext?.runId === message.runId && completionContext.taskKey === message.task.taskKey) {
      if (!completionContext.navigationBinding && message.task.seatLocked === true) {
        completionContext.navigationBinding = createLockedNavigationBinding(message.task);
      }
      return { ok: true };
    }
    const baselineRoots = findOfficialCompletionRoots();
    completionContext = {
      runId: message.runId,
      taskKey: message.task.taskKey,
      tweetUrl: normalizeTweetUrl(message.task.tweetUrl || ""),
      navigationBinding: message.task.seatLocked === true ? createLockedNavigationBinding(message.task) : null,
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
    const targetIdentity = normalizeTweetUrl(target, true);
    const rootText = normalize(root.innerText || "");
    const identityScope = root.closest?.("[role='dialog']") || root;
    const originalTweetLinks = Array.from(identityScope.querySelectorAll("a[href]"))
      .filter((node) => /^查看原推文$/.test(normalize(node.innerText || node.textContent || "")))
      .map((node) => normalizeTweetUrl(node.href, true)).filter(Boolean);
    if (originalTweetLinks.length && (!targetIdentity || !originalTweetLinks.every((url) => url === targetIdentity))) {
      return { ok: true, completed: false };
    }
    // The new dispatch receipt removes its target link. It is attributable
    // only when this exact dialog was observed locked to the watched order.
    if (identityScope.getAttribute?.("data-engagement-dispatch") === "true" && !originalTweetLinks.length) {
      const binding = context.navigationBinding;
      if (!targetIdentity || binding?.root !== identityScope || binding.taskKey !== context.taskKey
          || normalizeTweetUrl(binding.tweetUrl, true) !== targetIdentity) return { ok: true, completed: false };
    }
    // Reopening a progress card is only navigation. Its title and reward are
    // not proof of identity: require the official result's original X link.
    if (context.requireExactTarget && (!targetIdentity || !originalTweetLinks.includes(targetIdentity))) {
      return { ok: true, completed: false };
    }
    const links = Array.from(root.querySelectorAll("a[href]"))
      .map((node) => normalizeTweetUrl(node.href, true))
      .filter(Boolean);
    // The paid-result overlay also contains unrelated recommended campaigns.
    // Only use X links as an identity check when the result panel has no
    // recommendation section; the completion watch itself is already scoped
    // to the current run and task and rejects pre-existing result panels.
    const hasRecommendedCampaigns = /继续搞钱|类似任务|推荐任务|查看全部/.test(rootText);
    if (!hasRecommendedCampaigns && links.length && (!targetIdentity || !links.includes(targetIdentity))) {
      return { ok: true, completed: false };
    }
    context.completionRoot = root;
    context.completionFingerprint = rootText;
    context.evidence = { runId: context.runId, taskKey: context.taskKey, tweetUrl: target, observedAt: Date.now(), text: normalize(root.innerText || "").slice(0, 500) };
    return { ok: true, completed: true, evidence: context.evidence };
  }

  async function waitForTaskCompletionAndReturn(settings = {}, message = {}) {
    const started = Date.now();
    const timeoutMs = Math.max(60000, Number(settings.lockSeatTimeoutMs || 0));
    while (true) {
      assertActiveRun(message.runId || activeRunId);
      const completion = checkOfficialCompletion(message);
      const completionConfirmed = completion.completed;
      const completionReturnButton = findCompletionReturnToCampaignsButton(message);
      if (completionConfirmed && completionReturnButton) {
        completionReturnButton.scrollIntoView({ block: "center", inline: "center" });
        await clickElement(completionReturnButton, { beforeClick: () => {
          assertActiveRun(message.runId || activeRunId);
          if (findCompletionReturnToCampaignsButton(message) !== completionReturnButton) {
            throw new Error("完成结果或关闭按钮已变化，保留当前页面");
          }
        } });
        if (await waitForCampaignsReturnAfterCompletion(settings)) {
          return { ok: true, evidence: completion.evidence, message: "Lighthouse 已确认完成，已关闭结果并返回任务广场" };
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
      if (completionConfirmed) {
        // The result panel can omit its return control. Preserve this order's
        // confirmed evidence so the background can recover the campaigns page.
        return {
          ok: false,
          completed: true,
          evidence: completion.evidence,
          message: "官网已确认任务完成；未找到返回任务广场入口，交由后台恢复广场"
        };
      }
      // A backgrounded tab can wake after the deadline with a fresh result.
      // Always inspect that final DOM receipt before returning a timeout.
      if (Date.now() - started >= timeoutMs) break;
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

  function isCompletionCloseCurrent(message) {
    const context = completionContext && completionContext.runId === message.runId
      && completionContext.taskKey === message.task?.taskKey ? completionContext : null;
    const evidence = message.completionEvidence || context?.evidence;
    if (!evidence) return true; // Ordinary unclaimed-detail cleanup has no completion receipt.
    const target = normalizeTweetUrl(message.task?.tweetUrl, true);
    if (!target || evidence.runId !== message.runId || !message.task?.taskKey
        || evidence.taskKey !== message.task.taskKey
        || normalizeTweetUrl(evidence.tweetUrl, true) !== target) return false;
    if (isCampaignsListOpen()) return true;
    if (!context?.evidence) {
      return evidence.source === "lighthouse_x_widget" && Boolean(currentLockedNavigationBinding(message));
    }
    // A saved receipt proves completion, not permission to close a later order.
    // Bind cleanup to the observed DOM result as well as the run and task.
    const roots = findOfficialCompletionRoots();
    const root = context.completionRoot;
    if (roots.length !== 1 || roots[0] !== root
        || getOfficialCompletionRootFingerprint(root) !== context.completionFingerprint) return false;
    const scope = root.closest?.("[role='dialog']") || root;
    const execution = findExecutionDialog();
    if (execution.present && execution.root !== scope) return false;
    const originals = Array.from(scope.querySelectorAll("a[href]"))
      .filter(node => /^查看原推文$/.test(normalize(node.innerText || node.textContent || "")));
    return originals.every(node => normalizeTweetUrl(node.href, true) === target);
  }

  function findCompletionReturnToCampaignsButton(message) {
    if (message && !isCompletionCloseCurrent(message)) return null;
    if (!hasOfficialCompletionEvidence()) return null;

    const dispatchResults = findOfficialCompletionRoots().filter(root => root.classList?.contains("dispatch-completion")
      && root.classList.contains("success")
      && root.closest?.("[role='dialog']")?.getAttribute("data-engagement-dispatch") === "true");
    if (dispatchResults.length) {
      const buttons = dispatchResults.flatMap(root => Array.from(root.querySelectorAll("button")))
        .filter(node => node.closest(".completion-controls") && buttonText(node) === "完成并关闭"
          && isVisible(node) && !isDisabled(node));
      return dispatchResults.length === 1 && buttons.length === 1 ? buttons[0] : null;
    }

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
    return /任务完成[，,]\s*验证通过|任务验证通过|验证成功|奖励已到账|已到账奖励|任务已完成|奖励已结算/.test(text);
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
    return /^(?:任务完成[，,]\s*验证通过|任务验证通过|验证(?:成功|通过)(?:\s*[·•]\s*(?:已通过|奖励已到账|奖励托管中))?|奖励已到账|已到账奖励|任务已完成|奖励已结算)[！!。.]?$/.test(value);
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
        .some((node) => {
          const text = normalize(node.innerText || node.textContent || "");
          if (!isVisible(node) || !isOfficialCompletionMarkerText(text)) return false;
          if (!/^任务完成[，,]\s*验证通过/.test(text)) return true;
          const panel = node.closest?.(".dispatch-completion");
          return node.tagName === "H2" && node.closest?.(".completion-hero")?.getAttribute("role") === "status"
            && panel?.classList.contains("success")
            && panel.closest("[role='dialog']")?.getAttribute("data-engagement-dispatch") === "true";
        }))
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

  async function waitForCampaignsReturnAfterCompletion(settings = {}, beforeCheck) {
    const started = Date.now();
    const timeoutMs = Math.min(Math.max((settings.actionDelayMs || 500) * 8, 4000), 10000);
    while (Date.now() - started < timeoutMs) {
      beforeCheck?.();
      if (isCampaignsListOpen()) return true;
      await wait(250);
    }
    beforeCheck?.();
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

  async function waitForTaskPanelClosed(settings, actionName, beforeCheck) {
    const started = Date.now();
    const timeoutMs = Math.min(Math.max((settings.actionDelayMs || 500) * 4, 2000), 5000);
    while (Date.now() - started < timeoutMs) {
      beforeCheck?.();
      if (!isTaskDetailOrRecoverableOverlayOpen() && isCampaignsListOpen()) return true;
      await wait(250);
    }
    beforeCheck?.();
    report("warn", `${actionName} 后仍未确认任务详情关闭`);
    return false;
  }

  async function clickTaskPanelOutside(beforeClick) {
    const runId = activeRunId;
    assertActiveRun(runId);
    const x = Math.max(24, Math.floor(window.innerWidth * 0.12));
    const y = Math.max(120, Math.floor(window.innerHeight * 0.5));
    const target = document.elementFromPoint(x, y) || document.body;
    await randomClickDelay();
    assertActiveRun(runId);
    for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
      beforeClick?.();
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
      if (hasBlockingTaskFailure(detailText, settings)) {
        throw new Error(extractHardFailureReason(detailText));
      }

      if (await acceptInvitationIfPresent(settings)) {
        continue;
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

  function lockConfirmationEvidence(root) {
    if (!root || root === document.body) return [];
    const evidence = new Set();
    for (const node of root.querySelectorAll?.("button,a,[role='button'],[role='status'],span,p,strong,div") || []) {
      if (!isVisible(node)) continue;
      const text = normalize(buttonText(node));
      if (/^(?:已锁定(?:席位)?|席位已锁定|锁定成功|已领取(?:任务)?|任务已领取|(?:任务)?进行中)$/.test(text)) {
        evidence.add(`status:${text}`);
      }
      // A static timeline label or a preview URL is not a claim receipt.
      if (node.matches?.("button,a[href],[role='button']") && !isDisabled(node)
          && /^(?:去\s*X\s*完成动作|前往\s*X\s*完成动作|在\s*X\s*打开|前往目标|查看推文)$/.test(text)) {
        evidence.add(`action:${text}:${normalizeTweetUrl(node.href || node.getAttribute("href") || "", true)}`);
      }
    }
    return [...evidence];
  }

  function observeLockAttempt(task) {
    const root = findTaskDetailRoot();
    return {
      root, task,
      title: root ? extractTitle(root) : "",
      bounty: parseCandidateBounty(root?.innerText || ""),
      tweetUrl: root ? extractTweetUrl(root) : "",
      evidence: lockConfirmationEvidence(root),
      priorClaimAttempted: Boolean(claimOperation?.claimActionAttempted),
      detailSignature: claimDetailSignature(root),
      rejectionAbsent: !hasHardFailure(normalize(root?.innerText || "")),
      positiveStateAbsent: !hasPositiveClaimState(normalize(root?.innerText || ""), root),
    };
  }

  function hasConfirmedLockedDetail(root, expectedTweetUrl = "") {
    if (!root || root === document.body || root.isConnected === false || !isVisible(root)) return false;
    const target = normalizeTweetUrl(extractTweetUrl(root), true);
    const expected = normalizeTweetUrl(expectedTweetUrl, true);
    if (!target || (expectedTweetUrl && !expected) || (expected && target !== expected)) return false;
    const execution = findExecutionDialog();
    if (execution.present) return execution.root === root && execution.locked
      && normalizeTweetUrl(execution.tweetUrl, true) === target;
    // A disabled claim button can be a request still in flight. Its presence
    // must block this fallback just as an enabled claim button does.
    const claimControls = Array.from(root.querySelectorAll("button,a,[role='button'],input[type='button'],input[type='submit']"))
      .filter((node) => isVisible(node) && node.matches?.("button,a[href],[role='button'],input[type='button'],input[type='submit']"))
      .some((node) => /^(?:锁定席位|锁定名额|抢占席位|领取任务|开始任务|去评论)(?:\s|·|$)/.test(normalize(buttonText(node))));
    if (claimControls) return false;
    const evidence = lockConfirmationEvidence(root);
    return evidence.some(value => /^status:(?:席位已锁定|已锁定席位|锁定成功)$/.test(value))
      && evidence.some(value => /^action:(?:去|前往)\s*X\s*完成动作:/.test(value));
  }

  function isSameLockDetail(observation) {
    const root = findTaskDetailRoot();
    if (!root || root === document.body || root !== observation.root
        || root.isConnected === false || !isVisible(root) || !isTaskDetailOpen()
        || extractTitle(root) !== observation.title
        || parseCandidateBounty(root.innerText || "") !== observation.bounty) return false;
    const tweetUrl = extractTweetUrl(root);
    return !observation.tweetUrl || !tweetUrl
      || normalizeTweetUrl(tweetUrl, true) === normalizeTweetUrl(observation.tweetUrl, true);
  }

  function readBoundOrderOutcome(task, includeCompletion = true) {
    const tweetUrl = normalizeTweetUrl(task?.tweetUrl || "");
    const identity = { taskKey: task?.taskKey || "", tweetUrl };
    if (!identity.taskKey || !tweetUrl) return { ...identity, outcome: "unknown" };
    // Unlike a watch started before submission, recovery has no baseline.
    // A visible official result must identify this exact original tweet;
    // titles, reward totals and recommended tasks cannot identify the order.
    for (const root of includeCompletion ? findOfficialCompletionRoots() : []) {
      const scope = root.closest?.("[role='dialog']") || root;
      const originals = Array.from(scope.querySelectorAll("a[href]"))
        .filter(node => isVisible(node) && normalize(node.innerText || node.textContent || "") === "查看原推文")
        .map(node => normalizeTweetUrl(node.href, true));
      if (originals.length && originals.every(url => url === normalizeTweetUrl(tweetUrl, true))) {
        return { ...identity, outcome: "completed", observedAt: Date.now(),
          text: normalize(root.innerText || "").slice(0, 500) };
      }
    }
    const root = findTaskDetailRoot();
    if (!hasHardFailure(normalize(root?.innerText || "")) && hasConfirmedLockedDetail(root, tweetUrl)) {
      return { ...identity, outcome: "locked", observedAt: Date.now() };
    }
    return { ...identity, outcome: "unknown" };
  }

  function readLockFeedback() {
    // react-hot-toast uses role=status, including while Radix marks its
    // container aria-hidden. These messages can vanish before the timeout.
    return Array.from(document.querySelectorAll(
      "[data-rht-toaster] [role='status'],[data-sonner-toast],[role='alert'],[role='alertdialog']"
    )).filter(isVisible).map(node => ({ node, text: normalize(node.innerText || node.textContent || "") }))
      .filter(item => item.text && item.text.length <= 500);
  }

  function knownLockRefusal(text) {
    const value = text.replace(/\s+/g, "");
    const cooldown = value.match(/^本批名额暂不可领取，请约([1-9]\d{0,3})分钟后重试[。.]?$/);
    if (cooldown) return { retryAfterMs: Number(cooldown[1]) * 60000, claimRetryScope: "task" };
    if (/^你抢的太快了，请30秒后重试[。.]?$/.test(value)) return { retryAfterMs: 30000 };
    if (/^当前没有可锁定的席位，请刷新任务查看最新名额[。.]?$/.test(value)) return { retryAfterMs: 15000 };
    if (/^当前无法接单，请刷新任务后重试[。.]?$/.test(value)) return { retryAfterMs: 30000 };
    return null;
  }

  async function clickAndVerifyLock(button, settings, observation, expectedInvitation = null) {
    const runId = activeRunId;
    const seen = new Map(readLockFeedback().map(item => [item.node, item.text]));
    observation.feedback = [];
    observation.collectFeedback = () => {
      if (activeRunId !== runId || automationPaused || cancelledRunIds.has(runId)) return;
      for (const { node, text } of readLockFeedback()) {
        if (seen.get(node) === text) continue;
        seen.set(node, text);
        // Preserve diagnostic text even when it is not a proven refusal.
        if (observation.feedback.some(item => item.text === text)) continue;
        observation.feedback.push({ text, sameDetail: isSameLockDetail(observation), refusal: knownLockRefusal(text) });
        if (observation.feedback.length > 20) observation.feedback.shift();
        report("info", `锁位即时提示：${text}`);
      }
    };
    const watcher = typeof MutationObserver === "function" ? new MutationObserver(observation.collectFeedback) : null;
    watcher?.observe(document.body, { childList: true, subtree: true, characterData: true });
    try {
      await clickElement(button, { randomDelay: false, claimAction: true,
        beforeClick: expectedInvitation ? () => {
          assertInvitationTarget(expectedInvitation);
          if (!isSameLockDetail(observation) || button.isConnected === false
              || isDisabled(button) || findLockButton() !== button) {
            const error = new Error("邀请任务或锁位按钮已变化，保留本单，未继续锁位");
            error.task = expectedInvitation;
            throw error;
          }
        } : undefined });
      report("info", "已点击锁定席位，等待本单锁位结果");
      observation.collectFeedback();
      await confirmLighthouseGuidanceBeforeClaim(observation);
      await verifyLockClickAccepted(settings, observation);
    } finally {
      watcher?.disconnect();
      delete observation.collectFeedback;
    }
  }

  async function verifyLockClickAccepted(settings, observation) {
    const runId = activeRunId;
    const started = Date.now();
    const timeoutMs = Math.min(Math.max((settings.actionDelayMs || 500) * 4, 15000), 30000);
    while (true) {
      assertActiveRun(runId);
      observation.collectFeedback?.();
      // A claim receipt is the state transition. An earlier notice can stay
      // mounted after that transition and must not shadow the actual order.
      // Use the same exact-order reader as interrupted-run reconciliation.
      if (isSameLockDetail(observation)
          && readBoundOrderOutcome({ ...observation.task,
            // The site reveals the target link only after claiming. Before
            // that transition the same detail may contain only an X button.
            // Keep any known target binding; otherwise bind the newly
            // revealed target only inside this unchanged claim observation.
            tweetUrl: observation.tweetUrl || observation.task?.tweetUrl
              || extractTweetUrl(observation.root) }, false).outcome === "locked") {
        report("info", "已复核本单席位锁定、目标链接和可用 X 入口，接续本单");
        return true;
      }
      // A native dialog or a suspended tab can consume the wall-clock
      // deadline. Reconcile the current receipt once before timing out,
      // without dispatching another confirmation after the deadline.
      if (Date.now() - started < timeoutMs) await confirmLighthouseGuidanceBeforeClaim(observation);
      assertActiveRun(runId);
      if (getLighthousePreClaimNoticeButton()) {
        if (Date.now() - started >= timeoutMs) break;
        await wait(200);
        continue;
      }
      if (isSameLockDetail(observation)) {
        const text = normalize(observation.root.innerText || "");
        const evidence = lockConfirmationEvidence(observation.root);
        if (hasHardFailure(text)) {
          const error = new Error(`锁定点击后失败：${extractHardFailureReason(text)}`);
          // A new refusal may release this click only when no earlier claim,
          // success evidence or unrelated detail change can explain it.
          if (!observation.priorClaimAttempted && observation.rejectionAbsent
              && observation.positiveStateAbsent && !hasPositiveClaimState(text, observation.root)
              && !observation.evidence.length && !evidence.length
              && observation.detailSignature && observation.detailSignature === claimDetailSignature(observation.root)) {
            error.confirmedClaimRejection = true;
            error.task = { ...observation.task, detailText: text.slice(0, 1800), seatLocked: false, claimRejected: true };
          }
          throw error;
        }
        // Some renders already expose the same status/action labels in the
        // baseline. Confirm the current same-order locked state as a whole,
        // not only a text delta, before leaving a real claim stranded.
        if (hasConfirmedLockedDetail(observation.root, observation.tweetUrl || observation.task?.tweetUrl)) {
          report("info", "已复核本单席位锁定、目标链接和可用 X 入口，接续本单");
          return true;
        }
        if (evidence.some(value => !observation.evidence.includes(value))) return true;
        const refusal = observation.feedback?.find(item => item.sameDetail && item.refusal);
        if (refusal && !observation.priorClaimAttempted && observation.rejectionAbsent
            && observation.positiveStateAbsent && !hasPositiveClaimState(text, observation.root)
            && findLockButton() && !observation.evidence.some(value => value.startsWith("status:"))) {
          const error = new Error(`平台明确拒绝本次锁位：${refusal.text}`);
          error.confirmedClaimRejection = true;
          error.retryAfterMs = refusal.refusal.retryAfterMs;
          error.claimRetryScope = refusal.refusal.claimRetryScope;
          error.task = { ...observation.task, detailText: text.slice(0, 1800), seatLocked: false, claimRejected: true };
          throw error;
        }
      }
      if (Date.now() - started >= timeoutMs) break;
      await wait(300);
    }
    const root = findTaskDetailRoot();
    const controls = Array.from(root?.querySelectorAll?.("button,a,[role='button']") || [])
      .filter(isVisible).map(node => `${normalize(buttonText(node))}${isDisabled(node) ? "（不可点击）" : ""}`)
      .filter(Boolean).slice(0, 12).join(" / ");
    const alerts = [...new Set([...(observation.feedback || []).map(item => item.text), ...readLockFeedback().map(item => item.text)])]
      .join(" / ").slice(0, 500);
    report("warn", `锁位核对：同一详情=${isSameLockDetail(observation)}；当前控件=${controls || "无"}；页面提示=${alerts || "无"}；点击前证据=${JSON.stringify(observation.evidence)}；当前证据=${JSON.stringify(lockConfirmationEvidence(root))}`);
    const error = new Error("已点击锁定席位，但未确认本单锁位结果；已保留本次动作，请核对订单后继续");
    error.task = observation.task;
    throw error;
  }

  async function confirmLighthouseGuidanceBeforeClaim(observation = null) {
    // A confirmation can remain mounted while its request is in flight.
    // Keep each step once per lock attempt, even if React replaces its button.
    const submitted = observation && (observation.guidanceSteps ||= new Set());
    let riskNoticeButton = getLighthousePreClaimNoticeButton();
    if (riskNoticeButton) {
      if (submitted?.has("risk")) return true;
      // The notice can replace its action during its entrance render. Wait
      // for that transition and reacquire the current actionable button.
      const runId = activeRunId;
      await wait(400);
      assertActiveRun(runId);
      riskNoticeButton = getLighthousePreClaimNoticeButton();
      if (!riskNoticeButton) return false;
      submitted?.add("risk");
      await clickElement(riskNoticeButton, { randomDelay: false, claimAction: true });
      report("info", "检测到 Lighthouse 锁位前风险提醒，已单次点击确认，等待平台回执");
      await wait(150);
      return true;
    }

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

      if (submitted?.has("guidance")) return true;
      submitted?.add("guidance");
      await clickElement(button, { randomDelay: false, claimAction: true });
      report("info", "检测到 Lighthouse 接单备注引导，已单次点击确认接单");
      await wait(150);
      return true;
    }
    return false;
  }

  function getLighthousePreClaimNoticeButton() {
    const buttons = Array.from(document.querySelectorAll("button,a,[role='button']"))
      .filter((node) => isVisible(node) && !isDisabled(node))
      .filter((node) => /^(?:已了解[，,]?锁定席位)$/.test(normalize(buttonText(node))));

    for (const button of buttons) {
      let scope = button;
      for (let depth = 0; scope && depth < 8; depth += 1) {
        if (scope === document.body || scope === document.documentElement) break;
        const text = normalize(scope.innerText || scope.textContent || "");
        if (/接单前需要注意以下事项/.test(text)
            && /请先阅读下方提醒|目标推文包含外部链接|认真评论/.test(text)
            && /锁定席位/.test(text)) {
          return button;
        }
        scope = scope.parentElement;
      }
    }
    return null;
  }

  function createLockedNavigationBinding(task) {
    try {
      const root = findTaskDetailRoot();
      const tweetUrl = normalizeTweetUrl(task?.tweetUrl || "");
      if (!task?.taskKey || task.seatLocked !== true || !tweetUrl
          || readBoundOrderOutcome(task, false).outcome !== "locked") return null;
      return { root, taskKey: task.taskKey, tweetUrl,
        title: extractTitle(root), bounty: parseCandidateBounty(root.innerText || "") };
    } catch (_) {
      // Navigation proof is optional: a disappearing detail must not reverse
      // an already confirmed claim. A present notice still requires proof.
      return null;
    }
  }

  function currentLockedNavigationBinding(message) {
    const task = message.task;
    const target = normalizeTweetUrl(task?.tweetUrl || "", true);
    if (!message.runId || !task?.taskKey || task.seatLocked !== true || !target) return null;
    const operation = Array.from(settledClaimOperations.values()).reverse().find(value =>
      value.runId === message.runId && value.result?.ok === true
      && value.navigationBinding?.taskKey === task.taskKey
      && normalizeTweetUrl(value.navigationBinding.tweetUrl, true) === target);
    const binding = operation?.navigationBinding
      || (completionContext?.runId === message.runId && completionContext.taskKey === task.taskKey
        ? completionContext.navigationBinding : null);
    const root = findTaskDetailRoot();
    if (!binding || !root || root !== binding.root || !isTaskDetailOpen()
        || normalizeTweetUrl(binding.tweetUrl, true) !== target
        || extractTitle(root) !== binding.title
        || parseCandidateBounty(root.innerText || "") !== binding.bounty
        || readBoundOrderOutcome(task, false).outcome !== "locked") return null;
    return binding;
  }

  function findLockedTaskNoticeButtons() {
    return Array.from(document.querySelectorAll("button,a,[role='button']"))
      .filter(node => isVisible(node) && /^已了解[，,]前往\s*X$/.test(buttonText(node)))
      .filter(button => {
        for (let scope = button, depth = 0; scope && depth < 8; scope = scope.parentElement, depth++) {
          if (scope === document.body || scope === document.documentElement) break;
          const text = normalize(scope.innerText || scope.textContent || "");
          if (/席位已预订[，,]请确认任务提醒/.test(text)
              && /认真评论|目标推文包含外部链接/.test(text)) return true;
        }
        return false;
      });
  }

  async function confirmLockedTaskNotice(message) {
    const execution = findExecutionDialog();
    if (execution.present) {
      if (message.targetAlreadyOpen && execution.phase === "working") {
        assertActiveRun(message.runId);
        return { ...readExecutionState(message), noticePresent: true, noticeClicked: false };
      }
      return performExecutionAction(message, "open");
    }
    const runId = message.runId;
    assertActiveRun(runId);
    const receipt = { runId, taskKey: message.task?.taskKey || "",
      tweetUrl: normalizeTweetUrl(message.task?.tweetUrl || ""), noticePresent: false,
      noticeClicked: false, pending: false };
    const buttons = findLockedTaskNoticeButtons();
    if (!buttons.length) return { ...receipt, ok: true };
    const binding = currentLockedNavigationBinding(message);
    if (!binding) return { ...receipt, ok: false, message: "未确认本单锁定位及目标，未操作任务提醒" };
    const key = JSON.stringify([runId, binding.taskKey, normalizeTweetUrl(binding.tweetUrl, true)]);
    const existing = lockedTaskNotices.get(key);
    if (existing?.clicked) return { ...receipt, ok: true,
      noticePresent: findLockedTaskNoticeButtons().length > 0, alreadyConfirmed: true };
    if (existing?.promise) return existing.promise;
    if (buttons.length !== 1) return { ...receipt, ok: false, noticePresent: true, pending: true,
      message: "任务提醒存在多个确认按钮，未自动操作" };
    if (isDisabled(buttons[0])) return { ...receipt, ok: true, noticePresent: true, pending: true };
    const state = existing || { clicked: false, promise: null };
    lockedTaskNotices.set(key, state);
    if (lockedTaskNotices.size > 40) lockedTaskNotices.delete(lockedTaskNotices.keys().next().value);
    const pending = (async () => {
      // Reacquire an entering/rerendered dialog and its same-order proof before
      // the navigation click. This is not a second claim confirmation.
      await wait(150);
      assertActiveRun(runId);
      if (currentLockedNavigationBinding(message) !== binding) {
        return { ...receipt, ok: false, message: "任务详情已变化，未操作旧订单提醒" };
      }
      const current = findLockedTaskNoticeButtons();
      if (!current.length) return { ...receipt, ok: true };
      if (current.length !== 1 || isDisabled(current[0])) {
        return { ...receipt, ok: current.length === 1, noticePresent: true, pending: true };
      }
      state.clicked = true;
      await clickElement(current[0], { randomDelay: false, beforeClick: () => {
        assertActiveRun(runId);
        if (currentLockedNavigationBinding(message) !== binding) throw new Error("任务详情已变化，未前往 X");
      } });
      report("info", "已确认本单锁位后任务提醒，单次点击前往 X，等待官网打开目标");
      return { ...receipt, ok: true, noticePresent: true, noticeClicked: true };
    })();
    state.promise = pending;
    try { return await pending; }
    finally { if (state.promise === pending) state.promise = null; }
  }

  function extractDetailUnavailableReason(text) {
    if (hasBlockingTaskFailure(text)) return extractHardFailureReason(text);
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
      if (findStandaloneInvitation()) return true;
      const text = document.body?.innerText || "";
      const hasCampaignShell = location.pathname.includes("/campaigns");
      const hasTaskList = COMMENT_MARKERS.concat(COMMENT_EQUIVALENT_MARKERS).some((marker) => text.includes(marker)) || text.includes("任务广场") || text.includes("Task Hall");
      const hasCards = collectVisibleTaskLikeNodes().length > 0;
      if (hasCampaignShell && hasTaskList && (hasCards || (
          hasLoadedCampaignListShell()
          && !hasOfficialCompletionEvidence()
          && !isTaskDetailOrRecoverableOverlayOpen()
          && !isTaskDetailOpen()))) return true;
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
    const taskType = mergeTaskTypes(taskTypeHint, detectCandidateTaskType(detailRoot, detailRoot.innerText || ""));
    return {
      source: "lighthouse",
      title: extractTitle(detailRoot),
      tweetUrl: extractTweetUrl(detailRoot),
      taskType: taskType || "评论",
      taskKey: buildTaskKey(detailText),
      detailText,
      createdAt: new Date().toISOString()
    };
  }

  function findExecutionDialog() {
    const roots = Array.from(document.querySelectorAll("[role='dialog']"))
      .filter(root => root.getAttribute?.("role") === "dialog" && isVisible(root))
      .filter(root => Array.from(root.querySelectorAll("h1,h2,h3,[role='heading']"))
        .some(node => isVisible(node) && normalize(buttonText(node)) === "任务执行与验证"));
    if (!roots.length) return { present: false };
    if (roots.length !== 1) return { present: true, ambiguous: true };
    const root = roots[0];
    const labels = Array.from(root.querySelectorAll("h1,h2,h3,p,[role='status']"))
      .filter(isVisible).map(node => normalize(buttonText(node)));
    const phase = labels.includes("接单成功，开始任务吧") ? "claimed"
      : labels.includes("完成任务后，回来验证") ? "working" : "unknown";
    const targets = Array.from(root.querySelectorAll("a[href]"))
      .filter(node => isVisible(node) && normalize(node.getAttribute("aria-label") || buttonText(node)) === "查看目标推文")
      .map(node => normalizeTweetUrl(node.href || node.getAttribute("href")));
    const tweetUrl = targets.length && targets.every(Boolean)
      && new Set(targets.map(url => normalizeTweetUrl(url, true))).size === 1 ? targets[0] : "";
    const controls = Array.from(root.querySelectorAll("button,[role='button']")).filter(isVisible);
    const exactControls = pattern => controls.filter(node => pattern.test(normalize(buttonText(node)).replace(/[↗→]/g, "").trim()));
    const open = exactControls(/^(?:去完成任务|打开目标推文)$/);
    const verify = exactControls(/^我已完成[，,]开始验证$/);
    const claimControl = controls.some(node => /^(?:锁定席位|锁定名额|抢占席位|领取任务|开始任务|接受并开始)(?:\s|·|$)/.test(normalize(buttonText(node))));
    const locked = Boolean(tweetUrl && ["claimed", "working"].includes(phase) && !claimControl
      && labels.some(text => /^席位已锁定[，,]\s*请使用绑定的\s*X\s*账号完成任务[。.]?$/.test(text)));
    return { present: true, root, phase, tweetUrl, locked,
      open: open.length === 1 ? open[0] : null, verify: verify.length === 1 ? verify[0] : null };
  }

  function readExecutionState(message) {
    const execution = findExecutionDialog();
    const expected = normalizeTweetUrl(message.task?.tweetUrl, true);
    const matches = Boolean(message.task?.taskKey && expected
      && normalizeTweetUrl(execution.tweetUrl, true) === expected);
    return { ok: !execution.present || (matches && execution.locked), present: execution.present,
      runId: message.runId, taskKey: message.task?.taskKey || "", tweetUrl: execution.tweetUrl || "",
      phase: execution.phase || "unknown", locked: execution.locked === true,
      canVerify: Boolean(matches && execution.locked && execution.phase === "working"
        && execution.verify && !isDisabled(execution.verify)),
      message: execution.present && (!matches || !execution.locked) ? "执行弹窗尚未确认本单目标和锁位，保留订单" : "" };
  }

  async function performExecutionAction(message, action) {
    const runId = message.runId;
    const task = message.task;
    const target = normalizeTweetUrl(task?.tweetUrl, true);
    const receipt = { runId, taskKey: task?.taskKey || "", tweetUrl: task?.tweetUrl || "",
      noticePresent: action === "open", noticeClicked: false, actionAttempted: false };
    assertActiveRun(runId);
    if (!task?.taskKey || !target || (action === "open" && task.seatLocked !== true)
        || (action === "verify" && (message.xActionsCompleted !== true
          || message.settings?.autoSubmitLighthouse !== true || message.settings?.replyMode !== "post"))) {
      return { ...receipt, ok: false, message: "缺少本单动作完成凭据，未操作执行弹窗" };
    }
    const key = JSON.stringify(["execution", action, runId, task.taskKey, target]);
    const previous = lockedTaskNotices.get(key);
    if (previous?.clicked) return { ...receipt, ok: true, alreadyConfirmed: true,
      submitted: action === "verify", actionAttempted: true };
    if (previous?.promise) return previous.promise;
    const initial = findExecutionDialog();
    const matches = current => current.root && current.root === initial.root && current.locked
      && normalizeTweetUrl(current.tweetUrl, true) === target;
    if (!matches(initial) || (action === "verify" && initial.phase !== "working")) {
      return { ...receipt, ok: false, message: "执行弹窗状态或目标不匹配，未操作其他订单" };
    }
    const state = { clicked: false, promise: null };
    lockedTaskNotices.set(key, state);
    if (lockedTaskNotices.size > 40) lockedTaskNotices.delete(lockedTaskNotices.keys().next().value);
    state.promise = (async () => {
      await wait(150);
      assertActiveRun(runId);
      const current = findExecutionDialog();
      const button = current[action];
      if (!matches(current) || !button || isDisabled(button)
          || (action === "verify" && current.phase !== "working")) {
        return { ...receipt, ok: false, message: "本单执行按钮尚不可用或页面已变化，未点击" };
      }
      await clickElement(button, { randomDelay: false, beforeClick: () => {
        const fresh = findExecutionDialog();
        assertActiveRun(runId);
        if (!matches(fresh) || fresh[action] !== button || isDisabled(button)
            || (action === "verify" && fresh.phase !== "working")) throw new Error("本单执行页面已变化，取消旧按钮操作");
        state.clicked = true;
      } });
      report("info", action === "open" ? "已点击本单去完成任务，等待官网打开目标 X"
        : "已点击本单我已完成，开始验证；等待官网结果，不重复提交");
      return { ...receipt, ok: true, actionAttempted: true, noticeClicked: action === "open", submitted: action === "verify" };
    })();
    try { return await state.promise; }
    finally {
      state.promise = null;
      if (!state.clicked && lockedTaskNotices.get(key) === state) lockedTaskNotices.delete(key);
    }
  }

  function findTaskDetailRoot() {
    const execution = findExecutionDialog();
    if (execution.present) return execution.root || null;
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
      // Plaza cards (and their list wrappers) can say "前往目标" too.
      // Their text cannot keep a closed task dialog artificially open.
      .filter(node => node.getAttribute("role") === "dialog"
        || (!node.closest("article[role='button']") && !node.querySelector("article[role='button']")))
      .map((node) => ({ node, text: normalize(node.innerText || node.textContent || ""), rect: node.getBoundingClientRect() }))
      .filter((entry) => entry.text.includes("LUX") && DETAIL_MARKERS.some((marker) => entry.text.includes(marker)))
      .filter((entry) => entry.rect.width > 240 && entry.rect.height > 180)
      .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));
    return candidates[0]?.node || null;
  }

  function extractTweetUrl(root = document) {
    // In the execution dialog the target is an icon link, labelled through
    // aria-label. Do not pick another status link from the tweet's prose.
    const labelled = Array.from(root.querySelectorAll?.("a[href]") || [])
      .filter(node => isVisible(node) && normalize(node.getAttribute("aria-label") || buttonText(node)) === "查看目标推文");
    if (labelled.length) {
      const urls = labelled.map(node => normalizeTweetUrl(node.href || node.getAttribute("href")));
      return urls.every(Boolean) && new Set(urls.map(url => normalizeTweetUrl(url, true))).size === 1 ? urls[0] : "";
    }
    const anchorUrl = Array.from(root.querySelectorAll?.("a[href]") || [])
      .map((anchor) => normalizeTweetUrl(anchor.href))
      .find(Boolean);
    if (anchorUrl) return anchorUrl;

    const textUrls = normalize(root.innerText || root.textContent || "").match(/https:\/\/[^\s<>"')]+/gi) || [];
    return textUrls.map(url => normalizeTweetUrl(url)).find(Boolean) || "";
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
    if (/账户风险中|等待审核|风险审核/.test(normalize(text))) return "账户风险中，等待审核";
    return getEligibilityBlockReason(text) || HARD_FAIL_MARKERS.find((marker) => text.includes(marker)) || "任务不可做";
  }

  function hasAccountRiskReviewBlock(text) {
    const value = normalize(text).replace(/\s+/g, "");
    return ACCOUNT_RISK_REVIEW_MARKERS.some((marker) => value.includes(marker));
  }

  function parseCooldownFromCard(card, fallbackText) {
    const monitorParser = globalThis.__lighthouseHighBountyMonitor__?.parseStatusFromCard;
    if (typeof monitorParser === "function") {
      try {
        const status = monitorParser(card);
        if (status?.isBlocked) {
          return { remainingMs: 0, text: status.rawText || "不可接", source: "monitor", isBlocked: true };
        }
        if (status?.isCooling) {
          const countdownSec = Math.max(0, Number(status.countdownSec) || 0);
          return {
            remainingMs: countdownSec > 0 ? countdownSec * 1000 : Number.POSITIVE_INFINITY,
            text: status.countdown || status.rawText || "冷却中",
            source: "monitor"
          };
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
    if (/账户风险中|等待审核|风险审核/.test(value)) return false;
    if (value.includes("冷却") || value.includes("后可")) return true;
    return /等待(?:下一批|下一波)?(?:席位)?(?:释放|开放)?\s*[·:：-]?\s*(?=\d{1,2}:\d{2}|\d+\s*(?:h(?![A-Za-z])|hr|hour|小时|时|min|m(?![A-Za-z])|分钟|分|sec|s(?![A-Za-z])|秒))/i.test(value)
      || /等待(?:下一批|下一波)(?:席位)?(?:释放|开放)|(?:下一批|下一波).{0,40}(?:席位|释放|开放)/i.test(value);
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
      const stored = await chrome.runtime.sendMessage({ type: "GET_CONTENT_SETTINGS" });
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

  async function writeClaimCheckpoint(operation, phase) {
    assertActiveRun(operation.runId);
    if (claimOperation !== operation) throw new Error("接单操作已被替换，未允许点击");
    const receipt = await chrome.runtime.sendMessage({
      type: "LIGHTHOUSE_CLAIM_CHECKPOINT", version: 1, phase,
      runId: operation.runId, operationType: operation.type,
      claimIntentId: operation.claimIntentId, instanceId: INSTANCE_ID,
      ...(phase === "before_click" && operation.invitationTask ? { invitationTask: operation.invitationTask } : {})
    });
    assertActiveRun(operation.runId);
    if (claimOperation !== operation || receipt?.ok !== true || receipt.checkpointRegistered !== true
        || receipt.claimIntentId !== operation.claimIntentId || receipt.instanceId !== INSTANCE_ID
        || (phase === "before_click" && receipt.permitClaimClick !== true)) {
      throw new Error("后台未确认接单检查点，尚未点击接单");
    }
  }

  async function clickElement(node, options = {}) {
    const runId = activeRunId;
    assertActiveRun(runId);
    if (options.randomDelay !== false) {
      await randomClickDelay();
    }
    assertActiveRun(runId);
    if (claimOperation) assertActiveRun(claimOperation.runId);
    options.beforeClick?.();
    // Mark before dispatch: a handler can perform the action and then throw.
    // Invitation/confirmation buttons can claim an order just like a lock.
    if (options.claimAction && claimOperation) {
      const operation = claimOperation;
      if (operation.checkpointRequired) await writeClaimCheckpoint(operation, "before_click");
      assertActiveRun(runId);
      options.beforeClick?.();
      operation.claimActionAttempted = true;
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
    sendRuntimeMessage({ type: "LIGHTHOUSE_TASK_DONE", runId: activeRunId, result });
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
      if (options.allowInvitation && findStandaloneInvitation()) return { phase: "invitation_pending" };
      let snapshot = getLighthousePageSnapshot();
      if (options.requireInvitationResolved && snapshot.phase === "detail_ready"
          && findInvitationAcceptButton({ includeDisabled: true })) {
        snapshot = { ...snapshot, phase: "invitation_pending" };
      }
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
      invitation_pending: "邀请接单仍待确认",
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
    if (automationPaused || !activeRunId || cancelledRunIds.has(activeRunId)) return;
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
    if (globalThis.__lighthouseCommentTaskRunnerLighthouseSingleton__?.paused) throw new Error("运行已停止，页面自动操作已暂停");
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
  automationPauseReady = loadAutomationPause();
})();
