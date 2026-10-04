// world/tidy/apply.js · 执行归档计划 + 撤销日志（整个模块都是"可回滚"设计）。
'use strict';

const fs = require('fs');
const path = require('path');

function moveFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code === 'EXDEV') {
      // 跨卷（极少见：归档根目录挂到别的卷）退化为复制+删除
      fs.copyFileSync(from, to);
      fs.unlinkSync(from);
    } else {
      throw err;
    }
  }
}

/**
 * 执行 plan。逐个移动，单个失败不中断整批；写撤销日志。
 * @returns {{moved:number, failed:Array<{from:string,error:string}>, undoFile:string|null}}
 */
function applyPlan(plan, { undoDir } = {}) {
  const failed = [];
  const done = [];
  for (const m of plan.moves) {
    try {
      if (!fs.existsSync(m.from)) throw new Error('源文件已不在原位');
      moveFile(m.from, m.to);
      done.push(m);
    } catch (err) {
      failed.push({ from: m.from, error: err.message });
    }
  }

  let undoFile = null;
  if (done.length && undoDir) {
    fs.mkdirSync(undoDir, { recursive: true });
    undoFile = path.join(undoDir, `tidy-undo-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(
      undoFile,
      JSON.stringify({ ts: new Date().toISOString(), rootDir: plan.rootDir, moves: done.map(({ from, to }) => ({ from, to })) }, null, 2)
    );
  }
  return { moved: done.length, failed, undoFile };
}

function latestUndoFile(undoDir) {
  try {
    const files = fs
      .readdirSync(undoDir)
      .filter((f) => /^tidy-undo-.*\.json$/.test(f))
      .sort();
    return files.length ? path.join(undoDir, files[files.length - 1]) : null;
  } catch {
    return null;
  }
}

/**
 * 撤销：按逆序把文件移回原位；目标位置已被占用就跳过并报告。
 * @returns {{restored:number, skipped:Array<{to:string, reason:string}>}}
 */
function undo(undoFile) {
  const log = JSON.parse(fs.readFileSync(undoFile, 'utf8'));
  const skipped = [];
  let restored = 0;
  for (const m of [...log.moves].reverse()) {
    if (!fs.existsSync(m.to)) {
      skipped.push({ to: m.to, reason: '归档后的文件不在了（可能已被手动移动）' });
      continue;
    }
    if (fs.existsSync(m.from)) {
      skipped.push({ to: m.to, reason: '原位置已有同名文件' });
      continue;
    }
    try {
      moveFile(m.to, m.from);
      restored++;
    } catch (err) {
      skipped.push({ to: m.to, reason: err.message });
    }
  }
  return { restored, skipped };
}

module.exports = { applyPlan, undo, latestUndoFile };
