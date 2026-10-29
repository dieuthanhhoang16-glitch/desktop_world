// world/metrics/events.js
// desktop-world · 本地指标事件（只追加 JSONL，0600）。
//
// 隐私边界：事件只保存 type / subject（短标签）/ 时间 / 来源 / 计数。
// 不保存原文、文件名、项目内容、密钥或模型输出；未知字段一律丢弃。
'use strict';

const fs = require('fs');
const path = require('path');

const { metricsRoot, eventsFile } = require('./paths');

const TYPES = new Set([
  'explanation', // 用户又一次解释同一偏好/流程
  'correction', // 用户纠正 agent
  'config-snapshot', // 配置层悬空条目/重复项快照
  'cleanup-proposal', // 生成清理提案
  'cleanup-execute', // 执行确认删除
  'cleanup-restore', // 从回收站/归档恢复
]);

const SUBJECT_RE = /^[A-Za-z0-9._:\-一-龥]{1,64}$/;
const SOURCE_RE = /^[a-z0-9-]{1,24}$/;
const REF_RE = /^[A-Za-z0-9:._-]{1,80}$/;
const COUNT_KEY_RE = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const SECRET_SUBJECT_RE = /(^|[-_:])(sk|pk|api[-_]?key|token|secret|password|bearer)[-_:]/i;
const MAX_COUNT_KEYS = 20;

function looksLikeSecret(subject) {
  const s = String(subject || '');
  return SECRET_SUBJECT_RE.test(s) || /^(sk-|ghp_|xox[baprs]-|AKIA|Bearer\s)/i.test(s);
}

function normalizeSubject(value) {
  if (value == null || value === '') return null;
  const s = String(value);
  if (!SUBJECT_RE.test(s) || looksLikeSecret(s)) return null;
  return s;
}

function normalizeCounts(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  let n = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (n >= MAX_COUNT_KEYS) break;
    if (!COUNT_KEY_RE.test(key)) continue;
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) continue;
    out[key] = Math.floor(num);
    n += 1;
  }
  return out;
}

/** 只保留白名单字段；解析坏行时返回 null。 */
function normalizeEvent(raw, { fallbackAt = Date.now(), fallbackId = null } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const type = String(raw.type || '');
  if (!TYPES.has(type)) return null;
  const ms = Date.parse(raw.at);
  const at = Number.isFinite(ms) ? ms : fallbackAt;
  const source = SOURCE_RE.test(String(raw.source || '')) ? String(raw.source) : 'unknown';
  const ref = REF_RE.test(String(raw.ref || '')) ? String(raw.ref) : null;
  return {
    v: 1,
    id: String(raw.id || fallbackId || `ev-${at}-${Math.random().toString(36).slice(2, 8)}`).slice(0, 64),
    at: new Date(at).toISOString(),
    type,
    subject: normalizeSubject(raw.subject),
    source,
    ref,
    counts: normalizeCounts(raw.counts),
  };
}

function readEvents(dir) {
  const file = eventsFile(dir);
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const ev = normalizeEvent(JSON.parse(line));
      if (ev) out.push(ev);
    } catch {
      // 坏行跳过，不影响其余指标
    }
  }
  return out;
}

/**
 * 追加一条事件。带 ref 的事件按 (type, ref) 幂等，重复导入不会重复计数。
 * @returns {{ok:boolean, duplicate?:boolean, event?:object, file?:string}}
 */
function appendEvent(dir, raw, { now = () => new Date() } = {}) {
  const at = now();
  const existing = readEvents(dir);
  const event = normalizeEvent(raw, { fallbackAt: at.getTime(), fallbackId: `ev-${at.getTime()}-${String(existing.length + 1).padStart(4, '0')}` });
  if (!event) return { ok: false, reason: 'invalid-event' };
  if (event.ref) {
    const dup = existing.find((e) => e.type === event.type && e.ref === event.ref);
    if (dup) return { ok: true, duplicate: true, event: dup, file: eventsFile(dir) };
  }
  const root = metricsRoot(dir);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = eventsFile(dir);
  fs.writeFileSync(file, JSON.stringify(event) + '\n', { flag: 'a', mode: 0o600 });
  return { ok: true, event, file };
}

function recordExplanation(dir, subject, counts = {}, opts = {}) {
  return appendEvent(dir, { type: 'explanation', subject, source: opts.source || 'cli', ref: opts.ref || null, counts: { count: counts.count || 1, ...counts } }, opts);
}

function recordCorrection(dir, subject, counts = {}, opts = {}) {
  return appendEvent(dir, { type: 'correction', subject, source: opts.source || 'cli', ref: opts.ref || null, counts: { count: counts.count || 1, ...counts } }, opts);
}

function recordConfigSnapshot(dir, counts, opts = {}) {
  return appendEvent(dir, { type: 'config-snapshot', subject: 'config', source: opts.source || 'config-audit', ref: opts.ref || null, counts }, opts);
}

function recordCleanupProposal(dir, { proposalId, candidates, confirmed = 0, kind = 'project' }, opts = {}) {
  return appendEvent(dir, {
    type: 'cleanup-proposal',
    subject: kind === 'config' ? 'config-cleanup' : 'project-cleanup',
    source: opts.source || 'cleanup',
    ref: proposalId,
    counts: { candidates, confirmed, proposals: 1 },
  }, opts);
}

function recordCleanupExecute(dir, { proposalId, confirmed, removed = 0, moved = 0, failed = 0, kind = 'project' }, opts = {}) {
  return appendEvent(dir, {
    type: 'cleanup-execute',
    subject: kind === 'config' ? 'config-cleanup' : 'project-cleanup',
    source: opts.source || 'cleanup',
    ref: proposalId,
    counts: { confirmed, removed, moved, failed },
  }, opts);
}

function recordCleanupRestore(dir, { proposalId, restored = 0, kind = 'project' }, opts = {}) {
  const day = (opts.now ? opts.now() : new Date()).toISOString().slice(0, 10);
  return appendEvent(dir, {
    type: 'cleanup-restore',
    subject: kind === 'config' ? 'config-cleanup' : 'project-cleanup',
    source: opts.source || 'cleanup',
    ref: proposalId ? `${proposalId}:restore:${day}` : null,
    counts: { restored },
  }, opts);
}

module.exports = {
  TYPES,
  SUBJECT_RE,
  looksLikeSecret,
  normalizeSubject,
  normalizeEvent,
  readEvents,
  appendEvent,
  recordExplanation,
  recordCorrection,
  recordConfigSnapshot,
  recordCleanupProposal,
  recordCleanupExecute,
  recordCleanupRestore,
};
