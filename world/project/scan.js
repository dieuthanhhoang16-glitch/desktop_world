// world/project/scan.js
// desktop-world · 首启导入的候选扫描（spec §5 + ticket 03）：
// 「Documents 根之下含 .git 的目录」进候选，带四条硬边界——
//   · 有界二层：一级目录为主；一级目录自己不是仓库时才下潜一层，兜住
//     Documents/<分组>/<仓库> 形态；绝不再深——三层及以下一律无缘；
//   · 仓库边界：遇到含 .git 的目录即收为候选并止步（仓库内部的子模块/vendored 仓库不另立项目）；
//   · node_modules 永不扫描、永不纳管；隐藏目录、压缩包/散文件、符号链接同样不进候选；
//   · ~/Downloads 从不作为扫描根被自动传入（CLI 默认根锁死 Documents，见 defaultDocumentsDir）。
// 全程只读 readdir/stat，不写任何东西。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_DEPTH = 2; // 最多看两层：Documents/<项目> 与 Documents/<分组>/<项目>
const NEVER_DESCEND = new Set(['node_modules']); // 依赖目录永不扫描（装的 repo 也不收）

/** 首启导入的默认扫描根：显式从 home 推，方便测试注入夹具 home。 */
function defaultDocumentsDir(homeDir) {
  return path.join(homeDir || os.homedir(), 'Documents');
}

/** .git 是目录（正常仓库）或文件（worktree 指针）都算已初始化仓库。 */
function hasGit(dir) {
  try {
    fs.statSync(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

function levelEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function collect(dir, depth, found) {
  for (const e of levelEntries(dir)) {
    if (!e.isDirectory()) continue; // 压缩包/散文件不是候选；符号链接也不算（不跟链）
    if (e.name.startsWith('.')) continue; // 隐藏目录不进纳管名单
    if (NEVER_DESCEND.has(e.name)) continue; // 依赖目录永不扫描、永不纳管
    const abs = path.join(dir, e.name);
    if (hasGit(abs)) {
      found.push(abs);
      continue; // 仓库边界：收编，不下潜
    }
    if (depth < MAX_DEPTH) collect(abs, depth + 1, found); // 自己不是仓库才往下看一层
  }
}

/** 返回排好序的候选绝对路径。根目录读不到按空处理（不炸首启）。 */
function documents(dir) {
  const found = [];
  collect(dir, 1, found);
  return found.sort();
}

module.exports = { defaultDocumentsDir, documents, hasGit, MAX_DEPTH };
