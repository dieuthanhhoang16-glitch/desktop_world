// world/cleanup/round1.js
// desktop-world · 清理第一轮：JEV 一次性评估候选删除概率。
//
// 规则：每次清理只调用 JEV 一次；无 JEV 时不创建提案目录。候选、风险、理由与
// 扫描参数一起落盘，供第二轮复核与人工审阅。
'use strict';

const fs = require('fs');
const path = require('path');

const { scanProject } = require('./scan');
const { proposalDir, proposalId } = require('./paths');

const PURPOSE = 'cleanup-round1';
const DELETE_THRESHOLD = 0.5;

const BASE_RISK = Object.freeze({ duplicate: 'low', generated: 'low', unreferenced: 'medium', stale: 'high' });
const RISK_LEVELS = ['low', 'medium', 'high'];

function escalate(risk) {
  const i = RISK_LEVELS.indexOf(risk);
  return RISK_LEVELS[Math.min(RISK_LEVELS.length - 1, i + 1)];
}

function buildQuestions(candidates) {
  const questions = {};
  for (const c of candidates) {
    const evidence = (c.evidenceLines || []).join('；');
    questions[c.key] = {
      type: 'noul',
      instructions: `项目文件 ${c.path} 应在本轮清理中被删除（类别：${c.category}；证据：${evidence}）`,
    };
  }
  return questions;
}

function riskFor(candidate, probability) {
  let risk = BASE_RISK[candidate.category] || 'medium';
  if (candidate.tracked && risk === 'low') risk = 'medium';
  if (probability < 0.6) risk = escalate(risk);
  return risk;
}

function reasonFor(candidate, probability) {
  return `JEV 删除概率 ${probability.toFixed(2)}；${(candidate.evidenceLines || []).join('；')}`;
}

/**
 * @param {object} opts
 * @param {string} opts.projectPath
 * @param {Function} [opts.decider] JEV decider（与 world/orch/llm createClient().decide 同形）
 * @param {string} [opts.root] 清理根目录
 * @param {Function} [opts.now]
 * @param {object} [opts.scan] 预扫描结果（测试注入）
 */
async function runRound1({ projectPath, decider, root, now = () => new Date(), scan, jevLimit } = {}) {
  const project = path.resolve(String(projectPath || ''));
  const at = now();
  if (typeof decider !== 'function') {
    return { ok: false, reason: 'jev-unavailable', project, message: 'JEV 不可用，不生成清理提案。' };
  }

  let scanResult = scan;
  if (!scanResult) {
    scanResult = scanProject(project, { now: () => at, jevLimit });
  }
  if (!scanResult.ok) return scanResult;
  if (!scanResult.candidates.length) {
    return { ok: true, empty: true, project, scan: scanResult, candidates: [], message: '没有发现需要清理的候选。' };
  }

  let res = null;
  try {
    res = await decider({
      state: `清理复核第 1 轮：项目 ${path.basename(project)} 共 ${scanResult.candidates.length} 个候选，逐项判断是否应删除。`,
      questions: buildQuestions(scanResult.candidates),
      purpose: PURPOSE,
    });
  } catch {
    res = null;
  }
  if (!res || !res.ok) {
    return {
      ok: false,
      reason: 'jev-unavailable',
      project,
      detail: res && (res.reason || res.message || res.source) ? String(res.reason || res.message || res.source) : null,
      scan: scanResult,
      message: 'JEV 调用失败，不生成清理提案。',
    };
  }

  const answers = res.answers || {};
  const candidates = scanResult.candidates.map((c) => {
    const answer = answers[c.key];
    const raw = typeof answer === 'number' ? answer : answer && typeof answer.noul === 'number' ? answer.noul : null;
    const probability = raw === null ? 0 : Math.max(0, Math.min(1, raw));
    const votedDelete = probability >= DELETE_THRESHOLD;
    return {
      ...c,
      probability,
      votedDelete,
      risk: riskFor(c, probability),
      jevReason: reasonFor(c, probability),
    };
  });

  const date = at.toISOString().slice(0, 10);
  const dir = proposalDir(root, project, date);
  const base = {
    schemaVersion: 1,
    proposalId: proposalId(project, date),
    project,
    projectName: path.basename(project),
    date,
    generatedAt: at.toISOString(),
    rounds: { jev: { ok: true, model: res.model || null, source: res.source || null, calls: 1, at: at.toISOString() } },
    scanParams: scanResult.params,
    exclusions: scanResult.exclusions,
    candidates,
  };

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'scan.json'), JSON.stringify({ ...scanResult, candidates: scanResult.candidates }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'round1.json'), JSON.stringify(base, null, 2) + '\n');

  return {
    ok: true,
    empty: false,
    project,
    dir,
    proposalId: base.proposalId,
    date,
    model: res.model || null,
    scan: scanResult,
    candidates,
    round1: base,
  };
}

module.exports = {
  PURPOSE,
  DELETE_THRESHOLD,
  BASE_RISK,
  buildQuestions,
  riskFor,
  reasonFor,
  runRound1,
};
