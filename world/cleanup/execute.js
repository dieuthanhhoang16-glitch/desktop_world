// world/cleanup/execute.js
// desktop-world · 清理执行器：默认 dry-run；已跟踪文件走专用分支 git rm，
// 未跟踪文件移入 .trash/<日期>/，30 天内可恢复，到期才允许清除。
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { RETENTION_DAYS } = require('./decisions');

const DAY_MS = 24 * 3600 * 1000;

function runGit(projectPath, args) {
  try {
    return {
      ok: true,
      out: execFileSync('git', ['-C', projectPath, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      out: String((error && error.stdout) || ''),
      err: String((error && error.stderr) || (error && error.message) || error),
    };
  }
}

function safeRel(rel) {
  if (typeof rel !== 'string' || !rel.trim()) return null;
  if (path.isAbsolute(rel)) return null;
  const norm = path.normalize(rel);
  if (norm.startsWith('..') || norm.split(path.sep).includes('..')) return null;
  return norm;
}

function localDate(at) {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function uniqueDestination(dest) {
  if (!fs.existsSync(dest)) return dest;
  const dir = path.dirname(dest);
  const base = path.basename(dest);
  for (let i = 1; i < 1000; i += 1) {
    const candidate = path.join(dir, `${base}.${i}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error('无法找到可用的回收站目标名');
}

function hasTrackedChanges(projectPath) {
  const res = runGit(projectPath, ['status', '--porcelain']);
  if (!res.ok) return { ok: false, reason: 'git-status-failed', detail: res.err };
  const lines = res.out.split('\n').filter(Boolean);
  const dirty = lines.filter((line) => !line.startsWith('??'));
  if (dirty.length) return { ok: false, reason: 'dirty-worktree', paths: dirty.map((l) => l.slice(3)) };
  return { ok: true };
}

function ensureBranch(projectPath, branch) {
  const current = runGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!current.ok) return { ok: false, reason: 'git-head-failed', detail: current.err };
  if (current.out.trim() === branch) return { ok: true, branch, switched: false };
  const exists = runGit(projectPath, ['rev-parse', '--verify', `refs/heads/${branch}`]);
  const checkout = exists.ok
    ? runGit(projectPath, ['checkout', branch])
    : runGit(projectPath, ['checkout', '-b', branch]);
  if (!checkout.ok) return { ok: false, reason: 'branch-create-failed', detail: checkout.err };
  return { ok: true, branch, switched: true };
}

/**
 * 预览或执行决策。
 * @param {object} opts
 * @param {string} opts.projectPath
 * @param {string} opts.dir 提案目录（回执写入处）
 * @param {object} opts.decisions readDecisions() 的结果
 * @param {boolean} [opts.dryRun=true]
 */
function execute({ projectPath, dir, decisions, dryRun = true, now = () => new Date() } = {}) {
  const project = path.resolve(String(projectPath || ''));
  const at = now();
  if (!decisions || decisions.schemaVersion !== 1 || !Array.isArray(decisions.items)) {
    return { ok: false, reason: 'invalid-decisions', message: 'decisions.json 缺失或格式不正确。' };
  }
  const deletes = decisions.items.filter((i) => i.action === 'delete');
  const date = localDate(at);
  const branch = decisions.branch || `cleanup/${decisions.proposalId}`;
  const recoverableUntil = new Date(at.getTime() + RETENTION_DAYS * DAY_MS).toISOString();
  const trashDir = path.join(project, '.trash', date);

  const preview = deletes.map((item) => {
    const rel = safeRel(item.path);
    return {
      path: item.path,
      valid: Boolean(rel),
      tracked: Boolean(item.tracked),
      action: item.tracked ? 'git-rm' : 'move',
      destination: item.tracked ? `git-branch:${branch}` : path.join(trashDir, rel || item.path),
      recoverableUntil: item.tracked ? null : recoverableUntil,
    };
  });

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      project,
      branch,
      trashDir,
      recoverableUntil,
      deleteCount: deletes.length,
      preview,
      message: `${deletes.length} 个文件将被处理（dry-run，未做任何修改）。`,
    };
  }
  if (!deletes.length) {
    return { ok: true, dryRun: false, noop: true, deleteCount: 0, message: '没有勾选任何删除项。' };
  }
  const invalid = preview.filter((p) => !p.valid);
  if (invalid.length) {
    return { ok: false, reason: 'unsafe-path', paths: invalid.map((p) => p.path), message: '决策中包含越界路径，已拒绝执行。' };
  }

  const trackedItems = deletes.filter((i) => i.tracked);
  const untrackedItems = deletes.filter((i) => !i.tracked);
  const results = [];
  let gitInfo = null;

  if (trackedItems.length) {
    const dirty = hasTrackedChanges(project);
    if (!dirty.ok) {
      return { ok: false, reason: dirty.reason, paths: dirty.paths || [], message: '工作区有未提交的已跟踪改动，拒绝切换清理分支。请先提交或暂存。' };
    }
    const switched = ensureBranch(project, branch);
    if (!switched.ok) {
      return { ok: false, reason: switched.reason, detail: switched.detail, message: '无法创建/切换到清理分支。' };
    }
    const fromCommit = runGit(project, ['rev-parse', 'HEAD']);
    gitInfo = { branch, switched: switched.switched, fromCommit: fromCommit.ok ? fromCommit.out.trim() : null };
    const removed = [];
    for (const item of trackedItems) {
      const res = runGit(project, ['rm', '--', item.path]);
      results.push({
        path: item.path,
        tracked: true,
        action: 'git-rm',
        status: res.ok ? 'removed' : 'failed',
        destination: `git-branch:${branch}`,
        recoverableUntil: null,
        error: res.ok ? null : res.err.slice(-300),
      });
      if (res.ok) removed.push(item.path);
    }
    if (removed.length) {
      const commit = runGit(project, ['commit', '-m', `chore(cleanup): remove ${removed.length} files (${decisions.proposalId})`]);
      gitInfo.commit = commit.ok ? (runGit(project, ['rev-parse', 'HEAD']).out || '').trim() : null;
      if (!commit.ok) gitInfo.commitError = commit.err.slice(-300);
    }
  }

  fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
  for (const item of untrackedItems) {
    const rel = safeRel(item.path);
    const src = path.join(project, rel);
    if (!fs.existsSync(src)) {
      results.push({ path: item.path, tracked: false, action: 'move', status: 'not-found', destination: null, recoverableUntil });
      continue;
    }
    try {
      const dest = uniqueDestination(path.join(trashDir, rel));
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.renameSync(src, dest);
      results.push({ path: item.path, tracked: false, action: 'move', status: 'moved', destination: dest, recoverableUntil });
    } catch (error) {
      results.push({ path: item.path, tracked: false, action: 'move', status: 'failed', destination: null, recoverableUntil, error: String(error.message || error) });
    }
  }

  const receipt = {
    schemaVersion: 1,
    proposalId: decisions.proposalId,
    project,
    executedAt: at.toISOString(),
    dryRun: false,
    retentionDays: RETENTION_DAYS,
    git: gitInfo,
    results,
    counts: {
      removed: results.filter((r) => r.status === 'removed').length,
      moved: results.filter((r) => r.status === 'moved').length,
      failed: results.filter((r) => r.status === 'failed').length,
      notFound: results.filter((r) => r.status === 'not-found').length,
    },
  };
  const receiptPath = path.join(dir, 'receipt.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  return { ok: true, dryRun: false, project, receiptPath, receipt, ...receipt.counts };
}

function readReceipt(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'receipt.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 30 天内恢复：已跟踪文件从清理分支的父提交取回；未跟踪文件从 .trash 移回原路径。
 */
function restore({ projectPath, dir, now = () => new Date() } = {}) {
  const project = path.resolve(String(projectPath || ''));
  const receipt = readReceipt(dir);
  if (!receipt) return { ok: false, reason: 'no-receipt', message: '没有可恢复的执行回执。' };
  const at = now();
  const restored = [];
  const skipped = [];
  for (const item of receipt.results || []) {
    if (item.status !== 'removed' && item.status !== 'moved') continue;
    if (item.recoverableUntil && new Date(item.recoverableUntil).getTime() < at.getTime()) {
      skipped.push({ path: item.path, reason: 'retention-expired' });
      continue;
    }
    if (item.tracked) {
      const fromCommit = receipt.git && receipt.git.fromCommit;
      if (!fromCommit) {
        skipped.push({ path: item.path, reason: 'missing-from-commit' });
        continue;
      }
      const res = runGit(project, ['checkout', fromCommit, '--', item.path]);
      if (res.ok) restored.push({ path: item.path, action: 'git-restore' });
      else skipped.push({ path: item.path, reason: 'git-restore-failed', detail: res.err.slice(-200) });
    } else {
      const rel = safeRel(item.path);
      const dest = path.join(project, rel);
      if (!item.destination || !fs.existsSync(item.destination)) {
        skipped.push({ path: item.path, reason: 'trash-missing' });
        continue;
      }
      if (fs.existsSync(dest)) {
        skipped.push({ path: item.path, reason: 'target-exists' });
        continue;
      }
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(item.destination, dest);
        restored.push({ path: item.path, action: 'move-back' });
      } catch (error) {
        skipped.push({ path: item.path, reason: 'move-failed', detail: String(error.message || error) });
      }
    }
  }
  receipt.restoredAt = at.toISOString();
  receipt.restored = restored;
  receipt.restoreSkipped = skipped;
  fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  return { ok: true, restored, skipped, receiptPath: path.join(dir, 'receipt.json') };
}

/**
 * 清除超过 30 天的 .trash 内容。按日期目录判断，未到期的一律不碰。
 */
function purge({ projectPath, now = () => new Date() } = {}) {
  const project = path.resolve(String(projectPath || ''));
  const root = path.join(project, '.trash');
  const at = now();
  const purged = [];
  const kept = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { ok: true, purged, kept, message: '没有回收站。' };
  }
  for (const e of entries) {
    if (!e.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(e.name)) continue;
    const expiry = new Date(`${e.name}T00:00:00Z`).getTime() + RETENTION_DAYS * DAY_MS;
    const dir = path.join(root, e.name);
    if (at.getTime() < expiry) {
      kept.push({ date: e.name, expiresAt: new Date(expiry).toISOString() });
      continue;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    purged.push({ date: e.name });
  }
  try {
    if (fs.readdirSync(root).length === 0) fs.rmdirSync(root);
  } catch {
    // ignore
  }
  return { ok: true, purged, kept };
}

module.exports = {
  RETENTION_DAYS,
  execute,
  restore,
  purge,
  readReceipt,
  safeRel,
  localDate,
  hasTrackedChanges,
};
