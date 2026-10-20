"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const RUN = "popup-run";
const TARGET = "https://x.com/invited/status/2110664701864444362";
const OTHER = "https://x.com/other/status/2110664701864444363";
const INVITATION_KEY = "invitation:https://x.com/i/status/2110664701864444362";
const source = fs.readFileSync(path.join(process.env.LIGHTHOUSE_TEST_SOURCE_ROOT || path.join(__dirname, "../src"), "content/lighthouse.js"), "utf8");

// A small semantic DOM, not selector-specific answers. The real listener,
// invitation selectors, claim checkpoints, click path and lock flow execute.
class Element {
  constructor(tag, text = "", children = [], attrs = {}, rect = {}) {
    Object.assign(this, { tagName: tag.toUpperCase(), ownText: text, children: [], attrs,
      clicks: 0, isConnected: true, disabled: Object.hasOwn(attrs, "disabled"), hidden: false });
    this.rect = { left: 180, top: 180, width: 280, height: 28, ...rect };
    this.classList = { contains: value => String(attrs.class || "").split(/\s+/).includes(value) };
    this.replaceChildren(...children);
  }
  get innerText() { return [this.ownText, ...this.children.map(child => child.innerText)].filter(Boolean).join("\n"); }
  get textContent() { return this.innerText; }
  get href() { return this.attrs.href || ""; }
  set href(value) { this.attrs.href = value; }
  get parentNode() { return this.parentElement; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
  getBoundingClientRect() {
    const rect = { ...this.rect };
    if (!this.isConnected || this.hidden) rect.width = rect.height = 0;
    return { ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top };
  }
  matches(selector) {
    return selector.split(",").some(raw => {
      let part = raw.trim();
      if (part.includes(" ")) {
        const split = part.lastIndexOf(" ");
        return this.matches(part.slice(split + 1)) && Boolean(this.parentElement?.closest(part.slice(0, split)));
      }
      if (part === "*") return true;
      const tag = part.match(/^[a-z][a-z0-9-]*/i)?.[0];
      if (tag && tag.toUpperCase() !== this.tagName) return false;
      if (tag) part = part.slice(tag.length);
      if (part.startsWith(".")) return this.classList.contains(part.slice(1));
      const attrs = [...part.matchAll(/\[([^\]=*^$~]+)(?:([*^$~]?=)["']?([^\]"']*)["']?)?\]/g)];
      if (part && attrs.length === 0) return false;
      return attrs.every(([, name, operator, expected]) => {
        const actual = this.getAttribute(name);
        if (!operator) return actual !== null;
        if (actual === null) return false;
        if (operator === "*=") return String(actual).includes(expected);
        if (operator === "^=") return String(actual).startsWith(expected);
        if (operator === "$=") return String(actual).endsWith(expected);
        return actual === expected;
      });
    });
  }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelectorAll(selector) { return this.descendants().filter(node => node.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  contains(node) { return node === this || this.descendants().includes(node); }
  replaceChildren(...children) {
    for (const child of this.children) child.disconnect();
    this.children = children;
    for (const child of children) { child.parentElement = this; child.connect(); }
  }
  connect() { this.isConnected = true; for (const child of this.children) child.connect(); }
  disconnect() { this.isConnected = false; for (const child of this.children) child.disconnect(); }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.disconnect();
  }
  appendChild(child) { this.children.push(child); child.parentElement = this; child.connect(); return child; }
  scrollIntoView() {}
  click() { this.clicks += 1; this.onClick?.(); }
  dispatchEvent(event) { if (event.type === "click") this.click(); return true; }
}

function page(options = {}) {
  let listener, now = 1000000;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const f = { reports: [], checkpoints: [], waits: [], clicksAtPermit: [], beforePermit: null, beforeWait: null,
    detail: null, lock: null, popup: null, accept: null, skip: null, popupClose: null, dispatchedEvents: [] };
  const action = new Element("button", options.waitingList ? "等待下一批释放 · 20m" : "查看详情", [],
    options.waitingList ? { disabled: "" } : {});
  const card = new Element("article", "", [new Element("span", "评论留言"), new Element("h3", "广场另一任务 @other"),
    new Element("div", "", [new Element("span", "预计获得"), new Element("span", "0.20 LUX")]),
    new Element("div", "", [action], { "data-mobile-card-slot": "action" })], { role: "button" }, { width: 330, height: 400 });
  const heading = new Element("h1", "任务广场");
  const all = new Element("button", "全部", [], { disabled: "" });
  const marketplace = new Element("main", "", [heading, all, new Element("button", "可抢 1"), new Element("button", "进行中 0"), card], {}, { width: 1100, height: 800 });
  const body = new Element("body", "", [marketplace], {}, { left: 0, top: 0, width: 1440, height: 1000 });
  const document = { body, documentElement: body, hidden: false, addEventListener() {},
    querySelectorAll: selector => body.querySelectorAll(selector), querySelector: selector => body.querySelector(selector),
    elementFromPoint: () => body,
    dispatchEvent(event) { f.dispatchedEvents.push(event.type); return true; },
    createTreeWalker(root, _kind, filter) {
      const nodes = [root, ...root.descendants()].filter(node => node.ownText)
        .map(node => ({ nodeValue: node.ownText, parentElement: node })).filter(node => filter.acceptNode(node) === 1);
      let index = 0;
      return { currentNode: null, nextNode() { this.currentNode = nodes[index++]; return Boolean(this.currentNode); } };
    }
  };
  const installDetail = (target = TARGET) => {
    f.popup?.remove();
    f.detail?.remove();
    const close = new Element("button", "关闭", [], { "aria-label": "关闭" }, { left: 1010, top: 40, width: 32, height: 32 });
    close.onClick = () => f.detail.remove();
    const title = new Element("h2", "评论任务");
    const badge = new Element("span", "评论");
    const bounty = new Element("span", "0.10 LUX");
    const targetLabel = new Element("p", "目标推文");
    const link = new Element("a", "查看推文", [], { href: target });
    const lock = new Element("button", "锁定席位");
    const detail = new Element("section", "", [close, title, badge, bounty, targetLabel, link, lock], { role: "dialog" }, { left: 400, top: 100, width: 640, height: 600 });
    lock.onClick = () => detail.replaceChildren(close, title, badge, bounty, targetLabel, link,
      new Element("span", "席位已锁定"), new Element("a", "去 X 完成动作", [], { href: target }));
    body.appendChild(detail); f.detail = detail; f.lock = lock;
    return detail;
  };
  action.onClick = card.onClick = () => installDetail(OTHER);
  const showPopup = (extra = {}) => {
    f.popup?.remove();
    const accept = new Element("button", "接受并开始", [], extra.disabled ? { disabled: "" } : {});
    const skip = new Element("button", "跳过");
    const close = new Element("button", "关闭", [], { "aria-label": "关闭" }, { left: 1000, top: 30, width: 32, height: 32 });
    const targetLink = new Element("a", "目标推文", [], { href: extra.target || TARGET });
    const popup = new Element("div", "", [new Element("p", "Lighthouse · 专属任务邀请"),
      new Element("h2", "一条新任务，等你接单"), new Element("strong", `${extra.bounty || "0.10"} LUX`),
      new Element("span", extra.taskType || "评论"), new Element("span", "Tier D-"), targetLink, accept, skip, close],
    { role: "dialog", "aria-modal": "true", class: "fixed invitation-modal" }, { left: 390, top: 120, width: 660, height: 600 });
    popup.style = { position: "fixed", zIndex: "50" };
    accept.onClick = () => {
      if (options.outcome === "visible") return;
      if (options.outcome === "disabled") { accept.disabled = true; return; }
      installDetail(options.outcome === "wrong-detail" ? OTHER : targetLink.href);
    };
    skip.onClick = close.onClick = () => popup.remove();
    body.appendChild(popup);
    Object.assign(f, { popup, accept, skip, popupClose: close, targetLink });
    return popup;
  };
  f.showPopup = showPopup; f.installDetail = installDetail;
  if (options.popup !== false) showPopup(options);
  const dispatch = message => new Promise(resolve => {
    if (!listener(message, {}, resolve)) resolve({ ok: false, unhandled: true });
  });
  const c = vm.createContext({ console, URL, Date: Clock, Element, document,
    location: { href: "https://app.lhdao.top/campaigns", origin: "https://app.lhdao.top", pathname: "/campaigns" },
    window: { innerWidth: 1440, innerHeight: 1000, addEventListener() {} },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    getComputedStyle: node => ({ display: node.hidden ? "none" : "block", visibility: "visible", position: "static", zIndex: "0", ...node.style }),
    MouseEvent: class { constructor(type, value) { this.type = type; Object.assign(this, value); } },
    KeyboardEvent: class { constructor(type, value) { this.type = type; Object.assign(this, value); } },
    localStorage: { getItem() { return null; }, setItem() {} },
    setTimeout, clearTimeout,
    fetch: async () => { throw Error("Network forbidden in invitation popup tests"); },
    fixtureWait: async ms => {
      now += Math.max(1, Number(ms) || 0); f.waits.push(ms);
      await f.beforeWait?.(ms);
      if (now > 1100000) throw Error("Fixture exhausted bounded observation window");
    },
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } },
      async sendMessage(message) {
        f.reports.push(JSON.parse(JSON.stringify(message)));
        if (message.type === "GET_CONTENT_SETTINGS") return { ok: true, paused: false, settings: { autoMinTaskBounty: options.minimum || 0 } };
        if (message.type === "LIGHTHOUSE_CLAIM_CHECKPOINT") {
          f.checkpoints.push(JSON.parse(JSON.stringify(message)));
          if (message.phase === "before_click") {
            f.clicksAtPermit.push((f.accept?.clicks || 0) + (f.lock?.clicks || 0));
            await f.beforePermit?.(message);
          }
          return { ok: true, checkpointRegistered: true, permitClaimClick: message.phase === "before_click",
            claimIntentId: message.claimIntentId, instanceId: message.instanceId };
        }
        return { ok: true };
      }
    } }
  });
  const end = source.lastIndexOf("})();");
  vm.runInContext(source.slice(0, end) + "\nwait = fixtureWait;\n" + source.slice(end), c);
  const run = (type = "START_LIGHTHOUSE_COMMENT_TASK", extra = {}) => dispatch({ type, platform: "lighthouse", runId: RUN,
    claimIntentId: "popup-intent", claimCheckpointRequired: true,
    settings: { actionDelayMs: 150, cooldownPollMs: 250, lockSeatTimeoutMs: 5000, enableCooldownSniping: true,
      autoMinTaskBounty: options.minimum || 0, ...extra.settings }, ...extra });
  return { f, body, marketplace, card, action, c, run, dispatch,
    pause: () => dispatch({ type: "AUTOMATION_PAUSE_CHANGED", paused: true }),
    read: () => dispatch({ type: "CHECK_LIGHTHOUSE_INVITATION", platform: "lighthouse" }) };
}

test("ordinary list selection still completes its actual detail and lock path", async () => {
  const p = page({ popup: false });
  const result = await p.run();
  assert.equal(result.ok, true, result.message);
  assert.equal(p.action.clicks, 1);
  assert.equal(p.f.lock.clicks, 1);
  assert.equal(result.task.tweetUrl, OTHER);
});

for (const type of ["START_LIGHTHOUSE_COMMENT_TASK", "DEBUG_OPEN_FIRST_COMMENT_TASK"]) {
  test(`initial exclusive invitation follows its own identity through ${type}`, async () => {
    const p = page();
    const result = await p.run(type);
    assert.equal(result.ok, true, result.message);
    assert.equal(p.f.accept.clicks, 1);
    assert.equal(p.action.clicks + p.card.clicks, 0, "the underlying task must never be selected");
    assert.equal(result.task.taskKey, INVITATION_KEY);
    assert.equal(result.task.tweetUrl, TARGET);
    assert.equal(p.f.lock.clicks, type === "START_LIGHTHOUSE_COMMENT_TASK" ? 1 : 0);
    assert.equal(result.claimActionAttempted, true);
    assert.equal(p.f.clicksAtPermit[0], 0, "persistent permission precedes the invitation click");
    const invitationPermit = p.f.checkpoints.find(value => value.phase === "before_click");
    assert.ok(JSON.stringify(invitationPermit).includes(INVITATION_KEY), "the click checkpoint must retain invitation identity");
    assert.ok(JSON.stringify(invitationPermit).includes(TARGET), "the click checkpoint must retain its target");
    if (type === "DEBUG_OPEN_FIRST_COMMENT_TASK") assert.equal(result.detailConfirmation.invitationResolved, true);
  });
}

test("an invitation arriving during a pending marketplace scan takes over without clicking the old card", async () => {
  const p = page({ popup: false, waitingList: true });
  p.f.beforeWait = () => { if (!p.f.popup) p.f.showPopup(); };
  const result = await p.run();
  assert.equal(result.ok, true, result.message);
  assert.equal(p.f.accept.clicks, 1);
  assert.equal(p.action.clicks + p.card.clicks, 0);
  assert.equal(result.task.taskKey, INVITATION_KEY);
  assert.equal(p.f.lock.clicks, 1);
});

for (const outcome of ["visible", "disabled", "wrong-detail"]) {
  test(`accepted invitation with ${outcome} outcome is not clicked again or treated as completed detail`, async () => {
    const p = page({ outcome });
    const result = await p.run("DEBUG_OPEN_FIRST_COMMENT_TASK");
    assert.equal(p.f.accept.clicks, 1);
    assert.equal(result.ok, false);
    assert.equal(result.claimActionAttempted, true);
    assert.equal(result.detailConfirmation, undefined);
    assert.equal(p.f.lock?.clicks || 0, 0);
    assert.equal(p.action.clicks + p.card.clicks, 0);
  });
}

for (const change of ["stop", "target", "button", "root"]) {
  test(`${change} while invitation checkpoint is pending prevents the physical accept`, async () => {
    const p = page();
    const original = p.f.accept;
    let replacement;
    p.f.beforePermit = async () => {
      if (change === "stop") await p.pause();
      else if (change === "target") p.f.targetLink.href = OTHER;
      else if (change === "button") { p.f.accept.remove(); replacement = new Element("button", "接受并开始"); p.f.popup.appendChild(replacement); }
      else p.f.showPopup();
    };
    const result = await p.run("DEBUG_OPEN_FIRST_COMMENT_TASK");
    assert.equal(p.f.checkpoints.some(value => value.phase === "before_click"), true);
    assert.equal(original.clicks + (replacement?.clicks || 0) + (p.f.accept === original ? 0 : p.f.accept.clicks), 0);
    assert.equal(result.ok, false);
    assert.equal(p.action.clicks + p.card.clicks, 0);
  });
}

test("a bound different invited order cannot be replaced by the popup", async () => {
  const p = page();
  const result = await p.run("START_LIGHTHOUSE_COMMENT_TASK", { task: { taskKey: "old-order", tweetUrl: OTHER,
    invitationAccepted: { taskKey: "old-order" } } });
  assert.equal(result.ok, false);
  assert.equal(p.f.accept.clicks, 0);
  assert.equal(p.f.checkpoints.some(value => value.phase === "before_click"), false);
});

for (const type of ["OPEN_SELECTED_COUNTDOWN_TASK_DETAIL", "OPEN_SELECTED_COUNTDOWN_TASK_TWEET", "WAIT_SELECTED_COUNTDOWN_AND_LOCK"]) {
  test(`selected task entry ${type} cannot accept a standalone invitation`, async () => {
    const p = page();
    const result = await p.run(type, { selectedTask: { taskKey: "selected-other", taskType: "评论", tweetUrl: OTHER } });
    assert.equal(result.ok, false);
    assert.equal(p.f.accept.clicks, 0);
    assert.equal(p.action.clicks + p.card.clicks, 0);
  });
}

for (const options of [{ taskType: "原创推文" }, { minimum: 0.15 }]) {
  test(`ineligible invitation is skipped before continuing the ordinary scan: ${JSON.stringify(options)}`, async () => {
    const p = page(options);
    const result = await p.run();
    assert.equal(p.f.accept.clicks, 0);
    assert.equal(p.f.skip.clicks, 1);
    assert.equal(p.f.checkpoints.some(value => value.phase === "before_click"
      && JSON.stringify(value).includes(INVITATION_KEY)), false);
    assert.equal(result.ok, true, result.message);
    assert.equal(result.task.tweetUrl, OTHER);
    assert.equal(p.action.clicks, 1);
    assert.equal(p.f.lock.clicks, 1);
  });
}

for (const disabled of [false, true]) {
  test(`read-only invitation inspection reports pending without actions, disabled=${disabled}`, async () => {
    const p = page({ disabled });
    const result = await p.read();
    assert.equal(result.ok, true);
    assert.equal(result.pending, true);
    assert.equal(result.invitationPending, true);
    assert.equal(p.f.accept.clicks + p.f.skip.clicks + p.f.popupClose.clicks, 0);
    assert.equal(p.f.checkpoints.length, 0);
  });
}

test("ordinary detail and invitation-like list prose are not standalone invitation prompts", async () => {
  const p = page({ popup: false });
  p.f.installDetail();
  assert.equal((await p.read()).pending, false);
  p.f.detail.remove();
  p.card.appendChild(new Element("p", "Lighthouse · 专属任务邀请 一条新任务，等你接单"));
  p.card.appendChild(new Element("a", "目标推文", [], { href: TARGET }));
  p.card.appendChild(new Element("button", "接受并开始"));
  assert.equal((await p.read()).pending, false);
  assert.equal(p.action.clicks + p.card.clicks, 0);
});

test("ordinary detail cleanup leaves an exclusive invitation intact", async () => {
  const p = page();
  const result = await p.run("CLOSE_LIGHTHOUSE_TASK_DETAIL");
  assert.equal(result.ok, true, result.message);
  assert.equal(p.f.popup.isConnected, true);
  assert.equal(p.f.accept.clicks + p.f.skip.clicks + p.f.popupClose.clicks, 0);
  assert.deepEqual(p.f.dispatchedEvents, []);
});

test("an invitation appearing while an older detail closes is preserved without Escape or backdrop actions", async () => {
  const p = page({ popup: false });
  p.f.installDetail();
  const oldDetailClose = p.f.detail.querySelector("button");
  p.f.beforeWait = () => {
    if (!p.f.popup) p.f.showPopup();
  };
  const result = await p.run("CLOSE_LIGHTHOUSE_TASK_DETAIL");
  assert.equal(p.f.popup.isConnected, true);
  assert.equal(p.f.accept.clicks + p.f.skip.clicks + p.f.popupClose.clicks, 0);
  assert.deepEqual(p.f.dispatchedEvents, [], "a newly arrived invitation must not receive the fallback Escape");
  assert.equal(p.body.clicks, 0, "the backdrop fallback must not dismiss the new invitation");
  assert.equal(oldDetailClose.clicks, 0, "the stale close operation must yield as soon as the invitation appears");
  assert.equal(result.ok, true, result.message);
  assert.equal(result.invitationPending, true);
});

test("manual-only guidance appearing during the invitation checkpoint prevents acceptance", async () => {
  const p = page();
  p.f.beforePermit = () => {
    p.f.popup.appendChild(new Element("p", "评论引导：请填写钱包地址"));
  };
  const result = await p.run("DEBUG_OPEN_FIRST_COMMENT_TASK");
  assert.equal(p.f.checkpoints.some(value => value.phase === "before_click"), true,
    "the guidance update must occur while the persistent permission is pending");
  assert.equal(p.f.accept.clicks, 0, "manual-only guidance must be rechecked immediately before accepting");
  assert.equal(p.f.lock?.clicks || 0, 0);
  assert.equal(p.action.clicks + p.card.clicks, 0);
  assert.equal(result.ok, false);
});

test("a disabled invitation cannot produce an accept or lock action", async () => {
  const p = page({ disabled: true });
  const result = await p.run();
  assert.equal(result.ok, false);
  assert.equal(p.f.accept.clicks + p.f.skip.clicks + p.f.popupClose.clicks, 0);
  assert.equal(p.f.lock?.clicks || 0, 0);
  assert.equal(p.f.checkpoints.some(value => value.phase === "before_click"), false);
});

test("an explicitly expired invitation is never accepted even if its button remains enabled", async () => {
  const p = page();
  p.f.popup.appendChild(new Element("p", "邀请已过期"));
  await p.run("DEBUG_OPEN_FIRST_COMMENT_TASK");
  assert.equal(p.f.accept.clicks, 0);
  assert.equal(p.f.lock?.clicks || 0, 0);
  assert.equal(p.f.checkpoints.some(value => value.phase === "before_click"
    && JSON.stringify(value).includes(INVITATION_KEY)), false);
});

for (const target of ["", "javascript:alert(1)", "https://x.com.evil.example/invited/status/2110664701864444362",
  "https://attacker@x.com/invited/status/2110664701864444362", "http://x.com/invited/status/2110664701864444362"]) {
  test(`an invitation without a unique trusted target is not accepted: ${target || "missing"}`, async () => {
    const p = page();
    p.f.targetLink.href = target;
    const result = await p.run();
    assert.equal(result.ok, false);
    assert.equal(p.f.accept.clicks + p.f.skip.clicks + p.f.popupClose.clicks, 0);
    assert.equal(p.f.lock?.clicks || 0, 0);
    assert.equal(p.f.checkpoints.some(value => value.phase === "before_click"), false);
  });
}

test("an invitation with two different target tweets is not accepted", async () => {
  const p = page();
  p.f.popup.appendChild(new Element("a", "查看目标推文", [], { href: OTHER }));
  const result = await p.run();
  assert.equal(result.ok, false);
  assert.equal(p.f.accept.clicks, 0);
  assert.equal(p.f.checkpoints.some(value => value.phase === "before_click"), false);
});

test("comment plus like invitation retains both required actions through the full claim path", async () => {
  const p = page({ taskType: "评论+点赞" });
  const result = await p.run();
  assert.equal(result.ok, true, result.message);
  assert.equal(result.task.taskType, "评论+点赞");
  assert.equal(result.task.tweetUrl, TARGET);
  assert.equal(p.f.accept.clicks, 1);
  assert.equal(p.f.lock.clicks, 1);
});

test("comment plus follow invitation is skipped rather than silently dropping its unsupported action", async () => {
  const p = page({ taskType: "评论+关注" });
  const result = await p.run();
  assert.equal(result.ok, true, result.message);
  assert.equal(result.task.tweetUrl, OTHER);
  assert.equal(p.f.accept.clicks, 0);
  assert.equal(p.f.skip.clicks, 1);
  assert.equal(p.f.lock.clicks, 1);
});

test("an invitation that directly establishes a locked order continues without a second lock click", async () => {
  const p = page();
  p.f.accept.onClick = () => {
    p.f.installDetail();
    p.f.lock.onClick();
  };
  const result = await p.run();
  assert.equal(result.ok, true, result.message);
  assert.equal(result.task.taskKey, INVITATION_KEY);
  assert.equal(result.task.tweetUrl, TARGET);
  assert.equal(result.task.seatLocked, true);
  assert.equal(p.f.accept.clicks, 1);
  assert.equal(p.f.lock.clicks, 0);
  assert.equal(p.f.checkpoints.filter(value => value.phase === "before_click").length, 1);
});

test("STOP immediately after invitation acceptance prevents every subsequent lock action", async () => {
  const p = page();
  p.f.accept.onClick = () => {
    p.f.installDetail();
    void p.pause();
  };
  const result = await p.run();
  assert.equal(result.ok, false);
  assert.equal(p.f.accept.clicks, 1);
  assert.equal(p.f.lock.clicks, 0);
  assert.equal(p.f.checkpoints.filter(value => value.phase === "before_click").length, 1);
  assert.equal(p.action.clicks + p.card.clicks, 0);
});

for (const change of ["stop", "target", "button", "root"]) {
  test(`${change} while the post-invitation lock checkpoint is pending prevents the physical lock`, async () => {
    const p = page();
    let originalLock;
    let replacementLock;
    p.f.beforePermit = async () => {
      if (p.f.checkpoints.filter(value => value.phase === "before_click").length !== 2) return;
      originalLock = p.f.lock;
      if (change === "stop") await p.pause();
      else if (change === "target") p.f.detail.querySelector("a[href]").href = OTHER;
      else if (change === "button") {
        originalLock.remove();
        replacementLock = new Element("button", "锁定席位");
        p.f.detail.appendChild(replacementLock);
      } else p.f.installDetail(OTHER);
    };
    const result = await p.run();
    assert.ok(originalLock, "the real lock checkpoint must have been reached");
    assert.equal(originalLock.clicks + (replacementLock?.clicks || 0)
      + (p.f.lock === originalLock ? 0 : p.f.lock.clicks), 0);
    assert.equal(result.ok, false);
    assert.equal(p.f.accept.clicks, 1);
    assert.equal(p.action.clicks + p.card.clicks, 0);
  });
}

test("invitation expiration during its persistent checkpoint prevents the accept click", async () => {
  const p = page();
  p.f.beforePermit = () => p.f.popup.appendChild(new Element("p", "邀请已过期"));
  const result = await p.run();
  assert.equal(result.ok, false);
  assert.equal(p.f.accept.clicks, 0);
  assert.equal(p.f.lock?.clicks || 0, 0);
});

test("a lock button disabled during its persistent checkpoint is not clicked", async () => {
  const p = page();
  p.f.beforePermit = () => {
    if (p.f.checkpoints.filter(value => value.phase === "before_click").length === 2) p.f.lock.disabled = true;
  };
  const result = await p.run();
  assert.equal(result.ok, false);
  assert.equal(p.f.accept.clicks, 1);
  assert.equal(p.f.lock.clicks, 0);
});

test("two simultaneous standalone invitation prompts cannot choose an arbitrary order", async () => {
  const p = page();
  const original = p.f.popup;
  const firstAccept = p.f.accept;
  p.f.showPopup({ target: OTHER });
  p.body.appendChild(original);
  const result = await p.run();
  assert.equal(result.ok, false);
  assert.equal(firstAccept.clicks + p.f.accept.clicks, 0);
  assert.equal(p.f.checkpoints.some(value => value.phase === "before_click"), false);
});

test("real content candidate reports preserve the durable invitation binding through the real worker lock checkpoint", async t => {
  const clone = value => JSON.parse(JSON.stringify(value));
  const stored = { lighthouseAiApiKey: "fixture-key" };
  const timers = new Set();
  const event = { addListener() {} };
  const tab = { id: 11, windowId: 1, url: "https://app.lhdao.top/campaigns", status: "complete" };
  const chrome = {
    runtime: { id: "test", getURL: value => `chrome-extension://test/${value}`,
      getManifest: () => ({ version: "test" }), onInstalled: event, onMessage: event },
    storage: { local: { async setAccessLevel() {},
      async get(keys) { return Object.fromEntries(keys.filter(key => Object.hasOwn(stored, key)).map(key => [key, clone(stored[key])])); },
      async set(values, callback) { Object.assign(stored, clone(values)); callback?.(); }, async remove() {} } },
    alarms: { onAlarm: event, async create() {}, async clear() {} },
    tabs: { onCreated: event, onUpdated: event, onRemoved: event, async get() { return { ...tab }; },
      async query() { return [{ ...tab }]; }, async sendMessage() { return { ok: true }; } }
  };
  const c = vm.createContext({ chrome, console, URL, Date, AbortController, importScripts() {},
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timer.unref(); timers.add(timer); return timer; },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
    fetch: async () => { throw Error("Network forbidden in integrated invitation test"); } });
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  for (const file of ["reply-engine.js", "background.js"]) {
    const root = process.env.LIGHTHOUSE_TEST_SOURCE_ROOT || path.join(__dirname, "../src");
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), c, { filename: file });
  }
  await vm.runInContext("runtimeStateReady", c);
  c.publishLighthouseMonitorSnapshot = () => {};
  vm.runInContext(`Object.assign(runtimeState, { running: true, mode: "auto", runId: "${RUN}",
    lighthouseTabId: 11, lighthouseWindowId: 1, runtimeWindowId: 1, currentTask: null,
    uncertainAction: { type: "START_LIGHTHOUSE_COMMENT_TASK", runId: "${RUN}", tabId: 11,
      intentId: "popup-intent", taskKey: "", checkpointRequired: true } })`, c);
  const p = page();
  const originalSend = p.c.chrome.runtime.sendMessage;
  const workerMessages = [];
  p.c.chrome.runtime.sendMessage = async message => {
    if (!["LIGHTHOUSE_CLAIM_CHECKPOINT", "DEBUG_TASK_CANDIDATE"].includes(message.type)) return originalSend(message);
    const result = await c.handleMessage(clone(message), { id: "test", tab, frameId: 0, url: tab.url });
    workerMessages.push({ message: clone(message), result: clone(result) });
    return result;
  };
  const result = await p.run();
  assert.equal(result.ok, true, result.message);
  assert.equal(p.f.accept.clicks, 1);
  assert.equal(p.f.lock.clicks, 1);
  const candidates = workerMessages.filter(value => value.message.type === "DEBUG_TASK_CANDIDATE");
  assert.ok(candidates.length >= 1, "the actual content candidate event must cross the worker boundary");
  assert.ok(candidates.every(value => value.message.task.taskKey === INVITATION_KEY));
  assert.equal(workerMessages.filter(value => value.message.phase === "before_click" && value.result.permitClaimClick === true).length, 2);
  assert.equal(stored.lighthouseAutoRunStateV1.currentTask.taskKey, INVITATION_KEY);
  assert.equal(stored.lighthouseAutoRunStateV1.currentTask.tweetUrl, TARGET);
});

test("inline invitation header badges remain identifiable without reading target tweet prose as task type", async () => {
  const p = page();
  const popup = p.f.popup;
  popup.appendChild(new Element("p", "关注与转发是这条目标推文谈论的话题"));
  Object.defineProperty(popup, "innerText", { get() {
    return [this.children.slice(0, 5).map(node => node.innerText).join(" "),
      ...this.children.slice(5).map(node => node.innerText)].join("\n");
  } });
  const result = await p.run();
  assert.equal(result.ok, true, result.message);
  assert.equal(result.task.taskType, "评论");
  assert.equal(result.task.tweetUrl, TARGET);
  assert.equal(p.f.accept.clicks, 1);
  assert.equal(p.f.skip.clicks, 0);
  assert.equal(p.f.lock.clicks, 1);
});

for (const changeTarget of [false, true]) {
  test(`separate debug lock step stays bound to the accepted invitation, targetChanges=${changeTarget}`, async () => {
    const p = page();
    const opened = await p.run("DEBUG_OPEN_FIRST_COMMENT_TASK");
    assert.equal(opened.ok, true, opened.message);
    const boundTask = { ...opened.task, invitationAccepted: { taskKey: opened.task.taskKey } };
    p.f.beforePermit = () => {
      if (changeTarget) p.f.detail.querySelector("a[href]").href = OTHER;
    };
    const result = await p.run("DEBUG_LOCK_SEAT_AND_EXTRACT", { task: boundTask });
    assert.equal(p.f.accept.clicks, 1);
    assert.equal(result.ok, !changeTarget, result.message);
    assert.equal(p.f.lock.clicks, changeTarget ? 0 : 1);
    if (!changeTarget) {
      assert.equal(result.task.taskKey, INVITATION_KEY);
      assert.equal(result.task.tweetUrl, TARGET);
    }
  });
}
