// world/orch/dispatch.js
// desktop-world · 派单前的可行性检查（硬闸门）。
//
// 设计原则：**不硬派**。任一检查不满足就明确报错 + 给出修复建议，绝不"先派了再说"。
// 三个闸门：
//   ① 目标 agent 必须已安装且已启用 —— 判定**完全复用** src/agent-gate.js 的语义
//      （isAgentIntegrationInstalled / isAgentEnabled），不自造第二套名单。
//   ② cwd 必须真实存在且是目录。
//   ③ 依赖不成环、无悬空/自依赖。
//
// 权限与破坏性操作仍走 src/permission.js 原链路：本模块**不产出任何权限决定**，
// 也不新增绕过口。它只是把工单信封写进目标 session 的收件箱 —— 那个 agent 是用户
// 自己开的会话，要不要动手、要不要批准工具，仍由原有链路决定。
'use strict';

const fs = require('fs');
const agentGate = require('../../src/agent-gate');
const { isCustomApplicationId, isCustomApplicationNamespace } = require('../../src/custom-applications');
const { getAgent } = require('../../agents/registry');
const T = require('./tickets');

const CHECKS = Object.freeze({
  AGENT_UNKNOWN: 'agent-unknown',
  AGENT_NOT_INSTALLED: 'agent-not-installed',
  AGENT_DISABLED: 'agent-disabled',
  AGENT_NOT_REGISTERED: 'agent-not-registered',
  CWD_MISSING: 'cwd-missing',
  CWD_NOT_DIRECTORY: 'cwd-not-directory',
  DEP_CYCLE: 'dep-cycle',
  DEP_MISSING: 'dep-missing',
  DEP_SELF: 'dep-self',
  DEP_UNCONFIRMED: 'dep-unconfirmed',
  TICKET_INVALID: 'ticket-invalid',
});

/**
 * 目标 agent 的 gate 判定。**判定语义来自 src/agent-gate.js**，本函数只负责
 * 把结论翻译成"可派 / 不可派 + 怎么修"。
 *
 * @param agentId 目标 agent id
 * @param prefsSnapshot src/prefs.js 的 snapshot 形状（{agents, customApplications}）
 * @returns {{ok:boolean, code?:string, reason?:string, fix?:string, agentName?:string}}
 */
function checkAgent(agentId, prefsSnapshot) {
  const id = typeof agentId === 'string' ? agentId.trim() : '';
  if (!id) {
    return {
      ok: false,
      code: CHECKS.AGENT_UNKNOWN,
      reason: '工单没有指定目标 agent',
      fix: '派单前用 --agent <id> 指定目标 agent，或在确认那一步改派',
    };
  }

  // 伪造/删除的 custom- id 直接拒绝，不能降级成某个内置 agent
  if (isCustomApplicationNamespace(id) && !isCustomApplicationId(id)) {
    return {
      ok: false,
      code: CHECKS.AGENT_UNKNOWN,
      reason: `非法自定义 agent id：${id}`,
      fix: 'custom- id 必须形如 custom-<slug>-<12 位 hex>；删除过的注册会被 prefs 规范化移除',
    };
  }

  const registryAgent = getAgent(id);
  const custom = isCustomApplicationId(id);
  if (!registryAgent && !custom) {
    return {
      ok: false,
      code: CHECKS.AGENT_UNKNOWN,
      reason: `未注册的 agent：${id}`,
      fix: '目标必须是 agents/registry.js 里已注册的 agent，或 Settings 里注册过的自定义 HTTP Agent',
    };
  }

  if (custom) {
    // customApplications 是注册真相：没注册就当未注册（绝不降级）
    const registered = Array.isArray(prefsSnapshot && prefsSnapshot.customApplications)
      && prefsSnapshot.customApplications.some((a) => a && a.id === id);
    if (!registered) {
      return {
        ok: false,
        code: CHECKS.AGENT_NOT_REGISTERED,
        reason: `自定义 agent 未注册：${id}`,
        fix: '去 Settings → Agents 注册这个应用，或改派到已注册的 agent',
      };
    }
    // 注册的自定义 HTTP agent 与内置 agent 是两套模型：按 src/prefs.js 的
    // normalizeCustomAgentGates，注册项的 integrationInstalled 被**永久钉成 false**
    // （注册只分配 ID 与状态入口，不安装 hook、不观察进程）。所以这里只查 enabled，
    // 查 installed 会把所有自定义 agent 永远判成"未安装"，一个都派不出去。
    if (!agentGate.isAgentEnabled(prefsSnapshot, id)) {
      return {
        ok: false,
        code: CHECKS.AGENT_DISABLED,
        reason: `自定义 agent 已注册但未启用：${id}`,
        fix: `去 Settings → Agents 把 ${id} 打开开关（自定义 agent 不需要安装集成）`,
      };
    }
    return { ok: true, agentName: id };
  }

  const installed = agentGate.isAgentIntegrationInstalled(prefsSnapshot, id);
  if (!installed) {
    return {
      ok: false,
      code: CHECKS.AGENT_NOT_INSTALLED,
      reason: `${id} 尚未安装集成`,
      fix: `先在 Settings → Agents 对 ${id} 点 Install（安装并启用），再回来派单`,
    };
  }
  const enabled = agentGate.isAgentEnabled(prefsSnapshot, id);
  if (!enabled) {
    return {
      ok: false,
      code: CHECKS.AGENT_DISABLED,
      reason: `${id} 已安装但未启用`,
      fix: `去 Settings → Agents 把 ${id} 打开开关（只启用不卸载 hooks/plugins），再回来派单`,
    };
  }

  return {
    ok: true,
    agentName: (registryAgent && (registryAgent.displayName || registryAgent.name)) || id,
  };
}

/** cwd 检查：存在 + 是目录。空 cwd 视为不满足（不猜当前目录）。 */
function checkCwd(cwd, fsImpl = fs) {
  const dir = typeof cwd === 'string' ? cwd.trim() : '';
  if (!dir) {
    return {
      ok: false,
      code: CHECKS.CWD_MISSING,
      reason: '工单没有指定 cwd',
      fix: '派单前用 --cwd <目录> 指定工作目录（编排层不猜当前目录）',
    };
  }
  let stat;
  try {
    stat = fsImpl.statSync(dir);
  } catch {
    return {
      ok: false,
      code: CHECKS.CWD_MISSING,
      reason: `cwd 不存在：${dir}`,
      fix: `先创建/修正这个目录，或改派到已存在的目录（当前目录：${process.cwd()}）`,
    };
  }
  if (!stat.isDirectory()) {
    return {
      ok: false,
      code: CHECKS.CWD_NOT_DIRECTORY,
      reason: `cwd 不是目录：${dir}`,
      fix: '把 cwd 改成一个目录',
    };
  }
  return { ok: true };
}

/** 依赖检查：成环 + 悬空 + 自依赖。整批一起看（单看一张看不出环）。 */
function checkDependencies(tickets = []) {
  const problems = [];
  for (const cycle of T.findCycles(tickets)) {
    problems.push({
      code: CHECKS.DEP_CYCLE,
      reason: `依赖成环：${cycle.join(' → ')}`,
      fix: '打断环上任意一条依赖（确认那一步把 dependsOn 清空或改成单向链）',
      ids: cycle,
    });
  }
  for (const p of T.checkDependencies(tickets)) {
    problems.push({
      code: p.kind === 'self' ? CHECKS.DEP_SELF : CHECKS.DEP_MISSING,
      reason: p.kind === 'self' ? `工单依赖自己：${p.id}` : `依赖不存在的工单：${p.id} → ${p.dep}`,
      fix: p.kind === 'self' ? '去掉自依赖' : '修正 dependsOn 里的 id，或先建那张工单',
      ids: [p.id, p.dep],
    });
  }
  return problems;
}

/**
 * 前置就绪：依赖的前置工单必须已经过了"人确认"这一关。
 * READY 集合是白名单而非黑名单 —— 新增状态时默认不可派，必须显式放行，
 * 避免"忘了加进黑名单"导致未确认的工单被硬派出去。
 *
 * batch 内部依赖（同一次 plan/派发里的工单互为前置）被跳过：它们会在同一次人确认里
 * 一起变成 confirmed，用 draft 状态去卡它们会让"线性链拆分"永远派不出去。
 * 真正要卡的是**跨批次**的未确认前置。
 */
const DEP_READY_STATUSES = new Set(['confirmed', 'dispatched', 'running', 'done']);

function checkDepReadiness(ticket, allTickets = [], opts = {}) {
  const byId = new Map((allTickets || []).map((t) => [t.id, t]));
  const selfIds = opts.selfIds instanceof Set ? opts.selfIds : new Set(opts.selfIds || []);
  const problems = [];
  for (const dep of T.depsOf(ticket)) {
    if (selfIds.has(dep)) continue; // 同批次，一起确认
    const upstream = byId.get(dep);
    if (!upstream) continue; // 悬空由 checkDependencies 报，这里不重复
    if (DEP_READY_STATUSES.has(upstream.status)) continue;
    problems.push({
      code: CHECKS.DEP_UNCONFIRMED,
      reason: `前置工单还不能作为前置：${ticket.id} 依赖 ${dep}（当前 ${upstream.status}）`,
      fix: upstream.status === 'draft'
        ? `先确认 ${dep}，或把 ${ticket.id} 的这条依赖去掉`
        : `${dep} 当前 ${upstream.status}，先处理它或改派`,
    });
  }
  return problems;
}

/**
 * 单张工单的可行性检查（不含跨工单成环，成环要走 checkBatch）。
 * @returns {{ok:boolean, problems:Array<{code,reason,fix}>}}
 */
function checkTicket(ticket, ctx = {}) {
  const problems = [];
  const invalid = T.validateTicket(ticket);
  if (invalid.length) {
    problems.push({
      code: CHECKS.TICKET_INVALID,
      reason: `工单字段不合法：${invalid.join('；')}`,
      fix: '修正工单字段后重试（id 与 status 由编排层生成，不该手改）',
    });
  }
  if (!ctx.skipAgent) {
    const agentResult = checkAgent(ticket && ticket.agent, ctx.prefs);
    if (!agentResult.ok) problems.push({ code: agentResult.code, reason: agentResult.reason, fix: agentResult.fix });
  }
  if (!ctx.skipCwd) {
    const cwdResult = checkCwd(ticket && ticket.cwd, ctx.fs || fs);
    if (!cwdResult.ok) problems.push({ code: cwdResult.code, reason: cwdResult.reason, fix: cwdResult.fix });
  }
  problems.push(...(ctx.allTickets ? checkDepReadiness(ticket, ctx.allTickets, ctx) : []));
  return { ok: problems.length === 0, problems };
}

/**
 * 整批工单的可行性检查（派发前的最后闸门）。
 * @param tickets 待派发的工单数组
 * @param ctx { prefs, allTickets 账本全量（默认= tickets）, fs }
 * @returns {{ok, problems, checked}}
 */
function checkBatch(tickets = [], ctx = {}) {
  const all = ctx.allTickets || tickets;
  const problems = [];

  // 整批的依赖图问题（成环必须整批看）
  problems.push(...checkDependencies(all));

  // 同批次 id 集合：批次内部的依赖不算"未确认前置"（它们会在同一次人确认里一起变 confirmed）
  const selfIds = new Set((tickets || []).map((t) => t && t.id));

  for (const ticket of tickets || []) {
    const r = checkTicket(ticket, { ...ctx, allTickets: all, selfIds });
    problems.push(...r.problems.map((p) => ({ ...p, id: ticket && ticket.id })));
  }

  return { ok: problems.length === 0, problems, checked: (tickets || []).length };
}

/** 只做依赖图检查（CLI 的 --check 快速通道，不碰 fs / prefs）。 */
function checkGraph(tickets = []) {
  const problems = checkDependencies(tickets);
  const cycles = T.findCycles(tickets);
  const order = cycles.length ? null : T.topoOrder(tickets);
  return { ok: problems.length === 0, problems, cycles, order };
}

/** 可读汇总（一行一条问题 + 修复建议）。 */
function formatProblems(problems = []) {
  return problems
    .map((p) => `  ❌ [${p.code}] ${p.id ? `${p.id}：` : ''}${p.reason}\n     → ${p.fix}`)
    .join('\n');
}

module.exports = {
  CHECKS,
  checkAgent,
  checkCwd,
  checkDependencies,
  checkDepReadiness,
  checkTicket,
  checkBatch,
  checkGraph,
  formatProblems,
};