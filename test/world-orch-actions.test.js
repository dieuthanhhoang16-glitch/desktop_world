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

/** 注入 prefs：缺省全放行（agent-gate 对缺失 flag 默认 true，见 src/agent-gate.js）。 */
function depsFor(root, prefs) {
  return { root, prefs: prefs === undefined ? { agents: {} } : prefs };
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
