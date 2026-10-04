// world/collector-codex.js
// desktop-world · Codex（OpenAI CLI）会话采集：只读 ~/.codex/sessions/**/*.jsonl。
// 转录格式比 Claude Code 演变快得多，解析策略是"宽进严出"：
// 任何一行坏了就跳过，任何字段缺失就用兜底 —— 宁可少统计，绝不让流水线断。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CODEX_SESSIONS_DIR = process.env.CODEX_SESSIONS_DIR || path.join(os.homedir(), '.codex', 'sessions');

// 深度受控地收集 jsonl 文件（session 目录按 年/月/日 组织，6 层足够）。
function walkJsonl(dir, out, depth) {
  if (depth > 8) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsonl(full, out, depth + 1);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
}

function extractUserText(payload) {
  if (!payload) return '';
  const content = payload.content;
  if (!Array.isArray(content)) return '';
  const text = content
    .filter((c) => c && (c.type === 'input_text' || c.type === 'text') && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
    .trim();
  // 注入的环境上下文/用户说明不算"人说的话"
  if (!text || text.startsWith('<')) return '';
  return text.replace(/\s+/g, ' ').slice(0, 200);
}

function parseCodexFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const s = {
    id: path.basename(filePath, '.jsonl'),
    cwd: null,
    prompts: [],
    toolCalls: 0,
    start: null,
    end: null,
  };
  for (const line of raw.split('\n')) {
    if (!line || line[0] !== '{') continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.timestamp) {
      const ts = new Date(ev.timestamp);
      if (!isNaN(ts)) {
        if (!s.start || ts < s.start) s.start = ts;
        if (!s.end || ts > s.end) s.end = ts;
      }
    }
    const payload = ev.payload || {};
    if (ev.type === 'session_meta') {
      if (!s.cwd && typeof payload.cwd === 'string' && payload.cwd) s.cwd = payload.cwd;
      continue;
    }
    // 事件类型演进很快：名字里带 call/tool 的都姑且算工具调用
    const ptype = typeof payload.type === 'string' ? payload.type : '';
    if (/(function_call|shell_call|tool_call|custom_tool)/i.test(ptype)) {
      s.toolCalls++;
      continue;
    }
    if (ptype === 'message' && payload.role === 'user') {
      const text = extractUserText(payload);
      if (text) {
        if (s.prompts.length < 8) s.prompts.push(text);
        else if (s.prompts.length === 8) s.prompts.push('…');
      }
    }
  }
  if (!s.start && !s.end) return null;
  if (s.prompts.length === 0 && s.toolCalls === 0) return null;
  return s;
}

/**
 * 采集 Codex 当日会话。
 * @returns {Array} 与 collector 主会话相同的条目结构 + agent:'codex'
 */
function collectCodex({ dir = CODEX_SESSIONS_DIR, todayStart, now, activeWindowMs }) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  walkJsonl(dir, files, 0);
  const sessions = [];
  for (const file of files) {
    let mtime;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < todayStart.getTime() - 24 * 3600 * 1000) continue;
    const s = parseCodexFile(file);
    if (!s || !s.end || s.end < todayStart) continue;

    sessions.push({
      project: s.cwd ? path.basename(s.cwd) : 'codex',
      title: s.prompts[0] ? s.prompts[0].slice(0, 80) : '(无文本输入)',
      firstPromptSample: s.prompts.slice(0, 3),
      promptCount: s.prompts.length >= 8 ? '8+' : s.prompts.length,
      toolCalls: s.toolCalls,
      topTools: [],
      durationMin: Math.max(1, Math.round((s.end - (s.start || s.end)) / 60000)),
      status: now - s.end < activeWindowMs ? '进行中' : '已完成',
      end: s.end.toISOString(),
      gitBranch: null,
      agent: 'codex',
    });
  }
  return sessions;
}

module.exports = { collectCodex, parseCodexFile, CODEX_SESSIONS_DIR };
