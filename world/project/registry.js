// world/project/registry.js
// desktop-world · 显式项目注册表（registry.json）的读写与幂等注册（纯 fs 模块，可单测）。
// 注册表只记「哪些项目在纳管名单里」，检查结果在项目自己的 .world/project.json；
// 两层分开，项目目录被整棵搬走时注册表条目可独立判活（见 badge.js 的 gone 标记）。
'use strict';

const fs = require('fs');
const path = require('path');
const { registryFile } = require('./paths');

/** 容错读取：坏文件/不存在都按空表处理（注册表可从 add 重建，不算数据丢失）。 */
function load(root) {
  try {
    const obj = JSON.parse(fs.readFileSync(registryFile(root), 'utf8'));
    const projects = Array.isArray(obj && obj.projects) ? obj.projects : [];
    return { schemaVersion: 1, projects: projects.filter((p) => p && typeof p.path === 'string') };
  } catch {
    return { schemaVersion: 1, projects: [] };
  }
}

function save(root, data) {
  const file = registryFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, projects: data.projects }, null, 2), { mode: 0o600 });
  return data;
}

/** 归一化注册键：resolve + 去尾斜杠，./变体与重复斜杠不骗出第二条记录。 */
function keyOf(projectPath) {
  return path.resolve(String(projectPath || ''));
}

/**
 * 注册一个项目目录。幂等：同一路径重复 add 不产生第二条记录，registeredAt 也不改写。
 * 返回 { projects, path, registeredAt, duplicate }。
 */
function add(root, projectPath) {
  const abs = keyOf(projectPath);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new Error(`项目路径不存在：${abs}`);
  }
  if (!stat.isDirectory()) throw new Error(`项目路径不是目录：${abs}`);
  const reg = load(root);
  const existing = reg.projects.find((p) => p.path === abs);
  if (existing) return { projects: reg.projects, path: abs, registeredAt: existing.registeredAt, duplicate: true };
  const entry = { path: abs, registeredAt: new Date().toISOString() };
  reg.projects.push(entry);
  save(root, reg);
  return { projects: reg.projects, path: abs, registeredAt: entry.registeredAt, duplicate: false };
}

module.exports = { load, save, add, keyOf };
