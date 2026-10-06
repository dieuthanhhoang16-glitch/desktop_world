// test/world-live-pomodoro.test.js
// 番茄钟状态机（world/live/pomodoro.js）：节奏推进、暂停/恢复/跳过、
// 跨幂等 tick、任务记账、持久化 0600、重启恢复截止时刻。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pomo = require('../world/live/pomodoro');

const D = '2026-10-06';
const T0 = Date.parse('2026-10-06T09:00:00');

function tmp() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'live-pomo-')), 'pomodoro.json');
}

test('开始 → focus 25 分钟；满钟自动进 break 5 分钟；休息完回 idle', () => {
  const f = tmp();
  pomo.start(f, D, { text: '续写论文' }, T0);
  let v = pomo.view(pomo.load(f), D, T0 + 10 * 60 * 1000);
  assert.strictEqual(v.phase, 'focus');
  assert.strictEqual(v.remainMs, 15 * 60 * 1000);
  assert.strictEqual(v.task.title, '续写论文');

  v = pomo.tick(f, D, T0 + 25 * 60 * 1000); // 正好到期
  assert.strictEqual(v.phase, 'break');
  assert.strictEqual(v.cycles, 1);

  v = pomo.tick(f, D, T0 + 30 * 60 * 1000 + 1); // 休息也结束了
  assert.strictEqual(v.phase, 'idle');
  assert.strictEqual(v.cycles, 1);
  assert.strictEqual(v.focusMs, 25 * 60 * 1000);
  assert.strictEqual(v.tasks['text:续写论文'], 25 * 60 * 1000);
});

test('暂停/恢复：剩余时间以主进程时刻为准，恢复后续上', () => {
  const f = tmp();
  pomo.start(f, D, null, T0);
  let v = pomo.pause(f, D, T0 + 5 * 60 * 1000);
  assert.strictEqual(v.phase, 'focus-paused');
  assert.strictEqual(v.remainMs, 20 * 60 * 1000);
  // 暂停期间.tick 不推进（即使过了原来的 endAt）
  v = pomo.tick(f, D, T0 + 60 * 60 * 1000);
  assert.strictEqual(v.phase, 'focus-paused');
  assert.strictEqual(v.remainMs, 20 * 60 * 1000);
  // 恢复后从"新 now + 剩余"重算截止时刻
  pomo.resume(f, D, T0 + 60 * 60 * 1000);
  v = pomo.view(pomo.load(f), D, T0 + 60 * 60 * 1000 + 20 * 60 * 1000);
  assert.strictEqual(v.phase, 'focus');
  assert.strictEqual(v.remainMs, 0);
});

test('跳过专注：时长记账但不算满钟番茄，进休息', () => {
  const f = tmp();
  pomo.start(f, D, { text: '审稿' }, T0);
  const v = pomo.skip(f, D, T0 + 12 * 60 * 1000);
  assert.strictEqual(v.phase, 'break');
  assert.strictEqual(v.cycles, 0); // 没坐满不算一个番茄
  assert.strictEqual(v.focusMs, 12 * 60 * 1000);
  assert.strictEqual(v.tasks['text:审稿'], 12 * 60 * 1000);
});

test('幂等 tick：一小时后一次性结算 focus+break 两阶段', () => {
  const f = tmp();
  pomo.start(f, D, { text: '长跑任务' }, T0);
  const v = pomo.tick(f, D, T0 + 45 * 60 * 1000); // 25 专注 + 5 休息早过了
  assert.strictEqual(v.phase, 'idle');
  assert.strictEqual(v.cycles, 1);
  assert.strictEqual(v.focusMs, 25 * 60 * 1000);
});

test('关联会话卡任务：sid 记账键与自由文本分开', () => {
  const f = tmp();
  pomo.start(f, D, { sid: 'claude:abc-1', title: '续写论文（卡）' }, T0);
  pomo.tick(f, D, T0 + 25 * 60 * 1000);
  pomo.tick(f, D, T0 + 31 * 60 * 1000);
  pomo.start(f, D, { text: '杂事' }, T0 + 31 * 60 * 1000);
  const v = pomo.view(pomo.load(f), D, T0 + 31 * 60 * 1000 + 24 * 60 * 1000); // 还差 1 分钟满钟
  assert.strictEqual(v.phase, 'focus');
  assert.strictEqual(v.cycles, 1);
  assert.strictEqual(v.tasks['sid:claude:abc-1'], 25 * 60 * 1000);
  assert.strictEqual(v.tasks['text:杂事'], undefined); // 这轮还在 focus，没结算
});

test('已有进行中段时 start 等价于挤掉重开（旧段按已花时长记账）', () => {
  const f = tmp();
  pomo.start(f, D, { text: '甲' }, T0);
  const v = pomo.start(f, D, { text: '乙' }, T0 + 10 * 60 * 1000);
  assert.strictEqual(v.task.title, '乙');
  assert.strictEqual(v.focusMs, 10 * 60 * 1000);
  assert.strictEqual(v.tasks['text:甲'], 10 * 60 * 1000);
});

test('另一天不受影响；文件 0600；非法日期拒绝', () => {
  const f = tmp();
  pomo.start(f, D, { text: '干活' }, T0);
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  assert.strictEqual(pomo.view(pomo.load(f), '2026-10-07', T0).cycles, 0);
  assert.throws(() => pomo.start(f, '06/10/2026', null, T0));
});

test('重启恢复：状态在文件里，重载后剩余时间按墙钟算准', () => {
  const f = tmp();
  pomo.start(f, D, { text: '论文' }, T0);
  // 模拟 App 重启：全量重新 load，此刻已是 20 分钟后
  const v = pomo.view(pomo.load(f), D, T0 + 20 * 60 * 1000);
  assert.strictEqual(v.phase, 'focus');
  assert.strictEqual(v.remainMs, 5 * 60 * 1000);
  assert.strictEqual(v.task.title, '论文');
});

test('任务类型映射动作：读资料→thinking，整理→sweeping，搬运→carrying，会议→attention，默认 working', () => {
  assert.strictEqual(pomo.taskActionFor({ title: '读论文 & 梳理 review 结论' }), 'thinking');
  assert.strictEqual(pomo.taskActionFor({ title: '整理下载文件夹/归档杂项' }), 'sweeping');
  assert.strictEqual(pomo.taskActionFor({ title: '同步照片到移动硬盘' }), 'carrying');
  assert.strictEqual(pomo.taskActionFor({ title: '和周会对齐排期' }), 'attention');
  assert.strictEqual(pomo.taskActionFor({ title: '写番茄钟联动代码' }), 'working');
  assert.strictEqual(pomo.taskActionFor({ title: '' }), 'working');
  assert.strictEqual(pomo.taskActionFor(null), 'working');
});

test('任务类型映射只产出主题状态机真实键（girl/calico 均有的通用语义）', () => {
  // 兜底是 working；映射结果必须能在 girl 主题 states 里直接命中（live.js 把它当 pet override）
  const girl = require('../themes/girl/theme.json');
  for (const title of ['整理', '搬运', '读', '开会', '写代码', '']) {
    const action = pomo.taskActionFor({ title });
    assert.ok(girl.states[action], `${title} → ${action} 不在 girl 主题 states 里`);
  }
});
