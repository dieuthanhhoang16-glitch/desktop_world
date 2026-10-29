// world/study/scanner.js
// desktop-world · 把日报里的结构化 techTips 匹配回「学习目标关键词」。
//
// 匹配口径（宁缺毋滥，绝不硬凑）：
//   强匹配 —— 考点标题与关键词字面重合，或关键词是考点标题的显著子串；
//   弱匹配 —— 项目名/答案里出现关键词，且是长度 ≥4 的技术词（短词容易误伤，一律不弱匹配）。
// 匹配不上的 tips 直接丢弃：日报里"今天沉淀的通用经验"不等于某个定向考点的证据。
// 纯函数，无 IO，可单测。
'use strict';

const REPORT_RE = /^daily-(\d{4}-\d{2}-\d{2})\.json$/;

// 归一成 { topic, project, answer, hook, action }；非结构化的旧字符串 tips 返回 null
// （旧字符串形态不带考点语义，无法可靠归属到某个关键词，宁可不收）
function normalizeTip(item) {
  if (!item || typeof item !== 'object' || typeof item.topic !== 'string') return null;
  const t = item.topic.trim();
  if (!t) return null;
  return {
    topic: t,
    project: typeof item.project === 'string' ? item.project.trim() : '',
    answer: typeof item.answer === 'string' ? item.answer.trim() : '',
    hook: typeof item.hook === 'string' ? item.hook.trim() : '',
    action: typeof item.action === 'string' ? item.action.trim() : '',
  };
}

/** 词元化：把 "electron 主进程 IPC 通信设计" 切成可比对的片段 */
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[\s,，、/|:：\-_()（）[\]{}+.]+/)
    .filter(Boolean);
}

// 归一化比对用的"紧格式"：去掉所有空白并小写。
// 为什么必须这么做：模型输出的考点常带空格（"electron 主进程 IPC 通信设计"），
// 而配置里的关键词可能不带（"electron主进程IPC通信设计"）。直接做子串包含会因
// 一个空格之差整个失配 —— 这是首日端到端冒烟实测到的真实漏匹配，不是假想。
function compact(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, '');
}

// 长词优先：先试 "electron主进程ipc"，再试单个 "ipc"
function candidateTokens(keyword) {
  const full = compact(keyword);
  if (!full) return [];
  const toks = tokenize(keyword).sort((a, b) => b.length - a.length);
  const out = [];
  if (full.length >= 4) out.push(full);
  for (const t of toks) {
    const ct = compact(t);
    if (ct.length >= 2 && !out.includes(ct)) out.push(ct);
  }
  return out;
}

/**
 * 这个考点是否属于这个关键词？
 * @param {string} keyword 学习目标的关键词
 * @param {object} tip normalizeTip() 的输出
 */
function tipMatchesKeyword(keyword, tip) {
  if (!tip || !tip.topic) return false;
  const kw = compact(keyword);
  if (!kw) return false;

  const topic = compact(tip.topic);
  const project = compact(tip.project);
  const answer = compact(tip.answer);

  // 强匹配：整词出现在考点标题里（长关键词），或短关键词反向被包含
  if (topic.includes(kw) && kw.length >= 3) return true;
  if (kw.length <= 2 && topic.includes(kw)) return true;

  for (const cand of candidateTokens(keyword)) {
    if (cand.length < 2) continue;
    if (topic.includes(cand)) return true;
    // 弱匹配只在长词上做，且只在项目名/答案这类上下文里，避免"ipc""状态"这类通用词乱认亲
    if (cand.length >= 4 && project.includes(cand)) return true;
    if (cand.length >= 4 && answer.includes(cand)) return true;
  }
  return false;
}

/**
 * 一份日报的 techTips → 按关键词分组的结果。
 * @param {object} report  daily-*.json 的内容
 * @param {Array<{id:string, direction:string, keywords:string[], kwIds?:object}>} goals
 * @returns {{ date:string, matched:Array<{goalId:string, keyword:string, kwId:string, tips:object[]}> }}
 */
function matchReport(report, goals) {
  const date = report && report.meta && report.meta.date;
  if (!date || !Array.isArray(goals) || !goals.length) return { date: date || '', matched: [] };

  const tips = (Array.isArray(report.techTips) ? report.techTips : []).map(normalizeTip).filter(Boolean);
  const matched = [];

  for (const goal of goals) {
    for (const keyword of goal.keywords || []) {
      const hits = tips.filter((t) => tipMatchesKeyword(keyword, t));
      if (!hits.length) continue;
      matched.push({
        goalId: goal.id,
        direction: goal.direction,
        keyword,
        kwId: (goal.kwIds && goal.kwIds[keyword]) || null,
        tips: hits,
      });
    }
  }
  return { date, matched };
}

module.exports = { REPORT_RE, normalizeTip, tokenize, compact, candidateTokens, tipMatchesKeyword, matchReport };
