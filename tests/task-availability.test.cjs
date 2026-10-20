const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

// Match the live marketplace: a clickable article contains a separate action
// slot, whose button can be disabled while the article remains clickable.
class Element {
  constructor(tag, text = '', children = [], attrs = {}) {
    Object.assign(this, { tagName: tag.toUpperCase(), ownText: text, children, attrs, clicks: 0, isConnected: true });
    this.disabled = 'disabled' in attrs;
    this.classList = { contains: () => false };
    for (const child of children) child.parentElement = this;
  }
  get innerText() { return [this.ownText, ...this.children.map(child => child.innerText)].filter(Boolean).join('\n'); }
  get textContent() { return this.innerText; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  getBoundingClientRect() { return { width: this.tagName === 'ARTICLE' ? 330 : 280, height: this.tagName === 'ARTICLE' ? 400 : 24, top: this.tagName === 'BUTTON' ? 350 : 0, left: 0 }; }
  matches(selector) {
    return selector.split(',').some(part => {
      const value = part.trim();
      if (value === '*') return true;
      const attr = value.match(/^\[([^=]+)=['"]([^'"]+)['"]\]$/);
      if (attr) return this.attrs[attr[1]] === attr[2];
      if (value === 'a[href]') return this.tagName === 'A' && Boolean(this.attrs.href);
      return value.toUpperCase() === this.tagName;
    });
  }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelectorAll(selector) { return this.descendants().filter(node => node.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  scrollIntoView() {}
  click() { this.clicks += 1; this.onClick?.(); }
}

function harness({ status = '查看详情', disabled = false, ariaDisabled = false, detailText = '', monitor = true, badge = '', extraStatus = '' } = {}) {
  let now = 1000000;
  const action = new Element('button', status, [], { ...(disabled ? { disabled: '' } : {}), ...(ariaDisabled ? { 'aria-disabled': 'true' } : {}) });
  const slot = new Element('div', '', [action, ...(extraStatus ? [new Element('div', extraStatus, [], { role: 'status' })] : [])], { 'data-mobile-card-slot': 'action' });
  const card = new Element('article', '', [new Element('span', '评论留言'), new Element('p', '测试任务 @fixture'), new Element('span', badge),
    new Element('div', '', [new Element('span', '预计获得'), new Element('span', '0.1 LUX'), new Element('p', '任务推文内容')]), slot], { role: 'button' });
  const root = new Element('section', detailText);
  const body = new Element('body', '', [card, root]);
  const fixture = { action, card, root, detailOpen: Boolean(detailText), waits: [], logs: [], onWait: null };
  action.onClick = card.onClick = () => { fixture.detailOpen = true; };
  const document = { body, hidden: false, addEventListener() {}, querySelectorAll: selector => body.querySelectorAll(selector), querySelector: selector => body.querySelector(selector),
    createTreeWalker(node, _kind, filter) {
      const nodes = [node, ...node.descendants()].filter(n => n.ownText).map(n => ({ nodeValue: n.ownText, parentElement: n })).filter(n => filter.acceptNode(n) === 1);
      let i = 0;
      return { currentNode: null, nextNode() { this.currentNode = nodes[i++]; return Boolean(this.currentNode); } };
    }
  };
  const c = vm.createContext({ fixture, console, URL, Element, document,
    Date: class extends Date { static now() { return now; } },
    advance(ms) { now += Math.max(1, Number(ms) || 0); },
    location: { href: 'https://app.lhdao.top/campaigns', origin: 'https://app.lhdao.top', pathname: '/campaigns' },
    window: { innerWidth: 1440, innerHeight: 1000, addEventListener() {} },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    localStorage: { getItem() { return null; }, setItem() {} },
    chrome: { runtime: { onMessage: { addListener() {} }, async sendMessage(message) { return message.type === 'GET_CONTENT_SETTINGS' ? { ok: true, paused: false } : undefined; } } }
  });
  const load = (file, adapters) => {
    const source = fs.readFileSync(path.join(__dirname, '../src/content', file), 'utf8');
    const end = source.lastIndexOf('})();');
    vm.runInContext(source.slice(0, end) + adapters + '\n' + source.slice(end), c);
  };
  if (monitor) load('lighthouse-monitor.js', 'globalThis.monitorTest = { parseStatusFromCard };');
  load('lighthouse.js', `
    activeRunId = 'availability-test';
    isTaskDetailOpen = () => fixture.detailOpen;
    isTaskDetailOrRecoverableOverlayOpen = () => fixture.detailOpen;
    findTaskDetailRoot = () => fixture.detailOpen ? fixture.root : null;
    isCampaignsListOpen = () => !fixture.detailOpen;
    hasTaskUnavailableError = hasDetailRequestTimeout = hasRecoverableDetailLoadFailure = hasEnteredDetailLoadingFlow = () => false;
    buildTask = () => ({ taskKey: 'fixture', taskType: '评论', detailText: fixture.root.innerText });
    acceptInvitationIfPresent = async () => false;
    report = (_level, text) => fixture.logs.push(text);
    wait = async (ms) => { fixture.waits.push(ms); advance(ms); fixture.onWait?.(); };
    globalThis.page = { collectTaskCandidates, getOpenTargetsInCard, openTaskDetailOrFail, findLockButtonAfterHydration, waitSelectedCountdownAndLock, waitWithDetailHealthCheck, extractDetailUnavailableReason, assertSupportedDetailTask };
  `);
  return { c, page: c.page, monitor: c.monitorTest, ...fixture, fixture, slot };
}

for (const monitor of [true, false]) {
  for (const status of ['暂不可接单', '需灯塔严选资格', '档位不符', '资格校验未通过', '等待资格审核']) {
    test(`disabled action blocks card without falling back to its article: ${status}, monitor=${monitor}`, () => {
      const h = harness({ status, disabled: true, monitor });
      const candidate = h.page.collectTaskCandidates([])[0];
      assert.equal(candidate.isBlocked, true);
      if (h.monitor) {
        const state = h.monitor.parseStatusFromCard(h.card);
        assert.equal(state.isBlocked, true);
        assert.equal(state.isReady, false);
      }
    });
  }
}

test('aria-disabled action also blocks a clickable article', () => {
  const h = harness({ status: '查看详情', ariaDisabled: true });
  assert.equal(h.page.collectTaskCandidates([])[0].isBlocked, true);
  assert.equal(h.monitor.parseStatusFromCard(h.card).isBlocked, true);
});

test('an eligibility denial takes priority over another countdown in the same card', () => {
  const h = harness({ status: '需灯塔严选资格', disabled: true, extraStatus: '冷却中 · 20s' });
  assert.equal(h.page.collectTaskCandidates([])[0].isBlocked, true);
  const state = h.monitor.parseStatusFromCard(h.card);
  assert.equal(state.isBlocked, true);
  assert.equal(state.isCooling, false);
});

test('an official disabled release timer remains eligible for waiting', () => {
  const h = harness({ status: '等待下一批释放 · 00:20', disabled: true });
  const candidate = h.page.collectTaskCandidates([])[0];
  assert.equal(candidate.isBlocked, false);
  assert.equal(candidate.cooldownMs, 20000);
  assert.equal(h.monitor.parseStatusFromCard(h.card).isCooling, true);
});

test('a curated-only badge alone does not exclude an eligible account', () => {
  const h = harness({ badge: '仅灯塔严选可接' });
  assert.equal(h.page.collectTaskCandidates([])[0].isBlocked, false);
  assert.equal(h.monitor.parseStatusFromCard(h.card).isReady, true);
});

test('a changed platform eligibility is read again rather than permanently excluded', () => {
  const h = harness({ status: '需灯塔严选资格', disabled: true, detailText: '' });
  assert.equal(h.page.collectTaskCandidates([])[0].isBlocked, true);
  h.action.ownText = '查看详情';
  h.action.disabled = false;
  assert.equal(h.page.collectTaskCandidates([])[0].isBlocked, false);
  assert.equal(h.monitor.parseStatusFromCard(h.card).isReady, true);
  h.root.ownText = '评论任务 档位不符，无法领取';
  h.fixture.detailOpen = true;
  assert.throws(() => h.page.assertSupportedDetailTask({ taskType: '评论' }), error => !error.permanentIgnore && /档位不符/.test(error.message));
  h.root.ownText = '评论任务 锁定席位';
  assert.doesNotThrow(() => h.page.assertSupportedDetailTask({ taskType: '评论' }));
});

test('disabled preferred targets never re-enter the click fallback list', () => {
  const h = harness({ status: '暂不可接单', disabled: true });
  assert.equal(h.page.getOpenTargetsInCard(h.card, h.action).includes(h.action), false);
});

for (const timing of ['before_open', 'during_scroll_delay', 'during_click_delay', 'replaced_card']) {
  test(`eligibility changing after selection prevents button and article clicks: ${timing}`, async () => {
    const h = harness();
    const selection = h.page.collectTaskCandidates([])[0];
    const restrict = () => { h.action.ownText = '需灯塔严选资格'; h.action.disabled = true; };
    if (timing === 'before_open') restrict();
    else if (timing === 'replaced_card') h.card.isConnected = false;
    else h.fixture.onWait = () => { if (timing === 'during_scroll_delay' || h.waits.length === 2) restrict(); };
    await assert.rejects(h.page.openTaskDetailOrFail(selection, { actionDelayMs: 10 }), /需灯塔严选资格|不可接|卡片已更新/);
    assert.equal(h.action.clicks + h.card.clicks, 0);
  });
}

for (const text of ['需灯塔严选资格', '档位不符', '暂不可接单', '当前等级不可', '额度不足']) {
  for (const method of ['findLockButtonAfterHydration', 'waitSelectedCountdownAndLock']) {
    test(`${method} rejects ${text} immediately instead of waiting for a missing lock button`, async () => {
      const h = harness({ detailText: `评论任务 TARGET TWEET 锁定席位 ${text}` });
      await assert.rejects(h.page[method]({}), error => error.message.includes(text) && !error.message.includes('超时'));
      assert.equal(h.waits.length, 0);
      assert.equal(h.action.clicks + h.card.clicks, 0);
      assert.ok(h.page.extractDetailUnavailableReason(h.root.innerText).includes(text));
    });
  }
}

test('countdown health checks ignore unavailable cards behind the current detail', async () => {
  const h = harness({ status: '不可领取', disabled: true, detailText: '评论任务 TARGET TWEET 等待下一批释放 · 00:20' });
  await h.page.waitWithDetailHealthCheck(1000, {});
  assert.equal(h.waits.length, 1);
});

test('a qualification denial arriving during the release wait interrupts the wait', async () => {
  const h = harness({ detailText: '评论任务 TARGET TWEET 等待下一批释放 · 00:20' });
  h.fixture.onWait = () => { h.root.ownText = '评论任务 TARGET TWEET 需灯塔严选资格'; };
  await assert.rejects(h.page.findLockButtonAfterHydration({}), /需灯塔严选资格/);
  assert.equal(h.waits.length, 1);
  assert.equal(h.action.clicks + h.card.clicks, 0);
});
