// world/live/live.js
// desktop-world · 动态桌面（v0.5）：透明无框、点击穿透的常驻窗口，
// 直接渲染早报模板的"活体"——数据每 15 分钟热刷新（不截图、无裁剪、原生清晰度）。
// 静态烘焙壁纸仍然保留：它是分享给 IM 的图片底稿，也是动态窗口下面的衬底。
//
// 边界说明（有意取舍）：
// - 窗口浮在桌面图标*上方*（和桌宠同款机制）。图标下方的真·壁纸层在 macOS 需私有 API、
//   Windows 需 WorkerW 重父级，列入 v0.6 调研项，不在这个版本赌稳定性。
// - 跨日切换时热刷新会升级为完整流水线（跑 runDaily：结算世界 + 烘焙壁纸），
//   平时只做只读式轻刷新，绝不重复结算（幂等由 garden/watch 保证）。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { BrowserWindow, screen } = require('electron');

const TEMPLATE = path.join(__dirname, '..', 'template', 'daily-card.html');
const CFG_FILE = process.env.WORLD_LIVE_FILE || path.join(os.homedir(), '.desktop-world', 'live.json');

let win = null;
let timer = null;

function loadCfg() {
  try {
    return { enabled: false, clickThrough: true, refreshMin: 15, w: 980, h: 620, x: null, y: null, ...JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) };
  } catch {
    return { enabled: false, clickThrough: true, refreshMin: 15, w: 980, h: 620, x: null, y: null };
  }
}
function saveCfg(patch) {
  const cfg = { ...loadCfg(), ...patch };
  fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true });
  fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return cfg;
}

function isOpen() {
  return !!(win && !win.isDestroyed());
}
function isLiveClickable() {
  if (!isOpen()) return false;
  return !loadCfg().clickThrough;
}

/** 组装 live 视图的报告：沿用最新日报的一句话/思路，数据（统计/世界/专案）全部取实时。digest 可复用，避免重复扫盘。 */
async function buildLiveReport(outDir, digest) {
  const { collect } = require('../collector');
  const { loadLatestReport } = require('../pipeline');
  const { worldForReuse, withSvg } = require('../garden');
  const { loadWatch } = require('../watch/config');
  const { annotateSessions, buildView, loadWatchState } = require('../watch/state');

  if (!digest) digest = await collect();
  const latest = loadLatestReport(outDir) || {}; // 旧报告只借文案，数据全部实时

  // 专案：标注 + 只读建视图（结算写盘交给完整流水线，轻刷新不落盘）
  const cfg = loadWatch();
  let watch;
  if (cfg.folders.length) {
    annotateSessions(digest, cfg.folders);
    watch = { ...buildView(cfg.folders, loadWatchState(outDir), digest, digest.date) };
    // 今日实况直接来自 digest，无需结算也准
  }

  return {
    meta: {
      date: digest.date,
      weekday: digest.weekday,
      generatedAt: digest.generatedAt,
      source: digest.source,
      live: true,
    },
    digest,
    watch: watch && watch.active ? watch : undefined,
    world: withSvg(worldForReuse(outDir)),
    oneline: latest.oneline || '今天的一句话还没生成，点一次「生成今日早报壁纸」。',
    ideas: latest.ideas || [],
    source: latest.source || 'fallback',
  };
}

/** 把报告推进窗口（转义 < 防注入提前闭合，虽然数据纯本地）。 */
function pushReport(report) {
  if (!isOpen()) return;
  const payload = JSON.stringify(report).replace(/</g, '\\u003c');
  win.webContents
    .executeJavaScript(`window.__worldRender && window.__worldRender(${payload}); 0`)
    .catch((err) => console.error('[live] 注入失败：', err.message));
}

/**
 * 刷新策略：
 * - 同一天：只更新统计/世界/专案（一句话沿用最新日报，不调 LLM）。
 * - 跨到新的一天：升级跑完整流水线 runDaily（世界结算 + 烘焙衬底壁纸 + 新一句话）。
 */
async function refresh(outDir, onFullDay) {
  const { loadLatestReport } = require('../pipeline');
  const { collect } = require('../collector');
  const digest = await collect();
  const latest = loadLatestReport(outDir);
  const newDay = !latest || latest.meta.date !== digest.date;
  if (newDay) {
    console.log('[live] 发现新的一天，升级跑完整流水线…');
    const { runDaily } = require('../pipeline');
    await runDaily({ outDir, setWallpaper: true, onStep: (m) => console.log(`[live] ${m}`) });
    if (typeof onFullDay === 'function') onFullDay();
    const fresh = loadLatestReport(outDir);
    pushReport(await buildLiveReport(outDir).catch(() => fresh));
    return;
  }
  pushReport(await buildLiveReport(outDir, digest));
}

async function open(outDir) {
  if (isOpen()) return win;
  const cfg = loadCfg();
  const area = screen.getPrimaryDisplay().workAreaSize;
  const w = Math.min(cfg.w, area.width - 40);
  const h = Math.min(cfg.h, area.height - 40);
  const x = cfg.x != null ? cfg.x : Math.round(area.width - w - 32);
  const y = cfg.y != null ? cfg.y : Math.round(area.height - h - 24);

  win = new BrowserWindow({
    width: w,
    height: h,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    maximizable: false,
    resizable: false,
    webPreferences: { sandbox: true },
  });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  win.setIgnoreMouseEvents(cfg.clickThrough, { forward: true });
  win.on('closed', () => {
    win = null;
    if (timer) clearInterval(timer);
    timer = null;
  });
  win.on('moved', () => {
    if (!win || win.isDestroyed()) return;
    const [bx, by] = win.getPosition();
    saveCfg({ x: bx, y: by });
  });

  await win.loadFile(TEMPLATE);
  await refresh(outDir).catch((err) => console.error('[live] 首次刷新失败：', err.message));
  timer = setInterval(() => {
    refresh(outDir).catch((err) => console.error('[live] 定时刷新失败：', err.message));
  }, Math.max(5, cfg.refreshMin) * 60 * 1000);
  console.log(`[live] 动态桌面已开启（${cfg.clickThrough ? '点击穿透' : '可拖动'}，每 ${cfg.refreshMin} 分钟刷新）`);
  return win;
}

function close() {
  if (timer) clearInterval(timer);
  timer = null;
  if (isOpen()) win.close();
  win = null;
}

function toggle(outDir) {
  if (isOpen()) {
    close();
    saveCfg({ enabled: false });
    return { open: false };
  }
  saveCfg({ enabled: true });
  open(outDir).catch((err) => console.error('[live] 开启失败：', err.message));
  return { open: true };
}

function toggleClickThrough() {
  const cfg = loadCfg();
  const next = !cfg.clickThrough;
  saveCfg({ clickThrough: next });
  if (isOpen()) win.setIgnoreMouseEvents(next, { forward: true });
  return { clickThrough: next };
}

module.exports = { open, close, toggle, toggleClickThrough, isOpen, isLiveClickable, loadCfg, saveCfg, buildLiveReport, refresh };
