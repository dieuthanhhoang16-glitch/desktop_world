// world/live/maintenance.js
// desktop-world · 动态桌面「维护」tab 的主进程数据层（可单测，不依赖 Electron）。
//
// 渲染层不 require 任何 world 模块；所有读写都通过 preload 桥接到这里。
// 项目注册、学习计划、清理提案/决策/执行、配置审计、里程碑提示、指标报告。
'use strict';

const fs = require('fs');
const path = require('path');

const registry = require('../projects/registry');
const { REGISTRY_FILE } = require('../projects/paths');
const { badge } = require('../projects/markers');
const { readPlan, createPlan } = require('../learn/plan');
const { readProposal, buildProposal, writeProposal } = require('../cleanup/proposal');
const { buildDecisions, writeDecisions, readDecisions } = require('../cleanup/decisions');
const { execute, restore, readReceipt } = require('../cleanup/execute');
const { runRound1 } = require('../cleanup/round1');
const { runRound2 } = require('../cleanup/round2');
const { createJevDecider } = require('../learn/drafter');
const milestone = require('../cleanup/milestone-prompt');
const { cleanupRoot, projectSlug } = require('../cleanup/paths');
const { configProposalRoot, configProposalDir } = require('../config-audit/paths');
const { auditConfig } = require('../config-audit/audit');
const {
  buildConfigProposal,
  writeConfigProposal,
  readConfigProposal,
} = require('../config-audit/proposal');
const { executeConfig, restoreConfig, readConfigReceipt } = require('../config-audit/execute');
const { recordCleanupProposal, recordCleanupExecute, recordCleanupRestore } = require('../metrics/events');
const { buildReport } = require('../metrics/report');

function latestDateDir(base) {
  let dates = [];
  try {
    dates = fs.readdirSync(base).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  } catch {
    return null;
  }
  return dates.length ? path.join(base, dates[dates.length - 1]) : null;
}

function projectProposalDir({ projectPath, root }) {
  const base = path.join(cleanupRoot(root), projectSlug(projectPath));
  return latestDateDir(base);
}

function configDir({ root, date }) {
  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return null;
    return configProposalDir(root, date);
  }
  return latestDateDir(configProposalRoot(root));
}

function isRegisteredProject({ registryFile = REGISTRY_FILE, projectPath } = {}) {
  if (!projectPath) return false;
  let abs = path.resolve(String(projectPath));
  try {
    abs = fs.realpathSync(abs);
  } catch {
    // 路径不存在时保留 resolve 结果，交给后续操作报错
  }
  return registry.load(registryFile).projects.some((p) => {
    try {
      return fs.realpathSync(p.path) === abs;
    } catch {
      return path.resolve(p.path) === abs;
    }
  });
}

/** 概览：项目 + 学习计划摘要 + 最新清理提案摘要 + 待处理里程碑提示 + 指标。 */
function overview({ registryFile = REGISTRY_FILE, learnRootDir, cleanupRootDir, orchRoot, metricsDir } = {}) {
  let projects = [];
  try {
    projects = listProjects({ registryFile, learnRootDir, cleanupRootDir });
  } catch {
    projects = [];
  }
  const config = loadConfig({ root: cleanupRootDir });
  const configSummary = config.hasProposal ? {
    date: config.date,
    proposalId: config.proposal.proposalId,
    status: config.proposal.status,
    counts: config.proposal.counts,
    totalCandidates: config.proposal.totalCandidates,
    hasDecisions: Boolean(config.decisions),
    hasReceipt: Boolean(config.receipt),
  } : null;
  let metrics = null;
  try {
    metrics = metricsOverview({ metricsDir });
  } catch {
    metrics = null;
  }
  return {
    ok: true,
    projects,
    milestones: listMilestonePrompts({ orchRoot }),
    config: configSummary,
    metrics,
  };
}

function summarizePlan(plan) {
  if (!plan) return null;
  return {
    project: plan.project,
    projectName: plan.projectName,
    generatedAt: plan.generatedAt,
    ordering: plan.ordering,
    totalMinutes: plan.totalMinutes,
    dailyCapMinutes: plan.dailyCapMinutes,
    cards: (plan.cards || []).map((c) => ({
      id: c.id,
      topic: c.topic,
      sourcePath: c.sourcePath,
      chars: c.chars,
      minutes: c.minutes,
      prerequisites: c.prerequisites,
    })),
    days: plan.days || [],
    diff: plan.diff || null,
  };
}

function listProjects({ registryFile = REGISTRY_FILE, learnRootDir, cleanupRootDir } = {}) {
  const projects = registry.listProjects(registryFile, { refresh: true });
  return projects.map((p) => {
    const plan = readPlan({ root: learnRootDir, projectPath: p.path });
    const dir = projectProposalDir({ projectPath: p.path, root: cleanupRootDir });
    let proposal = null;
    if (dir) {
      const parsed = readProposal(dir);
      if (parsed) proposal = { dir, date: path.basename(dir), proposalId: parsed.proposalId, status: parsed.status, counts: parsed.counts, kind: parsed.kind || 'project' };
    }
    return {
      path: p.path,
      name: p.name || path.basename(p.path),
      status: p.status,
      badge: badge(p.status),
      missing: p.missing || [],
      lastCheckedAt: p.lastCheckedAt || null,
      plan: plan ? { generatedAt: plan.generatedAt, cards: (plan.cards || []).length, totalMinutes: plan.totalMinutes } : null,
      proposal,
    };
  });
}

function loadProject({ projectPath, root, learnRootDir } = {}) {
  if (!projectPath) return { ok: false, reason: 'missing-project', message: '缺少项目路径。' };
  const abs = path.resolve(String(projectPath));
  const plan = readPlan({ root: learnRootDir, projectPath: abs });
  const dir = projectProposalDir({ projectPath: abs, root });
  let proposal = null;
  if (dir) {
    const parsed = readProposal(dir);
    if (parsed) {
      proposal = {
        dir,
        date: path.basename(dir),
        proposal: parsed,
        decisions: readDecisions(dir),
        receipt: readReceipt(dir),
      };
    }
  }
  return { ok: true, projectPath: abs, plan: summarizePlan(plan), proposal };
}

async function createLearningPlan({ projectPath, root: learnRootDir, decider, useJev = true } = {}) {
  if (!projectPath) return { ok: false, reason: 'missing-project', message: '缺少项目路径。' };
  const abs = path.resolve(String(projectPath));
  try {
    const result = await createPlan({
      projectPath: abs,
      root: learnRootDir,
      decider: decider || (useJev ? createJevDecider() : undefined),
    });
    if (!result.ok) {
      return {
        ok: false,
        reason: result.reason,
        message: result.reason === 'no-cards'
          ? '这个项目还没有学习卡。先运行 `npm run world:learn -- generate <project>`，再回来生成计划。'
          : result.message,
        cycle: result.cycle || null,
      };
    }
    return {
      ok: true,
      planPath: result.planPath,
      plan: summarizePlan(result.plan),
      ordering: result.ordering,
      diff: result.diff,
      totalMinutes: result.totalMinutes,
      days: result.days,
    };
  } catch (error) {
    return { ok: false, reason: 'plan-failed', message: String(error.message || error) };
  }
}

async function generateProposal({ projectPath, root, metricsDir, decider, runner, useJev = true } = {}) {
  if (!projectPath) return { ok: false, reason: 'missing-project', message: '缺少项目路径。' };
  const abs = path.resolve(String(projectPath));
  try {
    const r1 = await runRound1({ projectPath: abs, root, decider: decider || (useJev ? createJevDecider() : undefined) });
    if (!r1.ok) {
      return {
        ok: false,
        reason: r1.reason,
        message: r1.reason === 'jev-unavailable'
          ? 'JEV 不可用，未生成提案（按设计不降级）。检查 JEV 配置后重试。'
          : r1.message || '扫描失败。',
      };
    }
    if (r1.empty) return { ok: true, empty: true, message: r1.message };
    const r2 = await runRound2({ projectPath: abs, candidates: r1.candidates, runner });
    const proposal = buildProposal({ round1: r1, round2: r2 });
    const files = writeProposal(r1.dir, proposal);
    recordCleanupProposal(metricsDir, {
      proposalId: proposal.proposalId,
      candidates: proposal.totalCandidates,
      confirmed: proposal.counts.confirmed,
    });
    return { ok: true, dir: r1.dir, ...files, proposal: proposal, incomplete: proposal.status !== 'complete' };
  } catch (error) {
    return { ok: false, reason: 'proposal-failed', message: String(error.message || error) };
  }
}

function saveProjectDecisions({ projectPath, root, dir, selectedPaths = [], selectAll = false } = {}) {
  const target = dir || projectProposalDir({ projectPath, root });
  if (!target) return { ok: false, reason: 'no-proposal', message: '还没有清理提案。' };
  const proposal = readProposal(target);
  if (!proposal) return { ok: false, reason: 'proposal-unreadable', message: '提案不可读。' };
  const result = buildDecisions({ proposal, selectedPaths, selectAll });
  if (!result.ok) return result;
  const file = writeDecisions(target, result.decisions);
  return { ok: true, dir: target, file, decisions: result.decisions };
}

function previewProjectExecute({ projectPath, root, dir } = {}) {
  const target = dir || projectProposalDir({ projectPath, root });
  if (!target) return { ok: false, reason: 'no-proposal', message: '还没有清理提案。' };
  const decisions = readDecisions(target);
  if (!decisions) return { ok: false, reason: 'no-decisions', message: '还没有审批决策，先勾选并写入 decisions.json。' };
  return execute({ projectPath: path.resolve(String(projectPath)), dir: target, decisions, dryRun: true });
}

function runProjectExecute({ projectPath, root, dir, metricsDir } = {}) {
  const target = dir || projectProposalDir({ projectPath, root });
  if (!target) return { ok: false, reason: 'no-proposal', message: '还没有清理提案。' };
  const decisions = readDecisions(target);
  if (!decisions) return { ok: false, reason: 'no-decisions', message: '还没有审批决策。' };
  const result = execute({ projectPath: path.resolve(String(projectPath)), dir: target, decisions, dryRun: false });
  if (result.ok && !result.noop) {
    recordCleanupExecute(metricsDir, {
      proposalId: decisions.proposalId,
      confirmed: decisions.items.filter((i) => i.action === 'delete').length,
      removed: result.removed,
      moved: result.moved,
      failed: result.failed,
    });
  }
  return result;
}

function restoreProject({ projectPath, root, dir, metricsDir } = {}) {
  const target = dir || projectProposalDir({ projectPath, root });
  if (!target) return { ok: false, reason: 'no-proposal', message: '还没有清理提案。' };
  const result = restore({ projectPath: path.resolve(String(projectPath)), dir: target });
  if (result.ok && result.restored.length) {
    const receipt = readReceipt(target);
    recordCleanupRestore(metricsDir, { proposalId: receipt ? receipt.proposalId : null, restored: result.restored.length });
  }
  return result;
}

// ---- 配置层 ----

function auditConfigForUi({ claudeDir, root, archiveDir } = {}) {
  const audit = auditConfig({ claudeDir, root, archiveDir });
  if (!audit.ok) return audit;
  return {
    ok: true,
    root: audit.root,
    date: audit.date,
    proposalId: audit.proposalId,
    scannedAt: audit.scannedAt,
    memory: audit.memory,
    skills: audit.skills,
    indexes: audit.indexes,
    sessions: audit.sessions,
    counts: audit.counts,
    candidates: audit.candidates.map((c) => ({
      path: c.path,
      kind: c.kind,
      category: c.category,
      bucket: c.bucket,
      risk: c.risk,
      evidenceLines: c.evidenceLines,
      bucketReason: c.bucketReason,
      archiveTo: c.archiveTo,
      entries: c.entries,
      removeIndexLine: c.removeIndexLine || false,
    })),
  };
}

function loadConfig({ root, date, archiveDir } = {}) {
  const dir = configDir({ root, date });
  if (!dir) return { ok: true, hasProposal: false, proposal: null };
  const proposal = readConfigProposal(dir);
  if (!proposal) return { ok: true, hasProposal: false, proposal: null };
  return {
    ok: true,
    hasProposal: true,
    dir,
    date: path.basename(dir),
    proposal,
    decisions: readDecisions(dir),
    receipt: readConfigReceipt(dir),
    archiveRootDir: archiveDir,
  };
}

function proposeConfig({ claudeDir, root, archiveDir, metricsDir } = {}) {
  const audit = auditConfig({ claudeDir, root, archiveDir });
  if (!audit.ok) return audit;
  const proposal = buildConfigProposal({ audit });
  const dir = configProposalDir(root, audit.date);
  const files = writeConfigProposal(dir, proposal);
  recordCleanupProposal(metricsDir, {
    proposalId: proposal.proposalId,
    candidates: proposal.totalCandidates,
    confirmed: proposal.counts.confirmed,
    kind: 'config',
  });
  return { ok: true, dir, ...files, proposal };
}

function saveConfigDecisions({ root, date, selectedPaths = [], selectAll = false } = {}) {
  const dir = configDir({ root, date });
  if (!dir) return { ok: false, reason: 'no-proposal', message: '还没有配置清理提案。' };
  const proposal = readConfigProposal(dir);
  if (!proposal) return { ok: false, reason: 'proposal-unreadable', message: '配置提案不可读。' };
  const result = buildDecisions({ proposal, selectedPaths, selectAll });
  if (!result.ok) return result;
  const file = writeDecisions(dir, result.decisions);
  return { ok: true, dir, file, decisions: result.decisions };
}

function executeConfigForUi({ root, date, archiveDir, metricsDir, dryRun = true } = {}) {
  const dir = configDir({ root, date });
  if (!dir) return { ok: false, reason: 'no-proposal', message: '还没有配置清理提案。' };
  const decisions = readDecisions(dir);
  if (!decisions) return { ok: false, reason: 'no-decisions', message: '还没有配置审批决策。' };
  const result = executeConfig({ dir, decisions, dryRun, archiveRootDir: archiveDir });
  if (result.ok && !result.dryRun && !result.noop) {
    recordCleanupExecute(metricsDir, {
      proposalId: decisions.proposalId,
      confirmed: decisions.items.filter((i) => i.action === 'delete').length,
      removed: result.archivedDeleted,
      failed: result.failed,
      kind: 'config',
    });
  }
  return result;
}

function restoreConfigForUi({ root, date, metricsDir } = {}) {
  const dir = configDir({ root, date });
  if (!dir) return { ok: false, reason: 'no-proposal', message: '还没有配置清理提案。' };
  const result = restoreConfig({ dir });
  if (result.ok && result.restored.length) {
    const receipt = readConfigReceipt(dir);
    recordCleanupRestore(metricsDir, { proposalId: receipt ? receipt.proposalId : null, restored: result.restored.length, kind: 'config' });
  }
  return result;
}

// ---- 里程碑提示 / 指标 ----

function listMilestonePrompts({ orchRoot } = {}) {
  if (!orchRoot) return [];
  return milestone.listPrompts(orchRoot).filter((p) => !p.acknowledgedAt);
}

function acknowledgeMilestonePrompt({ orchRoot, key } = {}) {
  if (!orchRoot || !key) return { ok: false, reason: 'missing-args' };
  const file = milestone.ledgerFile(orchRoot);
  const ledger = milestone.loadLedger(file);
  const prompt = ledger.prompts.find((p) => p.key === key);
  if (!prompt) return { ok: false, reason: 'not-found' };
  prompt.acknowledgedAt = new Date().toISOString();
  milestone.saveLedger(file, ledger);
  return { ok: true, key };
}

function metricsOverview({ metricsDir, since } = {}) {
  return buildReport({ metricsDir, since });
}

module.exports = {
  latestDateDir,
  projectProposalDir,
  configDir,
  isRegisteredProject,
  overview,
  summarizePlan,
  listProjects,
  loadProject,
  createLearningPlan,
  generateProposal,
  saveProjectDecisions,
  previewProjectExecute,
  runProjectExecute,
  restoreProject,
  auditConfigForUi,
  loadConfig,
  proposeConfig,
  saveConfigDecisions,
  executeConfigForUi,
  restoreConfigForUi,
  listMilestonePrompts,
  acknowledgeMilestonePrompt,
  metricsOverview,
};
