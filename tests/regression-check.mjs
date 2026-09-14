import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const background = readFileSync(new URL("../src/background.js", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/content/lighthouse.js", import.meta.url), "utf8");
const monitor = readFileSync(new URL("../src/content/lighthouse-monitor.js", import.meta.url), "utf8");
const xPage = readFileSync(new URL("../src/content/x.js", import.meta.url), "utf8");
const debugPage = readFileSync(new URL("../src/debug/debug.js", import.meta.url), "utf8");

const waitFunction = background.slice(
  background.indexOf("async function waitForLighthouseOpenedTweet"),
  background.indexOf("async function clickCurrentDetailTweetTargetFallback")
);

assert.match(background, /const SITE_X_OPEN_WAIT_MS = 5000/);
assert.doesNotMatch(waitFunction, /getActiveTweetTab\(/);
assert.match(waitFunction, /consumeXOpenCandidate\(lighthouseTabId, currentExpectedUrl\)/);
assert.match(waitFunction, /source: "extension_fallback"/);
assert.match(waitFunction, /单次点击“去 X 完成动作”/);
assert.match(background, /const createProperties = \{ url: tweetUrl, active: true, openerTabId: lighthouseTabId \}/);
assert.match(background, /await focusTaskXTab\(tabId\)/);
assert.match(background, /async function focusTaskXTab/);
assert.match(background, /chrome\.windows\.update\(windowId, \{ focused: true \}\)/);
assert.match(background, /X 推文页已打开并切到前台/);
// The 30s keepalive alarm is the only sanctioned alarms usage: it keeps the
// MV3 worker alive during plaza cooldown waits and resumes a safe auto run
// after an unexpected worker restart. Resume must refuse a locked, unfinished
// seat instead of scanning new tasks on top of it.
assert.match(background, /chrome\.alarms\.onAlarm\.addListener/);
assert.match(background, /const AUTO_RUN_KEEPALIVE_ALARM = "lighthouseAutoRunKeepaliveV1"/);
assert.match(background, /periodInMinutes: 0\.5/);
assert.match(background, /hasLockedIncompleteSeat/);
assert.match(background, /不自动续跑，请人工处理该订单后重新启动/);
assert.match(background, /resume_after_service_worker_restart/);
assert.match(background, /Chrome 后台恢复了中断的 Lighthouse 状态，等待保活闹钟自动续跑/);
assert.match(background, /tab\.openerTabId === lighthouseTabId/);
assert.match(background, /xOpenSource: source/);
assert.match(background, /case "LIGHTHOUSE_TARGET_TWEET_URL"/);
assert.match(background, /await recoverPendingXOpenFromCapturedUrl\(tweetUrl\)/);
assert.match(background, /function mergeTaskPreservingCapturedTweetUrl/);
assert.match(background, /function getTaskMergeIdentity/);
assert.match(background, /tweetUrl: overrideUrl \|\| nextUrl \|\| \(sameTask \? currentUrl : ""\)/);
assert.match(background, /let capturedTargetRecoveryPromise = null/);
assert.match(background, /let directTweetOpenPromise = null/);
assert.match(waitFunction, /getBoundMatchingTaskXTab\(currentExpectedUrl\)/);
assert.match(background, /locked_task_target_unavailable/);
assert.match(background, /locked_task_recovery_blocked/);
assert.match(background, /lockFailed: true/);
assert.match(background, /seatLocked: false/);
assert.match(background, /hasExplicitSeatLockState/);
assert.match(background, /retry_after_task_select_failed/);
assert.match(page, /lighthouse-target-tweet-url/);
assert.match(page, /seatLocked: true/);
assert.match(page, /function isOwnedByTaskCard/);
assert.match(monitor, /function belongsToTaskCard/);
assert.match(monitor, /function retireInvalidExtensionContext/);
assert.match(monitor, /Extension context invalidated/);
assert.match(monitor, /request\.catch/);
assert.match(xPage, /waitForTaskWidgetSubmission/);
assert.match(xPage, /验证中\|提交中\|已提交\|已完成\|验证通过\|奖励到账/);
assert.match(page, /function hasOfficialCompletionEvidence/);
assert.match(page, /function findOfficialCompletionRoot/);
assert.match(page, /已入账至钱包\|入账/);
assert.doesNotMatch(page, /任务验证通过\|验证通过即到账\|奖励已到账/);
assert.match(background, /markPendingVerification/);
assert.match(background, /waitForOfficialLighthouseCompletionDuringXSubmission/);
assert.match(background, /Promise\.race\(\[xSubmission, officialCompletion\]\)/);
assert.match(background, /Lighthouse 已显示验证通过\/奖励到账/);
assert.match(background, /本单官方完成证据已保存，已恢复任务广场并准备继续扫描/);
assert.match(page, /CHECK_LIGHTHOUSE_OFFICIAL_COMPLETION/);
assert.match(page, /completed: true,\s*evidence: completion\.evidence/);
assert.match(background, /已保留订单并停止扫描/);
assert.doesNotMatch(background, /startNextAutoTask\("after_pending_verification"\)/);
assert.match(background, /丢弃非灯塔的残留任务标签/);
assert.match(page, /function hasUnsupportedCommentGuidance/);
assert.match(monitor, /function hasUnsupportedCommentGuidance/);
assert.match(debugPage, /function runPanelTask/);
assert.match(debugPage, /message channel closed\|Extension context invalidated\|Receiving end does not exist/);
assert.doesNotMatch(debugPage, /button\.addEventListener\("click", async \(\) => \{\s*await runSingleCommand/);
assert.match(xPage, /activeStepName !== "RUN_X_REPLY"/);
assert.match(xPage, /url\.pathname !== "\/compose\/post"/);
assert.match(xPage, /Date\.now\(\) - activeStepStartedAt > 45000/);
assert.match(background, /settingsVersion: 13/);
assert.match(background, /model: settings\.aiModel/);
assert.match(background, /aiModel: String\(merged\.aiModel/);
assert.match(debugPage, /aiModel: fields\.aiModel\.value\.trim\(\)/);
assert.match(background, /replyMode: "post"/);
assert.match(background, /aiProvider: "gpt-5\.6-terra"/);
assert.match(background, /aiModel: "gpt-5\.6-terra"/);
assert.match(background, /根据原推文写一句自然的中文回复/);
assert.match(background, /避免宣传腔、总结腔、夸张吹捧、复述原文和模板化感叹/);


// The two projects carry forked copies of src/content/x.js. This pin makes an
// accidental deletion or rename of a shared reply-pipeline function fail the
// regression run in BOTH repos, so an X-side fix cannot land in only one.
const sharedReplyPipelineFns = ["runReply",
  "scrapeCurrentTweet",
  "inferTaskActions",
  "detectExistingReplyBeforeWriting",
  "queryLocalReplyHistory",
  "findExistingOwnReplyOnPage",
  "tryWholeTextPasteOnce",
  "insertReplyTextViaCharacterPaste",
  "setReplyComposerTextNatively",
  "waitForNativeComposerText",
  "classifyReplyComposerMismatch",
  "clearReplyBoxIfNeeded",
  "findReplyBox",
  "clickPostButtonAndVerify",
  "waitForReplySendButtonReady",
  "waitForReplySuccess",
  "waitForDraftClearAfterReplySuccess",
  "waitForReplyBoxContentStable",
  "simulateReadingBeforeReply",
  "waitForPageReady",
  "waitForStableMainTweet",
  "assertActiveRun",
  "findMainTweetArticle",
  "completeTaskWidgetLifecycle",
  "hasAccountRestrictionBanner",];
for (const fn of sharedReplyPipelineFns) {
  assert.match(xPage, new RegExp(`function ${fn}\\(`));
}

assert.match(background, /CAMPAIGNS_IDLE_REFRESH_MS = 5 \* 60 \* 1000/);
assert.match(background, /runtimeState\.stage === "selecting_task"/);
assert.match(background, /!runtimeState\.currentTask/);
assert.match(background, /Date\.now\(\) - Number\(runtimeState\.lastProgressAt \|\| 0\) >= CAMPAIGNS_IDLE_REFRESH_MS/);
assert.match(background, /refreshLighthouseCampaignsTab\(/);
assert.doesNotMatch(background, /case "CONTENT_LOG"[\s\S]{0,260}touchRunState\(\)/);

console.log("Lighthouse regression checks passed.");
