// test/world-project.test.js
// 项目层：只读标记检查、registry 幂等、seed 范围、非覆盖 ensure、manifest、回执。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const markers = require('../world/projects/markers');
const registry = require('../world/projects/registry');
const { ensure, gapReport } = require('../world/projects/ensure');
const manifest = require('../world/projects/manifest');

function tmpDir(prefix = 'dwproj-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(root, rel, body) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function fullProject({ dir = tmpDir('dwproj-full-'), agentFile = 'AGENTS.md' } = {}) {
  write(dir, 'docs/agents/issue-tracker.md', '# issue tracker\n');
  write(dir, 'docs/agents/domain.md', '# domain\n');
  write(dir, 'GLOSSARY.md', '# glossary\n');
  write(dir, agentFile, `# fixture\n\n## Agent skills\n`);
  return dir;
}

test('checkMarkers：missing / partial / initialized 三态，且只读', () => {
  const empty = tmpDir();
  let r = markers.checkMarkers(empty);
  assert.equal(r.status, 'missing');
  assert.deepEqual(r.missing, markers.REQUIRED);
  assert.deepEqual(r.optionalMissing, markers.OPTIONAL);
  assert.deepEqual(fs.readdirSync(empty), []);

  write(empty, 'docs/agents/issue-tracker.md', '# it\n');
  r = markers.checkMarkers(empty);
  assert.equal(r.status, 'partial');

  const full = fullProject();
  r = markers.checkMarkers(full);
  assert.equal(r.status, 'initialized');
  assert.deepEqual(r.missing, []);
  assert.equal(markers.badge('initialized'), null);
  assert.equal(markers.badge('missing').label, '未初始化');
});

test('registry：显式添加幂等；list/remove；seed 只认 Documents 下含 .git 的直属目录', () => {
  const file = path.join(tmpDir(), 'projects.json');
  const project = fullProject();

  const first = registry.addProject(file, project);
  const second = registry.addProject(file, project);
  assert.equal(first.added, true);
  assert.equal(second.added, false);
  assert.equal(registry.listProjects(file).length, 1);
  assert.equal(registry.listProjects(file)[0].status, 'initialized');

  const documents = tmpDir('dwproj-docs-');
  fs.mkdirSync(path.join(documents, 'repo', '.git'), { recursive: true });
  fs.mkdirSync(path.join(documents, 'plain'), { recursive: true });
  fs.mkdirSync(path.join(documents, '.hidden', '.git'), { recursive: true });
  const candidates = registry.seedCandidates({ documentsDir: documents });
  assert.deepEqual(candidates.map((c) => c.name), ['repo']);

  assert.equal(registry.removeProject(file, project).removed, true);
  assert.equal(registry.listProjects(file).length, 0);
});

test('checkProject：检查不创建 .world/、不写项目文件，只更新 registry 缓存', () => {
  const file = path.join(tmpDir(), 'projects.json');
  const project = tmpDir();
  write(project, 'docs/agents/issue-tracker.md', '# it\n');
  const before = fs.readdirSync(project).sort();

  const record = registry.checkProject(file, project);
  assert.equal(record.status, 'partial');
  assert.equal(record.lastCheckedAt !== undefined, true);
  assert.deepEqual(fs.readdirSync(project).sort(), before);
  assert.equal(fs.existsSync(path.join(project, '.world')), false);

  const cached = registry.listProjects(file)[0];
  assert.equal(cached.status, 'partial');
});

test('ensure：只补缺失文件，已有 AGENTS.md 仅追加保留原文，写 manifest 与回执', async () => {
  const project = tmpDir();
  write(project, 'AGENTS.md', '# 用户项目\n\n用户自己的内容\n');
  const ensureRoot = tmpDir('dwproj-ensure-');
  let runs = 0;

  const result = await ensure({
    projectPath: project,
    ensureRoot,
    standardVersion: '1.3.1',
    runId: 'run1',
    now: () => new Date('2026-10-18T00:00:00Z'),
    setupRunner: ({ projectPath }) => {
      runs += 1;
      write(projectPath, 'docs/agents/issue-tracker.md', '# issue tracker\n');
      write(projectPath, 'docs/agents/domain.md', '# domain\n');
      write(projectPath, 'GLOSSARY.md', '# glossary\n');
      fs.appendFileSync(path.join(projectPath, 'AGENTS.md'), '\n## Agent skills\n\n- ticket 工具\n');
      return { status: 0, stdout: 'done', stderr: '' };
    },
  });

  assert.equal(runs, 1);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'initialized');
  assert.equal(markers.checkMarkers(project).status, 'initialized');
  assert.match(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8'), /用户自己的内容/);
  assert.match(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8'), /## Agent skills/);

  const m = JSON.parse(fs.readFileSync(path.join(project, '.world', 'project.json'), 'utf8'));
  assert.equal(m.standard, 'mattpocock-skills');
  assert.equal(m.standardVersion, '1.3.1');
  assert.equal(m.status, 'initialized');
  assert.equal(m.project, project);
  assert.ok(m.generatedFiles.includes('docs/agents/issue-tracker.md'));
  assert.ok(m.generatedFiles.includes('GLOSSARY.md'));

  // 回执按 slug/runId 落盘，可审计
  const { projectSlug } = require('../world/projects/paths');
  assert.ok(fs.existsSync(path.join(ensureRoot, projectSlug(project), 'run1.json')));

  // 再次 ensure：不 spawn、不写盘
  const mtime = fs.statSync(path.join(project, '.world', 'project.json')).mtimeMs;
  const again = await ensure({
    projectPath: project,
    ensureRoot,
    runId: 'run2',
    setupRunner: () => {
      runs += 1;
      return { status: 0 };
    },
  });
  assert.equal(again.ok, true);
  assert.equal(again.noop, true);
  assert.equal(runs, 1);
  assert.equal(fs.statSync(path.join(project, '.world', 'project.json')).mtimeMs, mtime);
});

test('ensure：运行器改写已有文件会被还原并判失败，不写 manifest', async () => {
  const project = tmpDir();
  write(project, 'AGENTS.md', '# 用户项目\n\n不可覆盖\n');
  write(project, 'docs/agents/issue-tracker.md', '# 既有工单\n');
  const ensureRoot = tmpDir('dwproj-ensure-');

  const result = await ensure({
    projectPath: project,
    ensureRoot,
    runId: 'bad1',
    setupRunner: ({ projectPath: root }) => {
      write(root, 'AGENTS.md', '# 被覆盖\n');
      write(root, 'docs/agents/issue-tracker.md', '# 被覆盖\n');
      write(root, 'docs/agents/domain.md', '# domain\n');
      write(root, 'GLOSSARY.md', '# glossary\n');
      return { status: 0 };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'existing-file-modified');
  assert.deepEqual(result.restored.sort(), ['AGENTS.md', 'docs/agents/issue-tracker.md']);
  assert.equal(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8'), '# 用户项目\n\n不可覆盖\n');
  assert.equal(fs.readFileSync(path.join(project, 'docs/agents/issue-tracker.md'), 'utf8'), '# 既有工单\n');
  assert.equal(fs.existsSync(path.join(project, '.world', 'project.json')), false);
});

test('ensure：setup skill 不可用时只报告缺口，不写任何项目文件', async () => {
  const project = tmpDir();
  write(project, 'README.md', '# fixture\n');
  const before = fs.readdirSync(project).sort();
  const ensureRoot = tmpDir('dwproj-ensure-');

  const result = await ensure({ projectPath: project, ensureRoot, setupRunner: null, runId: 'na1' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'setup-skill-unavailable');
  assert.ok(result.gaps.missing.includes('issueTracker'));
  assert.deepEqual(fs.readdirSync(project).sort(), before);
  assert.equal(fs.existsSync(path.join(project, '.world')), false);
  assert.ok(fs.existsSync(path.join(ensureRoot, require('../world/projects/paths').projectSlug(project), 'na1.json')));
});

test('ensure dry-run：只出缺口报告，不 spawn、不写盘', async () => {
  const project = tmpDir();
  let called = false;
  const result = await ensure({
    projectPath: project,
    dryRun: true,
    setupRunner: () => {
      called = true;
      return { status: 0 };
    },
  });
  assert.equal(called, false);
  assert.equal(result.dryRun, true);
  assert.equal(result.planned, true);
  assert.ok(result.gaps.items.length > 0);
  assert.deepEqual(fs.readdirSync(project), []);
});

test('manifest：generatedFiles 并集、registeredAt 保留、registeredAt 不被 ensure 重置', () => {
  const project = tmpDir();
  const check = markers.checkMarkers(project);
  const first = manifest.buildManifest({
    projectPath: project,
    check,
    now: () => new Date('2026-10-01T00:00:00Z'),
    standardVersion: '1.3.1',
    generatedFiles: ['docs/agents/domain.md'],
  });
  const second = manifest.buildManifest({
    projectPath: project,
    check,
    previous: first,
    now: () => new Date('2026-10-02T00:00:00Z'),
    generatedFiles: ['docs/agents/issue-tracker.md'],
  });
  assert.equal(second.registeredAt, first.registeredAt);
  assert.deepEqual(second.generatedFiles, ['docs/agents/domain.md', 'docs/agents/issue-tracker.md']);
  assert.equal(second.lastEnsureAt, '2026-10-02T00:00:00.000Z');
});

test('gapReport：纯只读，返回期望路径', () => {
  const project = tmpDir();
  const report = gapReport(project);
  assert.equal(report.ok, false);
  assert.equal(report.status, 'missing');
  assert.equal(report.items.find((i) => i.id === 'issueTracker').expected, 'docs/agents/issue-tracker.md');
  assert.deepEqual(fs.readdirSync(project), []);
});
