// world/study/index.js
// desktop-world · 学习卡片读写主入口（IO 层；纯逻辑都在 card.js / scanner.js 里）。
//
// 补的是 v0.6.5 断掉的那一环：关键词收敛后只写 techstack.json，链路上没有任何 writer，
// 于是"配了关键词却从没生成过学习md"。本模块给每个关键词建一张长期累积的卡片，
// 并把日报里的八股考点按关键词回填进去（追加，永不覆盖）。
//
// 目录选择（有意为之，不是偷懒）：
//   卡片落~/.desktop-world/study/，**不跟 outDir**。outDir 在 App 里是
//   app.getPath('userData')/world，在 CLI 里是仓库 world/out —— 两处路径不同，
//   跟outDir 会导致 App 跑的卡片和 CLI 跑的卡片不在同一处，--sync 也补不上 App 那份。
//   live.json / techstack.json / channels.json 已都在 ~/.desktop-world/ 下，学习卡片与它们同源。
//   WORLD_STUDY_DIR 可覆盖路径（单测与便携场景）。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const card = require('./card');
const scanner = require('./scanner');
const { loadTechstack } = require('../techstack/config');

const CONFIG_DIR = path.join(os.homedir(), '.desktop-world');
const STUDY_DIR = process.env.WORLD_STUDY_DIR || path.join(CONFIG_DIR, 'study');
const INDEX_FILE = 'index.md';
const MAX_LIST = 200;

// 目录名只允许 ASCII 安全字符：目标方向是用户输入的中文，不能直接当目录名（各平台限制不一）
function goalSlug(goal) {
  const base = String(goal.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  return base || 'goal';
}

// 卡片文件名 = 稳定 keyword id。绝不用中文标题（改标题会丢历史）。
// 兜底扫目录：老卡片若没有对应的 id 文件（例如中途换过算法），按标题前缀找回它的正文。
function cardPath(root, goal, keyword) {
  return path.join(root, goalSlug(goal), `${(goal.kwIds && goal.kwIds[keyword]) || 'kw-unmapped'}.md`);
}

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function writeFileSafe(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o600 });
}

/** 一张卡片在磁盘上的状态（用于 index 与 UI 列表） */
function inspectCard(root, goal, keyword, date) {
  const file = cardPath(root, goal, keyword);
  const body = readFileSafe(file);
  const exists = body.length > 0;
  const days = card.countEvidenceDays(body);
  const hitDates = [...days].sort();  return {
    goalId: goal.id,
    direction: goal.direction,
    keyword,
    kwId: (goal.kwIds && goal.kwIds[keyword]) || null,
    file: exists ? file : null,
    exists,
    status: exists ? card.deriveStatus(body) : card.STATUS.pending,
    hitDays: hitDates,
    dayCount: hitDates.length,
    lastHit: hitDates.length ? hitDates[hitDates.length - 1] : null,
    date: date || '',
  };
}

/**
 * 列出全部目标 × 关键词 × 卡片状态。没配 techstack 时返回空数组（调用方据此整段静默）。
 */
function listCards({ root = STUDY_DIR, goals } = {}) {
  const gs = goals || loadTechstack().goals;
  const out = [];
  for (const g of gs) {
    for (const keyword of g.keywords || []) {
      out.push(inspectCard(root, g, keyword));
    }
    if (out.length >= MAX_LIST) break;
  }
  return out.slice(0, MAX_LIST);
}

/**
 * 把某一天的实证追加进对应卡片。**同日幂等**：card.appendEvidence 见到当天分节就返回 null。
 * @returns {{written:string[], skipped:string[], created:string[], unmatched:number}}
 */
function appendDay(goals, { date, tips, sourceFile, root = STUDY_DIR } = {}) {
  const result = { written: [], skipped: [], created: [], unmatched: 0 };
  if (!card.isValidDate(date)) return result;
  const list = Array.isArray(tips) ? tips : [];

  for (const g of goals) {
    for (const keyword of g.keywords || []) {
      const hits = list.filter((t) => scanner.tipMatchesKeyword(keyword, scanner.normalizeTip(t) || {}));
      const normalized = hits.map(scanner.normalizeTip).filter(Boolean);
      if (!normalized.length) {
        result.unmatched += list.length ? 1 : 0;
        continue;
      }
      const file = cardPath(root, g, keyword);
      let body = readFileSafe(file);
      const isNew = !body.trim();
      if (isNew) {
        body = card.renderNewCard({
          keyword,
          direction: g.direction,
          kwId: (g.kwIds && g.kwIds[keyword]) || null,
          date,
          sourceFile,
        });
      }
      const next = card.appendEvidence(body, { date, tips: normalized, sourceFile });
      if (next === null) {
        result.skipped.push(keyword);
        continue;
      }
      writeFileSafe(file, next);
      result.written.push(file);
      if (isNew) result.created.push(file);
    }
  }
  return result;
}

/**
 * 为所有还没有卡片的关键词建档（写「空白区」）。
 * 这是修「配了关键词却什么都没看到」的关键：没材料也要有一张卡，明确告知还在等。
 * @returns {{created:string[], existed:string[]}}
 */
function ensureCards(goals, { date, root = STUDY_DIR, sourceFile = '日报' } = {}) {
  const result = { created: [], existed: [] };
  const today = card.isValidDate(date) ? date : null;
  for (const g of goals) {
    for (const keyword of g.keywords || []) {
      const file = cardPath(root, g, keyword);
      if (readFileSafe(file).trim()) {
        result.existed.push(keyword);
        continue;
      }
      writeFileSafe(
        file,
        card.renderNewCard({
          keyword,
          direction: g.direction,
          kwId: (g.kwIds && g.kwIds[keyword]) || null,
          date: today || '',
          sourceFile,
        }),
      );
      result.created.push(file);
    }
  }
  return result;
}

/** 总览 index.md：所有目标 × 关键词 × 进度 × 最近更新 */
function renderIndex(entries) {
  const lines = ['# 学习卡片总览', ''];
  if (!entries.length) {
    lines.push('_还没有定向学习目标。_', '', '配置方式见 `world/README.md` 的「定向学习」一节。', '');
    return lines.join('\n');
  }
  const byGoal = new Map();
  for (const e of entries) {
    if (!byGoal.has(e.goalId)) byGoal.set(e.goalId, { direction: e.direction, items: [] });
    byGoal.get(e.goalId).items.push(e);
  }
  const ICON = { 待补料: '🧩', 学习中: '📌', 已沉淀: '🌳' };
  for (const [, group] of byGoal) {
    lines.push(`## 🎯 ${group.direction}`, '');
    lines.push('| 状态 | 关键词 | 实证天数 | 最近命中 |', '|---|---|---|---|');
    for (const e of group.items) {
      const days = e.dayCount ? `${e.dayCount} 天` : '—';
      const last = e.lastHit || '—';
      const mark = ICON[e.status] || '·';
      lines.push(`| ${mark} ${e.status} | ${e.keyword} | ${days} | ${last} |`);
    }
    lines.push('');
  }
  lines.push('---', '_由 Desktop World 学习卡片生成。每个关键词一张卡，只追加不覆盖。_', '');
  return lines.join('\n');
}

/** 写总览。返回文件路径。 */
function writeIndex({ root = STUDY_DIR, goals } = {}) {
  const entries = listCards({ root, goals });
  const file = path.join(root, INDEX_FILE);
  writeFileSafe(file, renderIndex(entries));
  return { file, count: entries.length };
}

/**
 * 日报流水线的接入点：把当天 techTips 回填进卡片 + 补齐还没有卡片的关键词。
 * 未配置 techstack 时**零副作用**（不建目录、不写文件）。
 * @returns {null|{cards:Array, written:string[], created:string[], unmatched:number, indexFile:string}}
 * @param {Array} [opts.goals] 显式传入已加载的目标（pipeline 已 loadTechstack 过一次，
 *   传进来可省一次读盘；也便于单测注入）
 */
function scanAndAppend(report, { root = STUDY_DIR, ensure = true, goals: injected } = {}) {
  const goals = injected || loadTechstack().goals;
  if (!goals.length) return null; // 没配目标：老用户行为一个字符不变
  const date = report && report.meta && report.meta.date;
  if (!card.isValidDate(date)) return null;

  const sourceFile = `tips-${date}.md`;
  let written = [];
  let created = [];
  if (ensure) created = ensureCards(goals, { date, root, sourceFile }).created;
  const appended = appendDay(goals, { date, tips: report.techTips, sourceFile, root });
  written = appended.written;
  const { file: indexFile } = writeIndex({ root, goals });

  return {
    cards: listCards({ root, goals }),
    written,
    created,
    unmatched: appended.unmatched,
    indexFile,
  };
}

/**
 * 补历史欠账：扫最近 N 天日报，把还没进卡片的考点回填。
 * 单向、幂等——已经进去的（当天分节存在）会被card.appendEvidence 挡掉。
 */
function syncRecent({ days = 7, root = STUDY_DIR, goals: injected, outDirs } = {}) {
  const goals = injected || loadTechstack().goals;
  if (!goals.length) return { goals: 0, days: [], written: [], created: [] };
  // 先补齐所有卡片骨架（含历史里没命中的关键词），再回填。
  // 建档日期用本地今天：--sync 是"现在补"，首次收录日应该是当天而不是留空。
  const created = ensureCards(goals, { date: localToday() }).created;
  const written = [];
  const seenDays = [];

  for (const dir of outDirs || resolveOutDirs()) {
    let files = [];
    try {
      // 按日期窗口筛，而不是"最后 N 个文件"：目录里若有一份很旧的日报（比如跨年残留），
      // 数量切片会把它当最近的收进来，把真正的近 N 天挤掉。--days 的语义是"最近 N 天"。
      const all = fs
        .readdirSync(dir)
        .map((f) => ({ f, d: scanner.REPORT_RE.exec(f) }))
        .filter((x) => x.d)
        .sort((a, b) => a.d[1].localeCompare(b.d[1]));
      files = pickRecentByDay(all.map((x) => ({ f: x.f, date: x.d[1] })), days);
    } catch {
      continue;
    }
    for (const { f, date: fileDate } of files) {
      let report = null;
      try {
        report = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch {
        continue;
      }
      // 以文件名日期为准回看窗口；报告里的 meta.date 缺失时不猜（宁可漏一天也不写错日期）
      const m = scanner.matchReport(report, goals);
      if (!m.date || m.date !== fileDate) continue;
      seenDays.push(m.date);
      for (const hit of m.matched) {
        const goal = goals.find((g) => g.id === hit.goalId);
        if (!goal) continue;
        const r = appendDay([goal], { date: m.date, tips: hit.tips, sourceFile: `tips-${m.date}.md`, root });
        written.push(...r.written);
      }
    }
  }

  const { file } = writeIndex({ root, goals });
  return { goals: goals.length, days: [...new Set(seenDays)].sort(), written: [...new Set(written)], created, indexFile: file };
}

/**
 * 从日报里取「最近 N 天」（以最新一份为基准，含当天）。
 * 纯函数，可单测。内部自排序，调用方不必保证顺序——「输入必须已排序」是个容易踩的坑：
 * 未排序的输入会静默给出错误的回看窗口，而不是报错。
 */
function pickRecentByDay(entries, days) {
  const n = Number(days);
  if (!Array.isArray(entries) || !entries.length || !Number.isFinite(n) || n < 1) return [];
  const sorted = [...entries].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const latest = sorted[sorted.length - 1].date;
  // YYYY-MM-DD 可直接按字典序当日期序用，无需 Date 解析（避免时区把日期挪一天）
  const cutoff = shiftDay(latest, -(Math.floor(n) - 1));
  return sorted.filter((e) => e.date >= cutoff);
}

// 给 YYYY-MM-DD 加减天数（UTC 算术，避开本地时区）
function shiftDay(dateStr, delta) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) return String(dateStr);
  const t = Date.UTC(y, m - 1, d) + delta * 86400000;
  const dt = new Date(t);
  const p = (v) => String(v).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

// 本地今天 YYYY-MM-DD（"用户今天"是本地概念，不能用 UTC——晚上 8 点前 UTC 还停在前一天）
function localToday() {
  const t = new Date();
  const p = (v) => String(v).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

// --sync 要找日报可能出现的所有位置：App 的 userData、仓库 world/out、以及显式 env。
//纯 Node 下拿不到 Electron 的 app.getPath()，所以用 env + 常见路径探测（与
// world/techstack/techstack.js 的 resolveOutDir 同一套思路）。
function resolveOutDirs() {
  const cands = [
    process.env.WORLD_OUT_DIR,
    path.join(os.homedir(), 'Library', 'Application Support', 'clawd-on-desk', 'world'),
    path.join(os.homedir(), 'Library', 'Application Support', 'Desktop World', 'world'),
    path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'clawd-on-desk', 'world'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'clawd-on-desk', 'world') : null,
    path.join(__dirname, '..', 'out'),
  ].filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const d of cands) {
    if (seen.has(d)) continue;
    seen.add(d);
    try {
      if (fs.readdirSync(d).some((f) => scanner.REPORT_RE.test(f))) out.push(d);
    } catch {
      /* 目录不存在就不参与 */
    }
  }
  return out;
}

module.exports = {
  STUDY_DIR,
  INDEX_FILE,
  goalSlug,
  cardPath,
  inspectCard,
  listCards,
  appendDay,
  ensureCards,
  renderIndex,
  writeIndex,
  scanAndAppend,
  syncRecent,
  pickRecentByDay,
  shiftDay,
  localToday,
  resolveOutDirs,
};
