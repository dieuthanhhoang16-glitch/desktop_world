// world/orch/split.js
// desktop-world · 拆分入口：**本地确定性出工单，JEV 只做判断与打分**。
//
// ════════════════════════════════════════════════════════════════
// 关键设计：Jev **不生成文本**（见 llm.js 文件头），所以它**不拆工单**。
// 职责切得很干净：
//   本地确定性规则 → 工单标题、动作类型、验收标准、依赖关系（永远由它产出）
//   Jev             → 这个目标该不该拆？该派给哪个已装 agent？风险多大？
//   人（stage ③）   → 逐条确认 / 改派 / 删
//
// 这样安排不是因为保守，而是因为 Jev 只能输出 0..1 的概率。让它"建议标题"是
// 逼它做它不擅长的事，产出质量不可控，而且失去了"建议 vs 执行"的清晰边界。
// 一个额外好处：**工单措辞永远可复现**（同输入同输出），模型只影响"要不要拆、派给谁"
// 这两个判断，且这两个判断都会记录在 decisions/ 里可复盘。
//
// ── 为什么需要包一层 ───────────────────────────────────────────
// Stage C-1 的 draftTickets() 是纯规则拆分。它的优点是确定性、零延迟、零出网；
// 缺点是看不懂语义——"先调研再决定做不做"这种**该不该做**的判断它给不出来。
// 所以让Jev 只在本地判定**不足以支撑派单**时才介入（而不是每次都问）。
//
// ── 铁律 ──────────────────────────────────────────────────────
// Jev 的输出**只是建议**，必须经过 Stage C-1 的 validateTicket + dispatch 可行性
// 检查，再由人在 stage ③ 逐条确认。本模块**没有能力** spawn 进程、cd 到哪、
// 执行什么命令 —— 它连工单的措辞都不生成，无从谈"指挥动作"。
'use strict';

const ticketsModel = require('./tickets');

// 置信度阈值：本地拆分低于这个值才问Jev。
// 0.5 是"子句数量、长度、形态三项都过得去"的及格线。调低会增加出网与延迟，
// 调高会让 Jev 失去存在意义（大部分目标本地都拆得开）。
const LOW_CONFIDENCE = 0.5;

// 概率判定阈值：Jev 给的是 0..1 的概率，不是布尔。取0.6 是因为实测
// 无关问题也会给 0.4~0.5（"这段话是否涉及删除操作"对任何输入都在 0.4 左右），
// 阈值低于 0.5 会把噪声当信号。
const PROB_YES = 0.6;
const PROB_NO = 0.4;

// 路由打分的归一化区间：概率差小于这个值视为"分不出高下"，不硬派。
const ROUTE_MARGIN = 0.15;

/**
 * 本地拆分的置信度（纯函数，0-1）。不够高才交给 Jev 判断。
 * @param {string[]} clauses splitClauses() 的输出
 */
function localConfidence(clauses) {
  if (!Array.isArray(clauses) || !clauses.length) return 0;
  const usable = clauses.filter((c) => typeof c === 'string' && c.trim());
  if (!usable.length) return 0;
  // 一条都没达到 MIN_CLAUSE_LEN → 本地根本没拆出子任务（"OK 嗯"这种），直接 0。
  // 不这么判的话，光靠"条数分"就能白拿 0.4 分，让一堆碎片蒙过阈值。
  if (!usable.some((c) => c.length >= ticketsModel.MIN_CLAUSE_LEN)) return 0;
  const total = usable.reduce((n, c) => n + c.length, 0);
  const longEnough = usable.filter((c) => c.length >= ticketsModel.MIN_CLAUSE_LEN).length;
  const avg = total / usable.length;
  const runOn = usable.some((c) => c.length > MAX_CLAUSE_CHARS);

  // 「没拆开」有三种形态，都该让 Jev 接手判断：
  //   ① 整句塞进一条（超过 MAX_CLAUSE_CHARS）
  //   ② 只切出**一条**子句 —— 目标里的"然后/再/并且"没被识别出来，本地等于没拆
  //   ③ 全部子句都很长（avg 顶格）—— 同样指向"这只是整句话"
  // 长度不能反过来说明置信度高：一句话越长，越可能只是没切开。
  if (runOn || usable.length < 2) return 0;
  if (avg >= LONG_CLAUSE_AVG) return 0;

  // 三个维度各占权重：条数够不够、每条像不像完整子句、平均长度是否够
  let score = 0;
  score += Math.min(1, usable.length / 3) * 0.4;
  score += (longEnough / usable.length) * 0.35;
  score += Math.min(1, avg / ticketsModel.MIN_CLAUSE_LEN) * 0.25;
  return Math.min(1, Number(score.toFixed(3)));
}

// 子句形态阈值（与 tickets.js 的拆句规则配套，见 localConfidence 注释）
const MAX_CLAUSE_CHARS = 120;
const LONG_CLAUSE_AVG = 40;

/**
 * 建判断用的**问题表**（纯函数）。
 *
 * Jev 收的是"要问什么"，不是"要它答什么文本"。所以这里给一组命名问题，
 * 一次调用问完，返回一组 0..1 的概率：
 *   splitable      这段目标能否拆成多个可独立推进的子任务
 *   needs_research 是否需要先调研/对齐才能决定该不该做
 *   risky          是否涉及删除、覆盖、不可逆操作
 *   agent_<id>     哪个已装 agent 更适合接（每个候选一个，概率即路由打分）
 *
 * @param {string} goal
 * @param {Array<{id:string,name?:string}>} agents 已注册且被 gate 放行的 agent 名单
 */
function buildJudgmentQuestions(goal, agents = []) {
  const g = String(goal || '').slice(0, 600);
  const questions = {
    // state 里带上完整目标，问题才问得准；Jev 是按 state 回答 questions 的
    splitable: { type: 'noul', instructions: `这段目标是否包含多个可以独立推进、互不阻塞的子任务？目标：${g}` },
    needs_research: { type: 'noul', instructions: `这段目标是否需要先调研、先对齐或先确认需求，才能决定要不要做？目标：${g}` },
    risky: { type: 'noul', instructions: `这段目标是否涉及删除、覆盖、不可逆操作、或者花钱/动生产环境？目标：${g}` },
  };
  const roster = (Array.isArray(agents) ? agents : []).filter((a) => a && a.id).slice(0, 6);
  for (const a of roster) {
    // 问题名必须是合法标识符（它同时是响应里的 key）
    const key = `agent_${String(a.id).replace(/[^A-Za-z0-9_]/g, '_')}`.slice(0, 60);
    questions[key] = {
      type: 'noul',
      instructions: `在目标「${g}」上，这个 assistant 是否比其他人更合适？assistant：${a.name || a.id}`,
    };
    a.__qKey = key;
  }
  return questions;
}

/** 概率 → 三档判断标签（纯函数）。中间档就是"不确定"。 */
function verdictOf(p, { yes = PROB_YES, no = PROB_NO } = {}) {
  if (p === null || p === undefined || !Number.isFinite(p)) return 'unknown';
  if (p >= yes) return 'yes';
  if (p <= no) return 'no';
  return 'unsure';
}

/**
 * 从Jev 的概率里读出路由建议（纯函数）。
 * @param {object} probs  { splitable: 0.87, agent_claude_code: 0.6, ... }
 * @param {Array} agents  候选 agent 名单（需带 __qKey）
 * @returns {{verdict:string, suggestedAgent:string|null, margin:number, risky:boolean,
 *            needsResearch:boolean, splitable:number|null}}
 */
function readJudgment(probs, agents = []) {
  const p = probs && typeof probs === 'object' ? probs : {};
  const splitable = Number.isFinite(p.splitable) ? p.splitable : null;
  const riskyVerdict = verdictOf(Number.isFinite(p.risky) ? p.risky : null);
  const researchVerdict = verdictOf(Number.isFinite(p.needs_research) ? p.needs_research : null);

  // 路由：取概率最高的 agent；差距不够就说"分不出高下"（宁可让人自己派）
  let suggestedAgent = null;
  let margin = 0;
  const scored = (Array.isArray(agents) ? agents : [])
    .filter((a) => a && a.__qKey)
    .map((a) => ({ agent: a, score: Number.isFinite(p[a.__qKey]) ? p[a.__qKey] : null }))
    .filter((x) => x.score !== null)
    .sort((a, b) => b.score - a.score);
  if (scored.length) {
    margin = scored.length > 1 ? scored[0].score - scored[1].score : scored[0].score;
    if (scored[0].score >= PROB_NO && margin >= ROUTE_MARGIN) suggestedAgent = scored[0].agent;
  }

  return {
    splitable,
    verdict: verdictOf(splitable),
    risky: riskyVerdict === 'yes',
    needsResearch: researchVerdict === 'yes',
    suggestedAgent: suggestedAgent ? { id: suggestedAgent.id, name: suggestedAgent.name || suggestedAgent.id } : null,
    margin: Number(margin.toFixed(3)),
  };
}

/**
 * 入口：本地出工单；置信度不足时问 Jev 拿判断。
 *
 * @param {string} goal
 * @param {object} [opts]
 * @param {Array}  [opts.existingIds]
 * @param {string} [opts.agent]   目标 agent（**始终来自用户/调用方**，永不被模型覆盖）
 * @param {string} [opts.cwd]     工作目录（同上）
 * @param {boolean}[opts.independent]
 * @param {string[]}[opts.dependsOn]
 * @param {Array}  [opts.agents]  已装 agent 名单（只用于提问，不决定派给谁）
 * @param {boolean}[opts.force]   强制问 JEV（用户明确要求时）
 * @param {Function}[opts.client] 注入的 LLM 客户端（单测必用）
 * @returns {Promise<{tickets:Array, source:'local'|'jev', localConfidence:number,
 *   reason:string, modelTried:boolean, judgment:object|null}>}
 *   永不 throw：任何异常路径都退回纯本地结果。
 *   judgment 为 null 表示没问/没问成；有值时其中的建议只是给人看的参考。
 */
async function draftWithLlm(goal, opts = {}) {
  const baseOpts = {
    existingIds: opts.existingIds,
    agent: opts.agent,
    cwd: opts.cwd,
    independent: opts.independent,
    dependsOn: opts.dependsOn,
  };

  const clauses = ticketsModel.splitClauses(goal);
  const conf = localConfidence(clauses);

  // 工单永远由本地规则产出 —— 措辞、动作类型、验收标准、依赖关系，一个字都不由模型写
  const tickets = clauses.length ? ticketsModel.draftTickets(goal, baseOpts) : [];

  // 本地够好 → 直接返回，连 client 都不问
  if (!opts.force && conf >= LOW_CONFIDENCE && tickets.length) {
    return {
      tickets,
      source: 'local',
      localConfidence: conf,
      reason: '本地拆分置信度足够',
      modelTried: false,
      judgment: null,
    };
  }

  // 没有可用客户端（JEV 未启用/无密钥/端点错）→ 本地兜底，并把原因如实带回
  if (!opts.client || typeof opts.client.decide !== 'function') {
    return {
      tickets,
      source: 'local',
      localConfidence: conf,
      reason: clauses.length ? '本地拆分可用（未启用 JEV 判断）' : '本地拆不出子句且未启用 JEV 判断',
      modelTried: false,
      judgment: null,
    };
  }

  const agents = Array.isArray(opts.agents) ? opts.agents.slice() : [];
  for (const a of agents) if (a && typeof a === 'object') a.__qKey = undefined; // 由 buildJudgmentQuestions 填

  let result;
  try {
    result = await opts.client.decide({
      state: goal,
      questions: buildJudgmentQuestions(goal, agents),
      purpose: 'split-judgment',
    });
  } catch (err) {
    // client 理论上不 throw（llm.js 保证），但这里再兜一层：编排链路不能因为
    // 任何意外断在这里 —— 本地结果必须永远可用。
    return {
      tickets,
      source: 'local',
      localConfidence: conf,
      reason: `JEV 判断异常（已退回本地）：${err && err.message}`,
      modelTried: true,
      judgment: null,
    };
  }

  if (!result || !result.ok || !result.probs) {
    return {
      tickets,
      source: 'local',
      localConfidence: conf,
      reason: `JEV 不可用（已退回本地）：${(result && result.reason) || 'unknown'}`,
      modelTried: true,
      judgment: null,
    };
  }

  const judgment = readJudgment(result.probs, agents);
  return {
    tickets,
    source: 'jev',
    localConfidence: conf,
    reason: buildReason(conf, judgment, tickets.length),
    modelTried: true,
    judgment,
  };
}

/** 把判断结果写成人话（给 CLI/日志看）。 */
function buildReason(conf, judgment, count) {
  const bits = [];
  if (count === 0) bits.push('本地未拆出子句');
  else if (conf < LOW_CONFIDENCE) bits.push(`本地置信度 ${conf} 偏低`);
  else bits.push('本地已拆出工单');
  if (judgment) {
    bits.push(`JEV：可拆分 ${judgment.splitable == null ? 'n/a' : judgment.splitable}`);
    if (judgment.needsResearch) bits.push('建议先调研/对齐');
    if (judgment.risky) bits.push('⚠ 涉及不可逆操作，需人工确认');
    if (judgment.suggestedAgent) bits.push(`建议派给 ${judgment.suggestedAgent.name}`);
  }
  return bits.join('；');
}

module.exports = {
  LOW_CONFIDENCE,
  PROB_YES,
  PROB_NO,
  ROUTE_MARGIN,
  MAX_CLAUSE_CHARS,
  LONG_CLAUSE_AVG,
  localConfidence,
  buildJudgmentQuestions,
  verdictOf,
  readJudgment,
  draftWithLlm,
  buildReason,
};