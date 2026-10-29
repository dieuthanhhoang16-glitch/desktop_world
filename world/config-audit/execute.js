// world/config-audit/execute.js
// desktop-world · 配置清理执行器：先归档、验证、再删除；默认 dry-run。
// decisions.json 是唯一执行依据；审计与执行都不读取 settings/密钥内容。
'use strict';

const fs = require('fs');
const path = require('path');

const { isSecret } = require('../learn/sources');
const { archiveRoot } = require('./paths');

const DAY_MS = 24 * 3600 * 1000;
const RETENTION_DAYS = 30;

function safeInside(root, target, { allowRoot = false } = {}) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  if (!allowRoot && t === r) return false;
  return t.startsWith(r + path.sep);
}

function uniqueDest(dest) {
  if (!fs.existsSync(dest)) return dest;
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `${dest}.${i}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error('归档目标重名，无法生成唯一路径');
}

function linkTarget(line, indexFile) {
  const m = String(line).match(/\[[^\]]*\]\(([^)]+)\)/);
  if (!m) return null;
  const raw = m[1].trim();
  if (!raw || /^(https?:|#|mailto:)/i.test(raw)) return null;
  return path.resolve(path.dirname(indexFile), decodeURIComponent(raw.split('#')[0]));
}

function filterIndexLines(indexFile, predicate) {
  let text = '';
  try {
    text = fs.readFileSync(indexFile, 'utf8');
  } catch {
    return { removed: [], changed: false };
  }
  const lines = text.split(/\r?\n/);
  const removed = [];
  const kept = lines.filter((line) => {
    const target = linkTarget(line, indexFile);
    if (predicate(line, target)) {
      removed.push(line);
      return false;
    }
    return true;
  });
  if (!removed.length) return { removed: [], changed: false };
  fs.writeFileSync(indexFile, kept.join('\n'));
  return { removed, changed: true };
}

function removeMemoryIndexLine(file) {
  const indexFile = path.join(path.dirname(file), 'MEMORY.md');
  if (!fs.existsSync(indexFile)) return { removed: [], changed: false };
  return filterIndexLines(indexFile, (line, target) => target && path.resolve(target) === path.resolve(file));
}

function removeEntryLines(indexFile, entries) {
  const targets = new Set((entries || []).map((e) => String(e.line).trim()));
  return filterIndexLines(indexFile, (line) => targets.has(line.trim()));
}

function restoreEntryLines(indexFile, lines) {
  if (!lines || !lines.length) return { restored: 0 };
  if (!fs.existsSync(indexFile)) return { restored: 0 };
  const text = fs.readFileSync(indexFile, 'utf8');
  const have = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const missing = lines.filter((l) => !have.has(l.trim()));
  if (!missing.length) return { restored: 0 };
  const sep = text.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(indexFile, `${text}${sep}${missing.join('\n')}\n`);
  return { restored: missing.length };
}

function archiveSource(src, dest, kind) {
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  const actual = uniqueDest(dest);
  if (kind === 'directory') {
    fs.cpSync(src, actual, { recursive: true });
    if (!fs.existsSync(actual)) throw new Error('目录归档失败');
    return actual;
  }
  fs.copyFileSync(src, actual);
  const s = fs.statSync(src);
  const d = fs.statSync(actual);
  if (s.size !== d.size) throw new Error('归档校验失败：大小不一致');
  return actual;
}

/**
 * @param {object} opts
 * @param {string} opts.dir 提案目录（receipt.json 写入处）
 * @param {object} opts.decisions
 * @param {boolean} [opts.dryRun=true]
 */
function executeConfig({ dir, decisions, dryRun = true, now = () => new Date(), archiveRootDir } = {}) {
  if (!decisions || decisions.schemaVersion !== 1 || decisions.kind !== 'config' || !Array.isArray(decisions.items)) {
    return { ok: false, reason: 'invalid-decisions', message: '不是配置层清理决策。' };
  }
  const root = path.resolve(decisions.root || decisions.project || '');
  if (!root || !fs.existsSync(root)) return { ok: false, reason: 'config-root-missing', root };
  const archiveBase = path.resolve(archiveRootDir || archiveRoot());
  const at = now();
  const deletes = decisions.items.filter((i) => i.action === 'delete');
  const recoverableUntil = new Date(at.getTime() + RETENTION_DAYS * DAY_MS).toISOString();

  const preview = deletes.map((item) => {
    const src = path.resolve(String(item.path || ''));
    const rel = path.relative(root, src);
    const denied = !safeInside(root, src) || /^settings/i.test(rel) || rel === 'history.jsonl' || isSecret(rel);
    return {
      path: item.path,
      valid: !denied,
      kind: item.kind || 'file',
      action: item.kind === 'index-entries' ? 'archive-index-and-remove-entries' : 'archive-then-delete',
      archiveTo: item.archiveTo || null,
      recoverableUntil,
    };
  });

  if (dryRun) {
    return { ok: true, dryRun: true, root, deleteCount: deletes.length, preview, recoverableUntil, message: `${deletes.length} 个配置项将先归档再删除（dry-run，未修改）。` };
  }
  const invalid = preview.filter((p) => !p.valid);
  if (invalid.length) {
    return { ok: false, reason: 'unsafe-path', paths: invalid.map((p) => p.path), message: '决策中包含配置目录之外的路径，已拒绝执行。' };
  }
  if (!deletes.length) {
    return { ok: true, dryRun: false, noop: true, deleteCount: 0, message: '没有勾选任何配置删除项。' };
  }

  const results = [];
  for (const item of deletes) {
    const src = path.resolve(item.path);
    const rel = path.relative(root, src);
    const baseArchive = item.archiveTo
      ? path.resolve(item.archiveTo)
      : path.join(archiveBase, decisions.proposalId, rel);
    if (!baseArchive.startsWith(archiveBase + path.sep)) {
      results.push({ path: item.path, status: 'failed', error: '归档路径越界' });
      continue;
    }
    if (!fs.existsSync(src)) {
      results.push({ path: item.path, status: 'not-found', kind: item.kind || 'file' });
      continue;
    }
    try {
      if (item.kind === 'index-entries') {
        const actual = archiveSource(src, baseArchive, 'file');
        const removed = removeEntryLines(src, item.entries || []);
        results.push({
          path: item.path,
          kind: 'index-entries',
          status: 'archived-deleted',
          archivePath: actual,
          recoverableUntil,
          removedIndexLines: removed.removed,
        });
        continue;
      }
      const kind = item.kind === 'directory' ? 'directory' : 'file';
      const actual = archiveSource(src, baseArchive, kind);
      if (kind === 'directory') fs.rmSync(src, { recursive: true, force: true });
      else fs.unlinkSync(src);
      const indexEdit = item.removeIndexLine && kind === 'file' ? removeMemoryIndexLine(src) : { removed: [], changed: false };
      results.push({
        path: item.path,
        kind,
        status: 'archived-deleted',
        archivePath: actual,
        recoverableUntil,
        removedIndexLines: indexEdit.removed,
        indexFile: indexEdit.changed ? path.join(path.dirname(src), 'MEMORY.md') : null,
      });
    } catch (error) {
      results.push({ path: item.path, status: 'failed', kind: item.kind || 'file', error: String(error.message || error) });
    }
  }

  const receipt = {
    schemaVersion: 1,
    kind: 'config',
    proposalId: decisions.proposalId,
    root,
    executedAt: at.toISOString(),
    dryRun: false,
    retentionDays: RETENTION_DAYS,
    results,
    counts: {
      archivedDeleted: results.filter((r) => r.status === 'archived-deleted').length,
      failed: results.filter((r) => r.status === 'failed').length,
      notFound: results.filter((r) => r.status === 'not-found').length,
    },
  };
  const receiptPath = path.join(dir, 'receipt.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  return { ok: true, dryRun: false, root, receiptPath, receipt, ...receipt.counts };
}

function readConfigReceipt(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'receipt.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** 30 天内从归档恢复；不重新读取原文内容，只做文件复制与索引行回填。 */
function restoreConfig({ dir, now = () => new Date() } = {}) {
  const receipt = readConfigReceipt(dir);
  if (!receipt || receipt.kind !== 'config') return { ok: false, reason: 'no-receipt', message: '没有配置清理回执。' };
  const at = now();
  const restored = [];
  const skipped = [];
  for (const item of receipt.results || []) {
    if (item.status !== 'archived-deleted') continue;
    if (item.recoverableUntil && new Date(item.recoverableUntil).getTime() < at.getTime()) {
      skipped.push({ path: item.path, reason: 'retention-expired' });
      continue;
    }
    if (!item.archivePath || !fs.existsSync(item.archivePath)) {
      skipped.push({ path: item.path, reason: 'archive-missing' });
      continue;
    }
    try {
      if (item.kind === 'index-entries') {
        if (!fs.existsSync(item.path)) fs.copyFileSync(item.archivePath, item.path);
        const back = restoreEntryLines(item.path, item.removedIndexLines);
        restored.push({ path: item.path, action: 'restore-index-entries', lines: back.restored });
        continue;
      }
      if (fs.existsSync(item.path)) {
        skipped.push({ path: item.path, reason: 'target-exists' });
        continue;
      }
      fs.mkdirSync(path.dirname(item.path), { recursive: true });
      if (item.kind === 'directory') fs.cpSync(item.archivePath, item.path, { recursive: true });
      else fs.copyFileSync(item.archivePath, item.path);
      if (item.indexFile) restoreEntryLines(item.indexFile, item.removedIndexLines);
      restored.push({ path: item.path, action: 'restore' });
    } catch (error) {
      skipped.push({ path: item.path, reason: 'restore-failed', detail: String(error.message || error) });
    }
  }
  receipt.restoredAt = at.toISOString();
  receipt.restored = restored;
  receipt.restoreSkipped = skipped;
  fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  return { ok: true, restored, skipped, receiptPath: path.join(dir, 'receipt.json') };
}

module.exports = {
  RETENTION_DAYS,
  executeConfig,
  restoreConfig,
  readConfigReceipt,
  removeEntryLines,
  safeInside,
};
