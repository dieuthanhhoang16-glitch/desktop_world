// test/world-orch-template.test.js
// daily-card.html 里工单调度树 tab（v0.7，PRD v2.0 树形重写后）的结构性守门。
//
// 这里守的是几条容易在后续改动中被悄悄破坏的契约：
//   ① bake（烘焙 PNG）形态**绝不**出现工单 tab —— 早报 PNG 是 IM 分享底稿，
//      里面多一块编排看板就是排版事故。
//   ② tab 切换不参与 .page 的 flex 流（display:contents），早报两栏排版一个像素不动。
//   ③ 渲染层不做可行性判断、不碰账本文件：确认/派发/收敛全部经 __worldOrch 桥
//      到主进程 actions 层（硬闸门在那里），渲染层只发意图。
//   ④ 依赖连线是静态贝塞尔，不做逐帧 JS 动画。
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

test('依赖连线是静态贝塞尔：渲染时量一次坐标，不做逐帧 JS 动画', () => {
  // 连线一次性画成贝塞尔 path（M x y C …）
  assert.match(html, /setAttribute\('d', 'M '/);
  // 唯一的 rAF 用途是"DOM 落位后量一次坐标"（单发测量），不是逐帧动画循环
  assert.match(html, /requestAnimationFrame\(function \(\) \{ layoutTreeWires\(t\); \}\)/);
  assert.ok(!/requestAnimationFrame\(\s*function frame/.test(html), '不得有逐帧动画帧函数');
  // 旧看板飞行信封时代的 CSS 变量驱动已清场
  assert.ok(!html.includes('@keyframes envFly'), '旧信封动画残留');
  assert.ok(!html.includes("setProperty('--x0'"), '旧信封 CSS 变量残留');
});

test('尊重 prefers-reduced-motion：调度树无位移动画，定位闪烁退成常驻金框', () => {
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
  const idx = html.indexOf('@media (prefers-reduced-motion: reduce)');
  const block = html.slice(idx, idx + 320);
  assert.match(block, /\.tcard\.flash \{ animation: none;/);
});

test('渲染层不做可行性判断、不碰账本：闸门与写盘全在主进程 actions 层', () => {
  // 渲染层只发意图：confirm/dispatch/converge 全部经 __worldOrch.transition，
  // 不得自带闸门/账本/路径逻辑（出现这些串 = 把主进程的职责偷渡进了渲染层）
  for (const leak of ['checkBatch', 'checkTicket', 'agent-gate', 'tickets.json', 'blackboard.json', 'ticketsFile']) {
    assert.ok(!html.includes(leak), `渲染层出现主进程职责：${leak}`);
  }
  // 开单回路 M3 才进树：模板不得有 plan 动作
  assert.ok(!/__worldOrch\s*\.\s*plan/.test(html));
  // 立单指引仍指向 CLI（M3 前唯一开单口）
  assert.match(html, /npm run world:orch -- plan/);
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

test('依赖成环在守门员栏与状态行明说，不装作正常', () => {
  // 守门员栏有依赖环计数（>0 时红标）
  assert.ok(html.includes('<span>依赖环</span>'), '守门员栏缺依赖环计数');
  assert.match(html, /k\.cycles \? ' class="bad"' : ''/);
  // 状态行 cycles 同样红标
  assert.match(html, /s\.cycles \? 'bad' : ''/);
});

test('工单卡与 M2 新文本全部走 esc 转义', () => {
  const start = html.indexOf('function renderOrch(o) {');
  const block = html.slice(start, html.indexOf('function render(R) {'));
  // 工单卡 / 收敛带 / problems 墙 / session log / 派发选择器 / keeper advice 的自由文本都要转义
  for (const field of ['esc(c.title)', 'esc(c.id)', 'esc(a)', 'esc(p.reason ||', 'esc(r.text)', 'esc(s.id)', 'esc(k.lastAdvice ||']) {
    assert.ok(block.includes(field), `缺转义：${field}`);
  }
  // 验收标准逐条渲染成可勾选的 checkbox（M2 收敛带）
  assert.match(block, /acc\.forEach/);
});

test('依赖连线坐标按容器实际像素量（滚动补偿，拿不到宽度不硬画）', () => {
  assert.match(html, /getBoundingClientRect\(\)/);
  assert.match(html, /host\.scrollLeft/);
  assert.match(html, /host\.scrollTop/);
  // panel 还 hidden 时拿不到宽度：跳过等切 tab 重量，不硬画错位线
  assert.match(html, /if \(!hb\.width\) return;/);
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
  assert.match(app, /orchState,\s*\n\s*showOrchBoard,\s*\n\s*orchPreflight,\s*\n\s*orchZoom,/);
  // v0.7.1 工作面字号：主进程持久化倍率 + 定向重推，渲染层只读 orch.zoom 写 --ot-z
  assert.match(app, /function orchZoom\(delta\)/);
  const live = fs.readFileSync(path.join(__dirname, '..', 'world', 'live', 'live.js'), 'utf8');
  assert.match(live, /function orchZoom\(\)/);
  assert.match(live, /orch\.zoom = orchZoom\(\)/);
  assert.match(live, /setOrchZoom,/);
  assert.match(app, /function orchState\(sessionSnapshot\)/);

  // 菜单每次 build 现读，不缓存布尔
  const menu = fs.readFileSync(path.join(__dirname, '..', 'src', 'menu.js'), 'utf8');
  assert.match(menu, /orchSummary = wi\.orchState\(\)/);
  assert.match(menu, /showOrchBoard\(\)/);
  // 菜单里不得出现"启动进程/拉 agent"这类越界入口
  assert.ok(!/orchState[\s\S]{0,400}spawn/.test(menu));
});