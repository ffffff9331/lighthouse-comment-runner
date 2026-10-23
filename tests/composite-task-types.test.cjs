const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

class Element {
  constructor(tag, text = '', children = [], attrs = {}) {
    this.tagName = tag.toUpperCase(); this.ownText = text; this.children = children; this.attrs = attrs;
    this.classList = { contains() { return false; } };
    for (const child of children) child.parentElement = this;
  }
  get innerText() { return [this.ownText, ...this.children.map(child => child.innerText)].filter(Boolean).join('\n'); }
  get textContent() { return this.innerText; }
  getAttribute(name) { return this.attrs[name] || null; }
  getBoundingClientRect() { return { width: this.tagName === 'ARTICLE' ? 330 : 100, height: this.tagName === 'ARTICLE' ? 300 : 24, top: this.tagName === 'BUTTON' ? 260 : 0, left: 0 }; }
  querySelectorAll(selector) {
    return this.descendants().filter(node => selector.split(',').some(part => {
      const value = part.trim();
      if (value === '*') return true;
      if (value === "[role='button']") return node.attrs.role === 'button';
      if (value === 'a[href]') return node.tagName === 'A' && Boolean(node.attrs.href);
      return value.toUpperCase() === node.tagName;
    }));
  }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
}

function card(badges, tweet = '这篇分析讨论市场变化 @zhangtingt5977') {
  return new Element('article', '', [
    ...badges.map(label => new Element('span', label)),
    new Element('p', tweet),
    new Element('div', '', [new Element('span', '预计获得'), new Element('span', '0.2 LUX')]),
    new Element('button', '查看详情')
  ], { role: 'button' });
}

function harness(listCard, detailCard = listCard) {
  const body = new Element('body', '', [listCard]);
  const document = {
    body, hidden: false, addEventListener() {}, querySelectorAll: selector => body.querySelectorAll(selector),
    createTreeWalker(root, _type, filter) {
      const nodes = [root, ...root.descendants()].filter(node => node.ownText).map(node => ({ nodeValue: node.ownText, parentElement: node })).filter(node => filter.acceptNode(node) === 1);
      let index = 0;
      return { currentNode: null, nextNode() { this.currentNode = nodes[index++]; return Boolean(this.currentNode); } };
    }
  };
  const context = vm.createContext({
    console, URL, document, Element, fixtureDetail: detailCard,
    location: { href: 'https://app.lhdao.top/test', origin: 'https://app.lhdao.top', pathname: '/test' },
    window: { innerWidth: 1440, innerHeight: 1000, addEventListener() {} },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    localStorage: { getItem() { return null; }, setItem() {} },
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage() { return Promise.resolve({ ok: true }); } } }
  });
  for (const [filename, extra] of [
    ['lighthouse-monitor.js', 'globalThis.monitor = {collectTaskInfos, detectTaskType, detectScopedTaskType};'],
    ['lighthouse.js', `
      isTaskDetailOrRecoverableOverlayOpen = () => false;
      findTaskDetailRoot = () => fixtureDetail;
      ensureCampaignsPage = async () => {};
      confirmPagePhase = async () => {};
      ensureAllTaskFilter = async () => {};
      selectNextCommentTask = async () => collectTaskCandidates([])[0];
      openTaskDetailOrFail = async () => {};
      acceptInvitationIfPresent = async () => false;
      report = () => {};
      globalThis.page = {collectTaskCandidates, detectScopedTaskType, buildTask, mergeSelectedTaskIdentity, canonicalSupportedTaskType, scoreSelectedTaskCandidate, assertSupportedDetailTask, isAutomatableTaskType, debugOpenFirstCommentTask, buildSelectionId, buildStableTaskKey};
    `]
  ]) {
    const source = fs.readFileSync(path.join(__dirname, '../src/content', filename), 'utf8');
    const end = source.lastIndexOf('})();');
    vm.runInContext(source.slice(0, end) + extra + '\n' + source.slice(end), context);
  }
  return context;
}

for (const badges of [['评论+点赞'], ['评论+赞'], ['评论', '点赞'], ['Comment', 'Like']]) {
  test(`composite badge ${badges.join('/')} survives monitor, selection and detail`, async () => {
    const h = harness(card(badges));
    const monitored = h.monitor.collectTaskInfos()[0];
    const candidate = h.page.collectTaskCandidates([])[0];
    assert.equal(monitored.taskType, '评论+点赞');
    assert.equal(candidate.taskType, '评论+点赞');
    assert.equal(candidate.isAutomatable, true);
    assert.equal(candidate.title, '这篇分析讨论市场变化 @zhangtingt5977');
    assert.ok(h.page.scoreSelectedTaskCandidate(candidate, monitored) >= 140);
    assert.equal(h.page.buildTask({}, '点赞互动').taskType, '评论+点赞');
    const opened = await h.page.debugOpenFirstCommentTask({});
    assert.equal(opened.task.taskType, '评论+点赞');
    assert.doesNotThrow(() => h.page.assertSupportedDetailTask(opened.task));
  });
}

test('pure like stays like and pure comment ignores action words in tweet prose', () => {
  for (const [badge, body, expected] of [
    ['点赞互动', '欢迎在评论区分享你对市场的看法 @zhangtingt5977', '点赞互动'],
    ['评论留言', '这段内容值得点赞，也欢迎关注后续分析 @zhangtingt5977', '评论']
  ]) {
    const h = harness(card([badge], body));
    assert.equal(h.page.collectTaskCandidates([])[0].taskType, expected);
    assert.equal(h.monitor.collectTaskInfos()[0].taskType, expected);
    assert.equal(h.page.buildTask({}, expected).taskType, expected);
  }
});

test('composite type is preserved when list and later detail have different action labels', async () => {
  for (const [listBadges, detailBadges] of [[['评论+赞'], ['点赞互动']], [['点赞互动'], ['评论+点赞']]]) {
    const h = harness(card(listBadges), card(detailBadges));
    const opened = await h.page.debugOpenFirstCommentTask({});
    assert.equal(opened.task.taskType, '评论+点赞');
    const merged = h.page.mergeSelectedTaskIdentity(opened.task, { taskType: '点赞互动', seatLocked: true });
    assert.equal(merged.taskType, '评论+点赞');
    assert.equal(merged.seatLocked, true);
  }
});

test('later generic comment fallback cannot turn a selected like-only task into a comment', () => {
  const h = harness(card(['点赞互动']));
  const selected = h.page.collectTaskCandidates([])[0];
  assert.equal(h.page.mergeSelectedTaskIdentity(selected, { taskType: '评论', seatLocked: true }).taskType, '点赞互动');
});

test('follow, quote and original badges remain ineligible even alongside supported actions', () => {
  for (const [badge, expected] of [['关注', '关注'], ['引用转发', '引用'], ['原创推文', '原创推文']]) {
    const h = harness(card(['评论+点赞', badge]));
    const candidate = h.page.collectTaskCandidates([])[0];
    assert.equal(candidate.taskType, expected);
    assert.equal(candidate.isAutomatable, false);
    assert.equal(h.monitor.collectTaskInfos()[0].taskType, expected);
    assert.throws(() => h.page.assertSupportedDetailTask(h.page.buildTask({}, '评论+点赞')), error => error.permanentIgnore === true);
  }
});

for (const [badges, expected] of [
  [['转发互动'], '转发'], [['转发'], '转发'], [['转推'], '转发'], [['Repost'], '转发'], [['Retweet'], '转发'],
  [['转发互动', '点赞'], '点赞+转发'], [['评论+点赞', '转发互动'], '评论+点赞+转发'],
]) {
  test(`repost badges ${badges.join('/')} pass monitor, selection and detail without losing requirements`, async () => {
    const h = harness(card(badges));
    const candidate = h.page.collectTaskCandidates([])[0];
    const monitored = h.monitor.collectTaskInfos()[0];
    assert.equal(candidate.taskType, expected);
    assert.equal(monitored.taskType, expected);
    assert.equal(candidate.isAutomatable, true);
    assert.ok(h.page.scoreSelectedTaskCandidate(candidate, monitored) >= 140);
    const opened = await h.page.debugOpenFirstCommentTask({});
    assert.equal(opened.task.taskType, expected);
    assert.doesNotThrow(() => h.page.assertSupportedDetailTask(opened.task));
  });
}

test('repost requirement survives a generic comment detail fallback', () => {
  const h = harness(card(['转发互动']));
  assert.equal(h.page.mergeSelectedTaskIdentity({taskType: '转发'}, {taskType: '评论'}).taskType, '转发');
  assert.equal(h.page.mergeSelectedTaskIdentity({taskType: '转发'}, {taskType: '点赞+转发'}).taskType, '点赞+转发');
});

test('review: explicit composite requirements survive a detail repost label', async () => {
  const h = harness(card(['评论+点赞']), card(['转发']));
  const opened = await h.page.debugOpenFirstCommentTask({});
  assert.equal(opened.task.taskType, '评论+点赞+转发', 'an explicit list composite is not a generic comment fallback');
});

test('tweet prose cannot turn a comment card into a repost order', () => {
  const h = harness(card(['评论留言'], '请谈谈转发互动与引用的区别 @zhangtingt5977'));
  assert.equal(h.page.collectTaskCandidates([])[0].taskType, '评论');
  assert.equal(h.monitor.collectTaskInfos()[0].taskType, '评论');
});

test('composite aliases canonicalize consistently for matching and stable identity', () => {
  const h = harness(card(['评论+点赞']));
  const candidate = h.page.collectTaskCandidates([])[0];
  assert.ok(h.page.scoreSelectedTaskCandidate(candidate, { ...candidate, taskType: '评论+赞' }) >= 900);
  assert.equal(h.page.buildStableTaskKey({ ...candidate, taskType: '评论+赞' }), h.page.buildStableTaskKey(candidate));
  assert.equal(h.page.buildSelectionId({ ...candidate, taskType: '评论+赞' }), h.page.buildSelectionId(candidate));
  assert.equal(h.page.scoreSelectedTaskCandidate(candidate, { ...candidate, taskType: '点赞互动', taskKey: '', selectionId: '' }), 0);
});
