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
//   ⑤ v0.7.1：树区文字按设计稿（dw-office-tree.html，980×620 下 9–13px）以 px 定死、
//      只随 --otscale 等比缩放——不再出现随窗口缩到 2–5px 的裸 vmin 字号。
//   ⑥ v0.7.1：派发选择器不盖黑色全屏蒙版——它是树主面右上角的小浮层，
//      工作面任何时候不被罩住、不被挡点击。
//   ⑦ v0.7.2：树区布局几何（宽/高/行距/圆角/gap）同样是设计稿 px × --otscale——
//      字号 px 化后几何若还是 vmin，字会在容器里互相压叠。
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
  assert.match(app, /orchState,\s*\n\s*showOrchBoard,\s*\n\s*orchPreflight,/);
  assert.match(app, /function orchState\(sessionSnapshot\)/);

  // 菜单每次 build 现读，不缓存布尔
  const menu = fs.readFileSync(path.join(__dirname, '..', 'src', 'menu.js'), 'utf8');
  assert.match(menu, /orchSummary = wi\.orchState\(\)/);
  assert.match(menu, /showOrchBoard\(\)/);
  // 菜单里不得出现"启动进程/拉 agent"这类越界入口
  assert.ok(!/orchState[\s\S]{0,400}spawn/.test(menu));
});

test('派发选择器不盖黑布：全屏蒙版取消，退成右上角非模态小浮层', () => {
  assert.ok(!html.includes('rgba(6, 8, 10, 0.72)'), '黑色透明蒙版 rgba(6,8,10,.72) 不得复活');
  const m = html.match(/\.ot-picker \{([^}]*)\}/);
  assert.ok(m, '缺 .ot-picker 规则');
  const rule = m[1];
  // 锚定右上角，绝不再 fixed + inset:0 罩住整个工作面
  assert.match(rule, /position: absolute/);
  assert.match(rule, /right: calc\(12px/);
  assert.ok(!/position:\s*fixed/.test(rule), 'picker 不得再 fixed 铺满视口');
  assert.ok(!/inset:\s*0/.test(rule), 'picker 不得再 inset:0 铺满');
  // 不得自带 display：否则撰者规则盖过 UA 的 [hidden]{display:none}，浮层永久可见（本次事故根因）
  assert.ok(!/display\s*:/.test(rule), '.ot-picker 自带 display 会让 hidden 失效');
  assert.match(rule, /pointer-events: none/, '浮层壳不得吃点击（工作面永远点得到）');
  // 内容卡片实心 + 投影：浮层自身盖得住下面的树
  assert.match(html, /\.ot-picker \.pk \{[^}]*background: var\(--ot-panel2\)/);
  assert.match(html, /\.ot-picker \.pk \{[^}]*box-shadow/);
});

test('树区文字按设计稿锁 px（只随 --otscale 等比缩放），不再有裸 vmin 字号', () => {
  // orch CSS 区（调度树注释起 → 番茄钟板块止）不得出现 font-size: Xvmin
  const cssStart = html.indexOf('工单调度树（v0.7');
  const cssEnd = html.indexOf('番茄钟（v0.7');
  assert.ok(cssStart > 0 && cssEnd > cssStart, '调度树 CSS 区定位失败');
  const region = html.slice(cssStart, cssEnd);
  assert.ok(!/font-size:\s*[\d.]+vmin/.test(region), '树区出现裸 vmin 字号（会随窗口缩到 2–5px 不可读）');
  // 等比缩放 token：:root 声明默认 1 + JS 按窗口宽写入（980 = 设计稿宽，clamp 防糊防炸）
  assert.match(html, /--otscale: 1;/);
  assert.match(html, /function setOrchScale\(\)/);
  assert.match(html, /setProperty\('--otscale'/);
  assert.match(html, /Math\.max\(0\.82, Math\.min\(1\.6/);
});

test('树区布局几何 px 化：不得残留会压字的 vmin 尺寸（外壳窗口放置除外）', () => {
  const cssStart = html.indexOf('工单调度树（v0.7');
  const cssEnd = html.indexOf('番茄钟（v0.7');
  assert.ok(cssStart > 0 && cssEnd > cssStart, '调度树 CSS 区定位失败');
  const region = html.slice(cssStart, cssEnd);
  // 允许残留的只有面板外壳的窗口放置 inset 与外壳圆角
  const allowed = ['inset: 6.5vmin 5vmin 4.5vmin', 'border-radius: 1vmin'];
  const lines = region
    .split('\n')
    .filter((l) => /(^|[^\w-])\d+(\.\d+)?vmin/.test(l) && !allowed.some((a) => l.includes(a)))
    .map((l) => l.trim());
  assert.deepEqual(lines, [], `树区几何残留 vmin：${lines.join(' | ')}`);
});