// test/world-orch-render.test.js
// 真正执行模板里的 renderOrch / layoutEnvelopes（最小 DOM 桩），而不是只做文本匹配。
//
// 为什么值得单独做：结构守门（test/world-orch-template.test.js）能证明"代码在模板里"，
// 但证明不了"跑起来不抛、且真的把数据画进了 DOM"。这里用一个几十行的 DOM 桩把两个
// 函数真跑一遍，覆盖它们最容易在后续改动里坏掉的地方：
//   · 空/缺字段的 orch 视图不炸
//   · 每个状态列都真的有卡片进去
//   · 成环时 warn 真的解除 hidden
//   · 信封的 CSS 变量真的按 SVG 显示宽度换算过
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TEMPLATE = path.join(__dirname, '..', 'world', 'template', 'daily-card.html');
const html = fs.readFileSync(TEMPLATE, 'utf8');

// ---------- 最小 DOM 桩 ----------
// innerHTML 的语义必须对齐真实 DOM：**赋值会清空子节点**。这一点桩一开始写错，
// 测试就因为"以为 appendChild 之后读 children[0].children"而读到 undefined ——
// 桩本身撒谎比代码出错更容易误导。
class El {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this._html = '';
    this.style = { props: {}, setProperty(k, v) { this.props[k] = v; } };
    this.classList = {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      contains(c) { return this._s.has(c); },
      toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); },
    };
    this.hidden = false;
    this.textContent = '';
    this.className = '';
  }
  set innerHTML(v) { this._html = String(v); this.children = []; }
  get innerHTML() { return this._html; }
  appendChild(c) { this.children.push(c); return c; }
  getBoundingClientRect() { return { width: 640, height: 192 }; }
}

function makeDoc() {
  const ids = ['tabBar', 'panelOrch', 'orchSum', 'orchBadge', 'orchScene', 'orchWarn', 'orchCols', 'orchInbox', 'orchFacts', 'orchEnv', 'panelDaily', 'tabDaily', 'tabOrch'];
  const els = {};
  for (const id of ids) els[id] = new El('div');
  // layoutEnvelopes 会 querySelector('#orchScene svg')
  const svg = new El('svg');
  svg.getBoundingClientRect = () => ({ width: 640, height: 192 });
  els.orchScene.children = [svg];
  return {
    els,
    body: new El('body'),
    getElementById: (id) => els[id] || null,
    querySelector: (sel) => (sel === '#orchScene svg' ? svg : null),
    createElement: (tag) => new El(tag),
    addEventListener() {},
  };
}

// ---------- 从模板里抽出函数 ----------
function extract(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start > 0, `模板里找不到 ${name}`);
  // 从 function 关键字起做括号配平，取出完整函数体
  let depth = 0;
  let i = html.indexOf('{', start);
  const from = start;
  for (; i < html.length; i += 1) {
    if (html[i] === '{') depth += 1;
    else if (html[i] === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(from, i + 1);
    }
  }
  throw new Error(`${name} 括号不配平`);
}

// esc 也从模板里抽（而不是在测试里重抄一份）：抄一份的话，模板改了 esc 而测试没改，
// 测试就会对着旧语义放行 —— 这正是 test/world-live-template.test.js 当年记的那个事故。
const SRC = [
  extract('esc'),
  'var ORCH_COLS = ' + /var ORCH_COLS = (\[[\s\S]*?\]);/.exec(html)[1] + ';',
  'var ORCH_FACT_ICON = ' + /var ORCH_FACT_ICON = (\{[^}]*\});/.exec(html)[1] + ';',
  'var orchTab = "daily";',
  extract('setTab'),
  extract('renderOrch'),
  extract('layoutEnvelopes'),
  'return { renderOrch: renderOrch, layoutEnvelopes: layoutEnvelopes, setTab: setTab, ORCH_COLS: ORCH_COLS, getTab: function(){return orchTab;} };',
].join('\n');

function load() {
  const doc = makeDoc();
  const factory = new Function('document', 'window', 'console', SRC);
  const api = factory(doc, {}, console);
  return { doc, api };
}

// 覆盖"渲染层拿到的真实形状"：字段名与 world/orch/index.js 的 buildOrchView 对齐
const view = {
  active: true,
  summary: { total: 4, pending: 2, active: 1, counts: {} },
  columns: {
    draft: [], confirmed: [{ id: 'ORCH-003', title: '补测试', agent: 'claude-code', dependsOn: ['ORCH-002'], acceptance: ['能跑', '结论写回'], sessionId: '' }],
    dispatched: [{ id: 'ORCH-002', title: '改实现', agent: 'claude-code', dependsOn: ['ORCH-001'], acceptance: ['落盘'], sessionId: 'claude:9f2b' }],
    running: [{ id: 'ORCH-004', title: '更新文档', agent: 'claude-code', dependsOn: [], acceptance: ['写好'], sessionId: 'claude:9f2b' }],
    done: [{ id: 'ORCH-001', title: '读代码', agent: 'claude-code', dependsOn: [], acceptance: ['读完'], sessionId: '' }],
    failed: [], blocked: [],
  },
  tickets: [],
  scene: { svg: '<svg viewBox="0 0 320 96"></svg>', stations: [] },
  envelopes: [{ ticketId: 'ORCH-002', from: { x: 10, y: 30 }, to: { x: 60, y: 20 }, lift: 8 }],
  inbox: [{ sessionId: 'claude-9f2b', unread: 2 }],
  facts: [{ kind: 'convergence', text: '结论写回', ticketIds: ['ORCH-001'] }],
  graph: null,
  cycles: [],
};

// ---------- 实际执行 ----------

test('renderOrch 真跑：填出 tab 栏、工位场景、四个非空列、收件箱与黑板', () => {
  const { doc, api } = load();
  api.renderOrch(view);

  assert.strictEqual(doc.els.tabBar.hidden, false, '有工单就该亮 tab 栏');
  assert.strictEqual(doc.els.panelOrch.hidden, false);

  // 汇总数字进了 DOM
  assert.match(doc.els.orchSum.innerHTML, /共 <b>4<\/b>/);
  assert.match(doc.els.orchSum.innerHTML, /待确认 <b>2<\/b>/);
  assert.match(doc.els.orchSum.innerHTML, /未读信封 <b>2<\/b>/);

  // 待确认数 ≥1 时 tab 上出现角标
  assert.strictEqual(doc.els.orchBadge.hidden, false);
  assert.strictEqual(doc.els.orchBadge.textContent, '2');

  // 工位 SVG 原样注入
  assert.match(doc.els.orchScene.innerHTML, /<svg viewBox="0 0 320 96">/);

  // 四个非空列（列元素是 appendChild 进去的；列内容是 innerHTML 字符串）
  const colEls = doc.els.orchCols.children;
  assert.strictEqual(colEls.length, 4, '只渲染非空列');
  // 每列的 innerHTML 里都有一张卡（col 卡片数 = 非空列数）
  const perCol = colEls.map((c) => (c.innerHTML.match(/orch-card/g) || []).length);
  assert.deepStrictEqual(perCol, [1, 1, 1, 1], '每列各一张卡');
  const all = colEls.map((c) => c.innerHTML).join('');
  for (const id of ['ORCH-001', 'ORCH-002', 'ORCH-003', 'ORCH-004']) {
    assert.ok(all.includes(id), `缺工单 ${id}`);
  }
  // 依赖渲染成 odeps
  assert.match(all, /odeps/);
  // 验收标准逐条 <li>
  assert.match(all, /<li>能跑<\/li>/);

  // 收件箱与黑板
  assert.match(doc.els.orchInbox.innerHTML, /claude-9f2b/);
  assert.match(doc.els.orchInbox.innerHTML, /<span class="n">2<\/span>/);
  assert.match(doc.els.orchFacts.innerHTML, /结论写回/);

  // 无环 → warn 保持隐藏
  assert.strictEqual(doc.els.orchWarn.hidden, true);
});

test('renderOrch 真跑：成环时 warn 解除隐藏并写出环路径', () => {
  const { doc, api } = load();
  api.renderOrch({ ...view, cycles: [['ORCH-001', 'ORCH-002', 'ORCH-001']] });
  assert.strictEqual(doc.els.orchWarn.hidden, false);
  assert.match(doc.els.orchWarn.textContent, /依赖成环/);
  assert.match(doc.els.orchWarn.textContent, /ORCH-001/);
});

test('renderOrch 真跑：恶意文本被转义，不会破 DOM 结构', () => {
  const { doc, api } = load();
  api.renderOrch({
    ...view,
    columns: {
      confirmed: [{
        id: 'ORCH-003',
        title: '<img src=x onerror=alert(1)>',
        agent: '"><script>bad()</script>',
        dependsOn: [], acceptance: ['<b>粗体</b>'], sessionId: '',
      }],
      dispatched: [], running: [], done: [], draft: [], failed: [], blocked: [],
    },
  });
  const out = doc.els.orchCols.children[0].innerHTML;
  assert.ok(!out.includes('<img src=x'), '标签必须被转义');
  assert.ok(!out.includes('<script>'), 'script 必须被转义');
  assert.match(out, /&lt;img src=x/);
});

test('renderOrch 真跑：没有工单 → tab 与面板都隐藏，且不炸', () => {
  const { doc, api } = load();
  api.renderOrch(null);
  assert.strictEqual(doc.els.tabBar.hidden, true);
  assert.strictEqual(doc.els.panelOrch.hidden, true);

  for (const bad of [{}, { active: false }, { active: true }]) {
    assert.doesNotThrow(() => load().api.renderOrch(bad), `坏输入不应抛：${JSON.stringify(bad)}`);
  }
});

test('renderOrch 真跑：active 但没有任何非空列（列数取兜底四列，不塌成 0）', () => {
  const { doc, api } = load();
  api.renderOrch({ ...view, columns: {} });
  assert.ok(doc.els.orchCols.children.length >= 1, '列不能消失');
  assert.match(doc.els.orchCols.children[0].innerHTML, /class="empty"/);
});

test('layoutEnvelopes 真跑：信封元素带全套 CSS 变量，坐标按显示宽度换算', () => {
  const { doc, api } = load();
  api.renderOrch(view);
  const envs = doc.els.orchEnv.children;
  assert.strictEqual(envs.length, 1, '一条依赖 → 一封信');
  const s = envs[0].style;
  for (const v of ['--x0', '--y0', '--xm', '--y0', '--y1', '--x1', '--lift', '--delay', '--dur']) {
    assert.ok(s.props[v], `缺 CSS 变量 ${v}`);
  }
  // 坐标是 px 且不是 NaN（SVG viewBox 宽 320，DOM 宽 640 → 缩放 2）
  for (const v of ['--x0', '--y0', '--x1', '--y1', '--xm', '--lift']) {
    assert.match(s.props[v], /^-?\d+(\.\d+)?px$/, `${v} 不是合法 px：${s.props[v]}`);
    assert.ok(!s.props[v].includes('NaN'), `${v} 是 NaN`);
  }
  // from=(10,30) → x0 = 10 * 2px/格 * 2 (缩放) = 40px
  assert.strictEqual(s.props['--x0'], '40.0px');
});

test('layoutEnvelopes 真跑：没有信封时不创建元素', () => {
  const { doc, api } = load();
  api.renderOrch({ ...view, envelopes: [] });
  assert.strictEqual(doc.els.orchEnv.children.length, 0);
});

test('setTab：切到 orch 会给 body 加 tab-orch 类并解锁面板，切回 daily 会收起', () => {
  const { doc, api } = load();
  api.renderOrch(view);

  api.setTab('orch');
  assert.strictEqual(api.getTab(), 'orch');
  assert.strictEqual(doc.body.classList.contains('tab-orch'), true);
  assert.strictEqual(doc.els.panelOrch.hidden, false);
  assert.strictEqual(doc.els.tabOrch.classList.contains('on'), true);
  assert.strictEqual(doc.els.tabDaily.classList.contains('on'), false);

  api.setTab('daily');
  assert.strictEqual(api.getTab(), 'daily');
  assert.strictEqual(doc.body.classList.contains('tab-orch'), false);
  assert.strictEqual(doc.els.panelOrch.hidden, true);

  // 非法值退回 daily，不进未知态
  api.setTab('bogus');
  assert.strictEqual(api.getTab(), 'daily');
});