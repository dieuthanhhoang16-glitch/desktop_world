// world/roles/launcher.js · `world:roles launch glm --task <brief>` 的实现。
//
// 启动一次"干净 glm"要做六件事，顺序敏感：
//   1) 校验 rolesRoot 下 contract.md / cards/glm.md 存在（否则拒绝并提示 init）
//   2) 拼装 system prompt 并落盘到 <runDir>/config-dir/
//   3) 在 repo 上 `git worktree add` 一个独立 worktree（分支名 role-run/<runId>）
//   4) mk <runDir>/session/ 作为 glm 的独立会话目录
//   5) spawn runner（fixture 或真 glm），把所有上下文用 env 注入
//   6) 收集 worktree 的 git status + runner 退出，写 receipt.json
//
// 本模块不做的事：
//   · 不决定模型——model 由 CLI/brief 传入，launcher 只记录到 manifest 和 receipt
//   · 不做权限仲裁——那是 ticket 02 的事；本 ticket 的 fixture runner 也不联网
//   · 不清理临时产物——runs/<runId>/ 保留，回执指向它，方便事后审计
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const paths = require('./paths');
const prompt = require('./prompt');

// 权限由启动器强制（spec §2）。环境变量不整包继承——只白名单传递运行 node
// 与 POSIX 工具链所必需的几个，再叠加 WORLD_* 运行时变量。JEV_API、各类
// model key、shell 凭据、session 残留都进不到 runner 进程里。
const ENV_WHITELIST = Object.freeze([
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
]);

function curatedEnv(extra) {
  const base = {};
  for (const k of ENV_WHITELIST) {
    if (process.env[k] !== undefined) base[k] = process.env[k];
  }
  return { ...base, ...extra };
}

const RUNNERS = Object.freeze({
  // 注册表形式：launchGlm 只接受表里的 runnerKind，外部传 runner 可执行文件
  // 是后续门票的事；现在严格白名单，避免有人传 "evil" 就把任意脚本拉起来。
  fixture: path.join(__dirname, 'runners', 'glm-fixture.js'),
});

function fail(message, extra = {}) {
  return { ok: false, error: message, ...extra };
}

function sh(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', ...opts });
  if (r.error) throw r.error;
  return r;
}

/**
 * 启动一次 glm 任务。
 *
 * @param {object} opts
 * @param {string} opts.rolesRoot   运行根目录（含 contract.md / cards/glm.md），必填
 * @param {string} opts.repo        在哪个 git 仓开 worktree，必填
 * @param {string} opts.briefPath   任务简报 markdown 的绝对路径，必填
 * @param {string} [opts.model]     模型标识，默认 jd-glm53（只记录，不审判）
 * @param {string} [opts.runnerKind] 默认 'fixture'，必须在 RUNNERS 注册表里
 * @param {number} [opts.runnerTimeoutMs] runner 子进程超时，默认 60_000
 *
 * @returns {object} ok=true 时含 runId/runDir/receiptPath；ok=false 时 error 字段说明原因
 */
function launchGlm(opts) {
  const {
    rolesRoot,
    repo,
    briefPath,
    model = 'jd-glm53',
    runnerKind = 'fixture',
    runnerTimeoutMs = 60_000,
  } = opts || {};

  // ---------- 入参校验（尽早失败、信息可读）
  if (!rolesRoot || !fs.statSync(rolesRoot, { throwIfNoEntry: false })?.isDirectory()) {
    return fail(`rolesRoot 不存在或不是目录：${rolesRoot}`);
  }
  if (!repo || !fs.statSync(repo, { throwIfNoEntry: false })?.isDirectory()) {
    return fail(`repo 不存在或不是目录：${repo}`);
  }
  if (!briefPath || !fs.statSync(briefPath, { throwIfNoEntry: false })?.isFile()) {
    return fail(`briefPath 不存在或不是文件：${briefPath}`);
  }
  const runnerPath = RUNNERS[runnerKind];
  if (!runnerPath) {
    return fail(`未知 runnerKind="${runnerKind}"；已注册：${Object.keys(RUNNERS).join(', ')}`);
  }

  // ---------- ① 契约与角色卡必须就位
  const contractPath = paths.contractFile(rolesRoot);
  const cardPath = paths.cardFile('glm', rolesRoot);
  for (const p of [contractPath, cardPath]) {
    if (!fs.existsSync(p)) {
      return fail(`缺少 ${path.relative(rolesRoot, p)}；先运行 world:roles init`);
    }
  }
  const contract = fs.readFileSync(contractPath, 'utf8');
  const card = fs.readFileSync(cardPath, 'utf8');
  const brief = fs.readFileSync(briefPath, 'utf8');

  // ---------- ② 准备 runDir 与 config-dir
  const runId = paths.newRunId('glm');
  const runDir = paths.runDir(runId, rolesRoot);
  const configDir = path.join(runDir, 'config-dir');
  const sessionDir = path.join(runDir, 'session');
  const worktreeDir = path.join(runDir, 'worktree');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });

  const { content, hash } = prompt.assemble({ contract, card, brief, role: 'glm' });
  const manifest = prompt.manifest({
    contract,
    card,
    brief,
    role: 'glm',
    model,
    assembledAt: new Date().toISOString(),
    hash, // 避免内部再次 assemble
  });
  fs.writeFileSync(path.join(configDir, 'system-prompt.md'), content, 'utf8');
  fs.writeFileSync(path.join(configDir, 'prompt.manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  // 留存 brief 副本（receipt 审计用），与 config-dir 同级，不放进 config-dir
  fs.copyFileSync(briefPath, path.join(runDir, 'brief.md'));

  // ---------- ③ 在 repo 上开 worktree
  // 用 repo 的当前 HEAD 作为 base；分支名含 runId，便于人与其他工具反查。
  const branch = `role-run/${runId}`;
  const head = sh('git', ['-C', repo, 'rev-parse', 'HEAD']);
  if (head.status !== 0) {
    return fail(`git rev-parse HEAD 失败（repo 可能尚未提交）：${head.stderr.trim()}`, { runId, runDir });
  }
  const base = head.stdout.trim();
  const add = sh('git', ['-C', repo, 'worktree', 'add', '-b', branch, worktreeDir, base]);
  if (add.status !== 0) {
    return fail(`git worktree add 失败：${add.stderr.trim()}`, { runId, runDir });
  }

  // ---------- ④ spawn runner（白名单 env；不整包继承 process.env）
  const startedAt = new Date();
  const env = curatedEnv({
    WORLD_ROLE: 'glm',
    WORLD_MODEL: model,
    WORLD_RUN_ID: runId,
    WORLD_CONFIG_DIR: configDir,
    WORLD_WORKTREE: worktreeDir,
    WORLD_SESSION_DIR: sessionDir,
    WORLD_BRIEF_PATH: path.join(runDir, 'brief.md'),
    WORLD_SYSTEM_PROMPT_PATH: path.join(configDir, 'system-prompt.md'),
    WORLD_REPO_ROOT: repo,
  });
  const child = spawnSync(process.execPath, [runnerPath], {
    env,
    encoding: 'utf8',
    timeout: runnerTimeoutMs,
  });
  const finishedAt = new Date();

  // ---------- ⑤ 收集 worktree 改动
  // 用 git status --porcelain 拿的是相对 worktree 的路径，每行一条；
  // 不取 -z —— 文件名换行的边界场景跟我们无关，-z 还要处理 NUL 分隔，平添坑。
  const status = sh('git', ['-C', worktreeDir, 'status', '--porcelain']).stdout;
  const changedFiles = status
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.length > 3)
    .map((entry) => entry.slice(3)); // "?? file" / " M file" → "file"

  const receipt = {
    schemaVersion: 1,
    runId,
    role: 'glm',
    model,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    worktree: { path: worktreeDir, branch, base },
    configDir,
    sessionDir,
    briefPath: path.join(runDir, 'brief.md'),
    systemPromptSha256: hash,
    changedFiles,
    runner: {
      kind: runnerKind,
      // status 为 null 意味着子进程没有走正常 exit：信号 / 超时 / spawn 失败。
      // 一律记 -1 并把 signal / errorMessage 分别带上，绝不能静默当成功。
      exitCode: child.status === null ? -1 : child.status,
      signal: child.signal || null,
      errorMessage: child.error ? String(child.error.message || child.error) : null,
      stdout: (child.stdout || '').slice(-2000),
      stderr: (child.stderr || '').slice(-2000),
    },
  };
  const receiptPath = path.join(runDir, 'receipt.json');
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

  if (receipt.runner.exitCode !== 0) {
    return fail(`runner 退出码 ${receipt.runner.exitCode}（详见 receipt）`, {
      runId,
      runDir,
      receiptPath,
    });
  }
  return { ok: true, runId, runDir, receiptPath };
}

module.exports = { launchGlm, RUNNERS, curatedEnv, ENV_WHITELIST };
