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

// ---------- v0.7 工单调度树：五区结构守门 ----------
// 调度树是工作面：roster 带 / 守门员栏 / 树主面 / session log / 状态行，缺一个就是结构回退。

test('调度树五区骨架存在且 panel 默认 hidden；bake 双保险未被破坏', () => {
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  assert.match(html, /<div class="tabpanel orch" id="panelOrch" hidden>/, '调度树 panel 必须默认 hidden');
  for (const id of ['orchKeeper', 'orchTree', 'orchLog', 'orchStatus', 'orchSum']) {
    assert.ok(html.includes(`id="${id}"`), `缺调度树区元素 #${id}`);
  }
  assert.match(html, /body\.bake \.tabbar,\s*body\.bake #panelOrch \{\s*display:\s*none\s*!important;\s*\}/, 'bake 隐藏双保险被改');
  assert.ok(html.includes('class="ot-roster"'), '缺 roster 带');
  assert.ok(html.includes('class="ot-mid"'), '缺 mid 容器（守门员栏 + 树主面）');
});

test('调度树数据只走 R.orch.tree（tree-model），渲染层不算布局/clobber 旧看板已清', () => {
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  assert.ok(html.includes('lastR.orch.tree'), '渲染层必须消费 R.orch.tree（主进程注入的 view-model）');
  // 旧七列看板与飞行信封的残留一律不允许：它们与 tree-model 是两套世界观
  for (const stale of ['ORCH_COLS', 'layoutEnvelopes', 'orch-scene', 'orch-env', 'orchCols', 'orchInbox', 'orchFacts']) {
    assert.ok(!html.includes(stale), `旧看板残留：${stale}`);
  }
  // 红线上墙：守门员栏必须有「从不 spawn 进程」的常驻声明
  assert.ok(html.includes('从不 spawn 进程'), '守门员红线宣言缺失');
  // 双信号：stale（还没接活）是账本/引擎两盏灯分形的落点
  assert.ok(html.includes('还没接活'), 'stale 旗标（还没接活）缺失');
});

// ---------- v0.7 M2/M3：树内写闭环 + 开单回路（出口：确认→派发→收敛→开单不出 tab） ----------

test('M2/M3 写闭环只走 __worldOrch 桥：六个方法一个不缺且三层通道对刃', () => {
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  for (const call of ['__worldOrch.transition', '__worldOrch.patch', '__worldOrch.remove', '__worldOrch.sessions', '__worldOrch.plan', '__worldOrch.commitPlan']) {
    assert.ok(html.includes(call), `渲染层缺 ${call} 调用`);
  }
  // 桥必须真实暴露这六个通道（渲染层 invoke 的 channel 名与 preload 一一对应）
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

test('M2 交互元素齐备：卡片操作/会话选择器/收敛组合器/problems 上墙与定位', () => {
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  // 工单卡按状态出操作：OT_ACTIONS 表 + data-tact 按钮（状态机七个状态全覆盖）
  assert.ok(html.includes('var OT_ACTIONS = {'), '缺 OT_ACTIONS 状态→操作表');
  assert.ok(html.includes('data-tact='), '工单卡缺 data-tact 操作按钮');
  for (const st of ['draft', 'confirmed', 'dispatched', 'running', 'failed', 'blocked', 'done']) {
    assert.ok(html.includes(st + ':'), `OT_ACTIONS 缺状态 ${st} 的映射`);
  }
  // 派发会话选择器
  assert.ok(html.includes('id="orchPicker"'), '缺 #orchPicker 选择器容器');
  assert.ok(html.includes('data-pick-sid'), '选择器缺 data-pick-sid 行');
  // 收敛组合器：验收勾选 + 结论输入 + 写入按钮；CLI hint 已退场
  assert.ok(html.includes('data-caccept='), '收敛带缺验收勾选');
  assert.ok(html.includes('data-csum='), '收敛带缺结论输入');
  assert.ok(html.includes('data-converge='), '收敛带缺「写入收敛」按钮');
  assert.ok(!html.includes('chint'), 'M2 不得再留 CLI 收敛提示（chint）');
  // problems 上墙 + 点击定位
  assert.ok(html.includes('ot-problems'), '守门员栏缺 problems 容器类');
  assert.ok(html.includes('data-prob-tid'), 'problems 行缺 data-prob-tid 定位属性');
  assert.ok(html.includes('tcard.flash'), '缺定位闪烁样式');
  // M1 文案下线，M2 闭环宣言上墙
  assert.ok(!html.includes('写操作仍在 CLI'), 'M1「写操作仍在 CLI」文案必须下线');
  assert.ok(html.includes('确认 → 派发 → 收敛'), '缺 M2 闭环宣言');
});

test('M2 写操作纪律：忙闸 + 空桥兜底 + bake 形态隐藏双保险仍在', () => {
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  // 一次只许一个写操作在途（防双击双写账本）
  assert.ok(html.includes('otSetBusy'), '缺写操作忙闸 otSetBusy');
  assert.ok(html.includes('.busy .tact'), 'busy 态必须禁点操作按钮');
  // 无桥（bake/老 preload）时动作层有兜底而不是 TypeError
  assert.ok(html.includes('bridge-down'), '缺桥不可用的兜底 problem');
  // bake 双保险还在（新交互全在 #panelOrch 内，panel 隐藏即全藏）
  assert.match(html, /body\.bake \.tabbar,\s*body\.bake #panelOrch \{\s*display:\s*none\s*!important;\s*\}/, 'bake 隐藏双保险被改');
});
