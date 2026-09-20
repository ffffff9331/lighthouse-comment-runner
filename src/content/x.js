(function () {
  const SINGLETON_KEY = "__lighthouseCommentTaskRunnerXSingleton__";
  const RUN_LOCK_KEY = "__lighthouseCommentTaskRunnerXRunLock__";
  const SCRIPT_VERSION = "0.7.83";
  const INSTANCE_ID = `x-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const RESERVED_X_HANDLE_SLUGS = new Set(["home", "explore", "notifications", "messages", "jobs", "i", "settings"]);
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

  const stepResults = new Map();
  let activeStepKey = "";
  let activeStepName = "";
  let activeStepStartedAt = 0;
  let activeTargetUrl = "";
  let activeRunId = "";
  const cancelledRunIds = new Set();
  let taskWidgetObserver = null;
  let taskWidgetDebounceTimer = null;
  let taskWidgetAssistDisabled = false;
  let lastTaskWidgetKey = "";
  let cachedTaskWidgetControls = null;
  const TASK_WIDGET_CONTROL_SELECTOR = "button,a,[role='button'],[aria-label],[title],[tabindex]";
  const TASK_WIDGET_CLICKABLE_SELECTOR = "button,a,[role='button'],[tabindex]";

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (globalThis[SINGLETON_KEY]?.instanceId !== INSTANCE_ID) return false;
    if (message.type === "CANCEL_X_RUN") {
      if (message.runId) cancelledRunIds.add(message.runId);
      if (!message.runId || message.runId === activeRunId) activeRunId = `cancelled-${Date.now()}`;
      sendResponse({ ok: true });
      return true;
    }

    const actions = {
      RUN_X_REPLY: () => runReply(message.task, message.settings),
      RUN_X_WIDGET_CLAIM: () => runTaskWidgetClaim(message.task, message.settings),
      CLICK_X_TASK_VERIFY: () => completeTaskWidgetLifecycle(message.settings),
      COMPLETE_X_TASK_WIDGET: () => completeTaskWidgetLifecycle(message.settings)
    };
    if (!actions[message.type]) return false;
    executeXStep(message, actions[message.type]).then(sendResponse);
    return true;
  });

  function executeXStep(message, action) {
    const target = normalizeTweetUrl(message.task?.tweetUrl || "");
    if (!message.runId || message.platform !== "lighthouse" || !target || target !== normalizeTweetUrl(location.href)) {
      return Promise.resolve({ ok: false, message: "拒绝执行：平台或当前任务推文不匹配" });
    }
    if (cancelledRunIds.has(message.runId)) return Promise.resolve({ ok: false, cancelled: true, message: "任务已取消" });
    const step = message.type === "CLICK_X_TASK_VERIFY" ? "COMPLETE_X_TASK_WIDGET" : message.type;
    const key = [message.runId, message.task.taskKey || target, target, step].join("|");
    if (stepResults.has(key)) return stepResults.get(key);
    if (activeStepKey || globalThis[RUN_LOCK_KEY]?.active) {
      return Promise.resolve({ ok: false, conflict: true, message: "另一任务步骤仍在执行，未触发新操作" });
    }
    activeStepKey = key;
    activeStepName = step;
    activeStepStartedAt = Date.now();
    activeTargetUrl = target;
    activeRunId = message.runId;
    globalThis[RUN_LOCK_KEY] = { active: true, runId: message.runId, instanceId: INSTANCE_ID };
    const promise = Promise.resolve().then(() => {
      assertActiveRun(message.runId);
      return action();
    }).then((result) => {
      assertActiveRun(message.runId);
      return result;
    })
      .catch((error) => ({ ok: false, message: error.message || String(error) }))
      .finally(() => {
        activeStepKey = "";
        activeStepName = "";
        activeStepStartedAt = 0;
        if (globalThis[RUN_LOCK_KEY]?.instanceId === INSTANCE_ID) globalThis[RUN_LOCK_KEY].active = false;
      });
    stepResults.set(key, promise);
    if (stepResults.size > 60) stepResults.delete(stepResults.keys().next().value);
    return promise;
  }

  startTaskWidgetAssist();

  async function runReply(task, settings) {
    const runId = activeRunId;
    await waitForPageReady();
    assertActiveRun(runId);
    assertNotLoginWall();
    const tweet = scrapeCurrentTweet(task);
    // Fire AI generation before the human-theatre steps so the network call
    // overlaps with reading simulation, likes and dedupe scans.
    const localDedupe = await queryLocalReplyHistory(tweet, task);
    const aiPromise = localDedupe.replied ? null : chrome.runtime.sendMessage({
      type: "GENERATE_AI_REPLY",
      runId,
      tweet,
      task
    });
    // Early exits (follow failure, like-only tasks, dedupe hits) never await
    // this; mark it handled so a late rejection cannot surface as unhandled.
    // Awaiting it below still rethrows on the normal path.
    if (aiPromise) aiPromise.catch(() => {});
    await simulateReadingBeforeReply(settings);
    assertActiveRun(runId);

    const taskActions = inferTaskActions(task);
    const followResult = taskActions.needsFollow
      ? await followCurrentTweetAuthorIfNeeded(settings)
      : { ok: true, status: "not_required", message: "当前任务不要求关注" };
    if (!followResult.ok) {
      return {
        ok: false,
        message: followResult.message || "关注主推文作者失败",
        mode: "follow",
        tweet,
        follow: followResult,
        xInstanceId: INSTANCE_ID
      };
    }
    const likeResult = taskActions.needsLike
      ? await likeCurrentTweetIfNeeded(settings)
      : { ok: true, status: "not_required", message: "当前任务不要求点赞" };
    if (!taskActions.needsComment) {
      assertActiveRun(runId);
      return {
        ok: likeResult.ok && followResult.ok,
        message: taskActions.needsFollow && taskActions.needsLike
          ? "已完成关注和点赞任务"
          : (taskActions.needsFollow ? followResult.message : (likeResult.message || "已完成点赞任务")),
        mode: taskActions.needsFollow ? "follow" : "like",
        tweet,
        follow: followResult,
        like: likeResult,
        xInstanceId: INSTANCE_ID
      };
    }

    const dedupeResult = await detectExistingReplyBeforeWriting(tweet, task, settings);
    if (dedupeResult.replied) {
      return buildDedupeReplyResult(tweet, dedupeResult, likeResult);
    }

    const aiResponse = await aiPromise;
    if (!aiResponse || !aiResponse.ok || !aiResponse.replyText) {
      throw new Error(aiResponse?.error || "AI 回复生成失败");
    }

    const replyText = aiResponse.replyText;
    if (settings.replyProvider === "sola_bridge") {
      assertActiveRun(runId);
      const bridged = await trySolaBridge({ ...(task || {}), replyText, tweet }, settings);
      if (bridged.ok) return { ...bridged, replyText, tweet };
    }

    assertActiveRun(runId);
    await openReplyComposer(settings);
    await fillReplyText(replyText, settings);

    if (settings.replyMode === "fill") {
      return {
        ok: true,
        message: "已按 Sola 规则生成并填入回复，等待人工确认或下一步",
        mode: "fill",
        replyText,
        tweet,
        like: likeResult,
        xInstanceId: INSTANCE_ID
      };
    }

    assertActiveRun(runId);
    const postResult = await clickPostButtonAndVerify(settings);
    return {
      ok: true,
      message: postResult.message || "已按 Sola 流程发送 X 回复并确认成功",
      mode: "post",
      replyText,
      tweet,
      follow: followResult,
      like: likeResult,
      xInstanceId: INSTANCE_ID,
      verify: postResult
    };
  }

  function scrapeCurrentTweet(task) {
    const article = findMainTweetArticle();
    const text = cleanTweetText(article ? article.innerText : document.body.innerText);
    const authorHandle = extractAuthorHandle(article);
    const authorName = extractAuthorName(article);
    return {
      url: normalizeTweetUrl(location.href) || task?.tweetUrl || "",
      text,
      authorHandle,
      authorName
    };
  }

  function inferTaskActions(task = {}) {
    const taskType = normalizeText(task.taskType || "").toLowerCase();
    const declaredComment = /评论|回复|comment|reply/i.test(taskType);
    const declaredLike = /点赞|like/i.test(taskType);
    const declaredFollow = /关注|follow/i.test(taskType);
    const widget = findLighthouseTaskWidget();
    let requirementText = normalizeText(widget?.innerText || "");

    if (!requirementText.includes("停留时长") || !/(当前任务|要完成)/.test(requirementText)) {
      const panel = queryAccessibleElements("div,section,article")
        .filter((node) => isVisible(node))
        .map((node) => ({ node, text: normalizeText(node.innerText || node.textContent || "") }))
        .filter((entry) => entry.text.includes("停留时长") && /(当前任务|要完成)/.test(entry.text))
        .sort((a, b) => {
          const aRect = a.node.getBoundingClientRect();
          const bRect = b.node.getBoundingClientRect();
          return (aRect.width * aRect.height) - (bRect.width * bRect.height);
        })[0];
      requirementText = panel?.text || requirementText;
    }

    const hasRequirements = requirementText.includes("停留时长") && /(当前任务|要完成)/.test(requirementText);
    const needsComment = hasRequirements
      ? /要完成[\s\S]{0,100}(评论|回复)/.test(requirementText)
      : (declaredComment || (!declaredLike && !declaredFollow));
    const needsLike = hasRequirements
      ? /要完成[\s\S]{0,100}(点赞|喜欢|like)/i.test(requirementText)
      : declaredLike;
    const needsFollow = hasRequirements
      ? /要完成[\s\S]{0,100}(关注|follow)/i.test(requirementText)
      : declaredFollow;

    return { needsComment, needsLike, needsFollow, requirementText, source: hasRequirements ? "x_widget" : "task_type" };
  }

  function startTaskWidgetAssist() {
    if (taskWidgetAssistDisabled || taskWidgetObserver || !normalizeTweetUrl(location.href)) return;
    taskWidgetObserver = new MutationObserver(scheduleTaskWidgetScan);
    taskWidgetObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    scheduleTaskWidgetScan();
  }

  function scheduleTaskWidgetScan() {
    if (taskWidgetAssistDisabled) return;
    if (taskWidgetDebounceTimer) clearTimeout(taskWidgetDebounceTimer);
    taskWidgetDebounceTimer = setTimeout(scanTaskWidget, 900);
  }

  function scanTaskWidget() {
    if (taskWidgetAssistDisabled) return;
    if (!normalizeTweetUrl(location.href)) return;
    const widget = findLighthouseTaskWidget();
    if (!widget) return;

    const state = readTaskWidgetState(widget);
    if (!state || state.kind === "idle") return;

    const key = `${state.kind}|${state.actionText}|${state.countdownSec}|${normalizeTweetUrl(location.href)}`;
    if (key === lastTaskWidgetKey) return;
    lastTaskWidgetKey = key;

    sendTaskWidgetHint(state, normalizeTweetUrl(location.href));
  }

  function sendTaskWidgetHint(state, tweetUrl) {
    try {
      chrome.runtime.sendMessage({ type: "X_TASK_WIDGET_HINT", state, tweetUrl }).catch?.((error) => {
        if (isExtensionContextInvalidatedError(error)) disableTaskWidgetAssist();
      });
      return true;
    } catch (error) {
      if (!isExtensionContextInvalidatedError(error)) throw error;
      disableTaskWidgetAssist();
      return false;
    }
  }

  function disableTaskWidgetAssist() {
    taskWidgetAssistDisabled = true;
    if (taskWidgetDebounceTimer) clearTimeout(taskWidgetDebounceTimer);
    taskWidgetDebounceTimer = null;
    taskWidgetObserver?.disconnect();
    taskWidgetObserver = null;
  }

  function isExtensionContextInvalidatedError(error) {
    return /Extension context invalidated/i.test(String(error?.message || error || ""));
  }

  function findLighthouseTaskWidget() {
    const byAction = findTaskWidgetByActionButton();
    if (byAction) return byAction;

    const replyBox = findExistingReplyBox();
    const candidates = [];
    if (replyBox) {
      const article = replyBox.closest?.("article");
      if (article) candidates.push(article);
      let current = replyBox;
      for (let depth = 0; current && depth < 10; depth += 1) {
        candidates.push(current);
        current = current.parentElement;
      }
    }
    candidates.push(...Array.from(document.querySelectorAll("button,a,[role='button']")));

    return candidates
      .filter((node) => node && isVisible(node))
      .map((node) => findTaskWidgetContainer(node))
      .find(Boolean) || null;
  }

  function findTaskWidgetByActionButton() {
    const cached = getCachedTaskWidgetControls();
    if (cached?.container) return cached.container;

    const replyBox = findExistingReplyBox();
    const pair = findTaskWidgetControlPair(replyBox);
    if (pair) {
      cachedTaskWidgetControls = pair;
      return pair.container;
    }

    const entries = Array.from(document.querySelectorAll("button,a,[role='button']"))
      .filter((node) => isVisible(node))
      .map((node) => ({ node, text: getNodeActionText(node) }))
      .filter((entry) => isTaskWidgetActionText(entry.text));

    const ranked = entries
      .map((entry) => ({
        node: findTaskWidgetActionScope(entry.node, replyBox) || findTaskWidgetContainer(entry.node),
        score: scoreTaskWidgetActionText(entry.text, entry.node, replyBox),
        text: entry.text
      }))
      .filter((entry) => entry.node)
      .sort((a, b) => b.score - a.score);

    return ranked[0]?.node || null;
  }

  function getCachedTaskWidgetControls() {
    if (!cachedTaskWidgetControls) return null;
    const { container, claimButton, verifyButton } = cachedTaskWidgetControls;
    if (container?.isConnected && claimButton?.isConnected && verifyButton?.isConnected && isVisible(container)) {
      return cachedTaskWidgetControls;
    }
    cachedTaskWidgetControls = null;
    return null;
  }

  function findTaskWidgetControlPair(replyBox = null) {
    const buttons = collectTaskWidgetActionEntries(replyBox);

    const claimButtons = buttons.filter((entry) => isClaimCandidateText(entry.text));
    const verifyButtons = buttons.filter((entry) => isVerifyCandidateText(entry.text));
    const pairs = [];

    for (const claim of claimButtons) {
      for (const verify of verifyButtons) {
        if (claim.node === verify.node) continue;
        const sameRow = Math.abs(centerY(claim.rect) - centerY(verify.rect)) <= 42;
        const closeEnough = Math.abs(centerX(claim.rect) - centerX(verify.rect)) <= 220;
        if (!sameRow || !closeEnough) continue;
        const container = findSharedTaskWidgetContainer(claim.node, verify.node) || findTaskWidgetActionScope(claim.node, replyBox);
        if (!container) continue;
        pairs.push({
          container,
          claimButton: claim.node,
          verifyButton: verify.node,
          score: scoreControlPair(claim, verify)
        });
      }
    }

    return pairs.sort((a, b) => b.score - a.score)[0] || null;
  }

  function collectTaskWidgetActionEntries(replyBox = null) {
    const nodes = new Set();
    document.querySelectorAll("button,a,[role='button'],[aria-label],[title],[tabindex],div,span").forEach((node) => {
      if (!isVisible(node)) return;
      const text = getNodeActionText(node);
      if (isTaskWidgetActionText(text)) nodes.add(resolveActionClickableNode(node));
    });

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return isTaskWidgetActionText(normalizeText(node.nodeValue || "")) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (parent && isVisible(parent)) nodes.add(resolveActionClickableNode(parent));
    }

    return [...nodes]
      .filter((node) => node && isVisible(node))
      .map((node) => ({
        node,
        text: getNodeActionText(node),
        rect: node.getBoundingClientRect()
      }))
      .filter((entry) => entry.text && isTaskWidgetActionText(entry.text) && isNearReplyComposer(entry.node, replyBox));
  }

  function resolveActionClickableNode(node) {
    if (!node) return null;
    const direct = node.closest?.("button,a,[role='button'],[tabindex]");
    if (direct && isVisible(direct)) return direct;

    const rect = node.getBoundingClientRect?.();
    if (rect && rect.width > 0 && rect.height > 0) {
      const points = [
        [centerX(rect), centerY(rect)],
        [rect.left + Math.min(rect.width - 1, 8), centerY(rect)],
        [rect.right - Math.min(rect.width - 1, 8), centerY(rect)]
      ];
      for (const [x, y] of points) {
        const hit = document.elementFromPoint(x, y);
        const clickable = hit?.closest?.("button,a,[role='button'],[tabindex]");
        if (clickable && isVisible(clickable)) return clickable;
      }
    }

    return node;
  }

  function findSharedTaskWidgetContainer(a, b) {
    const ancestors = [];
    let current = a;
    for (let depth = 0; current && depth < 9; depth += 1) {
      ancestors.push(current);
      current = current.parentElement;
    }
    current = b;
    for (let depth = 0; current && depth < 9; depth += 1) {
      if (ancestors.includes(current) && isVisible(current)) {
        const rect = current.getBoundingClientRect();
        if (rect.width <= Math.min(window.innerWidth, 780) && rect.height <= 300) return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  function scoreControlPair(claim, verify) {
    let score = 100;
    if (/抢单/.test(claim.text)) score += 80;
    if (/验证/.test(verify.text)) score += 60;
    score += Math.max(0, 140 - Math.abs(centerY(claim.rect) - centerY(verify.rect)));
    score += Math.max(0, 240 - Math.abs(centerX(claim.rect) - centerX(verify.rect)));
    return score;
  }

  function centerX(rect) {
    return rect.left + rect.width / 2;
  }

  function centerY(rect) {
    return rect.top + rect.height / 2;
  }

  function getNodeActionText(node) {
    return normalizeText([
      node?.innerText,
      node?.textContent,
      node?.getAttribute?.("aria-label"),
      node?.getAttribute?.("title")
    ].filter(Boolean).join(" "));
  }

  function isTaskWidgetActionText(text) {
    return /抢单|抢|接任务|领取任务|锁定席位|开始任务|席位已满|重抢|验证|提交验证|完成上面步骤解锁|提交任务|完成任务|打开任务广场/.test(text || "");
  }

  function findTaskWidgetActionScope(node, replyBox = null) {
    let current = node;
    for (let depth = 0; current && depth < 9; depth += 1) {
      if (!isVisible(current)) {
        current = current.parentElement;
        continue;
      }
      const rect = current.getBoundingClientRect();
      if (rect.width > Math.min(window.innerWidth, 780) || rect.height > 260) {
        current = current.parentElement;
        continue;
      }
      const actionButtons = Array.from(current.querySelectorAll?.("button,a,[role='button']") || [])
        .filter((item) => isVisible(item))
        .map((item) => getNodeActionText(item))
        .filter(isTaskWidgetActionText);
      if (actionButtons.length >= 1 && isNearReplyComposer(current, replyBox)) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  function isNearReplyComposer(node, replyBox = null) {
    if (!replyBox || !isVisible(replyBox)) return true;
    const rect = node.getBoundingClientRect();
    const replyRect = replyBox.getBoundingClientRect();
    const horizontallyOverlaps = rect.right >= replyRect.left - 40 && rect.left <= replyRect.right + 80;
    const verticallyNear = rect.bottom <= replyRect.top + 80 && replyRect.top - rect.top < Math.max(360, window.innerHeight * 0.45);
    return horizontallyOverlaps && verticallyNear;
  }

  function findExistingReplyBox() {
    const selectors = '[data-testid="tweetTextarea_0"], [contenteditable="true"][role="textbox"], div[contenteditable="true"]';
    const mainArticle = findMainTweetArticle();
    const scoped = mainArticle ? Array.from(mainArticle.querySelectorAll(selectors)).find((node) => isVisible(node)) : null;
    if (scoped) return resolveReplyComposer(scoped);
    return Array.from(document.querySelectorAll(selectors))
      .find((node) => isVisible(node) && (!node.closest("article") || node.closest("article") === mainArticle)) || null;
  }

  function findTaskWidgetContainer(node) {
    let current = node;
    for (let depth = 0; current && depth < 8; depth += 1) {
      const text = normalizeText(current.innerText || "");
      const rect = current.getBoundingClientRect();
      if (looksLikeLighthouseTaskWidget(text) && rect.height < 520 && rect.width < Math.min(window.innerWidth, 760)) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  function looksLikeLighthouseTaskWidget(text) {
    if (!text) return false;
    const hasAction = /抢单|接任务|领取任务|锁定席位|开始任务|提交验证|我已评论|我已完成|验证|席位已满|重抢|完成上面步骤解锁|提交任务|完成任务|打开任务广场|已完成/.test(text);
    const hasBrandOrReward = /Lighthouse|Light House|LUX|任务|冷却|倒计时|当前任务/i.test(text);
    return hasAction && hasBrandOrReward;
  }

  function scoreTaskWidgetActionText(text, node = null, replyBox = null) {
    let score = 0;
    if (/抢单/.test(text)) score += 100;
    if (/席位已满|重抢/.test(text)) score += 90;
    if (/验证|提交验证|完成上面步骤解锁|提交任务/.test(text)) score += 80;
    if (/接任务|领取任务|锁定席位|开始任务/.test(text)) score += 60;
    if (node && isNearReplyComposer(node, replyBox)) score += 40;
    return score;
  }

  function readTaskWidgetState(widget) {
    const buttons = Array.from(widget.querySelectorAll("button,a,[role='button']"))
      .filter((node) => isVisible(node))
      .map((node) => ({
        node,
        text: normalizeText(node.innerText || node.textContent || node.getAttribute("aria-label") || "")
      }))
      .filter((entry) => entry.text);

    const ready = buttons.find((entry) => /接任务|领取任务|锁定席位|开始任务|提交验证|我已评论|我已完成|验证|完成上面步骤解锁|提交任务|完成任务|打开任务广场/.test(entry.text) && !isButtonDisabled(entry.node));
    const allText = normalizeText(widget.innerText || "");
    const countdownSec = parseCountdownSeconds(allText);
    const countdown = countdownSec > 0 ? formatCountdown(countdownSec) : "";

    if (ready) {
      return {
        kind: "ready",
        actionText: ready.text.slice(0, 40),
        countdown,
        countdownSec
      };
    }
    if (countdownSec > 0 && countdownSec <= 10) {
      return {
        kind: "soon",
        actionText: "即将可点",
        countdown,
        countdownSec
      };
    }
    return { kind: "idle" };
  }

  async function runTaskWidgetClaim(task = {}, settings = {}) {
    const runId = activeRunId;
    await waitForPageReady();
    await revealTaskWidgetArea(settings);
    const initialWidget = await waitForTaskWidgetReady(30000);
    assertActiveRun(runId);

    const plannedClaim = getPlannedClaimWindow(initialWidget, task);
    const plannedClaimStartAt = plannedClaim.startAt;
    const claimTimingSource = plannedClaim.source;
    if (plannedClaimStartAt > Date.now()) {
      await waitUntilPlannedClaimWindow(plannedClaimStartAt, runId, settings);
    }

    const waitStartedAt = Date.now();
    while (!plannedClaimStartAt && Date.now() - waitStartedAt < 180000) {
      assertActiveRun(runId);
      await revealTaskWidgetArea(settings);
      const widget = findLighthouseTaskWidget();
      if (!widget) {
        await wait(250);
        continue;
      }
      if (hasClaimedTask(widget)) {
        return { ok: true, message: `已检测到已抢状态，计时源：${claimTimingSource}`, claimed: true, timingSource: claimTimingSource };
      }
      const state = readTaskWidgetState(widget);
      if (Number.isFinite(state.countdownSec) && state.countdownSec <= 0) break;
      if (state.countdownSec === null || state.countdownSec === undefined) {
        return {
          ok: false,
          message: "未读取到 X 控件倒计时，也没有可用插件倒计时；按钮常驻不可作为开抢依据，已停留当前 X 页面",
          claimed: false,
          timingSource: claimTimingSource
        };
      }
      await wait(Math.min(1000, Math.max(250, state.countdownSec * 1000)));
    }

    const claimStartedAt = Date.now();
    let clicks = 0;
    let lastActionText = "";
    while (Date.now() - claimStartedAt < 10000) {
      assertActiveRun(runId);
      await revealTaskWidgetArea(settings);
      const widget = findLighthouseTaskWidget();
      if (!widget) {
        await wait(250);
        continue;
      }
      if (hasClaimedTask(widget)) {
        return { ok: true, message: `已抢成功，点击 ${clicks} 次，计时源：${claimTimingSource}`, claimed: true, clicks, timingSource: claimTimingSource };
      }

      const button = findClaimActionButton(widget);
      if (button) {
        lastActionText = normalizeText(button.innerText || button.textContent || button.getAttribute("aria-label") || "");
        await clickElement(button, { randomDelay: false });
        clicks += 1;
      }
      await wait(700);
    }

    const settled = await waitForClaimSettled(15000);
    if (settled.ok) {
      return { ok: true, message: `已抢成功，点击 ${clicks} 次，计时源：${claimTimingSource}`, claimed: true, clicks, timingSource: claimTimingSource };
    }
    return { ok: false, message: `${settled.message}，点击已停止，计时源：${claimTimingSource}，最后按钮：${lastActionText || "未找到"}`, claimed: false, clicks, timingSource: claimTimingSource };
  }

  async function waitUntilPlannedClaimWindow(plannedClaimStartAt, runId, settings = {}) {
    while (Date.now() < plannedClaimStartAt) {
      assertActiveRun(runId);
      await revealTaskWidgetArea(settings);
      const widget = findLighthouseTaskWidget();
      if (widget && hasClaimedTask(widget)) return;
      const remainingMs = plannedClaimStartAt - Date.now();
      await wait(Math.min(1000, Math.max(120, remainingMs)));
    }
  }

  function getPlannedClaimStartAt(task = {}) {
    const source = task?.selectedTask || task || {};
    const expiresAt = Number(source.expiresAt || source.readyAt || 0);
    if (Number.isFinite(expiresAt) && expiresAt > 0) {
      return Math.max(Date.now(), expiresAt);
    }

    const countdownSec = Number(source.countdownSec);
    if (source.countdownSec !== undefined && source.countdownSec !== null && Number.isFinite(countdownSec)) {
      return Date.now() + Math.max(0, countdownSec) * 1000;
    }

    return 0;
  }

  function getPlannedClaimWindow(widget, task = {}) {
    if (widget) {
      if (hasClaimedTask(widget)) {
        return { startAt: Date.now(), source: "x_widget_claimed" };
      }

      const state = readTaskWidgetState(widget);
      if (Number.isFinite(state.countdownSec)) {
        return {
          startAt: Date.now() + Math.max(0, state.countdownSec) * 1000,
          source: "x_widget_countdown",
          countdownSec: state.countdownSec
        };
      }
    }

    return {
      startAt: getPlannedClaimStartAt(task),
      source: "selected_task_countdown"
    };
  }

  async function revealTaskWidgetArea(settings = {}) {
    const timeoutMs = Math.max(3000, Math.min(12000, Number(settings.actionDelayMs || 1000) * 8));
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      const widget = findLighthouseTaskWidget();
      if (widget && isVisible(widget)) {
        try {
          widget.scrollIntoView({ block: "center", inline: "nearest" });
        } catch (_) {}
        return widget;
      }

      const replyBox = findExistingReplyBox() || await findReplyBox({ timeoutMs: 800, soft: true });
      if (replyBox && isVisible(replyBox)) {
        try {
          replyBox.scrollIntoView({ block: "center", inline: "nearest" });
        } catch (_) {}
        await wait(350);
        const revealed = findLighthouseTaskWidget();
        if (revealed && isVisible(revealed)) return revealed;
      }

      await wait(300);
    }

    return findLighthouseTaskWidget();
  }

  async function clickTaskWidgetVerify(settings = {}) {
    let verifyButton = findDocumentVerifyActionButton();
    if (!verifyButton) {
      await revealTaskWidgetArea(settings);
      const widget = await waitForTaskWidgetReady(Math.max(settings.actionDelayMs || 1000, 15000));
      verifyButton = findVerifyActionButton(widget);
    }
    if (!verifyButton) {
      return { ok: false, message: "未找到 X 任务验证按钮" };
    }
    const text = normalizeText(verifyButton.innerText || verifyButton.textContent || verifyButton.getAttribute("aria-label") || "");
    await clickElement(verifyButton);
    await wait(2500);
    return { ok: true, message: `已点击 X 任务验证按钮：${text}` };
  }

  async function completeTaskWidgetLifecycle(settings = {}) {
    const runId = activeRunId;
    const startedAt = Date.now();
    const timeoutMs = Math.max(60000, Number(settings.lockSeatTimeoutMs || 0));
    let submitText = "";

    while (Date.now() - startedAt < timeoutMs) {
      assertActiveRun(runId);
      // Some Lighthouse versions render the verification card outside the
      // container inferred from the reply composer. Check the visible page
      // first so an enabled "验证发奖" button is clicked immediately.
      let verifyButton = findDocumentVerifyActionButton();
      if (!verifyButton) {
        const widget = await revealTaskWidgetArea(settings);
        verifyButton = findVerifyActionButton(widget);
      }
      if (verifyButton) {
        submitText = getNodeActionText(verifyButton);
        const widgetBeforeClick = findLighthouseTaskWidget();
        const textBeforeClick = normalizeText(widgetBeforeClick?.innerText || "");
        verifyButton.click();
        const confirmed = await waitForTaskWidgetSubmission(textBeforeClick, submitText, 8000);
        if (confirmed) {
          return {
            ok: true,
            submitted: true,
            message: `已在 X 确认提交任务：${submitText}，等待 Lighthouse 显示已完成`
          };
        }
        return { ok: true, submitted: false, submissionAttempted: true, message: "已点击灯塔提交，等待官网结果，不重复点击" };
      }

      await wait(250);
    }

    const reason = "停留时长或完成步骤尚未解锁，未找到可点击的提交任务按钮";
    return { ok: false, message: `X 任务闭环超时：${reason}${submitText ? `：${submitText}` : ""}` };
  }

  async function waitForTaskWidgetSubmission(beforeText, submitText, timeoutMs) {
    const runId = activeRunId;
    const startedAt = Date.now();
    const before = normalizeText(beforeText || "");
    while (Date.now() - startedAt < timeoutMs) {
      assertActiveRun(runId);
      const widget = findLighthouseTaskWidget();
      const text = normalizeText(widget?.innerText || "");
      if (/验证中|提交中|已提交|已完成|验证通过|奖励到账/.test(text)) return true;
      const button = widget ? findVerifyActionButton(widget) : null;
      if (!button && text && text !== before) return true;
      if (button && isButtonDisabled(button) && text !== before) return true;
      await wait(250);
    }
    return false;
  }

  async function waitForTaskWidgetReady(timeoutMs) {
    return waitFor(() => {
      const widget = findLighthouseTaskWidget();
      return widget && isVisible(widget) ? widget : null;
    }, timeoutMs, "未找到 X 页面 Lighthouse 任务控件");
  }

  function hasClaimedTask(widget) {
    const text = normalizeText(widget?.innerText || "");
    return /已抢/.test(text);
  }

  async function waitForClaimSettled(timeoutMs) {
    const started = Date.now();
    let lastStateText = "";
    while (Date.now() - started < timeoutMs) {
      const widget = findLighthouseTaskWidget();
      if (!widget) {
        await wait(300);
        continue;
      }
      if (hasClaimedTask(widget)) {
        return { ok: true, message: "已检测到已抢状态" };
      }
      lastStateText = readClaimFailureText(widget) || lastStateText;
      if (lastStateText && Date.now() - started > 2500) {
        return { ok: false, message: `抢单结果失败：${lastStateText}` };
      }
      await wait(500);
    }
    return { ok: false, message: "等待抢单结果超时，未检测到已抢" };
  }

  function readClaimFailureText(widget) {
    const buttonText = getTaskWidgetButtons(widget)
      .map((entry) => entry.text)
      .find((text) => /席位已满|名额已满|已满|重抢|失败|错误|不可|稍后|重试/.test(text) && !/已抢/.test(text));
    if (buttonText) return buttonText.slice(0, 80);

    const text = normalizeText(widget?.innerText || "");
    const match = text.match(/.{0,12}(?:席位已满|名额已满|已满|重抢|失败|错误|不可|稍后|重试).{0,18}/);
    return match ? match[0].slice(0, 80) : "";
  }

  function findClaimActionButton(widget) {
    const cached = getCachedTaskWidgetControls();
    if (cached?.claimButton && isVisible(cached.claimButton) && !isButtonDisabled(cached.claimButton)) {
      return cached.claimButton;
    }

    const entries = getTaskWidgetButtons(widget)
      .filter((entry) => isClaimCandidateText(entry.text))
      .sort((a, b) => scoreClaimButton(b) - scoreClaimButton(a));
    return entries[0]?.node || null;
  }

  function findVerifyActionButton(widget) {
    if (!widget || !/\bLUX\b/.test(widget.innerText || "") || /XINHUO|薪火/.test(widget.innerText || "")) return null;
    const cached = getCachedTaskWidgetControls();
    if (cached?.verifyButton && isVisible(cached.verifyButton) && !isButtonDisabled(cached.verifyButton)) {
      return cached.verifyButton;
    }

    const entries = getTaskWidgetButtons(widget)
      .filter((entry) => isVerifyCandidateText(entry.text))
      .filter((entry) => !/已验证|已完成|已提交/.test(entry.text))
      .sort((a, b) => b.rect.left - a.rect.left);
    return entries[0]?.node || null;
  }

  function findDocumentVerifyActionButton() {
    const lighthouseButton = queryAccessibleElements("button.lh-cur-btn.on")
      .find((node) => {
        const text = getNodeActionText(node);
        return isVisible(node)
          && text.length <= 48
          && isVerifyCandidateText(text)
          && !node.disabled
          && node.getAttribute("aria-disabled") !== "true";
      });
    if (lighthouseButton) return lighthouseButton;

    const widget = findLighthouseTaskWidget();
    if (!widget || !/\bLUX\b/.test(widget.innerText || "") || /XINHUO|薪火/.test(widget.innerText || "")) return null;
    const entries = Array.from(widget.querySelectorAll("button,a,[role='button'],[tabindex],div,span"))
      .filter((node) => isVisible(node))
      .map((node) => ({
        node: resolveActionClickableNode(node),
        text: getNodeActionText(node)
      }))
      .filter((entry) => entry.node && entry.text && entry.text.length <= 48)
      .filter((entry) => isVerifyCandidateText(entry.text))
      .filter((entry) => !isButtonDisabled(entry.node) && isVisible(entry.node));

    return entries
      .sort((a, b) => {
        const aExact = /验证发奖|验证领奖/.test(a.text) ? 1 : 0;
        const bExact = /验证发奖|验证领奖/.test(b.text) ? 1 : 0;
        return bExact - aExact;
      })[0]?.node || null;
  }

  function queryAccessibleElements(selector) {
    const result = [];
    const visited = new Set();
    const visit = (root) => {
      if (!root || visited.has(root)) return;
      visited.add(root);
      root.querySelectorAll?.(selector).forEach((node) => result.push(node));
      root.querySelectorAll?.("*").forEach((node) => {
        if (node.shadowRoot) visit(node.shadowRoot);
        if (node.tagName === "IFRAME") {
          try { visit(node.contentDocument); } catch (_) {}
        }
      });
    };
    visit(document);
    return Array.from(new Set(result));
  }

  function getTaskWidgetButtons(widget) {
    const cached = getCachedTaskWidgetControls();
    const cachedEntries = cached
      ? [cached.claimButton, cached.verifyButton]
        .filter((node) => node && node.isConnected)
        .map((node) => ({
          node,
          text: getNodeActionText(node),
          rect: node.getBoundingClientRect()
        }))
      : [];
    const domEntries = Array.from(widget?.querySelectorAll?.("button,a,[role='button'],[aria-label],[title],[tabindex]") || [])
      .map((node) => ({
        node: resolveActionClickableNode(node),
        text: getNodeActionText(node),
        rect: node.getBoundingClientRect()
      }))
      .filter((entry) => entry.text && isVisible(entry.node) && !isButtonDisabled(entry.node));

    const seen = new Set();
    return [...cachedEntries, ...domEntries]
      .filter((entry) => entry.text && isVisible(entry.node) && !isButtonDisabled(entry.node))
      .filter((entry) => {
        if (seen.has(entry.node)) return false;
        seen.add(entry.node);
        return true;
      });
  }

  function isClaimCandidateText(text) {
    if (!text) return false;
    if (/已抢|验证|已验证|我已评论|我已完成|提交|回复|Reply|Post|分享|Share|引用|查看引用/.test(text)) return false;
    if (/抢|领|接|锁|开始|重抢|席位|任务/.test(text)) return true;
    return false;
  }

  function isVerifyCandidateText(text) {
    if (!text) return false;
    if (/已验证|已完成|已提交/.test(text)) return false;
    return /验证|提交验证|我已评论|我已完成|完成上面步骤解锁|提交任务|完成任务/.test(text);
  }

  function scoreClaimButton(entry) {
    let score = 0;
    if (/抢/.test(entry.text)) score += 80;
    if (/重抢/.test(entry.text)) score += 70;
    if (/席位/.test(entry.text)) score += 45;
    if (/接任务|领取任务|锁定|开始任务/.test(entry.text)) score += 35;
    score += Math.max(0, 200 - Math.abs(entry.rect.width - 84));
    return score;
  }

  function parseCountdownSeconds(text) {
    const value = normalizeText(text);
    const colon = value.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (colon) {
      const parts = colon.slice(1).filter(Boolean).map(Number);
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
      if (parts.length === 2) return parts[0] * 60 + parts[1];
    }

    let total = 0;
    const hour = value.match(/(\d+)\s*(?:h(?![A-Za-z])|hr|hour|小时|时)/i);
    const minute = value.match(/(\d+)\s*(?:min|分钟|分)/i);
    const second = value.match(/(\d+)\s*(?:sec|s(?![A-Za-z])|秒)/i);
    if (hour) total += Number(hour[1]) * 3600;
    if (minute) total += Number(minute[1]) * 60;
    if (second) total += Number(second[1]);
    return hour || minute || second ? total : null;
  }

  function formatCountdown(seconds) {
    if (!seconds) return "";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h) return `${h}小时${m}分${s}秒`;
    if (m) return `${m}分${s}秒`;
    return `${s}秒`;
  }

  function findMainTweetArticle() {
    const pinned = document.querySelector('article[tabindex="-1"]');
    if (pinned && isVisible(pinned)) return pinned;
    const articles = Array.from(document.querySelectorAll("article")).filter(isVisible);
    return articles[0] || null;
  }

  function cleanTweetText(raw) {
    return String(raw || "")
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => line && !/^(Reply|回复|Repost|转发|Like|喜欢|View|查看|Share|分享)$/i.test(line))
      .join("\n")
      .slice(0, 2400)
      .trim();
  }

  function extractAuthorHandle(article) {
    const href = Array.from(article?.querySelectorAll?.("a[href]") || [])
      .map((anchor) => anchor.getAttribute("href") || "")
      .find((href) => /^\/[A-Za-z0-9_]{1,20}$/.test(href));
    return href ? `@${href.slice(1)}` : "";
  }

  function extractAuthorName(article) {
    const nameNode = article?.querySelector?.('[data-testid="User-Name"]');
    const text = normalize(nameNode?.innerText || "");
    return text.split("@")[0].trim();
  }

  async function detectExistingReplyBeforeWriting(tweet, task, settings = {}) {
    const local = await queryLocalReplyHistory(tweet, task);
    if (local.replied) return local;

    // A native-mode run has no Sola bridge listening; skip the doomed
    // postMessage round-trip and its full timeout.
    const sola = settings.replyProvider === "sola_bridge"
      ? await querySolaBridgeReplyHistory(tweet, task, settings)
      : { replied: false, checked: false, source: "disabled_native_mode" };
    if (sola.replied) return sola;

    const page = await findExistingOwnReplyOnPage(tweet, settings);
    if (page.replied) return page;

    return { replied: false };
  }

  async function queryLocalReplyHistory(tweet, task) {
    try {
      const result = await chrome.runtime.sendMessage({
        type: "QUERY_TWEET_REPLY_HISTORY",
        tweet,
        task
      });
      if (result?.ok && result.replied) {
        return {
          replied: true,
          source: result.source || "local_reply_history",
          message: result.message || "本地回复记录显示该推文已回复",
          replyText: result.record?.replyText || "",
          record: result.record || null
        };
      }
    } catch (_) {}
    return { replied: false };
  }

  async function querySolaBridgeReplyHistory(tweet, task, settings = {}) {
    const tweetUrl = normalizeTweetUrl(tweet?.url || task?.tweetUrl || location.href);
    if (!tweetUrl) return { replied: false };

    const requestId = `lh-dedupe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const timeoutMs = Math.max(1200, Math.min(Number(settings.actionDelayMs || 1200) * 2, 3500));
    const response = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", listener);
        resolve(null);
      }, timeoutMs);

      function listener(event) {
        if (event.source !== window) return;
        const data = event.data || {};
        if (data.source !== "sola-login-reply" || data.requestId !== requestId) return;
        clearTimeout(timer);
        window.removeEventListener("message", listener);
        resolve(data);
      }

      window.addEventListener("message", listener);
      window.postMessage({
        source: "lighthouse-comment-runner",
        type: "REPLY_DEDUPE_QUERY",
        requestId,
        tweetUrl,
        tweet,
        task
      }, "*");
    });

    if (!response) return { replied: false, checked: false, source: "sola_bridge" };
    const replied = Boolean(response.replied || response.alreadyReplied || response.exists || response.status === "already_replied");
    return replied
      ? {
        replied: true,
        source: "sola_bridge",
        message: response.message || "Sola 本地记录显示该推文已回复",
        replyText: response.replyText || response.text || "",
        record: response.record || null
      }
      : { replied: false, checked: true, source: "sola_bridge" };
  }

  async function findExistingOwnReplyOnPage(tweet, settings = {}) {
    const handle = getCurrentAccountHandle();
    if (!handle) return { replied: false, checked: false, source: "x_visible_replies", reason: "missing_current_handle" };

    const mainTweetText = normalizeText(tweet?.text || "");
    const mainArticle = findMainTweetArticle();
    const maxScans = 4;
    for (let index = 0; index < maxScans; index += 1) {
      const match = findVisibleOwnReplyArticle(handle, mainArticle, mainTweetText);
      if (match) {
        return {
          replied: true,
          source: "x_visible_replies",
          message: `评论区已检测到当前账号 ${handle} 回复过该推文`,
          replyText: match.text,
          authorHandle: handle
        };
      }
      if (index < maxScans - 1) {
        window.scrollBy({ top: Math.max(520, Math.floor(window.innerHeight * 0.7)), left: 0, behavior: "smooth" });
        await wait(Math.max(700, Math.min(Number(settings.actionDelayMs || 1200), 1600)));
      }
    }

    if (mainArticle?.isConnected) {
      try {
        mainArticle.scrollIntoView({ block: "center", inline: "nearest" });
      } catch (_) {}
      await wait(300);
    }
    return { replied: false, checked: true, source: "x_visible_replies", authorHandle: handle };
  }

  function findVisibleOwnReplyArticle(handle, mainArticle, mainTweetText) {
    const normalizedHandle = normalizeHandle(handle);
    const articles = Array.from(document.querySelectorAll("article")).filter(isVisible);
    for (const article of articles) {
      if (article === mainArticle) continue;
      const articleHandle = normalizeHandle(extractAuthorHandle(article));
      if (!articleHandle || articleHandle !== normalizedHandle) continue;

      const text = cleanTweetText(article.innerText || "");
      const normalizedText = normalizeText(text);
      if (!normalizedText) continue;
      if (mainTweetText && normalizedText === mainTweetText) continue;
      return { article, text };
    }
    return null;
  }

  function getCurrentAccountHandle() {
    const candidates = [];
    const accountButton = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    if (accountButton) {
      candidates.push(accountButton.innerText, accountButton.textContent, accountButton.getAttribute("aria-label"));
    }

    document.querySelectorAll('a[data-testid="AppTabBar_Profile_Link"]').forEach((anchor) => {
      const href = anchor.getAttribute("href") || "";
      if (/^\/[A-Za-z0-9_]{1,20}$/.test(href)) candidates.push(`@${href.slice(1)}`);
      candidates.push(anchor.getAttribute("aria-label"), anchor.innerText);
    });

    return candidates
      .map((value) => String(value || "").match(/@[A-Za-z0-9_]{1,20}/)?.[0])
      .map(normalizeHandle)
      .find(Boolean) || "";
  }

  function normalizeHandle(handle) {
    const match = String(handle || "").match(/@?([A-Za-z0-9_]{1,20})/);
    if (!match) return "";
    const slug = match[1].toLowerCase();
    if (RESERVED_X_HANDLE_SLUGS.has(slug)) return "";
    return `@${slug}`;
  }

  function buildDedupeReplyResult(tweet, dedupeResult, likeResult = null) {
    return {
      ok: true,
      deduped: true,
      mode: "dedupe",
      message: `${dedupeResult.message || "已检测到该推文此前已回复"}，跳过重复评论并继续提交 Lighthouse`,
      replyText: dedupeResult.replyText || "",
      tweet,
      existingReply: {
        source: dedupeResult.source || "unknown",
        replyText: dedupeResult.replyText || "",
        authorHandle: dedupeResult.authorHandle || ""
      },
      like: likeResult || { ok: true, status: "skipped_dedupe", message: "已回复去重命中，跳过重复评论" },
      xInstanceId: INSTANCE_ID
    };
  }

  async function likeCurrentTweetIfNeeded(settings = {}) {
    try {
      const article = findMainTweetArticle();
      if (!article) {
        return { ok: false, status: "no_article", message: "未找到主推文，跳过点赞" };
      }
      if (isTweetAlreadyLiked(article)) {
        return { ok: true, status: "already_liked", message: "当前推文已点赞" };
      }

      const button = findTweetLikeButton(article);
      if (!button) {
        return { ok: false, status: "button_missing", message: "未找到点赞按钮，跳过点赞" };
      }

      await clickElement(button);
      await wait(Math.max(500, Math.min(Number(settings.actionDelayMs) || 1200, 1500)));
      const verified = await waitForLikeApplied(article, 4000).catch(() => false);
      return verified
        ? { ok: true, status: "liked", message: "已点赞当前推文" }
        : { ok: true, status: "clicked_unverified", message: "已点击点赞但未确认状态" };
    } catch (error) {
      return { ok: false, status: "error", message: `点赞跳过：${error.message || String(error)}` };
    }
  }

  async function followCurrentTweetAuthorIfNeeded(settings = {}) {
    try {
      const article = findMainTweetArticle();
      if (!article) return { ok: false, status: "no_article", message: "未找到主推文，无法关注作者" };
      const authorArea = findMainTweetAuthorArea(article);
      if (!authorArea) return { ok: false, status: "author_missing", message: "未定位到主推文作者区域，已停止关注操作" };
      if (isTweetAuthorAlreadyFollowed(authorArea)) {
        return { ok: true, status: "already_following", message: "已关注主推文作者" };
      }
      const button = findTweetAuthorFollowButton(authorArea);
      if (!button) return { ok: false, status: "button_missing", message: "未找到主推文作者的关注按钮，已停止关注操作" };

      await clickElement(button);
      await wait(Math.max(500, Math.min(Number(settings.actionDelayMs) || 1200, 1500)));
      const verified = await waitForFollowApplied(authorArea, 5000).catch(() => false);
      return verified
        ? { ok: true, status: "followed", message: "已关注主推文作者" }
        : { ok: false, status: "unverified", message: "已点击关注，但未确认关注状态；不会继续验证领奖" };
    } catch (error) {
      return { ok: false, status: "error", message: `关注主推文作者失败：${error.message || String(error)}` };
    }
  }

  function findMainTweetAuthorArea(article) {
    const author = article?.querySelector?.('[data-testid="User-Name"]');
    if (!author || !isVisible(author)) return null;

    // X may render the author-level Follow control beside, rather than inside, User-Name.
    let current = author;
    for (let depth = 0; current && depth < 6; depth += 1) {
      const controls = Array.from(current.querySelectorAll?.('[data-testid="follow"],[data-testid="unfollow"],button,[role="button"]') || []);
      if (controls.some((node) => {
        const testid = node.getAttribute?.("data-testid") || "";
        const text = normalize([node.innerText, node.textContent, node.getAttribute?.("aria-label"), node.getAttribute?.("title")].filter(Boolean).join(" "));
        return testid === "follow" || testid === "unfollow" || /(^|\s)Follow(\s|$)|Following|关注|已关注|正在关注/i.test(text);
      })) return current;
      current = current.parentElement;
    }
    return author;
  }

  function isTweetAuthorAlreadyFollowed(authorArea) {
    return Boolean(authorArea?.querySelector?.('[data-testid="unfollow"]'))
      || Array.from(authorArea?.querySelectorAll?.('button,[role="button"]') || []).some((node) => /Following|正在关注|已关注|取消关注/i.test(normalize([
        node.innerText, node.textContent, node.getAttribute?.("aria-label"), node.getAttribute?.("title")
      ].filter(Boolean).join(" "))));
  }

  function findTweetAuthorFollowButton(authorArea) {
    const candidates = Array.from(authorArea?.querySelectorAll?.('[data-testid="follow"],button,[role="button"]') || [])
      .map((node) => resolveClickableButtonNode(node))
      .filter((node, index, nodes) => node && nodes.indexOf(node) === index)
      .filter((node) => isVisible(node) && !isButtonDisabled(node))
      .map((node) => ({ node, score: scoreFollowButton(node) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);
    return candidates[0]?.node || null;
  }

  function scoreFollowButton(node) {
    const testid = node.getAttribute?.("data-testid") || "";
    const text = normalize([node.innerText, node.textContent, node.getAttribute?.("aria-label"), node.getAttribute?.("title")].filter(Boolean).join(" "));
    if (testid === "unfollow" || /Following|正在关注|已关注|取消关注/i.test(text)) return -1;
    if (testid === "follow") return 100;
    return /(^|\s)Follow(\s|$)|关注/i.test(text) ? 45 : 0;
  }

  async function waitForFollowApplied(authorArea, timeoutMs) {
    return waitFor(() => isTweetAuthorAlreadyFollowed(authorArea), timeoutMs, "关注状态未确认");
  }

  function isTweetAlreadyLiked(article) {
    return Boolean(article?.querySelector?.('[data-testid="unlike"]'));
  }

  function findTweetLikeButton(article) {
    const candidates = Array.from(article?.querySelectorAll?.('[data-testid="like"], button, [role="button"]') || [])
      .map((node) => resolveClickableButtonNode(node))
      .filter((node, index, nodes) => node && nodes.indexOf(node) === index)
      .filter((node) => isVisible(node) && !isButtonDisabled(node))
      .map((node) => ({ node, score: scoreLikeButton(node, article) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);
    return candidates[0]?.node || null;
  }

  function scoreLikeButton(node, article) {
    const testid = node.getAttribute?.("data-testid") || "";
    const text = normalize([
      node.innerText,
      node.textContent,
      node.getAttribute?.("aria-label"),
      node.getAttribute?.("title")
    ].filter(Boolean).join(" "));
    if (testid === "unlike" || /Unlike|取消喜欢|取消点赞|已喜欢/.test(text)) return -1;

    let score = 0;
    if (testid === "like") score += 100;
    if (/Like|喜欢|点赞/.test(text)) score += 45;
    if (/Reply|回复|Repost|转发|Share|分享|Bookmark|书签|View|查看/.test(text)) score -= 50;

    const articleRect = article.getBoundingClientRect?.();
    const rect = node.getBoundingClientRect?.();
    if (articleRect && rect) {
      const lowerHalf = rect.top > articleRect.top + articleRect.height * 0.35;
      const insideMainArticle = rect.top >= articleRect.top && rect.bottom <= articleRect.bottom;
      if (lowerHalf) score += 12;
      if (insideMainArticle) score += 8;
    }
    return score;
  }

  async function waitForLikeApplied(article, timeoutMs) {
    return waitFor(() => {
      if (isTweetAlreadyLiked(article)) return true;
      const liked = Array.from(article.querySelectorAll?.("button,[role='button']") || [])
        .some((node) => /Unlike|取消喜欢|取消点赞|已喜欢/.test(normalize([
          node.innerText,
          node.textContent,
          node.getAttribute?.("aria-label"),
          node.getAttribute?.("title")
        ].filter(Boolean).join(" "))));
      return liked;
    }, timeoutMs, "点赞状态未确认");
  }

  async function trySolaBridge(payload, settings) {
    const requestId = `lh-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const response = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", listener);
        resolve(null);
      }, Math.max(5000, settings.actionDelayMs * 5));

      function listener(event) {
        if (event.source !== window) return;
        const data = event.data || {};
        if (data.source !== "sola-login-reply" || data.requestId !== requestId) return;
        clearTimeout(timer);
        window.removeEventListener("message", listener);
        resolve(data);
      }

      window.addEventListener("message", listener);
      window.postMessage({
        source: "lighthouse-comment-runner",
        type: "REPLY_REQUEST",
        requestId,
        text: payload.replyText,
        task: payload
      }, "*");
    });

    if (!response) return { ok: false, message: "Sola bridge unavailable" };
    return {
      ok: Boolean(response.ok),
      message: response.message || "Sola bridge finished",
      mode: "sola_bridge",
      replyText: payload.replyText
    };
  }

  async function openReplyComposer(settings) {
    const existingComposer = await findReplyBox({ soft: true });
    if (existingComposer) return;

    const replyButton = await waitFor(() => {
      const mainArticle = findMainTweetArticle();
      const candidate = mainArticle?.querySelector("[data-testid='reply']");
      return candidate && isVisible(candidate) ? candidate : null;
    }, 15000, "未找到主推文回复按钮");
    replyButton.scrollIntoView({ block: "center", inline: "center" });
    await wait(settings.actionDelayMs);
    await clickElement(replyButton);
    await findReplyBox({ timeoutMs: 12000 });
  }

  async function fillReplyText(text, settings) {
    const textbox = await findReplyBox({ timeoutMs: 12000 });
    if (!(await activateReplyInput(textbox))) {
      throw new Error("回复框激活失败");
    }

    await wait(settings.actionDelayMs / 2);
    await clearReplyBoxIfNeeded(textbox);
    await wait(300);
    await pasteTextLikeUser(text, textbox);

    const stable = await waitForReplyBoxContentStable(text, 15000, 2000);
    if (!stable) {
      const current = await getReplyBoxText();
      throw new Error(`回复框内容未精确稳定，已停止以避免发送污染回复，expected=${String(text || "").length}, actual=${current.length}`);
    }
    await wait(800);
  }

  async function clickPostButtonAndVerify(settings) {
    if (hasAccountRestrictionBanner()) {
      throw new Error("ACCOUNT_RESTRICTION: X 提示账号可能不允许执行操作，请刷新后重试");
    }

    const replyInput = await findReplyBox({ timeoutMs: 5000 });
    const ready = await waitForReplySendButtonReady(replyInput, 10000, 250);
    if (!ready.ok || !ready.button) {
      throw new Error(ready.reason === "account_restriction" ? "ACCOUNT_RESTRICTION: X 提示账号可能不允许执行操作" : "回复按钮未就绪或不可点击");
    }

    await clickElement(ready.button);
    // The draft-state poll below already verifies the send; no fixed sleep.
    const success = await waitForReplySuccess(30000, 600, { replyInput, replyButton: ready.button });
    if (!success.ok) {
      const draftState = success.draftState || (await getReplyDraftState());
      throw new Error(success.reason === "account_restriction" ? "ACCOUNT_RESTRICTION: 回复后出现账号限制提示" : `回复确认失败：${success.reason || "草稿仍存在"}，draft=${JSON.stringify(draftState)}`);
    }

    replyInput.blur();
    document.body.focus();
    const postCheck = await waitForDraftClearAfterReplySuccess(6000, 400);
    if (postCheck?.draftState?.hasDraft) {
      throw new Error("回复成功后草稿仍存在，已按失败处理");
    }
    return { ok: true, reason: success.reason, message: "X 回复已发送并确认成功" };
  }

  async function findReplyBox(options = {}) {
    const { timeoutMs = 10000, soft = false } = options;
    const selectors = [
      '[data-testid="tweetTextarea_0"]',
      '[aria-label="帖子文本"]',
      '[aria-label="Post text"]',
      '[contenteditable="true"][role="textbox"]'
    ];
    try {
      return await waitFor(() => {
        const mainArticle = findMainTweetArticle();
        if (mainArticle) {
          for (const selector of selectors) {
            const scoped = mainArticle.querySelector(selector);
            const composer = resolveReplyComposer(scoped);
            if (composer && !hasAriaHiddenAncestor(composer) && isVisible(composer)) return composer;
          }
        }
        for (const selector of selectors) {
          const candidate = document.querySelector(selector);
          const composer = resolveReplyComposer(candidate);
          const ownerArticle = composer?.closest?.("article");
          if (composer && !hasAriaHiddenAncestor(composer) && isVisible(composer)
            && (!ownerArticle || ownerArticle === mainArticle)) return composer;
        }
        return null;
      }, timeoutMs, "未找到回复框");
    } catch (error) {
      if (soft) return null;
      throw error;
    }
  }

  function resolveReplyComposer(node) {
    if (!node) return null;
    if (node.matches?.('[contenteditable="true"][role="textbox"]')) return node;
    return node.querySelector?.('[contenteditable="true"][role="textbox"], [contenteditable="true"][data-contents="true"], [contenteditable="true"]') || node;
  }

  function getReplyTextRoot(input) {
    if (!input) return null;
    return input.querySelector?.('[data-contents="true"]') || input;
  }

  async function activateReplyInput(input) {
    if (!input) return false;
    input.scrollIntoView({ block: "center", inline: "center" });
    await clickElement(input);
    try {
      input.focus();
    } catch (_) {}
    return document.activeElement === input || input.contains(document.activeElement) || isSelectionInsideNode(input);
  }

  async function clearReplyBoxIfNeeded(input) {
    const box = input || (await findReplyBox({ timeoutMs: 5000 }));
    await activateReplyInput(box);
    const beforeText = getReplyComposerText(box);
    if (!beforeText) {
      dispatchReplyComposerInputEvents(box, null, "deleteContentBackward");
      return;
    }

    try {
      document.execCommand("selectAll", false, null);
    } catch (_) {}
    await wait(120);

    const maxPresses = Math.max(beforeText.length + 5, 20);
    for (let index = 0; index < maxPresses; index += 1) {
      if (!getReplyComposerText(box)) break;
      box.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Backspace",
        code: "Backspace",
        keyCode: 8,
        which: 8,
        bubbles: true,
        cancelable: true
      }));
      await wait(55);
    }

    if (getReplyComposerText(box)) {
      throw new Error("回复框已有草稿且清理失败，已停止以避免覆盖或乱删");
    }
    dispatchReplyComposerInputEvents(box, null, "deleteContentBackward");
  }

  async function pasteTextLikeUser(text, input) {
    const box = input || (await findReplyBox({ timeoutMs: 5000 }));
    if (!(await activateReplyInput(box))) {
      throw new Error("回复框激活失败，未执行写入");
    }
    await wait(500 + Math.floor(Math.random() * 500));

    const normalizedText = String(text || "");
    const beforeText = getReplyComposerText(box);
    if (beforeText) {
      throw new Error(`回复框写入前仍有草稿，已停止避免追加，draft=${beforeText.slice(0, 40)}`);
    }

    const writeResult = await writeReplyTextOnce(box, normalizedText);
    await wait(400);

    const currentText = getReplyComposerText(box);
    const exact = normalizedText && currentText === normalizedText;
    if (!writeResult?.success || !exact) {
      throw new Error(`回复框写入未同步，method=${writeResult?.method || "character_paste"} reason=${writeResult?.error || writeResult?.mismatchReason || "unknown"} expected=${normalizedText.length}, actual=${currentText.length}`);
    }
  }

  async function writeReplyTextOnce(input, text) {
    const normalized = String(text || "");
    if (!normalized) return false;

    return setReplyComposerTextNatively(input, normalized);
  }

  async function setReplyComposerTextNatively(input, text) {
    const normalized = String(text || "");
    const beforeText = getReplyComposerText(input);
    let insertResult = await tryWholeTextPasteOnce(input, normalized);
    if (!insertResult.success) {
      // A partial or doubled whole-paste leaves residue the character path
      // cannot handle; clean the box before falling back.
      await clearReplyBoxIfNeeded(input);
      insertResult = await insertReplyTextViaCharacterPaste(input, normalized);
    }
    let settle = insertResult.settle || {
      ok: false,
      reason: insertResult.success ? "not_checked" : insertResult.error,
      text: insertResult.actualText || normalizeReplyTextForSend(getReplyComposerText(input)),
      waitedMs: 0,
      samples: insertResult.samples || []
    };
    if (insertResult.success) {
      settle = await waitForNativeComposerText(input, normalized, 4500, 350);
    }
    let actualText = settle.text || insertResult.actualText || normalizeReplyTextForSend(getReplyComposerText(input));
    const mismatchReason = actualText === normalized ? "" : classifyReplyComposerMismatch(actualText, normalized);
    let doubleInsertRepair = {
      attempted: false,
      repaired: false,
      blocked: false,
      beforeLength: actualText.length,
      afterLength: actualText.length
    };

    if (mismatchReason === "exact_double_after_input") {
      doubleInsertRepair = {
        attempted: false,
        repaired: false,
        blocked: true,
        beforeLength: actualText.length,
        afterLength: actualText.length,
        reason: "blocked_exact_double_without_dom_repair"
      };
    }

    const success = Boolean(insertResult.success && settle.ok && actualText === normalized && !doubleInsertRepair.blocked);
    if (!success) {
      throw new Error(`回复框写入未同步，method=${insertResult.method || "character_paste"} reason=${mismatchReason || settle.reason || insertResult.error || "unknown"} expected=${normalized.length}, actual=${actualText.length}`);
    }

    return {
      success,
      inserted: Boolean(insertResult.inserted),
      method: insertResult.method,
      insertResult,
      settle,
      doubleInsertRepair,
      mismatchReason,
      expectedLength: normalized.length,
      beforeLength: beforeText.length,
      afterLength: actualText.length,
      actualSample: actualText.slice(0, 160)
    };
  }

  function createReplyPlainTextDataTransfer(text) {
    const normalized = String(text || "");
    try {
      const data = new DataTransfer();
      data.setData("text/plain", normalized);
      data.setData("text", normalized);
      return data;
    } catch (_) {
      return null;
    }
  }

  function dispatchReplyPasteText(input, text, method = "synthetic.clipboard.paste") {
    const normalized = String(text || "");
    const dataTransfer = createReplyPlainTextDataTransfer(normalized);
    if (!dataTransfer) {
      return {
        success: false,
        inserted: false,
        method,
        length: Array.from(normalized).length,
        error: "data_transfer_unavailable"
      };
    }

    try {
      const pasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer
      });
      return {
        success: true,
        inserted: true,
        dispatched: input.dispatchEvent(pasteEvent),
        method,
        length: Array.from(normalized).length,
        error: ""
      };
    } catch (error) {
      return {
        success: false,
        inserted: false,
        method,
        length: Array.from(normalized).length,
        error: error?.message || "paste_event_dispatch_failed"
      };
    }
  }

  // One synthetic paste of the whole reply, verified the same way the
  // character-by-character path verifies its prefix. Short replies rarely
  // need the character fallback at all.
  async function tryWholeTextPasteOnce(input, text) {
    const normalized = String(text || "");
    const dispatch = dispatchReplyPasteText(input, normalized, "synthetic.clipboard.paste.whole");
    if (!dispatch.success) {
      return {
        success: false,
        inserted: false,
        method: dispatch.method,
        error: dispatch.error || "whole_paste_dispatch_failed"
      };
    }
    const settle = await waitForNativeComposerText(input, normalized, 4500, 280);
    const actualText = settle.text || normalizeReplyTextForSend(getReplyComposerText(input));
    const success = Boolean(settle.ok && actualText === normalized);
    return {
      success,
      inserted: true,
      method: "synthetic.clipboard.paste.whole",
      settle,
      error: success ? "" : (settle.reason || "whole_paste_mismatch")
    };
  }

  async function insertReplyTextViaCharacterPaste(input, text) {
    const normalized = String(text || "");
    if (!normalized) {
      return { success: false, inserted: false, error: "empty_reply_text" };
    }
    if (!(await activateReplyInput(input))) {
      return { success: false, inserted: false, error: "reply_box_activation_failed" };
    }
    await wait(150);
    const preText = getReplyComposerText(input);
    if (preText) {
      return {
        success: false,
        inserted: false,
        method: "synthetic.clipboard.paste.character_by_character",
        error: "reply_box_not_empty_before_character_paste",
        actualText: preText,
        actualLength: preText.length
      };
    }

    const chars = Array.from(normalized);
    let expectedPrefix = "";
    let lastSettle = null;
    let totalWaitMs = 0;
    const samples = [];

    for (let index = 0; index < chars.length; index += 1) {
      const char = chars[index];
      const insertResult = dispatchReplyPasteText(input, char, "synthetic.clipboard.paste.character_by_character");
      if (!insertResult.success) {
        return {
          ...insertResult,
          success: false,
          inserted: index > 0,
          method: "synthetic.clipboard.paste.character_by_character",
          failedAt: index,
          error: insertResult.error || "character_paste_failed",
          actualText: normalizeReplyTextForSend(getReplyComposerText(input)),
          expectedPrefix,
          samples
        };
      }

      expectedPrefix += char;
      lastSettle = await waitForNativeComposerText(input, expectedPrefix, 1300, 60, 40);
      totalWaitMs += lastSettle.waitedMs || 0;
      if (samples.length < 8) {
        samples.push({
          index,
          expectedLength: expectedPrefix.length,
          actualLength: String(lastSettle.text || "").length,
          reason: lastSettle.reason,
          sample: String(lastSettle.text || "").slice(0, 80)
        });
      }
      if (!lastSettle.ok) {
        const actualText = normalizeReplyTextForSend(getReplyComposerText(input));
        return {
          success: false,
          inserted: true,
          method: "synthetic.clipboard.paste.character_by_character",
          length: chars.length,
          failedAt: index,
          error: classifyReplyComposerMismatch(actualText, expectedPrefix) || "character_prefix_mismatch",
          expectedPrefix,
          expectedLength: expectedPrefix.length,
          actualText,
          actualLength: actualText.length,
          totalWaitMs,
          settle: lastSettle,
          samples
        };
      }

      if (index < chars.length - 1) {
        const pause = /[\s.,!?。 ，！？]/.test(char) ? 42 : 14;
        await wait(pause + Math.floor(Math.random() * 18));
      }
    }

    return {
      success: true,
      inserted: true,
      method: "synthetic.clipboard.paste.character_by_character",
      length: chars.length,
      totalWaitMs,
      settle: lastSettle,
      samples,
      error: ""
    };
  }

  async function waitForNativeComposerText(input, expectedText, maxWaitMs = 4500, stableDurationMs = 280, pollIntervalMs = 100) {
    const expected = normalizeReplyTextForSend(expectedText);
    const startedAt = Date.now();
    let lastText = normalizeReplyTextForSend(getReplyComposerText(input));
    let lastChangeAt = startedAt;
    let exactSince = lastText === expected ? startedAt : null;
    const samples = [{ waitedMs: 0, length: lastText.length, sample: lastText.slice(0, 120), reason: "initial" }];

    while (Date.now() - startedAt < maxWaitMs) {
      const now = Date.now();
      const current = normalizeReplyTextForSend(getReplyComposerText(input));
      if (current !== lastText) {
        lastText = current;
        lastChangeAt = now;
        exactSince = current === expected ? now : null;
        if (samples.length < 8) {
          samples.push({ waitedMs: now - startedAt, length: current.length, sample: current.slice(0, 120), reason: "changed" });
        }
      } else if (current === expected) {
        if (exactSince === null) exactSince = now;
        if (now - exactSince >= stableDurationMs) {
          return {
            ok: true,
            reason: "stable_exact_match",
            text: current,
            waitedMs: now - startedAt,
            stableMs: now - exactSince,
            samples
          };
        }
      } else {
        exactSince = null;
        const stableMismatchMs = now - lastChangeAt;
        if (current && current.length > expected.length && stableMismatchMs >= Math.max(900, stableDurationMs * 3)) {
          if (samples.length < 8) {
            samples.push({ waitedMs: now - startedAt, length: current.length, sample: current.slice(0, 120), reason: "stable_oversized_waiting_for_x_reconcile" });
          }
        }
      }
      await wait(Math.max(20, pollIntervalMs));
    }

    return {
      ok: lastText === expected,
      reason: lastText === expected ? "timeout_exact_match" : "timeout_mismatch",
      text: lastText,
      waitedMs: Date.now() - startedAt,
      stableMismatchMs: Date.now() - lastChangeAt,
      samples
    };
  }

  function normalizeReplyTextForSend(value) {
    return String(value || "").trim();
  }

  function isExactDoubledReplyComposerText(actualText, expectedText) {
    const actual = String(actualText || "");
    const expected = String(expectedText || "");
    return Boolean(expected
      && actual.length === expected.length * 2
      && actual.slice(0, expected.length) === expected
      && actual.slice(expected.length) === expected);
  }

  function classifyReplyComposerMismatch(actualText, expectedText) {
    const actual = String(actualText || "");
    const expected = String(expectedText || "");
    if (!actual) return "empty_after_input";
    if (isExactDoubledReplyComposerText(actual, expected)) return "exact_double_after_input";
    if (actual.length > expected.length && actual.includes(expected)) return "oversized_or_polluted_after_input";
    if (actual.length < expected.length) return "incomplete_after_input";
    return "mismatch_after_input";
  }

  function dispatchReplyComposerInputEvents(input, data, inputType = "insertText") {
    if (!input) return;
    const hasData = data !== null && data !== undefined;
    const normalizedData = hasData ? String(data) : undefined;
    const shouldDispatchBeforeInput = hasData || inputType === "insertText" || inputType === "insertReplacementText";
    try {
      if (shouldDispatchBeforeInput) {
        input.dispatchEvent(new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType,
          data: normalizedData
        }));
      }
    } catch (_) {}
    try {
      if (hasData) {
        input.dispatchEvent(new InputEvent("input", {
          bubbles: true,
          inputType,
          data: normalizedData
        }));
      } else {
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } catch (_) {}
    try {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (_) {}
    try {
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    } catch (_) {}
  }

  async function findSendButton(options = {}) {
    const { allowDisabled = true, replyBoxOverride = null } = options;
    const replyBox = replyBoxOverride && replyBoxOverride.isConnected ? replyBoxOverride : await findReplyBox({ timeoutMs: 5000 });
    const candidates = [];
    const scopes = [
      replyBox,
      replyBox?.parentElement,
      replyBox?.closest?.('[role="group"]'),
      replyBox?.closest?.("form"),
      replyBox?.closest?.("article"),
      replyBox?.closest?.('[role="dialog"]'),
      document
    ].filter(Boolean);

    for (const scope of scopes) {
      scope.querySelectorAll?.('[data-testid="tweetButtonInline"], [data-testid="tweetButton"], button, [role="button"]').forEach((node) => {
        if (!candidates.includes(node) && matchesSendButton(node)) candidates.push(node);
      });
    }

    const ranked = candidates
      .map((node) => ({ node: resolveClickableButtonNode(node), score: scoreSendButton(node, replyBox) }))
      .filter((entry) => entry.node && isVisible(entry.node) && (allowDisabled || !isReplyButtonDisabled(entry.node)))
      .sort((a, b) => b.score - a.score);
    return ranked[0]?.node || null;
  }

  async function waitForReplySendButtonReady(replyInput, timeoutMs, intervalMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (hasAccountRestrictionBanner()) return { ok: false, reason: "account_restriction" };
      const button = await findSendButton({ allowDisabled: true, replyBoxOverride: replyInput });
      if (button && isReplySendButtonUsable(button)) return { ok: true, button };
      await wait(intervalMs);
    }
    return { ok: false, reason: "timeout" };
  }

  async function waitForReplySuccess(timeoutMs, intervalMs, refs = {}) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (hasAccountRestrictionBanner()) return { ok: false, reason: "account_restriction" };
      const draftState = await getReplyDraftState(refs.replyInput);
      if (!draftState.hasDraft) return { ok: true, reason: "draft_cleared", draftState };
      await wait(intervalMs);
    }
    return { ok: false, reason: "timeout", draftState: await getReplyDraftState(refs.replyInput) };
  }

  async function waitForDraftClearAfterReplySuccess(timeoutMs, intervalMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (hasAccountRestrictionBanner()) return { ok: false, reason: "account_restriction_after_success", draftState: await getReplyDraftState() };
      const draftState = await getReplyDraftState();
      if (!draftState.hasDraft) return { ok: true, reason: "draft_cleared", draftState };
      await wait(intervalMs);
    }
    return { ok: false, reason: "draft_still_present", draftState: await getReplyDraftState() };
  }

  async function waitForReplyBoxContentStable(expectedText, timeoutMs, stableMs) {
    const started = Date.now();
    let last = "";
    let stableSince = Date.now();
    const expected = normalizeReplyTextForSend(expectedText);
    while (Date.now() - started < timeoutMs) {
      const current = normalizeReplyTextForSend(await getReplyBoxText());
      if (current === last) {
        if (current === expected && Date.now() - stableSince >= stableMs) return true;
        if (current && current.length > expected.length && Date.now() - stableSince >= Math.max(900, stableMs)) return false;
      } else {
        stableSince = Date.now();
        last = current;
      }
      await wait(250);
    }
    return false;
  }

  async function getReplyBoxText() {
    const box = await findReplyBox({ timeoutMs: 1000, soft: true });
    return getReplyComposerText(box);
  }

  async function getReplyDraftState(input) {
    const box = input && input.isConnected ? input : await findReplyBox({ timeoutMs: 1000, soft: true });
    const text = getReplyComposerText(box);
    return { hasDraft: Boolean(text), textLength: text.length, textSample: text.slice(0, 80) };
  }

  function getReplyComposerText(input) {
    if (!input) return "";
    const text = extractVisibleNodeText(getReplyTextRoot(input) || input);
    if (/^(发布你的回复|post your reply|write your reply|回复|reply)$/i.test(text)) return "";
    return text;
  }

  function extractVisibleNodeText(node) {
    if (!node) return "";
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
      acceptNode(textNode) {
        const parent = textNode.parentElement;
        if (!parent || parent.closest('[aria-hidden="true"], [hidden], script, style')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let text = "";
    let current = walker.nextNode();
    while (current) {
      text += current.textContent || "";
      current = walker.nextNode();
    }
    return text.trim();
  }

  function matchesSendButton(node) {
    const clickNode = resolveClickableButtonNode(node);
    const testid = node.getAttribute?.("data-testid") || clickNode?.getAttribute?.("data-testid") || "";
    if (testid === "tweetButtonInline" || testid === "tweetButton") return true;
    const text = node.textContent || clickNode?.textContent || "";
    const ariaLabel = node.getAttribute?.("aria-label") || clickNode?.getAttribute?.("aria-label") || "";
    return ["Reply", "回复", "Post", "发布"].some((matcher) => text.includes(matcher) || ariaLabel.includes(matcher));
  }

  function scoreSendButton(node, input) {
    if (!node || !matchesSendButton(node)) return -1;
    const clickNode = resolveClickableButtonNode(node);
    let score = 0;
    if (node.getAttribute?.("data-testid") === "tweetButtonInline") score += 50;
    if (node.getAttribute?.("data-testid") === "tweetButton") score += 20;
    if (isVisible(clickNode)) score += 20;
    if (!isReplyButtonDisabled(clickNode)) score += 20;
    if (input && input.closest?.("form") === clickNode.closest?.("form")) score += 15;
    if (input && input.closest?.("article") === clickNode.closest?.("article")) score += 10;
    return score;
  }

  function isReplySendButtonUsable(button) {
    return Boolean(button && isVisible(button) && !isReplyButtonDisabled(button));
  }

  function isReplyButtonDisabled(button) {
    return button?.disabled || button?.getAttribute("aria-disabled") === "true" || button?.classList?.contains("disabled");
  }

  function isButtonDisabled(button) {
    return Boolean(button?.disabled
      || button?.getAttribute("aria-disabled") === "true"
      || button?.classList?.contains("disabled")
      || button?.closest?.("[aria-disabled='true'], [disabled]"));
  }

  function resolveClickableButtonNode(node) {
    if (!node) return null;
    if (node.matches?.('button, [role="button"]')) return node;
    return node.closest?.('button, [role="button"]') || node;
  }

  function hasAccountRestrictionBanner() {
    const banner = document.querySelector('[role="alert"]');
    return Boolean(banner && /不允许执行|刷新页面并重试|account.*restricted|try again/i.test(banner.textContent || ""));
  }

  async function waitForPageReady() {
    await waitFor(() => document.readyState === "complete" || document.readyState === "interactive", 20000, "X 页面未加载完成");
    await waitFor(() => normalizeTweetUrl(location.href), 20000, "当前不是 X 推文详情页");
    await waitFor(() => document.body && document.body.innerText.length > 20, 20000, "X 页面内容为空");
    await waitFor(() => findMainTweetArticle(), 25000, "X 主推文未加载完成");
    await waitForStableMainTweet(6000, 600);
  }

  async function waitForStableMainTweet(timeoutMs, stableMs) {
    const started = Date.now();
    let lastText = "";
    let stableSince = Date.now();
    while (Date.now() - started < timeoutMs) {
      const article = findMainTweetArticle();
      const text = cleanTweetText(article ? article.innerText : "");
      if (text && text === lastText && Date.now() - stableSince >= stableMs) return true;
      if (text !== lastText) {
        lastText = text;
        stableSince = Date.now();
      }
      await wait(250);
    }
    return Boolean(findMainTweetArticle());
  }

  async function simulateReadingBeforeReply(settings = {}) {
    // The platform widget already enforces its own dwell requirement; this
    // theatre only needs to look human, so it runs on a configurable budget
    // (default ~4s) instead of the old fixed 5-11s choreography.
    const runId = activeRunId;
    const budgetMs = Math.min(Math.max(Number(settings.readingSimulationMs) || 4000, 500), 20000);
    const article = findMainTweetArticle();
    if (article) {
      try {
        article.scrollIntoView({ block: "start", inline: "nearest" });
      } catch (_) {}
    }

    await wait(Math.round(budgetMs * (0.16 + Math.random() * 0.06)));
    const steps = budgetMs >= 6000 ? 3 : 2;
    for (let index = 0; index < steps; index += 1) {
      assertActiveRun(runId);
      const direction = Math.random() < 0.7 ? 1 : -1;
      const distance = randomBetween(100, 300) * direction;
      window.scrollBy({
        top: distance,
        left: 0,
        behavior: "smooth"
      });
      await wait(Math.round(budgetMs * 0.22 * (0.8 + Math.random() * 0.4)));
    }

    assertActiveRun(runId);
    const mainTweet = findMainTweetArticle();
    if (mainTweet) {
      try {
        mainTweet.scrollIntoView({ block: "center", inline: "nearest" });
      } catch (_) {}
    }
    await wait(Math.round(budgetMs * (0.1 + Math.random() * 0.05)));
  }

  function randomBetween(min, max) {
    const low = Math.min(min, max);
    const high = Math.max(min, max);
    return Math.floor(low + Math.random() * (high - low + 1));
  }

  function assertNotLoginWall() {
    const text = normalize(document.body.innerText);
    const loginWallMarkers = ["Log in", "Sign up", "登录", "注册", "Please log in"];
    const hasArticle = Boolean(document.querySelector("article"));
    if (!hasArticle && loginWallMarkers.some((marker) => text.includes(marker))) {
      throw new Error("X 当前不是已登录推文页，请先人工确认登录态");
    }
  }

  function waitForElement(selector, timeoutMs) {
    return waitFor(() => {
      const element = document.querySelector(selector);
      return element && isVisible(element) ? element : null;
    }, timeoutMs, `未找到元素：${selector}`);
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

  function isSelectionInsideNode(node) {
    const selection = window.getSelection?.();
    if (!selection || selection.rangeCount === 0) return false;
    return Boolean((selection.anchorNode && node.contains(selection.anchorNode)) || (selection.focusNode && node.contains(selection.focusNode)));
  }

  function hasAriaHiddenAncestor(node) {
    return Boolean(node?.closest?.('[aria-hidden="true"], [hidden], [style*="display: none"], [style*="visibility: hidden"]'));
  }

  function isVisible(node) {
    if (!node) return false;
    const rect = node.getBoundingClientRect?.();
    const style = getComputedStyle(node);
    return Boolean(rect && rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none");
  }

  async function clickElement(node, options = {}) {
    if (options.randomDelay !== false) {
      await randomClickDelay();
    }
    try {
      node.scrollIntoView({ block: "center", inline: "center" });
    } catch (_) {}
    try {
      node.click();
      return;
    } catch (_) {}
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  }

  function randomClickDelay() {
    return wait(500 + Math.floor(Math.random() * 1001));
  }

  function normalizeTweetUrl(url) {
    const match = String(url || "").match(/https:\/\/(?:x|twitter)\.com\/[A-Za-z0-9_]+\/status\/\d+/i);
    return match ? match[0].replace("twitter.com", "x.com") : "";
  }

  function normalize(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function normalizeText(text) {
    return normalize(text);
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

  function assertActiveRun(runId) {
    const currentTarget = normalizeTweetUrl(location.href);
    if (activeTargetUrl && currentTarget !== activeTargetUrl && !isExpectedReplyComposeTransition()) {
      throw new Error("目标推文已变化，取消本单操作");
    }
    if (runId && (cancelledRunIds.has(runId) || activeRunId !== runId)) {
      throw new Error("X 回复流程已取消");
    }
  }

  function isExpectedReplyComposeTransition() {
    if (activeStepName !== "RUN_X_REPLY" || !activeTargetUrl || !activeStepStartedAt) return false;
    if (Date.now() - activeStepStartedAt > 45000) return false;
    try {
      const url = new URL(location.href);
      if (!/^(?:x|twitter)\.com$/i.test(url.hostname) || url.pathname !== "/compose/post") return false;
    } catch (_) {
      return false;
    }
    return Boolean(document.querySelector?.('[data-testid="tweetTextarea_0"], [aria-label="帖子文本"], [aria-label="Post text"], [contenteditable="true"][role="textbox"]'));
  }
})();
