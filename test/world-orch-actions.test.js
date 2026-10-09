// test/world-orch-actions.test.js
// M2 动作层（world/orch/actions.js）守门：
// ① 与 CLI 同一套闸门/写序（confirm/dispatch/converge 语义对得上 cli.js）；
// ② 永不抛错，错误协议永远是 {ok:false, problems:[{code,reason,fix}]} 形状；
// ③ M2 出口在动作层闭环：建草案 → 确认 → 派发（信封落信箱） → 收敛（结论上黑板）。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const actions = require('../world/orch/actions');
const store = require('../world/orch/store');
const T = require('../world/orch/tickets');
const mailbox = require('../world/orch/mailbox');
const blackboard = require('../world/orch/blackboard');
const { ticketsFile, blackboardFile } = require('../world/orch/paths');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dw-orch-actions-'));
}

/**
 * 注入 prefs：缺省全放行（agent-gate 对缺失 flag 默认 true，见 src/agent-gate.js）。
 * jevClient 显式置 null：本文件的用例**绝不允许**因误触判断层而出网（红线同
 * world-orch-llm.test.js）；问判断层的行为由 P2 专测注入假 client 覆盖。
 */
function depsFor(root, prefs) {
  return { root, prefs: prefs === undefined ? { agents: {} } : prefs, jevClient: null };
}

/** 在临时账本里立一张 draft（走真实的 draftTickets → appendTickets 路径）。 */
function seedDraft(root, over = {}) {
  const drafts = T.draftTickets(over.goal || '把桌面整理做完', {
    agent: over.agent === undefined ? 'claude-code' : over.agent,
    cwd: over.cwd || os.tmpdir(),
  });
  const draft = { ...drafts[0], ...over };
  delete draft.goal;
  const ledger = store.appendTickets(ticketsFile(root), [draft]);
  return ledger.tickets[0];
}

function expectProblems(res, codes) {
  assert.equal(res.ok, false, `应失败：${JSON.stringify(res)}`);
  assert.ok(Array.isArray(res.problems) && res.problems.length, 'problems 必须是非空数组');
  for (const p of res.problems) {
    assert.ok(p.code && p.reason && p.fix, `problem 缺字段：${JSON.stringify(p)}`);
  }
  if (codes) assert.deepEqual(res.problems.map((p) => p.code), codes);
}

// ---------- 入参校验 ----------

test('未知动作 / 非法 id / 找不到工单：结构化拒绝，不抛', () => {
  const root = tmpRoot();
  expectProblems(actions.transition('ORCH-001', 'explode', {}, depsFor(root)), ['action-unknown']);
  expectProblems(actions.transition('xxx', 'confirm', {}, depsFor(root)), ['ticket-id-invalid']);
  expectProblems(actions.transition('ORCH-042', 'confirm', {}, depsFor(root)), ['ticket-not-found']);
});

// ---------- confirm ----------

test('confirm：闸门过了才翻 confirmed；重复确认 = 状态机同态 no-op（幂等重试安全）', () => {
  const root = tmpRoot();
  const d = seedDraft(root);
  const r1 = actions.transition(d.id, 'confirm', {}, depsFor(root));
  assert.equal(r1.ok, true);
  assert.equal(r1.ticket.status, 'confirmed');

  // canTransition 的 from===to 是同态放行（设计好的幂等）：重复点「确认」不出事、账本不变
  const r2 = actions.transition(d.id, 'confirm', {}, depsFor(root));
  assert.equal(r2.ok, true);
  assert.equal(store.get(ticketsFile(root), d.id).status, 'confirmed');
});

test('confirm：未注册 agent 被三闸门拒（agent-unknown），账本不动', () => {
  const root = tmpRoot();
  const d = seedDraft(root, { agent: 'not-a-real-agent' });
  const r = actions.transition(d.id, 'confirm', {}, depsFor(root));
  expectProblems(r, ['agent-unknown']);
  assert.equal(store.get(ticketsFile(root), d.id).status, 'draft');
});

test('confirm / dispatch：prefs 读不到时显式拒绝（默认不信任）', () => {
  const root = tmpRoot();
  const d = seedDraft(root);
  expectProblems(actions.transition(d.id, 'confirm', {}, { root, prefs: null }), ['prefs-unavailable']);
});

// ---------- dispatch ----------

test('dispatch：未确认拒、缺会话拒、闸门不过拒', () => {
  const root = tmpRoot();
  const d = seedDraft(root);
  expectProblems(actions.transition(d.id, 'dispatch', { sessionId: 's1' }, depsFor(root)), ['dispatch-not-confirmed']);

  assert.equal(actions.transition(d.id, 'confirm', {}, depsFor(root)).ok, true);
  expectProblems(actions.transition(d.id, 'dispatch', {}, depsFor(root)), ['session-required']);
});

test('dispatch happy：账本翻 dispatched + 信封落信箱 + 派发事实上黑板', () => {
  const root = tmpRoot();
  const d = seedDraft(root);
  actions.transition(d.id, 'confirm', {}, depsFor(root));
  const r = actions.transition(d.id, 'dispatch', { sessionId: 'claude-code:abc' }, depsFor(root));
  assert.equal(r.ok, true);
  assert.equal(r.ticket.status, 'dispatched');

  const box = mailbox.list('claude-code:abc', { root });
  assert.equal(box.length, 1, '信封必须落到目标会话收件箱');
  assert.equal(box[0].ticketId, d.id);
  assert.equal(box[0].kind, 'ticket');
  assert.deepEqual(box[0].acceptance, d.acceptance);

  const facts = blackboard.list(blackboardFile(root));
  assert.ok(facts.some((f) => f.kind === 'fact' && f.text.includes(`派发 ${d.id}`)), '黑板缺派发事实');
});

// ---------- converge ----------

test('converge：dispatched 补跳 running 再到 done；验收勾选与结论都落账', () => {
  const root = tmpRoot();
  const d = seedDraft(root);
  actions.transition(d.id, 'confirm', {}, depsFor(root));
  actions.transition(d.id, 'dispatch', { sessionId: 's1' }, depsFor(root));

  const done = d.acceptance.map(() => true);
  const r = actions.transition(d.id, 'converge', { summary: '做完了，回归全绿', acceptanceDone: done }, depsFor(root));
  assert.equal(r.ok, true);
  assert.equal(r.ticket.status, 'done');
  assert.deepEqual(r.ticket.acceptanceDone, done);

  const conv = blackboard.listByKind(blackboardFile(root), 'convergence');
  assert.equal(conv.length, 1);
  assert.equal(conv[0].text, '做完了，回归全绿');
  assert.deepEqual(conv[0].ticketIds, [d.id]);
});

test('converge：空 summary 回退默认文案；非 running/dispatched 拒', () => {
  const root = tmpRoot();
  const d = seedDraft(root);
  expectProblems(actions.transition(d.id, 'converge', {}, depsFor(root)), ['converge-not-running']);

  actions.transition(d.id, 'confirm', {}, depsFor(root));
  actions.transition(d.id, 'dispatch', { sessionId: 's1' }, depsFor(root));
  const r = actions.transition(d.id, 'converge', {}, depsFor(root));
  assert.equal(r.ok, true);
  const conv = blackboard.listByKind(blackboardFile(root), 'convergence');
  assert.match(conv[0].text, new RegExp(`^${d.id} 收敛：`));
});

// ---------- fail / block / redraft / reconfirm ----------

test('fail/block 带 reason 上黑板（user 声音进 session log）；redraft/reconfirm 纯状态机', () => {
  const root = tmpRoot();
  const d = seedDraft(root);
  // draft 哪也去不了 fail：状态机拒
  expectProblems(actions.transition(d.id, 'fail', {}, depsFor(root)), ['transition-invalid']);

  actions.transition(d.id, 'confirm', {}, depsFor(root));
  actions.transition(d.id, 'dispatch', { sessionId: 's1' }, depsFor(root));
  const rf = actions.transition(d.id, 'fail', { reason: '构建挂了' }, depsFor(root));
  assert.equal(rf.ok, true);
  assert.equal(rf.ticket.status, 'failed');
  const blockers = blackboard.listByKind(blackboardFile(root), 'blocker');
  assert.ok(blockers.some((b) => b.text.includes('标记失败') && b.text.includes('构建挂了')));

  const rc = actions.transition(d.id, 'reconfirm', {}, depsFor(root));
  assert.equal(rc.ok, true);
  assert.equal(rc.ticket.status, 'confirmed');

  const rb = actions.transition(d.id, 'block', {}, depsFor(root));
  assert.equal(rb.ticket.status, 'blocked');
  const rr = actions.transition(d.id, 'redraft', {}, depsFor(root));
  assert.equal(rr.ticket.status, 'draft');
});

// ---------- patch ----------

test('patch：白名单/消毒/状态门 —— 结构字段只在派发前可改', () => {
  const root = tmpRoot();
  const d = seedDraft(root);

  // 空 patch 幂等成功；非对象拒
  assert.equal(actions.patch(d.id, {}, depsFor(root)).ok, true);
  expectProblems(actions.patch(d.id, ['title'], depsFor(root)), ['patch-value-invalid']);
  // 未知字段（status 走 transition，不走 patch）
  expectProblems(actions.patch(d.id, { status: 'done' }, depsFor(root)), ['patch-field-unknown']);
  // 消毒：title 去空白、dependsOn 去空白滤非法、acceptanceDone 强制布尔
  //（dependsOn 用悬空但格式合法的 ORCH-999：格式测试，不制造自依赖）
  const r = actions.patch(d.id, { title: '  新标题  ', dependsOn: [' ORCH-999 ', 'junk'], acceptanceDone: [1, 0, 'x'] }, depsFor(root));
  assert.equal(r.ok, true);
  assert.equal(r.ticket.title, '新标题');
  assert.deepEqual(r.ticket.dependsOn, ['ORCH-999']);
  assert.deepEqual(r.ticket.acceptanceDone, [true, false, true]);
  expectProblems(actions.patch(d.id, { dependsOn: [d.id] }, depsFor(root)), ['patch-value-invalid']);
  // 依赖清空再进派发流（不然 dispatch 的整批闸门会报 dep-missing）
  assert.equal(actions.patch(d.id, { dependsOn: [] }, depsFor(root)).ok, true);

  // 派出后：结构字段禁改，acceptanceDone 仍可勾
  actions.transition(d.id, 'confirm', {}, depsFor(root));
  actions.transition(d.id, 'dispatch', { sessionId: 's1' }, depsFor(root));
  expectProblems(actions.patch(d.id, { agent: 'codex' }, depsFor(root)), ['patch-forbidden']);
  assert.equal(actions.patch(d.id, { acceptanceDone: [true] }, depsFor(root)).ok, true);

  // done 之后：什么都不让改了
  actions.transition(d.id, 'converge', {}, depsFor(root));
  expectProblems(actions.patch(d.id, { acceptanceDone: [false] }, depsFor(root)), ['patch-forbidden']);
});

// ---------- remove ----------

test('remove：draft/confirmed 可删，已派出的拒', () => {
  const root = tmpRoot();
  const d = seedDraft(root);
  assert.equal(actions.removeTicket(d.id, depsFor(root)).ok, true);
  assert.equal(store.get(ticketsFile(root), d.id), null);

  const d2 = seedDraft(root, { goal: '第二张' });
  actions.transition(d2.id, 'confirm', {}, depsFor(root));
  actions.transition(d2.id, 'dispatch', { sessionId: 's1' }, depsFor(root));
  expectProblems(actions.removeTicket(d2.id, depsFor(root)), ['remove-refused']);
  assert.ok(store.get(ticketsFile(root), d2.id), '被拒的删除不得动账本');
});

// ---------- sessionsFor（派发选择器数据源） ----------

test('sessionsFor：同 agent+同 cwd 置顶，headless 沉底，空快照给空数组', () => {
  const ticket = { agent: 'claude-code', cwd: '/repo' };
  const snapshot = {
    sessions: [
      { id: 's-other', agentId: 'codex', cwd: '/repo', state: 'working' },
      { id: 's-match', agentId: 'claude-code', cwd: '/repo', state: 'idle' },
      { id: 's-headless', agentId: 'claude-code', cwd: '/repo', state: 'working', headless: true },
      { id: 's-sameagent', agentId: 'claude-code', cwd: '/elsewhere', state: 'working' },
    ],
  };
  const list = actions.sessionsFor(ticket, snapshot);
  // headless 全局沉底（与 matchSession「非 headless 用尽才兜底」同口径）
  assert.deepEqual(list.map((s) => s.id), ['s-match', 's-sameagent', 's-other', 's-headless']);
  assert.equal(list[0].sameAgent, true);
  assert.equal(list[0].sameCwd, true);
  assert.deepEqual(actions.sessionsFor(ticket, null), []);
});

// ---------- M2 出口（动作层闭环） ----------

test('M2 出口路径：draft → confirm → dispatch → converge 全程 ok', () => {
  const root = tmpRoot();
  const d = seedDraft(root);
  const steps = [
    actions.transition(d.id, 'confirm', {}, depsFor(root)),
    actions.transition(d.id, 'dispatch', { sessionId: 'claude-code:a41f' }, depsFor(root)),
    actions.transition(d.id, 'converge', { summary: 'ok', acceptanceDone: [true, true] }, depsFor(root)),
  ];
  assert.ok(steps.every((s) => s.ok), `链路断在：${JSON.stringify(steps.find((s) => !s.ok))}`);
  assert.equal(store.get(ticketsFile(root), d.id).status, 'done');
});

// ---------- M3 开单回路（plan → 勾选 → commitPlan） ----------

test('M3 plan：确定性拆单 + 预发号过闸门，账本零写入；默认不问判断层', async () => {
  const root = tmpRoot();
  const res = await actions.plan('先把 A 模块重构做完，然后补 B 的集成测试，最后更新 README',
    { agent: 'claude-code', cwd: os.tmpdir() }, depsFor(root));
  assert.equal(res.ok, true, JSON.stringify(res.problems));
  assert.ok(res.drafts.length >= 2, '应拆出多张草案');
  assert.ok(res.drafts.every((d) => /^ORCH-\d{3,}$/.test(d.id)), '草案带预发号 id');
  assert.equal(store.list(ticketsFile(root)).length, 0, 'plan 不得落账');
  // 本地置信度足够 → split 内部不问判断层
  assert.equal(res.jev.source, 'local');
  assert.equal(res.jev.modelTried, false);
});

test('M3 plan 入参校验：空目标 / 拆不出子句 → 结构化拒绝，不抛', async () => {
  const root = tmpRoot();
  expectProblems(await actions.plan('   ', {}, depsFor(root)), ['plan-goal-empty']);
  expectProblems(await actions.plan('。。。', { agent: 'claude-code', cwd: os.tmpdir() }, depsFor(root)), ['plan-no-clauses']);
});

test('M3 commitPlan：勾选子集落账即确认，被弃依赖重挂最近保留前置，黑板留痕', async () => {
  const root = tmpRoot();
  const planRes = await actions.plan('先写数据 schema，然后接 API 层，最后补端到端测试',
    { agent: 'claude-code', cwd: os.tmpdir() }, depsFor(root));
  assert.equal(planRes.ok, true);
  const picked = planRes.drafts.slice(0, planRes.drafts.length - 1); // 弃最后一张
  const res = actions.commitPlan(picked, { root, prefs: { agents: {} }, goal: '先写 schema' });
  assert.equal(res.ok, true, JSON.stringify(res.problems));

  const ledger = store.load(ticketsFile(root));
  assert.equal(ledger.tickets.length, picked.length);
  assert.ok(ledger.tickets.every((t) => t.status === 'confirmed'), '勾选即人确认');
  const ids = new Set(ledger.tickets.map((t) => t.id));
  assert.ok(ledger.tickets.every((t) => t.dependsOn.every((d) => ids.has(d))),
    `依赖不得指向未落账 id：${JSON.stringify(ledger.tickets.map((t) => [t.id, t.dependsOn]))}`);
  const bb = blackboard.list(blackboardFile(root));
  assert.ok(bb.some((e) => e.kind === 'fact' && /立单/.test(e.text)), '黑板应有立单 fact');
});

test('M3 commitPlan：空勾选 / 预发号占用 / 非法 id → 结构化拒绝，账本不动', async () => {
  const root = tmpRoot();
  expectProblems(actions.commitPlan([], depsFor(root)), ['plan-commit-empty']);

  const planRes = await actions.plan('先整理目录结构，然后写迁移脚本', { agent: 'claude-code', cwd: os.tmpdir() }, depsFor(root));
  assert.equal(planRes.ok, true);
  const first = actions.commitPlan(planRes.drafts, { root, prefs: { agents: {} } });
  assert.equal(first.ok, true);
  // 同 id 再投 → 占号拒绝；账本不因部分失败写一半
  expectProblems(actions.commitPlan([planRes.drafts[0]], { root, prefs: { agents: {} } }), ['plan-id-conflict']);
  expectProblems(actions.commitPlan([{ ...planRes.drafts[0], id: '手写-1' }], { root, prefs: { agents: {} } }), ['plan-id-invalid']);
  assert.equal(store.list(ticketsFile(root)).length, planRes.drafts.length, '拒绝后账本保持第一次立单结果');
});

// ---------- P2 判断层接入（JEV） ----------

test('P2 强发问：判断层给概率与路由建议，但工单措辞一个字都不进模型产出', async () => {
  const root = tmpRoot();
  const seen = [];
  const fakeClient = {
    decide: async ({ state, questions }) => {
      seen.push({ state, questions });
      return { ok: true, probs: { splitable: 0.87, needs_research: 0.1, risky: 0.05, agent_claude_code: 0.72 }, usage: {} };
    },
  };
  const goal = '先把 A 模块重构做完，然后补 B 的集成测试，最后更新 README';
  const res = await actions.plan(goal,
    { agent: 'claude-code', cwd: os.tmpdir(), jev: true },
    { root, prefs: { agents: {} }, jevClient: fakeClient, agents: [{ id: 'claude-code', name: 'Claude Code' }] });
  assert.equal(res.ok, true, JSON.stringify(res.problems));
  assert.equal(res.jev.source, 'jev', '被问过就是 jev');
  assert.equal(res.jev.modelTried, true);
  assert.ok(res.jev.judgment && Math.abs(res.jev.judgment.splitable - 0.87) < 1e-9);
  assert.equal(res.jev.judgment.suggestedAgent.id, 'claude-code');
  assert.match(res.jev.reason, /JEV/);

  // 问题表：splitable/needs_research/risky + 每个候选一个 agent_ 路由问句
  assert.equal(seen.length, 1, '一次调用问完（省时省钱）');
  assert.ok('splitable' in seen[0].questions && 'risky' in seen[0].questions && 'needs_research' in seen[0].questions);
  assert.ok('agent_claude_code' in seen[0].questions);
  // 铁律：工单措辞仍本地确定性规则（与纯本地 plan 逐字节一致）
  const localOnly = await actions.plan(goal, { agent: 'claude-code', cwd: os.tmpdir() }, depsFor(root));
  assert.deepEqual(res.drafts, localOnly.drafts);
});

test('P2 判断层挂了静默降级：client 抛错/坏结果 → 开单照常，绝不拖垮', async () => {
  const root = tmpRoot();
  const goal = '先把 A 做完，然后补 B 的测试';
  const blowing = { decide: async () => { throw new Error('boom'); } };
  const r1 = await actions.plan(goal, { agent: 'claude-code', cwd: os.tmpdir(), jev: true }, { root, prefs: { agents: {} }, jevClient: blowing });
  assert.equal(r1.ok, true);
  assert.equal(r1.jev.source, 'local');
  assert.equal(r1.jev.modelTried, true, '问了没问成 ≠ 没问');

  const garbage = { decide: async () => ({ ok: false, reason: 'breaker-open' }) };
  const r2 = await actions.plan(goal, { agent: 'claude-code', cwd: os.tmpdir(), jev: true }, { root, prefs: { agents: {} }, jevClient: garbage });
  assert.equal(r2.ok, true);
  assert.equal(r2.jev.source, 'local');
  assert.equal(r2.jev.modelTried, true);
});
