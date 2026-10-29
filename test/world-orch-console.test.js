// test/world-orch-console.test.js
// 编排台快照（console-snapshot.js，纯函数）守门：
//   ① 泳道划分口径（needs=draft+failed+blocked / working=confirmed+dispatched+running / done）；
//   ② latestRun 选择（同工单多 run 按 startedAt 取最新；无 run → null）；
//   ③ audit 推导（fence=是否存在该工单 run；verdict/checkedAt 取工单自带字段）；
//   ④ 回执单派生（泳道计数 + convergence 事实按日聚合）与 roadmap/jev 原样透传。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildConsoleSnapshot } = require('../world/orch/console-snapshot');

function ticket(id, status, over = {}) {
  return {
    id,
    title: `${id} 标题`,
    status,
    agent: 'pi',
    cwd: '/tmp/proj',
    dependsOn: [],
    acceptance: ['过测'],
    ...over,
  };
}

function run(runId, ticketId, startedAt, over = {}) {
  return {
    runId,
    ticketId,
    role: 'glm',
    model: 'jd-glm53',
    status: 'completed',
    startedAt,
    finishedAt: '2026-10-18T01:00:00.000Z',
    worktreeDir: `/tmp/wt/${runId}`,
    runDir: `/tmp/runs/${runId}`,
    changedFiles: [],
    error: '',
    ...over,
  };
}

// ---------------------------------------------------------------- 泳道划分

test('泳道：status → lanes 三分口径全覆盖', () => {
  const tickets = [
    ticket('ORCH-001', 'draft'),
    ticket('ORCH-002', 'failed'),
    ticket('ORCH-003', 'blocked'),
    ticket('ORCH-004', 'confirmed'),
    ticket('ORCH-005', 'dispatched'),
    ticket('ORCH-006', 'running'),
    ticket('ORCH-007', 'done'),
  ];
  const snap = buildConsoleSnapshot({ tickets });
  assert.deepEqual(snap.lanes.needs.map((c) => c.id), ['ORCH-001', 'ORCH-002', 'ORCH-003']);
  assert.deepEqual(snap.lanes.working.map((c) => c.id), ['ORCH-004', 'ORCH-005', 'ORCH-006']);
  assert.deepEqual(snap.lanes.done.map((c) => c.id), ['ORCH-007']);
  assert.deepEqual(snap.counts, { needs: 3, working: 3, done: 1, total: 7 });
  assert.equal(typeof snap.summary, 'string');

  const card = snap.lanes.needs[0];
  assert.equal(card.title, 'ORCH-001 标题');
  assert.equal(card.agent, 'pi');
  assert.equal(card.agentName, 'pi');
  assert.deepEqual(card.acceptance, ['过测']);
  assert.equal(card.latestRun, null, '没跑过的工单 latestRun=null');
});

test('空输入：全空 lanes + 零计数，不抛', () => {
  const snap = buildConsoleSnapshot({});
  assert.deepEqual(snap.counts, { needs: 0, working: 0, done: 0, total: 0 });
  assert.deepEqual(snap.lanes, { needs: [], working: [], done: [] });
  assert.deepEqual(snap.runs, []);
  assert.equal(snap.roadmap, null);
  assert.equal(snap.jev, null);
});

// ---------------------------------------------------------------- latestRun

test('latestRun：同工单多 run 按 startedAt 取最新；跨工单互不串', () => {
  const tickets = [ticket('ORCH-001', 'running'), ticket('ORCH-002', 'done')];
  const runs = [
    run('r2', 'ORCH-001', '2026-10-18T02:00:00.000Z', { status: 'completed' }),
    run('r1', 'ORCH-001', '2026-10-18T01:00:00.000Z', { status: 'failed' }),
    run('r3', 'ORCH-001', '2026-10-18T03:00:00.000Z', { status: 'running', active: true, pid: 111 }),
    run('r9', 'ORCH-002', '2026-10-18T09:00:00.000Z'),
    run('rx', 'ORCH-999', '2026-10-18T10:00:00.000Z'), // 孤儿 run：不属于任何卡片
  ];
  const snap = buildConsoleSnapshot({ tickets, runs });
  const c1 = snap.lanes.working.find((c) => c.id === 'ORCH-001');
  const c2 = snap.lanes.done.find((c) => c.id === 'ORCH-002');
  assert.equal(c1.latestRun.runId, 'r3', '最新的是 startedAt 最大的那条（含在跑的）');
  assert.equal(c1.latestRun.status, 'running');
  assert.equal(c1.latestRun.active, true);
  assert.equal(c1.latestRun.pid, 111);
  assert.equal(c2.latestRun.runId, 'r9');
  // runs 数组原样齐全（孤儿 run 也进 runs 列表，只是不挂卡）
  assert.equal(snap.runs.length, 5);
  const n = snap.runs.find((r) => r.runId === 'r3');
  assert.equal(n.worktreeDir, '/tmp/wt/r3');
  assert.equal(n.runDir, '/tmp/runs/r3');
});

// ---------------------------------------------------------------- audit 推导

test('audit：fence=存在该工单的 run；verdict/checkedAt 取工单自带字段（缺省 null）', () => {
  const tickets = [
    ticket('ORCH-001', 'running', { verdict: 'pass', checkedAt: '2026-10-18T03:00:00.000Z' }),
    ticket('ORCH-002', 'draft'), // 没跑过也没审过
    ticket('ORCH-003', 'done'), // 有 run 但没审计字段
  ];
  const runs = [
    run('r1', 'ORCH-001', '2026-10-18T01:00:00.000Z'),
    run('r2', 'ORCH-003', '2026-10-18T02:00:00.000Z'),
  ];
  const snap = buildConsoleSnapshot({ tickets, runs });
  const [a1] = snap.lanes.working;
  const [a2] = snap.lanes.needs;
  const [a3] = snap.lanes.done;
  assert.deepEqual(a1.audit, { fence: true, verdict: 'pass', checkedAt: '2026-10-18T03:00:00.000Z' });
  assert.deepEqual(a2.audit, { fence: false, verdict: null, checkedAt: null });
  assert.deepEqual(a3.audit, { fence: true, verdict: null, checkedAt: null });
});

// ---------------------------------------------------------------- 回执单派生 / 透传

test('invoices：泳道计数 + convergence 事实按日聚合；非 convergence 不算', () => {
  const tickets = [ticket('ORCH-001', 'done'), ticket('ORCH-002', 'draft')];
  const day1 = Date.UTC(2026, 9, 16, 10, 0, 0);
  const day1b = Date.UTC(2026, 9, 16, 22, 0, 0);
  const day2 = Date.UTC(2026, 9, 18, 8, 0, 0);
  const facts = [
    { kind: 'convergence', text: 'A 收敛', ticketIds: ['ORCH-001'], at: day1 },
    { kind: 'fact', text: '派发 ORCH-002', ticketIds: ['ORCH-002'], at: day1b },
    { kind: 'convergence', text: 'B 收敛', ticketIds: ['ORCH-002'], at: day1b },
    { kind: 'convergence', text: 'C 收敛', ticketIds: ['ORCH-001'], at: day2 },
  ];
  const snap = buildConsoleSnapshot({ tickets, blackboardFacts: facts });
  assert.deepEqual(snap.invoices, {
    needs: 1,
    working: 0,
    done: 1,
    daily: [
      { date: '2026-10-16', count: 2 },
      { date: '2026-10-18', count: 1 },
    ],
  });
});

test('roadmap / jev 原样透传；run 归一化补齐默认字段', () => {
  const roadmap = { stageId: 's1', windows: [1, 2] };
  const jev = { enabled: false, reason: 'no-key' };
  const snap = buildConsoleSnapshot({
    tickets: [],
    runs: [{ runId: 'r1', startedAt: '2026-10-18T01:00:00.000Z' }],
    roadmapSlice: roadmap,
    jevStatus: jev,
  });
  assert.deepEqual(snap.roadmap, roadmap);
  assert.deepEqual(snap.jev, jev);
  const r = snap.runs[0];
  assert.equal(r.ticketId, '');
  assert.equal(r.changes, undefined);
  assert.deepEqual(r.changedFiles, []);
  assert.equal(r.active, false);
});
