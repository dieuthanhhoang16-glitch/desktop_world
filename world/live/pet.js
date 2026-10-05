// world/live/pet.js
// desktop-world · 动态桌面景观里的桌宠（纯模块，可单测）。
// 从主题契约（schemaVersion 1）挑当前该播哪个动画文件：
// 数据驱动——有进行中会话按 workingTiers 分级，深夜睡觉，其余 idle；
// app 侧可用 setPetState 注入引擎真实状态覆盖（这里只管映射，不管来源）。
'use strict';

const fs = require('fs');
const path = require('path');

const THEMES_ROOT = path.join(__dirname, '..', '..', 'themes');

/** 解析要用哪个主题目录：环境变量 > 显式指定 > girl > calico > 第一个带 theme.json 的。 */
function resolveThemeDir(preferred) {
  const names = [process.env.WORLD_PET_THEME, preferred, 'girl', 'calico'].filter(Boolean);
  let dirs = null;
  for (const name of names) {
    const dir = path.join(THEMES_ROOT, name);
    if (fs.existsSync(path.join(dir, 'theme.json'))) return dir;
  }
  try {
    dirs = fs.readdirSync(THEMES_ROOT, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(THEMES_ROOT, d.name);
    if (fs.existsSync(path.join(dir, 'theme.json'))) return dir;
  }
  return null;
}

function loadTheme(themeDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(themeDir, 'theme.json'), 'utf8'));
  } catch {
    return null;
  }
}

function firstFile(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry)) return entry.find((f) => typeof f === 'string') || null;
  return null;
}

/**
 * 挑选动画文件名。
 * @param theme 解析过的 theme.json
 * @param ctx { activeCount 进行中会话数, totalSessions 今日会话数, hour 0-23, override 引擎注入的状态名 }
 * @returns {file, why} 或 null（主题不可用）
 */
function resolvePetAsset(theme, ctx = {}) {
  if (!theme || !theme.states) return null;
  const states = theme.states;
  const hour = ctx.hour == null ? new Date().getHours() : ctx.hour;
  const active = ctx.activeCount || 0;
  const total = ctx.totalSessions || 0;

  // 引擎真状态覆盖（app 接管时）：直接映射到主题的状态键
  const ov = ctx.override;
  if (ov) {
    if (states[ov]) return { file: firstFile(states[ov]), why: 'override:' + ov };
    // 宽松映射：引擎状态名 → 主题里语义最近的键
    const soft = { working: 'working', sleep: 'sleeping', sleeping: 'sleeping', idle: 'idle' };
    const k = soft[ov];
    if (k && states[k]) return { file: firstFile(states[k]), why: 'override:' + k };
  }

  // 深夜（23:00–07:00）睡觉，除非正在干活
  if (active === 0 && (hour >= 23 || hour < 7) && states.sleeping) {
    return { file: firstFile(states.sleeping), why: 'night' };
  }

  // 有进行中会话 → 工作动画，按引擎 workingTiers 语义分级（minSessions 降序取第一个命中）
  if (active > 0) {
    if (Array.isArray(theme.workingTiers)) {
      const tiers = theme.workingTiers
        .filter((t) => t && typeof t.minSessions === 'number' && t.file)
        .sort((a, b) => b.minSessions - a.minSessions);
      const hit = tiers.find((t) => total >= t.minSessions);
      if (hit) return { file: hit.file, why: 'working:' + hit.minSessions };
    }
    if (states.working) return { file: firstFile(states.working), why: 'working' };
  }

  if (states.idle) return { file: firstFile(states.idle), why: 'idle' };
  // 兜底：随便一个能拿到的状态
  for (const k of Object.keys(states)) {
    const f = firstFile(states[k]);
    if (f) return { file: f, why: 'fallback:' + k };
  }
  return null;
}

/** 组合成报告里 R.pet 的形状；src 相对 world/template/（模板 loadFile 的基址）。 */
function buildPetEntry(themeDir, ctx) {
  const theme = loadTheme(themeDir);
  if (!theme) return null;
  const pick = resolvePetAsset(theme, ctx);
  if (!pick || !pick.file) return null;
  const dirName = path.basename(themeDir);
  const isPng = /\.(apng|png|gif|webp|svg)$/i.test(pick.file);
  if (!isPng) return null;
  return {
    src: `../../themes/${dirName}/assets/${pick.file}`,
    name: theme.name || dirName,
    why: pick.why,
  };
}

module.exports = { THEMES_ROOT, resolveThemeDir, loadTheme, resolvePetAsset, buildPetEntry };
