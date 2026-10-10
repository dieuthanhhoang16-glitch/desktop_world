// test/world-orch-protocol.test.js
// world/orch/protocol.js 的纯逻辑守门：窗口五态机 + WindowStateHeader + StageReport 校验。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const protocol = require('../world/orch/protocol');

// ---------- 五态与标签 ----------

test('五态冻结、顺序即推进顺序，标签与状态色全覆盖', () => {
  assert.deepEqual([...protocol.WINDOW_STATES], ['planning', 'execution', 'review', 'closeout', 'closed']);
  assert.ok(Object.isFrozen(protocol.WINDOW_STATES));
  for (const s of protocol.WINDOW_STATES) {
    assert.ok(protocol.WINDOW_STATE_LABELS[s], `缺标签 ${s}`);
    assert.match(protocol.WINDOW_STATE_COLORS[s], /^#[0-9a-f]{6}$/i, `缺状态色 ${s}`);
  }
  // 任务书指定的状态色是协议的一部分，钉死防止漂色
  assert.equal(protocol.WINDOW_STATE_COLORS.planning, '#3b82f6');
  assert.equal(protocol.WINDOW_STATE_COLORS.execution, '#10b981');
  assert.equal(protocol.WINDOW_STATE_COLORS.review, '#f59e0b');
  assert.equal(protocol.WINDOW_STATE_COLORS.closeout, '#8b5cf6');
  assert.equal(protocol.WINDOW_STATE_COLORS.closed, '#6b7280');
});

// ---------- 迁移表 ----------

test('canTransitionWindow：前进合法、每态一条回边、跳态/未知态拒绝、自迁移恒真', () => {
  assert.equal(protocol.canTransitionWindow('planning', 'execution'), true);
  assert.equal(protocol.canTransitionWindow('execution', 'review'), true);
  assert.equal(protocol.canTransitionWindow('review', 'closeout'), true);
  assert.equal(protocol.canTransitionWindow('closeout', 'closed'), true);
  // 回边：放弃重规划 / 打回返工 / 回执不全复验
  assert.equal(protocol.canTransitionWindow('execution', 'planning'), true);
  assert.equal(protocol.canTransitionWindow('review', 'execution'), true);
  assert.equal(protocol.canTransitionWindow('closeout', 'review'), true);
  // 跳态一律非法
  assert.equal(protocol.canTransitionWindow('planning', 'review'), false);
  assert.equal(protocol.canTransitionWindow('planning', 'closed'), false);
  assert.equal(protocol.canTransitionWindow('execution', 'closeout'), false);
  assert.equal(protocol.canTransitionWindow('closed', 'planning'), false);
  // 自迁移与未知态：镜像 tickets.canTransition
  assert.equal(protocol.canTransitionWindow('review', 'review'), true);
  assert.equal(protocol.canTransitionWindow('???', 'review'), false);
  assert.equal(protocol.canTransitionWindow('review', '???'), false);
});

test('nextWindowState：只看前进方向，closed 无下一态', () => {
  assert.equal(protocol.nextWindowState('planning'), 'execution');
  assert.equal(protocol.nextWindowState('execution'), 'review');
  assert.equal(protocol.nextWindowState('review'), 'closeout');
  assert.equal(protocol.nextWindowState('closeout'), 'closed');
  assert.equal(protocol.nextWindowState('closed'), null);
  assert.equal(protocol.nextWindowState('???'), null);
});

test('verdictOkForAdvance：pass 系可推进，fail/blocked 不可', () => {
  assert.equal(protocol.verdictOkForAdvance('pass'), true);
  assert.equal(protocol.verdictOkForAdvance('pass-with-non-blocker'), true);
  assert.equal(protocol.verdictOkForAdvance('fail'), false);
  assert.equal(protocol.verdictOkForAdvance('blocked'), false);
  assert.equal(protocol.verdictOkForAdvance('???'), false);
});

// ---------- 窗口头 ----------

test('windowGoalFor：每态给出唯一目标与前进去向，未知态回落 planning', () => {
  const p = protocol.windowGoalFor('planning');
  assert.equal(p.currentWindowState, 'planning');
  assert.match(p.soleGoal, /拆解/);
  assert.equal(p.nextAllowedState, 'execution');

  const e = protocol.windowGoalFor('execution');
  assert.match(e.soleGoal, /阶段范围内/);
  assert.equal(e.nextAllowedState, 'review');

  const c = protocol.windowGoalFor('closed');
  assert.equal(c.nextAllowedState, null);

  const u = protocol.windowGoalFor('nope');
  assert.equal(u.currentWindowState, 'planning');
});

test('windowHeader：协议四字段齐、缺 state 回 planning', () => {
  const h = protocol.windowHeader({ milestone: 'multi-agent-refactor', windowState: 'execution' });
  assert.deepEqual(Object.keys(h).sort(), ['currentMilestone', 'currentWindowState', 'nextAllowedState', 'soleGoal']);
  assert.equal(h.currentMilestone, 'multi-agent-refactor');
  assert.equal(h.currentWindowState, 'execution');
  assert.equal(h.nextAllowedState, 'review');

  const h0 = protocol.windowHeader({ milestone: 'm' });
  assert.equal(h0.currentWindowState, 'planning');
});

// ---------- StageReport 校验 ----------

function goodReport(over = {}) {
  return {
    stageState: 'execution',
    verdict: 'pass',
    deliverable: ['world/orch/protocol.js', 'test/world-orch-protocol.test.js'],
    evidence: [{ type: 'test', content: 'node --test test/world-orch-protocol.test.js 全绿' }],
    risks: { blocker: [], nonBlocker: ['UI 尚未接入'] },
    boundaryCheck: { version: 1, checkedAt: null, items: [{ id: 'scope', passed: true }] },
    blockingDecision: { blocker: '', blocksStageClose: false, blocksNextStage: false },
    recommendedNextStep: '进入 review',
    ...over,
  };
}

test('validateStageReport：合格回执原样通过且白名单重建', () => {
  const r = protocol.validateStageReport(goodReport({ hacker: 'extra' }));
  assert.equal(r.ok, true);
  assert.equal(r.report.stageState, 'execution');
  assert.equal('hacker' in r.report, false, '未知字段必须丢弃');
  assert.deepEqual(r.report.deliverable, ['world/orch/protocol.js', 'test/world-orch-protocol.test.js']);
});

test('validateStageReport：非对象 / 非法状态 / 非法判定各有专属问题码', () => {
  const p1 = protocol.validateStageReport(null);
  assert.equal(p1.ok, false);
  assert.equal(p1.problems[0].code, 'report-not-object');

  const p2 = protocol.validateStageReport(goodReport({ stageState: 'done' }));
  assert.ok(p2.problems.some((p) => p.code === 'report-state-invalid'));

  const p3 = protocol.validateStageReport(goodReport({ verdict: 'ok' }));
  assert.ok(p3.problems.some((p) => p.code === 'report-verdict-invalid'));
});

test('validateStageReport：pass 系 verdict 必须有指认得出的交付物', () => {
  const p = protocol.validateStageReport(goodReport({ deliverable: [] }));
  assert.equal(p.ok, false);
  assert.ok(p.problems.some((x) => x.code === 'report-deliverable-required'));

  // fail/blocked 允许空 deliverable（没说通过了什么）
  const f = protocol.validateStageReport(goodReport({ verdict: 'fail', deliverable: [] }));
  assert.equal(f.ok, true);
});

test('validateStageReport：类型字段逐一设防（deliverable/evidence/risks/boundary/blocking）', () => {
  const cases = [
    [{ deliverable: 'not-array' }, 'report-deliverable-type'],
    [{ evidence: 'not-array' }, 'report-evidence-type'],
    [{ risks: ['nope'] }, 'report-risks-type'],
    [{ boundaryCheck: 'nope' }, 'report-boundary-type'],
    [{ blockingDecision: 'nope' }, 'report-blocking-type'],
  ];
  for (const [over, code] of cases) {
    const r = protocol.validateStageReport(goodReport(over));
    assert.ok(r.problems.some((p) => p.code === code), `缺问题码 ${code}`);
  }
});

test('validateStageReport：证据收形——裸串归 manual、非法类型归 manual、synthetic 保留', () => {
  const r = protocol.validateStageReport(
    goodReport({
      evidence: [
        '人工走查了一遍',
        { type: 'command', content: 'npm test，12371 过', synthetic: true },
        { type: 'psychic', content: '直觉' },
        { content: '' },
        'x'.repeat(500),
      ],
    }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.report.evidence[0].type, 'manual');
  assert.equal(r.report.evidence[0].content, '人工走查了一遍');
  assert.equal(r.report.evidence[1].type, 'command');
  assert.equal(r.report.evidence[1].synthetic, true);
  assert.equal(r.report.evidence[2].type, 'manual');
  assert.equal(r.report.evidence.length, 4, '空 content 条目被丢');
  assert.ok(r.report.evidence[3].content.length <= 400, '超长证据截断');
});

test('validateStageReport：边界清单收形——passed 强制布尔、note 截断、未知字段不携带', () => {
  const r = protocol.validateStageReport(
    goodReport({
      boundaryCheck: {
        version: 1,
        checkedAt: '2026-10-10T10:00:00.000Z',
        items: [
          { id: 'scope', passed: true, note: 'ok\nfine\n' + 'z'.repeat(300), evidenceTag: 't1' },
          { id: '', passed: true },
          { id: 'garbage', passed: 'yes' },
        ],
      },
    }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.report.boundaryCheck.items.length, 2, '空 id 条目被丢');
  assert.equal(r.report.boundaryCheck.items[0].passed, true);
  assert.ok(r.report.boundaryCheck.items[0].note.length <= 200);
  assert.ok(!r.report.boundaryCheck.items[0].note.includes('\n'), 'note 必须压平换行');
  assert.equal(r.report.boundaryCheck.items[1].passed, false, 'truthy 串强制布尔为 false——passed 只认字面 true');
});

test('validateStageReport：数组上限钉死（deliverable 12 / evidence 24 / risks 12）', () => {
  const r = protocol.validateStageReport(
    goodReport({
      deliverable: Array.from({ length: 40 }, (_, i) => `f${i}`),
      evidence: Array.from({ length: 40 }, (_, i) => `e${i}`),
      risks: { blocker: Array.from({ length: 40 }, (_, i) => `b${i}`), nonBlocker: [] },
    }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.report.deliverable.length, 12);
  assert.equal(r.report.evidence.length, 24);
  assert.equal(r.report.risks.blocker.length, 12);
});

test('validateStageReport：推荐下一步压成单行；确定性深等', () => {
  const r1 = protocol.validateStageReport(goodReport({ recommendedNextStep: '进 review\n顺手授权下阶段' }));
  assert.equal(r1.ok, true);
  assert.ok(!r1.report.recommendedNextStep.includes('\n'));
  assert.deepEqual(
    protocol.validateStageReport(goodReport()),
    protocol.validateStageReport(goodReport()),
  );
});
