"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const sourceRoot = process.env.LIGHTHOUSE_TEST_SOURCE_ROOT || path.join(__dirname, "../src");
const read = file => fs.readFileSync(path.join(sourceRoot, file), "utf8");

function declaration(source, name) {
  const match = new RegExp(`^([ \\t]*)(?:async )?function ${name}\\(`, "m").exec(source);
  assert.ok(match, `Missing production function: ${name}`);
  const next = new RegExp(`^${match[1]}(?:async )?function \\w+\\(`, "gm");
  next.lastIndex = match.index + match[0].length;
  return source.slice(match.index, next.exec(source)?.index ?? source.lastIndexOf("})();"));
}

// These assertions encode the requested eligibility policy independently of
// the implementation: AI wording is not a reason to reject a comment task.
for (const file of ["content/lighthouse.js", "content/lighthouse-monitor.js"]) {
  const source = read(file);
  const c = vm.createContext({});
  vm.runInContext(declaration(source, "normalize"), c);
  vm.runInContext(declaration(source, "hasUnsupportedCommentGuidance"), c);

  for (const guidance of [
    "买家希望的评论方向 真实想法，不要ai长篇大论",
    "评论引导 不要AI评论",
    "任务备注 禁止使用 Ai 回复",
    "接单备注 不得使用 aI 评论",
    "接单前 不可 AI 回复",
    "买家希望 真实想法，不要 ai 长篇大论"
  ]) {
    test(`${file}: AI wording remains eligible: ${guidance}`, () => {
      assert.equal(c.hasUnsupportedCommentGuidance(guidance), false);
    });
  }

  for (const guidance of [
    "接单备注 要求填写EVM地址，抽奖",
    "任务备注 请填写钱包地址",
    "评论引导 回复你的收款地址",
    "买家希望 不要 AI 长篇大论，请填写钱包地址"
  ]) {
    test(`${file}: wallet-address requirement still blocks: ${guidance}`, () => {
      assert.equal(c.hasUnsupportedCommentGuidance(guidance), true);
    });
  }

  for (const guidance of [
    "评论引导 评价内容观点",
    "正文讨论 AI 交易和钱包地址安全"
  ]) {
    test(`${file}: ordinary comment remains eligible: ${guidance}`, () => {
      assert.equal(c.hasUnsupportedCommentGuidance(guidance), false);
    });
  }
}

function cacheLoader(initialStored) {
  const source = read("background.js");
  const declarationMatch = source.match(/^const PERMANENT_IGNORED_TASK_KEYS_KEY = [^;]+;/m);
  assert.ok(declarationMatch, "Missing current permanent-exclusion storage key");
  const stored = structuredClone(initialStored);
  const reads = [];
  const c = vm.createContext({ chrome: { storage: { local: {
    async get(keys) {
      reads.push(Array.from(keys));
      return Object.fromEntries(keys.filter(key => Object.hasOwn(stored, key)).map(key => [key, stored[key]]));
    },
    async remove(keys) { for (const key of keys) delete stored[key]; }
  } } } });
  vm.runInContext(`${declarationMatch[0]}
    let permanentIgnoredTaskKeysLoaded = false;
    let permanentIgnoredTaskKeysCache = new Set();
    ${declaration(source, "ensurePermanentIgnoredTaskKeysLoaded")}`, c);
  return { c, stored, reads };
}

test("legacy V5 exclusions cannot keep filtering tasks after the guidance policy changes", async () => {
  const fixture = cacheLoader({ permanentIgnoredTaskKeysV5: ["old-ai-guidance-task"] });
  const keys = await fixture.c.ensurePermanentIgnoredTaskKeysLoaded();
  assert.deepEqual(Array.from(keys), []);
  assert.equal(fixture.reads.flat().includes("permanentIgnoredTaskKeysV5"), false);
});

test("new V6 exclusions remain effective without resurrecting legacy AI exclusions", async () => {
  const fixture = cacheLoader({
    permanentIgnoredTaskKeysV5: ["old-ai-guidance-task"],
    permanentIgnoredTaskKeysV6: ["wallet-address-task", "unsupported-task-type"]
  });
  const keys = await fixture.c.ensurePermanentIgnoredTaskKeysLoaded();
  assert.deepEqual(Array.from(keys), ["wallet-address-task", "unsupported-task-type"]);
  const cached = await fixture.c.ensurePermanentIgnoredTaskKeysLoaded();
  assert.equal(cached, keys);
  assert.equal(fixture.reads.length, 1);
});

test("legacy exclusion cleanup preserves saved settings and completed reply history", async () => {
  const retained = {
    settings: { aiModel: "test-model" },
    replyHistoryRecords: [{ taskKey: "completed-task" }]
  };
  const fixture = cacheLoader({ ...retained, permanentIgnoredTaskKeysV5: ["old-ai-guidance-task"] });
  await fixture.c.ensurePermanentIgnoredTaskKeysLoaded();
  assert.deepEqual(fixture.stored.settings, retained.settings);
  assert.deepEqual(fixture.stored.replyHistoryRecords, retained.replyHistoryRecords);
});
