// world/orch/mailbox.js
// desktop-world · 每 session 一个收件箱（Envelope 的落点）。
//
// 对象模型借鉴 munder-difflin 的 inbox/outbox + router（不抄代码），但收件箱的 key 是
// **本仓库 session snapshot 里的 sessionId** —— 也就是 src/state.js 已经观察到的真实
// coding agent 会话。工单被"投递"只是写进这个文件，编排层**没有任何能力**让那个
// agent 进程自己拉起、自己读文件、或自己执行命令：agent 只在用户自己开的会话里
// 干活时，人自己决定看不看这个收件箱。
//
// 语义边界：收件箱只追加（append-only）。已投递的 envelope 不可改、不可删；
// 状态推进（unread → read）用独立的 ack 列表表达，不动原信封正文。
//
// 存储 <orchDir>/mailbox/<sanitized-sessionId>.json：{ sessionId, envelopes, acked }
'use strict';

const fs = require('fs');
const path = require('path');
const { mailboxFile, sanitizeSessionId } = require('./paths');

const MAX_ENVELOPES = 200;
const KINDS = new Set(['ticket', 'note', 'question', 'answer', 'cancellation']);

// envelope 正文是工单标题/验收标准等自由文本。与黑板同理：换行能伪造结构，必须收掉。
function sanitizeText(value, max = 400) {
  return String(value == null ? '' : value)
    .replace(/\r\n?|\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function fileFor(sessionId, root) {
  return mailboxFile(sessionId, root);
}

function normalizeEnvelope(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const body = sanitizeText(raw.body);
  if (!body) return null;
  return {
    id: sanitizeText(raw.id, 40),
    at: Number.isFinite(Number(raw.at)) ? Number(raw.at) : 0,
    kind: KINDS.has(raw.kind) ? raw.kind : 'note',
    from: sanitizeText(raw.from, 60) || 'orchestrator',
    to: sanitizeText(raw.to, 120),
    ticketId: /^ORCH-\d{3,}$/.test(String(raw.ticketId || '')) ? raw.ticketId : '',
    // body 必须落在返回对象里：漏掉它会让 saveAll 写出一个没有正文的信封，
    // 而 load 时又因为 body 空被判成 null —— 表现为"投递成功但收件箱是空的"。
    body,
    // 验收标准逐条存（数组），UI 能逐条勾；非法项丢掉而不是留 undefined
    acceptance: Array.isArray(raw.acceptance)
      ? raw.acceptance.map((a) => sanitizeText(a, 200)).filter(Boolean)
      : [],
  };
}

function emptyMailbox(sessionId) {
  return { sessionId: sanitizeSessionId(sessionId), envelopes: [], acked: [] };
}

function load(sessionId, root) {
  const file = fileFor(sessionId, root);
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return emptyMailbox(sessionId);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return emptyMailbox(sessionId);
  return {
    sessionId: sanitizeSessionId(obj.sessionId || sessionId),
    envelopes: Array.isArray(obj.envelopes) ? obj.envelopes.map(normalizeEnvelope).filter(Boolean) : [],
    acked: Array.isArray(obj.acked) ? obj.acked.map((x) => sanitizeText(x, 40)).filter(Boolean) : [],
  };
}

function saveAll(sessionId, root, all) {
  const file = fileFor(sessionId, root);
  const envelopes = (all && Array.isArray(all.envelopes) ? all.envelopes : [])
    .map(normalizeEnvelope)
    .filter(Boolean)
    .slice(-MAX_ENVELOPES);
  const acked = [...new Set((all && Array.isArray(all.acked) ? all.acked : []).map((x) => sanitizeText(x, 40)).filter(Boolean))];
  const out = { sessionId: sanitizeSessionId(sessionId), envelopes, acked };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2), { mode: 0o600 });
  return out;
}

/**
 * 投递一封信（append-only）。同 id 幂等：重复投递同一封不算两封。
 * @param sessionId 目标 session（来自 session snapshot）
 * @param envelope {id, kind, from, to, ticketId, body, acceptance, at}
 */
function deliver(sessionId, envelope, root) {
  const box = load(sessionId, root);
  const id = sanitizeText(envelope && envelope.id, 40) || `env-${box.envelopes.length + 1}`;
  if (box.envelopes.some((e) => e.id === id)) return box; // 幂等
  const normalized = normalizeEnvelope({
    ...(envelope || {}),
    id,
    at: Number.isFinite(Number(envelope && envelope.at)) ? Number(envelope.at) : Date.now(),
    to: sanitizeSessionId(sessionId),
  });
  if (!normalized) throw new Error('envelope 必须有 body');
  box.envelopes.push(normalized);
  return saveAll(sessionId, root, box);
}

/** 批量投递（同一次派发的多张工单合成一次写盘）。 */
function deliverMany(sessionId, envelopes = [], root) {
  const box = load(sessionId, root);
  const at = Date.now();
  let added = 0;
  (envelopes || []).forEach((e, i) => {
    const id = sanitizeText(e && e.id, 40) || `env-${box.envelopes.length + i + 1}`;
    if (box.envelopes.some((x) => x.id === id)) return;
    const normalized = normalizeEnvelope({
      ...(e || {}),
      id,
      at: Number.isFinite(Number(e && e.at)) ? Number(e.at) : at + i,
      to: sanitizeSessionId(sessionId),
    });
    if (!normalized) return;
    box.envelopes.push(normalized);
    added += 1;
  });
  if (!added) return box;
  return saveAll(sessionId, root, box);
}

/** 倒序列出（最新在前），给 UI。 */
function list(sessionId, { root, unreadOnly = false, ticketId = '' } = {}) {
  const box = load(sessionId, root);
  const acked = new Set(box.acked);
  let out = box.envelopes.slice().reverse();
  if (unreadOnly) out = out.filter((e) => !acked.has(e.id));
  if (ticketId) out = out.filter((e) => e.ticketId === ticketId);
  return out;
}

function unreadCount(sessionId, root) {
  const box = load(sessionId, root);
  const acked = new Set(box.acked);
  return box.envelopes.filter((e) => !acked.has(e.id)).length;
}

/** 标记已读（只动 ack 列表，正文永不动）。 */
function ack(sessionId, envelopeIds, root) {
  const box = load(sessionId, root);
  const ids = Array.isArray(envelopeIds) ? envelopeIds : [envelopeIds];
  for (const id of ids) {
    const clean = sanitizeText(id, 40);
    if (clean && !box.acked.includes(clean)) box.acked.push(clean);
  }
  return saveAll(sessionId, root, box);
}

module.exports = {
  MAX_ENVELOPES,
  KINDS,
  sanitizeText,
  fileFor,
  emptyMailbox,
  normalizeEnvelope,
  load,
  saveAll,
  deliver,
  deliverMany,
  list,
  unreadCount,
  ack,
};