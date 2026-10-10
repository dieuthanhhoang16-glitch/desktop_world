// test/world-orch-tree.test.js
// 调度树 view-model（world/orch/tree-model.js）的纯逻辑守门。
//
// 这个模块的纪律与 scene-agents.js 相同：纯函数、无 IO、确定性。
// 它面向的是 daily-card.html 的调度树主面（M1），断言的是**结构契约**——
// 模板只负责渲染，所有"该怎么摆"的判断都必须在这里可测。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const tree = require('../world/orch/tree-model');

/** 最小视图工厂：形状对齐 buildOrchView() 的输出。 */
function viewOf(over = {}) {
  return {
    active: true,
    summary: { total: 0, pending: 0, active: 0, counts: {} },
    tickets: [],
    facts: [],
    inbox: [],
    cycles: [],
    scene: { stations: [] },
    ...over,
  };
}

function ticketOf(id, over = {}) {
  return {
    id,
    title: `${id} 的标题`,
    status: 'confirmed',
    statusLabel: '已确认',
    agent: 'claude-code',
    cwd: '/tmp',
    dependsOn: [],
    sessionId: '',
    ...over,
  };
}

// ---------- 进度映射 ----------

test('progressOf：状态机位置映射，done 满格，未知状态归零', () => {
  assert.strictEqual(tree.progressOf('draft'), 0.1);
  assert.strictEqual(tree.progressOf('confirmed'), 0.25);
  assert.strictEqual(tree.progressOf('dispatched'), 0.5);
  assert.strictEqual(tree.progressOf('running'), 0.75);
  assert.strictEqual(tree.progressOf('done'), 1);
  // failed/blocked 是停格，不是前进
  assert.strictEqual(tree.progressOf('failed'), 0.75);
  assert.strictEqual(tree.progressOf('blocked'), 0.25);
  assert.strictEqual(tree.progressOf('???'), 0);
  assert.strictEqual(tree.progressOf(undefined), 0);
});

// ---------- 三档判定 ----------

test('verdictOf：sharp ≥0.6 / split 之间 / no ≤0.4，与 split.js 同阈值', () => {
  assert.strictEqual(tree.verdictOf(0.87), 'sharp');
  assert.strictEqual(tree.verdictOf(0.6), 'sharp');
  assert.strictEqual(tree.verdictOf(0.42), 'split');
  assert.strictEqual(tree.verdictOf(0.31), 'no');
  assert.strictEqual(tree.verdictOf(0.4), 'no');
  assert.strictEqual(tree.verdictOf(NaN), 'no');
  assert.strictEqual(tree.verdictOf('x'), 'no');
});

// ---------- 拓扑分列 ----------

test('laneDepths：无依赖深度 0，链式依赖递增，列内按 id 稳定排序', () => {
  const tickets = [
    ticketOf('ORCH-003', { dependsOn: ['ORCH-001'] }),
    ticketOf('ORCH-001'),
    ticketOf('ORCH-002', { dependsOn: ['ORCH-001'] }),
    ticketOf('ORCH-004', { dependsOn: ['ORCH-003'] }),
  ];
  const depths = tree.laneDepths(tickets);
  assert.strictEqual(depths.get('ORCH-001'), 0);
  assert.strictEqual(depths.get('ORCH-002'), 1);
  assert.strictEqual(depths.get('ORCH-003'), 1);
  assert.strictEqual(depths.get('ORCH-004'), 2);
});

test('laneDepths：悬空依赖（指向账本外）按深度 0 处理，不炸', () => {
  const depths = tree.laneDepths([ticketOf('ORCH-001', { dependsOn: ['ORCH-999'] })]);
  assert.strictEqual(depths.get('ORCH-001'), 0);
});

test('laneDepths：依赖环全部归零（树不成立时绝不假装成立）', () => {
  const tickets = [
    ticketOf('ORCH-001', { dependsOn: ['ORCH-002'] }),
    ticketOf('ORCH-002', { dependsOn: ['ORCH-001'] }),
    ticketOf('ORCH-003'),
  ];
  const depths = tree.laneDepths(tickets);
  assert.strictEqual(depths.get('ORCH-001'), 0);
  assert.strictEqual(depths.get('ORCH-002'), 0);
  assert.strictEqual(depths.get('ORCH-003'), 0); // 不相关节点不受影响
});

// ---------- 目标解析 ----------

test('goalOf：从最新「立单」fact 里取目标原文，取不到回空串', () => {
  const facts = [
    { kind: 'fact', text: '立单 ORCH-011, ORCH-012：把桌面整理做完，然后补回归测试' },
    { kind: 'fact', text: '立单 ORCH-001：旧目标' },
  ];
  assert.strictEqual(tree.goalOf(facts), '把桌面整理做完，然后补回归测试');
  assert.strictEqual(tree.goalOf([{ kind: 'fact', text: '派发 ORCH-011 → claude-code' }]), '');
  assert.strictEqual(tree.goalOf([]), '');
  assert.strictEqual(tree.goalOf(null), '');
});

// ---------- JEV 判断层 ----------

test('judgmentOf：没有带 probs 的决策 → null（本地拆分，层折叠）', () => {
  assert.strictEqual(tree.judgmentOf([]), null);
  assert.strictEqual(tree.judgmentOf([{ ok: true, source: 'local' }]), null);
  assert.strictEqual(tree.judgmentOf(null), null);
});

test('judgmentOf：取最新 probs，splitable 打头，agent_* 翻成路线标签', () => {
  const decisions = [
    { at: 't2', probs: { risky: 0.42, splitable: 0.87, agent_claude: 0.78 } },
    { at: 't1', probs: { splitable: 0.1 } },
  ];
  const j = tree.judgmentOf(decisions);
  assert.ok(j);
  assert.strictEqual(j.at, 't2');
  assert.strictEqual(j.forks, 2);
  assert.strictEqual(j.bars[0].key, 'splitable');
  assert.strictEqual(j.bars[0].verdict, 'sharp');
  const route = j.bars.find((b) => b.key === 'agent_claude');
  assert.strictEqual(route.label, 'route · claude');
  assert.strictEqual(j.bars.find((b) => b.key === 'risky').verdict, 'split');
});

test('judgmentOf：概率越界钳到 0..1，非数字条目丢弃', () => {
  const j = tree.judgmentOf([{ probs: { splitable: 1.7, risky: Number.NaN, needs_research: -0.2 } }]);
  assert.ok(j);
  assert.strictEqual(j.bars.find((b) => b.key === 'splitable').p, 1);
  assert.strictEqual(j.bars.find((b) => b.key === 'needs_research').p, 0);
  assert.ok(!j.bars.some((b) => b.key === 'risky'));
});

// ---------- 双信号 ----------

test('signalsOf：dispatched 且引擎 idle/无会话 → stale（还没接活）', () => {
  const v = viewOf({
    tickets: [
      ticketOf('ORCH-001', { status: 'dispatched' }),
      ticketOf('ORCH-002', { status: 'dispatched' }),
      ticketOf('ORCH-003', { status: 'running' }),
    ],
    scene: {
      stations: [
        { id: 'ORCH-001', engineState: 'idle' },
        { id: 'ORCH-002', engineState: 'working' },
        { id: 'ORCH-003', engineState: 'idle' },
      ],
    },
  });
  const sig = tree.signalsOf(v);
  assert.strictEqual(sig.byTicket['ORCH-001'].stale, true); // dispatched + idle
  assert.strictEqual(sig.byTicket['ORCH-002'].stale, false); // 引擎在干活
  assert.strictEqual(sig.byTicket['ORCH-003'].stale, false); // running 不算 stale
  assert.strictEqual(sig.byTicket['ORCH-003'].engine, 'idle');
});

test('signalsOf：没有工位（无会话）时 dispatched 也算 stale', () => {
  const v = viewOf({ tickets: [ticketOf('ORCH-001', { status: 'dispatched' })] });
  assert.strictEqual(tree.signalsOf(v).byTicket['ORCH-001'].stale, true);
});

// ---------- buildTree 组装 ----------

test('buildTree：空视图给空骨架（模板据此整段静默），不炸', () => {
  const t = tree.buildTree(null);
  assert.strictEqual(t.active, false);
  assert.deepStrictEqual(t.lanes, []);
  assert.deepStrictEqual(t.edges, []);
  assert.strictEqual(t.judgment, null);
  assert.strictEqual(t.main.goal, '');
  assert.strictEqual(t.main.progress, 0);
});

test('buildTree：lanes 按深度分列，edges 只画两端都在账本的依赖', () => {
  const v = viewOf({
    tickets: [
      ticketOf('ORCH-001'),
      ticketOf('ORCH-002', { dependsOn: ['ORCH-001'] }),
      ticketOf('ORCH-003', { dependsOn: ['ORCH-001', 'ORCH-999'] }),
    ],
  });
  const t = tree.buildTree(v);
  assert.strictEqual(t.active, true);
  assert.strictEqual(t.lanes.length, 2);
  assert.deepStrictEqual(t.lanes[0].map((c) => c.id), ['ORCH-001']);
  assert.deepStrictEqual(t.lanes[1].map((c) => c.id), ['ORCH-002', 'ORCH-003']);
  assert.deepStrictEqual(t.edges, [
    { from: 'ORCH-001', to: 'ORCH-002' },
    { from: 'ORCH-001', to: 'ORCH-003' },
  ]);
});

test('buildTree：converge 只收 running 队列；MAIN 进度是均值', () => {
  const v = viewOf({
    tickets: [
      ticketOf('ORCH-001', { status: 'running' }),
      ticketOf('ORCH-002', { status: 'done' }),
      ticketOf('ORCH-003', { status: 'draft' }),
    ],
  });
  const t = tree.buildTree(v);
  assert.deepStrictEqual(t.converge.map((c) => c.id), ['ORCH-001']);
  assert.ok(Math.abs(t.main.progress - (0.75 + 1 + 0.1) / 3) < 1e-9);
});

test('buildTree：session log 最新在下、只留 logLimit 条、主体按 kind 映射', () => {
  // buildOrchView 的 facts 是新→旧
  const facts = [
    { kind: 'blocker', text: '阻塞 ORCH-014：agent-not-installed', at: 4000, ticketIds: ['ORCH-014'] },
    { kind: 'fact', text: '派发 ORCH-012 → claude-code:a41f', at: 3000, ticketIds: ['ORCH-012'] },
    { kind: 'decision', text: '三闸门通过', at: 2000, ticketIds: [] },
    { kind: 'fact', text: '立单 ORCH-011：老目标', at: 1000, ticketIds: ['ORCH-011'] },
  ];
  const t = tree.buildTree(viewOf({ facts }), { logLimit: 3 });
  assert.strictEqual(t.log.length, 3);
  assert.deepStrictEqual(t.log.map((l) => l.at), [2000, 3000, 4000]); // 旧→新
  assert.strictEqual(t.log[0].who, 'gate');
  assert.strictEqual(t.log[1].who, 'orch');
  assert.strictEqual(t.log[2].who, 'user');
  assert.deepStrictEqual(t.log[2].ticketIds, ['ORCH-014']);
});

test('buildTree：report 留痕归 gate 频道（回执/关口推进与 LLM 判断同频道色）', () => {
  const facts = [{ kind: 'report', text: '窗口推进 A.a planning→execution（人确认）', at: 5000, ticketIds: [] }];
  const t = tree.buildTree(viewOf({ facts }));
  assert.strictEqual(t.log[0].who, 'gate');
});

test('buildTree：keeper 计数与发言优先级（环 > 阻塞 > 失败 > jev）', () => {
  const base = viewOf({
    tickets: [ticketOf('ORCH-001', { status: 'blocked' }), ticketOf('ORCH-002', { status: 'failed' })],
  });
  const k1 = tree.buildTree(base).keeper;
  assert.strictEqual(k1.blocked, 1);
  assert.strictEqual(k1.failed, 1);
  assert.match(k1.lastAdvice, /阻塞/);

  const k2 = tree.buildTree(viewOf({ ...base, cycles: [['ORCH-001', 'ORCH-002']] })).keeper;
  assert.match(k2.lastAdvice, /环/);

  const k3 = tree.buildTree(viewOf(), { decisions: [{ reason: 'local-confidence-low' }] }).keeper;
  assert.strictEqual(k3.lastAdvice, 'jev：local-confidence-low');
});

test('buildTree：status 行聚合计数（inbox 求和、jev=决策数）', () => {
  const v = viewOf({
    summary: { total: 5, pending: 1, active: 2, counts: {} },
    inbox: [{ sessionId: 'a', unread: 2 }, { sessionId: 'b', unread: 1 }],
    tickets: [ticketOf('ORCH-001')],
  });
  const t = tree.buildTree(v, { decisions: [{}, {}, {}] });
  assert.deepStrictEqual(t.status, { total: 5, pending: 1, active: 2, inbox: 3, cycles: 0, jev: 3 });
});

test('buildTree：确定性 —— 同一输入两次产出深度相等', () => {
  const v = viewOf({
    tickets: [ticketOf('ORCH-002', { dependsOn: ['ORCH-001'] }), ticketOf('ORCH-001')],
    facts: [{ kind: 'fact', text: '立单 ORCH-001：x', at: 1 }],
  });
  assert.deepStrictEqual(tree.buildTree(v), tree.buildTree(v));
});

// ── 五级窗口协作投影（opts.roadmap = index.buildRoadmapSlice() 的形状）───────

function roadmapSliceOf(over = {}) {
  return {
    header: { currentMilestone: 'm', currentWindowState: 'execution', soleGoal: '在范围内增量交付', nextAllowedState: 'review' },
    window: { stageId: 'A', stageTitle: '阶段A', subtaskId: 'a', subtaskTitle: '子任务a', state: 'execution', ticketIds: ['ORCH-001'] },
    windowId: 'A.a',
    color: '#10b981',
    stateLabel: '执行',
    tickets: [{ id: 'ORCH-001', status: 'running', title: '工单一' }],
    roadmap: [
      { id: 'A', title: '阶段A', authorized: true, subtasks: [
        { id: 'a', title: '子任务a', state: 'execution', active: true },
        { id: 'b', title: '子任务b', state: 'planning', active: false },
      ] },
      { id: 'B', title: '阶段B', authorized: false, subtasks: [
        { id: 'a', title: '子任务Ba', state: 'planning', active: false },
      ] },
    ],
    milestone: 'm',
    latestReport: { id: 'r-1', verdict: 'pass', checklist: [{ id: 'scope', passed: true, note: '' }] },
    ...over,
  };
}

test('buildTree：无 roadmap 时窗口三段全 null（四段 UI 整段静默的依据）', () => {
  const t = tree.buildTree(viewOf({ tickets: [ticketOf('ORCH-001')] }));
  assert.strictEqual(t.windowState, null);
  assert.strictEqual(t.roadmapView, null);
  assert.strictEqual(t.latestReport, null);
  // roadmap:null / 缺 window 的脏切片同样不炸不编
  const t2 = tree.buildTree(viewOf(), { roadmap: null });
  assert.strictEqual(t2.windowState, null);
  const t3 = tree.buildTree(viewOf(), { roadmap: { milestone: 'm' } });
  assert.strictEqual(t3.roadmapView, null);
});

test('buildTree：roadmap 投影——windowState / strip 标记 / 阶段带子任务状态文案', () => {
  const t = tree.buildTree(viewOf(), { roadmap: roadmapSliceOf() });
  assert.strictEqual(t.windowState, 'execution');
  const rv = t.roadmapView;
  assert.strictEqual(rv.windowId, 'A.a');
  assert.strictEqual(rv.stateLabel, '执行');
  assert.strictEqual(rv.soleGoal, '在范围内增量交付');
  assert.strictEqual(rv.nextAllowed, 'review');
  // 五态条：当前格只有一格，前面的 reached、后面的没有
  assert.strictEqual(rv.strip.length, 5);
  assert.deepStrictEqual(rv.strip.map((s) => s.id), ['planning', 'execution', 'review', 'closeout', 'closed']);
  assert.deepStrictEqual(rv.strip.filter((s) => s.current).map((s) => s.id), ['execution']);
  assert.deepStrictEqual(rv.strip.map((s) => s.reached), [true, true, false, false, false]);
  // 阶段带：授权旗标原样过，子任务状态 → 文案由 protocol 供
  assert.strictEqual(rv.stages.length, 2);
  assert.strictEqual(rv.stages[0].authorized, true);
  assert.strictEqual(rv.stages[1].authorized, false);
  assert.strictEqual(rv.stages[0].subtasks[0].stateLabel, '执行');
  assert.strictEqual(rv.stages[0].subtasks[1].stateLabel, '规划');
  assert.strictEqual(rv.stages[0].subtasks[0].active, true);
  // 关联工单聚合投影原样搬运（缺一字段也不炸）
  assert.deepStrictEqual(rv.tickets[0], { id: 'ORCH-001', status: 'running', title: '工单一' });
});

test('buildTree：latestReport 只挂活跃窗口有回执时（投影自由文本原样过，UI 侧 esc）', () => {
  const withReport = tree.buildTree(viewOf(), { roadmap: roadmapSliceOf() });
  assert.strictEqual(withReport.latestReport.verdict, 'pass');
  assert.strictEqual(withReport.latestReport.checklist[0].id, 'scope');
  const noReport = tree.buildTree(viewOf(), { roadmap: roadmapSliceOf({ latestReport: null }) });
  assert.strictEqual(noReport.windowState, 'execution');
  assert.strictEqual(noReport.latestReport, null);
});

test('buildTree：非法窗口状态脏切片 → 三段全 null（不假装状态成立）', () => {
  const bad = roadmapSliceOf({ window: { state: 'half-done', stageTitle: '', subtaskTitle: '' }, windowId: 'A.a' });
  const t = tree.buildTree(viewOf(), { roadmap: bad });
  assert.strictEqual(t.windowState, null);
  assert.strictEqual(t.roadmapView, null);
  assert.strictEqual(t.latestReport, null);
});
