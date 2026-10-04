// world/creature 桌宠皮肤单测：精灵覆盖度 == theme.json 引用、SVG 基本形态。
// 生成的主题必须过 scripts/validate-theme.js（CI 里如需要可用 npm run world:theme 手动验）。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { renderAll } = require('../world/creature/sprites');
const { generate, buildThemeJson } = require('../world/creature/generate');

test('theme.json 引用的每个资产文件都被生成', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-sprout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { written } = generate(dir);
  const theme = JSON.parse(fs.readFileSync(path.join(dir, 'theme.json'), 'utf8'));

  const referenced = new Set();
  const collectRefs = (v) => {
    if (typeof v === 'string' && v.endsWith('.svg')) referenced.add(`assets/${v}`);
    else if (Array.isArray(v)) v.forEach(collectRefs);
    else if (v && typeof v === 'object') Object.values(v).forEach(collectRefs);
  };
  collectRefs(theme.states);
  collectRefs(theme.miniMode.states);
  theme.workingTiers.forEach((x) => referenced.add(`assets/${x.file}`));
  theme.jugglingTiers.forEach((x) => referenced.add(`assets/${x.file}`));
  theme.idleAnimations.forEach((x) => referenced.add(`assets/${x.file}`));

  for (const rel of referenced) {
    assert.ok(written.includes(rel), `缺少被引用的资产：${rel}`);
  }
  // 关键契约：15 主状态 + mini 全部覆盖
  assert.equal(Object.keys(theme.states).length, 15);
  assert.equal(Object.keys(theme.miniMode.states).length, 9);
});

test('SVG 形态：viewBox 16/8、crispEdges、有实际像素内容', () => {
  const files = renderAll();
  const idle = files.get('sprout-idle');
  assert.match(idle, /^<svg /);
  assert.match(idle, /viewBox="0 0 16 16"/);
  assert.match(idle, /crispEdges/);
  assert.ok((idle.match(/<rect/g) || []).length > 10, 'idle 应有身体+芽叶+眼睛等多块像素');
  const mini = files.get('sprout-mini-idle');
  assert.match(mini, /viewBox="0 0 8 8"/);
  // 全 24 文件不能有空壳（至少 5 个像素块）
  for (const [name, svg] of files) {
    assert.ok((svg.match(/<rect/g) || []).length >= 5, `${name} 内容过少`);
  }
});

test('buildThemeJson：schemaVersion 1 与关键能力开关', () => {
  const theme = buildThemeJson();
  assert.equal(theme.schemaVersion, 1);
  assert.equal(theme.eyeTracking.enabled, false);
  assert.equal(theme.miniMode.supported, true);
  assert.equal(theme.sleepSequence.mode, 'full');
  assert.equal(theme.workingTiers.length, 3);
});
