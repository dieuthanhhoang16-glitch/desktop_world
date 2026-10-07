// world/orch/blackboard.js
// desktop-world · 共享事实板（只追加，永不覆盖）。
//
// 语义边界（与 tickets.json 严格区分）：
//   tickets.json  = 工单账本，字段会被状态机改写（draft→confirmed→running→done）
//   blackboard    = 共享事实的**流水**，每条 entry 一旦写入就不可变、不可删、不可改。
//
// 为什么只追加：黑板是多个 agent 工单之间唯一的事实传递面。如果允许改写，
// "谁在什么时候说过什么"就不可审计了，收敛后的结论也会被后来的草稿悄悄顶掉。
// 事实错了就再追加一条更正（supersedes 指向旧条目），不改旧的。
//
// 存储 <orchDir>/blackboard.json：{ entries: [...] }，0600，只保留最近 N 条。
'use strict';

const fs = require('fs');
const path = require('path');
const { blackboardFile } = require('./paths');

const MAX_ENTRIES = 500;
const ENTRY_KINDS = new Set(['fact', 'decision', 'blocker', 'convergence', 'correction']);

// 条目内容全是自由文本（agent 写的结论、标题），进 UI 前必须收掉会破坏结构的字符。
// 换行尤其关键：一条 entry 若能带换行，就能伪造出第二条 entry（伪造"不存在的事实"）。
function sanitizeText(value, max = 400) {
  return String(value == null ? '' : value)
    .replace(/\r\n?|\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = ENTRY_KINDS.has(raw.kind) ? raw.kind : 'fact';
  const text = sanitizeText(raw.text);
  if (!text) return null;
  return {
    id: sanitizeText(raw.id, 40),
    at: Number.isFinite(Number(raw.at)) ? Number(raw.at) : 0,
    kind,
    text,
    // 关联工单：只保留合法 id 形状，避免任意串进 UI 与依赖图
    ticketIds: Array.isArray(raw.ticketIds)
      ? raw.ticketIds.map((t) => sanitizeText(t, 40)).filter((t) => /^ORCH-\d{3,}$/.test(t))
      : [],
    // 更正类条目指向被更正的旧条目
    supersedes: /^ORCH-\d{3,}$/.test(String(raw.supersedes || '')) ? raw.supersedes : '',
  };
}

function load(file = blackboardFile()) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { entries: [] };
    return { entries: Array.isArray(obj.entries) ? obj.entries.map(normalizeEntry).filter(Boolean) : [] };
  } catch {
    return { entries: [] };
  }
}

function saveAll(file, all) {
  const entries = (all && Array.isArray(all.entries) ? all.entries : [])
    .map(normalizeEntry)
    .filter(Boolean);
  // 只留最近 MAX_ENTRIES 条（黑板是流水不是无限增长的仓库）
  const kept = entries.slice(-MAX_ENTRIES);
  if (!kept.length) {
    try { fs.unlinkSync(file); } catch { /* 没文件就算了 */ }
    return { entries: [] };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ entries: kept }, null, 2), { mode: 0o600 });
  return { entries: kept };
}

/**
 * 追加一条事实（永不覆盖）。id 缺省时按 at + 序号派生，不引入随机。
 * @param file blackboard.json 路径
 * @param entry {kind, text, ticketIds, supersedes, at, id}
 * @returns 追加后的整块（便于调用方直接取 id）
 */
function append(file, entry) {
  const all = load(file);
  const at = Number.isFinite(Number(entry && entry.at)) ? Number(entry.at) : Date.now();
  const normalized = normalizeEntry({
    ...(entry || {}),
    at,
    id: (entry && entry.id) || `bb-${String(all.entries.length + 1).padStart(4, '0')}`,
  });
  if (!normalized) throw new Error('黑板条目必须有 text');
  all.entries.push(normalized);
  const saved = saveAll(file, all);
  return saved;
}

/** 追加多条（一次写盘，避免半截状态）。 */
function appendMany(file, entries = []) {
  const all = load(file);
  const base = all.entries.length;
  const at = Date.now();
  const added = [];
  (entries || []).forEach((e, i) => {
    const normalized = normalizeEntry({
      ...(e || {}),
      at: Number.isFinite(Number(e && e.at)) ? Number(e.at) : at + i,
      id: (e && e.id) || `bb-${String(base + i + 1).padStart(4, '0')}`,
    });
    if (normalized) {
      all.entries.push(normalized);
      added.push(normalized);
    }
  });
  return saveAll(file, all);
}

/** 读回（倒序，最新在前）—— UI 展示用这个方向。 */
function list(file, opts = {}) {
  const all = load(file);
  const entries = all.entries.slice().reverse();
  if (Array.isArray(opts.ticketId)) {
    const want = new Set(opts.ticketId);
    return entries.filter((e) => e.ticketIds.some((t) => want.has(t)));
  }
  return entries;
}

/** 按 kind 过滤。 */
function listByKind(file, kind) {
  if (!ENTRY_KINDS.has(kind)) return [];
  return load(file).entries.filter((e) => e.kind === kind).slice().reverse();
}

/** 工单收敛后的回报（stage ⑥）：一条 convergence 事实 + 可选更正。 */
function reportConvergence(file, { ticketIds = [], summary, supersededId = '' } = {}) {
  return append(file, {
    kind: 'convergence',
    text: summary,
    ticketIds,
    supersedes: supersededId,
  });
}

module.exports = {
  MAX_ENTRIES,
  ENTRY_KINDS,
  sanitizeText,
  normalizeEntry,
  load,
  saveAll,
  append,
  appendMany,
  list,
  listByKind,
  reportConvergence,
};