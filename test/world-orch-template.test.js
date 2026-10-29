// test/world-orch-template.test.js
// 删单（ORCH-CONSOLE-R2 需求1）后的守门：daily-card 不再带「单」的工单调度树 tab，
// 编排唯一入口是「编」（orchestra 台）。这里守的是删干净契约 + 残留通道对刃：
//   ① bake 形态绝不出现任何编排入口：tab 栏整关，模板零编排 DOM。
//   ② tab 切换仍走 display:contents / 绝对定位，早报两栏排版一个像素不动。
//   ③ 模板零编排渲染层：panel / render 函数 / 桥调用 / R.orch 消费一律清零；
//      主进程职责（闸门/账本）更不许回流。
//   ④ 托盘切 tab 仍走同一个 setTab（__worldSetTab 保留），'orch' 落「编」台，未知 tab 兜底 daily；
//      快捷键 Ctrl/Cmd + 1/2/3 → 早报/编/维护（2 从「单」改指「编」，其余键位原数字不动）。
//   ⑤ __worldOrch 桥没有被顺手拆掉：「编」台（orchestra.html iframe 借父窗桥）
//      仍靠它——preload 通道与 live.js handler 对刃，一个不缺。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TEMPLATE = path.join(__dirname, '..', 'world', 'template', 'daily-card.html');
const html = fs.readFileSync(TEMPLATE, 'utf8');

test('bake 形态不含编排入口：tab 栏整关 + 模板零编排 DOM', () => {
  // bake（烘焙 PNG）是 IM 分享底稿，不得出现任何切换入口
  assert.match(html, /body\.bake \.tabbar \{ display: none !important; \}/);
  // tab 栏默认 hidden，只有 live 才亮
  assert.match(html, /<div class="tabbar" id="tabBar" hidden>/);
  // 「单」的 DOM 一律清零（面板 / tab 按钮 / 徽标）
  for (const gone of ['id="panelOrch"', 'tabpanel orch', 'id="tabOrch"', 'orchBadge']) {
    assert.ok(!html.includes(gone), `编排 DOM 残留：${gone}`);
  }
});

test('tab 面板用 display:contents，不改变 .page 的 flex 排版', () => {
  assert.match(html, /\.tabpanel \{ display: contents; \}/);
  // 切到维护时 daily 面板整块收起（display:contents 无法隐藏，走 body 类）
  assert.match(html, /body\.live\.tab-maint #panelDaily \{ display: none; \}/);
});

test('面板与 tab 栏定位仍是绝对定位，不挤进 flex 流', () => {
  assert.match(html, /\.tabpanel\.maint \{[\s\S]*?position: absolute;/);
  assert.match(html, /\.tabbar \{[\s\S]*?position: absolute;/);
});

test('删单清零：模板零编排渲染层，主进程职责不回流', () => {
  // 渲染函数 / 状态表 / 桥调用 / 数据消费：全删，一个串都不留
  for (const gone of [
    'function renderOrch', 'function renderTree', 'function renderKeeper',
    'function renderWstrip', 'function renderRoad', 'function renderLog', 'function renderStatus',
    '__worldOrch', 'R.orch', 'panelOrch', 'orchWires', 'orchTree', 'orchLog', 'orchStatus',
    'OT_ACTIONS', 'otSetBusy', 'data-tact', '--otscale', '.ot-', '@keyframes ot',
  ]) {
    assert.ok(!html.includes(gone), `编排渲染层残留：${gone}`);
  }
  // 主进程职责（闸门/账本/路径）从来不许进渲染层——删单后同理
  for (const leak of ['checkBatch', 'checkTicket', 'agent-gate', 'tickets.json', 'blackboard.json', 'ticketsFile']) {
    assert.ok(!html.includes(leak), `渲染层出现主进程职责：${leak}`);
  }
  // 渲染层不得直接 require（沿用既有纪律）
  assert.ok(!/require\s*\(/.test(html));
  // 逐帧动画与旧看板时代残留不得复活
  assert.ok(!/requestAnimationFrame\(\s*function frame/.test(html), '不得有逐帧动画帧函数');
  for (const stale of ['@keyframes envFly', "setProperty('--x0'", 'ORCH_COLS', 'layoutEnvelopes', 'orch-scene', 'orch-env']) {
    assert.ok(!html.includes(stale), `旧动画/旧看板残留：${stale}`);
  }
});

test('托盘切 tab 走渲染层同一个 setTab；快捷键 1/2/3 → 早报/编/维护', () => {
  assert.match(html, /window\.__worldSetTab = function \(tab\) \{\s*\n\s*setTab\(tab\);\s*\n\s*\}/);
  // 托盘入口不消费工单数据（台账只在主进程+「编」台 iframe 里）
  assert.ok(!html.includes('lastR.orch'), '托盘入口不得再消费工单数据');
  // 键盘 Ctrl/Cmd + 1/2/3：2 从「单」改指「编」，其余键位原数字不变
  assert.match(html, /e\.key !== '1' && e\.key !== '2' && e\.key !== '3'/);
  assert.match(html, /e\.key === '3' \? 'maint' : e\.key === '2' \? 'orch' : 'daily'/);
});

test('「编」台接线：tab 按钮 + iframe 懒加载 + bake 整关', () => {
  // tab 按钮在早报与维护之间
  assert.match(html, /<button class="tab" id="tabOrchestra" type="button" data-tab="orch">🎼 编<\/button>/);
  // iframe 面板：隐藏默认 + data-src 懒加载（首进台才载 orchestra.html）
  assert.match(html, /<div class="tabpanel bandview" id="viewOrchestra" hidden>/);
  assert.match(html, /<iframe id="orchestraFrame" title="编排台" data-src="orchestra\.html"><\/iframe>/);
  assert.match(html, /if \(fr && !fr\.src\) fr\.src = fr\.getAttribute\('data-src'\)/);
  // 定位规格与维护 tab 同款：绝对定位铺在工作面，bake 形态硬关
  assert.match(html, /\.tabpanel\.bandview \{[\s\S]*?position: absolute;/);
  assert.match(html, /body\.bake \.tabpanel\.bandview \{ display: none !important; \}/);
  // 切台时早报面板收起（body 类战术与维护一致）
  assert.match(html, /body\.live\.tab-orch #panelDaily \{ display: none; \}/);
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

test('__worldOrch 桥残留通道对刃：agents / 回执 / 推进 / roadmap 一枚不缺', () => {
  // 这些是「编」台（orchestra.html iframe 借父窗桥）在用的通道——删单只删视图层，
  // 桥与主进程 handler 不许顺手拆。
  const preload = fs.readFileSync(path.join(__dirname, '..', 'world', 'live', 'preload.js'), 'utf8');
  assert.match(preload, /exposeInMainWorld\('__worldOrch'/);
  const live = fs.readFileSync(path.join(__dirname, '..', 'world', 'live', 'live.js'), 'utf8');
  for (const ch of ['world:orch:agents', 'world:orch:submitReport', 'world:orch:advanceWindow', 'world:orch:roadmapRead']) {
    assert.ok(preload.includes(`'${ch}'`), `preload 缺通道 ${ch}`);
    assert.ok(live.includes(`ipcMain.handle('${ch}'`), `live.js 缺 handler ${ch}`);
  }
  // agents 名单 = agents/registry 注册表 × prefs 的 installed+enabled（只探测不连接）
  assert.match(live, /require\('\.\.\/\.\.\/agents\/registry'\)/);
  assert.match(live, /agentGate\.isAgentIntegrationInstalled\(snap, a\.id\) && agentGate\.isAgentEnabled\(snap, a\.id\)/);
  assert.match(live, /require\('\.\.\/orch\/prefs-source'\)\.loadPrefs\(\)\.snapshot/);
});
