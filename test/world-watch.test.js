// test/world-watch.test.js
// desktop-world · 专案追踪（watch）单测：分类推断 / 最长前缀匹配 / 结算幂等与同日升级 / 14 天柱图。
// 纯 Node 运行：node --test test/world-watch.test.js
'use strict';

// 必须先于 require('../world/watch/*') 设置：WATCH_FILE 在模块加载时就定型
const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'world-watch-test-'));
process.env.WORLD_WATCH_FILE = path.join(TMP, 'watch.json');

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadWatch, saveWatch, resolveWatch, inferCategory } = require('../world/watch/config');
const { annotateSessions, settle, buildView, prepareWatch, loadWatchState, HISTORY_DAYS } = require('../world/watch/state');

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const DAY1 = '2026-10-05';
const DAY2 = '2026-10-06';

function mkFolders(root) {
  return [
    { name: 'learn', path: path.join(root, 'learn'), category: '学习' },
    { name: 'learn-sub', path: path.join(root, 'learn', 'deep'), category: '学习' },
    { name: 'work', path: path.join(root, 'work'), category: '工作' },
  ];
}
function digestOf(date, sessions) {
  return { date, sessions };
}

test('inferCategory：学习线索命中学习，其余归工作', () => {
  assert.equal(inferCategory('thesis-notes'), '学习');
  assert.equal(inferCategory('读论文'), '学习');
  assert.equal(inferCategory('desktop-world'), '工作');
  assert.equal(inferCategory(''), '工作');
});

test('resolveWatch：最长前缀命中，未追踪路径返回 null', () => {
  const root = path.join(TMP, 'root');
  const folders = mkFolders(root);
  const hit = resolveWatch(folders, path.join(root, 'learn', 'deep', 'src'));
  assert.equal(hit.watchName, 'learn-sub'); // 较深的 learn-sub 应盖过 learn
  const hit2 = resolveWatch(folders, path.join(root, 'learn', 'elsewhere'));
  assert.equal(hit2.watchName, 'learn');
  assert.equal(resolveWatch(folders, path.join(root, 'random')), null);
  assert.equal(resolveWatch(folders, ''), null);
});

test('settle：新专案首日建档，天数/连击/历史正确', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 's1-'));
  const root = path.join(TMP, 'root');
  const folders = mkFolders(root);
  const d1 = digestOf(DAY1, [{ cwd: path.join(root, 'learn'), toolCalls: 3 }, { cwd: path.join(root, 'learn'), toolCalls: 1 }]);
  const state = settle(dir, folders, d1, DAY1);
  const e = state.folders.learn;
  assert.equal(e.days, 1);
  assert.equal(e.streak, 1);
  assert.equal(e.totalSessions, 2);
  assert.equal(e.totalToolCalls, 4);
  assert.deepEqual(e.history, [[DAY1, 2]]);
  assert.equal(state.folders.work, undefined); // 没动工的专案不建档
});

test('settle 同日幂等：重复结算只刷新今日计数，不重复累计', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 's2-'));
  const root = path.join(TMP, 'root');
  const folders = mkFolders(root);
  settle(dir, folders, digestOf(DAY1, [{ cwd: path.join(root, 'learn'), toolCalls: 2 }]), DAY1);
  // 同日再来一次，会话变多 → 只更新 history 里今天的数，days 不涨
  const state = settle(dir, folders, digestOf(DAY1, [
    { cwd: path.join(root, 'learn'), toolCalls: 2 },
    { cwd: path.join(root, 'learn'), toolCalls: 2 },
    { cwd: path.join(root, 'learn'), toolCalls: 2 },
  ]), DAY1);
  const e = state.folders.learn;
  assert.equal(e.days, 1);
  assert.equal(e.totalSessions, 1); // +1 只发生在首次结算
  assert.deepEqual(e.history, [[DAY1, 3]]); // 今日计数刷新到最新
});

test('settle 同日升级：早上 0 会话结算后，当天动工仍按新的一天计入', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 's3-'));
  const root = path.join(TMP, 'root');
  const folders = mkFolders(root);
  // 昨天动过 → 有档
  settle(dir, folders, digestOf(DAY1, [{ cwd: path.join(root, 'work'), toolCalls: 1 }]), DAY1);
  // 今天凌晨跑流水线：还没动工 → lastSettled 记为今天，但不进历史
  let state = settle(dir, folders, digestOf(DAY2, []), DAY2);
  assert.equal(state.folders.work.days, 1);
  assert.equal(state.folders.work.lastSettled, DAY2);
  assert.equal(state.folders.work.history.length, 1);
  // 今天下午开工 → 不能丢，按"新的一天"补结
  state = settle(dir, folders, digestOf(DAY2, [{ cwd: path.join(root, 'work'), toolCalls: 5 }]), DAY2);
  const e = state.folders.work;
  assert.equal(e.days, 2);
  assert.equal(e.streak, 2); // 连着两天
  assert.equal(e.totalSessions, 2);
  assert.deepEqual(e.history, [[DAY1, 1], [DAY2, 1]]);
});

test('settle 跨天连击与柱图封顶：连动 16 天 → history 只留 14 条', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 's4-'));
  const root = path.join(TMP, 'root');
  const folders = mkFolders(root);
  // 连续 16 个不同的日期（从 UTC 锚点逐日 +1，避免本地时区截断）
  const dates = [];
  for (let i = 0, t = Date.UTC(2026, 8, 1); i < 16; i++, t += 24 * 3600 * 1000) {
    dates.push(new Date(t).toISOString().slice(0, 10));
  }
  for (const ds of dates) {
    settle(dir, folders, digestOf(ds, [{ cwd: path.join(root, 'learn'), toolCalls: 1 }]), ds);
  }
  const e = loadWatchState(dir).folders.learn;
  assert.equal(e.days, 16);
  assert.equal(e.streak, 16);
  assert.equal(e.history.length, HISTORY_DAYS);
  assert.equal(e.history[0][0], dates[2]); // 最早的两天被挤出去了
  assert.equal(e.history[e.history.length - 1][0], dates[15]);
});

test('prepareWatch 无配置：安静返回 active:false', () => {
  // WORLD_WATCH_FILE 此时不存在 → loadWatch 空配置
  const dir = fs.mkdtempSync(path.join(TMP, 's5-'));
  const view = prepareWatch(dir, digestOf(DAY1, [{ cwd: '/anywhere', toolCalls: 1 }]), DAY1);
  assert.equal(view.active, false);
  assert.deepEqual(view.list, []);
  assert.equal(view.categories, null);
});

test('prepareWatch 全链路：配置 → 标注 → 结算 → 视图含今日与分类汇总', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 's6-'));
  const root = path.join(TMP, 'watchroot');
  fs.mkdirSync(path.join(root, 'learn'), { recursive: true });
  saveWatch({ folders: [{ name: 'learn', path: path.join(root, 'learn'), category: '学习' }] });

  const digest = digestOf(DAY1, [
    { cwd: path.join(root, 'learn'), toolCalls: 7 },
    { cwd: '/untracked/place', toolCalls: 1 },
  ]);
  const view = prepareWatch(dir, digest, DAY1);
  assert.equal(view.active, true);
  assert.equal(view.list.length, 1);
  const w = view.list[0];
  assert.equal(w.name, 'learn');
  assert.equal(w.today, 1);
  assert.equal(w.days, 1);
  assert.equal(w.totalToolCalls, 7);
  assert.deepEqual(w.spark, [1]);
  assert.deepEqual(view.categories, { 学习: 1 });
  // 标注发生在 digest 上（模板卡片的分类角标来自这里）
  assert.equal(digest.sessions[0].category, '学习');
  assert.equal(digest.sessions[0].watchName, 'learn');
  assert.equal(digest.sessions[1].category, undefined);
});

test('annotateSessions / buildView：未命中追踪的会话不进 categories', () => {
  const root = path.join(TMP, 'watchroot');
  const folders = [{ name: 'learn', path: path.join(root, 'learn'), category: '学习' }];
  const digest = digestOf(DAY1, [{ cwd: '/other', toolCalls: 0 }]);
  const tallies = annotateSessions(digest, folders);
  assert.equal(tallies.size, 0);
  const view = buildView(folders, null, digest, DAY1);
  assert.deepEqual(view.categories, {});
  assert.equal(view.list[0].today, 0);
  assert.equal(view.list[0].days, 0); // 无状态文件时归零而不是报错
});
