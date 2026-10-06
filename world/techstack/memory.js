// world/techstack/memory.js
// desktop-world · 「项目记忆」聚合：给"模糊学习方向 → 具体关键词"的收敛对话提供上下文。
// 来源：watch.json 已登记专案 + 最近 N 天日报（daily-*.json）的项目/标题/工具分布
// + 历史 tips/blockers 主题。纯读盘、坏文件跳过、纯 Node 可单测。
'use strict';

const fs = require('fs');
const path = require('path');

const REPORT_RE = /^daily-\d{4}-\d{2}-\d{2}\.json$/;

// 把 tips/blockers 条目规范成一行文字：兼容旧的字符串形态与新的结构化形态
function tipLine(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object') return item.topic || item.answer || '';
  return '';
}

/**
 * @param {object} opts
 * @param {string} [opts.outDir]  日报所在目录（App: userData/world；CLI: world/out）
 * @param {number} [opts.days]    回看天数，默认 7
 * @param {string} [opts.watchFile] watch.json 路径覆盖
 * @returns {{projects:Array, tools:Array, titles:string[], tips:string[], blockers:string[], watch:Array, reportDays:number}}
 */
function buildMemory({ outDir, days = 7, watchFile } = {}) {
  const watch = watchFile === null ? { folders: [] } : require('../watch/config').loadWatch(watchFile);

  const memory = { projects: [], tools: [], titles: [], tips: [], blockers: [], watch: watch.folders || [], reportDays: 0 };
  if (outDir) {
    let files = [];
    try {
      files = fs.readdirSync(outDir).filter((f) => REPORT_RE.test(f)).sort().slice(-days);
    } catch {
      files = [];
    }
    const projCount = new Map();
    const toolCount = new Map();
    for (const f of files) {
      let report = null;
      try {
        report = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'));
      } catch {
        continue;
      }
      const digest = report && report.digest;
      if (!digest) continue;
      memory.reportDays++;
      for (const p of digest.projects || []) {
        if (p && p.name) projCount.set(p.name, (projCount.get(p.name) || 0) + (p.sessions || 1));
      }
      for (const t of digest.topTools || []) {
        const name = typeof t === 'string' ? t : t && t.name;
        const n = typeof t === 'object' && t ? t.count || 1 : 1;
        if (name) toolCount.set(name, (toolCount.get(name) || 0) + n);
      }
      for (const s of digest.sessions || []) {
        if (s && s.title) memory.titles.push(String(s.title).slice(0, 80));
      }
      for (const x of report.techTips || []) {
        const line = tipLine(x);
        if (line) memory.tips.push(line);
      }
      for (const x of report.blockers || []) {
        const line = tipLine(x);
        if (line) memory.blockers.push(line);
      }
    }
    memory.projects = [...projCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, n]) => ({ name, count: n }));
    memory.tools = [...toolCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, n]) => ({ name, count: n }));
    memory.titles = memory.titles.slice(-30); // 最近的新，旧的标题热度让位
  }
  return memory;
}

module.exports = { buildMemory, tipLine };
