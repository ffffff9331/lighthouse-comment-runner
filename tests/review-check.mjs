// Review-time checks added during the 2026-09-11 self-audit.
// Run with: node tests/review-check.mjs
// These pin review findings; failures below correspond to findings in the
// review report and must be resolved (or consciously accepted) before merge.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const manifest = JSON.parse(read("manifest.json"));
const background = read("src/background.js");
const engine = read("src/reply-engine.js");
let passed = 0;
const failures = [];
const test = async (name, action) => {
  try {
    await action();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`FAIL ${name}: ${String(error.message || error).split("\n")[0]}`);
  }
};

function declaration(source, name) {
  const match = new RegExp(`^([ \\t]*)(?:async )?function ${name}\\(`, "m").exec(source);
  assert.ok(match, `Missing function: ${name}`);
  const start = match.index;
  const next = new RegExp(`^${match[1]}(?:async )?function \\w+\\(`, "gm");
  next.lastIndex = start + match[0].length;
  const end = next.exec(source)?.index ?? source.lastIndexOf("})();");
  return source.slice(start, end > start ? end : source.length);
}
function contextFor(source, names, globals = {}) {
  const context = vm.createContext({ console, URL, AbortController, setTimeout, clearTimeout,
    normalize: (s) => String(s).replace(/\s+/g, " ").trim(),
    normalizeText: (s) => String(s).replace(/\s+/g, " ").trim(),
    startTaskWidgetAssist() {}, ...globals });
  for (const name of names) vm.runInContext(declaration(source, name), context);
  return context;
}

const USER_FALLBACK_REPLIES = [
  "听着像个挺有趣的实验",
  "评论区已经开始整活了",
  "回复区的气氛已经到位",
  "看样子大家都挺会接梗",
  "一眼看去全是熟人互动",
  "感觉大家已经玩明白了",
  "评论区像在开小型团建",
  "有点想看看后面怎么发展",
  "大家好像都找到节奏了",
  "看得出大家都在认真接梗",
  "今天的评论区格外热闹",
  "随手一发评论区就热闹了"
];
const BLACKLIST_GLOBALS = {
  DEFAULT_AI_SYSTEM_PROMPT: "prompt",
  DEFAULT_REPLY_BLACKLIST: ["\n", "确实", "有点东西", "真香"],
  REPLY_STRUCTURAL_BLACKLIST: [{ label: "句首这系起手", regex: /^[\s'"“”‘’「」『』()（）【】]*?(?:这|这个|这条|这类|这种|这波)/i }],
  REPLY_HARD_BAN_PHRASES: ["值得关注"],
  MIN_REPLY_CHINESE_CHARS: 5,
  MAX_REPLY_CHINESE_CHARS: 15,
  USER_FALLBACK_REPLIES,
  fallbackReplyBag: [],
  loadedReplyBlacklist: [],
  chrome: { storage: null }
};

// Happy path: every fallback reply handed to the user still passes the same
// validation the AI reply must pass, including blacklist words declared inside
// the user's own system prompt. (Guards the behaviour the Xinhuo fork lost.)
await test("every user fallback reply passes validation against prompt-declared bans", async () => {
  const c = contextFor(engine, [
    "pickUserFallbackReply", "refillFallbackReplyBag", "takeNextValidFallbackReply",
    "getPromptReplyLengthRange", "getReplyLengthRange",
    "validateFinalReplyText", "isUsableReplyText", "normalizeBlacklistCandidateText",
    "countReplyChineseChars", "detectReplyTextDegeneration", "checkBlacklistedWords",
    "getReplyBlacklistSnapshot", "escapeRegExp"
  ], BLACKLIST_GLOBALS);
  const prompt = "10到20个汉字为主\n生成词黑名单：评论区";
  const seen = [];
  for (let index = 0; index < 12; index += 1) {
    const reply = await c.pickUserFallbackReply("tweet", prompt);
    seen.push(reply);
    assert.equal(
      c.validateFinalReplyText(reply, prompt).ok,
      true,
      `fallback reply failed validation: ${reply}`
    );
  }
  assert.ok(!seen.some((reply) => reply.includes("评论区")), "prompt-banned fallback must never be returned");
});

// Failure path: notification icons referenced from the service worker must
// resolve to files that actually ship in the extension root.
await test("every notification iconUrl resolves to a shipped file", async () => {
  const iconUrls = [...background.matchAll(/iconUrl:\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(iconUrls.length > 0, "expected at least one notification iconUrl");
  for (const iconUrl of iconUrls) {
    assert.ok(
      existsSync(join(root, iconUrl)),
      `notification iconUrl "${iconUrl}" does not exist in the extension root (icons live under src/assets/icons/)`
    );
  }
});

// Boundary / adjacent scenario: re-injection guard relies on SCRIPT_VERSION
// differing across releases; it must track the manifest version exactly.
await test("content-script SCRIPT_VERSION matches the manifest version", async () => {
  const contentFiles = [
    "src/content/lighthouse.js",
    "src/content/lighthouse-monitor.js",
    "src/content/x.js",
    "src/content/lighthouse-alert-bridge.js"
  ];
  for (const file of contentFiles) {
    const source = read(file);
    const match = source.match(/SCRIPT_VERSION\s*=\s*"([^"]+)"/);
    if (!match) continue; // bridge uses a boolean guard only
    assert.equal(
      match[1],
      manifest.version,
      `${file} SCRIPT_VERSION ${match[1]} is stale (manifest ${manifest.version}); after an extension update the singleton guard will early-return and leave the orphaned script in charge`
    );
  }
});

// The Gemini API key must travel in the x-goog-api-key header, never in the
// request URL where it can leak into network/proxy logs.
await test("gemini requests authenticate via header, not the URL query string", async () => {
  let fetchedUrl = "";
  let headers = null;
  const c = contextFor(engine, ["callAIProvider", "readJsonResponse"], {
    AI_PROVIDER_CONFIG: {
      gemini: {
        endpoint: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent",
        model: "gemini-3-pro-preview"
      }
    },
    normalizeCustomAIEndpoint: () => "",
    fetch: async (url, options) => {
      fetchedUrl = url;
      headers = options.headers;
      return { ok: true, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: "好" }] } }] }) };
    }
  });
  assert.equal(await c.callAIProvider("gemini", "secret-key", "prompt", "tweet", { timeout: 100 }), "好");
  assert.equal(headers["x-goog-api-key"], "secret-key");
  assert.ok(!fetchedUrl.includes("key="), `API key leaked into the request URL: ${fetchedUrl}`);
});

console.log(`lighthouse review checks: ${passed} passed, ${failures.length} failed.`);
if (failures.length) process.exitCode = 1;
