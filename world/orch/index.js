// world/orch/index.js
// desktop-world · 编排层门面：把工单账本 / 黑板 / 收件箱 / 场景拼成一个 UI 视图。
//
// 这一层是**只读聚合**：它不写任何文件。写入只有三条路：
//   store.appendTickets / setStatus（人确认后的落账）
//   blackboard.append（工单收敛后的回报）
//   mailbox.deliver（派发时的投递）
// 三条都在 CLI（stage ③ 人确认）之后发生，UI 只负责呈现。
//
// 视图里的 agent 状态有两个来源，优先级明确：
//   ① 引擎真实状态（session snapshot 的 state，来自 src/agent-runtime-main.js 收敛）
//   ② 工单状态（tickets.json 里的账本状态）
// ① 只影响"这一格在不在动"，不改变工单状态本身 —— 工单状态只由人确认和收敛推进。
'use strict';

const fs = require('fs');
const path = require('path');
const { ORCH_DIR, ticketsFile, blackboardFile, mailboxDir } = require('./paths');
const store = require('./store');
const ticketsModel = require('./tickets');
const blackboard = require('./blackboard');
const mailbox = require('./mailbox');
const scene = require('./scene-agents');

/**
 * 从 session snapshot 里挑出与工单相关的会话，按 agentId 归组。
 * snapshot 形状来自 src/state-session-snapshot.js 的 buildSessionSnapshot：
 *   { sessions: [{ id, agentId, agentName, state, badge, cwd, displayTitle, ... }] }
 * 这里**只读**，不修改 snapshot（它是 Dashboard/HUD/notification 的共享合约）。
 */
function indexSessions(snapshot) {
  const map = new Map();
  const sessions = snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  for (const s of sessions) {
    if (!s || typeof s !== 'object') continue;
    const agentId = String(s.agentId || '');
    if (!agentId) continue;
    if (!map.has(agentId)) map.set(agentId, []);
    map.get(agentId).push({
      id: String(s.id || ''),
      agentId,
      agentName: String(s.agentName || agentId),
      state: String(s.state || 'idle'),
      badge: String(s.badge || 'idle'),
      cwd: String(s.cwd || ''),
      title: String(s.displayTitle || s.sessionTitle || ''),
      headless: s.headless === true,
    });
  }
  return map;
}

/**
 * 一张工单当前接在哪个 session 上。
 * 优先级：同 cwd 的会话 > 正在干活的会话 > 任意会话。
 * 同 cwd 排在最前，是因为工单本身就指定了 cwd —— 目录一致比"恰好在忙"更能说明
 * 这张工单会被谁接走。
 */
function matchSession(ticket, byAgent) {
  const sessions = byAgent.get(String(ticket.agent || '')) || [];
  if (!sessions.length) return null;
  const usable = sessions.filter((s) => !s.headless);
  const pool = usable.length ? usable : sessions;
  const sameCwd = ticket.cwd
    ? pool.find((s) => s.cwd && path.resolve(s.cwd) === path.resolve(ticket.cwd))
    : null;
  if (sameCwd) return sameCwd;
  const alive = pool.filter((s) => s.state !== 'idle' && s.state !== 'sleeping');
  return alive[0] || pool[0] || null;
}

/**
 * 组装 UI 视图。
 * @param opts {root 编排目录, snapshot session snapshot（可空）, limit 黑板条数}
 */
function buildOrchView(opts = {}) {
  const root = opts.root || ORCH_DIR;
  const ticketsFilePath = ticketsFile(root);
  const ledger = store.load(ticketsFilePath);
  const tickets = ledger.tickets;
  const byAgent = indexSessions(opts.snapshot);

  // 工位：工单 + 匹配到的真实会话状态。
  // matchSession 只算一次并复用 —— 工单视图和场景用的是同一份匹配结果，
  // 两边各算一次的话，sessions 顺序一变就可能出现"卡片说接了会话、工位说没接"。
  const matched = tickets.map((t) => ({ ticket: t, session: matchSession(t, byAgent) }));
  const items = matched.map(({ ticket: t, session }) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    agent: t.agent,
    agentName: (session && session.agentName) || t.agent,
    cwd: t.cwd,
    sessionId: session ? session.id : '',
    state: session ? session.state : '',
  }));

  const { svg, stations } = scene.renderAgentScene(items);

  // 飞行信封：按依赖关系画（有 dependsOn 的工单 → 一封信从前置飞向后继）
  const pairs = [];
  for (const t of tickets) {
    for (const dep of ticketsModel.depsOf(t)) {
      pairs.push([dep, t.id, t.id]);
    }
  }
  const envelopes = scene.planEnvelopes(stations, pairs).slice(0, 12);

  // 收件箱概览：按 session 统计未读（UI 用来显示"有几封信没人读"）
  const inbox = [];
  try {
    for (const name of fs.readdirSync(mailboxDir(root))) {
      if (!name.endsWith('.json')) continue;
      const sessionId = name.slice(0, -5);
      const unread = mailbox.unreadCount(sessionId, root);
      if (unread) inbox.push({ sessionId, unread });
    }
  } catch {
    /* 目录还不存在（还没派过单）：概览为空，不是错误 */
  }
  inbox.sort((a, b) => b.unread - a.unread || a.sessionId.localeCompare(b.sessionId));

  return {
    root,
    active: tickets.length > 0,
    summary: ticketsModel.summarize(tickets),
    columns: ticketsModel.groupByStatus(tickets),
    tickets: matched.map(({ ticket: t, session }) => ({
      ...t,
      statusLabel: ticketsModel.statusLabel(t.status),
      sessionId: session ? session.id : '',
    })),
    scene: { svg, stations },
    envelopes,
    inbox: inbox.slice(0, 8),
    facts: blackboard.list(blackboardFile(root), { ticketId: opts.limitTicketIds }).slice(0, opts.limit || 20),
    graph: ticketsModel.topoOrder(tickets) || null,
    // 有环时明确告诉 UI"依赖图不可用"，别让界面假装正常
    cycles: ticketsModel.findCycles(tickets),
  };
}

/** 空视图（还没建过任何工单时）—— 界面据此整段静默。 */
function isOrchEmpty(view) {
  return !view || !view.active;
}

module.exports = {
  ORCH_DIR,
  indexSessions,
  matchSession,
  buildOrchView,
  isOrchEmpty,
};