// world/orch/tickets.js
// desktop-world · 工单数据模型（纯函数优先，可直接单测）。
//
// 对象模型借鉴 munder-difflin 的 Ticket / task ledger（不抄代码），但**编排对象是
// 已有的、可被观察的 coding agent 会话**，不是自己拉起来的 PTY。所以一张工单的
// "目标 agent" 落点是 agents/registry.js 里已注册、且被 src/agent-gate.js 放行的 agent；
// 工单本身不含任何命令、argv 或进程控制字段 —— 本模块**没有能力**spawn 进程。
//
// 工单 id：ORCH-001 形式，按 tickets.json 里已存在的最大序号 +1 递增（确定性、可重入）。
// 拆分器：本地确定性规则（按连接词/标点切句 → 归一 → 逐条成单），**不调 LLM**。
'use strict';

const { STATUSES, STATUS_LABELS } = require('./paths');

const ID_RE = /^ORCH-(\d{3,})$/;
const ID_WIDTH = 3;
const MAX_SEQ = 999; // ORCH-999 之后不再自动发号，宁可报错也不进 ORCH-1000 撞四位宽

/** id → 序号；非法 id 返回 0（不是有效工单，参与 max 时自然被忽略）。 */
function seqOf(id) {
  const m = ID_RE.exec(String(id || ''));
  return m ? Number(m[1]) : 0;
}

/** 序号 → id（补零到至少 3 位）。 */
function formatId(seq) {
  const n = Number(seq);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`非法工单序号：${seq}`);
  return `ORCH-${String(n).padStart(ID_WIDTH, '0')}`;
}

/**
 * 从已存在的 id 列表算出下一个 id。纯函数，调用方自己决定写不写盘。
 * 纯 id 列表（忽略非法项）→ 单调递增，不受数组顺序影响。
 */
function nextTicketId(existingIds = []) {
  const max = (existingIds || []).reduce((acc, id) => Math.max(acc, seqOf(id)), 0);
  if (max >= MAX_SEQ) throw new Error(`工单序号已用尽（上限 ORCH-${MAX_SEQ}）`);
  return formatId(max + 1);
}

/** 一批新草案的连续发号：从同一批 id 出发逐个 +1（不读盘，纯函数）。 */
function allocateIds(count, existingIds = []) {
  let max = (existingIds || []).reduce((acc, id) => Math.max(acc, seqOf(id)), 0);
  if (max + count > MAX_SEQ) throw new Error(`工单序号不足：还需要 ${count} 个，只剩 ${MAX_SEQ - max} 个`);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    max += 1;
    out.push(formatId(max));
  }
  return out;
}

// ---------- 状态机 ----------

const STATUS_SET = new Set(STATUSES);

/** 允许的状态迁移。draft 可直达 confirmed/blocked；blocked 可回到 draft 重新改派。 */
const TRANSITIONS = Object.freeze({
  draft: ['confirmed', 'blocked'],
  confirmed: ['dispatched', 'draft', 'blocked'],
  dispatched: ['running', 'failed', 'blocked', 'confirmed'],
  running: ['done', 'failed', 'blocked'],
  done: [],
  failed: ['blocked', 'confirmed'],
  blocked: ['draft', 'confirmed'],
});

function canTransition(from, to) {
  if (from === to) return true;
  if (!STATUS_SET.has(from) || !STATUS_SET.has(to)) return false;
  return (TRANSITIONS[from] || []).includes(to);
}

function isTerminalStatus(status) {
  return status === 'done';
}

/** 还没派出去的工单（人在确认阶段的那批）。 */
function isPreDispatch(status) {
  return status === 'draft' || status === 'confirmed';
}

// ---------- 依赖图 ----------

function depsOf(ticket) {
  return Array.isArray(ticket && ticket.dependsOn) ? ticket.dependsOn.filter((d) => typeof d === 'string' && d) : [];
}

/**
 * 依赖成环检测（三色 DFS）。返回所有环，每个环是成环的 id 数组（不重复首项）。
 * 无环返回 []。这是 dispatch 的硬闸门之一，也是单测的主目标之一。
 *
 * 实现说明：显式栈模拟递归，每帧记自己"正在看第几个依赖"（i），只有依赖看完了才
 * 把该节点标 BLACK。**顺序很关键** —— 若在"把子节点压栈"之后立刻标 BLACK，
 * 父节点就永远不是 GREY，回边（真正的环）就检测不���了（三节点环会漏成无环）。
 */
function findCycles(tickets = []) {
  const list = Array.isArray(tickets) ? tickets : [];
  const byId = new Map();
  for (const t of list) {
    if (t && typeof t.id === 'string' && t.id && !byId.has(t.id)) byId.set(t.id, t);
  }
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map();
  for (const id of byId.keys()) color.set(id, WHITE);
  const cycles = [];
  const seen = new Set();

  const record = (cycle) => {
    if (!cycle.length) return;
    const key = cycleKey(cycle);
    if (!key || seen.has(key)) return;
    seen.add(key);
    cycles.push(cycle);
  };

  for (const start of byId.keys()) {
    if (color.get(start) !== WHITE) continue;
    color.set(start, GREY);
    const stack = [{ id: start, deps: depsOf(byId.get(start)), i: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      // 这一帧的依赖都看完了 → 回溯，标 BLACK
      if (frame.i >= frame.deps.length) {
        color.set(frame.id, BLACK);
        stack.pop();
        continue;
      }
      const dep = frame.deps[frame.i];
      frame.i += 1;
      if (!byId.has(dep)) continue; // 悬空依赖另由 checkDependencies 报，不算成环
      const c = color.get(dep);
      if (c === GREY) {
        // 回边：栈上从 dep 到栈顶这一段就是一个环
        const path = stack.map((f) => f.id);
        const at = path.indexOf(dep);
        record(at >= 0 ? path.slice(at) : [dep]);
      } else if (c === WHITE) {
        color.set(dep, GREY);
        stack.push({ id: dep, deps: depsOf(byId.get(dep)), i: 0 });
      }
      // BLACK：已完整展开过，无需再走
    }
  }
  return cycles;
}

/** 环的规范化键：旋转到最小字典序起点，让 A→B→A 与 B→A→B 视为同一个环。 */
function cycleKey(cycle) {
  const nodes = cycle.slice();
  if (nodes.length > 1 && nodes[0] === nodes[nodes.length - 1]) nodes.pop();
  if (!nodes.length) return '';
  let best = null;
  for (let i = 0; i < nodes.length; i += 1) {
    const rotated = nodes.slice(i).concat(nodes.slice(0, i));
    const key = rotated.join('>');
    if (best === null || key < best) best = key;
  }
  return best;
}

/** 悬空依赖 / 自依赖：依赖了不存在的 id，或依赖自己。成环之外的另一种非法依赖。 */
function checkDependencies(tickets = []) {
  const list = Array.isArray(tickets) ? tickets : [];
  const ids = new Set();
  for (const t of list) if (t && typeof t.id === 'string') ids.add(t.id);
  const problems = [];
  for (const t of list) {
    for (const dep of depsOf(t)) {
      if (dep === t.id) problems.push({ id: t.id, dep, kind: 'self' });
      else if (!ids.has(dep)) problems.push({ id: t.id, dep, kind: 'missing' });
    }
  }
  return problems;
}

/** 拓扑序（Kahn）。有环时返回 null —— 调用方应先跑 findCycles。 */
function topoOrder(tickets = []) {
  const list = Array.isArray(tickets) ? tickets : [];
  const byId = new Map();
  for (const t of list) if (t && typeof t.id === 'string' && !byId.has(t.id)) byId.set(t.id, t);
  const indeg = new Map();
  for (const id of byId.keys()) indeg.set(id, 0);
  for (const t of byId.values()) {
    for (const dep of depsOf(t)) if (byId.has(dep)) indeg.set(t.id, indeg.get(t.id) + 1);
  }
  // 稳定排序：同层内按 id 字典序，结果与输入顺序无关（确定性）
  const ready = [...byId.keys()].filter((id) => indeg.get(id) === 0).sort();
  const out = [];
  while (ready.length) {
    const id = ready.shift();
    out.push(id);
    for (const t of byId.values()) {
      if (!depsOf(t).includes(id)) continue;
      indeg.set(t.id, indeg.get(t.id) - 1);
      if (indeg.get(t.id) === 0) {
        ready.push(t.id);
        ready.sort();
      }
    }
  }
  return out.length === byId.size ? out : null;
}

// ---------- 确定性拆分器 ----------

// 切句用的分隔符：中英文标点 + 连接词。**确定性规则的唯一来源**，不含随机、不含模型。
const CLAUSE_SPLIT_RE = /[，,。；;、\n]+|(?:\s*(?:然后|接着|再|并且|以及|同时|另外|最后)\s*)/g;
// 过短的碎片不单独成单（"OK"、"嗯"这类），但也不静默丢弃：并入相邻的一条。
// 阈值按 CJK 定的 —— 3 个汉字（"读代码"）本身就是完整子句，2 个（"OK"）才是碎片。
// 用 4 会在中文里把"改实现""跑测试"这类真子句误并成一条，工单就拆少了。
const MIN_CLAUSE_LEN = 3;
const MAX_TICKETS = 8;

// 动作类型 → 建议的验收标准模板。目标是让每张工单都带**可判定**的完成条件，
// 而不是把目标原样抄一遍。动作词表与 scene-agents.js 的 POSE 一一对应：
// 工单的 action 字段一路带到场景姿态，两边不能各说一套。
const ACCEPTANCE_TEMPLATES = {
  read: ['已读范围与结论落到 blackboard', '指明后续可执行的改动点'],
  change: ['改动已落盘且 diff 可查', '改动说明写回 blackboard'],
  verify: ['验证方式与实际结果写回 blackboard', '失败项如实记录，不掩盖'],
  test: ['相关测试可重复运行且通过', '测试结论写回 blackboard'],
  docs: ['文档/注释已更新', '变更点写回 blackboard'],
  sweeping: ['清理/归档范围已列明', '误删风险已逐项确认'],
  carrying: ['搬运来源与目标路径写回 blackboard', '数据完整性已核对'],
  attention: ['沟通结论写回 blackboard', '待确认事项已列给用户'],
  generic: ['产出物可被下一个工单接续', '结论写回 blackboard'],
};

// 关键词 → 动作类型。顺序即优先级：先特异（整理/搬运/沟通）后通用（改/读），
// 与 world/live/pomodoro.js 的 taskActionFor 同一纪律；全落空回退 generic。
const ACTION_RULES = [
  [/整理|清理|归纳|收拾|归档|删除|clean|tidy/i, 'sweeping'],
  [/搬|下载|移动|拷贝|迁移|同步|move|copy|download|sync/i, 'carrying'],
  [/聊|沟通|会议|讨论|对齐|回复|chat|meeting/i, 'attention'],
  [/测试|单测|回归|覆盖率|coverage|\btest\b/i, 'test'],
  [/验证|验收|检查|verify|check|确认/i, 'verify'],
  [/文档|注释|readme|docs|说明/i, 'docs'],
  [/读|看|研究|调研|梳理|分析|定位|排查|review|read|research|理解|学习/i, 'read'],
  [/重构|修复|实现|新增|改|写|做|建|搭|build|refactor|fix|implement|add/i, 'change'],
];

function classifyAction(text) {
  const t = String(text || '');
  for (const [re, action] of ACTION_RULES) if (re.test(t)) return action;
  return 'generic';
}

function acceptanceFor(action, text) {
  const base = ACCEPTANCE_TEMPLATES[action] || ACCEPTANCE_TEMPLATES.generic;
  const head = String(text || '').trim().slice(0, 60);
  return head ? [head, ...base] : [...base];
}

/** 归一化一条子句：收空白、去序号前缀、限长。 */
function normalizeClause(raw) {
  const t = String(raw || '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s]*[（(]?[0-9①-⑩]+[)）]?[\.、:：]?\s*/, '')
    .trim();
  return t.slice(0, 160);
}

/**
 * 确定性拆分：目标文本 → 子句列表（不含任何工单字段）。
 * 同一输入永远同一输出：无随机、无时间戳、无模型调用。
 *
 * 碎片合并用"前挂缓冲"实现：短于 MIN_CLAUSE_LEN 的片段先攒在 pending 里，
 * 等下一条真子句到来时拼在它**前面**；若后面没有了才拼到上一条**后面**。
 * 这样开头的碎片（"OK，然后修复 x"）不会被单独立成一张工单，结尾的碎片也不会丢。
 */
function splitClauses(goal) {
  const text = String(goal == null ? '' : goal).replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  const parts = text
    .split(CLAUSE_SPLIT_RE)
    .map(normalizeClause)
    .filter(Boolean);
  const merged = [];
  let pending = '';
  const push = (clause) => {
    const joined = pending ? `${pending} ${clause}`.trim() : clause;
    pending = '';
    merged.push(joined.slice(0, 160));
  };
  for (const part of parts) {
    if (part.length >= MIN_CLAUSE_LEN) push(part);
    else pending = pending ? `${pending} ${part}`.trim() : part;
  }
  // 收尾：还攒着碎片（结尾的短片段）→ 并到最后一条；一条都没有就自己成一条
  if (pending) {
    if (merged.length) merged[merged.length - 1] = `${merged[merged.length - 1]} ${pending}`.trim().slice(0, 160);
    else merged.push(pending);
  }
  return merged.filter(Boolean).slice(0, MAX_TICKETS);
}

/**
 * 目标 → 工单草案（确定性）。
 *
 * 依赖规则：默认**线性链**（第 N 条依赖第 N-1 条），因为子句通常是"先做 A 再做 B"的
 * 顺序叙述；`--independent` 走并行（无依赖）。刻意不做语义推断 —— 确定性优先，
 * 人在 CLI 确认那一步（stage ③）可以改派/删/加依赖。
 *
 * @param goal 目标文本
 * @param opts { agent 目标 agent id, cwd 工作目录, existingIds 已发号, independent 是否并行,
 *               dependsOn 额外的外部依赖 id 数组（只加在第一条上） }
 * @returns 工单数组（status 一律 draft —— 进入世界的第一状态永远是"待人确认"）
 */
function draftTickets(goal, opts = {}) {
  const clauses = splitClauses(goal);
  if (!clauses.length) return [];
  const ids = allocateIds(clauses.length, opts.existingIds || []);
  const baseDeps = Array.isArray(opts.dependsOn) ? opts.dependsOn.filter(Boolean) : [];
  const agent = typeof opts.agent === 'string' ? opts.agent.trim() : '';
  const cwd = typeof opts.cwd === 'string' ? opts.cwd.trim() : '';
  const independent = opts.independent === true;

  return clauses.map((clause, i) => {
    const action = classifyAction(clause);
    const dependsOn = independent ? [...baseDeps] : [...baseDeps, ...(i > 0 ? [ids[i - 1]] : [])];
    return {
      id: ids[i],
      title: clause,
      action,
      agent,
      cwd,
      dependsOn,
      status: 'draft',
      acceptance: acceptanceFor(action, clause),
    };
  });
}

/** 看板视图：按状态列分组（列顺序 = STATUSES 顺序），组内按 id 升序（确定性）。 */
function groupByStatus(tickets = []) {
  const cols = new Map(STATUSES.map((s) => [s, []]));
  for (const t of tickets || []) {
    if (!t || !STATUS_SET.has(t.status)) continue;
    cols.get(t.status).push(t);
  }
  const out = {};
  for (const s of STATUSES) {
    out[s] = cols.get(s).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }
  return out;
}

/** 汇总计数（看板顶栏用）。 */
function summarize(tickets = []) {
  const counts = {};
  for (const s of STATUSES) counts[s] = 0;
  for (const t of tickets || []) {
    if (t && STATUS_SET.has(t.status)) counts[t.status] += 1;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const pending = counts.draft + counts.confirmed;
  return { total, pending, active: counts.dispatched + counts.running, counts };
}

function statusLabel(status) {
  return STATUS_LABELS[status] || String(status || '');
}

/** 工单合法性（写入前守门；id/状态由本模块生成，外部手改的 file 才需要）。 */
function validateTicket(ticket) {
  const errors = [];
  if (!ticket || typeof ticket !== 'object') return ['工单不是对象'];
  if (!ID_RE.test(String(ticket.id || ''))) errors.push(`非法工单 id：${ticket.id}`);
  if (!STATUS_SET.has(ticket.status)) errors.push(`非法状态：${ticket.status}`);
  if (typeof ticket.title !== 'string' || !ticket.title.trim()) errors.push('缺 title');
  for (const dep of depsOf(ticket)) {
    if (!ID_RE.test(dep)) errors.push(`非法依赖 id：${dep}`);
  }
  if (!Array.isArray(ticket.acceptance)) errors.push('缺 acceptance 数组');
  return errors;
}

module.exports = {
  ID_RE,
  MAX_SEQ,
  STATUSES,
  TRANSITIONS,
  seqOf,
  formatId,
  nextTicketId,
  allocateIds,
  canTransition,
  isTerminalStatus,
  isPreDispatch,
  depsOf,
  findCycles,
  checkDependencies,
  topoOrder,
  splitClauses,
  classifyAction,
  acceptanceFor,
  draftTickets,
  groupByStatus,
  summarize,
  statusLabel,
  validateTicket,
};