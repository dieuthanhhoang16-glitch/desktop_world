// test/world-maintenance.test.js
// desktop-world · ticket 08/11/13：动态桌面维护 tab 的主进程数据层。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const maint = require('../world/live/maintenance');
const registry = require('../world/projects/registry');
const { projectSlug } = require('../world/projects/paths');
const { generateCards } = require('../world/learn/generate');
const { cleanupRoot } = require('../world/cleanup/paths');
const { configProposalDir } = require('../world/config-audit/paths');
const { writeConfigProposal, readConfigProposal } = require('../world/config-audit/proposal');
const { auditConfig } = require('../world/config-audit/audit');
const milestone = require('../world/cleanup/milestone-prompt');
const { recordCorrection } = require('../world/metrics/events');
const { eventsFile } = require('../world/metrics/paths');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maint-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(root, rel, body) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

function initProject(dir, { full = true } = {}) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  if (!full) return dir;
  write(dir, 'docs/agents/issue-tracker.md', '# Issue tracker\n\n本地 ticket 文件。\n');
  write(dir, 'docs/agents/domain.md', '# 工单 拆分\n\n把工单拆成可独立完成的小任务。\n');
  write(dir, 'docs/agents/triage-labels.md', '# 分诊标签\n');
  write(dir, 'GLOSSARY.md', '# 术语表\n\n## 角色\n\n角色的定义。\n\n## 权限\n\n权限的边界。\n');
  write(dir, 'AGENTS.md', '# 项目标准\n\n## Agent skills\n\n- /implement\n');
  return dir;
}

function seedProposal({ projectPath, root, buckets }) {
  const dir = path.join(cleanupRoot(root), projectSlug(projectPath), '2026-10-18');
  fs.mkdirSync(dir, { recursive: true });
  const proposal = {
    schemaVersion: 1,
    proposalId: 'cleanup-test-2026-10-18',
    project: projectPath,
    projectName: path.basename(projectPath),
    date: '2026-10-18',
    createdAt: '2026-10-18T10:00:00.000Z',
    status: 'complete',
    rounds: {
      jev: { ok: true, calls: 1, model: 'jev-test', at: '2026-10-18T10:00:00.000Z' },
      glm: { ok: true, calls: 1, model: 'glm-test', at: '2026-10-18T10:00:00.000Z' },
    },
    scanParams: {},
    exclusions: { recentDays: 14, ticketScope: [], excludedDirs: [] },
    totalCandidates: Object.values(buckets).flat().length,
    counts: {
      confirmed: buckets.confirmed.length,
      pending: buckets.pending.length,
      keep: buckets.keep.length,
    },
    buckets,
  };
  write(dir, 'proposal.json', JSON.stringify(proposal, null, 2));
  return { dir, proposal };
}

function candidate(projectPath, rel, extra = {}) {
  return {
    path: rel,
    category: 'generated-committed',
    risk: 'low',
    size: 12,
    tracked: false,
    evidence: { categories: ['generated-committed'] },
    evidenceLines: ['由构建生成且已提交', '无引用'],
    jev: { probability: 0.9, delete: true, reason: '生成物' },
    glm: { verdict: 'delete', evidence: '确认无引用' },
    bucketReason: '两轮都判 delete',
    ...extra,
  };
}

test('维护概览：项目徽标、最新提案与注册校验', (t) => {
  const root = tmp(t);
  const registryFile = path.join(root, 'projects.json');
  const learnRootDir = path.join(root, 'learn');
  const cleanupRootDir = path.join(root, 'cleanup');
  const init = initProject(path.join(root, 'alpha'));
  const partial = initProject(path.join(root, 'beta'), { full: false });
  registry.addProject(registryFile, init, { name: 'Alpha' });
  registry.addProject(registryFile, partial, { name: 'Beta' });
  const initReal = fs.realpathSync(init);
  const partialReal = fs.realpathSync(partial);

  const out = maint.overview({ registryFile, learnRootDir, cleanupRootDir, orchRoot: path.join(root, 'orch'), metricsDir: path.join(root, 'metrics') });
  assert.equal(out.ok, true);
  assert.equal(out.projects.length, 2);
  const alpha = out.projects.find((p) => p.path === initReal);
  const beta = out.projects.find((p) => p.path === partialReal);
  assert.equal(alpha.badge, null);
  assert.equal(alpha.status, 'initialized');
  assert.equal(beta.badge.label, '未初始化');
  assert.equal(beta.badge.tone, 'warn');
  assert.equal(out.config, null);
  assert.deepEqual(out.milestones, []);
  assert.equal(out.metrics.hasData, false);

  assert.equal(maint.isRegisteredProject({ registryFile, projectPath: init }), true);
  assert.equal(maint.isRegisteredProject({ registryFile, projectPath: path.join(root, 'nope') }), false);
});

test('学习计划：生成顺序与时长，重新规划显示新增差异，无卡时给出下一步', async (t) => {
  const root = tmp(t);
  const project = initProject(path.join(root, 'alpha'));
  write(project, 'docs/plans/design.md', '# 学习 设计\n\n设计学习卡的生成与索引。\n\n' + '正文。'.repeat(120));
  const learnRootDir = path.join(root, 'learn');
  await generateCards({ projectPath: project, root: learnRootDir });

  const first = await maint.createLearningPlan({ projectPath: project, root: learnRootDir, useJev: false });
  assert.equal(first.ok, true);
  assert.equal(first.plan.cards.length >= 2, true);
  assert.equal(first.plan.ordering.mode, 'deterministic');
  assert.ok(first.plan.totalMinutes.low > 0);
  assert.ok(first.plan.days.length >= 1);
  assert.ok(first.plan.days[0].minutes.low <= first.plan.dailyCapMinutes);
  assert.ok(fs.existsSync(first.planPath));

  const loaded = maint.loadProject({ projectPath: project, root: path.join(root, 'cleanup'), learnRootDir });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.plan.cards.length, first.plan.cards.length);

  // 新增一张卡后重新规划：diff 必须有 added，且不吞掉上一版
  write(project, 'docs/adr/002-slim.md', '# 配置 减重\n\n定期清理过期配置。\n\n' + '档案。'.repeat(80));
  await generateCards({ projectPath: project, root: learnRootDir });
  const second = await maint.createLearningPlan({ projectPath: project, root: learnRootDir, useJev: false });
  assert.equal(second.ok, true);
  assert.ok(second.diff, '重新规划应返回与上一版的差异');
  assert.ok(second.diff.added.length >= 1);
  assert.ok(second.diff.previousGeneratedAt);

  const bare = initProject(path.join(root, 'bare'));
  const failed = await maint.createLearningPlan({ projectPath: bare, root: learnRootDir, useJev: false });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'no-cards');
  assert.match(failed.message, /world:learn/);
});

test('项目清理：勾选写 decisions、dry-run 预览、执行归档、恢复', (t) => {
  const root = tmp(t);
  const project = initProject(path.join(root, 'alpha'));
  const cleanupRootDir = path.join(root, 'cleanup');
  const metricsDir = path.join(root, 'metrics');
  write(project, 'dist/bundle.js', 'module.exports = 1;\n');
  write(project, 'notes/keep.md', '# 保留\n');
  write(project, 'notes/uncertain.md', '# 待定\n');

  const { dir } = seedProposal({
    projectPath: project,
    root: cleanupRootDir,
    buckets: {
      confirmed: [candidate(project, 'dist/bundle.js')],
      pending: [candidate(project, 'notes/uncertain.md', { bucketReason: 'GLM 判 uncertain', glm: { verdict: 'uncertain', evidence: '无法判断' } })],
      keep: [candidate(project, 'notes/keep.md', { bucketReason: 'JEV 判保留', jev: { probability: 0.1, delete: false, reason: '还在用' } })],
    },
  });

  const listed = maint.listProjects({ registryFile: path.join(root, 'projects.json'), learnRootDir: path.join(root, 'learn'), cleanupRootDir });
  assert.equal(listed.length, 0);

  const loaded = maint.loadProject({ projectPath: project, root: cleanupRootDir });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.proposal.proposal.proposalId, 'cleanup-test-2026-10-18');

  // 只能勾确认桶；待定与保留不可直接执行
  const denied = maint.saveProjectDecisions({ projectPath: project, root: cleanupRootDir, selectedPaths: ['notes/uncertain.md'] });
  assert.equal(denied.ok, false);
  const saved = maint.saveProjectDecisions({ projectPath: project, root: cleanupRootDir, selectedPaths: ['dist/bundle.js'] });
  assert.equal(saved.ok, true);
  assert.equal(saved.decisions.selectedCount, 1);
  assert.ok(fs.existsSync(path.join(dir, 'decisions.json')));

  const preview = maint.previewProjectExecute({ projectPath: project, root: cleanupRootDir });
  assert.equal(preview.ok, true);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.deleteCount, 1);
  assert.ok(fs.existsSync(path.join(project, 'dist/bundle.js')));

  const executed = maint.runProjectExecute({ projectPath: project, root: cleanupRootDir, metricsDir });
  assert.equal(executed.ok, true);
  assert.equal(executed.moved, 1);
  assert.ok(!fs.existsSync(path.join(project, 'dist/bundle.js')));
  assert.match(fs.readFileSync(eventsFile(metricsDir), 'utf8'), /"type":"cleanup-execute"/);

  const restored = maint.restoreProject({ projectPath: project, root: cleanupRootDir, metricsDir });
  assert.equal(restored.ok, true);
  assert.equal(restored.restored.length, 1);
  assert.ok(fs.existsSync(path.join(project, 'dist/bundle.js')));
  assert.match(fs.readFileSync(eventsFile(metricsDir), 'utf8'), /"type":"cleanup-restore"/);
});

test('清理提案生成：JEV 不可用不降级，空候选不调用模型', async (t) => {
  const root = tmp(t);
  const project = initProject(path.join(root, 'alpha'));
  const cleanupRootDir = path.join(root, 'cleanup');

  const noJev = await maint.generateProposal({ projectPath: project, root: cleanupRootDir, useJev: false });
  assert.equal(noJev.ok, false);
  assert.equal(noJev.reason, 'jev-unavailable');
  assert.match(noJev.message, /JEV/);

  // 刚写入的文件在 14 天保护期内，扫描为空——模型一次都不该调用
  let calls = 0;
  const empty = await maint.generateProposal({
    projectPath: project,
    root: cleanupRootDir,
    decider: async () => { calls += 1; return { answers: [] }; },
  });
  assert.equal(empty.ok, true);
  assert.equal(empty.empty, true);
  assert.equal(calls, 0);
});

test('配置审计：提案复用三桶、可选择两桶、执行前归档并可恢复', (t) => {
  const root = tmp(t);
  const claudeDir = path.join(root, 'claude');
  const cleanupRootDir = path.join(root, 'cleanup');
  const archiveDir = path.join(root, 'archive');
  const metricsDir = path.join(root, 'metrics');
  write(claudeDir, 'memory/MEMORY.md', '# 索引\n\n- [缺失](gone.md) — 悬空\n');
  write(claudeDir, 'settings.json', '{"apiKey":"sk-live-should-not-be-read"}\n');

  const proposed = maint.proposeConfig({ claudeDir, root: cleanupRootDir, archiveDir, metricsDir });
  assert.equal(proposed.ok, true);
  assert.equal(proposed.proposal.kind, 'config');
  assert.deepEqual(proposed.proposal.policy.selectableBuckets, ['confirmed', 'pending']);
  assert.equal(proposed.proposal.policy.branch, null);
  assert.equal(proposed.proposal.counts.confirmed, 1);
  assert.ok(fs.existsSync(proposed.jsonPath));
  assert.match(fs.readFileSync(eventsFile(metricsDir), 'utf8'), /"type":"cleanup-proposal"/);

  const loaded = maint.loadConfig({ root: cleanupRootDir, archiveDir });
  assert.equal(loaded.hasProposal, true);
  assert.equal(loaded.proposal.proposalId, proposed.proposal.proposalId);

  const config = maint.loadConfig({ root: cleanupRootDir, date: '../../etc' });
  assert.equal(config.hasProposal, false, '非法日期不能逃出提案目录');

  const decided = maint.saveConfigDecisions({ root: cleanupRootDir, selectedPaths: [proposed.proposal.buckets.confirmed[0].path] });
  assert.equal(decided.ok, true);
  assert.equal(decided.decisions.kind, 'config');
  assert.equal(decided.decisions.selectedCount, 1);

  const preview = maint.executeConfigForUi({ root: cleanupRootDir, archiveDir, dryRun: true });
  assert.equal(preview.ok, true);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.deleteCount, 1);

  const executed = maint.executeConfigForUi({ root: cleanupRootDir, archiveDir, metricsDir, dryRun: false });
  assert.equal(executed.ok, true);
  assert.equal(executed.archivedDeleted, 1);
  const indexText = fs.readFileSync(path.join(claudeDir, 'memory/MEMORY.md'), 'utf8');
  assert.ok(!indexText.includes('gone.md'));

  const restored = maint.restoreConfigForUi({ root: cleanupRootDir, metricsDir });
  assert.equal(restored.ok, true);
  assert.equal(restored.restored.length, 1);
  assert.ok(fs.readFileSync(path.join(claudeDir, 'memory/MEMORY.md'), 'utf8').includes('gone.md'));
  const events = fs.readFileSync(eventsFile(metricsDir), 'utf8');
  assert.match(events, /"type":"cleanup-execute"/);
  assert.match(events, /"type":"cleanup-restore"/);
  assert.ok(!events.includes('sk-live'), '指标日志不得包含密钥');
});

test('里程碑提示：列出未确认提示、导航到已有提案、确认后消失', (t) => {
  const root = tmp(t);
  const project = initProject(path.join(root, 'alpha'));
  const cleanupRootDir = path.join(root, 'cleanup');
  const orchRoot = path.join(root, 'orch');
  seedProposal({
    projectPath: project,
    root: cleanupRootDir,
    buckets: { confirmed: [], pending: [], keep: [] },
  });

  const prompt = milestone.manualPrompt({ orchRoot, milestone: 'M1', projectPath: project, root: cleanupRootDir });
  assert.equal(prompt.navigate.action, 'open-proposal');
  assert.ok(prompt.navigate.proposalDir);

  let pending = maint.listMilestonePrompts({ orchRoot });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].key, prompt.key);

  const acked = maint.acknowledgeMilestonePrompt({ orchRoot, key: prompt.key });
  assert.equal(acked.ok, true);
  assert.deepEqual(maint.listMilestonePrompts({ orchRoot }), []);
  assert.equal(milestone.listPrompts(orchRoot).length, 1, '确认只标记不删除，账本仍可审计');
  assert.ok(milestone.listPrompts(orchRoot)[0].acknowledgedAt);

  const missing = maint.acknowledgeMilestonePrompt({ orchRoot, key: 'nope' });
  assert.equal(missing.ok, false);
});

test('指标概览读取事件日志并生成 30 天窗口', (t) => {
  const root = tmp(t);
  const metricsDir = path.join(root, 'metrics');
  const recorded = recordCorrection(metricsDir, '回复长度', { count: 2 });
  assert.equal(recorded.ok, true);
  const report = maint.metricsOverview({ metricsDir });
  assert.equal(report.hasData, true);
  assert.equal(report.metrics.repetition.corrections, 2);
  assert.equal(report.windowDays, 30);
});
