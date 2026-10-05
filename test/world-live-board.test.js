// test/world-live-board.test.js
// 看板「隐藏这条」存储（world/live/board.js）：稳定键、往返持久化、恢复、键校验
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const board = require('../world/live/board');

function tmp() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'live-board-')), 'dismissed.json');
}

test('隐藏 → 读回 同日在列；另一天不受影响', () => {
  const f = tmp();
  board.hide(f, '2026-10-05', 'claude:abc-123');
  board.hide(f, '2026-10-05', 'codex:roll-9');
  assert.deepStrictEqual(board.list(f, '2026-10-05'), ['claude:abc-123', 'codex:roll-9']);
  assert.deepStrictEqual(board.list(f, '2026-10-06'), []);
});

test('重复隐藏幂等', () => {
  const f = tmp();
  board.hide(f, '2026-10-05', 'claude:abc');
  board.hide(f, '2026-10-05', 'claude:abc');
  assert.deepStrictEqual(board.list(f, '2026-10-05'), ['claude:abc']);
});

test('全部恢复后清单清空', () => {
  const f = tmp();
  board.hide(f, '2026-10-05', 'claude:a');
  board.hide(f, '2026-10-05', 'claude:b');
  board.unhideAll(f, '2026-10-05');
  assert.deepStrictEqual(board.list(f, '2026-10-05'), []);
});

test('非法日期 / 非法会话键拒绝', () => {
  const f = tmp();
  assert.throws(() => board.hide(f, '../../x', 'claude:a'));
  assert.throws(() => board.hide(f, '2026-10-05', 'a/b'));
  assert.throws(() => board.hide(f, '2026-10-05', ''));
});

test('sidOf：有 id 用 agent:id；无 id 退哈希且稳定', () => {
  assert.strictEqual(board.sidOf({ agent: 'claude', id: 'u-1' }), 'claude:u-1');
  const a = board.sidOf({ agent: 'claude', project: '桌面世界', title: '修 bug', end: '2026-10-05T10:00:00Z' });
  const b = board.sidOf({ agent: 'claude', project: '桌面世界', title: '修 bug', end: '2026-10-05T10:00:00Z' });
  assert.strictEqual(a, b);
  assert.ok(/^claude#[0-9a-f]{16}$/.test(a));
});

test('annotateHidden 同时打 _sid 与 hidden', () => {
  const f = tmp();
  board.hide(f, '2026-10-05', 'claude:u-1');
  const sessions = [
    { agent: 'claude', id: 'u-1', title: 'a' },
    { agent: 'claude', id: 'u-2', title: 'b' },
  ];
  board.annotateHidden(sessions, board.list(f, '2026-10-05'));
  assert.strictEqual(sessions[0].hidden, true);
  assert.strictEqual(sessions[0]._sid, 'claude:u-1');
  assert.strictEqual(sessions[1].hidden, false);
  assert.strictEqual(sessions[1]._sid, 'claude:u-2');
});

test('文件权限 0600', () => {
  const f = tmp();
  board.hide(f, '2026-10-05', 'claude:a');
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
});
