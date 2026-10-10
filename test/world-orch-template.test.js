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
//   ⑧ M3 开单回路：打字目标 → plan 预览 → 勾选 → commitPlan 落账，全部只经
//      __worldOrch 桥发意图；拆单/闸门/账本写盘全在主进程 actions 层。
//   ⑨ P2 判断层：plan 可问 JEV 判断层（措辞永远本地确定性产出），判断意见
//      只作预览头部的建议级展示；判断层挂了静默回本地，绝不挡开单。
//   ⑩ v0.7.5 流体胶囊形变 + 弥散光晕：选择器/开单条水滴式开合、分配中的
//      工单卡带旋转流光描边 + 底部呼吸背光——全部纯 CSS 关键帧（无逐帧 JS），
//      几何守 px×--otscale 纪律，reduced-motion 下全部静止。
//   ⑪ v0.7.7 面板规则收敛 .tabpanel.orch：session log 行 class="r orch"（频道名
//      入类，靠它上色）曾命中裸 .orch 面板规则——绝对定位铺满树区、两行叠画在
//      keeper 上、z-index 4 吞掉整面真实鼠标点击（el.click 不走命中测试，所以
//      一度误判成"旧实例卡死"）。裸 .orch { 选择器列入禁规。
//   ⑫ v0.7.8 开单条两修：预览头/尾钉住 + 候选列表 .pdrafts 自滚（8 张候选不再
//      把「立单/弃单」挤出 max-height 裁切区）；agent 下拉 = registry × prefs
//      installed+enabled（与闸门同套语义、只探不连），候选填充只动 datalist
//      元素不整树重画（保住原生弹出层与打字焦点），手输自由保留。
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

test('v0.7.7 回归：面板几何/token 规则收敛 .tabpanel.orch，裸 .orch 面板选择器不得复活', () => {
  // 背景：session log 行渲染 class="r orch"（频道名入类）。裸 .orch 规则曾命中日志行：
  // position:absolute + inset 把行撑成 854×482 巨层铺满树区、两行同 rect 叠画、
  // z-index:4 把整面真实鼠标点击吃掉（el.click 绕过命中测试故长期漏网）。
  assert.ok(!/^\s*\.orch \{/m.test(html), '裸 .orch { 面板规则复活');
  // 几何块与 token 块两块都必须带 .tabpanel 限定（display:none + inset 面板放置 / --ot-* token 声明）
  assert.match(html, /\.tabpanel\.orch \{\s*\n\s*display: none;\s*\/\* 由下面 body\.live 规则打开/);
  assert.match(html, /\.tabpanel\.orch \{\s*\n\s*--ot-line: #222832;/);
  // 日志行仍然渲染频道类（上色语义不丢），且频道上色规则保持 .ot-log 局部
  assert.ok(html.includes("'<div class=\"r ' + esc(r.who) + '\">"), '日志行频道类渲染丢失');
  assert.match(html, /\.ot-log \.r\.orch \.who \{ color: var\(--ot-green2\); \}/);
});

test('v0.7.8 开单条两修：预览页脚钉住 + agent 下拉（只探不连、只填 datalist 不重画）', () => {
  // ① 预览结构：候选包进自滚容器 .pdrafts，页脚带 pacts 钉住——8 张候选不再挤出立单按钮
  assert.ok(html.includes("'<div class=\"pdrafts\">'"), '候选列表缺自滚容器');
  assert.ok(html.includes('prow pacts'), '页脚立单/弃单缺钉住类');
  assert.match(html, /\.ot-plan\.preview \{ display: flex; flex-direction: column; max-height: calc\(480px \* var\(--otscale/);
  assert.match(html, /\.ot-plan\.preview \.nh, \.ot-plan\.preview \.prow2, \.ot-plan\.preview \.pacts \{ flex: none; \}/);
  assert.match(html, /\.ot-plan \.pdrafts \{ flex: 1 1 auto; min-height: 0; overflow-y: auto;/);
  // ② agent 下拉：input 接 datalist（建议不是白名单，仍是文本框可手输）
  assert.match(html, /data-pagent list="otAgents"/);
  assert.ok(html.includes('<datalist id="otAgents">'), 'datalist 容器缺失');
  // 候选只拉一次；回来只填 datalist 元素——不整树重画（原生弹出层/打字焦点不被顶掉）
  assert.match(html, /var otAgentOpts = null;/);
  assert.match(html, /if \(!otAgentOpts && window\.__worldOrch\.agents\)/);
  assert.match(html, /document\.getElementById\('otAgents'\)/);
  assert.match(html, /dl\.innerHTML = otAgentOptsHtml\(\)/);
  // 候选行转义：id 是闸门认的、label 给人看，全部过 esc
  assert.ok(html.includes('\'<option value="\' + esc(a.id) + \'">\' + esc('), 'agent 候选行缺转义');
  // 桥与主进程 handler：名单 = registry × agent-gate 的 installed+enabled（只探测不连接）
  const preload = fs.readFileSync(path.join(__dirname, '..', 'world', 'live', 'preload.js'), 'utf8');
  assert.match(preload, /agents: \(\) => ipcRenderer\.invoke\('world:orch:agents'\)/);
  const live = fs.readFileSync(path.join(__dirname, '..', 'world', 'live', 'live.js'), 'utf8');
  assert.match(live, /ipcMain\.handle\('world:orch:agents'/);
  assert.match(live, /require\('\.\.\/\.\.\/agents\/registry'\)/);
  assert.match(live, /isAgentIntegrationInstalled\(snap, a\.id\) && agentGate\.isAgentEnabled\(snap, a\.id\)/);
  assert.match(live, /require\('\.\.\/orch\/prefs-source'\)\.loadPrefs\(\)\.snapshot/);
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
  // M3 开单回路同样只发意图：拆单预览与落账全走 __worldOrch 桥
  assert.match(html, /__worldOrch\.plan\(/);
  assert.match(html, /__worldOrch\.commitPlan\(/);
  // 空目标立单指引把 CLI 等价口留在文案里
  assert.match(html, /npm run world:orch -- plan/);
});

test('M3 开单条在树主面：目标/agent/cwd 输入 → 拆分预览 → 勾选 → 立单', () => {
  // 开单条样式进了树区 CSS（几何被 ⑦ 号 vmin 守门自动覆盖，这里守 px 基准存在）
  assert.match(html, /\.ot-plan \{/);
  assert.match(html, /\.ot-plan \{[^}]*width: calc\(470px \* var\(--otscale/);
  // 三个输入：闸门要求 agent + cwd 非空（agent-unknown / cwd-missing），开单条必须带上
  for (const attr of ['data-pgoal', 'data-pagent', 'data-pcwd']) assert.ok(html.includes(attr), `开单条缺输入 ${attr}`);
  // 预览/立单/弃单三个桥按钮 + 预览勾选（勾选是本地意图不过桥，只翻 class）
  for (const attr of ['data-plan="1"', 'data-plan-commit', 'data-plan-cancel', 'data-pcheck']) {
    assert.ok(html.includes(attr), `开单条缺交互 ${attr}`);
  }
  // 事件代理四分支都接到各自函数
  assert.match(html, /otTogglePlan\(pcheck\)/);
  assert.match(html, /otPlanPreview\(\)/);
  assert.match(html, /otPlanCommit\(\)/);
  assert.match(html, /otPlanCancel\(\)/);
  // 开单草稿态：候选与勾选只活在内存，落账成功才清空；morph 是形变标记（只带一帧）
  assert.match(html, /var otPlan = \{ goal: '', agent: '', cwd: '', drafts: null, checks: \[\], jev: null, morph: '' \};/);
  // P2 判断层：被问过就把意见以金色建议级行摆在预览头部（转义照旧，决策权在人）
  assert.match(html, /\.ot-plan \.pjudge \{ color: var\(--ot-gold\); \}/);
  assert.ok(html.includes('esc(otPlan.jev.reason)'), '判断意见缺转义');
  assert.match(html, /res\.jev && res\.jev\.modelTried/);
  // 无桥形态（bake/老 preload）整条不出开单口——开不了单的输入条比没有更误导
  const fn = html.slice(html.indexOf('function otPlanHtml()'));
  assert.match(fn.slice(0, 200), /if \(!window\.__worldOrch\) return '';/);
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

test('v0.7.5 流体胶囊形变 + 弥散光晕：纯 CSS 运动、状态色沿用账本 token、reduced-motion 全静止', () => {
  // ① 胶囊→面板形变：选择器与开单条预览都从 999px 胶囊圆角延展，高阻尼曲线（不上抛不回弹）
  assert.match(html, /@keyframes otPkMorph \{[\s\S]*?border-radius: calc\(999px \* var\(--otscale/);
  assert.match(html, /\.ot-picker \.pk \{ transform-origin: top right; animation: otPkMorph 0\.38s cubic-bezier\(0\.16, 1, 0\.3, 1\) both; \}/);
  assert.match(html, /@keyframes otPlanMorph \{[\s\S]*?border-radius: calc\(999px \* var\(--otscale/);
  assert.match(html, /\.ot-plan\.preview\.morphin \{ overflow: hidden; animation: otPlanMorph 0\.46s cubic-bezier\(0\.16, 1, 0\.3, 1\) both; \}/);
  // 收拢反向复用同帧（面板 → 胶囊）；候选项只在展开帧交错浮现（重推不重演）
  assert.match(html, /\.ot-plan\.fold \{ overflow: hidden; animation: otPlanMorph 0\.36s cubic-bezier\(0\.5, 0, 0\.75, 0\) reverse both; \}/);
  assert.ok(html.includes("otPlan.morph = 'morphin'") && html.includes("otPlan.morph = 'fold'"), '形变触发点缺失');
  assert.match(html, /otPlan\.morph = '';/); // otPlanHtml 读完即清：整树重画不重演入场
  assert.ok(html.includes("style=\"animation-delay:' + i * 45 + 'ms\""), '候选项行延迟缺失');
  // ② 弥散光晕：分配中的工单卡（dispatched/running，账本状态）= 旋转流光描边 + 底部呼吸背光
  assert.match(html, /@property --ot-a \{ syntax: '<angle>';/);
  assert.match(html, /conic-gradient\(from var\(--ot-a\)/);
  assert.match(html, /\.tcard\.s-running::before \{?[\s\S]*?animation: otGlowSpin 7s linear infinite;/);
  assert.match(html, /mask-composite: exclude;/);
  assert.match(html, /\.tcard\.s-running::after \{?[\s\S]*?filter: blur\(calc\(9px \* var\(--otscale/);
  assert.match(html, /\.tcard\.s-running::after \{?[\s\S]*?z-index: -1;/); // 光沁在卡片背后
  assert.match(html, /animation: otGlowBreath 3\.4s ease-in-out infinite alternate;/);
  // 状态色沿用账本 token，不引入新语义色
  assert.match(html, /\.tcard\.s-dispatched \{ --ot-glow: var\(--ot-vio\); \}/);
  assert.match(html, /\.tcard\.s-running \{ --ot-glow: var\(--ot-green2\); \}/);
  // ③ 加载挂起态：busy 时胶囊主按钮上一缕流光等主进程
  assert.match(html, /@keyframes otSheen/);
  assert.match(html, /\.tabpanel\.orch\.busy \.ot-plan \.tact\.go::after \{[\s\S]*?animation: otSheen 1\.05s linear infinite;/);
  // ④ 运动秩序：全部 CSS 关键帧，无逐帧 JS（既有守门只查 rAF 帧函数，不再赘述）
  for (const kf of ['otPkMorph', 'otRowIn', 'otPlanMorph', 'otDraftIn', 'otSheen', 'otGlowSpin', 'otGlowBreath']) {
    assert.match(html, new RegExp('@keyframes ' + kf), '缺关键帧 ' + kf);
  }
  // ⑤ reduced-motion 静止两块：第一块守定位闪烁（上面既有测），第二块守本节流光/形变
  const mid = html.indexOf('@media (prefers-reduced-motion: reduce)');
  const mid2 = html.indexOf('@media (prefers-reduced-motion: reduce)', mid + 10);
  assert.ok(mid2 > mid, '缺第二块 reduced-motion 静止');
  const block2 = html.slice(mid2, mid2 + 700);
  assert.match(block2, /\.tcard\.s-running::before \{ animation: none; \}/);
  assert.match(block2, /\.tcard\.s-running::after \{ animation: none; opacity: 0\.7; \}/);
  assert.match(block2, /\.ot-plan\.preview\.morphin, \.ot-plan\.fold, \.ot-plan\.preview\.morphin \.pdraft \{ animation: none; \}/);
  assert.match(block2, /\.ot-picker \.pk, \.ot-picker \.pk h4, \.ot-picker \.pkrow \{ animation: none; \}/);
});

test('v0.7.6 焦点守卫：推送帧撞上树内输入框持焦 → 暂存待渲，blur 才落；本地意图帧直画', () => {
  // 触发背景：主进程推送整树 innerHTML 重画，打字中的开单条被抢焦点、点按被替换帧吞掉
  assert.match(html, /var otPendingTree = null;/);
  // renderTree 非强制帧 + 树内 input/textarea 持焦 → 暂存返回，不重画
  assert.match(html, /function renderTree\(t, opts\) \{[\s\S]{0,500}otPendingTree = t;\s*\n\s*return;/);
  assert.match(html, /ae\.tagName === 'INPUT' \|\| ae\.tagName === 'TEXTAREA'/);
  // 本地意图（勾选/预览/弃单/落账回执）走 force 直画，守卫不拦
  assert.match(html, /renderTree\(lastR\.orch\.tree, \{ force: true \}\)/);
  // blur 彻底离开树才落暂存帧（树内输入互相跳不落）；force 落帧清暂存
  assert.match(html, /panel\.addEventListener\('focusout'/);
  assert.match(html, /e\.relatedTarget && treeEl\.contains\(e\.relatedTarget\)\) return;/);
  assert.match(html, /otPendingTree = null;\s*\n\s*var html =/);
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
test('v1.0 五级窗口协作 UI：四挂载点静默纪律 + 两步推进 + 授权不开 UI 口', () => {
  // ① 颜色协议：--ot-ws-* 与 protocol.WINDOW_STATE_COLORS 同值（protocol 是唯一真相）
  const protocol = require('../world/orch/protocol');
  for (const [st, hex] of Object.entries(protocol.WINDOW_STATE_COLORS)) {
    assert.ok(html.includes('--ot-ws-' + st + ': ' + hex + ';'), `缺五态 token ${st}`);
  }
  // ② 条与带默认 hidden；基类不得自带 display（[hidden] 失效 = .ot-picker 事故重演）
  assert.match(html, /<div class="ot-wstrip" id="orchWstrip" hidden>/);
  assert.match(html, /<div class="ot-road" id="orchRoad" hidden>/);
  const wstripBase = html.match(/\.ot-wstrip \{([^}]*)\}/);
  assert.ok(!wstripBase || !/display\s*:/.test(wstripBase[1] || ''), '.ot-wstrip 基类自带 display 会让 hidden 失效');
  const roadBase = html.match(/\.ot-road \{([^}]*)\}/);
  assert.ok(!roadBase || !/display\s*:/.test(roadBase[1] || ''), '.ot-road 基类自带 display 会让 hidden 失效');
  assert.match(html, /\.ot-wstrip:not\(\[hidden\]\) \{[\s\S]*?display: flex;/);
  assert.match(html, /\.ot-road:not\(\[hidden\]\) \{[\s\S]*?display: flex;/);
  // ③ 静默纪律：无数据整段不出（早退清 hidden / 返空串）
  const wstripFn = html.slice(html.indexOf('function renderWstrip(t)'));
  assert.match(wstripFn.slice(0, 280), /if \(!rv\) \{ el\.hidden = true; el\.innerHTML = ''; return; \}/);
  assert.match(html.slice(html.indexOf('function otWinHtml(t)'), html.indexOf('function otWinHtml(t)') + 160), /if \(!rv\) return '';/);
  assert.match(html.slice(html.indexOf('function otReportHtml(rep)'), html.indexOf('function otReportHtml(rep)') + 140), /if \(!rep\) return '';/);
  const roadFn = html.slice(html.indexOf('function renderRoad(t)'));
  assert.match(roadFn.slice(0, 320), /el\.hidden = true; el\.innerHTML = ''; return;/);
  // ④ 装配：renderOrch 挂两段渲染；窗口卡在 JEV 与 spawn 之间；回执面板进 keeper
  const renderOrch = html.slice(html.indexOf('function renderOrch(o) {'), html.indexOf('function renderOrch(o) {') + 1600);
  assert.ok(renderOrch.includes('renderWstrip(t);') && renderOrch.includes('renderRoad(t);'), 'renderOrch 缺五态条/roadmap 带渲染');
  const treeFn = html.slice(html.indexOf('function renderTree(t, opts) {'), html.indexOf('function tcardHtml('));
  const winIdx = treeFn.indexOf('html += otWinHtml(t);');
  assert.ok(winIdx > treeFn.indexOf('ot-jev local') && winIdx < treeFn.indexOf('ot-spawn-line'), '窗口卡必须挂在 JEV 与 spawn 之间');
  assert.ok(html.slice(html.indexOf('function renderKeeper(t)'), html.indexOf('function otProblemsHtml()')).includes('otReportHtml(t.latestReport)'), 'keeper 缺回执面板');
  // ⑤ 唯一写动作 = 推进，两步确认（武装 3s），不用阻塞式 confirm
  assert.ok(!html.includes('window.confirm'), '不得用阻塞式 window.confirm');
  assert.match(html, /var otWinArmUntil = 0;/);
  assert.ok(html.includes('再点一次确认推进'), '两步确认缺武装文案');
  assert.match(html, /__worldOrch\.advanceWindow\(\{ confirm: true \}\)/);
  // 授权是老大的人工关口，永不开 UI 写入口（channel/桥方法/交互属性三处都没有；
  // 只读展示 s.authorized 授权旗标是 design，不在禁列）
  assert.ok(!html.includes('world:orch:stage-authorize') && !html.includes('data-stage-authorize'), '渲染层不得出现授权入口');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'world', 'live', 'preload.js'), 'utf8');
  assert.ok(!/ipcRenderer\.invoke\('world:orch:(stage-)?authorize/.test(preload), 'preload 不得开授权桥');
  // 三桥 + 三 handler + 两处数据装配点（buildLiveReport / refreshOrchView）
  const live = fs.readFileSync(path.join(__dirname, '..', 'world', 'live', 'live.js'), 'utf8');
  for (const ch of ['world:orch:submitReport', 'world:orch:advanceWindow', 'world:orch:roadmapRead']) {
    assert.ok(preload.includes(ch), `preload 缺桥 ${ch}`);
    assert.ok(live.includes(ch), `live.js 缺 handler ${ch}`);
  }
  assert.equal((live.match(/roadmap: buildRoadmapSlice\(\{ root: orch\.root \}\)/g) || []).length, 2, '两处装配点都要注入 roadmap 切片');
  // ⑥ 新区块零输入框（焦点守卫不接管它们——这是设计：回执证据输入只走 CLI）
  const winBlock = html.slice(html.indexOf('function otWinHtml(t)'), html.indexOf('function otReportHtml(rep)'));
  assert.ok(!winBlock.includes('<input'), '窗口卡不得含输入框');
  const repBlock = html.slice(html.indexOf('function otReportHtml(rep)'), html.indexOf('function renderRoad(t)'));
  assert.ok(!repBlock.includes('<input'), '回执面板不得含输入框');
  // ⑦ 折叠只翻 class 不重渲染；开合态是模块变量（推送帧不抢本地意图）
  assert.match(html, /var otReportFold = true;/);
  assert.match(html, /rp\.classList\.toggle\('fold', otReportFold\)/);
  // ⑧ 回执面板：九项 ✅/❌ 行 + 自由文本全转义
  assert.ok(repBlock.includes('ok">✅') && repBlock.includes('no">❌'), '回执缺 ✅/❌ 行');
  for (const e of ['esc(rep.verdict ||', 'esc(c.id)', 'esc(rep.recommendedNextStep)', 'esc(bd.blocker ||']) {
    assert.ok(repBlock.includes(e), `回执缺转义 ${e}`);
  }
  // ⑨ 五态条/窗口卡/roadmap 带自由文本全转义
  for (const e of ['esc(s.label)', 'esc(rv.soleGoal', 'esc(rv.stateLabel)', 'esc(u.stateLabel)', 'esc(rv.milestone']) {
    assert.ok(html.includes(e), `缺转义 ${e}`);
  }
  // ⑩ 执行中窗口卡复用弥散光晕（同一关键帧），reduced-motion 进第二块静止列表
  assert.match(html, /\.ot-win\.ws-execution \{ --ot-glow: var\(--ws\); \}/);
  assert.match(html, /\.ot-win\.ws-execution::before \{[\s\S]*?animation: otGlowSpin 7s linear infinite;/);
  const mid = html.indexOf('@media (prefers-reduced-motion: reduce)');
  const mid2 = html.indexOf('@media (prefers-reduced-motion: reduce)', mid + 10);
  assert.ok(html.slice(mid2, mid2 + 900).includes('.ot-win.ws-execution::before { animation: none; }'), '窗口卡流光缺 reduced-motion 静止');
  // ⑪ 五态条 0.3s 过渡 + 当前格弥散光（0.3s 与 .tact 同纪律）
  assert.match(html, /\.ot-wstrip \.seg \{[\s\S]*?transition: border-color 0\.3s, color 0\.3s, background 0\.3s, box-shadow 0\.3s;/);
  assert.match(html, /\.ot-wstrip \.seg\.current \{[\s\S]*?box-shadow: 0 0 calc\(9px \* var\(--otscale/);
  // ⑫ 事件代理两个新分支（推进 / 回执折叠）
  assert.match(html, /el\.closest\('\[data-win-advance\]'\)/);
  assert.match(html, /el\.closest\('\[data-report-toggle\]'\)/);
});
