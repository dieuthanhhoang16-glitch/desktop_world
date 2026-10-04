// world/tidy/plan.js · 生成归档计划：归类 + 目标路径 + 重名避让（纯函数）。
'use strict';

const fs = require('fs');
const path = require('path');

function uniqueDest(destDir, name, taken) {
  let candidate = path.join(destDir, name);
  if (!taken.has(candidate.toLowerCase()) && !fs.existsSync(candidate)) {
    taken.add(candidate.toLowerCase());
    return candidate;
  }
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    candidate = path.join(destDir, `${stem}-${i}${ext}`);
    if (!taken.has(candidate.toLowerCase()) && !fs.existsSync(candidate)) {
      taken.add(candidate.toLowerCase());
      return candidate;
    }
  }
  throw new Error(`无法为 ${name} 找到可用目标名`);
}

/**
 * @param {object} opts
 * @param {Array}  opts.files   scanDesktop 的输出
 * @param {Map<string,Array>} opts.groups  classifyByRules 的 groups（可含 LLM 细化后的桶）
 * @param {string} opts.rootDir 归档根目录（例如 ~/Desktop/_归档）
 * @returns {{rootDir:string, moves:Array<{from:string,to:string,category:string,sizeKb:number}>, totalKb:number, byCategory:Object}}
 */
function buildPlan({ files, groups, rootDir }) {
  const taken = new Set(); // 本次计划内部也要互相避让（不依赖磁盘已存在）
  const moves = [];
  for (const [category, list] of groups) {
    const destDir = path.join(rootDir, category);
    for (const f of list) {
      moves.push({
        from: f.abs,
        to: uniqueDest(destDir, f.name, taken),
        category,
        sizeKb: f.sizeKb,
      });
    }
  }
  const byCategory = {};
  let totalKb = 0;
  for (const m of moves) {
    byCategory[m.category] = (byCategory[m.category] || 0) + 1;
    totalKb += m.sizeKb;
  }
  return { rootDir, moves, totalKb, byCategory, fileCount: files.length };
}

module.exports = { buildPlan, uniqueDest };
