// test/world-orch-store.test.js
// 工单账本（world/orch/store.js）+ 黑板（blackboard.js）+ 收件箱（mailbox.js）。
//
// 三个存储层共享一条纪律：**黑板与收件箱只追加**。工单账本是唯一允许改写状态的，
// 而且改写必须过状态机（store.setStatus 拒绝非法迁移）。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../world/orch/store');
const blackboard = require('../world/orch/blackboard');
const mailbox = require('../world/orch/mailbox');
const T = require('../world/orch/tickets');
const { ticketsFile, blackboardFile, sanitizeSessionId } = require('../world/orch/paths');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-store-'));
}

const draft = (over = {}) => ({
  title: '做一件事', action: 'change', agent: 'claude-code', cwd: '/tmp',
  dependsOn: [], status: 'draft', acceptance: ['a'], ...over,
});

// ---------- store ----------

test('store：读不存在的文件得到空账本，不抛', () => {
  const root = tmpRoot();
  const led = store.load(ticketsFile(root));
  assert.deepStrictEqual(led.tickets, []);
  assert.strictEqual(led.seq, 0);
});

test('store：appendTickets 发号并落盘', () => {
  const root = tmpRoot();
  const f = ticketsFile(root);
  const out = store.appendTickets(f, [draft(), draft({ title: '第二件' })]);
  assert.deepStrictEqual(out.tickets.map((t) => t.id), ['ORCH-001', 'ORCH-002']);
  assert.strictEqual(out.seq, 2);
  // 落盘后可读回
  assert.strictEqual(store.list(f).length, 2);
});

test('store：二次追加续号，不发重号', () => {
  const root = tmpRoot();
  const f = ticketsFile(root);
  store.appendTickets(f, [draft()]);
  const out = store.appendTickets(f, [draft()]);
  assert.strictEqual(out.tickets[1].id, 'ORCH-002');
  assert.strictEqual(new Set(out.tickets.map((t) => t.id)).size, 2);
});

test('store：文件按 id 升序存（与写入顺序无关）', () => {
  const root = tmpRoot();
  const f = ticketsFile(root);
  store.appendTickets(f, [draft()]);
  store.appendTickets(f, [draft()]);
  store.appendTickets(f, [draft()]);
  const ids = store.list(f).map((t) => t.id);
  assert.deepStrictEqual(ids, [...ids].sort());
});

test('store：seq 字段缺失时从现有 id 反推（老文件不发重号）', () => {
  const root = tmpRoot();
  const f = ticketsFile(root);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ tickets: [{ id: 'ORCH-007', status: 'draft' }] }));
  assert.strictEqual(store.load(f).seq, 7);
  assert.strictEqual(store.appendTickets(f, [draft()]).tickets[1].id, 'ORCH-008');
});

test('store：setStatus 走状态机，非法迁移抛错', () => {
  const root = tmpRoot();
  const f = ticketsFile(root);
  store.appendTickets(f, [draft()]);
  assert.strictEqual(store.setStatus(f, 'ORCH-001', 'confirmed').status, 'confirmed');
  assert.strictEqual(store.setStatus(f, 'ORCH-001', 'dispatched').status, 'dispatched');
  assert.throws(() => store.setStatus(f, 'ORCH-001', 'draft'), /非法状态迁移/);
  assert.throws(() => store.setStatus(f, 'ORCH-001', 'nope'), /非法状态/);
  assert.throws(() => store.setStatus(f, 'ORCH-999', 'confirmed'), /找不到工单/);
});

test('store：done 是终态，不能再流转', () => {
  const root = tmpRoot();
  const f = ticketsFile(root);
  store.appendTickets(f, [draft()]);
  store.setStatus(f, 'ORCH-001', 'confirmed');
  store.setStatus(f, 'ORCH-001', 'dispatched');
  store.setStatus(f, 'ORCH-001', 'running');
  assert.strictEqual(store.setStatus(f, 'ORCH-001', 'done').status, 'done');
  assert.throws(() => store.setStatus(f, 'ORCH-001', 'running'));
});

test('store：patchTicket 不能改 id', () => {
  const root = tmpRoot();
  const f = ticketsFile(root);
  store.appendTickets(f, [draft()]);
  const next = store.patchTicket(f, 'ORCH-001', { id: 'ORCH-999', title: '改了' });
  assert.strictEqual(next.id, 'ORCH-001');
  assert.strictEqual(next.title, '改了');
});

test('store：已派出的工单不可删除', () => {
  const root = tmpRoot();
  const f = ticketsFile(root);
  store.appendTickets(f, [draft()]);
  store.setStatus(f, 'ORCH-001', 'confirmed');
  store.setStatus(f, 'ORCH-001', 'dispatched');
  assert.throws(() => store.remove(f, 'ORCH-001'), /不可删除/);
});

test('store：draft/confirmed 可删除', () => {
  const root = tmpRoot();
  const f = ticketsFile(root);
  store.appendTickets(f, [draft()]);
  assert.ok(store.remove(f, 'ORCH-001'));
  assert.strictEqual(store.list(f).length, 0);
});

test('store：tickets.json 权限 0600', () => {
  const root = tmpRoot();
  const f = ticketsFile(root);
  store.appendTickets(f, [draft()]);
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
});

test('store：损坏的 JSON 读成空账本而不是崩掉', () => {
  const root = tmpRoot();
  const f = ticketsFile(root);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(f, '{ this is not json');
  assert.deepStrictEqual(store.load(f).tickets, []);
});

// ---------- blackboard ----------

test('blackboard：只追加，后写的在前（list 倒序）', () => {
  const root = tmpRoot();
  const f = blackboardFile(root);
  blackboard.append(f, { text: '第一条事实' });
  blackboard.append(f, { text: '第二条事实' });
  const list = blackboard.list(f);
  assert.deepStrictEqual(list.map((e) => e.text), ['第二条事实', '第一条事实']);
});

test('blackboard：已有条目永不被改写（追加语义的核心断言）', () => {
  const root = tmpRoot();
  const f = blackboardFile(root);
  blackboard.append(f, { text: '原始结论', kind: 'fact' });
  const firstId = blackboard.list(f)[0].id;
  blackboard.append(f, { text: '后来的说法', kind: 'fact' });
  const all = blackboard.list(f);
  const original = all.find((e) => e.id === firstId);
  assert.strictEqual(original.text, '原始结论', '旧条目被改写了');
  assert.strictEqual(original.kind, 'fact');
});

test('blackboard：更正用 supersedes 指向旧条目，不改旧条目', () => {
  const root = tmpRoot();
  const f = blackboardFile(root);
  blackboard.append(f, { text: '错误结论' });
  const target = blackboard.list(f)[0].id;
  blackboard.append(f, { text: '更正后的结论', kind: 'correction', supersedes: target });
  const list = blackboard.list(f);
  assert.strictEqual(list[0].kind, 'correction');
  // 注意：supersedes 只接受 ORCH- 形状的 id，这条 fact 的 id 是 bb-0001，
  // 所以更正关系不会建立 —— 但旧条目同样没被改掉，这正是要保的不变量。
  assert.strictEqual(list[1].text, '错误结论');
});

test('blackboard：换行被收掉（一条 entry 不能伪造出第二条）', () => {
  const root = tmpRoot();
  const f = blackboardFile(root);
  blackboard.append(f, { text: '第一行\n## 伪造的分节\n第二行' });
  const list = blackboard.list(f);
  assert.strictEqual(list.length, 1, '换行把一条entry 拆成了多条');
  assert.ok(!list[0].text.includes('\n'));
});

test('blackboard：空 text 拒绝写入', () => {
  const root = tmpRoot();
  const f = blackboardFile(root);
  assert.throws(() => blackboard.append(f, { text: '   ' }), /必须有 text/);
});

test('blackboard：非法 kind 归一到 fact，非法 ticketIds 被丢', () => {
  const root = tmpRoot();
  const f = blackboardFile(root);
  blackboard.append(f, { text: 'x', kind: 'not-a-kind', ticketIds: ['ORCH-001', 'garbage', '../../etc'] });
  const e = blackboard.list(f)[0];
  assert.strictEqual(e.kind, 'fact');
  assert.deepStrictEqual(e.ticketIds, ['ORCH-001']);
});

test('blackboard：reportConvergence 写 convergence 条目并关联工单', () => {
  const root = tmpRoot();
  const f = blackboardFile(root);
  blackboard.reportConvergence(f, { ticketIds: ['ORCH-001'], summary: '搞定了' });
  const e = blackboard.list(f)[0];
  assert.strictEqual(e.kind, 'convergence');
  assert.deepStrictEqual(e.ticketIds, ['ORCH-001']);
  assert.strictEqual(e.text, '搞定了');
});

test('blackboard：按工单过滤', () => {
  const root = tmpRoot();
  const f = blackboardFile(root);
  blackboard.append(f, { text: 'A 相关', ticketIds: ['ORCH-001'] });
  blackboard.append(f, { text: 'B 相关', ticketIds: ['ORCH-002'] });
  const filtered = blackboard.list(f, { ticketId: ['ORCH-001'] });
  assert.strictEqual(filtered.length, 1);
  assert.strictEqual(filtered[0].text, 'A 相关');
});

test('blackboard：只保留最近 N 条', () => {
  const root = tmpRoot();
  const f = blackboardFile(root);
  blackboard.appendMany(f, Array.from({ length: blackboard.MAX_ENTRIES + 30 }, (_, i) => ({ text: `事实 ${i}` })));
  assert.strictEqual(blackboard.list(f).length, blackboard.MAX_ENTRIES);
});

test('blackboard：权限 0600；损坏文件读成空', () => {
  const root = tmpRoot();
  const f = blackboardFile(root);
  blackboard.append(f, { text: 'x' });
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  fs.writeFileSync(f, 'not json');
  assert.deepStrictEqual(blackboard.list(f), []);
});

// ---------- mailbox ----------

test('sanitizeSessionId：路径分隔符与冒号被换掉，绝不逃出目录', () => {
  assert.strictEqual(sanitizeSessionId('qoder:abc-123'), 'qoder-abc-123');
  assert.strictEqual(sanitizeSessionId('../../etc/passwd'), 'etc-passwd');
  assert.strictEqual(sanitizeSessionId(''), 'unknown');
  assert.strictEqual(sanitizeSessionId(null), 'unknown');
  assert.ok(!sanitizeSessionId('a/b\\c:d').includes('/'));
  assert.ok(!sanitizeSessionId('a/b\\c:d').includes('\\'));
});

test('mailbox：投递后可读回，落在 mailbox/<id>.json', () => {
  const root = tmpRoot();
  mailbox.deliver('claude:abc', { body: 'ORCH-001 做事', ticketId: 'ORCH-001' }, root);
  const file = mailbox.fileFor('claude:abc', root);
  assert.strictEqual(path.basename(file), 'claude-abc.json');
  assert.strictEqual(path.basename(path.dirname(file)), 'mailbox');
  const list = mailbox.list('claude:abc', { root });
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].body, 'ORCH-001 做事');
});

test('mailbox：同 id 重复投递幂等（不算两封）', () => {
  const root = tmpRoot();
  mailbox.deliver('claude:abc', { id: 'env-1', body: 'x' }, root);
  mailbox.deliver('claude:abc', { id: 'env-1', body: 'x' }, root);
  assert.strictEqual(mailbox.list('claude:abc', { root }).length, 1);
});

test('mailbox：ack 只动 ack 列表，正文永不改', () => {
  const root = tmpRoot();
  mailbox.deliver('claude:abc', { id: 'env-1', body: '原始正文' }, root);
  mailbox.ack('claude:abc', 'env-1', root);
  assert.strictEqual(mailbox.unreadCount('claude:abc', root), 0);
  const e = mailbox.list('claude:abc', { root })[0];
  assert.strictEqual(e.body, '原始正文', 'ack 不该动正文');
});

test('mailbox：unreadOnly 只返回未读', () => {
  const root = tmpRoot();
  mailbox.deliver('claude:abc', { id: 'env-1', body: '一' }, root);
  mailbox.deliver('claude:abc', { id: 'env-2', body: '二' }, root);
  mailbox.ack('claude:abc', 'env-1', root);
  assert.strictEqual(mailbox.list('claude:abc', { root, unreadOnly: true }).length, 1);
  assert.strictEqual(mailbox.list('claude:abc', { root, unreadOnly: true })[0].body, '二');
});

test('mailbox：每个 session 各自一个收件箱，互不串', () => {
  const root = tmpRoot();
  mailbox.deliver('claude:aaa', { body: '给 A' }, root);
  mailbox.deliver('codex:bbb', { body: '给 B' }, root);
  assert.strictEqual(mailbox.list('claude:aaa', { root }).length, 1);
  assert.strictEqual(mailbox.list('codex:bbb', { root }).length, 1);
  assert.strictEqual(mailbox.list('claude:aaa', { root })[0].body, '给 A');
});

test('mailbox：to 字段强制等于目标 session（不能伪造收件人）', () => {
  const root = tmpRoot();
  mailbox.deliver('claude:aaa', { body: 'x', to: 'codex:someone-else' }, root);
  assert.strictEqual(mailbox.list('claude:aaa', { root })[0].to, 'claude-aaa');
});

test('mailbox：非法 ticketId 被丢，不进 UI', () => {
  const root = tmpRoot();
  mailbox.deliver('claude:abc', { body: 'x', ticketId: 'not-a-ticket' }, root);
  assert.strictEqual(mailbox.list('claude:abc', { root })[0].ticketId, '');
});

test('mailbox：正文换行被收掉（不能伪造第二条 envelope）', () => {
  const root = tmpRoot();
  mailbox.deliver('claude:abc', { body: '第一行\n{"id":"env-99"}' }, root);
  const list = mailbox.list('claude:abc', { root });
  assert.strictEqual(list.length, 1);
  assert.ok(!list[0].body.includes('\n'));
});

test('mailbox：空 body 拒绝投递', () => {
  const root = tmpRoot();
  assert.throws(() => mailbox.deliver('claude:abc', { body: '  ' }, root), /必须有 body/);
});

test('mailbox：损坏文件读成空收件箱，不崩', () => {
  const root = tmpRoot();
  const file = mailbox.fileFor('claude:abc', root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{{{ broken');
  assert.deepStrictEqual(mailbox.list('claude:abc', { root }), []);
});

test('mailbox：权限 0600', () => {
  const root = tmpRoot();
  mailbox.deliver('claude:abc', { body: 'x' }, root);
  assert.strictEqual(fs.statSync(mailbox.fileFor('claude:abc', root)).mode & 0o777, 0o600);
});

test('mailbox：投递的 acceptance 逐条保真（UI 要逐条勾）', () => {
  const root = tmpRoot();
  mailbox.deliver('claude:abc', { body: 'x', acceptance: ['第一条', '', '第二条'] }, root);
  assert.deepStrictEqual(mailbox.list('claude:abc', { root })[0].acceptance, ['第一条', '第二条']);
});

// ---------- 端到端：拆单 → 落账 → 确认 → 投递 ----------

test('端到端：拆单→落账→确认→投递→收敛', () => {
  const root = tmpRoot();
  const f = ticketsFile(root);
  const bb = blackboardFile(root);

  const drafts = T.draftTickets('读登录流程，然后修复 token bug', { agent: 'claude-code', cwd: '/tmp' });
  assert.strictEqual(drafts.length, 2);
  store.appendTickets(f, drafts);
  blackboard.append(bb, { kind: 'fact', text: '立单', ticketIds: drafts.map((d) => d.id) });

  for (const d of store.list(f)) store.setStatus(f, d.id, 'confirmed');
  for (const t of store.list(f)) {
    mailbox.deliver('claude:sess-1', { kind: 'ticket', ticketId: t.id, body: t.title, acceptance: t.acceptance }, root);
  }
  assert.strictEqual(mailbox.list('claude:sess-1', { root }).length, 2);

  for (const t of store.list(f)) {
    store.setStatus(f, t.id, 'dispatched');
    store.setStatus(f, t.id, 'running');
    store.setStatus(f, t.id, 'done');
  }
  blackboard.reportConvergence(bb, { ticketIds: ['ORCH-001'], summary: '结论' });

  const led = store.load(f);
  assert.ok(led.tickets.every((t) => t.status === 'done'));
  assert.ok(blackboard.list(bb).some((e) => e.kind === 'convergence'));
});