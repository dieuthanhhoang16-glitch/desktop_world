// world/orch/console-snapshot.js
// desktop-world · 编排台快照（纯函数，无 IO）：工单账本 + run 回执 + 黑板事实 → 一份渲染层唯一认的视图。
//
// 为什么单独立这个模块：orchestra.html / IPC / 测试三边必须看同一份数据形状，
// 各自拼账本必然漂移（泳道口径、latestRun 选法、audit 推导都会长出两份说法）。
// 本模块只做派生与归组，所有源头数据由调用方读盘传入：
//   {tickets, runs, roadmapSlice, jevStatus, blackboardFacts}
// 形状约定见 docs/design/ORCH-CONSOLE-R2.md §4。
'use strict';

// 泳道划分：needs=草案+失败+阻塞（等人推动）；working=已确认+已派发+执行中；done=完成。
const LANE_OF_STATUS = Object.freeze({
  draft: 'needs',
  failed: 'needs',
  blocked: 'needs',
  confirmed: 'working',
  dispatched: 'working',
  running: 'working',
  done: 'done',
});

const LANES = Object.freeze(['needs', 'working', 'done']);

function laneOf(status) {
  return LANE_OF_STATUS[status] || 'needs';
}

/** runs 数组按 startedAt 取最新（字符串 ISO 序即可比）；空数组 → null。 */
function latestRunOf(runs, ticketId) {
  let best = null;
  for (const r of runs || []) {
    if (!r || r.ticketId !== ticketId) continue;
    if (!best || String(r.startedAt || '') > String(best.startedAt || '')) best = r;
  }
  return best ? normalizeRun(best) : null;
}

/**
 * run 归一到 snapshot 形状（规格 §4 runs[] 条目）。
 * worktreeDir/runDir 由上游（executor.list）带上；缺数据时给空串而非 undefined，
 * 渲染层不判 undefined。
 */
function normalizeRun(r) {
  return {
    runId: String(r.runId || ''),
    ticketId: r.ticketId ? String(r.ticketId) : '',
    role: String(r.role || ''),
    model: String(r.model || ''),
    status: String(r.status || ''),
    startedAt: String(r.startedAt || ''),
    finishedAt: r.finishedAt ? String(r.finishedAt) : null,
    pid: typeof r.pid === 'number' ? r.pid : undefined,
    sessionId: r.sessionId ? String(r.sessionId) : undefined,
    worktreeDir: String(r.worktreeDir || (r.worktree && r.worktree.path) || ''),
    runDir: String(r.runDir || ''),
    changedFiles: Array.isArray(r.changedFiles) ? r.changedFiles : [],
    error: String(r.error || ''),
    parentRunId: r.parentRunId ? String(r.parentRunId) : undefined,
    active: r.active === true,
    elapsedMs: typeof r.elapsedMs === 'number' ? r.elapsedMs : undefined,
  };
}

/** 工单 → 泳道卡片：账本字段原样 + latestRun + audit 派生。 */
function cardOf(ticket, runs) {
  const hasRun = (runs || []).some((r) => r && r.ticketId === ticket.id);
  return {
    id: String(ticket.id || ''),
    title: String(ticket.title || ''),
    status: String(ticket.status || ''),
    agent: String(ticket.agent || ''),
    agentName: String(ticket.agentName || ticket.agent || ''),
    cwd: String(ticket.cwd || ''),
    acceptance: Array.isArray(ticket.acceptance) ? ticket.acceptance : [],
    acceptanceDone: Array.isArray(ticket.acceptanceDone) ? ticket.acceptanceDone : undefined,
    risk: ticket.risk != null ? ticket.risk : undefined,
    latestRun: latestRunOf(runs, ticket.id),
    audit: {
      fence: hasRun, // 存在该工单的 run = 隔离围栏曾经立过
      verdict: ticket.verdict != null ? ticket.verdict : null, // 审计裁定：工单自带字段，没有就 null
      checkedAt: ticket.checkedAt != null ? ticket.checkedAt : null,
    },
  };
}

/** convergence 事实按日聚合 [{date, count}]（date=ISO 日，升序）—— 月历的唯一取数口。 */
function dailyConvergences(facts) {
  const byDay = new Map();
  for (const f of facts || []) {
    if (!f || f.kind !== 'convergence') continue;
    const at = Number(f.at);
    if (!Number.isFinite(at)) continue;
    const date = new Date(at).toISOString().slice(0, 10);
    byDay.set(date, (byDay.get(date) || 0) + 1);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, count]) => ({ date, count }));
}

/**
 * 组装编排台快照。
 * @param {object} input
 * @param {Array}  [input.tickets]        工单账本条目
 * @param {Array}  [input.runs]           run 回执（executor.list 归并后的形状即可）
 * @param {object} [input.roadmapSlice]   buildRoadmapSlice 原样
 * @param {object} [input.jevStatus]      llmStatus 原样
 * @param {Array}  [input.blackboardFacts] 黑板条目（月历聚合用）
 */
function buildConsoleSnapshot(input = {}) {
  const tickets = Array.isArray(input.tickets) ? input.tickets : [];
  const runs = (Array.isArray(input.runs) ? input.runs : []).map(normalizeRun);

  const lanes = { needs: [], working: [], done: [] };
  for (const t of tickets) {
    if (!t || typeof t !== 'object') continue;
    lanes[laneOf(t.status)].push(cardOf(t, runs));
  }

  const counts = {
    needs: lanes.needs.length,
    working: lanes.working.length,
    done: lanes.done.length,
    total: lanes.needs.length + lanes.working.length + lanes.done.length,
  };

  // 回执单（invoices）派生：泳道计数 + convergence 事实按日聚合
  const invoices = {
    needs: counts.needs,
    working: counts.working,
    done: counts.done,
    daily: dailyConvergences(input.blackboardFacts),
  };

  const activeRuns = runs.filter((r) => r.active === true || r.status === 'running').length;
  const summary = `${counts.total} 张工单：${counts.needs} 待处理、${counts.working} 进行中、${counts.done} 完成` + (activeRuns ? `；${activeRuns} 个 run 在跑` : '');

  return {
    lanes,
    counts,
    summary,
    runs,
    roadmap: input.roadmapSlice != null ? input.roadmapSlice : null,
    jev: input.jevStatus != null ? input.jevStatus : null,
    invoices,
  };
}

module.exports = { buildConsoleSnapshot, LANE_OF_STATUS, dailyConvergences };
