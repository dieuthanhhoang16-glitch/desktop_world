// world/learn/sources.js
// desktop-world · 学习卡来源扫描（只读）。
//
// 来源：docs/agents/*、GLOSSARY.md、docs/adr/*、spec（docs/plans/*）、
// ticket（.scratch/**/issues/*.md）、handoff（docs/handoffs/* 或 *handoff*.md）、
// grill（文件名或首行标题含 grill/共识/consensus 的任意 md/txt）。
// 排除依赖目录、构建产物、.git、.trash 与密钥文件；绝不读 .env / 凭据。
'use strict';

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '.trash', '.cache', 'vendor', 'target']);
const SECRET_RE = /(^|\/)(\.env(\..*)?|id_rsa|id_ed25519|credentials(\.json)?|secrets?(\.json)?|(secret|secrets|credentials)\.(md|txt|ya?ml)|[^/]+\.(pem|key|p12|pfx))$/i;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 400;
// grill（GRILL 拷问/共识文档）识别：文件名大小写不敏感，首行标题按原样匹配
const GRILL_NAME_RE = /grill|共识|consensus/i;
const GRILL_H1_RE = /grill|GRILL|共识|consensus/;

function isSecret(rel) {
  return SECRET_RE.test(rel.replace(/\\/g, '/'));
}

function walk(root, rel, out, depth = 0) {
  if (depth > 6 || out.length >= MAX_FILES) return;
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    const child = rel ? path.join(rel, e.name) : e.name;
    const posix = child.split(path.sep).join('/');
    if (isSecret(posix)) continue;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      // 隐藏目录默认跳过，但 .scratch 是 ticket 的正式来源
      if (e.name.startsWith('.') && e.name !== '.scratch') continue;
      walk(root, child, out, depth + 1);
    } else if (e.isFile() && /\.(md|markdown|txt)$/i.test(e.name)) {
      out.push(posix);
    }
  }
}

function classify(rel) {
  const p = rel.replace(/\\/g, '/');
  if (p === 'GLOSSARY.md' || /\/GLOSSARY\.md$/.test(p)) return 'glossary';
  if (p.startsWith('docs/agents/')) return 'agent-doc';
  if (p.startsWith('docs/adr/')) return 'adr';
  if (p.startsWith('docs/plans/')) return 'spec';
  if (p.startsWith('.scratch/')) return /\/issues\/[^/]+\.md$/i.test(p) ? 'ticket' : null;
  if (p.startsWith('docs/handoffs/') || /(^|\/)handoff[^/]*\.md$/i.test(p)) return 'handoff';
  // 文件名命中 grill/共识/consensus 即归为共识文档（既有六类规则优先）
  if (GRILL_NAME_RE.test(path.basename(p))) return 'grill';
  return null;
}

const PRIORITY = Object.freeze({ glossary: 0, 'agent-doc': 1, adr: 2, spec: 3, ticket: 4, handoff: 5, grill: 6 });

function countChars(text) {
  return [...String(text).replace(/\s+/g, '')].length;
}

function firstHeading(body) {
  const m = String(body).match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : '';
}

function splitSections(body) {
  const lines = String(body).split(/\r?\n/);
  const sections = [];
  let current = { heading: '', text: [] };
  for (const line of lines) {
    const m = line.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (m) {
      if (current.heading || current.text.join('').trim()) sections.push(current);
      current = { heading: m[2].trim(), level: m[1].length, text: [] };
    } else {
      current.text.push(line);
    }
  }
  if (current.heading || current.text.join('').trim()) sections.push(current);
  return sections;
}

/**
 * @returns {{sources:Array, skipped:Array}}
 */
function scanSources(projectPath, { maxFiles = MAX_FILES } = {}) {
  const root = path.resolve(String(projectPath || ''));
  const files = [];
  walk(root, '', files);
  const sources = [];
  const skipped = [];
  for (const rel of files) {
    let kind = classify(rel);
    const abs = path.join(root, rel);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      skipped.push({ path: rel, reason: stat.size > MAX_FILE_BYTES ? 'too-large' : 'not-file' });
      continue;
    }
    let body = '';
    try {
      body = fs.readFileSync(abs, 'utf8');
    } catch {
      skipped.push({ path: rel, reason: 'unreadable' });
      continue;
    }
    // 正文晋升：路径规则没归类的条目，首行标题命中 grill/共识/consensus 即归为共识文档
    if (!kind && GRILL_H1_RE.test(firstHeading(body))) kind = 'grill';
    if (!kind) continue;
    sources.push({
      path: rel.split(path.sep).join('/'),
      kind,
      title: firstHeading(body) || path.basename(rel, path.extname(rel)),
      body,
      chars: countChars(body),
      sections: splitSections(body),
      mtimeMs: stat.mtimeMs,
    });
    if (sources.length + skipped.length >= maxFiles) break;
  }
  // 同一份内容的来源只留优先级最高的一个，避免重复卡片
  const seen = new Set();
  const deduped = [];
  for (const s of sources.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.path.localeCompare(b.path))) {
    const hash = require('crypto').createHash('sha256').update(s.body).digest('hex');
    if (seen.has(hash)) {
      skipped.push({ path: s.path, reason: 'duplicate-content' });
      continue;
    }
    seen.add(hash);
    deduped.push({ ...s, contentHash: hash });
  }
  return { sources: deduped, skipped };
}

module.exports = { scanSources, classify, splitSections, countChars, isSecret, SKIP_DIRS, PRIORITY };
