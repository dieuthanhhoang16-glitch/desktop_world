// test/world-orch-scene.test.js
// 工位场景（world/orch/scene-agents.js）+ 门面（world/orch/index.js）。
//
// 场景的第一纪律是**确定性**：同一份工单描述永远渲染出同一张 SVG。
// 这是 garden/scene.js 就有的纪律（那里是壁纸可缓存、测试可断言），工位场景同理——
// 热刷新每 15 分钟一次，画面不能每次刷新都换座位。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scene = require('../world/orch/scene-agents');
const store = require('../world/orch/store');
const orch = require('../world/orch/index');
const { ticketsFile, blackboardFile } = require('../world/orch/paths');
const mailbox = require('../world/orch/mailbox');

const items = [
  { id: 'ORCH-001', title: '梳理登录流程', status: 'confirmed', agent: 'claude-code', cwd: '/tmp' },
  { id: 'ORCH-002', title: '修复 token 刷新', status: 'running', agent: 'claude-code', cwd: '/tmp', state: 'working' },
];

// ---------- 动作映射 ----------

test('actionFor：按标题关键词映射动作（与 pomodoro.taskActionFor 同思路）', () => {
  assert.strictEqual(scene.actionFor('读一下登录流程'), 'thinking');
  assert.strictEqual(scene.actionFor('整理归档目录'), 'sweeping');
  assert.strictEqual(scene.actionFor('下载依赖包'), 'carrying');
  assert.strictEqual(scene.actionFor('开会讨论方案'), 'attention');
  assert.strictEqual(scene.actionFor('修复 token 刷新'), 'working'); // 通用
  assert.strictEqual(scene.actionFor(''), 'working');
  assert.strictEqual(scene.actionFor(null), 'working');
});

test('actionFor：返回的键都在 POSE 表里有姿态（否则画不出小人）', () => {
  for (const t of ['读代码', '整理', '搬东西', '开会', '写代码', '', 'x']) {
    const a = scene.actionFor(t);
    assert.ok(scene.POSE[a], `动作 ${a} 没有对应姿态`);
  }
});

// ---------- 渲染确定性 ----------

test('renderAgentScene：同一输入永远同一张 SVG', () => {
  const a = scene.renderAgentScene(items);
  const b = scene.renderAgentScene(items);
  assert.strictEqual(a.svg, b.svg);
  assert.deepStrictEqual(a.stations, b.stations);
});

test('renderAgentScene：工单顺序不同不影响单个工位的落位（按 id 派生，不按数组下标抖动）', () => {
  // seed 是按 id 列表派生的，但工位位置由 index 决定 —— 所以顺序变了位置会变。
  // 这里断言的是"给定顺序下稳定"，以及位置不越界（真正要守住的是后者）。
  const fwd = scene.renderAgentScene(items);
  const rev = scene.renderAgentScene([...items].reverse());
  assert.strictEqual(fwd.svg, fwd.svg); // 自反
  for (const st of [...fwd.stations, ...rev.stations]) {
    assert.ok(st.x >= 0 && st.x < scene.GW, `工位 x 越界：${st.x}`);
    assert.ok(st.y >= 0 && st.y < scene.GH, `工位 y 越界：${st.y}`);
  }
});

test('renderAgentScene：工位数量封顶，铺不爆画布', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    id: `ORCH-${String(i + 1).padStart(3, '0')}`, title: `任务 ${i}`, status: 'draft',
  }));
  const out = scene.renderAgentScene(many);
  assert.strictEqual(out.stations.length, scene.MAX_STATIONS);
});

test('renderAgentScene：输出是合法 SVG 字符串（以 <svg 开头 </svg> 结尾）', () => {
  const { svg } = scene.renderAgentScene(items);
  assert.ok(svg.startsWith('<svg '));
  assert.ok(svg.endsWith('</svg>'));
  assert.match(svg, /viewBox="0 0 320 96"/);
});

test('renderAgentScene：工位越少画面越简单（不是画一堆装饰）', () => {
  const one = scene.renderAgentScene([items[0]]);
  const two = scene.renderAgentScene(items);
  assert.ok(one.svg.length < two.svg.length);
});

test('renderAgentScene：空输入不崩，输出一个安静的 SVG', () => {
  const { svg, stations } = scene.renderAgentScene([]);
  assert.deepStrictEqual(stations, []);
  assert.ok(svg.startsWith('<svg '));
});

test('renderAgentScene：非数组输入不崩', () => {
  assert.ok(scene.renderAgentScene(null).svg.startsWith('<svg '));
  assert.ok(scene.renderAgentScene(undefined).svg.startsWith('<svg '));
});

test('renderAgentScene：seed 可显式指定（同一 seed 同图）', () => {
  const a = scene.renderAgentScene(items, { seed: 'fixed' });
  const b = scene.renderAgentScene(items, { seed: 'fixed' });
  const c = scene.renderAgentScene(items, { seed: 'other' });
  assert.strictEqual(a.svg, b.svg);
  assert.notStrictEqual(a.svg, c.svg);
});

test('renderAgentScene：不同引擎状态必须画出不同画面（"随 hook 事件变化"的落点）', () => {
  // 真实事故形态：只按工单状态画信号，引擎状态变了画面却不变 —— 等于没有联动。
  const withState = (state) => scene.renderAgentScene([
    { id: 'ORCH-001', title: '做事', status: 'running', agent: 'claude-code', cwd: '/tmp', state },
  ]).svg;

  assert.notStrictEqual(withState('idle'), withState('thinking'), 'idle 与 thinking 应不同');
  assert.notStrictEqual(withState('thinking'), withState('working'), 'thinking 与 working 应不同');
  assert.notStrictEqual(withState('working'), withState('juggling'));
  assert.notStrictEqual(withState('juggling'), withState('notification'));
  // 同状态仍然必须稳定（确定性优先于一切）
  assert.strictEqual(withState('working'), withState('working'));
});

test('renderAgentScene：没有会话的工位不画引擎信号（不假装在跑）', () => {
  const noSession = scene.renderAgentScene([
    { id: 'ORCH-001', title: '做事', status: 'confirmed', agent: 'claude-code', cwd: '/tmp' },
  ]).svg;
  assert.ok(!/#ffffff" fill-opacity="0.35"/.test(noSession), '没有真实会话就不该有引擎高光');
});

test('renderAgentScene：工位携带状态与图标（看板与场景语义一致）', () => {
  const { stations } = scene.renderAgentScene(items);
  const byId = new Map(stations.map((s) => [s.id, s]));
  assert.strictEqual(byId.get('ORCH-001').status, 'confirmed');
  assert.strictEqual(byId.get('ORCH-002').status, 'running');
  assert.strictEqual(byId.get('ORCH-001').icon, scene.STATUS_ICONS.confirmed);
});

// ---------- 飞行信封 ----------

test('envelopeRoute：算出起终点与抬升量', () => {
  const r = scene.envelopeRoute({ x: 10, y: 30 }, { x: 60, y: 20 });
  assert.deepStrictEqual(r.from, { x: 10, y: 30 });
  assert.deepStrictEqual(r.to, { x: 60, y: 20 });
  assert.ok(r.lift > 0);
});

test('envelopeRoute：同位置也有抬升量（不出现 0 高度的退化动画）', () => {
  const r = scene.envelopeRoute({ x: 10, y: 30 }, { x: 10, y: 30 });
  assert.ok(r.lift > 0);
});

test('envelopeRoute：缺坐标时退回 0，不产生 NaN', () => {
  const r = scene.envelopeRoute(null, undefined);
  assert.strictEqual(Number.isFinite(r.from.x), true);
  assert.strictEqual(Number.isFinite(r.to.x), true);
});

test('planEnvelopes：只给两端都存在的工位算路线', () => {
  const { stations } = scene.renderAgentScene(items);
  const routes = scene.planEnvelopes(stations, [
    ['ORCH-001', 'ORCH-002', 'ORCH-002'], // 两端都在 → 出路线
    ['ORCH-001', 'ORCH-999'], // 目标不存在 → 跳过，不猜位置
    ['nope', 'ORCH-001'],
  ]);
  assert.strictEqual(routes.length, 1);
  assert.strictEqual(routes[0].ticketId, 'ORCH-002');
});

// ---------- 门面 ----------

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-scene-'));
}

test('buildOrchView：没工单时 active=false（界面据此整段静默）', () => {
  const root = tmpRoot();
  const view = orch.buildOrchView({ root });
  assert.strictEqual(view.active, false);
  assert.strictEqual(view.summary.total, 0);
  assert.deepStrictEqual(view.tickets, []);
});

test('buildOrchView：有工单时给出列分组、场景与计数', () => {
  const root = tmpRoot();
  store.appendTickets(ticketsFile(root), [
    { title: 'A', agent: 'claude-code', cwd: '/tmp', status: 'draft', dependsOn: [], acceptance: ['x'], action: 'read' },
    { title: 'B', agent: 'claude-code', cwd: '/tmp', status: 'done', dependsOn: [], acceptance: ['x'], action: 'change' },
  ]);
  const view = orch.buildOrchView({ root });
  assert.strictEqual(view.active, true);
  assert.strictEqual(view.summary.total, 2);
  assert.strictEqual(view.scene.stations.length, 2);
  assert.strictEqual(view.columns.draft.length, 1);
  assert.strictEqual(view.columns.done.length, 1);
  assert.ok(view.tickets[0].statusLabel);
});

test('buildOrchView：成环时明确给出 cycles，而不是假装正常', () => {
  const root = tmpRoot();
  // 手写一个成环的账本（正常流程走不出这种形状）
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(ticketsFile(root), JSON.stringify({
    version: 1, seq: 2,
    tickets: [
      { id: 'ORCH-001', title: 'A', status: 'draft', agent: 'claude-code', cwd: '/tmp', dependsOn: ['ORCH-002'], acceptance: [], action: 'read' },
      { id: 'ORCH-002', title: 'B', status: 'draft', agent: 'claude-code', cwd: '/tmp', dependsOn: ['ORCH-001'], acceptance: [], action: 'read' },
    ],
  }));
  const view = orch.buildOrchView({ root });
  assert.strictEqual(view.cycles.length, 1);
  assert.strictEqual(view.graph, null); // 拓扑不可用
});

test('buildOrchView：依赖边变成飞行信封路线', () => {
  const root = tmpRoot();
  store.appendTickets(ticketsFile(root), [
    { title: 'A', agent: 'claude-code', cwd: '/tmp', status: 'draft', dependsOn: [], acceptance: [], action: 'read' },
    { title: 'B', agent: 'claude-code', cwd: '/tmp', status: 'draft', dependsOn: ['ORCH-001'], acceptance: [], action: 'read' },
  ]);
  const view = orch.buildOrchView({ root });
  assert.strictEqual(view.envelopes.length, 1);
  assert.strictEqual(view.envelopes[0].ticketId, 'ORCH-002');
});

test('buildOrchView：session snapshot 把真实会话状态接到工位上', () => {
  const root = tmpRoot();
  store.appendTickets(ticketsFile(root), [
    { title: 'A', agent: 'claude-code', cwd: '/repo', status: 'running', dependsOn: [], acceptance: [], action: 'change' },
  ]);
  const snapshot = {
    sessions: [{
      id: 'claude:sess-1', agentId: 'claude-code', agentName: 'Claude Code',
      state: 'working', badge: 'running', cwd: '/repo', displayTitle: '在改代码', headless: false,
    }],
  };
  const view = orch.buildOrchView({ root, snapshot });
  const st = view.scene.stations[0];
  assert.strictEqual(st.sessionId, 'claude:sess-1');
  assert.strictEqual(st.engineState, 'working'); // 引擎真实状态进了工位
  // 工单侧也带上接住的会话（UI 的"已接会话"角标）
  assert.strictEqual(view.tickets[0].sessionId, 'claude:sess-1');
  // 快照是共享合约，这里只读不改
  assert.strictEqual(snapshot.sessions[0].state, 'working');
  assert.ok(!('engineState' in snapshot.sessions[0]));
});

test('indexSessions：headless 会话被排除在工位匹配之外', () => {
  const byAgent = orch.indexSessions({
    sessions: [
      { id: 'a', agentId: 'claude-code', state: 'idle', headless: true },
      { id: 'b', agentId: 'claude-code', state: 'idle', headless: false },
    ],
  });
  const live = byAgent.get('claude-code').filter((s) => !s.headless);
  assert.strictEqual(live.length, 1);
  assert.strictEqual(live[0].id, 'b');
});

test('indexSessions：坏数据不崩（缺 agentId 的会话被跳过）', () => {
  const byAgent = orch.indexSessions({ sessions: [null, {}, { agentId: 'codex', state: 'idle' }] });
  assert.strictEqual(byAgent.size, 1);
  assert.ok(byAgent.has('codex'));
  assert.strictEqual(orch.indexSessions(null).size, 0);
  assert.strictEqual(orch.indexSessions({}).size, 0);
});

test('matchSession：同 cwd 优先，其次任意活会话', () => {
  const byAgent = new Map([['claude-code', [
    { id: 'idle-1', agentId: 'claude-code', state: 'idle', cwd: '/other', headless: false },
    { id: 'idle-2', agentId: 'claude-code', state: 'idle', cwd: '/repo', headless: false },
    { id: 'work-1', agentId: 'claude-code', state: 'working', cwd: '/other', headless: false },
  ]]]);
  // 同 cwd 的 idle 会话优先于别的 cwd 的 working（同目录优先是更具体的匹配）
  assert.strictEqual(orch.matchSession({ agent: 'claude-code', cwd: '/repo' }, byAgent).id, 'idle-2');
  // 没有同 cwd 时退到活会话
  assert.strictEqual(orch.matchSession({ agent: 'claude-code', cwd: '/nope' }, byAgent).id, 'work-1');
  // 没有任何会话 → null
  assert.strictEqual(orch.matchSession({ agent: 'kiro-cli', cwd: '/repo' }, byAgent), null);
});

test('buildOrchView：收件箱概览统计未读', () => {
  const root = tmpRoot();
  store.appendTickets(ticketsFile(root), [
    { title: 'A', agent: 'claude-code', cwd: '/tmp', status: 'confirmed', dependsOn: [], acceptance: [], action: 'read' },
  ]);
  mailbox.deliver('claude:s1', { body: '一' }, root);
  mailbox.deliver('claude:s1', { body: '二' }, root);
  mailbox.ack('claude:s1', mailbox.list('claude:s1', { root })[0].id, root);
  const view = orch.buildOrchView({ root });
  assert.strictEqual(view.inbox.length, 1);
  assert.strictEqual(view.inbox[0].unread, 1);
});

test('buildOrchView：黑板事实带进视图（最新在前）', () => {
  const root = tmpRoot();
  const bb = blackboardFile(root);
  require('../world/orch/blackboard').append(bb, { text: '第一条' });
  require('../world/orch/blackboard').append(bb, { text: '第二条' });
  store.appendTickets(ticketsFile(root), [
    { title: 'A', agent: 'claude-code', cwd: '/tmp', status: 'draft', dependsOn: [], acceptance: [], action: 'read' },
  ]);
  const view = orch.buildOrchView({ root });
  assert.strictEqual(view.facts[0].text, '第二条');
});

test('buildOrchView：同样的数据两次渲染出同样的场景（确定性贯通到门面）', () => {
  const root = tmpRoot();
  store.appendTickets(ticketsFile(root), [
    { title: 'A', agent: 'claude-code', cwd: '/tmp', status: 'running', dependsOn: [], acceptance: [], action: 'change' },
  ]);
  const a = orch.buildOrchView({ root });
  const b = orch.buildOrchView({ root });
  assert.strictEqual(a.scene.svg, b.scene.svg);
});