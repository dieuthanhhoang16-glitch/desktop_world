// test/world-roles-launch.test.js
// world/roles/launcher.js + world/roles/runners/glm-fixture.js：
// 一条 `world:roles launch glm --task <brief>` 命令应该
//   · 准备干净的 config-dir（只有 system-prompt.md 和 prompt.manifest.json，
//     不得出现用户级 skills/plugins/memory）
//   · 在独立 git worktree 里跑 glm（本 ticket 用确定性 fixture runner）
//   · 在独立 session 目录里留会话占位
//   · 写一份回执 receipt.json（角色/模型/worktree/变更清单/耗时）
//   · 不碰 worktree 之外的任何文件
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('node:child_process');

const initRoles = require('../world/roles/init');
const launcher = require('../world/roles/launcher');

// 建一个独立的 git 小仓：launcher 要在它里面开 worktree。
function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'world-roles-repo-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture repo\n', 'utf8');
  fs.writeFileSync(path.join(repo, 'MARKER.txt'), 'do-not-touch\n', 'utf8');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
  return repo;
}

function sha1File(p) {
  return require('crypto').createHash('sha1').update(fs.readFileSync(p)).digest('hex');
}

// 快照一个目录下所有文件的相对路径 + 内容 hash，用来断言"worktree 外没被改"。
function snapshotTree(root, exclude = []) {
  const out = new Map();
  const walk = (dir, rel) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (exclude.some((ex) => r === ex || r.startsWith(ex + '/'))) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs, r);
      else if (ent.isFile()) out.set(r, sha1File(abs));
    }
  };
  walk(root, '');
  return out;
}

function assertTreeEqual(before, after, msg) {
  const bKeys = [...before.keys()].sort();
  const aKeys = [...after.keys()].sort();
  assert.deepStrictEqual(aKeys, bKeys, `${msg}: 文件清单变了`);
  for (const k of bKeys) {
    assert.strictEqual(after.get(k), before.get(k), `${msg}: ${k} 内容被改`);
  }
}

function briefFile(dir, text) {
  const p = path.join(dir, 'brief.md');
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

test('launch glm 在空 config dir / 独立 worktree / 独立 session 中完成 fixture 任务并写回执', () => {
  const rolesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'world-roles-root-'));
  const repo = makeRepo();
  const briefPath = briefFile(repo, '#  Fixture 任务：在 worktree 里写 HELLO.txt\n');

  // 契约 + 三张角色卡是 launch 的前置（不 init 就不让跑，由 init 测试覆盖）
  initRoles.run({ root: rolesRoot });

  // 给"worktree 外文件未被修改"留基线
  const repoBefore = snapshotTree(repo, ['.git', 'runs']);

  const result = launcher.launchGlm({
    rolesRoot,
    repo,
    briefPath,
    model: 'jd-glm53',
    // fixture 是默认 runner；显式传一遍更稳，避免被将来改默认值绊倒
    runnerKind: 'fixture',
  });

  assert.strictEqual(result.ok, true, result.error || 'launch 应成功');
  assert.ok(result.runId, '回执里必须有 runId');
  const runDir = result.runDir;
  assert.ok(runDir.startsWith(path.join(rolesRoot, 'runs') + path.sep), 'runs/<runId> 必须落在 rolesRoot 下');

  // ---- ① config dir 只含 system-prompt.md 与 manifest，不能混入用户级配置
  const configDir = path.join(runDir, 'config-dir');
  const configEntries = fs.readdirSync(configDir).sort();
  assert.deepStrictEqual(configEntries, ['prompt.manifest.json', 'system-prompt.md']);
  const sys = fs.readFileSync(path.join(configDir, 'system-prompt.md'), 'utf8');
  // 顺序：契约 → 角色卡 → 简报
  const iContract = sys.indexOf('全局契约');
  const iCard = sys.indexOf('glm 角色卡');
  const iBrief = sys.indexOf('Fixture 任务');
  assert.ok(iContract >= 0 && iCard > iContract && iBrief > iCard, '拼装顺序漂移');

  const manifest = JSON.parse(fs.readFileSync(path.join(configDir, 'prompt.manifest.json'), 'utf8'));
  assert.deepStrictEqual(manifest.order, ['contract', 'card', 'brief']);
  assert.strictEqual(manifest.role, 'glm');
  assert.strictEqual(manifest.model, 'jd-glm53');
  // config dir 里绝不能出现这几个用户级成员
  for (const banned of ['skills', 'plugins', 'memory', 'settings.json', 'CLAUDE.md', 'agents', 'hooks']) {
    assert.ok(!configEntries.includes(banned), `config-dir 不允许出现 ${banned}`);
  }

  // ---- ② 独立 worktree：在 runDir/worktree，分支名带 runId
  const worktreeDir = path.join(runDir, 'worktree');
  assert.ok(fs.existsSync(worktreeDir), 'worktree 目录必须存在');
  const branch = execFileSync('git', ['-C', worktreeDir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.ok(branch.includes(result.runId), `分支 ${branch} 没含 runId`);

  // ---- ③ 独立 session 目录
  const sessionDir = path.join(runDir, 'session');
  assert.ok(fs.statSync(sessionDir).isDirectory(), 'session 目录必须存在');

  // ---- ④ fixture 任务真的做了：HELLO.txt 出现在 worktree 内
  assert.ok(fs.existsSync(path.join(worktreeDir, 'HELLO.txt')), 'fixture 任务产物缺失');

  // ---- ⑤ 回执字段齐
  const receiptPath = path.join(runDir, 'receipt.json');
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  assert.strictEqual(receipt.role, 'glm');
  assert.strictEqual(receipt.model, 'jd-glm53');
  assert.strictEqual(receipt.runId, result.runId);
  assert.ok(receipt.worktree && receipt.worktree.path === worktreeDir);
  assert.ok(receipt.worktree.branch.includes(result.runId));
  assert.ok(Array.isArray(receipt.changedFiles), 'changedFiles 必须是数组');
  assert.ok(receipt.changedFiles.includes('HELLO.txt'), `changedFiles 必须含 HELLO.txt，实际 ${JSON.stringify(receipt.changedFiles)}`);
  assert.ok(Number.isFinite(receipt.durationMs) && receipt.durationMs >= 0);
  assert.ok(receipt.startedAt && receipt.finishedAt);
  // fixture 应汇报自己的 exit code，便于失败后追查
  assert.strictEqual(receipt.runner.exitCode, 0);

  // ---- ⑥ worktree 之外的 repo 文件没被改
  const repoAfter = snapshotTree(repo, ['.git', 'runs']);
  assertTreeEqual(repoBefore, repoAfter, 'repo 内 worktree 之外的文件');

  // 主 repo 的 HEAD 也不允许动（万一 launcher 误用 commit 而不是 worktree commit）
  const headAfter = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.match(headAfter, /^[0-9a-f]{40}$/);
});

test('launch glm 时 runner 进程不继承父进程 env（spec §2 权限由启动器强制）', () => {
  const rolesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'world-roles-root-'));
  const repo = makeRepo();
  const briefPath = briefFile(repo, '# t\n');
  initRoles.run({ root: rolesRoot });

  // canary：如果 launcher 整包继承 process.env，这个值一定会漏到 runner 那边
  const CANARY = 'CANARY_SECRET_' + Date.now();
  process.env[CANARY] = 'must-not-leak';
  let result;
  try {
    result = launcher.launchGlm({ rolesRoot, repo, briefPath, model: 'jd-glm53', runnerKind: 'fixture' });
  } finally {
    delete process.env[CANARY];
  }

  assert.strictEqual(result.ok, true, result.error || 'launch 应成功');
  const witnessPath = path.join(result.runDir, 'session', 'env-witness.json');
  const witness = JSON.parse(fs.readFileSync(witnessPath, 'utf8'));
  assert.ok(!witness.keys.includes(CANARY), `canary ${CANARY} 漏到了 runner env 里`);
  // 但 WORLD_* 必须齐——这是 launcher 与 runner 的合约
  for (const k of ['WORLD_ROLE', 'WORLD_MODEL', 'WORLD_RUN_ID', 'WORLD_CONFIG_DIR', 'WORLD_WORKTREE', 'WORLD_SESSION_DIR', 'WORLD_BRIEF_PATH']) {
    assert.ok(witness.keys.includes(k), `缺 ${k}`);
    assert.ok(witness.worldVars[k] !== undefined, `worldVars.${k} 为空`);
  }
});

test('launch glm runner 退出非零时 exitCode 不为 0（signal/error 不得被当作成功）', () => {
  const rolesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'world-roles-root-'));
  const repo = makeRepo();
  const briefPath = briefFile(repo, '# t\n');
  initRoles.run({ root: rolesRoot });

  // 传一个极短 timeout，让 spawnSync 触发 ETIMEDOUT 杀掉 runner
  const result = launcher.launchGlm({
    rolesRoot,
    repo,
    briefPath,
    model: 'jd-glm53',
    runnerKind: 'fixture',
    runnerTimeoutMs: 1, // 1ms 必超时
  });

  // launch 不一定能拿到 receipt（runner 可能没起来），但如果有 receipt，exitCode 绝不能是 0
  if (result.receiptPath) {
    const receipt = JSON.parse(fs.readFileSync(result.receiptPath, 'utf8'));
    assert.notStrictEqual(receipt.runner.exitCode, 0, 'runner 被信号杀掉时 exitCode 绝不允许是 0');
  }
  // timeout 一发生 launcher 就应该告知失败
  assert.strictEqual(result.ok, false, '超时仍返回 ok=true 是在掩盖失败');
});

test('launch glm 缺少契约/角色卡时明确拒绝，不默默生成', () => {
  const rolesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'world-roles-root-'));
  const repo = makeRepo();
  const briefPath = briefFile(repo, '# t\n');
  // 不调用 initRoles
  const result = launcher.launchGlm({ rolesRoot, repo, briefPath, model: 'jd-glm53', runnerKind: 'fixture' });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /init/i);
});

test('launch glm 对不支持的 runnerKind 拒绝', () => {
  const rolesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'world-roles-root-'));
  const repo = makeRepo();
  initRoles.run({ root: rolesRoot });
  const briefPath = briefFile(repo, '# t\n');
  const result = launcher.launchGlm({ rolesRoot, repo, briefPath, model: 'jd-glm53', runnerKind: 'evil-rm-rf' });
  assert.strictEqual(result.ok, false);
});

test('CLI：world:roles init + launch 端到端（subprocess）', () => {
  const rolesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'world-roles-cli-'));
  const repo = makeRepo();
  const briefPath = briefFile(repo, '# CLI 端到端 fixture\n');

  const cliPath = path.resolve(__dirname, '..', 'world', 'roles', 'cli.js');
  const env = { ...process.env, WORLD_ROLES_DIR: rolesRoot, NODE_NO_WARNINGS: '1' };

  const r1 = spawnSync(process.execPath, [cliPath, 'init'], { env, encoding: 'utf8' });
  assert.strictEqual(r1.status, 0, `init 失败\nstdout=${r1.stdout}\nstderr=${r1.stderr}`);

  const r2 = spawnSync(
    process.execPath,
    [cliPath, 'launch', 'glm', '--task', briefPath, '--repo', repo],
    { env, encoding: 'utf8' },
  );
  assert.strictEqual(r2.status, 0, `launch 失败\nstdout=${r2.stdout}\nstderr=${r2.stderr}`);
  // CLI 必须把 receipt 路径打到 stdout，方便其他工具解析
  const m = /receipt:\s*(\S+)/.exec(r2.stdout);
  assert.ok(m, `stdout 未包含 receipt 路径\n${r2.stdout}`);
  const receipt = JSON.parse(fs.readFileSync(m[1], 'utf8'));
  assert.strictEqual(receipt.role, 'glm');
});
