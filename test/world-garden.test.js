// world/garden 生长世界单测：状态结算（幂等/连击）、阶段计算、场景渲染确定性。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { applyDailyReport, describe, loadState, saveState, initialState, dailyAward } = require('../world/garden/state');
const { renderWorldSvg } = require('../world/garden/scene');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-garden-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const digest = (sessions, toolCalls) => ({ totals: { sessions, prompts: sessions * 3, toolCalls } });

test('每日结算：出勤打底 + 会话/工具加成', () => {
  assert.equal(dailyAward(digest(0, 0)), 30);
  assert.equal(dailyAward(digest(2, 40)), 30 + 20 + 10);
  // 封顶：100 个会话也只按 20 计
  assert.equal(dailyAward(digest(100, 99999)), 30 + 200 + 100);
});

test('结算幂等：同一天重复烘焙不重复加分', (t) => {
  const dir = tmpDir(t);
  const d = digest(2, 50);
  const first = applyDailyReport(dir, d, '2026-10-05');
  assert.equal(first.settled, true);
  assert.equal(first.state.daysActive, 1);
  assert.equal(first.state.streak, 1);
  const xp1 = first.state.xp;

  const again = applyDailyReport(dir, digest(99, 999), '2026-10-05');
  assert.equal(again.settled, false);
  assert.equal(again.state.xp, xp1);
  assert.equal(again.state.daysActive, 1);
});

test('连续耕种：次日 streak+1，断签重置为 1', (t) => {
  const dir = tmpDir(t);
  applyDailyReport(dir, digest(1, 10), '2026-10-01');
  let r = applyDailyReport(dir, digest(1, 10), '2026-10-02');
  assert.equal(r.state.streak, 2);
  assert.equal(r.state.daysActive, 2);
  r = applyDailyReport(dir, digest(1, 10), '2026-10-05'); // 断了两天
  assert.equal(r.state.streak, 1);
  assert.equal(r.state.bestStreak, 2);
  assert.equal(r.state.totalSessions, 3);
});

test('阶段推进：xp 阈值决定 level 与下一目标', (t) => {
  const dir = tmpDir(t);
  const st = initialState('2026-10-01');
  st.xp = 350;
  saveState(dir, st);
  const d = describe(loadState(dir));
  assert.equal(d.level, 2);
  assert.equal(d.stageKey, 'sapling');
  assert.equal(d.stageName, '树苗');
  assert.equal(d.next.name, '开花树');
  assert.equal(d.next.remain, 600 - 350);
});

test('场景渲染：确定性 + 按阶段出现标志物', () => {
  const seed = { level: 0, stageKey: 'seed', stageName: '种子', daysActive: 1, streak: 1, xp: 30 };
  const a = renderWorldSvg(seed);
  const b = renderWorldSvg(seed);
  assert.equal(a, b, '同一世界状态必须渲染同一张图');
  assert.match(a, /<svg/);
  assert.match(a, /世界 Lv0 种子/);

  const wonder = renderWorldSvg({ level: 5, stageKey: 'wonder', stageName: '空中花园', daysActive: 30, streak: 9, xp: 1600 });
  assert.match(wonder, /世界 Lv5 空中花园/);
  assert.match(wonder, /#99e9f2/, '空中花园阶段应有瀑布');
  assert.notEqual(wonder, a, '不同阶段渲染必须不同');

  // 耕种天数多的场景植被数量应更多（SVG 里 rect 总数显著增加）
  const bare = renderWorldSvg({ level: 3, stageKey: 'bloom', stageName: '开花树', daysActive: 1, streak: 1, xp: 700 });
  const lush = renderWorldSvg({ level: 3, stageKey: 'bloom', stageName: '开花树', daysActive: 30, streak: 30, xp: 700 });
  const count = (s) => (s.match(/<rect/g) || []).length;
  assert.ok(count(lush) > count(bare), '耕作越久的矢量图元素越多');
});
