// world/projects/paths.js
// desktop-world · 项目层路径与稳定 slug（纯函数 + 常量）。
'use strict';

const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CONFIG_DIR = path.join(os.homedir(), '.desktop-world');
const REGISTRY_FILE = process.env.WORLD_PROJECTS_FILE || path.join(CONFIG_DIR, 'projects.json');
const ENSURE_ROOT = process.env.WORLD_ENSURE_DIR || path.join(CONFIG_DIR, 'ensure');

/** 项目在配置层的稳定目录名：可读前缀 + 绝对路径哈希，避免同名项目互撞。 */
function projectSlug(projectPath) {
  const abs = path.resolve(String(projectPath || ''));
  const base = path.basename(abs).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'project';
  const hash = crypto.createHash('sha1').update(abs).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

function registryFile(file) {
  return path.resolve(file || REGISTRY_FILE);
}

module.exports = { CONFIG_DIR, REGISTRY_FILE, ENSURE_ROOT, projectSlug, registryFile };
