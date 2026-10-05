// world/live/notes.js
// desktop-world · 动态桌面「随手记」存储（纯模块，可单测）。
// 每个自然日一条，键为 YYYY-MM-DD；文件 0600，只进 live 窗口，绝不进烘焙壁纸。
'use strict';

const fs = require('fs');
const path = require('path');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LEN = 4000; // 备注是便签不是文档，限定上限防误贴一大坨

function load(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

function get(file, date) {
  return String(load(file)[date] || '');
}

function save(file, date, text) {
  if (!DATE_RE.test(String(date || ''))) throw new Error(`非法日期键：${date}`);
  const all = load(file);
  const clean = String(text == null ? '' : text).replace(/\r\n?/g, '\n').slice(0, MAX_LEN);
  if (clean.trim()) all[date] = clean;
  else delete all[date];
  // 只留最近 60 天的，免得无限长胖
  const keys = Object.keys(all).sort();
  if (keys.length > 60) keys.slice(0, keys.length - 60).forEach((k) => delete all[k]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(all, null, 2), { mode: 0o600 });
  return all[date] || '';
}

module.exports = { load, get, save, MAX_LEN };
