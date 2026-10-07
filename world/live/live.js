// world/live/live.js
// desktop-world · 动态桌面（v0.6.1 重做形态）：透明无框、默认可点击互动的桌面组件，
// 直接渲染早报模板的"活体"——数据每 15 分钟热刷新（不截图、无裁剪、原生清晰度）。
// v0.6.1 形态变化（用户定调）：
// - 无卡片化 widget 风：组件直接"印"在桌面上，文字投影保可读，不再是一张实体卡片。
// - v0.6.4 起「壁纸」设计整体取消：任何路径（含跨日完整流水线、CLI、托盘）都不写
//   系统桌面壁纸；日报 PNG 只作 IM 分享底稿。
// - 默认可交互：随手记可编辑、窗口可拖动；点击穿透改为菜单里手动锁（toggleClickThrough 语义不变）。
// - 左侧像素景观有桌宠入住（world/live/pet.js 挑动画），右侧新增「随手记」（world/live/notes.js）。
//
// 边界说明（有意取舍）：
// - 窗口浮在桌面图标*上方*（和桌宠同款机制）。图标下方的真·壁纸层 PoC 已在
//   world/live/poc 验证（Plash 招式全可用），接回 Electron 是后续段。
// - 跨日切换时热刷新会升级为完整流水线（世界结算 + 新一句话），
//   平时只做只读式轻刷新，绝不重复结算（幂等由 garden/watch 保证）。
//
// v0.6.6 三态生命周期（closed / hidden / open）：
// - 之前只有 open/closed 两态，「关闭」= close() 销毁窗口——番茄钟/随手记在途状态
//   随之蒸发，重开还有 loadFile 空窗，用户报"桌面世界不能隐藏"。
// - 现在的 hide() 只把窗口收成右上角小胶囊：绝不销毁 webContents、不重跑 loadFile、
//   不清 15 分钟 timer；番茄钟/随手记在途状态全随 webContents 活着。
// - state() 是三态唯一真源：托盘菜单、全局快捷键、渲染层 ui 查询都只读它，
//   任何地方不许再各自缓存布尔值。
// - live.json 的 state 字段做启动恢复（hidden→hidden，不会一启动炸出全尺寸窗口）；
//   纯逻辑（胶囊边界/状态归一/迁移）在 lifecycle.js，配置读写在 cfg.js，都可单测。
'use strict';

const fs = require('fs');
const path = require('path');
const { BrowserWindow, screen, ipcMain } = require('electron');

const TEMPLATE = path.join(__dirname, '..', 'template', 'daily-card.html');
const PRELOAD = path.join(__dirname, 'preload.js');
const { CFG_FILE, loadCfg, saveCfg } = require('./cfg');
const life = require('./lifecycle');

let win = null;
let timer = null;
let notesFile = null; // open() 时确定为 <outDir>/notes.json
let dismissedFile = null; // open() 时确定为 <outDir>/dismissed.json
let pomoFile = null; // open() 时确定为 <outDir>/pomodoro.json（番茄钟：主进程时钟 + 落盘）
let liveOutDirRef = null; // open() 时记下 outDir（打开当日 md 用）
let petOverride = null; // app 侧引擎状态注入（见 setPetState），缺省时走数据推导
let sessionSnapshot = null; // app 侧引擎真实 session snapshot 注入（见 setSessionSnapshot）
let activeTabRef = 'daily'; // 当前 tab：'daily' 早报 | 'orch' 工单看板

// ---- 三态生命周期的模块态（窗口存在期间的显式形态；state() 的出口）----
let visMode = 'open'; // 窗口活着时的形态：'open' | 'hidden'（closed = 没有窗口，不占这里）
let fullBounds = null; // 收起前的完整边界 {x,y,width,height}，hidden→open 恢复用
let liveHooks = { openSettings: null, onStateChange: null }; // 托盘注入（settings 打开 + 菜单重建）

function isOpen() {
  return !!(win && !win.isDestroyed());
}

// 三态唯一真源。菜单/快捷键/渲染层都只读这一个；'closed' = 窗口不存在或已销毁。
function state() {
  if (!isOpen()) return 'closed';
  return visMode;
}

/** 托盘注入钩子：openSettings（lifecycle 控制组的 ⚙）与 onStateChange（状态变化重建菜单）。 */
function setHooks(hooks) {
  liveHooks = {
    openSettings: hooks && typeof hooks.openSettings === 'function' ? hooks.openSettings : null,
    onStateChange: hooks && typeof hooks.onStateChange === 'function' ? hooks.onStateChange : null,
  };
}
function emitState() {
  if (liveHooks.onStateChange) {
    try { liveHooks.onStateChange(state()); } catch { /* 菜单重建失败不挡生命周期 */ }
  }
}

/** 把形态 + UI 态（clickThrough）推给渲染层（胶囊点击态、锁按钮、is-hidden class）。 */
function syncRendererMode(mode) {
  if (!isOpen()) return;
  const clickThrough = !!loadCfg().clickThrough;
  win.webContents
    .executeJavaScript(
      `window.__worldSetMode && window.__worldSetMode(${JSON.stringify(mode)});` +
        `window.__worldSetUi && window.__worldSetUi(${JSON.stringify({ clickThrough })}); 0`
    )
    .catch(() => { /* 渲染层尚未就绪时，open() 的路径会再补一次 */ });
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

  // 编排（工单看板，v0.7）：只读聚合，不写盘。没建过工单时 active:false，模板整段静默。
  // sessionSnapshot 优先用引擎注入的真实快照（setSessionSnapshot），拿不到就退回
  // 本模块已采集的 digest 会话（同样的 agent 维度），保证场景永远有工位可画。
  let orch;
  try {
    const { buildOrchView } = require('../orch');
    orch = buildOrchView({ snapshot: sessionSnapshot || digestAsSnapshot(digest) });
  } catch (e) {
    console.error('[live] 编排视图读取失败（忽略，不影响卡片）：', e.message);
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
    oneline: latest.oneline || '今天的一句话还没生成——跑 npm run world:daily，或等跨日自动结算。',
    ideas: latest.ideas || [],
    sessionBriefs: latest.sessionBriefs, // 会话一句话沿用日报（顺序已对上新 digest 前 10 条，未必覆盖新会话）
    blockers: latest.blockers, // 今日卡点 / 技术总结：跟日报走，轻刷不重算
    techTips: latest.techTips,
    pomo: pomoView, // 番茄钟快照：面板渲染 + 看板任务累计时长角标（模板据此标 s._pomoMs）
    orch, // 编排工单看板（v0.7）：工位场景 + 工单列 + 收件箱概览 + 黑板事实
    source: latest.source || 'fallback',
  };
}

/**
 * 把已采集的 digest 会话折成 session snapshot 的最小形状。
 * 只为编排工位提供 agent/state/cwd 三件事，**不冒充引擎快照**：字段名对齐
 * src/state-session-snapshot.js，但语义是"日报采集看到的会话"，不是引擎实时状态。
 * 引擎真状态注入（setSessionSnapshot）优先级高于它。
 */
function digestAsSnapshot(digest) {
  const sessions = (digest && digest.sessions) || [];
  return {
    sessions: sessions.map((s) => ({
      id: s.id,
      agentId: s.agent || 'claude-code',
      agentName: s.agent || 'claude-code',
      // '进行中' 是 digest 的中文状态；编排场景只关心"是不是在干活"
      state: s.status === '进行中' ? 'working' : 'idle',
      badge: s.status === '进行中' ? 'running' : 'idle',
      cwd: s.project || '',
      displayTitle: s.title || '',
    })),
  };
}

/** app 侧把引擎真实 session snapshot 接进来（工位状态优先于 digest 推导）。 */
function setSessionSnapshot(snapshot) {
  sessionSnapshot = snapshot && Array.isArray(snapshot.sessions) ? snapshot : null;
}

/** 当前激活的 tab（'daily' | 'orch'）。托盘「工单看板」用来切到编排视图。 */
function activeTab() {
  return activeTabRef;
}
function setActiveTab(tab) {
  const next = tab === 'orch' ? 'orch' : 'daily';
  activeTabRef = next;
  if (isOpen()) {
    win.webContents
      .executeJavaScript(`window.__worldSetTab && window.__worldSetTab(${JSON.stringify(next)}); 0`)
      .catch((err) => console.error('[live]切 tab 失败：', err.message));
  }
  return next;
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
 * - 跨到新的一天：升级跑完整流水线 runDaily（世界结算 + 新一句话 + 分享底稿 PNG）。
 */
async function refresh(outDir, onFullDay) {
  const { loadLatestReport } = require('../pipeline');
  const { collect } = require('../collector');
  const digest = await collect();
  const latest = loadLatestReport(outDir);
  const newDay = !latest || latest.meta.date !== digest.date;
  if (newDay) {
    console.log('[live] 发现新的一天，升级跑完整流水线（结算 + 新一句话 + PNG，绝无壁纸改动）…');
    const { runDaily } = require('../pipeline');
    await runDaily({ outDir, onStep: (m) => console.log(`[live] ${m}`) });
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
  // 三态生命周期（v0.6.6）：胶囊点击展开、控制组（收起/穿透锁/Settings）都走这里，
  // new 按钮一律 preload invoke，渲染层不直接 require 主进程能力
  ipcMain.handle('world:live:hide', (e) => {
    if (!ok(e)) return 'closed';
    return hide();
  });
  ipcMain.handle('world:live:show', (e) => {
    if (!ok(e)) return 'closed';
    return show();
  });
  ipcMain.handle('world:live:ui', (e) => {
    if (!ok(e)) return { mode: 'closed', clickThrough: false };
    return { mode: state(), clickThrough: !!loadCfg().clickThrough };
  });
  ipcMain.handle('world:live:click-through', (e) => {
    if (!ok(e)) return { clickThrough: !!loadCfg().clickThrough };
    return toggleClickThrough();
  });
  ipcMain.handle('world:live:open-settings', (e) => {
    if (!ok(e)) return false;
    if (liveHooks.openSettings) {
      try { liveHooks.openSettings(); } catch { /* settings 打不开不挡组件 */ }
    }
    return true;
  });
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
  // 定向学习（v0.6.5）：渲染层只发模糊方向/选中关键词，记忆聚合与写盘全在主进程。
  // propose 永不抛错（LLM 挂了静默退确定性词典）；add 的校验在 techstack/config 层把关。
  const { loadTechstack, addGoal, MAX_DIRECTION_LEN } = require('../techstack/config');
  ipcMain.handle('world:tech:list', (e) => {
    if (!ok(e)) return { goals: [] };
    try {
      return { goals: loadTechstack().goals.map((g) => ({ id: g.id, direction: g.direction, keywords: g.keywords })) };
    } catch {
      return { goals: [] };
    }
  });
  ipcMain.handle('world:tech:propose', async (e, direction) => {
    if (!ok(e)) return { keywords: [] };
    const dir = String(direction || '').trim().slice(0, MAX_DIRECTION_LEN);
    if (!dir) return { keywords: [] };
    try {
      const { buildMemory } = require('../techstack/memory');
      const { proposeKeywords } = require('../techstack/propose');
      const memory = buildMemory({ outDir: liveOutDirRef, days: 7 });
      const res = await proposeKeywords(dir, memory, { timeoutMs: 60000 });
      return { direction: dir, keywords: (res && res.keywords) || [], source: (res && res.source) || 'static' };
    } catch (err) {
      console.error('[live] 定向学习候选失败（返回空，不打断组件）：', err.message);
      return { direction: dir, keywords: [] };
    }
  });
  ipcMain.handle('world:tech:add', (e, direction, keywords) => {
    if (!ok(e)) return { ok: false };
    try {
      const { goal, updated } = addGoal({ direction, keywords });
      return { ok: true, updated: !!updated, goal: { id: goal.id, direction: goal.direction, keywords: goal.keywords } };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 学习卡片（v0.7）：列卡片 / 打开卡片 md。
  // 路径白名单与 open:md 同规格——只放行 STUDY_DIR 之下、且确实是已登记卡片或index.md
  // 的路径，渲染层传进来的字符串一律当不可信输入处理（不做 path.join 拼接后直接open）。
  const studyMod = require('../study');
  const studyRoot = studyMod.STUDY_DIR;
  const studyBad = { cards: [], indexFile: null };
  const studyInside = (p) => {
    const abs = path.resolve(String(p || ''));
    const base = path.resolve(studyRoot);
    return abs === base || abs.startsWith(base + path.sep);
  };
  ipcMain.handle('world:study:list', (e) => {
    if (!ok(e)) return studyBad;
    try {
      const cards = studyMod.listCards();
      return { cards, indexFile: path.join(studyRoot, studyMod.INDEX_FILE) };
    } catch (err) {
      console.error('[live] 学习卡片列表失败：', err.message);
      return studyBad;
    }
  });
  ipcMain.handle('world:study:open', async (e, file) => {
    if (!ok(e)) return false;
    const abs = path.resolve(String(file || ''));
    if (!studyInside(abs) || !fs.existsSync(abs)) return false;
    const err = await shell.openPath(abs);
    if (err) console.error('[live] 打开学习卡片失败：', err);
    return !err;
  });
  ipcMain.handle('world:study:open-index', async (e) => {
    if (!ok(e)) return false;
    const abs = path.join(studyRoot, studyMod.INDEX_FILE);
    if (!fs.existsSync(abs)) return false;
    const err = await shell.openPath(abs);
    if (err) console.error('[live] 打开学习卡片总览失败：', err);
    return !err;
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

/**
 * 打开位置解析（open 与 show() 的 fullBounds 兜底共用）：
 * 保存的坐标必须在当前某块屏上露出足够面积，否则回退默认位。
 *（多屏下 macOS 可能把 frameless 窗"搬"进活跃 Space 所在的屏，或被断连的屏带走，
 *  上次保存的坐标会让窗口完整落在别的窗口后面/看不见——表现为"重启后看不见"。）
 */
function resolveOpenBounds(cfg) {
  const area = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(cfg.w, area.width - 40);
  const height = Math.min(cfg.h, area.height - 40);
  const displays = screen.getAllDisplays().map((d) => d.bounds);
  const cfgOK = require('./pos').rectVisibleOn({ x: cfg.x, y: cfg.y, w: width, h: height }, displays);
  const x = cfg.x != null && cfgOK ? cfg.x : Math.round(area.width - width - 32);
  const y = cfg.y != null && cfgOK ? cfg.y : Math.round(area.height - height - 24);
  if (cfg.x != null && !cfgOK) saveCfg({ x, y }); // 把坏坐标就地修掉
  return { x, y, width, height };
}

async function open(outDir, opts = {}) {
  if (isOpen()) return win;
  const cfg = loadCfg();
  notesFile = path.join(outDir, 'notes.json');
  dismissedFile = path.join(outDir, 'dismissed.json');
  pomoFile = path.join(outDir, 'pomodoro.json');
  liveOutDirRef = outDir;
  ensureNotesIpc();
  const bounds = resolveOpenBounds(cfg);

  visMode = 'open';
  fullBounds = null;
  // show:false——一启动恢复 hidden 态时绝不能先炸出全尺寸窗口再缩（spec：启动恢复 hidden→hidden）；
  // 普通开启也统一成"加载完再亮相"，行为只更稳
  win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    show: false,
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
  const created = win;
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  win.setIgnoreMouseEvents(cfg.clickThrough, { forward: true });
  win.on('closed', () => {
    // 'closed' 异步派发：若此时已经重开了新窗口（closeLive→toggle/open 紧挨着来），
    // 晚到的旧事件绝不能清掉新窗口的引用和它的 15 分钟 timer
    if (win !== created) return;
    win = null;
    if (timer) clearInterval(timer);
    timer = null;
    emitState();
  });
  win.on('moved', () => {
    if (!win || win.isDestroyed()) return;
    if (visMode !== 'open') return; // 收起/展开过程中的程序化 setBounds 不得覆盖用户位置
    const [bx, by] = win.getPosition();
    saveCfg({ x: bx, y: by });
  });

  await win.loadFile(TEMPLATE);
  // macOS 兜底（lifecycle.snapPosition）：setVisibleOnAllWorkspaces/Space 切换可能让系统
  // 把窗口改摆到别的屏；loadFile 完成后核对一次，不在目标位就拉回来
  //（'moved' 事件随之把正确坐标存回去）。hidden→open 的展开复用同一个函数。
  life.snapPosition(win, bounds.x, bounds.y);
  await refresh(outDir).catch((err) => console.error('[live] 首次刷新失败：', err.message));
  timer = setInterval(() => {
    refresh(outDir).catch((err) => console.error('[live] 定时刷新失败：', err.message));
  }, Math.max(5, cfg.refreshMin) * 60 * 1000);

  if (opts.startHidden) {
    hide(); // 全程没亮过相，直接以胶囊形态登场
  } else {
    win.show();
  }
  emitState();
  console.log(
    `[live] 动态桌面已开启（${opts.startHidden ? '恢复为收起胶囊' : cfg.clickThrough ? '点击穿透' : '可交互可拖动'}，每 ${cfg.refreshMin} 分钟刷新）`
  );
  return win;
}

/**
 * 收起：open → hidden。窗口缩成右上角胶囊（世界等级/番茄/考点摘要），
 * 绝不销毁 webContents、不重跑 loadFile、不清 timer——番茄钟和随手记在途状态全活着。
 * hide 态保持 setIgnoreMouseEvents(cfg.clickThrough)：锁定时胶囊穿透不可点，
 * 只能从托盘/快捷键唤回（预期行为，胶囊 title 有说明）。
 */
function hide() {
  if (!isOpen()) return 'closed';
  if (visMode === 'hidden') return 'hidden';
  fullBounds = life.collapseToPill(win, syncRendererMode);
  visMode = 'hidden';
  saveCfg({ state: 'hidden' });
  emitState();
  console.log('[live] 已收起到角落胶囊（webContents/timer 保持，番茄钟继续跑）');
  return 'hidden';
}

/**
 * 展开：hidden → open。胶囊换成完整窗：还原收起前边界 + 复用 open() 的 macOS
 * 位置兜底（收起期间 Space/多屏可能把坐标挪走）。
 */
function show() {
  if (!isOpen()) return 'closed';
  if (visMode === 'open') return 'open';
  // fullBounds 分内记忆优先（收起前实测）；兜底走与 open() 相同的保存位解析
  const b = fullBounds || resolveOpenBounds(loadCfg());
  life.expandFromPill(win, b, syncRendererMode);
  visMode = 'open';
  saveCfg({ state: 'open' });
  emitState();
  console.log('[live] 已从胶囊展开');
  return 'open';
}

/** 真关闭：销毁窗口 + enabled:false（下一次 App 启动不再恢复）。区别于 toggle 的 open↔hidden。 */
function closeLive() {
  close();
  saveCfg({ enabled: false, state: 'closed' });
  emitState();
  console.log('[live] 动态桌面已关闭（销毁窗口，enabled:false）');
  return 'closed';
}

function close() {
  if (timer) clearInterval(timer);
  timer = null;
  if (isOpen()) win.close();
  win = null;
  fullBounds = null;
}

/**
 * v0.6.6 toggle 语义：closed → open（启动组件）；open ↔ hidden（收起/展开互切，不销毁）。
 * 真关闭只有 closeLive()。
 */
function toggle(outDir) {
  const s = state();
  if (s === 'closed') {
    saveCfg({ enabled: true, state: 'open' });
    open(outDir).catch((err) => console.error('[live] 开启失败：', err.message));
    return { state: 'open' }; // 意图先行；open 完成后还会 emitState
  }
  if (s === 'open') {
    hide();
    return { state: 'hidden' };
  }
  show();
  return { state: 'open' };
}

function toggleClickThrough() {
  const cfg = loadCfg();
  const next = !cfg.clickThrough;
  saveCfg({ clickThrough: next });
  if (isOpen()) {
    win.setIgnoreMouseEvents(next, { forward: true });
    syncRendererMode(visMode); // 胶囊 title/锁按钮跟着新状态走
  }
  return { clickThrough: next };
}

module.exports = {
  open,
  close,
  closeLive,
  toggle,
  toggleClickThrough,
  hide,
  show,
  state,
  setHooks,
  isOpen,
  isLiveClickable,
  hasSavedCfg,
  loadCfg,
  saveCfg,
  CFG_FILE,
  buildLiveReport,
  refresh,
  setPetState,
  setSessionSnapshot,
  activeTab,
  setActiveTab,
};
