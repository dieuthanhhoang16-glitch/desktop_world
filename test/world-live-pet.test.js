// test/world-live-pet.test.js
// 桌宠动画挑选（world/live/pet.js）：数据驱动分级 + 深夜睡眠 + 引擎覆盖。
// 用仓库里真实的 themes/girl 主题做锚点（它就是用户当前在用的桌宠）。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const pet = require('../world/live/pet');

const girlDir = path.join(pet.THEMES_ROOT, 'girl');
const girl = JSON.parse(fs.readFileSync(path.join(girlDir, 'theme.json'), 'utf8'));

test('resolveThemeDir 找到 girl 主题', () => {
  delete process.env.WORLD_PET_THEME;
  const dir = pet.resolveThemeDir();
  assert.ok(dir);
  assert.strictEqual(path.basename(dir), 'girl');
});

test('无活动会话 + 白天 → idle', () => {
  const pick = pet.resolvePetAsset(girl, { activeCount: 0, totalSessions: 2, hour: 14 });
  assert.strictEqual(pick.why, 'idle');
  assert.ok(pick.file);
});

test('深夜（23 点后 / 7 点前）且无活动 → sleeping', () => {
  for (const hour of [23, 0, 3, 6]) {
    const pick = pet.resolvePetAsset(girl, { activeCount: 0, totalSessions: 0, hour });
    assert.strictEqual(pick.why, 'night');
    assert.ok(/sleep/i.test(pick.file));
  }
});

test('进行中 1 会话 → 工作分级 1（敲键盘）', () => {
  const pick = pet.resolvePetAsset(girl, { activeCount: 1, totalSessions: 1, hour: 10 });
  assert.strictEqual(pick.why, 'working:1');
  assert.strictEqual(pick.file, 'girl-working-typing.apng');
});

test('进行中且今日 3 会话 → 工作分级 3（搬砖）', () => {
  const pick = pet.resolvePetAsset(girl, { activeCount: 1, totalSessions: 3, hour: 10 });
  assert.strictEqual(pick.why, 'working:3');
  assert.strictEqual(pick.file, 'girl-working-building.apng');
});

test('深夜但有进行中会话 → 工作优先于睡觉', () => {
  const pick = pet.resolvePetAsset(girl, { activeCount: 1, totalSessions: 1, hour: 2 });
  assert.ok(pick.why.startsWith('working'));
});

test('引擎状态覆盖优先于一切推导', () => {
  const pick = pet.resolvePetAsset(girl, { activeCount: 1, totalSessions: 5, hour: 10, override: 'sleeping' });
  assert.ok(pick.why.startsWith('override'));
  assert.ok(/sleep/i.test(pick.file));
});

test('buildPetEntry 产出模板可用的相对路径，且文件真实存在', () => {
  const entry = pet.buildPetEntry(girlDir, { activeCount: 0, totalSessions: 0, hour: 14 });
  assert.ok(entry);
  assert.ok(entry.src.startsWith('../../themes/girl/assets/'));
  const abs = path.resolve(__dirname, '..', 'world', 'template', entry.src);
  assert.ok(fs.existsSync(abs), '相对路径应能解析到仓库内真实文件：' + entry.src);
});

test('坏主题目录不炸', () => {
  const entry = pet.buildPetEntry('/nonexistent/path', { activeCount: 1, totalSessions: 1, hour: 10 });
  assert.strictEqual(entry, null);
});
