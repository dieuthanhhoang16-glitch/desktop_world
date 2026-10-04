// world/watch/config.js
// desktop-world · 专案追踪配置：把"特定文件夹"登记为要追的项目，带分类（学习/工作/…）。
// 配置存 ~/.desktop-world/watch.json（0600）；纯 Node，无 Electron 依赖。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = path.join(os.homedir(), '.desktop-world');
const WATCH_FILE = process.env.WORLD_WATCH_FILE || path.join(CONFIG_DIR, 'watch.json');

const CATEGORIES = ['学习', '工作', '生活', '开源', '其他'];
const LEARN_HINT = /paper|thesis|study|learn|read|course|coursework|论文|学习|课程|笔记|读书/i;

function normalizePath(p) {
  if (!p) return '';
  let abs = path.resolve(String(p).replace(/^~(?=\/)/, os.homedir()));
  return abs.replace(/\/+$/, '');
}

// 未指定分类时按名字猜（猜不到归"工作"，宁缺毋滥不硬造分类）
function inferCategory(name) {
  return LEARN_HINT.test(name || '') ? '学习' : '工作';
}

function loadWatch() {
  try {
    const raw = JSON.parse(fs.readFileSync(WATCH_FILE, 'utf8'));
    const folders = Array.isArray(raw.folders) ? raw.folders : [];
    return {
      folders: folders
        .filter((f) => f && f.path)
        .map((f) => ({
          name: f.name || path.basename(normalizePath(f.path)),
          path: normalizePath(f.path),
          category: f.category || inferCategory(f.name || f.path),
        })),
    };
  } catch {
    return { folders: [] };
  }
}

function saveWatch(cfg) {
  fs.mkdirSync(path.dirname(WATCH_FILE), { recursive: true });
  fs.writeFileSync(WATCH_FILE, JSON.stringify({ version: 1, folders: cfg.folders }, null, 2), { mode: 0o600 });
}

function addFolder({ path: p, category, name }) {
  const cfg = loadWatch();
  const norm = normalizePath(p);
  if (!norm) throw new Error('缺少文件夹路径');
  if (!fs.existsSync(norm)) throw new Error(`文件夹不存在：${norm}`);
  if (cfg.folders.some((f) => f.path === norm)) throw new Error(`已在追踪列表里：${norm}`);
  cfg.folders.push({ name: name || path.basename(norm), path: norm, category: category || inferCategory(norm) });
  saveWatch(cfg);
  return cfg;
}

function removeFolder(nameOrPath) {
  const cfg = loadWatch();
  const before = cfg.folders.length;
  const norm = normalizePath(nameOrPath);
  cfg.folders = cfg.folders.filter((f) => f.name !== nameOrPath && f.path !== norm);
  if (cfg.folders.length === before) throw new Error(`没找到这个追踪项：${nameOrPath}`);
  saveWatch(cfg);
  return cfg;
}

// 会话 cwd → 命中的追踪项（路径前缀匹配，取最长项）。
// 返回 {folder, category, watchName} 或 null。
function resolveWatch(folders, cwd) {
  if (!cwd) return null;
  const norm = normalizePath(cwd);
  let best = null;
  for (const f of folders) {
    if (norm === f.path || norm.startsWith(f.path + path.sep)) {
      if (!best || f.path.length > best.path.length) best = f;
    }
  }
  return best ? { folder: best, category: best.category, watchName: best.name } : null;
}

module.exports = { WATCH_FILE, CATEGORIES, loadWatch, saveWatch, addFolder, removeFolder, resolveWatch, inferCategory, normalizePath };
