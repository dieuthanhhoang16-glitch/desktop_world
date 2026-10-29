// world/config-audit/audit.js
// desktop-world · ~/.claude 配置层只读审计。
//
// 只读元数据：stat、frontmatter 头部、MEMORY.md 的索引链接、zip 条目名。
// 不读取 settings.json、history、session 正文或任何密钥文件；审计不写配置目录。
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { isSecret } = require('../learn/sources');
const { claudeDir, archiveRoot, configProposalId } = require('./paths');

const IDENTITY_LIMIT = 20;
const WORKFLOW_LIMIT = 50;
const SKILL_LIMIT = 20;
const SKILL_UNUSED_DAYS = 60;
const PROJECT_TTL_DAYS = 180;
const SESSION_ARCHIVE_DAYS = 30;
const MAX_SESSION_CANDIDATES = 200;
const DAY = 24 * 3600 * 1000;

const LAYERS = Object.freeze({ identity: '身份/语气', workflow: '工作流习惯', project: '项目事实' });
const NEVER_READ = /(^|\/)(settings(\.local)?\.json|history\.jsonl|.*\.jsonl|.*\.env|credentials.*)$/i;

function daysAgo(ms, now) {
  return Math.floor((now.getTime() - ms) / DAY);
}

function statOf(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function relOf(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function humanBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** 只读文件头 4KB，解析 frontmatter 的 name/description/type（含 metadata.type）。 */
function readFrontmatter(file, maxBytes = 4096) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    const text = buf.slice(0, n).toString('utf8');
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return {};
    const out = {};
    let nested = null;
    for (const raw of m[1].split(/\r?\n/)) {
      if (!raw.trim() || raw.trim().startsWith('#')) continue;
      const top = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (top) {
        nested = top[1] === 'metadata' && !top[2].trim() ? 'metadata' : null;
        if (top[1] !== 'metadata') out[top[1]] = top[2].trim().replace(/^["']|["']$/g, '');
        continue;
      }
      const sub = raw.match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
      if (sub && nested === 'metadata') {
        if (sub[1] === 'type') out.type = sub[2].trim().replace(/^["']|["']$/g, '');
      }
    }
    return out;
  } catch {
    return {};
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function memoryLayer(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'user') return 'identity';
  if (t === 'feedback') return 'workflow';
  return 'project';
}

function findMemoryDirs(claude) {
  const dirs = [];
  const top = path.join(claude, 'memory');
  if (fs.existsSync(top)) dirs.push(top);
  const projects = path.join(claude, 'projects');
  let children = [];
  try {
    children = fs.readdirSync(projects, { withFileTypes: true });
  } catch {
    return dirs;
  }
  for (const child of children) {
    if (!child.isDirectory()) continue;
    const mem = path.join(projects, child.name, 'memory');
    if (fs.existsSync(mem)) dirs.push(mem);
  }
  return dirs;
}

function parseIndexEntries(indexFile) {
  let text = '';
  try {
    text = fs.readFileSync(indexFile, 'utf8');
  } catch {
    return [];
  }
  const entries = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/\[[^\]]*\]\(([^)]+)\)/);
    if (!m) continue;
    const raw = m[1].trim();
    if (!raw || /^(https?:|#|mailto:)/i.test(raw)) continue;
    const target = decodeURIComponent(raw.split('#')[0]);
    const abs = path.resolve(path.dirname(indexFile), target);
    if (!fs.existsSync(abs)) entries.push({ line: line.trim(), target: raw, file: indexFile });
  }
  return entries;
}

function addCandidate(map, candidate) {
  const existing = map.get(candidate.path);
  if (!existing) {
    map.set(candidate.path, candidate);
    return;
  }
  existing.evidenceLines = [...new Set([...existing.evidenceLines, ...candidate.evidenceLines])];
  existing.bucketReason = `${existing.bucketReason}；${candidate.bucketReason}`;
  if (!existing.entries && candidate.entries) existing.entries = candidate.entries;
}

function scanMemories(claude, archive, date, now, candidates) {
  const layers = {};
  const indexFiles = [];
  const dangling = [];
  for (const key of Object.keys(LAYERS)) layers[key] = { count: 0, bytes: 0, files: [], limit: key === 'identity' ? IDENTITY_LIMIT : key === 'workflow' ? WORKFLOW_LIMIT : null };

  for (const dir of findMemoryDirs(claude)) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const indexFile = path.join(dir, 'MEMORY.md');
    const indexEntries = fs.existsSync(indexFile) ? parseIndexEntries(indexFile) : [];
    if (indexEntries.length) {
      indexFiles.push(indexFile);
      dangling.push(...indexEntries);
      const rel = relOf(claude, indexFile);
      addCandidate(candidates, {
        path: indexFile,
        kind: 'index-entries',
        category: 'dangling-index',
        bucket: 'confirmed',
        risk: 'low',
        size: statOf(indexFile)?.size || 0,
        tracked: false,
        evidenceLines: [
          `索引中有 ${indexEntries.length} 条链接指向不存在的文件`,
          `索引：${rel}`,
          `最后修改：${statOf(indexFile) ? new Date(statOf(indexFile).mtimeMs).toISOString() : '未知'}`,
        ],
        bucketReason: '悬空索引条目，删除前会归档索引文件',
        archiveTo: path.join(archive, rel),
        entries: indexEntries.map((e) => ({ line: e.line, target: e.target })),
      });
    }

    for (const e of entries) {
      if (!e.isFile() || !/\.md$/i.test(e.name) || e.name === 'MEMORY.md') continue;
      const file = path.join(dir, e.name);
      if (isSecret(relOf(claude, file))) continue;
      const stat = statOf(file);
      if (!stat) continue;
      const meta = readFrontmatter(file);
      const layer = memoryLayer(meta.type);
      const bucket = layers[layer];
      bucket.count += 1;
      bucket.bytes += stat.size;
      bucket.files.push({ path: file, name: meta.name || path.basename(file, '.md'), description: meta.description || '', ageDays: daysAgo(stat.mtimeMs, now), size: stat.size, layer });
    }
  }

  for (const key of ['identity', 'workflow']) {
    const layer = layers[key];
    if (!layer.limit || layer.count <= layer.limit) continue;
    const excess = layer.count - layer.limit;
    const victims = layer.files.slice().sort((a, b) => b.ageDays - a.ageDays || a.path.localeCompare(b.path)).slice(0, excess);
    for (const v of victims) {
      const rel = relOf(claude, v.path);
      addCandidate(candidates, {
        path: v.path,
        kind: 'file',
        category: 'memory-over-budget',
        bucket: 'pending',
        risk: 'high',
        size: v.size,
        tracked: false,
        evidenceLines: [
          `层：${LAYERS[key]}（${key}）`,
          `超预算：${layer.count} 条 / 上限 ${layer.limit} 条`,
          `该文件 ${v.ageDays} 天未修改，${humanBytes(v.size)}`,
        ],
        bucketReason: `记忆层超过预算，建议合并或删除最早条目（${key} ${layer.count}/${layer.limit}）`,
        archiveTo: path.join(archive, rel),
        removeIndexLine: true,
      });
    }
  }

  for (const v of layers.project.files) {
    if (v.ageDays < PROJECT_TTL_DAYS) continue;
    const rel = relOf(claude, v.path);
    addCandidate(candidates, {
      path: v.path,
      kind: 'file',
      category: 'memory-expired',
      bucket: 'pending',
      risk: 'medium',
      size: v.size,
      tracked: false,
      evidenceLines: [
        `层：${LAYERS.project}（project）`,
        `TTL：${PROJECT_TTL_DAYS} 天，已 ${v.ageDays} 天未修改`,
        `体积：${humanBytes(v.size)}`,
      ],
      bucketReason: `项目事实超过 ${PROJECT_TTL_DAYS} 天 TTL，建议归档`,
      archiveTo: path.join(archive, rel),
      removeIndexLine: true,
    });
  }

  return {
    layers,
    indexFiles: indexFiles.length,
    danglingEntries: dangling.length,
    danglingFiles: [...new Set(dangling.map((d) => d.file))],
  };
}

function walkSkillDirs(root, out, depth = 0) {
  if (depth > 3) return;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) out.push(root);
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    walkSkillDirs(path.join(root, e.name), out, depth + 1);
  }
}

function zipTopEntries(zip) {
  try {
    const out = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
    return [...new Set(out.split(/\r?\n/).map((l) => l.split('/')[0]).filter(Boolean))];
  } catch {
    return [];
  }
}

function scanSkills(claude, archive, date, now, candidates) {
  const skillsRoot = path.join(claude, 'skills');
  const dirs = [];
  walkSkillDirs(skillsRoot, dirs);
  const skills = dirs.map((dir) => {
    const file = path.join(dir, 'SKILL.md');
    const stat = statOf(file) || statOf(dir);
    const meta = readFrontmatter(file);
    return {
      dir,
      file,
      name: (meta.name || path.basename(dir)).toLowerCase(),
      mtimeMs: stat ? stat.mtimeMs : 0,
      ageDays: stat ? daysAgo(stat.mtimeMs, now) : 0,
      size: stat ? stat.size : 0,
    };
  });

  const byName = new Map();
  for (const s of skills) {
    if (!byName.has(s.name)) byName.set(s.name, []);
    byName.get(s.name).push(s);
  }
  const duplicateDirs = new Set();
  for (const [, group] of byName) {
    if (group.length < 2) continue;
    const sorted = group.slice().sort((a, b) => b.mtimeMs - a.mtimeMs || a.dir.length - b.dir.length || a.dir.localeCompare(b.dir));
    for (const dup of sorted.slice(1)) duplicateDirs.add(dup.dir);
  }

  const uniqueCount = new Set(skills.map((s) => s.name)).size;
  for (const s of skills) {
    const rel = relOf(claude, s.dir);
    if (duplicateDirs.has(s.dir)) {
      addCandidate(candidates, {
        path: s.dir,
        kind: 'directory',
        category: 'duplicate-skill',
        bucket: 'confirmed',
        risk: 'low',
        size: s.size,
        tracked: false,
        evidenceLines: [
          `技能名重复：${s.name}`,
          `目录：${rel}`,
          `最后修改：${new Date(s.mtimeMs).toISOString()}`,
        ],
        bucketReason: '同类技能重复，保留同名的较新目录',
        archiveTo: path.join(archive, rel),
      });
    } else if (s.ageDays >= SKILL_UNUSED_DAYS) {
      addCandidate(candidates, {
        path: s.dir,
        kind: 'directory',
        category: 'skill-unused',
        bucket: 'pending',
        risk: 'medium',
        size: s.size,
        tracked: false,
        evidenceLines: [
          `技能 ${SKILL_UNUSED_DAYS} 天未修改：已 ${s.ageDays} 天`,
          `目录：${rel}`,
          `体积：${humanBytes(s.size)}`,
        ],
        bucketReason: `技能 ${SKILL_UNUSED_DAYS} 天未使用，进入候选`,
        archiveTo: path.join(archive, rel),
      });
    }
  }

  if (uniqueCount > SKILL_LIMIT) {
    const excess = skills.slice().sort((a, b) => b.ageDays - a.ageDays || a.dir.localeCompare(b.dir)).slice(0, uniqueCount - SKILL_LIMIT);
    for (const s of excess) {
      const rel = relOf(claude, s.dir);
      addCandidate(candidates, {
        path: s.dir,
        kind: 'directory',
        category: 'skill-over-budget',
        bucket: 'pending',
        risk: 'high',
        size: s.size,
        tracked: false,
        evidenceLines: [`技能总数 ${uniqueCount} / 上限 ${SKILL_LIMIT}`, `该技能 ${s.ageDays} 天未修改`, `目录：${rel}`],
        bucketReason: '用户技能超过 20 个预算',
        archiveTo: path.join(archive, rel),
      });
    }
  }

  // zip 与解压目录重复
  const zips = [];
  (function findZips(dir, depth = 0) {
    if (depth > 3) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) findZips(path.join(dir, e.name), depth + 1);
      else if (e.isFile() && /\.zip$/i.test(e.name)) zips.push(path.join(dir, e.name));
    }
  })(skillsRoot);
  for (const zip of zips) {
    const parent = path.dirname(zip);
    let dirsHere = [];
    try {
      dirsHere = fs.readdirSync(parent, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      dirsHere = [];
    }
    const tops = zipTopEntries(zip);
    const matches = tops.filter((t) => dirsHere.includes(t));
    const stem = path.basename(zip, '.zip');
    if (!matches.length && !dirsHere.includes(stem)) continue;
    const stat = statOf(zip);
    const rel = relOf(claude, zip);
    addCandidate(candidates, {
      path: zip,
      kind: 'file',
      category: 'zip-duplicate',
      bucket: 'confirmed',
      risk: 'low',
      size: stat ? stat.size : 0,
      tracked: false,
      evidenceLines: [
        matches.length ? `zip 内顶层目录已解压：${matches.slice(0, 5).join('、')}` : `同名解压目录已存在：${stem}/`,
        `zip：${rel}（${humanBytes(stat ? stat.size : 0)}）`,
      ],
      bucketReason: 'zip 与解压目录重复，保留解压目录',
      archiveTo: path.join(archive, rel),
    });
  }

  return { count: skills.length, uniqueCount, duplicateCount: duplicateDirs.size, unusedCount: skills.filter((s) => s.ageDays >= SKILL_UNUSED_DAYS).length, dirs, zips: zips.length };
}

function scanSessions(claude, archive, date, now, candidates) {
  const projects = path.join(claude, 'projects');
  let projectDirs = [];
  try {
    projectDirs = fs.readdirSync(projects, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return { count: 0, oldCount: 0, months: {} };
  }
  let count = 0;
  let oldCount = 0;
  let added = 0;
  const months = {};
  for (const p of projectDirs) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(projects, p.name), { withFileTypes: true }).filter((e) => e.isFile() && /\.jsonl$/i.test(e.name));
    } catch {
      continue;
    }
    for (const f of files) {
      count += 1;
      const file = path.join(projects, p.name, f.name);
      const stat = statOf(file);
      if (!stat) continue;
      const age = daysAgo(stat.mtimeMs, now);
      if (age < SESSION_ARCHIVE_DAYS) continue;
      oldCount += 1;
      const month = new Date(stat.mtimeMs).toISOString().slice(0, 7);
      months[month] = (months[month] || 0) + 1;
      if (added >= MAX_SESSION_CANDIDATES) continue;
      added += 1;
      const monthlyRel = path.join('sessions', month, p.name, f.name);
      addCandidate(candidates, {
        path: file,
        kind: 'file',
        category: 'session-archive',
        bucket: 'pending',
        risk: 'low',
        size: stat.size,
        tracked: false,
        evidenceLines: [
          `session 已 ${age} 天未更新（阈值 ${SESSION_ARCHIVE_DAYS} 天）`,
          `按月归档：${month}`,
          `体积：${humanBytes(stat.size)}`,
        ],
        bucketReason: `超过 ${SESSION_ARCHIVE_DAYS} 天的 session，先归档到 ${month} 再删除`,
        archiveTo: path.join(archive, monthlyRel),
        archiveMonth: month,
      });
    }
  }
  return { count, oldCount, months, capped: oldCount > MAX_SESSION_CANDIDATES };
}

/**
 * @param {object} opts
 * @param {string} [opts.claudeDir]
 * @param {Function} [opts.now]
 * @param {string} [opts.archiveDir]
 * @param {string} [opts.root] 清理根目录（提案位置）
 */
function auditConfig({ claudeDir: dir, now = () => new Date(), archiveDir, root } = {}) {
  const claude = claudeDir(dir);
  const at = now();
  const date = at.toISOString().slice(0, 10);
  const proposalId = configProposalId(date);
  const archive = path.join(archiveRoot(archiveDir), proposalId);
  const candidates = new Map();

  if (!fs.existsSync(claude)) {
    return { ok: false, reason: 'claude-dir-not-found', root: claude };
  }

  const memories = scanMemories(claude, archive, date, at, candidates);
  const skills = scanSkills(claude, archive, date, at, candidates);
  const sessions = scanSessions(claude, archive, date, at, candidates);

  const list = [...candidates.values()].sort((a, b) => {
    const order = { confirmed: 0, pending: 1, keep: 2 };
    return order[a.bucket] - order[b.bucket] || a.path.localeCompare(b.path);
  });

  const totalBytes = Object.values(memories.layers).reduce((n, l) => n + l.bytes, 0);
  const overBudget = Object.entries(memories.layers)
    .filter(([, l]) => l.limit && l.count > l.limit)
    .map(([layer, l]) => ({ layer, count: l.count, limit: l.limit }));
  if (skills.uniqueCount > SKILL_LIMIT) overBudget.push({ layer: 'skills', count: skills.uniqueCount, limit: SKILL_LIMIT });

  return {
    ok: true,
    root: claude,
    scannedAt: at.toISOString(),
    date,
    proposalId,
    archiveRoot: archive,
    memory: {
      layers: memories.layers,
      totalBytes,
      totalCount: Object.values(memories.layers).reduce((n, l) => n + l.count, 0),
      overBudget,
      ttlDays: PROJECT_TTL_DAYS,
    },
    skills: {
      count: skills.count,
      uniqueCount: skills.uniqueCount,
      limit: SKILL_LIMIT,
      duplicateCount: skills.duplicateCount,
      unusedCount: skills.unusedCount,
      unusedDays: SKILL_UNUSED_DAYS,
      zips: skills.zips,
    },
    indexes: { files: memories.indexFiles, danglingEntries: memories.danglingEntries, danglingFiles: memories.danglingFiles },
    sessions: { ...sessions, archiveAfterDays: SESSION_ARCHIVE_DAYS },
    candidates: list,
    counts: {
      confirmed: list.filter((c) => c.bucket === 'confirmed').length,
      pending: list.filter((c) => c.bucket === 'pending').length,
      total: list.length,
      danglingIndex: list.filter((c) => c.category === 'dangling-index').length,
      duplicateSkill: list.filter((c) => c.category === 'duplicate-skill').length,
      duplicates: list.filter((c) => c.category === 'duplicate-skill' || c.category === 'zip-duplicate').length,
    },
  };
}

module.exports = {
  IDENTITY_LIMIT,
  WORKFLOW_LIMIT,
  SKILL_LIMIT,
  SKILL_UNUSED_DAYS,
  PROJECT_TTL_DAYS,
  SESSION_ARCHIVE_DAYS,
  readFrontmatter,
  memoryLayer,
  auditConfig,
  NEVER_READ,
};
