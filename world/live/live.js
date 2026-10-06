// world/live/live.js
// desktop-world · 动态桌面（v0.6.1 重做形态）：透明无框、默认可点击互动的桌面组件，
// 直接渲染早报模板的"活体"——数据每 15 分钟热刷新（不截图、无裁剪、原生清晰度）。
// v0.6.1 形态变化（用户定调）：
// - 无卡片化 widget 风：组件直接"印"在桌面上，文字投影保可读，不再是一张实体卡片。
// - 组件永不碰系统壁纸（跨日跑完整流水线也只结算数据，setWallpaper=false）；
//   壁纸烘焙只保留手动入口（托盘「生成今日早报壁纸」/ CLI world:daily），产物仍是 IM 分享底稿。
// - 默认可交互：随手记可编辑、窗口可拖动；点击穿透改为菜单里手动锁（toggleClickThrough 语义不变）。
// - 左侧像素景观有桌宠入住（world/live/pet.js 挑动画），右侧新增「随手记」（world/live/notes.js）。
//
// 边界说明（有意取舍）：
// - 窗口浮在桌面图标*上方*（和桌宠同款机制）。图标下方的真·壁纸层 PoC 已在
//   world/live/poc 验证（Plash 招式全可用），接回 Electron 是后续段。
// - 跨日切换时热刷新会升级为完整流水线（世界结算 + 新一句话），
//   平时只做只读式轻刷新，绝不重复结算（幂等由 garden/watch 保证）。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { BrowserWindow, screen, ipcMain } = require('electron');

const TEMPLATE = path.join(__dirname, '..', 'template', 'daily-card.html');
const PRELOAD = path.join(__dirname, 'preload.js');
const CFG_FILE = process.env.WORLD_LIVE_FILE || path.join(os.homedir(), '.desktop-world', 'live.json');

let win = null;
let timer = null;
let notesFile = null; // open() 时确定为 <outDir>/notes.json
let dismissedFile = null; // open() 时确定为 <outDir>/dismissed.json
let pomoFile = null; // open() 时确定为 <outDir>/pomodoro.json（番茄钟：主进程时钟 + 落盘）
let liveOutDirRef = null; // open() 时记下 outDir（打开当日 md 用）
let petOverride = null; // app 侧引擎状态注入（见 setPetState），缺省时走数据推导

function loadCfg() {
  // v0.6.1 起组件默认可交互（clickThrough:false）；点击穿透是菜单里的可选锁定。
  const dflt = { enabled: false, clickThrough: false, refreshMin: 15, w: 980, h: 620, x: null, y: null };
  let cfg;
  try {
    cfg = { ...dflt, ...JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) };
  } catch {
    return { ...dflt };
  }
  // 一次性迁移：v0.5 时代默认存了 clickThrough:true，v0.6.1 起组件应是可互动的，刷掉
  if (cfg.clickThrough === true && !cfg.v61) {
    cfg = { ...cfg, clickThrough: false, v61: true };
    try {
      fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    } catch { /* 迁移失败不挡启动 */ }
  }
  return cfg;
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
function hasSavedCfg() {
  return fs.existsSync(CFG_FILE);
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

  // 看板「隐藏这条」：从 dismissed.json 标注 s.hidden（模板据此过滤；原始会话记录不受影响）
  if (outDir) {
    try {
      const board = require('./board');
      board.annotateHidden(digest.sessions, board.list(path.join(outDir, 'dismissed.json'), digest.date));
    } catch (e) {
      console.error('[live] 隐藏清单读取失败（忽略）：', e.message);
    }
  }

  // 番茄钟视图快照（主进程幂等 tick 一次，顺便让热刷新也吃到最新阶段）
  let pomoView;
  try {
    const pomo = require('./pomodoro');
    if (outDir) pomoView = pomo.tick(path.join(outDir, 'pomodoro.json'), digest.date);
  } catch (e) {
    console.error('[live] 番茄钟视图读取失败（忽略）：', e.message);
  }
  const pomoFocusing = pomoView && pomoView.phase === 'focus';

  // 桌宠入住景观：挑当前主题的动画文件（数据驱动分级 + 引擎覆盖优先）。
  // 番茄专注期间按任务类型映射角色动作（任务名关键词 → thinking/sweeping/carrying/…，
  // munder-difflin 式"行为即状态"），未关联任务时通用 working；
  // 引擎 setPetState 的显式 override 仍然最高优先
  let pet;
  try {
    const petlib = require('./pet');
    const pomo = require('./pomodoro');
    const themeDir = petlib.resolveThemeDir();
    if (themeDir) {
      const sessions = digest.sessions || [];
      pet = petlib.buildPetEntry(themeDir, {
        activeCount: sessions.filter((s) => s.status === '进行中').length + (pomoFocusing ? 1 : 0),
        totalSessions: Math.max(
          ((digest.totals && digest.totals.sessions) || sessions.length || 0),
          pomoFocusing ? 99 : 0 // 顶格 workingTiers，focus 期间给最拼的动画
        ),
        override: petOverride || (pomoFocusing ? pomo.taskActionFor(pomoView.task) : null),
      }) || undefined;
      if (pomoFocusing && pomoView.task) pet = pet ? { ...pet, taskTitle: pomoView.task.title } : pet;
    }
  } catch (e) {
    console.error('[live] 桌宠解析失败（忽略，不影响卡片）：', e.message);
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
    pet,
    oneline: latest.oneline || '今天的一句话还没生成，点一次「生成今日早报壁纸」。',
    ideas: latest.ideas || [],
    sessionBriefs: latest.sessionBriefs, // 会话一句话沿用日报（顺序已对上新 digest 前 10 条，未必覆盖新会话）
    blockers: latest.blockers, // 今日卡点 / 技术总结：跟日报走，轻刷不重算
    techTips: latest.techTips,
    pomo: pomoView, // 番茄钟快照：面板渲染 + 看板任务累计时长角标（模板据此标 s._pomoMs）
    source: latest.source || 'fallback',
  };
}

/** app 侧把引擎真实状态接进来（working/sleeping/idle/…）；null 恢复数据推导。 */
function setPetState(state) {
  petOverride = state || null;
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
 * - 跨到新的一天：升级跑完整流水线 runDaily（世界结算 + 新一句话）——
 *   但永不替换系统壁纸（setWallpaper:false，用户要的「组件永不碰壁纸」）。
 */
async function refresh(outDir, onFullDay) {
  const { loadLatestReport } = require('../pipeline');
  const { collect } = require('../collector');
  const digest = await collect();
  const latest = loadLatestReport(outDir);
  const newDay = !latest || latest.meta.date !== digest.date;
  if (newDay) {
    console.log('[live] 发现新的一天，升级跑完整流水线（不触碰系统壁纸）…');
    const { runDaily } = require('../pipeline');
    await runDaily({ outDir, setWallpaper: false, onStep: (m) => console.log(`[live] ${m}`) });
    if (typeof onFullDay === 'function') onFullDay();
    const fresh = loadLatestReport(outDir);
    pushReport(await buildLiveReport(outDir).catch(() => fresh));
    return;
  }
  pushReport(await buildLiveReport(outDir, digest));
}

let notesIpcReady = false;

/** 组件窗 IPC：只服务本窗口的 webContents（随手记 / 看板隐藏 / 打开当日 md）。 */
function ensureNotesIpc() {
  if (notesIpcReady) return;
  notesIpcReady = true;
  const notes = require('./notes');
  const board = require('./board');
  const { shell } = require('electron');
  const ok = (e) => win && !win.isDestroyed() && e.sender === win.webContents;
  ipcMain.handle('world:notes:load', (e, date) => {
    if (!ok(e) || !notesFile) return '';
    return notes.get(notesFile, String(date || ''));
  });
  ipcMain.handle('world:notes:save', (e, date, text) => {
    if (!ok(e) || !notesFile) return '';
    try {
      return notes.save(notesFile, String(date || ''), String(text || ''));
    } catch (err) {
      console.error('[live] 随手记保存失败：', err.message);
      return '';
    }
  });
  ipcMain.handle('world:board:hide', (e, date, sid) => {
    if (!ok(e) || !dismissedFile) return [];
    try {
      return board.hide(dismissedFile, String(date || ''), String(sid || ''));
    } catch (err) {
      console.error('[live] 隐藏失败：', err.message);
      return [];
    }
  });
  ipcMain.handle('world:board:unhide-all', (e, date) => {
    if (!ok(e) || !dismissedFile) return [];
    try {
      return board.unhideAll(dismissedFile, String(date || ''));
    } catch (err) {
      console.error('[live] 恢复失败：', err.message);
      return [];
    }
  });
  // 打开当日随笔 md：只允许 outDir 下的 blockers|tips-YYYY-MM-DD.md，白名单式拼路径
  ipcMain.handle('world:open:md', async (e, kind, date) => {
    if (!ok(e) || !liveOutDirRef) return false;
    if (kind !== 'blockers' && kind !== 'tips') return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return false;
    const file = path.join(liveOutDirRef, `${kind}-${date}.md`);
    if (!fs.existsSync(file)) return false;
    const err = await shell.openPath(file);
    if (err) console.error('[live] 打开 md 失败：', err);
    return !err;
  });
  // 番茄钟：主进程是唯一时钟源。渲染层 1Hz 轮询 poll（内含幂等 tick 推进/结算）；
  // 动作只发指令，日期键白名单校验，任务引用由 pomodoro.normTask 规范化
  const pomo = require('./pomodoro');
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const badView = { phase: 'idle', remainMs: 0, totalMs: 0, task: null, cycles: 0, focusMs: 0, tasks: {}, doneSids: [] };
  const pomoGuard = (e, date) => (ok(e) && pomoFile && DATE_RE.test(String(date || '')));
  ipcMain.handle('world:pomo:poll', (e, date) => {
    if (!pomoGuard(e, date)) return badView;
    try {
      return pomo.tick(pomoFile, String(date));
    } catch (err) {
      console.error('[live] 番茄钟 poll 失败：', err.message);
      return badView;
    }
  });
  ipcMain.handle('world:pomo:start', (e, date, task) => {
    if (!pomoGuard(e, date)) return badView;
    try {
      return pomo.start(pomoFile, String(date), task && typeof task === 'object' ? task : null);
    } catch (err) {
      console.error('[live] 番茄开始失败：', err.message);
      return badView;
    }
  });
  for (const [ch, fn] of [
    ['world:pomo:pause', pomo.pause],
    ['world:pomo:resume', pomo.resume],
    ['world:pomo:skip', pomo.skip],
  ]) {
    ipcMain.handle(ch, (e, date) => {
      if (!pomoGuard(e, date)) return badView;
      try {
        return fn(pomoFile, String(date));
      } catch (err) {
        console.error(`[live] 番茄 ${ch} 失败：`, err.message);
        return badView;
      }
    });
  }
  ipcMain.handle('world:pomo:complete-task', (e, date, sid) => {
    if (!pomoGuard(e, date)) return badView;
    try {
      return pomo.completeTask(pomoFile, String(date), String(sid || ''));
    } catch (err) {
      console.error('[live] 手动完成任务失败：', err.message);
      return badView;
    }
  });
}

async function open(outDir) {
  if (isOpen()) return win;
  const cfg = loadCfg();
  notesFile = path.join(outDir, 'notes.json');
  dismissedFile = path.join(outDir, 'dismissed.json');
  pomoFile = path.join(outDir, 'pomodoro.json');
  liveOutDirRef = outDir;
  ensureNotesIpc();
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
    webPreferences: { sandbox: true, preload: PRELOAD },
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
  console.log(`[live] 动态桌面已开启（${cfg.clickThrough ? '点击穿透' : '可交互可拖动'}，每 ${cfg.refreshMin} 分钟刷新）`);
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

module.exports = { open, close, toggle, toggleClickThrough, isOpen, isLiveClickable, hasSavedCfg, loadCfg, saveCfg, buildLiveReport, refresh, setPetState };
