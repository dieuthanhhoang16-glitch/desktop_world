// world/roles/launcher.js
// desktop-world · 干净角色启动器：空 config dir + 独立 worktree + 独立会话 + 权限围栏。
//
// 这里只做"启动前的隔离与围栏"，不接管 agent 的工具审批。权限由三件事共同强制：
//   ① cwd 只能是 worktree（glm）或项目（ds/jev 只读）
//   ② config/session 目录每次 run 新建，不继承用户级 skills/plugins/memory
//   ③ 环境变量白名单 + 禁网代理黑洞 + permissions.json 落盘
// 这不是内核级沙箱；它保证"默认路径"是隔离的，越界仍需人为批准，回执里可审计。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');

const { ROLES, PERMISSION_MATRIX, CONTRACT, roleCard } = require('./defaults');
const { composePrompt, sha256 } = require('./prompt');

const DEFAULT_ROOT = path.join(os.homedir(), '.desktop-world', 'roles');
const MANIFEST = 'manifest.json';
const SKIP_COPY = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.venv', '__pycache__', '.trash']);

function rolesRoot(root) {
  return path.resolve(root || process.env.WORLD_ROLES_DIR || DEFAULT_ROOT);
}

function mkdirPrivate(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* Windows 不支持 0700，忽略 */
  }
}

function atomicWrite(file, body) {
  mkdirPrivate(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function sanitizeId(id) {
  const cleaned = String(id == null ? '' : id)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 100);
  return cleaned || 'run';
}

// ---------------------------------------------------------------- 初始化 / 漂移

/**
 * 建契约与三张角色卡。幂等：已存在的文件不覆盖，manifest 只缺时补。
 * @returns {{root:string, created:string[], existed:string[], manifest:string}}
 */
function initRoles({ root } = {}) {
  const r = rolesRoot(root);
  mkdirPrivate(r);
  const items = [
    { rel: 'contract.md', body: CONTRACT },
    ...Object.keys(ROLES).map((id) => ({ rel: path.join('cards', `${id}.md`), body: roleCard(id) })),
  ];
  const created = [];
  const existed = [];
  for (const item of items) {
    const file = path.join(r, item.rel);
    if (fs.existsSync(file)) {
      existed.push(item.rel);
      continue;
    }
    atomicWrite(file, item.body.endsWith('\n') ? item.body : `${item.body}\n`);
    created.push(item.rel);
  }
  const manifestFile = path.join(r, MANIFEST);
  if (!fs.existsSync(manifestFile)) {
    const manifest = buildManifest(r);
    atomicWrite(manifestFile, JSON.stringify(manifest, null, 2));
  }
  return { root: r, created, existed, manifest: manifestFile };
}

function buildManifest(root) {
  const cards = {};
  for (const id of Object.keys(ROLES)) {
    cards[id] = sha256(readSafe(path.join(root, 'cards', `${id}.md`)));
  }
  return {
    schemaVersion: 1,
    contractHash: sha256(readSafe(path.join(root, 'contract.md'))),
    cards,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * 漂移检查：manifest 与当前文件哈希不一致、文件缺失、多出未知角色卡。
 * @returns {{ok:boolean, root:string, drift:Array<{kind:string, file:string}>, manifest:object|null}}
 */
function checkRoles({ root } = {}) {
  const r = rolesRoot(root);
  const drift = [];
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(r, MANIFEST), 'utf8'));
  } catch {
    drift.push({ kind: 'manifest-missing', file: MANIFEST });
  }
  const contractFile = path.join(r, 'contract.md');
  if (!fs.existsSync(contractFile)) {
    drift.push({ kind: 'missing', file: 'contract.md' });
  } else if (manifest && manifest.contractHash !== sha256(readSafe(contractFile))) {
    drift.push({ kind: 'hash-mismatch', file: 'contract.md' });
  }
  for (const id of Object.keys(ROLES)) {
    const rel = path.join('cards', `${id}.md`);
    const file = path.join(r, rel);
    if (!fs.existsSync(file)) {
      drift.push({ kind: 'missing', file: rel });
      continue;
    }
    if (manifest && manifest.cards && manifest.cards[id] !== sha256(readSafe(file))) {
      drift.push({ kind: 'hash-mismatch', file: rel });
    }
  }
  try {
    for (const name of fs.readdirSync(path.join(r, 'cards'))) {
      const id = name.replace(/\.md$/, '');
      if (name.endsWith('.md') && !ROLES[id]) drift.push({ kind: 'unknown-card', file: path.join('cards', name) });
    }
  } catch {
    /* cards 目录不存在时，上面的 missing 已覆盖 */
  }
  return { ok: drift.length === 0, root: r, drift, manifest };
}

// ---------------------------------------------------------------- 权限矩阵

const SECRET_RE = [
  /(^|[\\/])\.env(\.[^\\/]*)?$/i,
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])id_(rsa|ed25519|ecdsa)(\.pub)?$/i,
  /\.(pem|key|p12|pfx)$/i,
  /(^|[\\/])\.config[\\/]agentero[\\/]settings\.json$/i,
  /(^|[\\/])credentials(\.json)?$/i,
];

function isSecretPath(p) {
  const s = String(p || '');
  return SECRET_RE.some((re) => re.test(s));
}

function isInside(child, parent) {
  if (!parent) return false;
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 权限判定（纯函数）。返回 {ok, reason}，调用方据此拒绝或放行。
 * @param {'read'|'write'|'execute'|'external'} action
 * @param {{path?:string, worktreeDir?:string, networkApproved?:boolean}} [ctx]
 */
function assertAllowed(roleId, action, ctx = {}) {
  const role = ROLES[roleId];
  if (!role) return { ok: false, reason: `未知角色：${roleId}` };
  const matrix = PERMISSION_MATRIX[roleId];
  const target = ctx.path ? path.resolve(ctx.path) : '';

  if ((action === 'read' || action === 'write') && target && isSecretPath(target)) {
    return { ok: false, reason: `禁止读取/写入密钥文件：${target}` };
  }

  if (roleId === 'glm') {
    if (action === 'read' || action === 'write') {
      if (!ctx.worktreeDir) return { ok: false, reason: 'glm 的读写必须指定 worktreeDir' };
      if (!target) return { ok: false, reason: 'glm 的读写必须指定具体路径' };
      if (!isInside(target, ctx.worktreeDir)) {
        return { ok: false, reason: `路径越出 glm worktree：${target}` };
      }
      return { ok: true };
    }
    if (action === 'execute') {
      return matrix.execute.includes(ctx.commandKind || 'tests')
        ? { ok: true }
        : { ok: false, reason: `glm 不允许执行：${ctx.commandKind || '(未指定)'}` };
    }
    if (action === 'external') {
      return ctx.networkApproved === true
        ? { ok: true }
        : { ok: false, reason: 'glm 默认禁网；装依赖/外发需用户批准' };
    }
  }

  if (matrix[action] && matrix[action].length) return { ok: true };
  return { ok: false, reason: `${roleId} 没有 ${action} 权限` };
}

function requireAllowed(roleId, action, ctx) {
  const r = assertAllowed(roleId, action, ctx);
  if (!r.ok) throw new Error(r.reason);
  return r;
}

// ---------------------------------------------------------------- git / 目录

function runGit(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
}

function isGitRepo(dir) {
  if (!dir) return false;
  const r = runGit(['rev-parse', '--is-inside-work-tree'], dir);
  return r.status === 0 && String(r.stdout).trim() === 'true';
}

function copyProject(from, to) {
  fs.cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(from, src);
      if (!rel) return true;
      const top = rel.split(path.sep)[0];
      return !SKIP_COPY.has(top);
    },
  });
}

function prepareWorktree({ projectPath, worktreeDir, dryRun }) {
  if (!projectPath) return { path: '', kind: 'none', created: false };
  if (dryRun) {
    return { path: worktreeDir, kind: isGitRepo(projectPath) ? 'git-worktree' : 'copy', created: false, planned: true };
  }
  fs.rmSync(worktreeDir, { recursive: true, force: true });
  mkdirPrivate(path.dirname(worktreeDir));
  if (isGitRepo(projectPath)) {
    runGit(['worktree', 'prune'], projectPath);
    const r = runGit(['worktree', 'add', '--detach', worktreeDir], projectPath);
    if (r.status !== 0) throw new Error(`创建 git worktree 失败：${String(r.stderr || r.stdout).trim()}`);
    return { path: worktreeDir, kind: 'git-worktree', created: true };
  }
  copyProject(projectPath, worktreeDir);
  return { path: worktreeDir, kind: 'copy', created: true };
}

function removeWorktree({ projectPath, worktreeDir }) {
  if (!worktreeDir) return;
  if (projectPath && isGitRepo(projectPath)) {
    runGit(['worktree', 'remove', '--force', worktreeDir], projectPath);
    runGit(['worktree', 'prune'], projectPath);
  }
  fs.rmSync(worktreeDir, { recursive: true, force: true });
}

function changedFiles(worktreeDir) {
  if (!worktreeDir || !isGitRepo(worktreeDir)) return [];
  const r = runGit(['status', '--porcelain'], worktreeDir);
  if (r.status !== 0) return [];
  return String(r.stdout || '')
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------- 环境

const BASE_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SHELL', 'TERM'];
const MODEL_ENV_KEYS = {
  ds: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL'],
  jev: ['JEV_API', 'JEV_API_KEY', 'JEV_BASE_URL', 'JEV_MODEL'],
  glm: ['WORLD_GLM_BASE_URL', 'WORLD_GLM_API_KEY', 'WORLD_GLM_MODEL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL'],
};

function buildEnv(roleId, { configDir, runId, sourceEnv = process.env, network }) {
  const env = {};
  for (const key of BASE_ENV_KEYS) {
    if (sourceEnv[key] != null) env[key] = sourceEnv[key];
  }
  for (const key of MODEL_ENV_KEYS[roleId] || []) {
    if (sourceEnv[key] != null) env[key] = sourceEnv[key];
  }
  env.CLAUDE_CONFIG_DIR = path.join(configDir, 'claude');
  env.CODEX_HOME = path.join(configDir, 'codex');
  env.PI_HOME = path.join(configDir, 'pi');
  env.XDG_CONFIG_HOME = path.join(configDir, 'xdg');
  env.WORLD_ROLE = roleId;
  env.WORLD_RUN_ID = runId;
  env.WORLD_NETWORK = network;
  if (network === 'disabled') {
    // 代理黑洞：绝大多数 HTTP 客户端会直接连接失败。不是内核防火墙，
    // 但足以让"默认禁网"成为默认态；真要联网必须由人显式放行。
    env.HTTP_PROXY = 'http://127.0.0.1:9';
    env.HTTPS_PROXY = 'http://127.0.0.1:9';
    env.ALL_PROXY = 'http://127.0.0.1:9';
    env.NO_PROXY = '';
    env.http_proxy = env.HTTP_PROXY;
    env.https_proxy = env.HTTPS_PROXY;
  }
  return env;
}

// ---------------------------------------------------------------- run

function runDirs(root, runId) {
  const runDir = path.join(root, 'runs', runId);
  return {
    runDir,
    configDir: path.join(runDir, 'config'),
    sessionDir: path.join(runDir, 'sessions'),
    worktreeDir: path.join(runDir, 'worktree'),
    promptFile: path.join(runDir, 'prompt.md'),
    taskFile: path.join(runDir, 'task.md'),
    receiptFile: path.join(runDir, 'receipt.json'),
    permissionsFile: path.join(runDir, 'permissions.json'),
  };
}

function defaultSpawn(command, args, opts) {
  return spawnSync(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    timeout: opts.timeoutMs,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

function defaultSpawnAsync(command, args, opts) {
  return spawn(command, args, { cwd: opts.cwd, env: opts.env });
}

/**
 * 角色参数拼装：role.args 为底，任务级覆盖按序叠加。
 *   - opts.model：若 args 已有 `--model <x>` 就原地换值（不追加第二个 --model）；
 *     没有则补插一对 --model，让任何角色都能被任务级模型覆盖。
 *   - opts.extraArgs：插在 role.args 之后、promptFlag 之前（如 ['--output-format','json']）。
 */
function buildArgs(role, opts) {
  const args = (role.args || []).slice();
  if (opts.model) {
    const idx = args.indexOf('--model');
    if (idx >= 0 && idx + 1 < args.length) args[idx + 1] = String(opts.model);
    else args.push('--model', String(opts.model));
  }
  if (Array.isArray(opts.extraArgs)) {
    for (const a of opts.extraArgs) args.push(String(a));
  }
  return args;
}

/**
 * 启动一次角色任务的准备流程（createRun / createRunAsync 共用，保证两条路径的
 * 隔离与围栏完全一致）：空 config、提示拼装与落盘、worktree、permissions、env、回执 planned。
 * 返回 {receipt, dirs, command, cwd, env, worktree, now, early}：
 * early=true 表示 dryRun 或 judgement-only，回执已是终态，调用方直接返回即可。
 */
function prepareRun(opts) {
  const roleId = String(opts.role || '');
  const role = ROLES[roleId];
  if (!role) throw new Error(`未知角色：${roleId}`);
  const task = String(opts.task || '').trim();
  if (!task) throw new Error('任务简报不能为空');

  const root = rolesRoot(opts.root);
  const now = typeof opts.now === 'function' ? opts.now : () => new Date();
  const startedAt = now().toISOString();
  const runId = sanitizeId(opts.runId || `${roleId}-${startedAt.replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`);
  const dirs = runDirs(root, runId);
  mkdirPrivate(dirs.configDir);
  mkdirPrivate(dirs.sessionDir);
  // 每次 run 都新建空的运行时配置根：Claude/Pi/Codex 各一套，互不继承。
  for (const name of ['claude', 'codex', 'pi', 'xdg']) mkdirPrivate(path.join(dirs.configDir, name));

  const contract = readSafe(path.join(root, 'contract.md')) || CONTRACT;
  const card = readSafe(path.join(root, 'cards', `${roleId}.md`)) || roleCard(roleId);
  const prompt = composePrompt({ contract, card, brief: task });
  atomicWrite(dirs.promptFile, prompt.text);
  atomicWrite(dirs.taskFile, `${task}\n`);

  const projectPath = opts.project ? path.resolve(opts.project) : '';
  if (projectPath && !fs.existsSync(projectPath)) throw new Error(`项目不存在：${projectPath}`);

  // 只有执行角色需要独立 worktree；ds/jev 是只读角色，直接在项目里读，不复制一份。
  // worktreeOverride（仅 glm 有效）：复用既有 worktree，跳过删除重建 —— steer/follow-up
  // 场景靠它保住父 run 的现场，绝不在复用时 rm 一遍别人的工作区。
  const override = opts.worktreeOverride ? path.resolve(String(opts.worktreeOverride)) : '';
  let worktree;
  if (roleId === 'glm' && override) {
    worktree = { path: override, kind: 'reused', created: false };
  } else if (roleId === 'glm') {
    worktree = prepareWorktree({ projectPath, worktreeDir: dirs.worktreeDir, dryRun: opts.dryRun === true });
  } else {
    worktree = { path: '', kind: 'none', created: false };
  }
  const cwd = roleId === 'glm' ? (worktree.path || projectPath) : projectPath;

  const permissions = {
    schemaVersion: 1,
    role: roleId,
    matrix: PERMISSION_MATRIX[roleId],
    network: role.network,
    worktree: worktree.path || null,
    secretFiles: 'deny',
    note: '权限由启动器按 cwd/config/env 围栏；越界动作必须由用户批准并写回执。',
  };
  atomicWrite(dirs.permissionsFile, JSON.stringify(permissions, null, 2));

  const env = buildEnv(roleId, {
    configDir: dirs.configDir,
    runId,
    sourceEnv: opts.sourceEnv || process.env,
    network: role.network,
  });
  env.WORLD_PERMISSIONS_FILE = dirs.permissionsFile;

  const args = buildArgs(role, opts);
  const command = role.command.length ? [role.command[0], ...args, ...(role.promptFlag ? [role.promptFlag, prompt.text] : [])] : [];
  const receipt = {
    schemaVersion: 1,
    runId,
    role: roleId,
    roleTitle: role.title,
    model: opts.model ? String(opts.model) : role.defaultModel,
    project: projectPath,
    task,
    status: 'planned',
    ok: null,
    startedAt,
    finishedAt: null,
    promptHash: prompt.hash,
    promptSections: prompt.sections,
    configDir: dirs.configDir,
    sessionDir: dirs.sessionDir,
    worktree,
    cwd,
    network: role.network,
    command: command.length ? { file: command[0], args: command.slice(1, -1), promptFile: dirs.promptFile } : null,
    changedFiles: [],
    exitCode: null,
    signal: null,
    error: '',
  };
  atomicWrite(dirs.receiptFile, JSON.stringify(receipt, null, 2));

  if (opts.dryRun === true) {
    return { receipt, dirs, command, cwd, env, worktree, now, early: true };
  }

  if (!command.length) {
    receipt.status = 'judgement-only';
    receipt.ok = true;
    receipt.finishedAt = now().toISOString();
    atomicWrite(dirs.receiptFile, JSON.stringify(receipt, null, 2));
    return { receipt, dirs, command, cwd, env, worktree, now, early: true };
  }

  return { receipt, dirs, command, cwd, env, worktree, now, early: false };
}

/**
 * 启动一次角色任务（同步版，CLI/历史路径用）。dryRun 只做规划与落盘，不建 worktree、不 spawn。
 *
 * @param {object} opts
 * @param {'ds'|'jev'|'glm'} opts.role
 * @param {string} [opts.project] 目标项目绝对路径
 * @param {string} opts.task 任务简报
 * @param {string} [opts.runId]
 * @param {string} [opts.root]
 * @param {boolean} [opts.dryRun]
 * @param {Function} [opts.spawn] 注入的执行器（单测）
 * @param {number} [opts.timeoutMs]
 * @param {object} [opts.sourceEnv]
 * @param {string} [opts.model] 覆盖角色 args 里的 --model 值（原地替换，不追加）
 * @param {string[]} [opts.extraArgs] 追加在 role.args 之后、promptFlag 之前
 * @param {string} [opts.worktreeOverride] 复用既有 worktree 绝对路径（仅 glm）
 * @returns {object} receipt
 */
function createRun(opts = {}) {
  const { receipt, dirs, command, cwd, env, worktree, now, early } = prepareRun(opts);
  if (early) return receipt;

  const spawnFn = typeof opts.spawn === 'function' ? opts.spawn : defaultSpawn;
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 10 * 60 * 1000;
  let result;
  try {
    result = spawnFn(command[0], command.slice(1), { cwd, env, timeoutMs });
  } catch (err) {
    result = { error: err, status: null, stdout: '', stderr: '' };
  }

  const stdout = result && result.stdout != null ? String(result.stdout) : '';
  const stderr = result && result.stderr != null ? String(result.stderr) : '';
  if (stdout) atomicWrite(path.join(dirs.runDir, 'stdout.log'), stdout);
  if (stderr) atomicWrite(path.join(dirs.runDir, 'stderr.log'), stderr);

  const exitCode = result && typeof result.status === 'number' ? result.status : null;
  const error = result && result.error ? String(result.error.message || result.error) : '';
  receipt.finishedAt = now().toISOString();
  receipt.exitCode = exitCode;
  receipt.signal = result ? result.signal || null : null;
  receipt.error = error;
  receipt.status = error ? 'failed' : exitCode === 0 ? 'completed' : 'failed';
  receipt.ok = receipt.status === 'completed';
  receipt.changedFiles = changedFiles(worktree.path);
  atomicWrite(dirs.receiptFile, JSON.stringify(receipt, null, 2));
  return receipt;
}

/**
 * 启动一次角色任务（异步版，Electron 主进程/编排台用）：准备流程与 createRun 完全一致，
 * 只把执行换成 child_process.spawn 异步流式收集。
 *
 * @param {object} opts  与 createRun 相同的全部字段；执行器注入键为 opts.spawnImpl：
 *   spawnImpl(command, args, {cwd, env, timeoutMs}) 两种返回都支持（单测必用）：
 *     ① Promise：resolve({status?, stdout?, stderr?, error?, signal?})，形状同 spawnSync 结果；
 *     ② child 句柄：{pid, stdout:EventEmitter, stderr:EventEmitter, kill(signal?),
 *        on('exit', (code, signal)=>…), on('error', (err)=>…)}（Node child_process 契约）。
 *   缺省用真实 child_process.spawn。
 * @param {Function} [onEvent] 回调 onEvent({kind:'start', runId, pid, command, args})
 *   / onEvent({kind:'stdout', runId, stream:'stdout'|'stderr', text})
 *   / onEvent({kind:'done', runId, receipt})。
 * @returns {Promise<object>} receipt（与 createRun 同形状；timeout 时 status=failed、error='timeout'）
 */
function createRunAsync(opts = {}, onEvent) {
  const { receipt, dirs, command, cwd, env, worktree, now, early } = prepareRun(opts);
  if (early) return Promise.resolve(receipt);

  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  const spawnImpl = typeof opts.spawnImpl === 'function' ? opts.spawnImpl : defaultSpawnAsync;
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 10 * 60 * 1000;

  const appendLog = (name, text) => {
    if (!text) return;
    try {
      fs.appendFileSync(path.join(dirs.runDir, name), text, { mode: 0o600 });
    } catch {
      /* 日志落盘失败不丢回执：收集仍在内存里，终态照常写 */
    }
  };

  const finish = ({ exitCode, signal, error, stdout, stderr }) => {
    appendLog('stdout.log', stdout);
    appendLog('stderr.log', stderr);
    receipt.finishedAt = now().toISOString();
    receipt.exitCode = typeof exitCode === 'number' ? exitCode : null;
    receipt.signal = signal || null;
    receipt.error = error || '';
    receipt.status = receipt.error ? 'failed' : receipt.exitCode === 0 ? 'completed' : 'failed';
    receipt.ok = receipt.status === 'completed';
    receipt.changedFiles = changedFiles(worktree.path);
    atomicWrite(dirs.receiptFile, JSON.stringify(receipt, null, 2));
    emit({ kind: 'done', runId: receipt.runId, receipt });
    return receipt;
  };

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command[0], command.slice(1), { cwd, env, timeoutMs });
    } catch (err) {
      resolve(finish({ exitCode: null, signal: null, error: String(err && err.message ? err.message : err) }));
      return;
    }

    // ① Promise 风格假执行器：与 spawnSync 同形状结果，无流式中间态。
    if (child && typeof child.then === 'function') {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(finish({ exitCode: null, signal: null, error: 'timeout' }));
      }, timeoutMs);
      emit({ kind: 'start', runId: receipt.runId, pid: undefined, command: command[0], args: command.slice(1) });
      child.then(
        (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const r = result || {};
          resolve(finish({
            exitCode: typeof r.status === 'number' ? r.status : (typeof r.code === 'number' ? r.code : null),
            signal: r.signal || null,
            error: r.error ? String(r.error.message || r.error) : '',
            stdout: r.stdout != null ? String(r.stdout) : '',
            stderr: r.stderr != null ? String(r.stderr) : '',
          }));
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(finish({ exitCode: null, signal: null, error: String(err && err.message ? err.message : err) }));
        },
      );
      return;
    }

    // ② child 句柄：边到边流式收集，stdout/stderr 逐块追加到日志。
    const pid = child && typeof child.pid === 'number' ? child.pid : undefined;
    receipt.pid = pid;
    receipt.status = 'running';
    atomicWrite(dirs.receiptFile, JSON.stringify(receipt, null, 2));
    emit({ kind: 'start', runId: receipt.runId, pid, command: command[0], args: command.slice(1) });

    let settled = false;
    let timedOut = false;
    let exitError = '';
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child && typeof child.kill === 'function') child.kill('SIGKILL');
      } catch {
        /* 已经死了，下面 exit/error 至少来一个会把账结掉 */
      }
    }, timeoutMs);
    const done = (code, signal, errText) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(finish({
        exitCode: typeof code === 'number' ? code : null,
        signal: signal || null,
        error: timedOut ? 'timeout' : (errText || ''),
      }));
    };
    if (child && child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', (buf) => {
        const text = String(buf);
        appendLog('stdout.log', text);
        emit({ kind: 'stdout', runId: receipt.runId, stream: 'stdout', text });
      });
    }
    if (child && child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (buf) => {
        const text = String(buf);
        appendLog('stderr.log', text);
        emit({ kind: 'stdout', runId: receipt.runId, stream: 'stderr', text });
      });
    }
    if (child && typeof child.on === 'function') {
      child.on('error', (err) => {
        exitError = String(err && err.message ? err.message : err);
        done(null, null, exitError);
      });
      child.on('exit', (code, signal) => done(code, signal, exitError));
      child.on('close', (code, signal) => done(code, signal, exitError));
    } else {
      // 两种契约都不满足的注入物：不装死，显式失败。
      done(null, null, 'spawnImpl 返回值既不是 Promise 也不是 child 句柄');
    }
  });
}

function listRuns({ root } = {}) {
  const r = rolesRoot(root);
  let names = [];
  try {
    names = fs.readdirSync(path.join(r, 'runs'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    try {
      const receipt = JSON.parse(fs.readFileSync(path.join(r, 'runs', name, 'receipt.json'), 'utf8'));
      if (receipt && receipt.runId) out.push(receipt);
    } catch {
      /* 不完整 run 目录跳过，不让列表整体失败 */
    }
  }
  return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

function cleanupRun({ root, runId, projectPath, removeWorktree: remove = true } = {}) {
  const r = rolesRoot(root);
  const dirs = runDirs(r, sanitizeId(runId));
  let receipt = null;
  try {
    receipt = JSON.parse(fs.readFileSync(dirs.receiptFile, 'utf8'));
  } catch {
    receipt = null;
  }
  if (remove) {
    removeWorktree({
      projectPath: projectPath || (receipt && receipt.project),
      worktreeDir: dirs.worktreeDir,
    });
  }
  return { runId, worktreeRemoved: remove, runDir: dirs.runDir };
}

module.exports = {
  DEFAULT_ROOT,
  MANIFEST,
  rolesRoot,
  initRoles,
  buildManifest,
  checkRoles,
  assertAllowed,
  requireAllowed,
  isSecretPath,
  isInside,
  createRun,
  createRunAsync,
  buildArgs,
  runDirs,
  listRuns,
  cleanupRun,
  buildEnv,
  changedFiles,
};
