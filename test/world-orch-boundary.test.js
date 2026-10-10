// test/world-orch-boundary.test.js
// world/orch/boundary-check.js 的纯逻辑守门：九项清单的形状、校验与机器抽查。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const bc = require('../world/orch/boundary-check');

// ---------- 清单表 ----------

test('九项规则冻结、id/label/intent 齐全、机器可抽查恰好三项', () => {
  assert.equal(bc.BOUNDARY_RULES.length, 9);
  assert.ok(Object.isFrozen(bc.BOUNDARY_RULES));
  assert.deepEqual(
    bc.BOUNDARY_RULES.map((r) => r.id),
    ['scope', 'overreach', 'unauthorized', 'authority', 'second-source', 'garbage', 'masking', 'legacy', 'fake-evidence'],
  );
  for (const r of bc.BOUNDARY_RULES) {
    assert.ok(r.label && r.intent, `规则 ${r.id} 缺 label/intent`);
  }
  assert.deepEqual(bc.MACHINE_CHECKABLE, ['fake-evidence', 'garbage', 'second-source']);
});

test('defaultChecklist：九项全 ❌（默认不过，逐项声明才算数）且顺序即清单顺序', () => {
  const list = bc.defaultChecklist();
  assert.equal(list.length, 9);
  assert.deepEqual(list.map((i) => i.id), bc.RULE_IDS);
  assert.ok(list.every((i) => i.passed === false));
});

// ---------- normalizeChecklist ----------

test('normalizeChecklist：未知 id 丢弃、重复去重、passed 只认字面 true、恢复清单顺序', () => {
  const list = bc.normalizeChecklist([
    { id: 'garbage', passed: true },
    { id: 'nonsense', passed: true },
    { id: 'scope', passed: 1 }, // truthy 非 true → false（审计诚实：自报"是"不算数）
    { id: 'scope', passed: true }, // 重复：只留首条
  ]);
  assert.deepEqual(list.map((i) => i.id), ['scope', 'garbage']);
  assert.equal(list[0].passed, false);
  assert.equal(list[1].passed, true);
});

test('normalizeChecklist：note 压平换行截 200，非数组输入回空', () => {
  const list = bc.normalizeChecklist([{ id: 'scope', passed: true, note: 'a\nb\nc' + 'x'.repeat(300) }]);
  assert.equal(list.length, 1);
  assert.ok(!list[0].note.includes('\n'));
  assert.ok(list[0].note.length <= 200);
  assert.deepEqual(bc.normalizeChecklist(null), []);
  assert.deepEqual(bc.normalizeChecklist('x'), []);
});

// ---------- validateChecklist ----------

test('validateChecklist：缺项逐项报 boundary-item-missing，fix 带判定标准', () => {
  const problems = bc.validateChecklist([{ id: 'scope', passed: true }]);
  const missing = problems.filter((p) => p.code === 'boundary-item-missing');
  assert.equal(missing.length, 8, '只交一项缺八项');
  assert.ok(missing.every((p) => p.fix.includes('判定标准')));
});

test('validateChecklist：requireAllPassed 时未过项报 boundary-item-failed', () => {
  const items = bc.defaultChecklist().map((i) => (i.id === 'scope' ? { ...i, passed: true } : i));
  const problems = bc.validateChecklist(items, { requireAllPassed: true });
  const failed = problems.filter((p) => p.code === 'boundary-item-failed');
  assert.equal(failed.length, 8);
  assert.ok(failed.some((p) => p.reason.includes('越界')));

  // 全部通过 = 零问题
  const all = bc.defaultChecklist().map((i) => ({ id: i.id, passed: true }));
  assert.deepEqual(bc.validateChecklist(all, { requireAllPassed: true }), []);
  // 不要求全过时，只查缺项不查失败
  assert.deepEqual(
    bc.validateChecklist(bc.defaultChecklist(), { requireAllPassed: false }),
    [],
  );
});

// ---------- assertEvidenceConsistency（机器抽查三项） ----------

function reportWith(over = {}) {
  return {
    stageState: 'execution',
    verdict: 'pass',
    deliverable: ['world/orch/protocol.js'],
    evidence: [{ type: 'test', content: 'node --test 全绿' }],
    risks: { blocker: [], nonBlocker: [] },
    blockingDecision: { blocker: '', blocksStageClose: false, blocksNextStage: false },
    recommendedNextStep: '',
    ...over,
  };
}

test('机器抽查·证据真实性：synthetic 冒充 command/file/test 被抓，manual 放行', () => {
  const bad = bc.assertEvidenceConsistency(
    reportWith({ evidence: [{ type: 'command', content: 'npm test 全绿', synthetic: true }] }),
  );
  assert.equal(bad.length, 1);
  assert.equal(bad[0].code, 'boundary-fake-evidence');

  const okFile = bc.assertEvidenceConsistency(
    reportWith({ evidence: [{ type: 'file', content: 'world/orch/protocol.js 存在', synthetic: true }] }),
  );
  assert.equal(okFile.length, 1);

  const manual = bc.assertEvidenceConsistency(
    reportWith({ evidence: [{ type: 'manual', content: '演示截图（占位）', synthetic: true }] }),
  );
  assert.equal(manual.length, 0, 'manual + synthetic 是诚实的占位，不算伪标');

  const real = bc.assertEvidenceConsistency(
    reportWith({ evidence: [{ type: 'command', content: 'node --test 全绿' }] }),
  );
  assert.equal(real.length, 0);
});

test('机器抽查·垃圾入库：tmp/cache/runtime/node_modules 路径段进交付清单被抓', () => {
  const cases = ['tmp/out.png', '/var/tmp/x.js', 'cache/res.json', 'world/runtime/state.json', 'x\\temp\\y.txt'];
  for (const d of cases) {
    const problems = bc.assertEvidenceConsistency(reportWith({ deliverable: [d] }));
    assert.ok(problems.some((p) => p.code === 'boundary-garbage'), `${d} 应被抓`);
  }
  const clean = bc.assertEvidenceConsistency(reportWith({ deliverable: ['world/orch/protocol.js', 'AGENT.md'] }));
  assert.equal(clean.filter((p) => p.code === 'boundary-garbage').length, 0);
});

test('机器抽查·第二事实源：多份 roadmap 类工件被抓，单份放行', () => {
  const dup = bc.assertEvidenceConsistency(
    reportWith({ deliverable: ['roadmap.json', 'docs/ROADMAP-note.md', 'world/orch/protocol.js'] }),
  );
  assert.equal(dup.length, 1);
  assert.equal(dup[0].code, 'boundary-second-source');

  const single = bc.assertEvidenceConsistency(reportWith({ deliverable: ['roadmap.json', 'AGENT.md'] }));
  assert.equal(single.length, 0);
});

test('机器抽查永不抛：空报告/字段缺失回空问题表（判不出就是判不出）', () => {
  assert.deepEqual(bc.assertEvidenceConsistency(null), []);
  assert.deepEqual(bc.assertEvidenceConsistency({}), []);
  assert.deepEqual(bc.assertEvidenceConsistency(reportWith({ evidence: null, deliverable: null })), []);
});

test('宁可漏报不可错杀：六项人工判定规则从不出现在机器抽查问题码里', () => {
  const problems = bc.assertEvidenceConsistency(
    reportWith({ deliverable: ['src/menu.js', 'src/permission.js'] }),
  );
  for (const p of problems) {
    assert.match(p.code, /^boundary-(fake-evidence|garbage|second-source)$/);
  }
});
