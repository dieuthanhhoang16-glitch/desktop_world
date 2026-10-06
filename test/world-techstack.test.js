// test/world-techstack.test.js
// v0.6.5 定向学习：配置读写 / 关键词收敛 / 提示词注入点 / 结构化 techTips 全链
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { addGoal, removeGoal, loadTechstack, cleanKeywords, validKeyword, MAX_GOALS } = require('../world/techstack/config');
const { extractKeywords, buildProposePrompt } = require('../world/techstack/propose');
const { buildMemory } = require('../world/techstack/memory');
const { buildPrompt, normalizeTechTips } = require('../world/summarizer');
const { writeDayNotes } = require('../world/pipeline');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dwtech-'));
}

const fakeDigest = {
  date: '2026-10-06',
  weekday: '周二',
  generatedAt: '2026-10-06T19:00:00.000Z',
  source: 'claude',
  totals: { sessions: 2, prompts: 8, toolCalls: 42 },
  topTools: [{ name: 'Edit', count: 20 }, { name: 'Bash', count: 15 }],
  projects: [{ name: 'desktop-world', sessions: 2 }],
  hours: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 1, 0, 0, 0, 0, 0, 4, 5, 0, 0, 0, 0],
  agents: [{ agent: 'claude', sessions: 2, prompts: 8, toolCalls: 42 }],
  sessions: [
    { id: 's1', agent: 'claude', project: 'desktop-world', cwd: '/x', title: 'electron 多屏窗口定位修复', status: '进行中', durationMin: 30, toolCalls: 20, tools: {} },
    { id: 's2', agent: 'claude', project: 'co-agent-paper', cwd: '/y', title: 'zustand persist 状态管理', status: '完成', durationMin: 45, toolCalls: 22, tools: {} },
  ],
};

// ---------- 配置读写 ----------

test('config：addGoal 落盘 0600 + 关键词白名单 + 幂等覆盖', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'techstack.json');
  const r = addGoal({ direction: '状态管理', keywords: ['zustand persist 持久化', 'redux 选型', 'bad<script>'] }, file);
  assert.equal(r.updated, false);
  // 坏词被白名单踢掉（< > 不允许），净词保留
  assert.deepEqual(r.goal.keywords, ['zustand persist 持久化', 'redux 选型']);
  assert.equal((fs.statSync(file).mode & 0o777), 0o600);

  // 同方向幂等覆盖而不是堆叠
  const r2 = addGoal({ direction: '状态管理', keywords: ['zustand persist 持久化'] }, file);
  assert.equal(r2.updated, true);
  assert.equal(loadTechstack(file).goals.length, 1);
  assert.deepEqual(loadTechstack(file).goals[0].keywords, ['zustand persist 持久化']);
});

test('config：无有效关键词拒绝落盘 / removeGoal 按 id 或方向 / 读坏回空不崩', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'techstack.json');
  assert.throws(() => addGoal({ direction: '空', keywords: ['<script>'] }, file), /没有有效关键词/);
  addGoal({ direction: '窗口', keywords: ['electron 多屏'] }, file);
  removeGoal('窗口', file);
  assert.equal(loadTechstack(file).goals.length, 0);
  fs.writeFileSync(file, 'not-json{{{');
  assert.deepEqual(loadTechstack(file), { goals: [] });
  assert.equal(validKeyword('C++ 模板元编程'), 'C++ 模板元编程');
  assert.equal(validKeyword('a'.repeat(31)), null);
  assert.equal(validKeyword(''), null);
});

test('config：关键词去重 + 超 8 截断 + 目标上限 MAX_GOALS', () => {
  assert.deepEqual(cleanKeywords(['A', 'a', 'B']), ['A', 'B']); // 大小写不敏感去重
  const many = Array.from({ length: 12 }, (_, i) => `kw${i}`);
  assert.equal(cleanKeywords(many).length, 8);
  const dir = tmpDir();
  const file = path.join(dir, 'techstack.json');
  for (let i = 0; i < MAX_GOALS; i++) addGoal({ direction: `方向${i}`, keywords: [`kw${i}`] }, file);
  assert.throws(() => addGoal({ direction: '超', keywords: ['kw'] }, file), /目标太多/);
});

// ---------- 关键词收敛（确定性层） ----------

test('extractKeywords：方向本身打头，4–8 条，去重封顶，空记忆也能出题', () => {
  const kws = extractKeywords('状态管理', {
    titles: ['zustand persist 持久化修复'],
    projects: [{ name: 'desktop-world' }],
    tools: [{ name: 'node' }],
    tips: [],
    blockers: [],
    watch: [],
  });
  assert.ok(kws.length >= 4 && kws.length <= 8, `条数应在 4–8：${kws.length}`);
  assert.equal(kws[0], '状态管理'); // 方向本身过白名单则第一候选
  assert.ok(kws.some((k) => /zustand|persist/.test(k)), '记忆里的 zustand 要命中');
  const lower = kws.map((k) => k.toLowerCase());
  assert.equal(new Set(lower).size, lower.length, '无重复');

  const empty = extractKeywords('   ', {});
  assert.ok(empty.length >= 4, '空方向/空记忆也补足 4 条保底');
});

test('buildProposePrompt：方向与记忆都进 prompt', () => {
  const p = buildProposePrompt('多屏窗口', {
    watch: [{ name: '桌面世界', category: '工作' }],
    projects: [{ name: 'desktop-world', count: 3 }],
    tools: [{ name: 'Edit', count: 5 }],
    titles: ['electron 多屏定位'],
    tips: ['app-region 拖拽'],
  });
  assert.match(p, /多屏窗口/);
  assert.match(p, /桌面世界/);
  assert.match(p, /electron 多屏定位/);
  assert.match(p, /严格只输出 JSON/);
});

// ---------- 记忆聚合 ----------

test('buildMemory：聚合近 N 天日报的项目/工具/标题/tips，坏文件跳过', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'daily-2026-10-05.json'), JSON.stringify({ meta: { date: '2026-10-05' }, digest: fakeDigest, techTips: ['app-region 拖拽会吃点击'], blockers: ['多屏坐标跑偏'] }, null));
  fs.writeFileSync(path.join(dir, 'daily-2026-10-06.json'), JSON.stringify({ meta: { date: '2026-10-06' }, digest: fakeDigest, techTips: [{ topic: 'electron 多屏', project: 'desktop-world', answer: 'a' }] }, null));
  fs.writeFileSync(path.join(dir, 'daily-broken.json'), 'ignore-me');
  fs.writeFileSync(path.join(dir, 'daily-2026-10-04.json'), '{broken');

  const mem = buildMemory({ outDir: dir, days: 7, watchFile: null });
  assert.equal(mem.reportDays, 2);
  assert.ok(mem.projects.some((p) => p.name === 'desktop-world' && p.count >= 2));
  assert.ok(mem.tools.some((t) => t.name === 'Edit'));
  assert.ok(mem.titles.some((t) => /多屏/.test(t)));
  assert.ok(mem.tips.some((t) => /app-region/.test(t))); // 旧字符串被收
  assert.ok(mem.tips.some((t) => /electron 多屏/.test(t))); // 新结构化对象取 topic
  assert.ok(mem.blockers.some((b) => /多屏/.test(b)));
});

// ---------- 提示词注入点 ----------

test('buildPrompt：无目标时与旧版逐字一致；有目标时注入关键词 + 八股 spec', () => {
  const plain = buildPrompt(fakeDigest);
  assert.match(plain, /techTips：今日技术总结/); // 旧 spec 原文
  assert.doesNotMatch(plain, /学习目标/);
  assert.doesNotMatch(plain, /八股考点|来自哪个项目/);

  const guided = buildPrompt(fakeDigest, { techstack: { goals: [{ direction: '状态管理', keywords: ['zustand persist 持久化'] }] } });
  assert.match(guided, /学习目标/);
  assert.match(guided, /zustand persist 持久化/);
  assert.match(guided, /材料对不上.*静默跳过|静默跳过/);
  assert.match(guided, /"topic".*"project".*"answer".*"hook".*"action"/s, '输出形状必须是结构化考点');
  assert.doesNotMatch(guided, /techTips：今日技术总结——/, '有目标时不再用旧 spec');
});

test('normalizeTechTips：字符串/对象/混合/垃圾全部归一，封顶 4', () => {
  const mixed = normalizeTechTips([
    '普通字符串 tip',
    { topic: 'electron 多屏', project: 'desktop-world', answer: '答案一二。', hook: '钩子', action: '今天做X' },
    { noTopic: true },
    42,
    { topic: '第二条', answer: 'x'.repeat(300) },
    { topic: '第三条' },
    { topic: '第四条' },
    { topic: '第五条会被截掉' },
  ]);
  assert.equal(mixed.length, 4);
  assert.equal(mixed[0], '普通字符串 tip');
  assert.equal(mixed[1].topic, 'electron 多屏');
  assert.equal(mixed[1].project, 'desktop-world');
  assert.ok(mixed[2].answer.length <= 141, 'answer 截断（140 字 + 收尾省略号）');
  assert.equal(normalizeTechTips([]), undefined);
  assert.equal(normalizeTechTips('not-array'), undefined);
});

// ---------- tips md 结构化排版 ----------

test('writeDayNotes：结构化考点进 md 按行段排版，旧字符串兼容', () => {
  const dir = tmpDir();
  const files = writeDayNotes(dir, {
    meta: { date: '2026-10-06' },
    source: 'claude',
    blockers: ['卡点一'],
    techTips: [
      { topic: 'electron 多屏窗口定位', project: 'desktop-world', answer: 'WindowServer 会按 Space 级联摆放。', hook: '位置守卫先于信任配置。', action: '给 open() 加 pos 钳制' },
      '旧字符串 tip 仍在',
    ],
  });
  const tips = files.find((f) => f.includes('tips-'));
  const md = fs.readFileSync(tips, 'utf8');
  assert.match(md, /### 【考点】electron 多屏窗口定位（来自项目：desktop-world）/);
  assert.match(md, /- \*\*标准答案\*\*：WindowServer/);
  assert.match(md, /- \*\*记忆钩子\*\*：位置守卫/);
  assert.match(md, /- \*\*可操作方法\*\*：给 open\(\) 加 pos 钳制/);
  assert.match(md, /- 旧字符串 tip 仍在/);
});
