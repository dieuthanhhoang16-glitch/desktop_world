// test/world-orch-template.test.js
// daily-card.html 里工单看板 tab（v0.7）的结构性守门。
//
// 这里守的是几条容易在后续改动中被悄悄破坏的契约：
//   ① bake（烘焙 PNG）形态**绝不**出现工单 tab —— 早报 PNG 是 IM 分享底稿，
//      里面多一块编排看板就是排版事故。
//   ② tab 切换不参与 .page 的 flex 流（display:contents），早报两栏排版一个像素不动。
//   ③ 渲染层不做可行性判断、不派单：stage ③ 的硬闸门在 CLI 里。
//   ④ 信封动画只走 CSS transform，不做逐帧 JS。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TEMPLATE = path.join(__dirname, '..', 'world', 'template', 'daily-card.html');
const html = fs.readFileSync(TEMPLATE, 'utf8');

test('bake 形态不含工单 tab：CSS 双保险 + 元素默认 hidden', () => {
  assert.match(html, /body\.bake \.tabbar,\s*\n?\s*body\.bake #panelOrch \{ display: none !important; \}/);
  // tab 栏与编排面板默认 hidden，只有 live + 有工单时才亮
  assert.match(html, /<div class="tabbar" id="tabBar" hidden>/);
  assert.match(html, /<div class="tabpanel orch" id="panelOrch" hidden>/);
});

test('tab 面板用 display:contents，不改变 .page 的 flex 排版', () => {
  assert.match(html, /\.tabpanel \{ display: contents; \}/);
  // 切到编排时 daily 面板整块收起
  assert.match(html, /body\.live\.tab-orch #panelDaily \{ display: none; \}/);
});

test('编排面板定位是绝对定位，不挤进 flex 流', () => {
  assert.match(html, /\.orch \{[\s\S]*?position: absolute;/);
  assert.match(html, /\.tabbar \{[\s\S]*?position: absolute;/);
});

test('信封动画走 CSS transform + keyframes，不做逐帧 JS', () => {
  // 只截 keyframes 块本身（到它的收尾花括号为止），否则会吃到后面规则的 left/top
  const start = html.indexOf('@keyframes envFly');
  const end = html.indexOf('}', html.indexOf('100% {', start)) + 1;
  const keyframes = html.slice(start, end);
  assert.match(keyframes, /transform: translate3d/);
  assert.ok(!/left:|top:/.test(keyframes), '信封动画不该逐帧改 left/top');
  assert.ok(!html.includes('requestAnimationFrame'), '模板不该用 rAF 做逐帧动画');
  // 渲染层只写 CSS 变量
  assert.match(html, /setProperty\('--x0'/);
  assert.match(html, /setProperty\('--lift'/);
});

test('尊重 prefers-reduced-motion：信封不做位移动画', () => {
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
  const idx = html.indexOf('@media (prefers-reduced-motion: reduce)');
  const block = html.slice(idx, idx + 320);
  assert.match(block, /\.orch-env i \{ animation: none;/);
});

test('渲染层不派单、不做可行性判断（硬闸门只在 CLI）', () => {
  // 模板里不应出现任何"派发/确认"的动作调用
  assert.ok(!/__worldOrch\s*\.\s*dispatch/.test(html));
  assert.ok(!/__worldOrch\s*\.\s*confirm/.test(html));
  assert.ok(!/__worldOrch\s*\.\s*plan/.test(html));
  // 面板底部的指引把 CLI 命令写清楚
  assert.match(html, /npm run world:orch -- plan/);
  assert.match(html, /--dispatch ORCH-001 --to/);
});

test('编排数据全部来自主进程注入的 R.orch，渲染层不读文件', () => {
  assert.match(html, /renderOrch\(R\.orch\)/);
  // 渲染层不得直接 require（沿用既有纪律）
  assert.ok(!/require\s*\(/.test(html));
});

test('没有工单时整个 tab 静默（不占界面）', () => {
  const fn = html.slice(html.indexOf('function renderOrch(o) {'), html.indexOf('function renderOrch(o) {') + 400);
  assert.match(fn, /!o \|\| !o\.active/);
  assert.match(fn, /bar\.hidden = true;/);
  // 有工单才亮 tab 栏
  assert.match(fn, /bar\.hidden = false;/);
});

test('依赖成环在界面上明说，不装作正常', () => {
  assert.match(html, /依赖成环，派单会被拦下/);
  assert.match(html, /warn\.hidden = cycles\.length === 0;/);
});

test('工单卡片的自由文本全部走 esc 转义', () => {
  const start = html.indexOf('function renderOrch(o) {');
  const block = html.slice(start, html.indexOf('function layoutEnvelopes(o)'));
  // title / agent / sessionId / acceptance / facts 都要转义
  for (const field of ['esc(t.title)', 'esc(t.agent ||', 'esc(t.id)', 'esc(b.sessionId)', 'esc(f.text)', 'esc(a)']) {
    assert.ok(block.includes(field), `缺转义：${field}`);
  }
  // 验收标准逐条渲染（UI 要能逐条勾）
  assert.match(block, /t\.acceptance\.slice\(0, 4\)/);
});

test('信封坐标按 SVG 实际显示宽度换算（缩放不错位）', () => {
  assert.match(html, /getBoundingClientRect\(\)/);
  assert.match(html, /var k = box\.width \/ VB_W;/);
  // 拿不到宽度就跳过，不硬画
  assert.match(html, /if \(!box\.width\) return;/);
});

test('托盘切 tab 走渲染层同一个 setTab（不另开窗口）', () => {
  assert.match(html, /window\.__worldSetTab = function \(tab\)/);
  // 主进程切进来时也要校验"真有工单"，不能切出一个空看板
  assert.match(html, /lastR\.orch && lastR\.orch\.active/);
});

test('live.js 导出 setActiveTab / setSessionSnapshot（菜单与 App 接线用）', () => {
  const live = fs.readFileSync(path.join(__dirname, '..', 'world', 'live', 'live.js'), 'utf8');
  assert.match(live, /setActiveTab,/);
  assert.match(live, /setSessionSnapshot,/);
  assert.match(live, /function setActiveTab\(tab\)/);
});

test('app-integration 导出编排入口，菜单不闭包缓存状态', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'world', 'app-integration.js'), 'utf8');
  assert.match(app, /orchState,\s*\n\s*showOrchBoard,\s*\n\s*orchPreflight,/);
  assert.match(app, /function orchState\(sessionSnapshot\)/);

  // 菜单每次 build 现读，不缓存布尔
  const menu = fs.readFileSync(path.join(__dirname, '..', 'src', 'menu.js'), 'utf8');
  assert.match(menu, /orchSummary = wi\.orchState\(\)/);
  assert.match(menu, /showOrchBoard\(\)/);
  // 菜单里不得出现"启动进程/拉 agent"这类越界入口
  assert.ok(!/orchState[\s\S]{0,400}spawn/.test(menu));
});