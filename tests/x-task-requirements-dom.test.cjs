"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(process.env.LIGHTHOUSE_TEST_SOURCE_ROOT || path.join(__dirname, "../src"), "content/x.js"), "utf8");
function declaration(name) {
  const match = new RegExp(`^([ \\t]*)(?:async )?function ${name}\\(`, "m").exec(source);
  if (!match) return "";
  const next = new RegExp(`^${match[1]}(?:async )?function \\w+\\(`, "gm");
  next.lastIndex = match.index + match[0].length;
  return source.slice(match.index, next.exec(source)?.index ?? source.lastIndexOf("})();"));
}

// Semantic DOM fixture follows the installed official 0.4.23 current-task
// structure. Rendering is explicit: SVG titles enter textContent, not innerText.
class Element {
  constructor(tagName, className = "", text = "") {
    this.tagName = tagName.toUpperCase();
    this.className = className;
    this.text = text;
    this.children = [];
    this.parentElement = null;
    this.visible = true;
    this.disabled = false;
  }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } return this; }
  get textContent() { return this.text + this.children.map(node => node.textContent).join(""); }
  get innerText() {
    if (this.forceTextContent || !this.visible || ["SVG", "TITLE"].includes(this.tagName)) return "";
    return [this.text, ...this.children.map(node => node.innerText)].filter(Boolean).join(" ");
  }
  matches(selector) {
    return selector.split(",").some(part => {
      const match = part.trim().match(/^([a-z]+)?(?:\.([\w-]+))?$/i);
      return match && (!match[1] || this.tagName === match[1].toUpperCase())
        && (!match[2] || this.className.split(/\s+/).includes(match[2]));
    });
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) {
    const parts = selector.trim().split(/\s+/), results = [];
    const visit = node => {
      for (const child of node.children) {
        if (child.matches(parts.at(-1))) {
          let ancestor = child.parentElement, index = parts.length - 2;
          while (ancestor && index >= 0) {
            if (ancestor.matches(parts[index])) index--;
            ancestor = ancestor.parentElement;
          }
          if (index < 0) results.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return results;
  }
}
const el = (tag, className, text) => new Element(tag, className, text);
const row = (label, status = "待完成") => el("li", "lh-cur-item").append(
  el("span", "lh-cur-check"), el("span", "lh-cur-item-label", label), el("span", "lh-cur-item-badge", status));

function officialPanel(options = {}) {
  const heading = el("div", "lh-cur-head").append(el("span", "lh-cur-eyebrow", "当前任务"), el("span", "lh-cur-pill", "进行中"));
  const reward = el("div", "lh-cur-reward", "+0.2").append(el("span", "lh-cur-reward-unit", "LUX"));
  const top = el("div", "lh-cur-top").append(el("div", "lh-cur-name", options.author || "xux"), reward);
  const todo = el("ul", "lh-cur-todo").append(...(options.rows || [row("评论"), row("点赞", "已完成")]));
  const dwell = el("div", "lh-cur-dwell-row").append(
    el("svg", "").append(el("title", "", "dwell")), el("span", "", "停留时长"), el("span", "r", "63 / 10s"));
  const button = el("button", "lh-cur-btn off", "完成上面步骤解锁");
  button.disabled = true;
  const body = el("div", "lh-cur-body").append(
    ...(options.guide ? [el("div", "lh-cur-guide-text", options.guide)] : []),
    el("div", "lh-cur-todo-label", "要完成"), todo, el("div", "lh-cur-dwell").append(dwell), button);
  const card = el("div", "lh-cur-card").append(top, body);
  const panel = el("section", "lh-cur-sec").append(heading, card);
  panel.forceTextContent = Boolean(options.forceTextContent);
  return { panel, heading, top, reward, card, body, todo, dwell, button };
}

function infer(...fixtures) {
  const body = el("body").append(...fixtures.map(fixture => fixture.panel));
  const c = vm.createContext({ document: { body },
    normalizeText: value => String(value || "").replace(/\s+/g, " ").trim(),
    queryAccessibleElements: selector => body.querySelectorAll(selector),
    isVisible: node => Boolean(node && node.visible),
  });
  for (const name of ["parseCurrentTaskRequirements", "readStructuredCurrentTaskRequirements", "inferTaskActions"]) {
    const code = declaration(name);
    if (code) vm.runInContext(code, c);
  }
  return c.inferTaskActions();
}

function assertComposite(actions) {
  assert.equal(actions.complete, true, actions.reason);
  assert.equal(actions.needsComment, true);
  assert.equal(actions.needsLike, true);
  assert.equal(actions.needsFollow, false);
  assert.deepEqual(Array.from(actions.steps, step => [step.label, step.completed]), [["评论", false], ["点赞", true]]);
  assert.equal(actions.dwellSeconds, 63);
  assert.equal(actions.requiredDwellSeconds, 10);
}

test("official semantic DOM reads both actions while its verification button is disabled", () => {
  assertComposite(infer(officialPanel()));
});
test("SVG title text cannot become an extra task requirement through textContent", () => {
  const fixture = officialPanel({ forceTextContent: true });
  assert.match(fixture.panel.textContent, /已完成dwell停留时长/);
  assertComposite(infer(fixture));
});
test("author and comment guidance wording cannot add duplicate current-task headings or steps", () => {
  assertComposite(infer(officialPanel({ author: "当前任务", guide: "你要完成的事是什么？请在评论中解释当前任务。" })));
});
test("known unsupported actions remain explicit instead of silently becoming pure-like", () => {
  const result = infer(officialPanel({ rows: [row("引用"), row("点赞", "已完成")] }));
  assert.equal(result.complete, true);
  assert.deepEqual(Array.from(result.unsupported), ["引用"]);
});

for (const label of ['转发', '转发互动', '转推', '转帖', 'Repost', 'Retweet']) {
  test(`official semantic DOM preserves ${label} as a repost requirement`, () => {
    const result = infer(officialPanel({rows: [row(label), row('点赞', '已完成')]}));
    assert.equal(result.complete, true);
    assert.equal(result.needsRepost, true);
    assert.equal(result.needsLike, true);
    assert.equal(result.needsComment, false);
    assert.deepEqual(Array.from(result.unsupported), []);
  });
}

for (const invalid of ["missing label", "missing badge", "loading status", "unknown action", "duplicate label", "duplicate badge", "wrapped row", "hidden row", "non-row child", "empty list", "two lists", "missing list class", "two dwell rows", "two dwell values", "invalid dwell", "missing dwell value", "two rewards", "invalid reward"]) {
  test(`recognized official panel fails closed for ${invalid}`, () => {
    const f = officialPanel({ guide: "评论方向可以提到点赞。" });
    const first = f.todo.children[0];
    if (invalid === "missing label") first.children = first.children.filter(n => !n.matches(".lh-cur-item-label"));
    if (invalid === "missing badge") first.children = first.children.filter(n => !n.matches(".lh-cur-item-badge"));
    if (invalid === "loading status") first.querySelectorAll(".lh-cur-item-badge")[0].text = "加载中";
    if (invalid === "unknown action") first.querySelectorAll(".lh-cur-item-label")[0].text = "投票";
    if (invalid === "duplicate label") first.append(el("span", "lh-cur-item-label", "评论"));
    if (invalid === "duplicate badge") first.append(el("span", "lh-cur-item-badge", "待完成"));
    if (invalid === "wrapped row") { f.todo.children = []; f.todo.append(el("div", "").append(first)); }
    if (invalid === "hidden row") first.visible = false;
    if (invalid === "non-row child") f.todo.append(el("div", "", ""));
    if (invalid === "empty list") f.todo.children = [];
    if (invalid === "two lists") f.body.append(el("ul", "lh-cur-todo").append(row("关注")));
    if (invalid === "missing list class") f.todo.className = "unknown-list";
    if (invalid === "two dwell rows") f.body.append(el("div", "lh-cur-dwell-row").append(el("span", "r", "63 / 10s")));
    if (invalid === "two dwell values") f.dwell.append(el("span", "r", "63 / 10s"));
    if (invalid === "invalid dwell") f.dwell.querySelectorAll(".r")[0].text = "加载中";
    if (invalid === "missing dwell value") f.dwell.children = f.dwell.children.filter(n => !n.matches(".r"));
    if (invalid === "two rewards") f.top.append(el("div", "lh-cur-reward", "+0.3 LUX"));
    if (invalid === "invalid reward") f.reward.text = "未知";
    const result = infer(f);
    assert.equal(result.complete, false, invalid);
  });
}

test("a complete-looking guide cannot fill in a partial recognized official list", () => {
  const f = officialPanel({ guide: "当前任务 +0.2LUX 要完成 评论 待完成 点赞 已完成 停留时长 63/10s" });
  f.todo.children = [];
  assert.equal(infer(f).complete, false);
});
test("two official panels remain ambiguous even when only one has finished loading", () => {
  const first = officialPanel(), second = officialPanel();
  first.todo.children = [];
  const result = infer(first, second);
  assert.equal(result.complete, false);
  assert.match(result.reason, /多个/);
});
test("two complete official panels remain ambiguous", () => {
  assert.equal(infer(officialPanel(), officialPanel()).complete, false);
});
test("legacy non-structured official controls keep the strict text parser", () => {
  const panel = el("div", "", "当前任务 +0.2LUX 要完成 评论 待完成 点赞 已完成 停留时长63/10s");
  panel.append(el("button", "lh-cur-btn off", "完成上面步骤解锁"));
  assertComposite(infer({ panel }));
});

test("an official panel missing its header cannot infer a complete-looking guide as requirements", () => {
  const f = officialPanel({ guide: "当前任务 +0.2LUX 要完成 点赞 待完成 停留时长 63/10s" });
  f.heading.children = [];
  f.body.children = f.body.children.filter(node => !node.matches(".lh-cur-todo-label"));
  f.todo.children = [];
  assert.equal(infer(f).complete, false);
});
