// world/app-integration.js
// desktop-world · 桌宠 App 内的接入口（托盘/右键菜单调用）。
// 与独立 CLI 的区别：输出目录用 userData，用系统通知反馈进度。
// v0.6.4 起：「早报壁纸」设计整体取消——任何代码路径都不允许碰系统桌面壁纸
// （日报 PNG 仍生成，仅作 IM 分享底稿；当日日报由动态桌面跨日自动结算或 CLI world:daily 产出）。
'use strict';

const fs = require('fs');
const path = require('path');

let running = false;

function notify(title, body) {
  try {
    const { Notification } = require('electron');
    if (Notification.isSupported()) new Notification({ title, body }).show();
  } catch {
    /* 通知不可用时静默降级，日志仍在 */
  }
  console.log(`[world] ${title}${body ? ' — ' + body : ''}`);
}

// 托盘菜单入口：把最近一份日报分享到已配置渠道（不重跑流水线）。
async function shareDaily() {
  if (running) {
    notify('忙线中…', '早报流水线正在跑，等它结束再分享');
    return;
  }
  running = true;
  try {
    const { app } = require('electron');
    const outDir = path.join(app.getPath('userData'), 'world');
    const { loadLatestReport } = require('./pipeline');
    const report = loadLatestReport(outDir);
    if (!report) {
      notify('还没有可分享的日报', '先跑一次 npm run world:daily（或等动态桌面跨日自动结算）');
      return;
    }
    const { share } = require('./share');
    const { ok, results, hint } = await share({
      report,
      imagePath: path.join(outDir, `daily-${report.meta.date}.png`),
      log: (m) => console.log(`[share] ${m}`),
    });
    if (hint) {
      notify('尚未配置分享渠道', 'node world/share/configure.js --set wework <webhook>');
      return;
    }
    const success = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    notify(
      ok ? '日报已分享 📮' : '分享失败 ❌',
      [
        success.length ? `成功 ${success.length} 个渠道` : '',
        failed.length ? `失败：${failed.map((r) => `${r.channel}(${r.detail})`).join('；')}` : '',
      ].filter(Boolean).join('；').slice(0, 200)
    );
  } catch (err) {
    console.error('[share] 失败：', err);
    notify('分享失败 ❌', err.message || String(err));
  } finally {
    running = false;
  }
}

// 托盘菜单入口：桌面文件整理（扫描 → 弹确认框 → 归档）。
// "申请-确认"式半自动：绝不在用户没点"归档"之前动文件。
async function tidyDesktop() {
  if (running) {
    notify('忙线中…', '另一条流水线还在跑，稍后再试');
    return;
  }
  running = true;
  try {
    const { app, dialog } = require('electron');
    const { scanDesktop, DEFAULT_DESKTOP } = require('./tidy/scan');
    const { classifyByRules, refineOthersWithLLM, OTHER } = require('./tidy/classify');
    const { buildPlan } = require('./tidy/plan');
    const { applyPlan } = require('./tidy/apply');

    const files = scanDesktop({ dir: DEFAULT_DESKTOP, minAgeMin: 60 });
    if (!files.length) {
      notify('桌面很干净 ✨', '没有可归档的散文件');
      return;
    }
    const { groups, others } = classifyByRules(files);
    if (others.length) {
      const { runClaudeHeadless } = require('./summarizer');
      const refined = await refineOthersWithLLM(others.map((f) => f.name), runClaudeHeadless).catch(() => new Map());
      if (refined.size) {
        groups.delete(OTHER);
        for (const f of others) {
          const cat = refined.get(f.name) || OTHER;
          if (!groups.has(cat)) groups.set(cat, []);
          groups.get(cat).push(f);
        }
      }
    }
    const rootDir = path.join(DEFAULT_DESKTOP, '_归档');
    const plan = buildPlan({ files, groups, rootDir });

    const detail = Object.entries(plan.byCategory)
      .map(([cat, n]) => `${cat} × ${n}`)
      .join('　');
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['归档', '取消'],
      defaultId: 0,
      cancelId: 1,
      title: '桌面整理申请',
      message: `发现 ${plan.moves.length} 个散文件，拟归档到「_归档」文件夹：`,
      detail: `${detail}\n\n归档后可用 node world/tidy/tidy.js --undo 一键还原。`,
    });
    if (response !== 0) return;

    const outDir = path.join(app.getPath('userData'), 'world');
    const { moved, failed } = applyPlan(plan, { undoDir: outDir });
    notify(
      `桌面已整理 🧹 ${moved}/${plan.moves.length}`,
      failed.length ? `${failed.length} 个失败，见控制台日志` : `撤销：node world/tidy/tidy.js --undo`
    );
    if (failed.length) failed.forEach((f) => console.warn('[tidy] 失败：', f.from, f.error));
  } catch (err) {
    console.error('[tidy] 失败：', err);
    notify('桌面整理失败 ❌', err.message || String(err));
  } finally {
    running = false;
  }
}

// ---------- v0.5 · 动态桌面（透明热刷新窗口，代替"只能截图换壁纸"） ----------
// v0.6.6 起三态生命周期（closed / hidden / open）：toggle 只做 open↔hidden 互切与
// closed→open 启动（不销毁窗口）；真销毁只有 closeLiveDesktop（enabled:false）。
// 唯一的显式"在中间收起"形态是右上角胶囊——番茄钟/随手记随 webContents 活着。

const DEFAULT_LIVE_ACCEL = 'CommandOrControl+Shift+D'; // Cmd(mac)/Ctrl(其他)+Shift+D

let liveStarted = false;
let liveShortcutAccel = null; // 当前已注册的加速器（相等即幂等跳过；冲突/失败则钉住不再刷屏重试）

function liveOutDir() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'world');
}

// 三态唯一真源的出口——托盘菜单每次 build 都从这里现读（禁止各处缓存布尔）
function liveState() {
  try {
    return require('./live/live').state();
  } catch {
    return 'closed';
  }
}

function isLiveOpen() {
  return liveState() !== 'closed';
}

/** 托盘「展开/收起」：closed→open 启动；open↔hidden 互切（收起不销毁，番茄钟/随手记保住）。 */
function toggleLiveDesktop() {
  const live = require('./live/live');
  const before = live.state();
  const { state: after } = live.toggle(liveOutDir());
  if (before === 'closed' && after === 'open') {
    liveStarted = true;
    const cfg = live.loadCfg();
    notify('动态桌面已开启 🖥️', `可拖动位置，每 ${cfg.refreshMin} 分钟自动刷新数据`);
  } else if (after === 'hidden') {
    notify('已收起到角落胶囊 📌', '番茄钟和随手记继续跑着；点胶囊 / 托盘 / 快捷键随时展开');
  }
  return after;
}

/** 托盘「关闭动态桌面」：真销毁窗口 + enabled:false（下次启动不恢复）。 */
function closeLiveDesktop() {
  const live = require('./live/live');
  if (live.state() === 'closed') return 'closed';
  live.closeLive();
  notify('动态桌面已关闭', '随时可从托盘菜单重新启动');
  return 'closed';
}

/**
 * 托盘把自家能力注进来：控制组的 ⚙ 打开 Settings、状态变化重建托盘菜单。
 * 幂等（buildTrayMenu/createTray 每次调用只是重赋值）。
 */
function setupLiveHooks(hooks) {
  try {
    require('./live/live').setHooks(hooks);
  } catch (err) {
    console.error('[live] 钩子注入失败：', err.message);
  }
}

/**
 * 全局快捷键（Cmd/Ctrl+Shift+D，可在 live.json 的 shortcut 字段改）。
 * 注册前冲突检查：应用内已注册（包括其他 feature 注册的同名键）就不注册并 console.warn；
 * globalShortcut.register 返回 false（系统/其他 App 占用）同样只警告不覆盖。
 * 语义与托盘「展开/收起」一致：closed→open、open→hidden、hidden→open。
 */
function ensureLiveShortcut() {
  try {
    const { globalShortcut } = require('electron');
    const live = require('./live/live');
    const { validAccelerator } = require('./live/lifecycle');
    const cfg = live.loadCfg();
    let accel = DEFAULT_LIVE_ACCEL;
    if (typeof cfg.shortcut === 'string' && cfg.shortcut.trim()) {
      const v = validAccelerator(cfg.shortcut);
      if (v) accel = v;
      else console.warn(`[live] live.json 的 shortcut "${cfg.shortcut}" 不合法，回退默认 ${DEFAULT_LIVE_ACCEL}（例：CommandOrControl+Shift+D）`);
    }
    if (accel === liveShortcutAccel) return; // 幂等：同键不重复注册
    // 换键：先放下一个（只能是我们自己挂的——liveShortcutAccel 非空才说明注册成功过）
    if (liveShortcutAccel) {
      try { globalShortcut.unregister(liveShortcutAccel); } catch { /* 注销失败也不挡新键 */ }
      liveShortcutAccel = null;
    }
    if (globalShortcut.isRegistered(accel)) {
      console.warn(`[live] 快捷键 ${accel} 已被应用内其他功能占用，本次不注册（可在 live.json 改 shortcut 字段）`);
      liveShortcutAccel = accel; // 钉住，不每次重建菜单都刷 warn；改键或重启再试
      return;
    }
    let ok = false;
    try {
      ok = globalShortcut.register(accel, () => {
        try {
          require('./live/live').toggle(liveOutDir());
        } catch (err) {
          console.error('[live] 快捷键切换失败：', err.message);
        }
      });
    } catch {
      ok = false;
    }
    if (!ok) {
      console.warn(`[live] 快捷键 ${accel} 注册失败（可能被系统或其他 App 占用），本次不注册，托盘菜单不受影响`);
      liveShortcutAccel = accel; // 同样钉住防刷屏
      return;
    }
    liveShortcutAccel = accel;
    console.log(`[live] 全局快捷键已注册：${accel}（在 live.json 的 shortcut 字段可改）`);
  } catch (err) {
    console.error('[live] 快捷键注册入口失败：', err.message);
  }
}

// App 启动时按 live.json 的 enabled 自动恢复窗口（托盘重建菜单时调用，幂等）。
// 首次运行（还没有 live.json）视为 v0.5 升级：自动开启一次并告知用户如何关。
// v0.6.6：state=hidden 的恢复直接以胶囊形态登场，绝不先亮全尺寸窗再缩。
function ensureLiveAutostart() {
  if (liveStarted) return;
  try {
    const live = require('./live/live');
    const { normalizePersistedState } = require('./live/lifecycle');
    const firstRun = !live.hasSavedCfg();
    if (firstRun) live.saveCfg({ enabled: true, state: 'open' });
    const cfg = live.loadCfg();
    if (firstRun || cfg.enabled) {
      liveStarted = true;
      const persisted = firstRun ? 'open' : normalizePersistedState(cfg);
      live.open(liveOutDir(), { startHidden: persisted === 'hidden' }).catch((err) => console.error('[live] 自动恢复失败：', err.message));
      if (firstRun) {
        notify('动态桌面已就位 🖥️', '右下角是活的早报卡片，自动刷新；托盘菜单可随时收起、锁定或关闭');
      }
    }
  } catch (err) {
    console.error('[live] 自动恢复失败：', err.message);
  }
}

// ---------- v0.7 · 多智能体编排（工单看板；窗口长在动态桌面里，不新增窗口） ----------

/**
 * 编排概览（菜单文案与状态读数用）。
 *
 * 刻意**不缓存**：每次 buildTrayMenu 都现读 tickets.json + 会话快照，
 * 菜单文案因此永远等于当前真实状态（和 liveState() 同一纪律）。缓存布尔
 * 会让"刚派了单菜单还写着没有工单"这种不一致长期存在。
 */
function orchState(sessionSnapshot) {
  try {
    const { buildOrchView } = require('./orch');
    const view = buildOrchView({ snapshot: sessionSnapshot });
    return {
      active: view.active,
      total: view.summary.total,
      pending: view.summary.pending,
      activeCount: view.summary.active,
      stations: view.scene.stations.length,
      inbox: view.inbox.reduce((a, b) => a + b.unread, 0),
      cycles: view.cycles.length,
    };
  } catch (err) {
    console.error('[orch] 状态读取失败：', err.message);
    return { active: false, total: 0, pending: 0, activeCount: 0, stations: 0, inbox: 0, cycles: 0 };
  }
}

/**
 * 托盘「工单看板」：切到动态桌面的工单 tab。
 *
 * 这一步**不开新窗口**（Stage A 刚把窗口数量问题解决掉）：编排视图长在现有
 * 动态桌面组件的第二个 tab 里。动态桌面没开时不开它——用户没要求第二个窗口。
 */
function showOrchBoard() {
  try {
    const live = require('./live/live');
    if (live.state() === 'closed') {
      notify('动态桌面还没开', '工单看板是动态桌面里的第二个 tab；先点「启动动态桌面」');
      return { ok: false, reason: 'live-closed' };
    }
    live.setActiveTab('orch');
    if (live.state() === 'hidden') live.show();
    notify('工单看板 🎫', '逐条确认与派发仍走 CLI：npm run world:orch -- list');
    return { ok: true };
  } catch (err) {
    console.error('[orch] 工单看板失败：', err.message);
    notify('工单看板失败 ❌', err.message);
    return { ok: false, reason: err.message };
  }
}

/**
 * 派单可行性自检的托盘入口：只报告，不派。
 * 存在的意义是让"为什么派不出去"在菜单里就能看见，而不是逼用户去猜。
 */
function orchPreflight() {
  try {
    const store = require('./orch/store');
    const dispatch = require('./orch/dispatch');
    const { loadPrefs } = require('./orch/prefs-source');
    const { ticketsFile } = require('./orch/paths');
    const ledger = store.load(ticketsFile());
    const prefs = loadPrefs();
    const batch = dispatch.checkBatch(ledger.tickets, {
      prefs: prefs.ok ? prefs.snapshot : null,
    });
    if (batch.ok) {
      notify('派单自检通过 ✅', `${batch.checked} 张工单当前都可派`);
      return batch;
    }
    const head = batch.problems[0];
    notify(
      `派单自检未通过 ❌（${batch.problems.length} 项）`,
      `${head.reason}${head.fix ? ` → ${head.fix}` : ''}`,
    );
    return batch;
  } catch (err) {
    console.error('[orch] 自检失败：', err.message);
    notify('派单自检失败 ❌', err.message);
    return { ok: false, problems: [] };
  }
}

module.exports = {
  shareDaily,
  tidyDesktop,
  toggleLiveDesktop,
  closeLiveDesktop,
  liveState,
  isLiveOpen,
  setupLiveHooks,
  ensureLiveShortcut,
  ensureLiveAutostart,
  orchState,
  showOrchBoard,
  orchPreflight,
  DEFAULT_LIVE_ACCEL,
};
