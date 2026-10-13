const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../src/content/lighthouse-monitor.js'), 'utf8');

// A small DOM fixture exercises the production collectors, ancestry, geometry,
// status parsing and identity together; it does not replace those functions.
class Element {
  constructor(tag, text = '', children = [], options = {}) {
    this.tagName = tag.toUpperCase();
    this.ownText = text;
    this.children = children;
    this.attrs = options.attrs || {};
    this.rect = { width: 100, height: 24, top: 0, left: 0, ...options.rect };
    this.visible = options.visible !== false;
    for (const child of children) child.parentElement = this;
  }
  get innerText() { return [this.ownText, ...this.children.map(child => child.innerText)].filter(Boolean).join('\n'); }
  get textContent() { return this.innerText; }
  getAttribute(name) { return this.attrs[name] || null; }
  getBoundingClientRect() { return this.rect; }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map(value => value.trim());
    return this.descendants().filter(node => selectors.some(value => {
      if (value === "[role='button']") return node.attrs.role === 'button';
      if (value === 'a[href]') return node.tagName === 'A' && Boolean(node.attrs.href);
      return value.toUpperCase() === node.tagName;
    }));
  }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
}

function makeCard({ title = '任务内容 @same_author', status = '查看详情', campaign = '', height = 300, type = '评论留言' } = {}) {
  const action = new Element('button', status, [], { rect: { top: 250, width: 280, height: 36 } });
  const children = [
    new Element('p', type),
    new Element('p', title),
    new Element('div', '', [new Element('span', '预计获得'), new Element('span', '0.1 LUX')]),
    action
  ];
  if (campaign) children.push(new Element('a', '任务入口', [], { attrs: { href: campaign } }));
  const card = new Element('article', '', children, {
    attrs: { role: 'button' }, rect: { width: 330, height, top: 180 }
  });
  return { card, action };
}

function harness(children, rect = { width: 1200, height: 1200 }, viewport = { width: 1440, height: 1000 }) {
  const body = new Element('body', '', children, { rect });
  const document = {
    body,
    hidden: false,
    addEventListener() {},
    querySelectorAll: selector => body.querySelectorAll(selector),
    createTreeWalker(root, _what, filter) {
      const texts = [root, ...root.descendants()].filter(node => node.ownText).map(node => ({ nodeValue: node.ownText, parentElement: node }));
      const matches = texts.filter(node => filter.acceptNode(node) === 1);
      let index = 0;
      return { currentNode: null, nextNode() { this.currentNode = matches[index++]; return Boolean(this.currentNode); } };
    }
  };
  const context = vm.createContext({
    console, URL, document, Element,
    location: { href: 'https://lighthouse.example/test', origin: 'https://lighthouse.example', pathname: '/test' },
    window: { innerWidth: viewport.width, innerHeight: viewport.height, addEventListener() {} },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    getComputedStyle: node => ({ display: node.visible ? 'block' : 'none', visibility: 'visible' }),
    localStorage: { getItem() { return null; }, setItem() {} },
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage() { return Promise.resolve({ ok: true }); } } }
  });
  const end = source.lastIndexOf('})();');
  assert.ok(end > 0);
  vm.runInContext(source.slice(0, end) + '\nglobalThis.monitorTest = { collectTaskInfos, findFallbackCard, extractTaskInfo, extractFallbackTaskInfo, dedupeTasks };\n' + source.slice(end), context);
  return context.monitorTest;
}

test('plaza tabs and multi-card containers never become monitor tasks', () => {
  const first = makeCard({ title: '第一条任务 @same_author' });
  const second = makeCard({ title: '第二条任务 @same_author', status: '冷却中 02:15' });
  const tab = new Element('button', '进行中 31');
  const header = new Element('div', '3 秒看清今天收益 — 接单、完成、提现，全部由 Lighthouse 自动结算', [tab]);
  const grid = new Element('div', '', [first.card, second.card], { rect: { width: 600, height: 500 } });
  const monitor = harness([header, grid]);
  assert.equal(monitor.findFallbackCard(tab), null);
  assert.equal(monitor.findFallbackCard(grid), null);
  const tasks = monitor.collectTaskInfos();
  assert.equal(tasks.length, 2);
  assert.deepEqual(Array.from(tasks, task => task.title).sort(), ['第一条任务 @same_author', '第二条任务 @same_author']);
  assert.equal(tasks.find(task => task.title.startsWith('第二')).countdownSec, 135);
});

test('a page wrapper containing just one reward still cannot become a task', () => {
  const real = makeCard();
  const tab = new Element('button', '进行中 31');
  const monitor = harness([tab, real.card]);
  assert.equal(monitor.findFallbackCard(tab), null);
  assert.equal(monitor.collectTaskInfos().length, 1);
});

test('fallback retains compact real cards and unknown task variants', () => {
  const compact = makeCard({ height: 115 });
  const unknown = makeCard({ title: '问卷内容 @survey_author', type: '问卷任务' });
  const monitor = harness([compact.card, unknown.card]);
  assert.equal(monitor.findFallbackCard(compact.action), compact.card);
  assert.equal(monitor.findFallbackCard(unknown.action), unknown.card);
  const tasks = monitor.collectTaskInfos();
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every(task => task.sourceConfidence === 55));
});

test('narrow-window single-column cards survive without admitting the plaza header', () => {
  const real = makeCard();
  real.card.rect.width = 550;
  const headerTab = new Element('button', '进行中 31');
  const monitor = harness([headerTab, real.card], { width: 550, height: 500 }, { width: 600, height: 1000 });
  assert.equal(monitor.findFallbackCard(real.action), real.card);
  assert.equal(monitor.findFallbackCard(headerTab), null);
  const tasks = monitor.collectTaskInfos();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].isReady, true);
  assert.equal(tasks[0].sourceConfidence, 55);
});

test('primary and fallback views of one card merge despite conflicting status', () => {
  const real = makeCard();
  const monitor = harness([real.card]);
  const primary = monitor.extractTaskInfo(real.card);
  const fallback = { ...monitor.extractFallbackTaskInfo(real.card), isReady: false, isBlocked: true };
  assert.equal(primary.taskIdentity, fallback.taskIdentity);
  for (const entries of [[primary, fallback], [fallback, primary]]) {
    const tasks = monitor.dedupeTasks(entries);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0], primary);
    assert.equal(tasks[0].isReady, true);
  }
  assert.equal(monitor.collectTaskInfos().length, 1);
});

test('different cards remain separate even with identical author, title and reward', () => {
  const first = makeCard();
  const second = makeCard();
  const monitor = harness([first.card, second.card]);
  const tasks = monitor.collectTaskInfos();
  assert.equal(tasks.length, 2);
  assert.notEqual(tasks[0].taskIdentity, tasks[1].taskIdentity);
});

test('nested compact and full-size wrappers share the same reward identity without hrefs', () => {
  const compact = makeCard({ height: 115 });
  const outer = new Element('article', '', [compact.card], { rect: { width: 350, height: 300 } });
  const monitor = harness([outer]);
  assert.equal(monitor.findFallbackCard(compact.action), compact.card);
  const primary = monitor.extractTaskInfo(outer);
  const fallback = monitor.extractFallbackTaskInfo(compact.card);
  assert.equal(primary.taskIdentity, fallback.taskIdentity);
  const tasks = monitor.collectTaskInfos();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].sourceConfidence, primary.sourceConfidence);
});

test('same campaign links merge copies; different campaigns and bonus links do not', () => {
  const first = makeCard({ campaign: '/campaigns/campaign-one' });
  const second = makeCard({ campaign: '/campaigns/campaign-one?view=details', status: '进行中' });
  const third = makeCard({ campaign: '/campaigns/campaign-two' });
  const bonus1 = makeCard({ campaign: '/campaigns/shared-bonus?view=bonus' });
  const bonus2 = makeCard({ campaign: '/campaigns/shared-bonus?view=bonus' });
  const monitor = harness([first.card, second.card, third.card, bonus1.card, bonus2.card]);
  const tasks = monitor.collectTaskInfos();
  assert.equal(tasks.length, 4);
  const shared = tasks.find(task => task.taskIdentity === 'campaign:campaign-one');
  assert.equal(shared.isBlocked, true);
  assert.equal(shared.isReady, false);
  assert.ok(tasks.some(task => task.taskIdentity === 'campaign:campaign-two'));
});
