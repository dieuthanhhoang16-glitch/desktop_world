// world/orch/tree-model.js
// desktop-world · 调度树（Agent Tree）视图的纯逻辑层。
//
// 输入是 buildOrchView() 的只读聚合（index.js）+ decisions.list() 的复盘记录，
// 输出是模板直接可渲染的树形 view-model：
//
//   { main, judgment|null, lanes, edges, converge, signals, keeper, log, status }
//
// 纪律（与 scene.js / view-model 同名约定）：
//   ① 纯函数：无任何 IO，不写盘，不读环境；同一份输入永远产出同一份输出。
//   ② 不发明状态：账本状态（tickets.json）与引擎信号（session snapshot）分开搬运，
//      UI 上这是两盏灯，绝不合并成一个"推测状态"。
//   ③ 进度条没有完成度字段可用，映射的是状态机位置（诚实且免费）：
//      draft 10% / confirmed 25% / dispatched 50% / running 75% / done 100%；
//      failed / blocked 停在自己被卡住的那一格，由 UI 标色，不在逻辑层假装前进。
'use strict';

const protocol = require('./protocol'); // 纯函数零 IO：五态表/文案的唯一真相

// ── 状态 → 进度映射 ─────────────────────────────────────────────
// failed/blocked 是"停格"：停在出事前的位置，由模板标红/橙而不是继续走。
const PROGRESS_BY_STATUS = Object.freeze({
  draft: 0.1,
  confirmed: 0.25,
  dispatched: 0.5,
  running: 0.75,
  done: 1,
  failed: 0.75,
  blocked: 0.25,
});

// JEV 判断条的三档（与 split.js verdictOf 同一套阈值，逻辑层只打标不裁决）
const VERDICT_SHARP = 0.6;
const VERDICT_NO = 0.4;

// 「已派发但引擎一直 idle」判定：dispatched 且匹配会话不在干活。
// 没有匹配会话（空串）也算 stale —— 信投出去了，没人接。
const IDLE_STATES = new Set(['', 'idle', 'sleeping']);

// session log 主体：黑板 kind → 日志里的"谁说的"（模板按它着色）
const WHO_BY_KIND = Object.freeze({
  fact: 'orch',
  decision: 'gate',
  blocker: 'user',
  convergence: 'orch',
  correction: 'user',
  report: 'gate', // 回执/关口推进留痕（stage-lead 写入）→ 走 gate 频道色
});

function progressOf(status) {
  return PROGRESS_BY_STATUS[String(status)] ?? 0;
}

/** JEV 概率 → 三档词。sharp ≥0.6 / split 0.4–0.6 / no ≤0.4。 */
function verdictOf(p) {
  const v = Number(p);
  if (!Number.isFinite(v)) return 'no';
  if (v >= VERDICT_SHARP) return 'sharp';
  if (v <= VERDICT_NO) return 'no';
  return 'split';
}

/**
 * 每张工单的拓扑深度（0 = 无依赖的第一列）。
 * 有环时不再信任拓扑（buildOrchView 的 graph 已置 null），所有环上节点深度归零 ——
 * UI 把它们平铺到第一列并由状态行/守门员报警，绝不假装树还成立。
 */
function laneDepths(tickets) {
  const byId = new Map();
  for (const t of tickets) byId.set(String(t.id), t);
  const memo = new Map();
  const visiting = new Set();
  const cyclic = new Set();

  function depsOf(t) {
    const deps = Array.isArray(t && t.dependsOn) ? t.dependsOn : [];
    return deps.map(String).filter((d) => byId.has(d));
  }

  function depth(id) {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) {
      cyclic.add(id);
      return 0; // 环上节点：不再递归，记 0 并由 cycles 单独报警
    }
    const t = byId.get(id);
    if (!t) return 0;
    visiting.add(id);
    let d = 0;
    for (const dep of depsOf(t)) {
      const dd = depth(dep);
      if (cyclic.has(dep)) cyclic.add(id); // 依赖环上节点的也算环的一部分
      d = Math.max(d, dd + 1);
    }
    visiting.delete(id);
    if (cyclic.has(id)) d = 0;
    memo.set(id, d);
    return d;
  }

  const depths = new Map();
  for (const t of tickets) depths.set(String(t.id), depth(String(t.id)));
  return depths;
}

/**
 * MAIN 卡的目标原文。
 * 唯一可靠来源是开单时写进黑板的那条「立单 <ids>：<goal>」fact（cli.js cmdPlan）。
 * 解析失败（手工建的账本、旧数据）退回空串 —— 模板显示「目标未立」，不编一个。
 */
function goalOf(facts) {
  const list = Array.isArray(facts) ? facts : [];
  for (const f of list) {
    const text = String((f && f.text) || '');
    const m = /^立单\s+(.+?)[：:]\s*(.+)$/s.exec(text);
    if (m && m[2]) return m[2].trim();
  }
  return '';
}

/**
 * JEV 判断层：取 decisions 里最近一条带 probs 的记录，把每条概率翻成一根条。
 * decisions 是 decisions.list() 的结果（新→旧）。
 * 没有 judgment 数据（本地确定性拆分置信度够高、从没问过 Jev）→ null，
 * 模板折叠成一行「local · 没问 Jev」。
 */
function judgmentOf(decisions) {
  const list = Array.isArray(decisions) ? decisions : [];
  const entry = list.find((d) => d && d.probs && typeof d.probs === 'object' && Object.keys(d.probs).length);
  if (!entry) return null;
  const bars = [];
  for (const [key, raw] of Object.entries(entry.probs)) {
    const p = Number(raw);
    if (!Number.isFinite(p)) continue;
    bars.push({
      key,
      // route 概率的 key 是 agent_<id>（split.js），UI 读作「路线 · <id>」
      label: key.startsWith('agent_') ? `route · ${key.slice(6)}` : key,
      p: Math.max(0, Math.min(1, p)),
      verdict: verdictOf(p),
    });
  }
  // splitable 打头，其余按概率降序 —— 每屏第一眼看到"该不该拆"
  bars.sort((a, b) => (a.key === 'splitable' ? -1 : b.key === 'splitable' ? 1 : b.p - a.p));
  return {
    at: entry.at || '',
    ok: entry.ok === true,
    source: entry.source || 'local',
    forks: list.length,
    bars,
  };
}

/**
 * 双信号：账本状态之外的第二盏灯 —— 引擎真实状态。
 * 数据源是 buildOrchView 已算好的 scene.stations（matchSession 的结果），
 * tree-model 只做读和判定，不重新匹配（两边各匹配一次会出现不一致）。
 * stale：dispatched 但引擎不在干活（含根本没匹配到会话）→「还没接活」。
 */
function signalsOf(view) {
  const byTicket = {};
  const stations = (view && view.scene && Array.isArray(view.scene.stations)) ? view.scene.stations : [];
  const engineById = new Map();
  for (const st of stations) engineById.set(String(st.id), String(st.engineState || ''));
  const tickets = Array.isArray(view && view.tickets) ? view.tickets : [];
  for (const t of tickets) {
    const id = String(t.id);
    const engine = engineById.get(id) || '';
    byTicket[id] = {
      engine,
      stale: String(t.status) === 'dispatched' && IDLE_STATES.has(engine),
    };
  }
  return { byTicket };
}

/** 守门员面板的计数与"上一次发言"（M1 只读：数据全来自账本/黑板，进程内统计留给 M2+）。 */
function keeperOf(view, decisions) {
  const tickets = Array.isArray(view && view.tickets) ? view.tickets : [];
  const blocked = tickets.filter((t) => t.status === 'blocked').length;
  const failed = tickets.filter((t) => t.status === 'failed').length;
  const cycles = Array.isArray(view && view.cycles) ? view.cycles.length : 0;
  // 发言优先级：环 > 阻塞/失败 > 最近一条 JEV 决策的原因
  let lastAdvice = '';
  if (cycles) lastAdvice = `依赖环 ${cycles} 处：先解环再派发`;
  else if (blocked) lastAdvice = `${blocked} 张阻塞：检查 agent / cwd / 依赖`;
  else if (failed) lastAdvice = `${failed} 张失败：可改派回草案`;
  else {
    const j = (Array.isArray(decisions) ? decisions : []).find((d) => d && d.reason);
    if (j) lastAdvice = `jev：${j.reason}`;
  }
  return { blocked, failed, cycles, lastAdvice };
}

/**
 * session log：黑板 facts（新→旧）翻转成终端语义的"最新在下"，
 * 只保留最后 limit 条。模板负责 HH:MM:SS 格式化（at 是 epoch ms，0 表示无时间）。
 */
function logOf(facts, limit) {
  const list = Array.isArray(facts) ? facts : [];
  return list
    .slice(0, Math.max(1, limit))
    .reverse()
    .map((f) => ({
      at: Number.isFinite(Number(f && f.at)) ? Number(f.at) : 0,
      who: WHO_BY_KIND[String(f && f.kind)] || 'orch',
      text: String((f && f.text) || ''),
      ticketIds: Array.isArray(f && f.ticketIds) ? f.ticketIds.map(String) : [],
    }));
}

/**
 * 五级窗口协作投影（输入 = index.buildRoadmapSlice() 的输出，即 stage-lead.windowStatus 的形状）。
 * 无 roadmap / 无活跃窗口 → null，UI 四段（五态条/窗口卡/回执面板/roadmap 带）整段静默。
 * 这里只做搬运与打标：五态表、文案、颜色语义全部由 protocol 供给，不就地重述。
 */
function roadmapViewOf(slice) {
  if (!slice || typeof slice !== 'object' || !slice.window) return null;
  const state = String(slice.window.state || '');
  if (!protocol.isWindowState(state)) return null;
  const currentIdx = protocol.WINDOW_STATES.indexOf(state);
  return {
    milestone: String(slice.milestone || ''),
    windowId: String(slice.windowId || ''),
    stageTitle: String(slice.window.stageTitle || ''),
    subtaskTitle: String(slice.window.subtaskTitle || ''),
    state,
    stateLabel: String(slice.stateLabel || protocol.WINDOW_STATE_LABELS[state] || state),
    soleGoal: slice.header && slice.header.soleGoal ? String(slice.header.soleGoal) : '',
    nextAllowed: slice.header && slice.header.nextAllowedState ? String(slice.header.nextAllowedState) : null,
    tickets: (Array.isArray(slice.tickets) ? slice.tickets : []).map((t) => ({
      id: String(t.id || ''),
      status: String(t.status || 'missing'),
      title: String(t.title || ''),
    })),
    // 五态条：reached = 已走过的格（含当前），current = 当前格
    strip: protocol.WINDOW_STATES.map((s, i) => ({
      id: s,
      label: protocol.WINDOW_STATE_LABELS[s],
      reached: i <= currentIdx,
      current: i === currentIdx,
    })),
    stages: (Array.isArray(slice.roadmap) ? slice.roadmap : []).map((s) => ({
      id: String(s.id || ''),
      title: String(s.title || ''),
      authorized: s.authorized === true,
      subtasks: (Array.isArray(s.subtasks) ? s.subtasks : []).map((t) => ({
        id: String(t.id || ''),
        title: String(t.title || ''),
        state: protocol.isWindowState(t.state) ? t.state : 'planning',
        stateLabel: protocol.WINDOW_STATE_LABELS[t.state] || String(t.state || ''),
        active: t.active === true,
      })),
    })),
  };
}

/**
 * 组装调度树视图。
 * @param view  buildOrchView() 的输出（可以是空视图 {active:false}，返回全空骨架）
 * @param opts  { decisions: decisions.list() 的结果（可省）, logLimit,
 *                roadmap: index.buildRoadmapSlice() 的输出（可省；五态窗口投影） }
 */
function buildTree(view, opts = {}) {
  const v = view && typeof view === 'object' ? view : {};
  const tickets = Array.isArray(v.tickets) ? v.tickets : [];
  const facts = Array.isArray(v.facts) ? v.facts : [];
  const decisions = Array.isArray(opts.decisions) ? opts.decisions : [];

  // 工单卡：原样搬运账本字段 + 计算列（progress / lane 深度在 lanes 阶段完成）
  const cards = tickets.map((t) => ({
    id: String(t.id || ''),
    title: String(t.title || ''),
    status: String(t.status || 'draft'),
    statusLabel: String(t.statusLabel || t.status || ''),
    agent: String(t.agent || ''),
    action: String(t.action || ''),
    cwd: String(t.cwd || ''),
    sessionId: String(t.sessionId || ''),
    progress: progressOf(t.status),
    acceptance: Array.isArray(t.acceptance) ? t.acceptance.map(String) : [],
    acceptanceDone: Array.isArray(t.acceptanceDone) ? t.acceptanceDone.map(Boolean) : [],
  }));

  // 分列：深度相同的工单同一列，列内按 id 升序（稳定，不随输入顺序变）
  const depths = laneDepths(tickets);
  const laneMap = new Map();
  for (const c of cards) {
    const d = depths.get(c.id) || 0;
    if (!laneMap.has(d)) laneMap.set(d, []);
    laneMap.get(d).push(c);
  }
  const lanes = [...laneMap.keys()]
    .sort((a, b) => a - b)
    .map((d) => laneMap.get(d).sort((a, b) => a.id.localeCompare(b.id)));

  // 依赖边：两端都在账本里的才画（缺端点的悬空依赖是账本问题，不画不猜）
  const ids = new Set(cards.map((c) => c.id));
  const edges = [];
  for (const t of tickets) {
    const to = String(t.id || '');
    const deps = Array.isArray(t.dependsOn) ? t.dependsOn : [];
    for (const dep of deps) {
      const from = String(dep);
      if (ids.has(from) && ids.has(to) && from !== to) edges.push({ from, to });
    }
  }

  const converge = cards.filter((c) => c.status === 'running');

  // MAIN 卡进度 = 全部工单映射值的均值（没有任何一张单时 0）
  const progress = cards.length ? cards.reduce((sum, c) => sum + c.progress, 0) / cards.length : 0;

  const summary = (v.summary && typeof v.summary === 'object') ? v.summary : {};
  const inbox = (Array.isArray(v.inbox) ? v.inbox : []).reduce((sum, i) => sum + (Number(i.unread) || 0), 0);

  // 五级窗口协作切片（与工单树正交；无 roadmap 时三段全 null，模板整段静默）
  const roadmapSlice = opts.roadmap && typeof opts.roadmap === 'object' ? opts.roadmap : null;
  const roadmapView = roadmapViewOf(roadmapSlice);

  return {
    active: v.active === true && cards.length > 0,
    // ── 窗口五态（v1.0；null = 没有活跃窗口，与 active 无关 —— 没有工单也可以有 roadmap） ──
    windowState: roadmapView ? roadmapView.state : null,
    roadmapView,
    latestReport: roadmapView && roadmapSlice && roadmapSlice.latestReport ? roadmapSlice.latestReport : null,
    main: {
      goal: goalOf(facts),
      tickets: cards.length,
      progress,
    },
    judgment: judgmentOf(decisions),
    lanes,
    edges,
    converge,
    signals: signalsOf(v),
    keeper: keeperOf(v, decisions),
    log: logOf(facts, opts.logLimit || 8),
    status: {
      total: Number(summary.total) || cards.length,
      pending: Number(summary.pending) || 0,
      active: Number(summary.active) || 0,
      inbox,
      cycles: Array.isArray(v.cycles) ? v.cycles.length : 0,
      jev: decisions.length,
    },
  };
}

module.exports = {
  PROGRESS_BY_STATUS,
  VERDICT_SHARP,
  VERDICT_NO,
  progressOf,
  verdictOf,
  laneDepths,
  goalOf,
  judgmentOf,
  signalsOf,
  roadmapViewOf,
  buildTree,
};
