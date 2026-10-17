// world/roles/paths.js · 角色运行时根目录与常量的唯一真相。
//
// 参照 world/orch/paths.js 的约定：落盘根默认在 ~/.desktop-world/roles/，
// WORLD_ROLES_DIR 可覆盖（单测与便携场景必须能从环境改路径，否则会写脏用户家）。
//
// 本模块只做路径解析与常量，不含任何读写逻辑。
'use strict';

const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CONFIG_DIR = path.join(os.homedir(), '.desktop-world');
const ROLES_DIR = process.env.WORLD_ROLES_DIR || path.join(CONFIG_DIR, 'roles');

const CONTRACT_FILE = 'contract.md';
const CARDS_DIR = 'cards';
const RUNS_DIR = 'runs';

// 角色白名单。launcher 接到不在表里的 role 必须拒绝，否则会去读不存在的角色卡。
const ROLES = Object.freeze(['ds', 'jev', 'glm']);

// 每次 launch 都是一个全新的运行时实例：runId 同时用作
//   · runs/ 下的子目录名
//   · git worktree 分支名的尾巴
// 因此要：① 时间有序方便人按时间翻账，② 带短随机避免同毫秒两次启动撞名。
function newRunId(role, now = new Date()) {
  const ts = now.toISOString().replace(/[-:T.]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
  const rand = crypto.randomBytes(3).toString('hex'); // 6 hex
  return `${role}-${ts}-${rand}`;
}

function contractFile(root = ROLES_DIR) {
  return path.join(root, CONTRACT_FILE);
}
function cardsDir(root = ROLES_DIR) {
  return path.join(root, CARDS_DIR);
}
function cardFile(role, root = ROLES_DIR) {
  return path.join(cardsDir(root), `${role}.md`);
}
function runsDir(root = ROLES_DIR) {
  return path.join(root, RUNS_DIR);
}
function runDir(runId, root = ROLES_DIR) {
  return path.join(runsDir(root), runId);
}

module.exports = {
  ROLES_DIR,
  CONTRACT_FILE,
  CARDS_DIR,
  RUNS_DIR,
  ROLES,
  newRunId,
  contractFile,
  cardsDir,
  cardFile,
  runsDir,
  runDir,
};
