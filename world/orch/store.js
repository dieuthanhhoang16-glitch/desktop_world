// world/orch/store.js
// desktop-world · tickets.json 的读写与工单状态推进（编排层的账本写入口）。
//
// 这是**唯一**会改写 tickets.json 的模块。字段语义：
//   { version, seq, tickets: [...] }
// seq 是已发到哪个序号（下一个 id 从 seq+1 起），避免每次重扫整表。
'use strict';

const fs = require('fs');
const path = require('path');
const { ticketsFile, STATUSES } = require('./paths');
const T = require('./tickets');

const VERSION = 1;

function emptyLedger() {
  return { version: VERSION, seq: 0, tickets: [] };
}

function load(file = ticketsFile()) {
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return emptyLedger();
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return emptyLedger();
  const tickets = Array.isArray(obj.tickets) ? obj.tickets.filter((t) => t && typeof t.id === 'string') : [];
  // seq 缺省时从现有 id 反推（老文件/手改文件都不该因此发重号）
  const seq = Number.isFinite(Number(obj.seq))
    ? Number(obj.seq)
    : tickets.reduce((acc, t) => Math.max(acc, T.seqOf(t.id)), 0);
  return { version: VERSION, seq, tickets };
}

function saveAll(file, ledger) {
  const tickets = (ledger && Array.isArray(ledger.tickets) ? ledger.tickets : []).slice();
  // 存盘前统一按 id 升序，保证文件内容与输入顺序无关（确定性）
  tickets.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const seq = tickets.reduce((acc, t) => Math.max(acc, T.seqOf(t.id)), 0);
  const out = { version: VERSION, seq, tickets };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2), { mode: 0o600 });
  return out;
}

/** 发号并写盘（一次原子化的"发号 + 落账"）。 */
function appendTickets(file, drafts = []) {
  const ledger = load(file);
  const tickets = ledger.tickets.slice();
  let seq = ledger.seq;
  const nextSeq = () => {
    if (seq >= T.MAX_SEQ) throw new Error(`工单序号已用尽（上限 ORCH-${T.MAX_SEQ}）`);
    seq += 1;
    return seq;
  };
  for (const draft of drafts) {
    const id = draft.id && /^ORCH-\d{3,}$/.test(draft.id) ? draft.id : T.formatId(nextSeq());
    // dependsOn 里的空串/非法项在这里挡掉：它们会让 checkBatch 报 dep-missing，
    // 把整批都卡住。属于"调用方算错了"，但落账是最后一道便宜的闸门。
    const dependsOn = Array.isArray(draft.dependsOn)
      ? draft.dependsOn.filter((d) => typeof d === 'string' && /^ORCH-\d{3,}$/.test(d))
      : [];
    tickets.push({ ...draft, id, dependsOn });
  }
  return saveAll(file, { tickets });
}

/** 改一张工单的字段（patch），不改 id。返回改后的工单。 */
function patchTicket(file, id, patch = {}) {
  const ledger = load(file);
  const idx = ledger.tickets.findIndex((t) => t.id === id);
  if (idx < 0) throw new Error(`找不到工单：${id}`);
  const next = { ...ledger.tickets[idx] };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'id') continue; // id 不可改
    next[k] = v;
  }
  ledger.tickets[idx] = next;
  saveAll(file, ledger);
  return next;
}

/**
 * 状态推进。非法迁移直接抛错 —— 编排层不"帮忙"把非法迁移变成合法。
 * @returns 改后的工单
 */
function setStatus(file, id, status) {
  if (!STATUSES.includes(status)) throw new Error(`非法状态：${status}`);
  const ledger = load(file);
  const ticket = ledger.tickets.find((t) => t.id === id);
  if (!ticket) throw new Error(`找不到工单：${id}`);
  if (!T.canTransition(ticket.status, status)) {
    throw new Error(`非法状态迁移：${ticket.status} → ${status}（${id}）`);
  }
  return patchTicket(file, id, { status });
}

function get(file, id) {
  return load(file).tickets.find((t) => t.id === id) || null;
}

function list(file) {
  return load(file).tickets;
}

/** 删除工单（只有 draft/confirmed 能删 —— 已派出去的工单是既成事实，不可撤）。 */
function remove(file, id) {
  const ledger = load(file);
  const ticket = ledger.tickets.find((t) => t.id === id);
  if (!ticket) return null;
  if (!T.isPreDispatch(ticket.status)) {
    throw new Error(`已派出的工单不可删除（${id} 当前 ${ticket.status}）：改派或标记 failed`);
  }
  ledger.tickets = ledger.tickets.filter((t) => t.id !== id);
  saveAll(file, ledger);
  return ticket;
}

module.exports = { VERSION, emptyLedger, load, saveAll, appendTickets, patchTicket, setStatus, get, list, remove };