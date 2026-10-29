// test/world-config-audit.test.js
// desktop-world · ticket 13：配置层审计、提案、归档执行与恢复。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { auditConfig, IDENTITY_LIMIT, WORKFLOW_LIMIT, SKILL_LIMIT, SKILL_UNUSED_DAYS, PROJECT_TTL_DAYS, SESSION_ARCHIVE_DAYS, NEVER_READ } = require('../world/config-audit/audit');
const { buildConfigProposal, writeConfigProposal, readConfigProposal } = require('../world/config-audit/proposal');
const { executeConfig, restoreConfig, readConfigReceipt } = require('../world/config-audit/execute');
const { buildDecisions, writeDecisions } = require('../world/cleanup/decisions');

const DAY = 24 * 3600 * 1000;
const NOW = new Date('2026-10-18T12:00:00.000Z');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function memoryFile(dir, name, type, extra = '') {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `---\nname: ${name.replace(/\.md$/, '')}\ndescription: 测试记忆\nmetadata:\n  type: ${type}\n---\n\n${extra}\n`);
  return file;
}

function age(file, days) {
  const t = new Date(NOW.getTime() - days * DAY);
  fs.utimesSync(file, t, t);
}

function skillDir(root, name, skillName, { ageDays = 0 } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, `---\nname: ${skillName}\ndescription: 测试技能\n---\n\nbody\n`);
  if (ageDays) age(file, ageDays);
  return dir;
}

test('配置审计：三层记忆预算、180 天 TTL 与悬空索引条目', (t) => {
  const root = tmp(t);
  const claude = path.join(root, 'claude');
  const mem = path.join(claude, 'memory');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), '# 索引\n\n- [缺失](gone.md) — 悬空\n- [身份](identity-00.md) — 保留\n- [过期](project-old.md) — 过期\n');

  for (let i = 0; i < IDENTITY_LIMIT + 1; i += 1) {
    const file = memoryFile(mem, `identity-${String(i).padStart(2, '0')}.md`, 'user');
    age(file, i === 0 ? 90 : 1);
  }
  const expired = memoryFile(mem, 'project-old.md', 'project');
  age(expired, PROJECT_TTL_DAYS + 20);

  const audit = auditConfig({ claudeDir: claude, now: () => NOW, archiveDir: path.join(root, 'archive'), root: path.join(root, 'cleanup') });
  assert.equal(audit.ok, true);
  assert.equal(audit.memory.layers.identity.count, IDENTITY_LIMIT + 1);
  assert.equal(audit.memory.layers.identity.limit, IDENTITY_LIMIT);
  assert.equal(audit.memory.layers.workflow.limit, WORKFLOW_LIMIT);
  assert.equal(audit.memory.layers.project.count, 1);
  assert.equal(audit.memory.overBudget.length, 1);
  assert.equal(audit.indexes.danglingEntries, 1);

  const over = audit.candidates.find((c) => c.path.endsWith(`${path.sep}identity-00.md`));
  assert.ok(over, '最老的超预算记忆应成为候选');
  assert.equal(over.category, 'memory-over-budget');
  assert.equal(over.bucket, 'pending');
  assert.ok(over.evidenceLines.length >= 2);

  const expiredCandidate = audit.candidates.find((c) => c.path === expired);
  assert.ok(expiredCandidate, '超过 TTL 的项目事实应成为候选');
  assert.equal(expiredCandidate.category, 'memory-expired');
  assert.equal(expiredCandidate.removeIndexLine, true);

  const index = audit.candidates.find((c) => c.category === 'dangling-index');
  assert.ok(index);
  assert.equal(index.kind, 'index-entries');
  assert.equal(index.bucket, 'confirmed');
  assert.equal(index.entries.length, 1);
  assert.match(index.entries[0].target, /gone\.md/);
  assert.ok(index.archiveTo.includes('config-cleanup-2026-10-18'));
});

test('配置审计：重复技能、60 天未用技能与 zip 重复', (t) => {
  const root = tmp(t);
  const claude = path.join(root, 'claude');
  const skills = path.join(claude, 'skills');
  skillDir(skills, 'a', 'alpha', { ageDays: 0 });
  skillDir(skills, 'b', 'alpha', { ageDays: 10 });
  skillDir(skills, 'old', 'beta', { ageDays: SKILL_UNUSED_DAYS + 1 });
  skillDir(skills, 'zipdupe', 'zeta', { ageDays: 0 });
  fs.writeFileSync(path.join(skills, 'zipdupe.zip'), 'not-a-real-zip');

  const audit = auditConfig({ claudeDir: claude, now: () => NOW, archiveDir: path.join(root, 'archive'), root: path.join(root, 'cleanup') });
  assert.equal(audit.skills.uniqueCount, 3);
  assert.equal(audit.skills.duplicateCount, 1);
  assert.equal(audit.skills.unusedCount, 1);

  const dup = audit.candidates.find((c) => c.category === 'duplicate-skill');
  assert.ok(dup);
  assert.match(dup.path, /skills[/\\]b$/);

  const unused = audit.candidates.find((c) => c.category === 'skill-unused');
  assert.ok(unused);
  assert.match(unused.path, /skills[/\\]old$/);
  assert.equal(unused.bucket, 'pending');

  const zip = audit.candidates.find((c) => c.category === 'zip-duplicate');
  assert.ok(zip);
  assert.match(zip.path, /zipdupe\.zip$/);
  assert.equal(zip.bucket, 'confirmed');
});

test('配置审计：技能总数超过 20 个预算时取最老的超额技能', (t) => {
  const root = tmp(t);
  const claude = path.join(root, 'claude');
  const skills = path.join(claude, 'skills');
  for (let i = 0; i < SKILL_LIMIT + 1; i += 1) {
    skillDir(skills, `s-${String(i).padStart(2, '0')}`, `skill-${i}`, { ageDays: i === 0 ? 100 : i });
  }
  const audit = auditConfig({ claudeDir: claude, now: () => NOW, archiveDir: path.join(root, 'archive'), root: path.join(root, 'cleanup') });
  assert.equal(audit.skills.uniqueCount, SKILL_LIMIT + 1);
  // 最老技能同时命中“60 天未用”和“超预算”，同一路径合并为一条候选。
  const over = audit.candidates.find((c) => /s-00$/.test(c.path));
  assert.ok(over);
  assert.match(over.bucketReason, new RegExp(`超过 ${SKILL_LIMIT} 个预算`));
  assert.ok(over.evidenceLines.some((e) => e.includes(`上限 ${SKILL_LIMIT}`)));
});

test('配置审计：超过 30 天的 session 按月归档候选', (t) => {
  const root = tmp(t);
  const claude = path.join(root, 'claude');
  const proj = path.join(claude, 'projects', 'proj-a');
  fs.mkdirSync(proj, { recursive: true });
  const old = path.join(proj, 'old.jsonl');
  const fresh = path.join(proj, 'fresh.jsonl');
  fs.writeFileSync(old, '{"x":1}\n');
  fs.writeFileSync(fresh, '{"x":2}\n');
  age(old, SESSION_ARCHIVE_DAYS + 15);

  const audit = auditConfig({ claudeDir: claude, now: () => NOW, archiveDir: path.join(root, 'archive'), root: path.join(root, 'cleanup') });
  assert.equal(audit.sessions.count, 2);
  assert.equal(audit.sessions.oldCount, 1);
  const candidate = audit.candidates.find((c) => c.category === 'session-archive');
  assert.ok(candidate);
  assert.equal(candidate.path, old);
  assert.match(candidate.archiveTo.replace(/\\/g, '/'), /sessions\/\d{4}-\d{2}\/proj-a\/old\.jsonl$/);
  assert.ok(!audit.candidates.some((c) => c.path === fresh));
});

test('配置提案复用清理决策：勾选待定桶、执行前归档、30 天内可恢复', (t) => {
  const root = tmp(t);
  const claude = path.join(root, 'claude');
  const archive = path.join(root, 'archive');
  const cleanupRoot = path.join(root, 'cleanup');
  const mem = path.join(claude, 'memory');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), '# 索引\n\n- [缺失](gone.md) — 悬空\n- [过期](project-old.md) — 过期\n');
  const expired = memoryFile(mem, 'project-old.md', 'project', '旧事实');
  age(expired, PROJECT_TTL_DAYS + 20);

  const audit = auditConfig({ claudeDir: claude, now: () => NOW, archiveDir: archive, root: cleanupRoot });
  const proposal = buildConfigProposal({ audit, now: () => NOW });
  assert.equal(proposal.kind, 'config');
  assert.equal(proposal.status, 'complete');
  assert.deepEqual(proposal.policy.selectableBuckets, ['confirmed', 'pending']);
  assert.equal(proposal.policy.branch, null);
  assert.equal(proposal.counts.confirmed, 1);
  assert.equal(proposal.counts.pending, 1);

  const dir = path.join(cleanupRoot, '_config', audit.date);
  const files = writeConfigProposal(dir, proposal);
  assert.ok(fs.existsSync(files.jsonPath));
  assert.ok(fs.existsSync(files.mdPath));
  assert.equal(readConfigProposal(dir).proposalId, proposal.proposalId);

  const built = buildDecisions({ proposal, selectAll: true, now: () => NOW });
  assert.equal(built.ok, true);
  assert.equal(built.decisions.kind, 'config');
  assert.equal(built.decisions.branch, null);
  assert.equal(built.decisions.selectedCount, 2);
  const indexItem = built.decisions.items.find((i) => i.kind === 'index-entries');
  assert.equal(indexItem.action, 'delete');
  assert.ok(Array.isArray(indexItem.entries));
  const fileItem = built.decisions.items.find((i) => i.path === expired);
  assert.equal(fileItem.action, 'delete');
  assert.equal(fileItem.removeIndexLine, true);

  const decisionsFile = writeDecisions(dir, built.decisions);
  assert.ok(fs.existsSync(decisionsFile));

  const dry = executeConfig({ dir, decisions: built.decisions, now: () => NOW, archiveRootDir: archive });
  assert.equal(dry.ok, true);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.deleteCount, 2);
  assert.ok(fs.existsSync(expired), 'dry-run 不删除任何文件');

  const real = executeConfig({ dir, decisions: built.decisions, dryRun: false, now: () => NOW, archiveRootDir: archive });
  assert.equal(real.ok, true);
  assert.equal(real.archivedDeleted, 2);
  assert.equal(real.failed, 0);
  assert.ok(!fs.existsSync(expired));
  const indexText = fs.readFileSync(path.join(mem, 'MEMORY.md'), 'utf8');
  assert.ok(!indexText.includes('gone.md'));
  assert.ok(!indexText.includes('project-old.md'));
  const receipt = readConfigReceipt(dir);
  assert.equal(receipt.results.length, 2);
  assert.ok(receipt.results.every((r) => r.archivePath && fs.existsSync(r.archivePath)));
  assert.ok(receipt.results.every((r) => new Date(r.recoverableUntil) > NOW));

  const restored = restoreConfig({ dir, now: () => NOW });
  assert.equal(restored.ok, true);
  assert.equal(restored.restored.length, 2);
  assert.ok(fs.existsSync(expired));
  assert.match(fs.readFileSync(expired, 'utf8'), /旧事实/);
  const back = fs.readFileSync(path.join(mem, 'MEMORY.md'), 'utf8');
  assert.ok(back.includes('gone.md'));
  assert.ok(back.includes('project-old.md'));
});

test('配置审计不读取 settings、history、session 正文或密钥文件', (t) => {
  const root = tmp(t);
  const claude = path.join(root, 'claude');
  const mem = path.join(claude, 'memory');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), '# 索引\n\n- [密钥](secret.md) — 不应读取\n');
  fs.writeFileSync(path.join(mem, 'secret.md'), '---\nname: secret\ndescription: t\nmetadata:\n  type: user\n---\nsk-live-xxx\n');
  fs.writeFileSync(path.join(claude, 'settings.json'), '{"apiKey":"sk-live-xxx"}');
  fs.writeFileSync(path.join(claude, 'history.jsonl'), '{"prompt":"secret"}\n');
  const proj = path.join(claude, 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'session.jsonl'), '{"text":"secret"}\n');

  const audit = auditConfig({ claudeDir: claude, now: () => NOW, archiveDir: path.join(root, 'archive'), root: path.join(root, 'cleanup') });
  assert.equal(audit.ok, true);
  assert.equal(audit.memory.layers.identity.count, 0);
  assert.ok(!audit.candidates.some((c) => /settings|history|secret\.md/i.test(c.path)));
  assert.ok(NEVER_READ.test(path.join(claude, 'settings.json')));
  assert.ok(NEVER_READ.test(path.join(claude, 'history.jsonl')));
  assert.ok(NEVER_READ.test(path.join(proj, 'session.jsonl')));
});

test('配置审计 CLI：propose → decide --select-all → execute dry-run', (t) => {
  const root = tmp(t);
  const claude = path.join(root, 'claude');
  const cleanupRoot = path.join(root, 'cleanup');
  const archive = path.join(root, 'archive');
  const mem = path.join(claude, 'memory');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), '# 索引\n\n- [缺失](gone.md) — 悬空\n');

  const cli = path.join(__dirname, '..', 'world', 'config-audit', 'cli.js');
  const env = { ...process.env, WORLD_CONFIG_ARCHIVE_DIR: archive };
  const metricsDir = path.join(root, 'metrics');
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [cli, ...args, '--claude-dir', claude, '--root', cleanupRoot, '--metrics-dir', metricsDir, '--json'], { encoding: 'utf8', env }));

  const proposed = run('propose');
  assert.equal(proposed.ok, true);
  assert.ok(fs.existsSync(proposed.jsonPath));
  assert.match(fs.readFileSync(path.join(metricsDir, 'events.jsonl'), 'utf8'), /"type":"cleanup-proposal"/);

  const decided = run('decide', '--select-all');
  assert.equal(decided.ok, true);
  assert.equal(decided.decisions.selectedCount, 1);

  const dry = run('execute');
  assert.equal(dry.ok, true);
  assert.equal(dry.deleteCount, 1);
  assert.ok(fs.existsSync(path.join(mem, 'MEMORY.md')));
});
