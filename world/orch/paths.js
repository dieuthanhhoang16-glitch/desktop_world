// world/orch/paths.js
// desktop-world · 编排层落盘根目录与常量的唯一真相。
//
// 为什么不跟 outDir：outDir 在 App 里是 app.getPath('userData')/world，在 CLI 里是
// 仓库 world/out —— 两处路径不同。工单/黑板/收件箱是**编排状态**（和 live.json、
// techstack.json、study/ 同源），不是某一份日报的派生物，所以统一落在
// ~/.desktop-world/orch/ 下，WORLD_ORCH_DIR 可覆盖（单测与便携场景）。
//
// 本模块只做路径解析与常量，不含任何读写逻辑。
'use strict';

const os = require('os');
const path = require('path');

const CONFIG_DIR = path.join(os.homedir(), '.desktop-world');
const ORCH_DIR = process.env.WORLD_ORCH_DIR || path.join(CONFIG_DIR, 'orch');

const TICKETS_FILE = 'tickets.json';
const BLACKBOARD_FILE = 'blackboard.json';
const MAILBOX_DIR = 'mailbox';

// 工单状态机。顺序即看板列顺序（draft 之后才是真正在跑的）。
const STATUSES = Object.freeze(['draft', 'confirmed', 'dispatched', 'running', 'done', 'failed', 'blocked']);

// 状态 → 看板列。draft/confirmed 是"还没派出去"的人确认阶段，
// dispatched/running 是"已经在目标 agent 手里"，done/failed/blocked 是收敛态。
const STATUS_LABELS = Object.freeze({
  draft: '草案',
  confirmed: '已确认',
  dispatched: '已派发',
  running: '执行中',
  done: '已完成',
  failed: '失败',
  blocked: '阻塞',
});

function ticketsFile(root = ORCH_DIR) {
  return path.join(root, TICKETS_FILE);
}
function blackboardFile(root = ORCH_DIR) {
  return path.join(root, BLACKBOARD_FILE);
}
function mailboxDir(root = ORCH_DIR) {
  return path.join(root, MAILBOX_DIR);
}
/** sessionId 是外部来的（session snapshot / hook payload），必须先消毒再拼路径。 */
function mailboxFile(sessionId, root = ORCH_DIR) {
  return path.join(mailboxDir(root), `${sanitizeSessionId(sessionId)}.json`);
}

// 只允许 ASCII 安全字符。sessionId 里真实存在 ':'（如 "qoder:raw"）与 Windows
// 盘符/反斜杠，这里统一换成 '-'，保证任何平台都能当文件名且不会逃出目录。
function sanitizeSessionId(sessionId) {
  const cleaned = String(sessionId == null ? '' : sessionId)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 120);
  return cleaned || 'unknown';
}

module.exports = {
  ORCH_DIR,
  TICKETS_FILE,
  BLACKBOARD_FILE,
  MAILBOX_DIR,
  STATUSES,
  STATUS_LABELS,
  ticketsFile,
  blackboardFile,
  mailboxDir,
  mailboxFile,
  sanitizeSessionId,
};