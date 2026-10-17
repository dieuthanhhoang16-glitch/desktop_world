// world/project/scan.js
// desktop-world · 首启导入的候选扫描（spec §5 + ticket 03）：
// 只收「给定的 Documents 根的直接子目录 + 含 .git」的目录——
//   · 普通目录（无 .git）、隐藏目录、压缩包等文件、嵌套在深处的仓库，一律不进候选；
//   · 不递归（不读子孙内容），密钥与一次性目录自然无缘；
//   · ~/Downloads 从不作为扫描根被自动传入（CLI 默认根锁死 Documents，见 defaultDocumentsDir）。
// 只读 readdir/stat，不写任何东西。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

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

/** 返回排好序的候选绝对路径。根目录读不到按空处理（不炸首启）。 */
function documents(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue; // 压缩包/散文件不是候选；符号链接也不算（不跟链）
    if (e.name.startsWith('.')) continue; // 隐藏目录不进纳管名单
    const abs = path.join(dir, e.name);
    if (hasGit(abs)) found.push(abs);
  }
  return found.sort();
}

module.exports = { defaultDocumentsDir, documents, hasGit };
