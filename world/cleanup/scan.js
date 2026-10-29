// world/cleanup/scan.js
// desktop-world · 只读文件扫描与候选识别。
//
// 四类候选：duplicate（重复/被取代）、unreferenced（未引用）、stale（长期未动）、
// generated（生成物误入库）。每条候选至少两类证据。近 14 天修改的文件与当前
// ticket 范围内的文件一律不进候选。扫描绝不写项目。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { isSecret } = require('../learn/sources');

const EXCLUDE_DIRS = new Set([
  '.git', 'node_modules', 'vendor', 'target', '.venv', 'venv', '__pycache__', '.cache',
  '.trash', '.idea', '.vscode', '.DS_Store', 'tmp',
]);
const BUILD_DIRS = new Set(['dist', 'build', 'out', 'coverage', '.next', '.nuxt']);
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.yml', '.yaml', '.html', '.css', '.scss', '.py', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.sh', '.toml', '.ini']);
const NEVER_CANDIDATE = [
  /^(README|LICENSE|NOTICE|CHANGELOG|CONTRIBUTING|AGENTS|CLAUDE|GLOSSARY)(\.|$)/i,
  /^(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig.*\.json)$/i,
  /^(index|launch|main)\.(js|mjs|cjs|ts)$/,
  /^src\/(main|index)\.(js|mjs|cjs|ts)$/,
  /^test\//,
  /^\.github\//,
  /(^|\/)(\.eslintrc|\.prettierrc|vite\.config|webpack\.config|electron-builder)/i,
];
const SUPERSEDED_RE = /(\.bak|\.old|\.orig|~|\.copy|copy of|备份|旧版|deprecated)/i;
const GENERATED_RE = /(^|\/)(dist|build|out|coverage|\.next|\.nuxt)\/|\.min\.(js|css)$|\.map$/i;
const FOURTEEN_DAYS = 14;
const STALE_DAYS = 180;
const MAX_FILES = 5000;
const MAX_HASH_BYTES = 2 * 1024 * 1024;
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_CANDIDATES = 40;
const JEV_LIMIT = 12;

function git(projectPath, args) {
  try {
    return execFileSync('git', ['-C', projectPath, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    });
  } catch {
    return null;
  }
}

function walk(projectPath) {
  const root = path.resolve(projectPath);
  const files = [];
  function rec(rel, depth) {
    if (depth > 8 || files.length >= MAX_FILES) return;
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= MAX_FILES) return;
      const child = rel ? path.join(rel, e.name) : e.name;
      const posix = child.split(path.sep).join('/');
      if (e.isDirectory()) {
        if (EXCLUDE_DIRS.has(e.name)) continue;
        if (e.name.startsWith('.') && e.name !== '.scratch') continue;
        rec(child, depth + 1);
      } else if (e.isFile()) {
        if (isSecret(posix)) continue;
        let stat;
        try {
          stat = fs.lstatSync(path.join(root, child));
        } catch {
          continue;
        }
        files.push({
          path: posix,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          inBuildDir: posix.split('/').some((seg) => BUILD_DIRS.has(seg)),
        });
      }
    }
  }
  rec('', 0);
  return files;
}

function sha256File(abs, size) {
  if (size > MAX_HASH_BYTES) return null;
  try {
    return 'sha256-' + crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  } catch {
    return null;
  }
}

function isEligible(rel) {
  if (isSecret(rel)) return false;
  return !NEVER_CANDIDATE.some((re) => re.test(rel));
}

function activeTicketScope(projectPath, fileSet) {
  const root = path.resolve(projectPath);
  const scope = new Set();
  const files = [...fileSet].filter((p) => /^\.scratch\/.*\/issues\/.*\.md$/.test(p));
  for (const rel of files) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      continue;
    }
    const active = /Status:\s*(ready-for-agent|in-progress|in_progress|进行中)/i.test(text) || /^- \[ \]/m.test(text);
    if (!active) continue;
    scope.add(rel);
    const tokens = text.match(/[A-Za-z0-9_.\-/]+\.(?:md|js|mjs|cjs|ts|tsx|json|ya?ml|py|go|rs|css|html|sh)/g) || [];
    for (const token of tokens) {
      const clean = token.replace(/^\.\//, '');
      if (fileSet.has(clean)) scope.add(clean);
    }
  }
  return scope;
}

function buildTextIndex(projectPath, files) {
  const root = path.resolve(projectPath);
  const index = [];
  let total = 0;
  for (const f of files) {
    if (total >= MAX_INDEX_BYTES) break;
    if (f.size > 256 * 1024) continue;
    if (f.inBuildDir) continue;
    if (!TEXT_EXT.has(path.extname(f.path).toLowerCase())) continue;
    let text = '';
    try {
      text = fs.readFileSync(path.join(root, f.path), 'utf8');
    } catch {
      continue;
    }
    total += text.length;
    index.push({ path: f.path, text: text.toLowerCase() });
  }
  return index;
}

function countReferences(index, rel) {
  const base = path.basename(rel).toLowerCase();
  const relLower = rel.toLowerCase();
  let count = 0;
  const refs = [];
  for (const doc of index) {
    if (doc.path === rel) continue;
    let n = 0;
    let at = doc.text.indexOf(base);
    while (at >= 0) {
      n += 1;
      at = doc.text.indexOf(base, at + base.length);
    }
    if (n > 0) {
      count += n;
      if (refs.length < 8) refs.push(doc.path);
    } else if (doc.text.includes(relLower)) {
      count += 1;
      if (refs.length < 8) refs.push(doc.path);
    }
  }
  return { count, refs };
}

function daysAgo(ms, now) {
  return Math.floor((now.getTime() - ms) / (24 * 3600 * 1000));
}

function pickKeeper(group) {
  return group
    .slice()
    .sort((a, b) => {
      const supA = SUPERSEDED_RE.test(a.path) ? 1 : 0;
      const supB = SUPERSEDED_RE.test(b.path) ? 1 : 0;
      return supA - supB || Number(!a.tracked) - Number(!b.tracked) || a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path);
    })[0];
}

/**
 * @returns {{ok:true, project:string, candidates:Array, counts:object, params:object, exclusions:object}}
 */
function scanProject(projectPath, { now = () => new Date(), jevLimit = JEV_LIMIT } = {}) {
  const root = path.resolve(String(projectPath || ''));
  const at = now();
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { ok: false, reason: 'project-not-found', project: root };
  }
  const isGit = git(root, ['rev-parse', '--is-inside-work-tree']) === 'true\n';
  const trackedList = isGit ? (git(root, ['ls-files', '-z']) || '').split('\0').filter(Boolean) : [];
  const tracked = new Set(trackedList);

  const rawFiles = walk(root).map((f) => ({ ...f, tracked: tracked.has(f.path) }));
  const fileSet = new Set(rawFiles.map((f) => f.path));
  const ticketScope = activeTicketScope(root, fileSet);
  const index = buildTextIndex(root, rawFiles);

  const exclusions = {
    recentDays: 14,
    staleDays: STALE_DAYS,
    excludedDirs: [...EXCLUDE_DIRS, ...BUILD_DIRS],
    excludedPatterns: NEVER_CANDIDATE.map(String),
    ticketScope: [...ticketScope].sort(),
  };

  const stats = new Map();
  const hashGroups = new Map();
  for (const f of rawFiles) {
    const age = daysAgo(f.mtimeMs, at);
    const eligible = isEligible(f.path) && age >= FOURTEEN_DAYS && !ticketScope.has(f.path);
    f.ageDays = age;
    f.eligible = eligible;
    if (!eligible) continue;
    const ref = countReferences(index, f.path);
    const hash = sha256File(path.join(root, f.path), f.size);
    f.hash = hash;
    f.refCount = ref.count;
    f.refs = ref.refs;
    if (hash) {
      if (!hashGroups.has(hash)) hashGroups.set(hash, []);
      hashGroups.get(hash).push(f);
    }
    stats.set(f.path, f);
  }

  const candidates = [];
  const seen = new Set();
  const push = (f, category, extra) => {
    if (seen.has(f.path)) return;
    seen.add(f.path);
    const lastCommitSec = isGit ? Number(git(root, ['log', '-1', '--format=%ct', '--', f.path]) || 0) || null : null;
    const evidenceLines = [];
    if (f.refCount !== undefined) evidenceLines.push(`引用搜索：${f.refCount} 处${f.refs.length ? `（${f.refs.slice(0, 3).join('、')}）` : ''}`);
    evidenceLines.push(`最后修改：${new Date(f.mtimeMs).toISOString()}（${f.ageDays} 天前）`);
    if (extra.duplicateOf) evidenceLines.push(`内容哈希：${f.hash.slice(0, 23)}… 与 ${extra.duplicateOf} 相同`);
    if (lastCommitSec) evidenceLines.push(`git 最后提交：${new Date(lastCommitSec * 1000).toISOString()}`);
    evidenceLines.push(f.tracked ? 'git：已跟踪' : 'git：未跟踪');
    if (extra.generated) evidenceLines.push('生成物特征：构建目录或 .min/.map 产物被提交');
    candidates.push({
      path: f.path,
      category,
      risk: extra.risk || (f.tracked ? 'medium' : 'low'),
      size: f.size,
      tracked: f.tracked,
      evidence: {
        referenceCount: f.refCount ?? null,
        references: f.refs || [],
        lastModified: new Date(f.mtimeMs).toISOString(),
        ageDays: f.ageDays,
        lastCommit: lastCommitSec ? new Date(lastCommitSec * 1000).toISOString() : null,
        duplicateHash: extra.duplicateOf ? f.hash : null,
        duplicateOf: extra.duplicateOf || null,
        generated: Boolean(extra.generated),
        tracked: f.tracked,
      },
      evidenceLines,
      jevReason: '',
      jevScore: null,
    });
  };

  // 1) 重复/被取代
  const duplicateKeepers = new Set();
  for (const [, group] of hashGroups) {
    if (group.length < 2) continue;
    const keeper = pickKeeper(group);
    duplicateKeepers.add(keeper.path);
    for (const f of group) {
      if (f.path === keeper.path) continue;
      push(f, 'duplicate', { duplicateOf: keeper.path, risk: 'low' });
    }
  }

  // 2) 生成物误入库
  for (const f of rawFiles) {
    if (!f.eligible || seen.has(f.path) || duplicateKeepers.has(f.path)) continue;
    if (f.tracked && GENERATED_RE.test(f.path)) push(f, 'generated', { generated: true, risk: 'low' });
  }

  // 3) 未引用
  for (const f of rawFiles) {
    if (!f.eligible || seen.has(f.path) || duplicateKeepers.has(f.path)) continue;
    if (f.inBuildDir) continue;
    if (f.refCount === 0) push(f, 'unreferenced', { risk: f.tracked ? 'medium' : 'low' });
  }

  // 4) 长期未动（同时要求 git 最后提交也足够久，避免误伤近期改过的文件）
  for (const f of rawFiles) {
    if (!f.eligible || seen.has(f.path) || duplicateKeepers.has(f.path)) continue;
    if (f.ageDays < STALE_DAYS) continue;
    const lastCommitSec = isGit ? Number(git(root, ['log', '-1', '--format=%ct', '--', f.path]) || 0) || null : null;
    if (lastCommitSec && daysAgo(lastCommitSec * 1000, at) < STALE_DAYS) continue;
    push(f, 'stale', { risk: 'high' });
  }

  // 被取代的命名即使内容不同也标为 duplicate（旧备份）
  for (const f of rawFiles) {
    if (!f.eligible || seen.has(f.path) || duplicateKeepers.has(f.path)) continue;
    if (SUPERSEDED_RE.test(f.path)) push(f, 'duplicate', { risk: 'low' });
  }

  const order = { duplicate: 0, generated: 1, unreferenced: 2, stale: 3 };
  candidates.sort((a, b) => order[a.category] - order[b.category] || a.path.localeCompare(b.path));
  const forJev = candidates.slice(0, jevLimit).map((c, i) => ({ ...c, key: `c${i}` }));

  return {
    ok: true,
    project: root,
    scannedAt: at.toISOString(),
    isGit,
    trackedCount: tracked.size,
    candidates: forJev,
    totalCandidates: candidates.length,
    counts: candidates.reduce((acc, c) => ({ ...acc, [c.category]: (acc[c.category] || 0) + 1 }), {}),
    params: {
      maxFiles: MAX_FILES,
      maxHashBytes: MAX_HASH_BYTES,
      maxIndexBytes: MAX_INDEX_BYTES,
      maxCandidates: MAX_CANDIDATES,
      jevLimit,
      recentDays: 14,
      staleDays: STALE_DAYS,
      git: isGit,
    },
    exclusions,
  };
}

module.exports = {
  scanProject,
  EXCLUDE_DIRS,
  BUILD_DIRS,
  GENERATED_RE,
  SUPERSEDED_RE,
  FOURTEEN_DAYS,
  STALE_DAYS,
  JEV_LIMIT,
  git,
};
