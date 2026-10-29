// world/projects/ensure.js
// desktop-world · 非覆盖式 ensure：缺口报告 → 干净会话跑 setup skill → 复核 → manifest。
//
// 不变量：
//   1) 只创建缺失文件；任何已存在文件被改动都会被还原并判失败。
//   2) setup skill 不可用时不写任何项目文件，只报告缺口。
//   3) 已 initialized 的项目再次 ensure 不 spawn、不写盘（manifest 缺失时除外）。
//   4) 每次实际尝试都留回执（~/.desktop-world/ensure/<slug>/<runId>.json）。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { checkMarkers, EXPECTED } = require('./markers');
const { projectSlug, ENSURE_ROOT } = require('./paths');
const { readManifest, writeManifest, buildManifest } = require('./manifest');
const { runSetupSkill } = require('./setup-runner');

const ROOT_FILES = ['AGENTS.md', 'CLAUDE.md', 'GLOSSARY.md'];

function exists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function walkFiles(root, rel = '', out = [], depth = 0) {
  if (depth > 3) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const childRel = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      walkFiles(root, childRel, out, depth + 1);
    } else if (e.isFile()) {
      out.push(childRel.split(path.sep).join('/'));
    }
  }
  return out;
}

/** 收集会被 setup 触碰的文件：根目录三件套 + docs/agents 全量。 */
function watchedFiles(projectPath) {
  const root = path.resolve(projectPath);
  const files = ROOT_FILES.filter((rel) => exists(path.join(root, rel)));
  for (const rel of walkFiles(root, 'docs/agents')) files.push(rel);
  return [...new Set(files)].sort();
}

function snapshot(projectPath) {
  const root = path.resolve(projectPath);
  const map = new Map();
  for (const rel of watchedFiles(root)) {
    try {
      map.set(rel, fs.readFileSync(path.join(root, rel)));
    } catch {
      // 读不到就不纳入快照；它也不会被还原
    }
  }
  return map;
}

// AGENTS.md/CLAUDE.md 允许"只追加"（补 ## Agent skills 块），但原字节必须完整保留。
const APPENDABLE = new Set(['AGENTS.md', 'CLAUDE.md']);

function restoreModified(projectPath, before, afterSet) {
  const root = path.resolve(projectPath);
  const restored = [];
  for (const [rel, content] of before) {
    const abs = path.join(root, rel);
    let current = null;
    try {
      current = fs.readFileSync(abs);
    } catch {
      current = null;
    }
    const unchanged = current !== null && current.equals(content);
    const pureAppend =
      current !== null &&
      APPENDABLE.has(rel) &&
      current.length > content.length &&
      current.subarray(0, content.length).equals(content);
    if (unchanged || pureAppend) continue;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    restored.push(rel);
    afterSet.add(rel); // 还原后不算新建
  }
  return restored;
}

function createdFiles(projectPath, beforeSet) {
  const root = path.resolve(projectPath);
  return watchedFiles(root)
    .filter((rel) => !beforeSet.has(rel))
    .sort();
}

function tail(text, n = 4000) {
  const s = String(text || '');
  return s.length > n ? s.slice(-n) : s;
}

function defaultRunId(now) {
  const stamp = now().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${rand}`;
}

function receiptPathFor(projectPath, runId, { ensureRoot = ENSURE_ROOT } = {}) {
  return path.join(path.resolve(ensureRoot), projectSlug(projectPath), `${runId}.json`);
}

function writeReceipt(file, receipt) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  return receipt;
}

/** 缺口报告：纯只读，不建目录、不写 manifest。 */
function gapReport(projectPath) {
  const check = checkMarkers(projectPath);
  return {
    project: path.resolve(String(projectPath || '')),
    status: check.status,
    markers: check.markers,
    missing: check.missing,
    items: check.missing.map((id) => ({ id, expected: EXPECTED[id] })),
    ok: check.status === 'initialized',
  };
}

/**
 * @param {object} opts
 * @param {string} opts.projectPath
 * @param {Function|null} [opts.setupRunner] 传 null 表示 skill 不可用；undefined 用默认干净会话
 */
async function ensure(opts = {}) {
  const projectPath = path.resolve(String(opts.projectPath || ''));
  const now = opts.now || (() => new Date());
  const ensureRoot = opts.ensureRoot || ENSURE_ROOT;
  const standardVersion = opts.standardVersion;
  const startedAt = now().toISOString();
  const runId = opts.runId || defaultRunId(now);

  if (!exists(projectPath) || !fs.statSync(projectPath).isDirectory()) {
    return { ok: false, reason: 'project-not-found', project: projectPath, gaps: null };
  }

  const before = checkMarkers(projectPath);
  const gaps = gapReport(projectPath);
  const previous = readManifest(projectPath);

  // 已完成：不 spawn。manifest 缺失时补记一次（这是 ensure 的合法写入）。
  if (before.status === 'initialized') {
    if (!previous) {
      const manifest = buildManifest({ projectPath, check: before, now, standardVersion, touchEnsure: false });
      writeManifest(projectPath, manifest);
      return { ok: true, noop: true, status: 'initialized', gaps, manifest, manifestWritten: true };
    }
    return { ok: true, noop: true, status: 'initialized', gaps, manifest: previous, manifestWritten: false };
  }

  if (opts.dryRun === true) {
    return { ok: true, dryRun: true, planned: true, status: before.status, gaps, before };
  }

  const runner = opts.setupRunner === undefined ? runSetupSkill : opts.setupRunner;
  if (typeof runner !== 'function') {
    const receipt = writeReceipt(receiptPathFor(projectPath, runId, { ensureRoot }), {
      runId,
      role: 'setup',
      project: projectPath,
      startedAt,
      finishedAt: now().toISOString(),
      status: 'unavailable',
      ok: false,
      reason: 'setup-skill-unavailable',
      gapsBefore: gaps.missing,
    });
    return { ok: false, reason: 'setup-skill-unavailable', status: before.status, gaps, receipt, receiptPath: receipt.runId };
  }

  const beforeFiles = snapshot(projectPath);
  const beforeSet = new Set(beforeFiles.keys());
  let result;
  try {
    result = await runner({ projectPath, runId, prompt: undefined });
  } catch (err) {
    result = { status: 1, stdout: '', stderr: String((err && err.message) || err), error: { code: 'RUNNER_THREW' } };
  }

  const unavailable = Boolean(
    result && (result.reason === 'setup-skill-unavailable' || (result.error && result.error.code === 'ENOENT'))
  );
  const afterFiles = new Set(watchedFiles(projectPath));
  const after = checkMarkers(projectPath);
  let restored = [];
  let created = [];
  if (!unavailable) {
    restored = restoreModified(projectPath, beforeFiles, afterFiles);
    created = createdFiles(projectPath, beforeSet);
  }

  const baseReceipt = {
    runId,
    role: 'setup',
    project: projectPath,
    startedAt,
    finishedAt: now().toISOString(),
    runner: {
      status: result && typeof result.status === 'number' ? result.status : null,
      stdout: tail(result && result.stdout),
      stderr: tail(result && result.stderr),
    },
    gapsBefore: gaps.missing,
    created,
    restored,
  };

  if (unavailable) {
    const receipt = writeReceipt(receiptPathFor(projectPath, runId, { ensureRoot }), {
      ...baseReceipt,
      status: 'unavailable',
      ok: false,
      reason: 'setup-skill-unavailable',
      gapsAfter: gaps.missing,
    });
    return { ok: false, reason: 'setup-skill-unavailable', status: before.status, gaps, receipt };
  }

  if (restored.length > 0) {
    const afterRestore = checkMarkers(projectPath);
    const receipt = writeReceipt(receiptPathFor(projectPath, runId, { ensureRoot }), {
      ...baseReceipt,
      status: 'failed',
      ok: false,
      reason: 'existing-file-modified',
      gapsAfter: afterRestore.missing,
    });
    return {
      ok: false,
      reason: 'existing-file-modified',
      status: afterRestore.status,
      gaps: gapReport(projectPath),
      restored,
      created: [],
      receipt,
    };
  }

  if (after.status !== 'initialized') {
    const receipt = writeReceipt(receiptPathFor(projectPath, runId, { ensureRoot }), {
      ...baseReceipt,
      status: 'failed',
      ok: false,
      reason: 'still-partial',
      gapsAfter: after.missing,
    });
    return { ok: false, reason: 'still-partial', status: after.status, gaps: gapReport(projectPath), receipt };
  }

  // 只有复核通过才写 manifest：避免把一次失败运行记成 initialized。
  const manifest = buildManifest({
    projectPath,
    check: after,
    now,
    standardVersion,
    previous,
    generatedFiles: created,
  });
  writeManifest(projectPath, manifest);
  const receipt = writeReceipt(receiptPathFor(projectPath, runId, { ensureRoot }), {
    ...baseReceipt,
    status: 'completed',
    ok: true,
    gapsAfter: [],
    manifestPath: path.join('.world', 'project.json'),
  });
  return { ok: true, status: 'initialized', gaps, created, manifest, receipt };
}

/** 极简版本探测：取已安装插件目录里的最高版本；找不到就 unknown。 */
function detectStandardVersion({ cacheRoot = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'claude-plugins-official', 'mattpocock-skills') } = {}) {
  try {
    const versions = fs
      .readdirSync(cacheRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    return versions.length ? versions[versions.length - 1] : 'unknown';
  } catch {
    return 'unknown';
  }
}

module.exports = {
  ensure,
  gapReport,
  detectStandardVersion,
  receiptPathFor,
  watchedFiles,
  readManifest,
};
