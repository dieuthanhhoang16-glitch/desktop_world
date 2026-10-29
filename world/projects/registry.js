// world/projects/registry.js
// desktop-world · 项目 registry（~/.desktop-world/projects.json，0600）。
//
// 只纳管用户显式添加的项目。首次 seed 只扫 ~/Documents 的直属子目录且必须有 .git，
// 逐个确认；~/Downloads 永远不在自动导入范围。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { checkMarkers } = require('./markers');
const { registryFile: resolveRegistryFile } = require('./paths');

const VERSION = 1;

function emptyRegistry() {
  return { schemaVersion: VERSION, projects: [] };
}

function load(file) {
  const target = resolveRegistryFile(file);
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return emptyRegistry();
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return emptyRegistry();
  const projects = Array.isArray(obj.projects)
    ? obj.projects.filter((p) => p && typeof p.path === 'string' && path.isAbsolute(p.path))
    : [];
  return { schemaVersion: VERSION, projects };
}

function save(file, registry) {
  const target = resolveRegistryFile(file);
  const projects = (registry && Array.isArray(registry.projects) ? registry.projects : [])
    .slice()
    .sort((a, b) => String(a.path).localeCompare(String(b.path)));
  const out = { schemaVersion: VERSION, projects };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(out, null, 2), { mode: 0o600 });
  return out;
}

function normalizePath(p) {
  const abs = path.resolve(String(p || ''));
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

function isGitRepo(dir) {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

/**
 * 只读检查并更新 registry 里的缓存字段（不写项目文件）。
 * @returns {object|null} 更新后的项目记录；路径不存在时 null。
 */
function checkProject(file, projectPath, { now = () => new Date() } = {}) {
  const abs = normalizePath(projectPath);
  if (!fs.existsSync(abs)) return null;
  const result = checkMarkers(abs);
  const registry = load(file);
  const idx = registry.projects.findIndex((p) => p.path === abs);
  const record = {
    path: abs,
    name: path.basename(abs),
    addedAt: idx >= 0 ? registry.projects[idx].addedAt : now().toISOString(),
    lastCheckedAt: now().toISOString(),
    status: result.status,
    markers: result.markers,
    missing: result.missing,
  };
  if (idx >= 0) registry.projects[idx] = { ...registry.projects[idx], ...record };
  else registry.projects.push(record);
  save(file, registry);
  return record;
}

/**
 * 显式添加。重复添加幂等；路径非法直接抛错。
 */
function addProject(file, projectPath, { now = () => new Date(), name } = {}) {
  const abs = normalizePath(projectPath);
  if (!fs.existsSync(abs)) throw new Error(`项目不存在：${abs}`);
  if (!fs.statSync(abs).isDirectory()) throw new Error(`不是目录：${abs}`);
  const registry = load(file);
  const idx = registry.projects.findIndex((p) => p.path === abs);
  const check = checkMarkers(abs);
  const record = {
    path: abs,
    name: String(name || path.basename(abs)),
    addedAt: idx >= 0 ? registry.projects[idx].addedAt : now().toISOString(),
    lastCheckedAt: now().toISOString(),
    status: check.status,
    markers: check.markers,
    missing: check.missing,
    git: isGitRepo(abs),
  };
  if (idx >= 0) registry.projects[idx] = { ...registry.projects[idx], ...record };
  else registry.projects.push(record);
  save(file, registry);
  return { project: record, added: idx < 0 };
}

function removeProject(file, projectPath) {
  const abs = normalizePath(projectPath);
  const registry = load(file);
  const before = registry.projects.length;
  registry.projects = registry.projects.filter((p) => p.path !== abs);
  save(file, registry);
  return { removed: before !== registry.projects.length, path: abs };
}

function listProjects(file, { refresh = false, now } = {}) {
  const registry = load(file);
  if (!refresh) return registry.projects;
  return registry.projects.map((p) => {
    if (!fs.existsSync(p.path)) return { ...p, status: 'missing', missing: ['project-path'] };
    const result = checkMarkers(p.path);
    return {
      ...p,
      lastCheckedAt: (now ? now() : new Date()).toISOString(),
      status: result.status,
      markers: result.markers,
      missing: result.missing,
    };
  });
}

/**
 * 首次初始化候选：~/Documents 的直属子目录，必须有 .git（文件或目录）。
 * 不递归、不扫 ~/Downloads、不扫隐藏目录。
 */
function seedCandidates({ documentsDir = path.join(os.homedir(), 'Documents') } = {}) {
  let entries = [];
  try {
    entries = fs.readdirSync(documentsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => path.join(documentsDir, e.name))
    .filter((p) => isGitRepo(p))
    .map((p) => ({ path: p, name: path.basename(p) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

module.exports = {
  VERSION,
  emptyRegistry,
  load,
  save,
  normalizePath,
  isGitRepo,
  checkProject,
  addProject,
  removeProject,
  listProjects,
  seedCandidates,
};
