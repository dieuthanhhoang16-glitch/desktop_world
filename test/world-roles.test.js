// test/world-roles.test.js
// 角色层：契约/角色卡幂等、提示拼装顺序、空配置隔离、worktree 边界、权限矩阵、漂移检查。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const launcher = require('../world/roles/launcher');
const { composePrompt } = require('../world/roles/prompt');

function tmpDir(prefix = 'dwroles-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeRepo() {
  const dir = tmpDir('dwroles-repo-');
  git(dir, ['init']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init']);
  return dir;
}

test('initRoles：建契约与三张卡；重复运行不覆盖', () => {
  const root = tmpDir();
  const first = launcher.initRoles({ root });
  assert.deepEqual(first.created.sort(), ['cards/ds.md', 'cards/glm.md', 'cards/jev.md', 'contract.md']);
  assert.equal(first.existed.length, 0);

  fs.appendFileSync(path.join(root, 'cards', 'glm.md'), '\n用户手改\n');
  const second = launcher.initRoles({ root });
  assert.equal(second.created.length, 0);
  assert.equal(second.existed.length, 4);
  assert.match(fs.readFileSync(path.join(root, 'cards', 'glm.md'), 'utf8'), /用户手改/);
});

test('checkRoles：无漂移通过；改卡/加未知卡会报告', () => {
  const root = tmpDir();
  launcher.initRoles({ root });
  assert.equal(launcher.checkRoles({ root }).ok, true);

  fs.appendFileSync(path.join(root, 'cards', 'ds.md'), '\n漂移\n');
  let r = launcher.checkRoles({ root });
  assert.equal(r.ok, false);
  assert.ok(r.drift.some((d) => d.kind === 'hash-mismatch' && d.file === 'cards/ds.md'));

  launcher.initRoles({ root });
  fs.writeFileSync(path.join(root, 'cards', 'other.md'), '# other\n');
  r = launcher.checkRoles({ root });
  assert.ok(r.drift.some((d) => d.kind === 'unknown-card'));
});

test('composePrompt：契约 → 角色卡 → 简报，哈希稳定', () => {
  const a = composePrompt({ contract: 'C', card: 'R', brief: 'B' });
  const b = composePrompt({ contract: 'C', card: 'R', brief: 'B' });
  assert.equal(a.hash, b.hash);
  assert.ok(a.text.indexOf('SECTION:CONTRACT') < a.text.indexOf('SECTION:ROLE-CARD'));
  assert.ok(a.text.indexOf('SECTION:ROLE-CARD') < a.text.indexOf('SECTION:TASK-BRIEF'));
  assert.throws(() => composePrompt({ contract: 'C', card: 'R', brief: '' }), /任务简报/);
});

test('权限矩阵：ds/jev 只读；glm 只能碰本 worktree；密钥一律拒绝', () => {
  assert.equal(launcher.assertAllowed('ds', 'read', { path: '/tmp/project/a.md' }).ok, true);
  assert.equal(launcher.assertAllowed('ds', 'write', { path: '/tmp/project/a.md' }).ok, false);
  assert.equal(launcher.assertAllowed('ds', 'external', {}).ok, true);

  assert.equal(launcher.assertAllowed('jev', 'write', {}).ok, false);
  assert.equal(launcher.assertAllowed('jev', 'read', { path: '/home/u/.env' }).ok, false);

  const worktree = path.join(tmpDir(), 'wt');
  assert.equal(launcher.assertAllowed('glm', 'read', { path: path.join(worktree, 'a.js'), worktreeDir: worktree }).ok, true);
  assert.equal(launcher.assertAllowed('glm', 'write', { path: path.join(worktree, 'a.js'), worktreeDir: worktree }).ok, true);
  assert.equal(launcher.assertAllowed('glm', 'write', { path: '/etc/passwd', worktreeDir: worktree }).ok, false);
  assert.equal(launcher.assertAllowed('glm', 'external', {}).ok, false);
  assert.equal(launcher.assertAllowed('glm', 'external', { networkApproved: true }).ok, true);
  assert.equal(launcher.assertAllowed('glm', 'read', { path: path.join(worktree, '.env'), worktreeDir: worktree }).ok, false);
});

test('createRun(glm)：空 config、独立 worktree、受围栏 env、回执与变更清单', () => {
  const root = tmpDir();
  launcher.initRoles({ root });
  const project = makeRepo();
  let seen = null;

  const receipt = launcher.createRun({
    role: 'glm',
    project,
    task: '在 fixture 里写一个文件',
    root,
    runId: 'r1',
    spawn(command, args, opts) {
      seen = { command, args, opts };
      fs.writeFileSync(path.join(opts.cwd, 'fixture.txt'), 'done\n');
      return { status: 0, stdout: 'ok', stderr: '' };
    },
    sourceEnv: { PATH: process.env.PATH, HOME: process.env.HOME, JEV_API: 'secret-should-not-pass' },
  });

  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.ok, true);
  assert.equal(receipt.role, 'glm');
  assert.equal(receipt.worktree.kind, 'git-worktree');
  assert.ok(fs.existsSync(path.join(receipt.worktree.path, 'fixture.txt')));
  assert.deepEqual(receipt.changedFiles, ['fixture.txt']);

  // 原项目不受影响
  assert.equal(fs.existsSync(path.join(project, 'fixture.txt')), false);

  // 空配置：没有 skills/plugins/memory，只有本次 run 的空目录
  const cfgNames = fs.readdirSync(receipt.configDir).sort();
  assert.deepEqual(cfgNames, ['claude', 'codex', 'pi', 'xdg']);
  for (const name of cfgNames) assert.deepEqual(fs.readdirSync(path.join(receipt.configDir, name)), []);

  // 围栏：cwd 是 worktree；模型密钥不传给 glm；默认禁网
  assert.equal(seen.opts.cwd, receipt.worktree.path);
  assert.equal(seen.opts.env.WORLD_ROLE, 'glm');
  assert.equal(seen.opts.env.JEV_API, undefined);
  assert.equal(seen.opts.env.HTTP_PROXY, 'http://127.0.0.1:9');
  assert.equal(seen.opts.env.CLAUDE_CONFIG_DIR, path.join(receipt.configDir, 'claude'));

  // 提示顺序
  const prompt = fs.readFileSync(path.join(root, 'runs', 'r1', 'prompt.md'), 'utf8');
  assert.ok(prompt.indexOf('SECTION:CONTRACT') < prompt.indexOf('SECTION:ROLE-CARD'));
  assert.ok(prompt.indexOf('SECTION:ROLE-CARD') < prompt.indexOf('SECTION:TASK-BRIEF'));

  // 回执落盘
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'runs', 'r1', 'receipt.json'), 'utf8'));
  assert.equal(onDisk.promptHash, receipt.promptHash);
  assert.equal(onDisk.permissionsFile, undefined); // 权限文件名不进回执，路径由 env 指向
});

test('createRun(ds)：只读角色不建 worktree，cwd 是项目', () => {
  const root = tmpDir();
  launcher.initRoles({ root });
  const project = makeRepo();
  let seen = null;
  const receipt = launcher.createRun({
    role: 'ds',
    project,
    task: '分析 README',
    root,
    runId: 'r2',
    spawn(command, args, opts) {
      seen = { command, args, opts };
      return { status: 0, stdout: 'analysis', stderr: '' };
    },
    sourceEnv: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  assert.equal(receipt.worktree.kind, 'none');
  assert.equal(seen.opts.cwd, project);
  assert.equal(receipt.changedFiles.length, 0);
});

test('createRun(dry-run)：不建 worktree、不 spawn，回执为 planned', () => {
  const root = tmpDir();
  launcher.initRoles({ root });
  const project = makeRepo();
  let called = false;
  const receipt = launcher.createRun({
    role: 'glm',
    project,
    task: 'dry run',
    root,
    runId: 'r3',
    dryRun: true,
    spawn() {
      called = true;
      return { status: 0 };
    },
  });
  assert.equal(called, false);
  assert.equal(receipt.status, 'planned');
  assert.equal(receipt.worktree.planned, true);
  assert.equal(fs.existsSync(receipt.worktree.path), false);
});
