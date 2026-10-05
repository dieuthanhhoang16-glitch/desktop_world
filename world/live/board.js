// world/live/board.js
// desktop-world · 动态桌面看板「隐藏这条」的持久化（纯模块，可单测）。
// 隐藏 ≠ 删除原始会话记录——只是把这张卡片从今天起（含后续刷新）从看板上拿掉；
// 按天归档（键 YYYY-MM-DD），值是稳定的会话键 "agent:id"。文件 0600。
'use strict';

const fs = require('fs');
const path = require('path');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SID_RE = /^[\w:.#-]{1,200}$/; // agent:uuid / agent#哈希 都算；宽松但不接受路径符

function load(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

function saveAll(file, all) {
  // 只留最近 30 天的隐藏清单
  const keys = Object.keys(all).filter((k) => (all[k] || []).length).sort();
  const keep = {};
  for (const k of keys.slice(-30)) keep[k] = all[k];
  if (!Object.keys(keep).length) {
    try { fs.unlinkSync(file); } catch { /* 没文件就算了 */ }
    return keep;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(keep, null, 2), { mode: 0o600 });
  return keep;
}

function list(file, date) {
  if (!DATE_RE.test(String(date || ''))) return [];
  return load(file)[date] || [];
}

function hide(file, date, sid) {
  if (!DATE_RE.test(String(date || ''))) throw new Error(`非法日期键：${date}`);
  if (!SID_RE.test(String(sid || ''))) throw new Error(`非法会话键：${sid}`);
  const all = load(file);
  const cur = new Set(all[date] || []);
  cur.add(sid);
  all[date] = [...cur];
  saveAll(file, all);
  return all[date];
}

function unhideAll(file, date) {
  if (!DATE_RE.test(String(date || ''))) throw new Error(`非法日期键：${date}`);
  const all = load(file);
  delete all[date];
  saveAll(file, all);
  return [];
}

/** 会话对象的稳定键；id 缺失（老数据/异常）时退回 project|title|end 的短哈希，不至于整列不能隐藏 */
function sidOf(session) {
  const head = `${session.agent || 'claude'}`;
  if (session.id) return `${head}:${session.id}`;
  const crypto = require('crypto');
  const raw = `${session.project || ''}|${session.title || ''}|${session.end || ''}`;
  return `${head}#${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16)}`;
}

/** 给 digest.sessions 标 s._sid（模板隐藏按钮的 data 键）和 s.hidden */
function annotateHidden(sessions, hiddenList) {
  const set = new Set(hiddenList || []);
  for (const s of sessions || []) {
    const sid = sidOf(s);
    s._sid = sid;
    s.hidden = set.has(sid);
  }
}

module.exports = { load, list, hide, unhideAll, sidOf, annotateHidden };
