// world/live/pos.js 的单元测试：窗口坐标可见性守卫。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { rectVisibleOn, MIN_VISIBLE } = require('../world/live/pos');

// 本机实测同款布局：主屏(笔记本) 0..1512 × 0..982；4K 外接屏在左边 -1920..0 × 0..1080
const DISPLAYS = [
  { x: 0, y: 0, width: 1512, height: 982 },
  { x: -1920, y: 0, width: 1920, height: 1080 },
];

test('主屏上的正常位置可见', () => {
  assert.ok(rectVisibleOn({ x: 280, y: 207, w: 980, h: 620 }, DISPLAYS));
});

test('左侧外接屏上的位置可见（负坐标合法）', () => {
  assert.ok(rectVisibleOn({ x: -1382, y: 141, w: 980, h: 620 }, DISPLAYS));
});

test('外接屏断连后，留在负坐标区的窗口判不可见 → 回退默认位', () => {
  assert.strictEqual(rectVisibleOn({ x: -1382, y: 141, w: 980, h: 620 }, [DISPLAYS[0]]), false);
});

test('只露出一条边（小于最小可见面积）判不可见', () => {
  assert.strictEqual(rectVisibleOn({ x: 1512 - 10, y: 0, w: 980, h: 620 }, DISPLAYS), false);
  assert.ok(rectVisibleOn({ x: 1512 - MIN_VISIBLE, y: 0, w: 980, h: 620 }, DISPLAYS));
});

test('完全飞到所有屏之外判不可见', () => {
  assert.strictEqual(rectVisibleOn({ x: 99999, y: 99999, w: 980, h: 620 }, DISPLAYS), false);
  assert.strictEqual(rectVisibleOn({ x: -5000, y: -5000, w: 980, h: 620 }, DISPLAYS), false);
});

test('未指定坐标 → false（调用方走默认位）；拿不到屏信息 → 不妄杀', () => {
  assert.strictEqual(rectVisibleOn({ x: null, y: null, w: 980, h: 620 }, DISPLAYS), false);
  assert.ok(rectVisibleOn({ x: 99999, y: 99999, w: 980, h: 620 }, []));
});
