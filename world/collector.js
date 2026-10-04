// world/collector.js
// desktop-world · 采集本地 Claude Code 当日会话活动 → 今日工作 digest。
// 只读 ~/.claude/projects，绝不写入用户数据目录之外的任何地方。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { collectCodex, CODEX_SESSIONS_DIR } = require('./collector-codex');

const PROJECTS_DIR =
  process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');

// 45 分钟内有动静的会话视为"进行中"（看板第一列）。
const ACTIVE_WINDOW_MS = 45 * 60 * 1000;

const ZH_WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// 本地时区日期串（toISOString 是 UTC，跨时区会让"今日早报"日期错一天）。
function localDateStr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
  }
  return '';
}

function isToolResultOnly(content) {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((c) => c && (c.type === 'tool_result' || c.type === 'tool_use'))
  );
}

// 解析单个会话 jsonl 转录文件；无实质内容时返回 null。
function parseSessionFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const s = {
    id: path.basename(filePath, '.jsonl'),
    cwd: null,
    project: path.basename(path.dirname(filePath)), // 兜底：项目目录 slug
    prompts: [], // 用户真实输入（已限长）
    tools: {}, // 工具名 → 次数
    toolCalls: 0,
    start: null,
    end: null,
    gitBranch: null,
    hours: new Array(24).fill(0), // 活跃小时直方图
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
        if (ev.type === 'user' || ev.type === 'assistant') s.hours[ts.getHours()]++;
      }
    }
    if (!s.cwd && typeof ev.cwd === 'string' && ev.cwd) {
      s.cwd = ev.cwd;
      s.project = path.basename(ev.cwd);
    }
    if (!s.gitBranch && typeof ev.gitBranch === 'string') s.gitBranch = ev.gitBranch;
    const msg = ev.message;
    if (!msg) continue;
    if (ev.type === 'user' && msg.role === 'user') {
      const text = extractText(msg.content).trim();
      // 过滤纯工具回执与 hook/XML 包装的系统注入，只留人写的 prompt
      if (text && !isToolResultOnly(msg.content) && !text.startsWith('<')) {
        if (s.prompts.length < 8) s.prompts.push(text.replace(/\s+/g, ' ').slice(0, 200));
        else if (s.prompts.length === 8) s.prompts.push('…');
      }
    } else if (ev.type === 'assistant' && Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (c && c.type === 'tool_use' && c.name) {
          s.tools[c.name] = (s.tools[c.name] || 0) + 1;
          s.toolCalls++;
        }
      }
    }
  }
  if (s.prompts.length === 0 && s.toolCalls === 0) return null;
  if (!s.end) s.end = new Date(fs.statSync(filePath).mtimeMs);
  if (!s.start) s.start = s.end;
  return s;
}

function topEntries(obj, n) {
  return Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => ({ name, count }));
}

/**
 * 采集今日 digest。
 * @returns {Promise<object>} digest（见 world/README.md 的结构说明）
 */
async function collect(options = {}) {
  const projectsDir = options.projectsDir || PROJECTS_DIR;
  const todayStart = new Date(options.now || Date.now());
  todayStart.setHours(0, 0, 0, 0);
  const now = new Date();

  const digest = {
    date: localDateStr(now),
    weekday: ZH_WEEKDAYS[now.getDay()],
    generatedAt: now.toISOString(),
    source: 'claude-code',
    totals: { sessions: 0, prompts: 0, toolCalls: 0 },
    agents: [], // e.g. [{agent:'claude-code',sessions:3},{agent:'codex',sessions:1}]
    topTools: [],
    projects: [],
    hours: new Array(24).fill(0),
    sessions: [], // 进行中在前，其余按结束时间倒序
    note: projectsDir === PROJECTS_DIR ? null : `custom dir: ${projectsDir}`,
  };

  let files = [];
  try {
    for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(projectsDir, entry.name);
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.jsonl')) files.push(path.join(dir, f));
      }
    }
  } catch {
    digest.note = `无法读取 ${projectsDir}`;
    return digest; // 空 digest，上层走"安静的一天"分支
  }

  const projectSessions = new Map(); // 项目名 → 会话数
  const globalTools = {};
  for (const file of files) {
    let mtime;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < todayStart.getTime() - 24 * 3600 * 1000) continue; // 粗筛：昨天的也解析，靠事件时间精判
    const s = parseSessionFile(file);
    if (!s || !s.end || s.end < todayStart) continue; // 精判：最后一个事件必须在今天

    const isActive = now - s.end < ACTIVE_WINDOW_MS;
    const topTools = topEntries(s.tools, 3);
    digest.sessions.push({
      project: s.project,
      cwd: s.cwd, // 完整路径：world/watch 专案追踪按它匹配
      title: s.prompts[0] ? s.prompts[0].slice(0, 80) : '(无文本输入)',
      firstPromptSample: s.prompts.slice(0, 3),
      promptCount: s.prompts.length >= 8 ? '8+' : s.prompts.length,
      toolCalls: s.toolCalls,
      topTools,
      durationMin: Math.max(1, Math.round((s.end - s.start) / 60000)),
      status: isActive ? '进行中' : '已完成',
      end: s.end.toISOString(),
      gitBranch: s.gitBranch,
      agent: 'claude',
    });
    digest.totals.prompts += s.prompts.length;
    digest.totals.toolCalls += s.toolCalls;
    for (let h = 0; h < 24; h++) digest.hours[h] += s.hours[h];
    for (const [k, v] of Object.entries(s.tools)) globalTools[k] = (globalTools[k] || 0) + v;
    projectSessions.set(s.project, (projectSessions.get(s.project) || 0) + 1);
  }

  // —— 多 agent：Codex 会话合并进同一份 digest（options.codex === false 可关闭）——
  const claudeSessions = digest.sessions.length;
  digest.agents = [{ agent: 'claude-code', sessions: claudeSessions }];
  if (options.codex !== false) {
    const codexDir = options.codexDir || CODEX_SESSIONS_DIR;
    const cx = collectCodex({ dir: codexDir, todayStart, now, activeWindowMs: ACTIVE_WINDOW_MS });
    for (const session of cx) {
      digest.sessions.push(session);
      digest.totals.prompts += typeof session.promptCount === 'number' ? session.promptCount : 8;
      digest.totals.toolCalls += session.toolCalls;
      projectSessions.set(session.project, (projectSessions.get(session.project) || 0) + 1);
    }
    if (cx.length) digest.agents.push({ agent: 'codex', sessions: cx.length });
  }

  digest.sessions.sort((a, b) => {
    if ((a.status === '进行中') !== (b.status === '进行中')) return a.status === '进行中' ? -1 : 1;
    return b.end.localeCompare(a.end);
  });
  digest.totals.sessions = digest.sessions.length;
  digest.topTools = topEntries(globalTools, 6);
  digest.projects = [...projectSessions.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, sessions]) => ({ name, sessions }));
  return digest;
}

// 直接运行：node world/collector.js  → 打印 digest 概览
if (require.main === module) {
  collect()
    .then((d) => {
      console.log(JSON.stringify({ ...d, sessions: d.sessions.map((x) => ({ ...x, firstPromptSample: undefined })) }, null, 2));
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

module.exports = { collect };
