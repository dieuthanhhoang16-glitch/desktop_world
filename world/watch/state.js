// world/watch/state.js
// desktop-world · 专案追踪的持久化进度：每个被 watch 的文件夹累计
// 天数 / 连击 / 总会话 / 14 天活动柱图。与 garden 同一套结算范式：
// 按天结算、同日幂等（重复烘焙刷新"今天"的计数而不重复累计）。
'use strict';

const fs = require('fs');
const path = require('path');
const { nextDateStr } = require('../garden/state');
const { resolveWatch } = require('./config');

const WATCH_STATE_FILE = 'watch-state.json';
const HISTORY_DAYS = 14;

function statePath(dir) {
  return path.join(dir, WATCH_STATE_FILE);
}
function loadWatchState(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(dir), 'utf8'));
    return raw && raw.version === 1 && raw.folders ? raw : null;
  } catch {
    return null;
  }
}
function saveWatchState(dir, state) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statePath(dir), JSON.stringify(state, null, 2));
}

/** 给 digest.sessions 就地标注 category/watchName，返回分类 → 会话数 汇总。 */
function annotateSessions(digest, folders) {
  const tallies = new Map();
  for (const s of digest.sessions || []) {
    const hit = resolveWatch(folders, s.cwd || s.project);
    if (!hit) continue;
    s.category = hit.category;
    s.watchName = hit.watchName;
    tallies.set(hit.category, (tallies.get(hit.category) || 0) + 1);
  }
  return tallies;
}

/**
 * 每日结算（幂等）。folders = config.folders；digest.sessions 需已带 cwd。
 */
function settle(dir, folders, digest, dateStr) {
  const state = loadWatchState(dir) || { version: 1, folders: {} };
  for (const folder of folders) {
    const daySessions = (digest.sessions || []).filter((s) => {
      const hit = resolveWatch([folder], s.cwd || '');
      return !!hit;
    });
    const today = daySessions.length;
    const todayTools = daySessions.reduce((n, s) => n + (s.toolCalls || 0), 0);

    let entry = state.folders[folder.name];
    if (!entry) {
      if (!today) continue; // 还没动工的专案暂不建档
      entry = state.folders[folder.name] = {
        path: folder.path,
        category: folder.category,
        firstSeen: dateStr,
        lastActiveDate: null,
        lastSettled: null,
        days: 0,
        streak: 0,
        bestStreak: 0,
        totalSessions: 0,
        totalToolCalls: 0,
        history: [],
      };
    }
    entry.path = folder.path; // 配置可能改过路径
    entry.category = folder.category;

    if (entry.lastSettled === dateStr) {
      const last = entry.history[entry.history.length - 1];
      const countedToday = last && last[0] === dateStr;
      if (today === 0 || countedToday) {
        // 同日重复：只刷新今天的计数，不重复累计
        if (today > 0 && countedToday) last[1] = today;
        continue;
      }
      // 同日升级：早上结算时 0 会话、之后才开始动 → 仍按"新的一天"结算
    }
    entry.lastSettled = dateStr;
    if (!today) continue; // 今天没动：连击冻结（不清零），等动工那天自然结算

    entry.streak = entry.lastActiveDate && nextDateStr(entry.lastActiveDate) === dateStr ? entry.streak + 1 : 1;
    entry.bestStreak = Math.max(entry.bestStreak, entry.streak);
    entry.days += 1;
    entry.totalSessions += today;
    entry.totalToolCalls += todayTools;
    entry.history.push([dateStr, today]);
    if (entry.history.length > HISTORY_DAYS) entry.history = entry.history.slice(-HISTORY_DAYS);
    entry.lastActiveDate = dateStr;
  }
  saveWatchState(dir, state);
  return state;
}

/**
 * 对外视图：config 顺序 × state 数据 + 今日实况 + 分类汇总。
 */
function buildView(folders, state, digest, dateStr) {
  const list = folders.map((folder) => {
    const entry = (state && state.folders[folder.name]) || null;
    const daySessions = (digest.sessions || []).filter((s) => s.watchName === folder.name);
    const hist = (entry && entry.history) || [];
    return {
      name: folder.name,
      category: folder.category,
      today: daySessions.length,
      todayToolCalls: daySessions.reduce((n, s) => n + (s.toolCalls || 0), 0),
      days: entry ? entry.days : 0,
      streak: entry ? entry.streak : 0,
      bestStreak: entry ? entry.bestStreak : 0,
      totalSessions: entry ? entry.totalSessions : 0,
      totalToolCalls: entry ? entry.totalToolCalls : 0,
      started: entry ? entry.firstSeen : null,
      history: hist,
      spark: hist.map(([, n]) => n), // 柱图数据（≤14）
    };
  });
  const categories = {};
  for (const s of digest.sessions || []) {
    if (!s.category) continue;
    categories[s.category] = (categories[s.category] || 0) + 1;
  }
  return { active: true, date: dateStr, list, categories };
}

/**
 * pipeline 入口：加载配置 → 标注会话 → 结算 → 生成视图。未配置时 active:false。
 */
function prepareWatch(outDir, digest, dateStr) {
  const { loadWatch } = require('./config');
  const cfg = loadWatch();
  if (!cfg.folders.length) return { active: false, list: [], categories: null };
  annotateSessions(digest, cfg.folders);
  const state = settle(outDir, cfg.folders, digest, dateStr);
  return buildView(cfg.folders, state, digest, dateStr);
}

module.exports = {
  WATCH_STATE_FILE,
  HISTORY_DAYS,
  loadWatchState,
  saveWatchState,
  annotateSessions,
  settle,
  buildView,
  prepareWatch,
};
