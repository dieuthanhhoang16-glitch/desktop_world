// world/projects/manifest.js
// desktop-world · 项目 manifest（<project>/.world/project.json）。
//
// manifest 是"这个项目的标准状态"的唯一落盘凭据：标准版本、标记、生成文件、
// 最后检查/ensure 时间。只有 ensure 成功或用户显式 ensure 刷新时才写——
// 只读检查不创建 .world/，避免把"检查过"伪装成"初始化过"。
'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const STANDARD = 'mattpocock-skills';
const MANIFEST_REL = path.join('.world', 'project.json');

function manifestPath(projectPath) {
  return path.join(path.resolve(String(projectPath || '')), MANIFEST_REL);
}

function readManifest(projectPath) {
  try {
    const obj = JSON.parse(fs.readFileSync(manifestPath(projectPath), 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

function writeManifest(projectPath, manifest) {
  const file = manifestPath(projectPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

function uniq(list) {
  return [...new Set((list || []).filter((x) => typeof x === 'string' && x.length > 0))].sort();
}

/**
 * 生成新 manifest。registeredAt 首次写入时间永久保留；generatedFiles 取并集，
 * 不因为一次增量生成而丢掉历史生成物。
 */
function buildManifest({ projectPath, check, now = () => new Date(), standardVersion, previous = null, generatedFiles = [], touchEnsure = true }) {
  const stamp = now().toISOString();
  const base = previous && typeof previous === 'object' ? previous : {};
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    standard: STANDARD,
    standardVersion: String(standardVersion || base.standardVersion || 'unknown'),
    project: path.resolve(String(projectPath || '')),
    registeredAt: base.registeredAt || stamp,
    lastCheckedAt: stamp,
    status: check.status,
    markers: { ...check.markers },
    generatedFiles: uniq([...(base.generatedFiles || []), ...(generatedFiles || [])]),
  };
  if (touchEnsure) manifest.lastEnsureAt = stamp;
  else if (base.lastEnsureAt) manifest.lastEnsureAt = base.lastEnsureAt;
  return manifest;
}

module.exports = { SCHEMA_VERSION, STANDARD, MANIFEST_REL, manifestPath, readManifest, writeManifest, buildManifest, uniq };
