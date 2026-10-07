// test/world-orch-tickets.test.js
// 工单数据模型（world/orch/tickets.js）：id 发号、依赖图、状态机、确定性拆分。
// 这些都是编排层的"账本真相"，错了会让派单追不回来，所以覆盖得比较细。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const T = require('../world/orch/tickets');

// ---------- id 发号 ----------

test('nextTicketId：从空账本发 ORCH-001，之后逐个递增', () => {
  assert.strictEqual(T.nextTicketId([]), 'ORCH-001');
  assert.strictEqual(T.nextTicketId(['ORCH-001']), 'ORCH-002');
  assert.strictEqual(T.nextTicketId(['ORCH-001', 'ORCH-002', 'ORCH-003']), 'ORCH-004');
});

test('nextTicketId：与输入顺序无关（取最大序号+1，不受乱序影响）', () => {
  const a = T.nextTicketId(['ORCH-009', 'ORCH-002', 'ORCH-005']);
  const b = T.nextTicketId(['ORCH-005', 'ORCH-009', 'ORCH-002']);
  assert.strictEqual(a, b);
  assert.strictEqual(a, 'ORCH-010');
});

test('nextTicketId：非法 id 被忽略，不污染发号', () => {
  assert.strictEqual(T.nextTicketId(['abc', '', null, 'ORCH-003']), 'ORCH-004');
  assert.strictEqual(T.nextTicketId(['nope']), 'ORCH-001');
});

test('allocateIds：一次发连续多个号', () => {
  assert.deepStrictEqual(T.allocateIds(3, []), ['ORCH-001', 'ORCH-002', 'ORCH-003']);
  assert.deepStrictEqual(T.allocateIds(2, ['ORCH-010']), ['ORCH-011', 'ORCH-012']);
});

test('seqOf / formatId：非法输入不抛，非法序号抛', () => {
  assert.strictEqual(T.seqOf('ORCH-042'), 42);
  assert.strictEqual(T.seqOf('ORCH-1234'), 1234);
  assert.strictEqual(T.seqOf('nope'), 0);
  assert.strictEqual(T.seqOf(undefined), 0);
  assert.strictEqual(T.formatId(7), 'ORCH-007');
  assert.strictEqual(T.formatId(1234), 'ORCH-1234'); // 超过三位不截断
  assert.throws(() => T.formatId(0));
  assert.throws(() => T.formatId(-1));
});

test('序号用尽时明确报错，不静默进 ORCH-1000', () => {
  assert.throws(() => T.nextTicketId(['ORCH-999']), /序号已用尽/);
  assert.throws(() => T.allocateIds(2, ['ORCH-998']), /序号不足/);
});

// ---------- 状态机 ----------

test('canTransition：合法迁移放行，非法迁移拒绝', () => {
  assert.ok(T.canTransition('draft', 'confirmed'));
  assert.ok(T.canTransition('confirmed', 'dispatched'));
  assert.ok(T.canTransition('dispatched', 'running'));
  assert.ok(T.canTransition('running', 'done'));
  assert.ok(T.canTransition('blocked', 'draft')); // 阻塞后可回草案改派
  // done 是终态：不能回到任何地方
  assert.ok(!T.canTransition('done', 'running'));
  assert.ok(!T.canTransition('done', 'draft'));
  // 不允许跳级
  assert.ok(!T.canTransition('draft', 'dispatched'));
  assert.ok(!T.canTransition('draft', 'running'));
  assert.ok(!T.canTransition('confirmed', 'done'));
  // 未知状态一律拒绝
  assert.ok(!T.canTransition('draft', 'nope'));
  assert.ok(!T.canTransition('nope', 'draft'));
});

test('同状态自迁允许（幂等重放不算非法）', () => {
  assert.ok(T.canTransition('running', 'running'));
});

// ---------- 依赖图 ----------

test('findCycles：无环返回空（含菱形共享依赖，不能误报）', () => {
  assert.deepStrictEqual(T.findCycles([
    { id: 'ORCH-001', dependsOn: [] },
    { id: 'ORCH-002', dependsOn: ['ORCH-001'] },
  ]), []);
  assert.deepStrictEqual(T.findCycles([
    { id: 'ORCH-001', dependsOn: [] },
    { id: 'ORCH-002', dependsOn: ['ORCH-001'] },
    { id: 'ORCH-003', dependsOn: ['ORCH-001'] },
    { id: 'ORCH-004', dependsOn: ['ORCH-002', 'ORCH-003'] },
  ]), []);
});

test('findCycles：两节点环', () => {
  const cycles = T.findCycles([
    { id: 'ORCH-001', dependsOn: ['ORCH-002'] },
    { id: 'ORCH-002', dependsOn: ['ORCH-001'] },
  ]);
  assert.strictEqual(cycles.length, 1);
  assert.deepStrictEqual([...cycles[0]].sort(), ['ORCH-001', 'ORCH-002']);
});

test('findCycles：三节点环（曾经漏检过，必须挡住）', () => {
  const cycles = T.findCycles([
    { id: 'ORCH-001', dependsOn: ['ORCH-003'] },
    { id: 'ORCH-002', dependsOn: ['ORCH-001'] },
    { id: 'ORCH-003', dependsOn: ['ORCH-002'] },
  ]);
  assert.strictEqual(cycles.length, 1, '三节点环必须被检出');
  assert.deepStrictEqual([...cycles[0]].sort(), ['ORCH-001', 'ORCH-002', 'ORCH-003']);
});

test('findCycles：自环', () => {
  const cycles = T.findCycles([{ id: 'ORCH-001', dependsOn: ['ORCH-001'] }]);
  assert.deepStrictEqual(cycles, [['ORCH-001']]);
});

test('findCycles：环外的正常节点不被牵连', () => {
  const cycles = T.findCycles([
    { id: 'ORCH-001', dependsOn: ['ORCH-002'] },
    { id: 'ORCH-002', dependsOn: ['ORCH-001'] },
    { id: 'ORCH-003', dependsOn: ['ORCH-001'] },
  ]);
  assert.strictEqual(cycles.length, 1);
  assert.ok(!cycles[0].includes('ORCH-003'));
});

test('findCycles：同一环只报一次（旋转视为同一个环）', () => {
  const cycles = T.findCycles([
    { id: 'ORCH-001', dependsOn: ['ORCH-002'] },
    { id: 'ORCH-002', dependsOn: ['ORCH-003'] },
    { id: 'ORCH-003', dependsOn: ['ORCH-001'] },
  ]);
  assert.strictEqual(cycles.length, 1);
});

test('findCycles：长链不爆栈（显式栈实现，300 层）', () => {
  const chain = Array.from({ length: 300 }, (_, i) => ({
    id: `ORCH-${String(i + 1).padStart(3, '0')}`,
    dependsOn: i ? [`ORCH-${String(i).padStart(3, '0')}`] : [],
  }));
  assert.deepStrictEqual(T.findCycles(chain), []);
  assert.strictEqual(T.topoOrder(chain).length, 300);
});

test('findCycles：悬空依赖不算成环（由 checkDependencies 单独报）', () => {
  assert.deepStrictEqual(T.findCycles([{ id: 'ORCH-001', dependsOn: ['ORCH-999'] }]), []);
});

test('checkDependencies：自依赖与悬空依赖分别归类', () => {
  const problems = T.checkDependencies([
    { id: 'ORCH-001', dependsOn: ['ORCH-001'] },
    { id: 'ORCH-002', dependsOn: ['ORCH-777'] },
  ]);
  assert.strictEqual(problems.length, 2);
  assert.strictEqual(problems.find((p) => p.id === 'ORCH-001').kind, 'self');
  assert.strictEqual(problems.find((p) => p.id === 'ORCH-002').kind, 'missing');
});

test('topoOrder：无环给确定性拓扑序，有环返回 null', () => {
  assert.deepStrictEqual(
    T.topoOrder([
      { id: 'ORCH-002', dependsOn: ['ORCH-001'] },
      { id: 'ORCH-001', dependsOn: [] },
    ]),
    ['ORCH-001', 'ORCH-002'],
  );
  assert.strictEqual(
    T.topoOrder([
      { id: 'ORCH-001', dependsOn: ['ORCH-002'] },
      { id: 'ORCH-002', dependsOn: ['ORCH-001'] },
    ]),
    null,
  );
});

test('topoOrder：同层按 id 排序，结果与输入顺序无关', () => {
  const a = T.topoOrder([
    { id: 'ORCH-003', dependsOn: [] },
    { id: 'ORCH-001', dependsOn: [] },
    { id: 'ORCH-002', dependsOn: [] },
  ]);
  const b = T.topoOrder([
    { id: 'ORCH-001', dependsOn: [] },
    { id: 'ORCH-003', dependsOn: [] },
    { id: 'ORCH-002', dependsOn: [] },
  ]);
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(a, ['ORCH-001', 'ORCH-002', 'ORCH-003']);
});

test('depsOf：非数组 / 非字符串项被过滤，不抛', () => {
  assert.deepStrictEqual(T.depsOf({ dependsOn: ['ORCH-001', '', null, 5] }), ['ORCH-001']);
  assert.deepStrictEqual(T.depsOf({}), []);
  assert.deepStrictEqual(T.depsOf(null), []);
});

// ---------- 确定性拆分器 ----------

test('splitClauses：按标点与连接词切句', () => {
  assert.deepStrictEqual(
    T.splitClauses('梳理登录流程，然后修复 token bug，补上测试'),
    ['梳理登录流程', '修复 token bug', '补上测试'],
  );
});

test('splitClauses：同一输入永远同一输出（确定性）', () => {
  const goal = '读代码，然后改实现，再跑测试';
  const a = T.splitClauses(goal);
  const b = T.splitClauses(goal);
  assert.deepStrictEqual(a, b);
});

test('splitClauses：过短碎片并入相邻子句，不单独成单', () => {
  const out = T.splitClauses('修复登录 bug，然后 OK，再补测试');
  assert.ok(out.every((c) => c.length >= 3), `不该出现碎片：${JSON.stringify(out)}`);
  assert.ok(out.some((c) => c.includes('OK')), '碎片不能被静默丢弃');
});

test('splitClauses：开头的短碎片并入下一条，不自己成单', () => {
  const out = T.splitClauses('OK，然后修复登录 bug');
  assert.strictEqual(out.length, 1);
  assert.ok(out[0].startsWith('OK'));
});

test('splitClauses：空输入返回空数组', () => {
  assert.deepStrictEqual(T.splitClauses(''), []);
  assert.deepStrictEqual(T.splitClauses('   '), []);
  assert.deepStrictEqual(T.splitClauses(null), []);
  assert.deepStrictEqual(T.splitClauses('，。；'), []);
});

test('draftTickets：默认线性依赖链，第 N 条依赖第 N-1 条', () => {
  const drafts = T.draftTickets('读代码，然后改实现，再跑测试', { agent: 'claude-code', cwd: '/tmp' });
  assert.strictEqual(drafts.length, 3);
  assert.deepStrictEqual(drafts[0].dependsOn, []);
  assert.deepStrictEqual(drafts[1].dependsOn, [drafts[0].id]);
  assert.deepStrictEqual(drafts[2].dependsOn, [drafts[1].id]);
});

test('draftTickets：independent 走并行（无内部依赖）', () => {
  const drafts = T.draftTickets('读代码，然后改实现，再跑测试', { independent: true });
  assert.strictEqual(drafts.length, 3);
  for (const d of drafts) assert.deepStrictEqual(d.dependsOn, []);
});

test('draftTickets：全部初始状态是 draft（进世界的第一状态永远是待人确认）', () => {
  const drafts = T.draftTickets('随便做点事');
  assert.ok(drafts.every((d) => d.status === 'draft'));
});

test('draftTickets：按 existingIds 续号，不发重号', () => {
  const drafts = T.draftTickets('做一件事', { existingIds: ['ORCH-001', 'ORCH-002'] });
  assert.strictEqual(drafts[0].id, 'ORCH-003');
});

test('draftTickets：每条都带可判定的验收标准', () => {
  const drafts = T.draftTickets('读代码，然后改实现，再补测试');
  for (const d of drafts) {
    assert.ok(Array.isArray(d.acceptance) && d.acceptance.length >= 2, `${d.id} 缺验收标准`);
    assert.ok(d.acceptance.every((a) => typeof a === 'string' && a.length > 0));
  }
});

test('classifyAction：按关键词判定动作类型', () => {
  assert.strictEqual(T.classifyAction('读一下登录流程'), 'read');
  assert.strictEqual(T.classifyAction('修复 token 刷新'), 'change');
  assert.strictEqual(T.classifyAction('补上回归测试'), 'test');
  assert.strictEqual(T.classifyAction('验证一下'), 'verify');
  assert.strictEqual(T.classifyAction('更新 README'), 'docs');
  assert.strictEqual(T.classifyAction('整理归档目录'), 'sweeping');
  assert.strictEqual(T.classifyAction('下载依赖包'), 'carrying');
  assert.strictEqual(T.classifyAction('开会讨论'), 'attention');
  assert.strictEqual(T.classifyAction('嗯'), 'generic'); // 全落空回退
});

// ---------- 视图与校验 ----------

test('groupByStatus：按固定列序分组，组内按 id 升序', () => {
  const cols = T.groupByStatus([
    { id: 'ORCH-002', status: 'draft' },
    { id: 'ORCH-001', status: 'draft' },
    { id: 'ORCH-003', status: 'done' },
  ]);
  assert.deepStrictEqual(Object.keys(cols), [...T.STATUSES]);
  assert.deepStrictEqual(cols.draft.map((t) => t.id), ['ORCH-001', 'ORCH-002']);
  assert.strictEqual(cols.done.length, 1);
});

test('summarize：总数/待确认/在跑计数', () => {
  const s = T.summarize([
    { status: 'draft' }, { status: 'confirmed' },
    { status: 'dispatched' }, { status: 'running' },
    { status: 'done' },
  ]);
  assert.strictEqual(s.total, 5);
  assert.strictEqual(s.pending, 2); // draft + confirmed
  assert.strictEqual(s.active, 2); // dispatched + running
});

test('validateTicket：字段不合法逐条报错', () => {
  assert.ok(T.validateTicket({ id: 'bad', status: 'draft', title: 'x', acceptance: [] }).length > 0);
  assert.ok(T.validateTicket({ id: 'ORCH-001', status: 'nope', title: 'x', acceptance: [] }).length > 0);
  assert.ok(T.validateTicket({ id: 'ORCH-001', status: 'draft', title: '', acceptance: [] }).length > 0);
  assert.ok(T.validateTicket({ id: 'ORCH-001', status: 'draft', title: 'x' }).length > 0);
  assert.ok(T.validateTicket({ id: 'ORCH-001', status: 'draft', title: 'x', dependsOn: ['nope'], acceptance: [] }).length > 0);
  // 合法工单零错误
  assert.deepStrictEqual(
    T.validateTicket({ id: 'ORCH-001', status: 'draft', title: '做事', dependsOn: [], acceptance: ['a'] }),
    [],
  );
});

test('statusLabel：未知状态退回原值，不显示 undefined', () => {
  assert.strictEqual(T.statusLabel('draft'), '草案');
  assert.strictEqual(T.statusLabel('nope'), 'nope');
});