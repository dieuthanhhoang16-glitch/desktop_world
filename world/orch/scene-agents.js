// world/orch/scene-agents.js
// desktop-world · 场景里的 agent 工位渲染（纯函数 + 确定性随机，无 IO）。
//
// 复用 world/garden/scene.js 的两条纪律：
//   ① 纯函数：同一份工单/会话描述永远渲染出同一张SVG，测试可断言、缓存可复用。
//   ② 确定性随机：FNV-1a 哈希 + mulberry32。工位抖动、工位配色都由
//      sessionId 的哈希决定 —— 同一个人在同一个位置坐下，画面不会每次热刷都换样子。
//
// 动作映射参考 world/live/pomodoro.js 的 taskActionFor（读/研究→thinking、
// 整理→sweeping、搬运→carrying、会议→attention、其余→working）：这里的输入是
// 工单标题 + agent 状态，输出是主题状态键。**只做映射，不管来源**。
//
// 边界：这里画的是**已有 coding agent 会话的投影**，不是自己拉起来的进程。
// 工位数量上限即会话数量上限，没有任何"启动一个 agent"的概念。
'use strict';

const { hashStr, mulberry32 } = require('../garden/scene');

// ── 画布尺寸 ──────────────────────────────────────────────────
// v0.7 放大：GW/GH 从 160×48 提到 240×72，CELL 从 2 提到 3（像素块更大更清楚），
// 工位从 8 个增到 12 个（3 行 × 4 列）。
//
// 为什么工位数跟着涨：COLS=4 时 8 个工位只能摆 2 行，画面上下留白很大、地板空旷。
// 12 个填满 3 行后画布密度才和放大后的尺寸匹配。
//
// ── 分层地板的几何（改尺寸时照这个推）─────────────────────────
// 工位自身的纵向占位（drawStation）：
//   头顶信号 y-3 ┐
//   屏幕/小人 y+1~y+4│
//   桌面 y+5,y+6   │ 共约 13 格
//   桌腿 y+7~y+8  ┘ y+9 处结束
//
// 3 排工位 = 3 条地板线（row 0 最前/最近/y 最大，row 越大越远/y 越小）：
//   floorLineForRow(row) = FLOOR_Y - row * ROW_H      ← 地板线
//   floorYForRow(row)    = 地板线 - DESK_DROP         ← 工位基准 y
//
// 硬约束（三条都要满足，否则工位出界或没有天花板留白）：
//   ① 最远排头顶 ≥ 0：FLOOR_Y - (ROWS-1)*ROW_H - DESK_DROP - 3 ≥ 0
//   ② 最近排桌腿 < GH：FLOOR_Y + 9 < GH
//   ③ 墙要留得住：WALL_H ≥ 14（天花板不能只剩几格，否则画面没有纵深）
// 当前 56 - 40 - 11 = 5 ≥ 0 ✅；56 + 9 = 65 < 72 ✅；WALL_H = 56-40-11-4 = 1 →上调 FLOOR_Y
const CELL = 3;
const GW = 240; // 画布宽（格）
const GH = 72; // 画布高（格）
const ROW_H = 16; // 每排的地板线间距（格）
const MAX_STATIONS = 12;
const COLS = 4;
const ROWS = Math.ceil(MAX_STATIONS / COLS); // 3
// 工位基准 y 到它脚下地板线的距离：桌腿画到 y+9，地板线要落在 y+8 那一格
const DESK_DROP = 8;
// 最前排的地板线。取值让①③ 同时成立：WALL_H = FLOOR_Y - 32 - 11 - 4 ≥ 14 → FLOOR_Y ≥ 61
const FLOOR_Y = 62;
const WALL_H = Math.max(14, FLOOR_Y - (ROWS - 1) * ROW_H - DESK_DROP - 3 - 4);

// 动作 → 状态语义（与 pomodoro.taskActionFor 的规则同源，键名一致）
const ACTION_THINKING = 'thinking';
const ACTION_SWEEPING = 'sweeping';
const ACTION_CARRYING = 'carrying';
const ACTION_ATTENTION = 'attention';
const ACTION_WORKING = 'working';

// 工单状态 → 工位上方的气泡图标（看板与场景用同一套语义）
const STATUS_ICONS = Object.freeze({
  draft: '📝',
  confirmed: '✅',
  dispatched: '📤',
  running: '⚙️',
  done: '🌳',
  failed: '❌',
  blocked: '🚧',
});

// 关键词 → 动作。顺序即优先级，与 pomodoro 的 rules 保持一致的"先特异后通用"。
const ACTION_RULES = [
  [/整理|清理|归纳|收拾|归档|clean|tidy|删除/i, ACTION_SWEEPING],
  [/搬|下载|移动|拷贝|迁移|同步|move|copy|download|sync/i, ACTION_CARRYING],
  [/读|看|研究|调研|梳理|分析|review|read|research|理解|学习/i, ACTION_THINKING],
  [/聊|沟通|会议|讨论|对齐|回复|chat|meeting/i, ACTION_ATTENTION],
];

/**
 * 工单标题 → 动作键。空标题回退 working（通用敲键盘）。
 * 与 pomodoro.taskActionFor 同构，但**独立实现**：orch 不依赖 live/pomodoro 的
 * 状态文件语义（那是有番茄钟的），只借它的映射思路。
 */
function actionFor(title) {
  const t = String(title == null ? '' : title).toLowerCase();
  if (!t) return ACTION_WORKING;
  for (const [re, action] of ACTION_RULES) if (re.test(t)) return action;
  return ACTION_WORKING;
}

// 动作 → 像素小人姿态。working 是"敲键盘"（手在桌上），thinking 是"抬头冒点"，
// sweeping 是"弯腰扫"，carrying 是"抱东西"，attention 是"举起手"。
const POSE = {
  [ACTION_WORKING]: { body: '00011', head: '00100', arms: '01010', prop: '01100', accent: '#4ade80' },
  [ACTION_THINKING]: { body: '00011', head: '00100', arms: '10110', prop: '00100', accent: '#7dd3fc' },
  [ACTION_SWEEPING]: { body: '00011', head: '00100', arms: '01110', prop: '10000', accent: '#fbbf24' },
  [ACTION_CARRYING]: { body: '00111', head: '00100', arms: '11011', prop: '01110', accent: '#c084fc' },
  [ACTION_ATTENTION]: { body: '00011', head: '00100', arms: '10101', prop: '00101', accent: '#fb7185' },
};

const DESK = '#3f3a52';
const DESK_TOP = '#565073';
const FLOOR_A = '#241f38';
const FLOOR_B = '#2b2442';
const WALL = '#151228';
const OUTLINE = '#0d0b1a';

/**
 * 归一化一个工位输入：工单 + 目标 session（可能没有 session —— 工单还没派出去）。
 * @param item {id, title, status, agent, cwd, sessionId, agentName, state}
 */
function normalizeStation(item = {}) {
  const action = item.action || actionFor(item.title);
  return {
    id: String(item.id || ''),
    title: String(item.title || ''),
    status: String(item.status || 'draft'),
    action,
    agent: String(item.agent || ''),
    agentName: String(item.agentName || item.agent || ''),
    cwd: String(item.cwd || ''),
    sessionId: String(item.sessionId || ''),
    // 引擎真实状态（来自 session snapshot 的 state 字段）：running 才算真在干活
    engineState: String(item.state || ''),
  };
}

/**
 * 第 row 排的**地板线** y（该排工位脚下那条地面的起始行）。
 * row 0 = **最前排**（画面最下方，最近），row 越大越靠里/越上（远排）——
 * 所以地板线y 随 row **递减**。画的时候从 row 0 往后画，近的覆盖远的，天然形成遮挡。
 */
function floorLineForRow(row) {
  return FLOOR_Y - row * ROW_H;
}

/**
 * 第 row 排工位的基准 y。**layout() 与几何校验都必须走这个函数** ——
 * 各自算一遍的话，工位和它脚下的地板会错位（v0.7 初次实现时就踩了：3 行工位
 * 只有第 1 行有地板，后两行悬空）。
 */
function floorYForRow(row) {
  return floorLineForRow(row) - DESK_DROP;
}

// 工位布局：网格排布 + 哈希决定的微抖动。抖动幅度小，保证不越界、不重叠。
//
// 行基准 y 用 floorYForRow 而不是魔法数字 —— v0.7 把工位从 2 行 8 个扩到 3 行 12 个，
// 行高必须跟着 FLOOR_Y 一起算，否则第 3 行的桌腿会踩到画布外。
function layout(index, seed) {
  const rand = mulberry32(hashStr(`orch:${seed}`) + index * 2654435761);
  const col = index % COLS;
  const row = Math.floor(index / COLS);
  const colW = (GW - 12) / COLS;
  const baseX = 6 + col * colW;
  const baseY = floorYForRow(row);
  // 抖动限制在 ±1 格，既能打散机械感又不会把工位挤出画布
  const jitterX = Math.round(rand() * 2 - 1);
  const jitterY = rand() > 0.5 ? 0 : -1;
  return {
    x: Math.max(2, Math.min(GW - 12, Math.round(baseX + jitterX))),
    // 下界要留给"头顶信号点"（画在 y-3）：y 至少 5，否则信号点会被画到墙外甚至负坐标
    y: Math.max(5, Math.round(baseY + jitterY)),
    hue: rand(),
    row,
  };
}

function rect(out, x, y, w, h, c, op) {
  out.push(`<rect x="${x * CELL}" y="${y * CELL}" width="${w * CELL}" height="${h * CELL}" fill="${c}"${op != null ? ` fill-opacity="${op}"` : ''}/>`);
}
function stamp(out, grid, x, y, c) {
  grid.forEach((row, dy) => {
    [...row].forEach((v, dx) => {
      if (v !== '0' && v !== '.') rect(out, x + dx, y + dy, 1, 1, typeof c === 'object' ? (c[v] || c['1']) : c);
    });
  });
}

// 工位：桌 + 小人 + 状态气泡图标
function drawStation(out, st, place, seed) {
  const pose = POSE[st.action] || POSE[ACTION_WORKING];
  const rand = mulberry32(hashStr(`orch-pose:${seed}:${st.id || place.index}`));
  const x = place.x;
  const y = place.y;

  // 桌子
  rect(out, x - 1, y + 5, 8, 1, DESK_TOP);
  rect(out, x - 1, y + 6, 8, 1, DESK);
  rect(out, x, y + 7, 1, 2, DESK); // 桌腿
  rect(out, x + 5, y + 7, 1, 2, DESK);

  // 小人（头 + 身体 + 手臂 + 手里的东西）
  // pose.* 都是单行 0/1 图案，stamp 接受二维 grid，所以包一层数组。
  const skin = ['#f5c9a4', '#e0ac8d', '#c98e6b'][Math.floor(place.hue * 3) % 3];
  stamp(out, [pose.body], x + 2, y + 3, '#8ab4f8');
  stamp(out, [pose.head], x + 2, y + 1, skin);
  stamp(out, [pose.arms], x + 1, y + 3, skin);
  stamp(out, [pose.prop], x + 4, y + 3, pose.accent);

  // 桌上一台小屏：状态色（done 绿 / failed 红 / blocked 黄 / 其他蓝）
  const SCREEN = {
    done: '#4ade80', failed: '#f87171', blocked: '#fbbf24', running: '#7dd3fc', dispatched: '#a78bfa',
  }[st.status] || '#64748b';
  rect(out, x + 5, y + 2, 2, 2, SCREEN, 0.9);
  rect(out, x + 5, y + 4, 2, 1, OUTLINE);

  // 引擎真实状态 → 工位上的可见信号。这是"场景随真实 hook 事件变化"的落点：
  // 不同引擎状态必须画出**不同**的像素，否则状态变了画面却不变，等于没有联动。
  // 位置全部来自 sessionId 的哈希（确定性），不做逐帧动画。
  const engine = st.engineState;
  const busy = engine && engine !== 'idle' && engine !== 'sleeping';
  if (busy) {
    // 头顶信号条：状态不同 → 条数/颜色不同
    const ENGINE_SIGNAL = {
      thinking: { dots: 3, color: '#7dd3fc' },
      working: { dots: 1, color: '#4ade80' },
      juggling: { dots: 2, color: '#c084fc' },
      notification: { dots: 3, color: '#fb7185' },
      attention: { dots: 2, color: '#fbbf24' },
      sweeping: { dots: 2, color: '#fbbf24' },
      carrying: { dots: 1, color: '#c084fc' },
    }[engine] || { dots: 1, color: '#4ade80' };
    for (let i = 0; i < ENGINE_SIGNAL.dots; i += 1) {
      const jitter = Math.floor(rand() * 2); // 0/1 格的确定性错位
      rect(out, x + 1 + i * 2, y - 2 - jitter, 1, 1, ENGINE_SIGNAL.color, 0.9);
    }
    // 屏幕高光：只有真在跑才有
    rect(out, x + 5, y + 2, 2, 1, '#ffffff', 0.35);
  }
  // 睡觉的工位：屏幕暗一档（idle/无会话的工位不加任何信号）
  if (engine === 'sleeping') {
    rect(out, x + 5, y + 2, 2, 2, '#334155', 0.5);
  }
  // 工单账本状态（人确认推进的）与引擎状态是两回事：单独用一个小台灯表示，
  // 这样"工单已派发但会话还没动"和"会话在跑"是两件能分别看见的事。
  if (st.status === 'running' || st.status === 'dispatched') {
    const bob = Math.floor(rand() * 3);
    rect(out, x + 7, y - 3 - bob, 1, 1, '#fbbf24', 0.75);
  }

  return { x, y };
}

/**
 * 工单看板数据 → 场景 SVG。
 * @param items 工位输入数组（工单 + 可选 session 信息）
 * @param opts {seed 额外扰动（默认按 id 列表确定性生成）}
 * @returns {svg, stations} SVG 字符串 + 每个工位的定位（信封飞行用）
 */
function renderAgentScene(items = [], opts = {}) {
  const list = (Array.isArray(items) ? items : []).slice(0, MAX_STATIONS).map(normalizeStation);
  const seed = opts.seed || list.map((s) => s.id).join(',');
  const out = [];

  // 房间：墙 + **多层**地板（v0.7 起 3 行工位）。
  //
  // 为什么必须分层：工位从 2 行扩到 3 行后，只有一层地板的话，第 2、3 行会悬空挂在
  // 墙上 —— 那不是透视效果，是没画地板。所以每行工位配一条自己的地板带。
  //
  // ⚠️ 每行的地板线**由行号直接算出**（floorYForRow），不要写成
  // `Math.max(FLOOR_Y, deskY + k)` —— FLOOR_Y 是**最前排**的地板线，用它兜底会把
  // 上层地板带全拉到同一条线上，分层就没了（v0.7 初次实现正是这么错的）。
  rect(out, 0, 0, GW, WALL_H, WALL);
  const floorRand = mulberry32(hashStr(`orch-floor:${seed}`));
  // 地板同样**远排先画、近排后画**（与工位同一个方向，两者才能对齐）：
  // floorLineForRow 随 row 递减，所以循环要从 ROWS-1 倒着走。
  // 近处的地板带画在后面，才能盖住远处地板带的边缘，不会出现"地板穿过小人"的错位。
  for (let row = ROWS - 1; row >= 0; row -= 1) {
    const bandTop = floorLineForRow(row);
    const bandH = GH - bandTop;
    if (bandH <= 0) continue;
    // 上层压暗一点，做出远近层次（row 0 = 最前排，最亮）
    const depth = 0.6 + 0.4 * (row / Math.max(1, ROWS - 1));
    rect(out, 0, bandTop, GW, Math.min(2, bandH), FLOOR_A, depth);
    rect(out, 0, bandTop + 2, GW, bandH - 2, FLOOR_B, depth);
    // 地板缝：数量跟这条带的面积走
    const seams = Math.max(4, Math.round((GW * bandH) / 700));
    for (let i = 0; i < seams; i += 1) {
      rect(
        out,
        Math.floor(floorRand() * (GW - 2)),
        bandTop + 2 + Math.floor(floorRand() * Math.max(1, bandH - 2)),
        2, 1, '#37304f', 0.7 * depth,
      );
    }
  }

  // 工位绘制顺序：**远排先画，近排后画**（SVG 后画覆盖先画，近的才能挡住远的）。
  // row 0 的地板线 y 最大（最靠近观者），所以按 y **升序**排 —— 远的（y 小）先落笔，
  // 近的（y 大）后落笔并正确遮住它。y 相同按原索引兜底，保证确定性。
  // 用带 y 排序的副本，不打乱 list 本身（stations 数组顺序仍按 id，与画序解耦）。
  const stations = [];
  const drawOrder = list
    .map((st, i) => ({ st, i, place: layout(i, seed) }))
    .sort((a, b) => a.place.y - b.place.y || a.i - b.i);
  for (const { st, i, place } of drawOrder) {
    const pos = drawStation(out, st, { ...place, index: i }, seed);
    stations.push({
      id: st.id,
      title: st.title,
      status: st.status,
      action: st.action,
      agent: st.agent,
      sessionId: st.sessionId,
      engineState: st.engineState,
      x: pos.x,
      y: pos.y,
      icon: STATUS_ICONS[st.status] || '·',
    });
  }
  // stations 的顺序对调用方（信封路线、UI 列表）要稳定 → 按原输入顺序排回去
  stations.sort((a, b) => String(a.id).localeCompare(String(b.id)));

  if (!list.length) {
    // 没有工单时不画空房间，给一句安静的话（同一状态永远同一句）
    rect(out, 70, FLOOR_Y - 6, 20, 1, '#4b4568');
  }

  const title = `Agent 工位 · ${list.length} 个`;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GW * CELL} ${GH * CELL}" preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges" role="img" aria-label="${title}">`,
    `<title>${title}</title>`,
    ...out,
    '</svg>',
  ].join('');
  return { svg, stations };
}

/**
 * 飞行信封的路径：两条工位之间的中点。渲染层用 CSS transform 做移动，
 * 本函数只算起点/终点/控制点 —— **不做逐帧 JS 动画**。
 */
function envelopeRoute(from, to) {
  const a = { x: (from && from.x) || 0, y: (from && from.y) || 0 };
  const b = { x: (to && to.x) || 0, y: (to && to.y) || 0 };
  return {
    from: a,
    to: b,
    // 抛物线控制点：中点抬高，纯 CSS 的 translate + 一个静态 --lift 变量即可表达
    lift: Math.max(6, Math.round(Math.abs(b.x - a.x) / 2)),
  };
}

/** 为一组信封算好路线（起点工位必须存在，否则返回 null 让调用方跳过）。 */
function planEnvelopes(stations = [], pairs = []) {
  const byId = new Map((stations || []).map((s) => [s.id, s]));
  const out = [];
  for (const [fromId, toId, ticketId] of pairs || []) {
    const from = byId.get(fromId);
    const to = byId.get(toId);
    if (!from || !to) continue; // 找不到工位就不画，不猜位置
    out.push({ ticketId: ticketId || '', ...envelopeRoute(from, to) });
  }
  return out;
}

module.exports = {
  CELL,
  GW,
  GH,
  FLOOR_Y,
  ROW_H,
  WALL_H,
  DESK_DROP,
  MAX_STATIONS,
  COLS,
  ROWS,
  POSE,
  STATUS_ICONS,
  actionFor,
  normalizeStation,
  floorLineForRow,
  floorYForRow,
  layout,
  renderAgentScene,
  envelopeRoute,
  planEnvelopes,
};