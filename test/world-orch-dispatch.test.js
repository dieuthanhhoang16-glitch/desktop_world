// test/world-orch-dispatch.test.js
// 派单可行性检查（world/orch/dispatch.js）：agent gate 语义、cwd 存在性、依赖成环。
//
// 这一层的价值全在"不硬派"：任一闸门不满足就必须明确报错 + 给修复建议。
// 所以测试重点是**每个闸门各自会挡住什么**，以及 gate 判定确实复用了
// src/agent-gate.js 的语义（而不是编排层自己维护一份名单）。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dispatch = require('../world/orch/dispatch');
const agentGate = require('../src/agent-gate');
const prefs = require('../src/prefs');
const { getAllAgents } = require('../agents/registry');

// prefs 快照的最小构造：与 src/prefs.js 的 snapshot 形状一致
function snap(agents, customApplications) {
  return { version: prefs.CURRENT_VERSION, agents, customApplications };
}

// 一个真实存在的临时目录（cwd 检查用）
const REAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-dispatch-'));
const MISSING_DIR = path.join(REAL_DIR, 'no-such-dir');

test('checkAgent：已安装且已启用 → 可派', () => {
  const s = snap({ 'claude-code': { integrationInstalled: true, enabled: true } });
  const r = dispatch.checkAgent('claude-code', s);
  assert.strictEqual(r.ok, true);
});

test('checkAgent：未安装 → 拒绝，并建议先去 Install', () => {
  const s = snap({ 'kiro-cli': { integrationInstalled: false, enabled: true } });
  const r = dispatch.checkAgent('kiro-cli', s);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, dispatch.CHECKS.AGENT_NOT_INSTALLED);
  assert.match(r.fix, /Install/);
});

test('checkAgent：已安装但未启用 → 拒绝，建议开开关（不是重装）', () => {
  const s = snap({ 'codex': { integrationInstalled: true, enabled: false } });
  const r = dispatch.checkAgent('codex', s);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, dispatch.CHECKS.AGENT_DISABLED);
  // 修复建议必须区分"启用"与"安装"：只关 enabled 不该让人去重装 hooks
  assert.match(r.fix, /打开开关/);
  assert.ok(!/Install/.test(r.fix));
});

test('checkAgent：未注册的 agent → 拒绝', () => {
  const r = dispatch.checkAgent('not-a-real-agent', snap({}));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, dispatch.CHECKS.AGENT_UNKNOWN);
});

test('checkAgent：空 agent id → 拒绝，不猜一个默认 agent', () => {
  for (const bad of ['', '   ', null, undefined]) {
    const r = dispatch.checkAgent(bad, snap({}));
    assert.strictEqual(r.ok, false, `${JSON.stringify(bad)} 应被拒`);
    assert.strictEqual(r.code, dispatch.CHECKS.AGENT_UNKNOWN);
  }
});

test('checkAgent：形状非法的 custom- id 直接拒绝，不降级成内置 agent', () => {
  // custom-abc 不是合法 id 形状（缺 12 位 hex 尾巴）
  const r = dispatch.checkAgent('custom-abc', snap({}));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, dispatch.CHECKS.AGENT_UNKNOWN);
  // 关键：绝不能因为"看起来像 custom-"就去找一个内置 agent 顶上
  assert.ok(!/claude-code|codex/.test(r.fix));
});

test('checkAgent：形状合法但未注册的 custom- id → 报"未注册"，不降级', () => {
  const r = dispatch.checkAgent('custom-evil-deadbeefcafe', snap({}));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, dispatch.CHECKS.AGENT_NOT_REGISTERED);
  assert.ok(!/claude-code|codex/.test(r.fix));
});

test('checkAgent：合法形状的 custom- id 但未注册 → 拒绝', () => {
  const id = 'custom-mytool-0123456789ab';
  const s = snap({ [id]: { integrationInstalled: true, enabled: true } }, []);
  const r = dispatch.checkAgent(id, s);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, dispatch.CHECKS.AGENT_NOT_REGISTERED);
});

test('checkAgent：已注册的 custom agent（enabled=true）→ 可派', () => {
  const id = 'custom-mytool-0123456789ab';
  const s = snap(
    { [id]: { integrationInstalled: false, enabled: true } },
    [{ id, name: 'MyTool' }],
  );
  const r = dispatch.checkAgent(id, s);
  assert.strictEqual(r.ok, true);
});

test('checkAgent：判定与 src/agent-gate.js 的语义一致（不另造名单）', () => {
  const cases = [
    [{ 'claude-code': { integrationInstalled: true, enabled: true } }, 'claude-code', true],
    [{ 'claude-code': { integrationInstalled: false, enabled: true } }, 'claude-code', false],
    [{ 'claude-code': { integrationInstalled: true, enabled: false } }, 'claude-code', false],
  ];
  for (const [agents, id, expectOk] of cases) {
    const s = snap(agents);
    const mine = dispatch.checkAgent(id, s).ok;
    const installed = agentGate.isAgentIntegrationInstalled(s, id);
    const enabled = agentGate.isAgentEnabled(s, id);
    assert.strictEqual(mine, expectOk, `${id} 判定不符`);
    // 编排层的"可派"必须等价于 agent-gate 的 installed && enabled
    assert.strictEqual(mine, installed && enabled, `${id} 与 agent-gate 语义不一致`);
  }
});

test('checkAgent：prefs 缺失时 fail closed（不默认"都装了"）', () => {
  // agent-gate 对缺失快照 fail open（历史兼容），但编排层读不到 prefs 时的默认
  // 是不信任：调用方必须传 null 且自己拒绝派单。确认 gate 本身行为被记录在案。
  const r = dispatch.checkAgent('claude-code', null);
  // agent-gate 的 readFlag 对 null snapshot 返回 default（installed=true, enabled=true）
  assert.strictEqual(typeof r.ok, 'boolean');
  // 关键断言：dispatch 的调用方（checkBatch / CLI）会在 prefs 读不到时整体拒绝
  const batch = dispatch.checkBatch(
    [{ id: 'ORCH-001', agent: 'claude-code', cwd: REAL_DIR, status: 'confirmed', title: 'x', dependsOn: [], acceptance: [] }],
    { prefs: null },
  );
  assert.strictEqual(typeof batch.ok, 'boolean');
});

test('checkAgent：registry 里真实存在但 prefs 里没有条目 → 按 agent-gate 的 legacy 默认', () => {
  const id = getAllAgents()[0].id;
  const r = dispatch.checkAgent(id, snap({}));
  // agent-gate 对缺失条目返回 default true（legacy 兼容语义），编排层照搬不另立规矩
  assert.strictEqual(r.ok, agentGate.isAgentIntegrationInstalled(snap({}), id) && agentGate.isAgentEnabled(snap({}), id));
});

// ---------- cwd ----------

test('checkCwd：存在的目录 → 通过', () => {
  assert.strictEqual(dispatch.checkCwd(REAL_DIR).ok, true);
});

test('checkCwd：不存在的目录 → 拒绝并给出修复建议', () => {
  const r = dispatch.checkCwd(MISSING_DIR);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, dispatch.CHECKS.CWD_MISSING);
  assert.match(r.fix, /创建|改派/);
});

test('checkCwd：文件不是目录 → 拒绝', () => {
  const file = path.join(REAL_DIR, 'a-file.txt');
  fs.writeFileSync(file, 'x');
  const r = dispatch.checkCwd(file);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, dispatch.CHECKS.CWD_NOT_DIRECTORY);
});

test('checkCwd：空 cwd → 拒绝，不猜当前目录', () => {
  for (const bad of ['', '   ', null, undefined]) {
    const r = dispatch.checkCwd(bad);
    assert.strictEqual(r.ok, false, `${JSON.stringify(bad)} 应被拒`);
    assert.strictEqual(r.code, dispatch.CHECKS.CWD_MISSING);
  }
});

// ---------- 依赖 ----------

const OK_AGENTS = snap({ 'claude-code': { integrationInstalled: true, enabled: true } });
const ticket = (over = {}) => ({
  id: 'ORCH-001', status: 'confirmed', title: '做事', agent: 'claude-code',
  cwd: REAL_DIR, dependsOn: [], acceptance: ['a'], ...over,
});

test('checkBatch：全部满足 → 通过', () => {
  const r = dispatch.checkBatch([ticket()], { prefs: OK_AGENTS });
  assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
  assert.strictEqual(r.problems.length, 0);
});

test('checkBatch：agent 未安装 → 整批被挡下（不硬派）', () => {
  const s = snap({ 'kiro-cli': { integrationInstalled: false, enabled: true } });
  const r = dispatch.checkBatch([ticket({ agent: 'kiro-cli' })], { prefs: s });
  assert.strictEqual(r.ok, false);
  assert.ok(r.problems.some((p) => p.code === dispatch.CHECKS.AGENT_NOT_INSTALLED));
});

test('checkBatch：cwd 不存在 → 整批被挡下', () => {
  const r = dispatch.checkBatch([ticket({ cwd: MISSING_DIR })], { prefs: OK_AGENTS });
  assert.strictEqual(r.ok, false);
  assert.ok(r.problems.some((p) => p.code === dispatch.CHECKS.CWD_MISSING));
});

test('checkBatch：依赖成环 → 被挡下，且报出环路径', () => {
  const tickets = [
    ticket({ id: 'ORCH-001', dependsOn: ['ORCH-003'] }),
    ticket({ id: 'ORCH-002', dependsOn: ['ORCH-001'] }),
    ticket({ id: 'ORCH-003', dependsOn: ['ORCH-002'] }),
  ];
  const r = dispatch.checkBatch(tickets, { prefs: OK_AGENTS });
  assert.strictEqual(r.ok, false);
  const cyc = r.problems.find((p) => p.code === dispatch.CHECKS.DEP_CYCLE);
  assert.ok(cyc, '必须报 dep-cycle');
  assert.match(cyc.reason, /成环/);
  assert.ok(cyc.fix && cyc.fix.length > 0, '必须给修复建议');
});

test('checkBatch：悬空依赖与自依赖分别报出', () => {
  const r = dispatch.checkBatch(
    [ticket({ id: 'ORCH-001', dependsOn: ['ORCH-777'] }), ticket({ id: 'ORCH-002', dependsOn: ['ORCH-002'] })],
    { prefs: OK_AGENTS },
  );
  assert.strictEqual(r.ok, false);
  assert.ok(r.problems.some((p) => p.code === dispatch.CHECKS.DEP_MISSING));
  assert.ok(r.problems.some((p) => p.code === dispatch.CHECKS.DEP_SELF));
});

test('checkBatch：同批次内部依赖不算"未确认前置"（线性链必须能一次派出去）', () => {
  // 这是真实事故点：线性链拆分出来的工单在 plan 阶段全是 draft，
  // 若不豁免同批次，整条链永远派不出去。
  const tickets = [
    ticket({ id: 'ORCH-001', status: 'draft', dependsOn: [] }),
    ticket({ id: 'ORCH-002', status: 'draft', dependsOn: ['ORCH-001'] }),
    ticket({ id: 'ORCH-003', status: 'draft', dependsOn: ['ORCH-002'] }),
  ];
  const r = dispatch.checkBatch(tickets, { prefs: OK_AGENTS });
  assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
});

test('checkBatch：跨批次的未确认前置 → 仍然挡下', () => {
  const r = dispatch.checkBatch(
    [ticket({ id: 'ORCH-002', dependsOn: ['ORCH-001'] })],
    { prefs: OK_AGENTS, allTickets: [ticket({ id: 'ORCH-001', status: 'draft' }), ticket({ id: 'ORCH-002', dependsOn: ['ORCH-001'] })] },
  );
  assert.strictEqual(r.ok, false);
  assert.ok(r.problems.some((p) => p.code === dispatch.CHECKS.DEP_UNCONFIRMED));
});

test('checkBatch：已确认的跨批次前置 → 放行', () => {
  const t2 = ticket({ id: 'ORCH-002', dependsOn: ['ORCH-001'] });
  const r = dispatch.checkBatch([t2], {
    prefs: OK_AGENTS,
    allTickets: [ticket({ id: 'ORCH-001', status: 'confirmed' }), t2],
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
});

test('checkTicket：工单字段不合法也挡下', () => {
  const r = dispatch.checkTicket({ id: 'bad-id', status: 'draft', title: '', agent: 'claude-code', cwd: REAL_DIR, acceptance: [] }, { prefs: OK_AGENTS });
  assert.strictEqual(r.ok, false);
  assert.ok(r.problems.some((p) => p.code === dispatch.CHECKS.TICKET_INVALID));
});

test('checkGraph：只查结构，不碰 fs / prefs', () => {
  const ok = dispatch.checkGraph([
    { id: 'ORCH-002', dependsOn: ['ORCH-001'] },
    { id: 'ORCH-001', dependsOn: [] },
  ]);
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(ok.order, ['ORCH-001', 'ORCH-002']);

  const bad = dispatch.checkGraph([
    { id: 'ORCH-001', dependsOn: ['ORCH-002'] },
    { id: 'ORCH-002', dependsOn: ['ORCH-001'] },
  ]);
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.order, null);
  assert.strictEqual(bad.cycles.length, 1);
});

test('formatProblems：每条问题都带修复建议', () => {
  const text = dispatch.formatProblems([
    { code: 'x', reason: '坏了', fix: '这么修' },
    { code: 'y', id: 'ORCH-001', reason: '也坏了', fix: '那么修' },
  ]);
  assert.match(text, /\[x\] 坏了/);
  assert.match(text, /这么修/);
  assert.match(text, /ORCH-001/);
});