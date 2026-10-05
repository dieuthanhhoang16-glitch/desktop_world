// test/world-live-notes.test.js
// 随手记存储（world/live/notes.js）：键校验、往返持久化、空删、权限位
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const notes = require('../world/live/notes');

function tmp() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'live-notes-')), 'notes.json');
}

test('缺失文件读为空', () => {
  assert.strictEqual(notes.get(tmp(), '2026-10-05'), '');
});

test('保存 → 读回 往返一致', () => {
  const f = tmp();
  notes.save(f, '2026-10-05', '第一行\n第二行');
  assert.strictEqual(notes.get(f, '2026-10-05'), '第一行\n第二行');
  // 另一天互不影响
  assert.strictEqual(notes.get(f, '2026-10-06'), '');
});

test('日期键必须 YYYY-MM-DD', () => {
  const f = tmp();
  assert.throws(() => notes.save(f, '../../etc/passwd', 'x'));
  assert.throws(() => notes.save(f, '今天', 'x'));
  assert.throws(() => notes.save(f, '', 'x'));
});

test('空白内容即删除该日条目', () => {
  const f = tmp();
  notes.save(f, '2026-10-05', '有内容');
  assert.strictEqual(notes.get(f, '2026-10-05'), '有内容');
  notes.save(f, '2026-10-05', '   \n ');
  assert.strictEqual(notes.get(f, '2026-10-05'), '');
  assert.deepStrictEqual(Object.keys(notes.load(f)), []);
});

test('文件权限 0600', () => {
  const f = tmp();
  notes.save(f, '2026-10-05', 'secret');
  const mode = fs.statSync(f).mode & 0o777;
  assert.strictEqual(mode, 0o600);
});

test('超长截断（防误贴大文件）', () => {
  const f = tmp();
  const big = 'x'.repeat(notes.MAX_LEN + 500);
  notes.save(f, '2026-10-05', big);
  assert.strictEqual(notes.get(f, '2026-10-05').length, notes.MAX_LEN);
});
