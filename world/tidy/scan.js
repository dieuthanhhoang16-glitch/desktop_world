// world/tidy/scan.js · 扫描 Desktop 顶层散文件（只读）。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_DESKTOP = path.join(os.homedir(), 'Desktop');

// 永不触碰的文件（macOS 系统件 + 我们自己的归档目录由"只扫文件不扫目录"天然规避）
const SKIP_NAMES = new Set(['.DS_Store', '.localized', 'Icon\r', 'Icon\n']);

/**
 * @param {object} [opts]
 * @param {string} [opts.dir]          扫描目录（默认 ~/Desktop）
 * @param {number} [opts.minAgeMin=0]  跳过最近 N 分钟内改动的文件（防止动到正在用的）
 * @returns {Array<{name:string, abs:string, ext:string, sizeKb:number, mtimeMs:number}>}
 */
function scanDesktop({ dir = DEFAULT_DESKTOP, minAgeMin = 0 } = {}) {
  const cutoff = minAgeMin > 0 ? Date.now() - minAgeMin * 60000 : 0;
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue; // v0.3 只收"散文件"，文件夹保持原地（见 README 取舍）
    if (entry.name.startsWith('.') || SKIP_NAMES.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (cutoff && st.mtimeMs > cutoff) continue;
    files.push({
      name: entry.name,
      abs,
      ext: path.extname(entry.name).slice(1).toLowerCase(),
      sizeKb: Math.max(1, Math.round(st.size / 1024)),
      mtimeMs: st.mtimeMs,
    });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

module.exports = { scanDesktop, DEFAULT_DESKTOP };
