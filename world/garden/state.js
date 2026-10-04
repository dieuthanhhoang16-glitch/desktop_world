// world/garden/state.js
// desktop-world · 生长世界的持久化状态：跨天累计，随每日工作成果升级。
// 状态存 <outDir>/world-state.json，每日首次烘焙时结算一次（幂等，同日重跑不重复加分）。
'use strict';

const fs = require('fs');
const path = require('path');

// 成长阶段：xp 达到 minXp 即解锁（阶段设计即"会生长的桌面世界"的骨架）。
const STAGES = [
  { key: 'seed', name: '种子', icon: '🫘', minXp: 0 },
  { key: 'sprout', name: '新芽', icon: '🌱', minXp: 100 },
  { key: 'sapling', name: '树苗', icon: '🌿', minXp: 300 },
  { key: 'bloom', name: '开花树', icon: '🌸', minXp: 600 },
  { key: 'grove', name: '果林', icon: '🌳', minXp: 1000 },
  { key: 'wonder', name: '空中花园', icon: '🏰', minXp: 1500 },
];

const STATE_FILE = 'world-state.json';

function initialState(dateStr) {
  return {
    version: 1,
    bornAt: dateStr,
    lastDate: null, // 上次结算的日期（YYYY-MM-DD）
    daysActive: 0,
    streak: 0,
    bestStreak: 0,
    totalSessions: 0,
    totalToolCalls: 0,
    xp: 0,
    lastXp: 0, // 最近一次结算当日获得的 xp
  };
}

function loadState(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8'));
    if (!raw || raw.version !== 1) return null;
    return raw;
  } catch {
    return null;
  }
}

function saveState(dir, state) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify(state, null, 2));
}

// dateStr 的次日（本地时区；正午构造避开 DST 边界）。
function nextDateStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + 1, 12, 0, 0, 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

// 当日经验：出勤 30 分打底 + 会话/工具加成（都封顶，防单日爆肝失衡）。
function dailyAward(digest) {
  const t = (digest && digest.totals) || {};
  const sessions = Math.min(t.sessions || 0, 20);
  const toolCalls = Math.min(t.toolCalls || 0, 400);
  return Math.round(30 + sessions * 10 + toolCalls * 0.25);
}

/**
 * 每日烘焙时调用：把今日 digest 结算进世界状态。
 * 同一天重复调用是幂等的（lastDate 相同则不再加分）。
 * @returns {{state:object, gained:number, settled:boolean}} settled=今天是否真的新结算了一天
 */
function applyDailyReport(dir, digest, dateStr) {
  let state = loadState(dir);
  if (!state) state = initialState(dateStr);

  const gained = dailyAward(digest);
  if (state.lastDate === dateStr) return { state, gained: state.lastXp, settled: false };

  state.streak = state.lastDate && nextDateStr(state.lastDate) === dateStr ? state.streak + 1 : 1;
  state.bestStreak = Math.max(state.bestStreak, state.streak);
  state.daysActive += 1;
  state.totalSessions += (digest && digest.totals && digest.totals.sessions) || 0;
  state.totalToolCalls += (digest && digest.totals && digest.totals.toolCalls) || 0;
  state.xp += gained;
  state.lastXp = gained;
  state.lastDate = dateStr;
  saveState(dir, state);
  return { state, gained, settled: true };
}

// 状态 → 对外描述（模板/分享/场景渲染用的全部字段）。
function describe(state) {
  const s = state || initialState(null);
  let level = 0;
  for (let i = 0; i < STAGES.length; i++) if (s.xp >= STAGES[i].minXp) level = i;
  const stage = STAGES[level];
  const next = STAGES[level + 1] || null;
  return {
    level,
    xp: s.xp,
    stageKey: stage.key,
    stageName: stage.name,
    stageIcon: stage.icon,
    daysActive: s.daysActive,
    streak: s.streak,
    bestStreak: s.bestStreak,
    totalSessions: s.totalSessions,
    totalToolCalls: s.totalToolCalls,
    todayXp: s.lastXp,
    next: next ? { name: next.name, icon: next.icon, xp: next.minXp, remain: next.minXp - s.xp } : null,
  };
}

module.exports = { STAGES, STATE_FILE, initialState, loadState, saveState, nextDateStr, dailyAward, applyDailyReport, describe };
