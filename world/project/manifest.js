// world/project/manifest.js
// desktop-world · 项目 manifest（<项目>/.world/project.json）的读写与契约（spec §5）。
// manifest 是"这个项目纳管到哪一步"的账本：标准、版本、标记、检查/ensure 时间。
// ensure（04 号 ticket）往 generatedFiles/lastEnsureAt 写，本模块负责合并时不冲掉它们。
'use strict';

const fs = require('fs');
const path = require('path');
const { MANIFEST_REL, STANDARD, STANDARD_VERSION, manifestFile } = require('./paths');

/** 全新 manifest 骨架（契约字段一次给齐，后面只改值不加键）。 */
function template(projectDir) {
  return {
    schemaVersion: 1,
    standard: STANDARD,
    standardVersion: STANDARD_VERSION,
    project: path.resolve(String(projectDir || '')),
    registeredAt: null,
    lastCheckedAt: null,
    status: 'missing',
    markers: {
      issueTracker: false,
      domainDocs: false,
      triageLabels: false,
      agentSkillsBlock: false,
      glossary: false,
      adrDir: false,
    },
    generatedFiles: [],
    lastEnsureAt: null,
  };
}

/** 读不到/坏文件 → null（调用方决定是重建还是报错；检查流会重建）。 */
function load(projectDir) {
  try {
    const obj = JSON.parse(fs.readFileSync(manifestFile(projectDir), 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

function save(projectDir, manifest) {
  const file = manifestFile(projectDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return manifest;
}

/**
 * 在既有 manifest 上合并补丁：契约字段用默认值补齐，已有值（generatedFiles、
 * lastEnsureAt 等）一律保留——只有显式出现在 patch 里的键才被改。
 */
function update(projectDir, patch) {
  const merged = { ...template(projectDir), ...(load(projectDir) || {}), ...(patch || {}) };
  merged.markers = { ...template(projectDir).markers, ...((load(projectDir) || {}).markers || {}), ...((patch || {}).markers || {}) };
  return save(projectDir, merged);
}

module.exports = { MANIFEST_REL, template, load, save, update };
