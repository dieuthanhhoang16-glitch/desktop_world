// world/cleanup/milestone-prompt.js
// desktop-world · 阶段/里程碑关闭后的清理提示（只提示，不自动执行）。
//
// 账本与 roadmap 放在同一目录：milestone-prompts.json。自动提示按
// 「里程碑 + 阶段」去重，重开再关不会重复；手动触发不受去重影响，仍会记账。
'use strict';

const fs = require('fs');
const path = require('path');

const { cleanupRoot, projectSlug } = require('./paths');

const LEDGER_FILE = 'milestone-prompts.json';
const VERSION = 1;

function ledgerFile(orchRoot) {
  return path.join(path.resolve(String(orchRoot || '')), LEDGER_FILE);
}

function loadLedger(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      version: VERSION,
      prompts: Array.isArray(raw.prompts) ? raw.prompts.filter((p) => p && typeof p.key === 'string') : [],
    };
  } catch {
    return { version: VERSION, prompts: [] };
  }
}

function saveLedger(file, ledger) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: VERSION, prompts: ledger.prompts }, null, 2) + '\n', { mode: 0o600 });
}

function latestProposalFor(projectPath, root) {
  const base = path.join(cleanupRoot(root), projectSlug(projectPath));
  let dates = [];
  try {
    dates = fs.readdirSync(base).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  } catch {
    return null;
  }
  for (let i = dates.length - 1; i >= 0; i -= 1) {
    const dir = path.join(base, dates[i]);
    try {
      const proposal = JSON.parse(fs.readFileSync(path.join(dir, 'proposal.json'), 'utf8'));
      return { dir, proposalId: proposal.proposalId || null, date: dates[i] };
    } catch {
      // 选择最新一个含提案的日期；只有 round1 的日期不算
      continue;
    }
  }
  return null;
}

function buildPrompt({ kind, key, milestone, stageId, projectPath, root, trigger = 'auto', now = () => new Date() }) {
  const latest = projectPath ? latestProposalFor(projectPath, root) : null;
  const label = kind === 'milestone' ? `里程碑「${milestone || '未命名'}」` : `阶段「${stageId}」`;
  return {
    id: `mp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    key,
    kind,
    milestone: milestone || '',
    stageId: stageId || null,
    trigger,
    at: now().toISOString(),
    message: `${label}已关闭。要做一次项目清理吗？（只生成提案，不会自动删除）`,
    autoExecute: false,
    navigate: {
      view: 'cleanup',
      projectPath: projectPath || null,
      proposalDir: latest ? latest.dir : null,
      proposalId: latest ? latest.proposalId : null,
      hasProposal: Boolean(latest),
      action: projectPath ? (latest ? 'open-proposal' : 'create-proposal') : 'select-project',
    },
  };
}

/**
 * 窗口关闭后调用：仅当阶段/里程碑全部 closed 时生成一次提示。
 * @returns {Array} 本次新增的提示（可能为空）
 */
function evaluateClose({ orchRoot, roadmap, stageId, subtaskId, projectPath, root, now = () => new Date() } = {}) {
  if (!orchRoot || !roadmap || !Array.isArray(roadmap.stages)) return [];
  const stage = roadmap.stages.find((s) => s.id === stageId);
  if (!stage || !Array.isArray(stage.subtasks) || !stage.subtasks.length) return [];
  if (!stage.subtasks.every((t) => t.windowState === 'closed')) return [];
  if (subtaskId && !stage.subtasks.some((t) => t.id === subtaskId)) return [];

  const milestone = roadmap.milestone || '';
  const allClosed = roadmap.stages.length > 0 && roadmap.stages.every((s) => s.subtasks.every((t) => t.windowState === 'closed'));
  const kind = allClosed ? 'milestone' : 'stage';
  const key = allClosed ? `milestone:${milestone || 'unnamed'}` : `stage:${milestone || 'unnamed'}:${stageId}`;
  const file = ledgerFile(orchRoot);
  const ledger = loadLedger(file);
  const duplicate = ledger.prompts.some((p) => p.key === key && p.trigger === 'auto');
  if (duplicate) return [];

  const prompt = buildPrompt({ kind, key, milestone, stageId, projectPath, root, trigger: 'auto', now });
  ledger.prompts.push(prompt);
  saveLedger(file, ledger);
  return [prompt];
}

/** 手动触发：始终返回提示，不受里程碑状态与去重影响；仍写入账本供审计。 */
function manualPrompt({ orchRoot, milestone = '', projectPath, root, now = () => new Date() } = {}) {
  const at = now();
  const key = `manual:${milestone || 'unnamed'}:${at.toISOString()}:${Math.random().toString(36).slice(2, 6)}`;
  const prompt = buildPrompt({ kind: 'milestone', key, milestone, stageId: null, projectPath, root, trigger: 'manual', now: () => at });
  const file = ledgerFile(orchRoot);
  const ledger = loadLedger(file);
  ledger.prompts.push(prompt);
  saveLedger(file, ledger);
  return prompt;
}

function listPrompts(orchRoot) {
  return loadLedger(ledgerFile(orchRoot)).prompts;
}

module.exports = {
  LEDGER_FILE,
  ledgerFile,
  loadLedger,
  saveLedger,
  latestProposalFor,
  buildPrompt,
  evaluateClose,
  manualPrompt,
  listPrompts,
};
