// test/world-live-template.test.js
// daily-card.html 内联脚本的结构性守门：renderPomo（IIFE 顶层函数）依赖的工具函数
// 必须在顶层可达。v0.6.3.2 前的真实事故：esc 只声明在 render() 内部，点「▶ 开始」
// 展开任务选择器时 renderPomo 抛 ReferenceError: esc is not defined，选择器不弹。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TEMPLATE = path.join(__dirname, '..', 'world', 'template', 'daily-card.html');

test('esc 声明在 render 之外，且先于 render 出现（renderPomo 可达）', () => {
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  const renderStart = html.indexOf('function render(R) {');
  const renderEnd = html.indexOf('} // render 到此为止');
  assert.ok(renderStart > 0, '找不到 render 起点');
  assert.ok(renderEnd > renderStart, '找不到 render 终点标注');

  const escDecl = html.indexOf('function esc(');
  assert.ok(escDecl > 0, '模板里找不到 esc 声明');
  assert.ok(escDecl < renderStart, 'esc 必须声明在 render 之前（顶层作用域），否则 renderPomo 拿不到');

  // 同一段名字可以在 render 内部再被 var/参数遮蔽吗——目前不允许第二次 function esc 声明
  const escInRender = html.indexOf('function esc(', renderStart);
  assert.ok(escInRender === -1 || escInRender > renderEnd, 'render 内部不得再声明 esc');
});

test('renderPomo 是 IIFE 顶层函数（不被 render 包住），picker 分支引用 esc', () => {
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  const renderStart = html.indexOf('function render(R) {');
  const renderEnd = html.indexOf('} // render 到此为止');

  const pomoDecl = html.indexOf('function renderPomo(v) {');
  assert.ok(pomoDecl > 0, '找不到 renderPomo 声明');
  assert.ok(pomoDecl < renderStart || pomoDecl > renderEnd, 'renderPomo 必须在 render 外');

  // 选择器构造分支必须真实存在转义调用（数据进 DOM 不裸拼）
  const pickBranch = html.indexOf('data-pick-sid');
  assert.ok(pickBranch > 0, '找不到任务选择器分支');
  assert.ok(
    html.slice(Math.max(0, pickBranch - 400), pickBranch + 400).includes('esc(s.project)'),
    '选择器选项必须转义输出',
  );
});

// ---------- v0.6.6 三态生命周期：pill / 控制组的结构守门 ----------
// 既有契约复用同一模板，烘焙 PNG（body.bake）形态绝不能亮出新 UI。

test('pill 与控制组默认 hidden，JS 全走 preload 桥（渲染层不直接 require）', () => {
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  assert.match(html, /<div class="pill" id="lifePill" hidden>/, 'pill 必须默认 hidden');
  assert.match(html, /<div class="lifecycle" id="lifeCtl" hidden>/, '控制组必须默认 hidden');
  assert.ok(html.includes('window.__worldSetMode'), '缺主进程形态注入入口 __worldSetMode');
  assert.ok(html.includes('__worldLive.hide()') && html.includes('__worldLive.show()'), '胶囊/控制组必须走 __worldLive 桥');
  assert.ok(!/require\s*\(/.test(html), '模板渲染层不得直接 require（只走 preload 桥）');
});

test('bake 形态绝不出现 pill 与控制组：CSS 双保险 + 元素默认 hidden', () => {
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  assert.match(html, /body\.bake \.pill,\s*body\.bake \.lifecycle\s*\{\s*display:\s*none\s*!important;\s*\}/, '缺 bake 隐藏双保险');
  assert.match(html, /body\.live\.is-hidden \.pill\s*\{\s*display:\s*flex;\s*\}/, '缺 is-hidden 下 pill 展示规则');
  assert.match(html, /body\.live\.is-hidden \.page,/, '缺 is-hidden 下隐藏主体的规则');
});

test('胶囊摘要取现有 live 字段（世界等级 / 番茄数 / 考点数）；幽灵模式已取消，无锁钮与穿透文案', () => {
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  assert.ok(html.includes("stageIcon || '🌱'"), 'pill 世界等级摘要缺失');
  assert.ok(html.includes("parts.push('🍅' + pillData.cycles)"), 'pill 番茄摘要缺失');
  assert.ok(!html.includes('data-life="lock"'), '控制组不应再有穿透锁按钮');
  assert.ok(!html.includes('点不到'), '不应再有穿透锁定相关文案');
});

// ---------- 删单（ORCH-CONSOLE-R2 需求1）后的守门 ----------
// 「单」的工单调度树 tab 已整棵移除，编排唯一入口是「编」（orchestra 台）。
// 这里守：bake 形态 tab 栏整关、托盘入口仍在、__worldOrch 桥三层通道对刃
// （「编」台 iframe 借父窗桥消费这些通道——删单只删视图层，桥不能跟着拆）。

test('删单后 bake 纪律：tab 栏整关，编排 DOM 与数据消费清零', () => {
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  // bake（烘焙 PNG）是 IM 分享底稿，不得出现任何切换入口
  assert.match(html, /body\.bake \.tabbar \{ display: none !important; \}/, 'bake tab 栏硬关规则被改');
  // 「单」的面板与工单数据消费一律清零
  assert.ok(!html.includes('panelOrch'), '编排面板残留');
  assert.ok(!html.includes('R.orch'), '模板仍在消费 R.orch');
  // 托盘「工单看板」主进程仍从 __worldSetTab 切进来（setTab 兜底未知 tab）
  assert.ok(html.includes('window.__worldSetTab'), '缺主进程切 tab 入口 __worldSetTab');
});

test('__worldOrch 桥三层通道对刃：六个写闭环通道一个不缺', () => {
  // 「编」台经父窗桥调这六个方法：桥必须真实暴露（channel 名 preload ↔ live.js 一一对应）
  const preload = fs.readFileSync(path.join(__dirname, '..', 'world', 'live', 'preload.js'), 'utf8');
  assert.ok(preload.includes("exposeInMainWorld('__worldOrch'"), 'preload 缺 __worldOrch 桥');
  const channels = ['world:orch:transition', 'world:orch:patch', 'world:orch:remove', 'world:orch:sessions', 'world:orch:plan', 'world:orch:commitPlan'];
  for (const ch of channels) {
    assert.ok(preload.includes(`'${ch}'`), `preload 缺通道 ${ch}`);
  }
  // 主进程必须有对应 handler（桥对不上刃就是哑按钮）
  const live = fs.readFileSync(path.join(__dirname, '..', 'world', 'live', 'live.js'), 'utf8');
  for (const ch of channels) {
    assert.ok(live.includes(`ipcMain.handle('${ch}'`), `live.js 缺 handler ${ch}`);
  }
});
