// world/app-integration.js
// desktop-world · 桌宠 App 内的接入口（托盘/右键菜单调用）。
// 与独立 CLI 的区别：输出目录用 userData，用系统通知反馈进度。
'use strict';

const fs = require('fs');
const path = require('path');
const { runDaily } = require('./pipeline');

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

// 托盘菜单入口：生成今日早报壁纸。重复点击做防抖（只跑一条流水线）。
async function runDailyWallpaper() {
  if (running) {
    notify('早报生成中…', '上一条流水线还没跑完，稍等一下');
    return;
  }
  running = true;
  const startedAt = Date.now();
  try {
    const { app } = require('electron');
    const outDir = path.join(app.getPath('userData'), 'world');
    notify('早报生成中…', '采集今日 Claude Code 活动');
    const { report, pngPath } = await runDaily({
      outDir,
      setWallpaper: true,
      onStep: (msg) => console.log(`[world] ${msg}`),
    });
    const secs = Math.round((Date.now() - startedAt) / 1000);
    notify('今日早报已贴上桌面 🌅', `${report.oneline}（${secs}s）`);
    console.log(`[world] 壁纸文件：${pngPath}`);
  } catch (err) {
    console.error('[world] 生成失败：', err);
    notify('早报生成失败 ❌', err.message || String(err));
  } finally {
    running = false;
  }
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
      notify('还没有可分享的日报', '先点一次「生成今日早报壁纸」');
      return;
    }
    const { share } = require('./share');
    const { ok, results, hint } = await share({
      report,
      imagePath: path.join(outDir, `wallpaper-${report.meta.date}.png`),
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

let liveStarted = false;

function liveOutDir() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'world');
}

function isLiveOpen() {
  try {
    return require('./live/live').isOpen();
  } catch {
    return false;
  }
}
// 菜单用：true = 当前可拖动（未开穿透）
function isLiveDraggable() {
  try {
    const live = require('./live/live');
    return live.isOpen() && live.isLiveClickable();
  } catch {
    return false;
  }
}

function toggleLiveDesktop() {
  const live = require('./live/live');
  const { open } = live.toggle(liveOutDir());
  if (open) {
    liveStarted = true;
    const cfg = live.loadCfg();
    notify(
      '动态桌面已开启 🖥️',
      `${cfg.clickThrough ? '点击穿透、不影响操作' : '可拖动位置'}，每 ${cfg.refreshMin} 分钟自动刷新数据`
    );
  } else {
    notify('动态桌面已关闭', '烘焙壁纸还是原样，不影响');
  }
  return open;
}

function toggleLiveDrag() {
  const live = require('./live/live');
  if (!live.isOpen()) {
    notify('动态桌面还没开', '先点「开启动态桌面」');
    return null;
  }
  const { clickThrough } = live.toggleClickThrough();
  notify(clickThrough ? '已锁定：点击穿透 🔒' : '已解锁：可以拖动 ↔️', clickThrough ? '鼠标会直接点到桌面图标' : '调整好后记得再锁回去');
  return clickThrough;
}

// App 启动时按 live.json 的 enabled 自动恢复窗口（托盘重建菜单时调用，幂等）。
function ensureLiveAutostart() {
  if (liveStarted) return;
  try {
    const live = require('./live/live');
    if (live.loadCfg().enabled) {
      liveStarted = true;
      live.open(liveOutDir()).catch((err) => console.error('[live] 自动恢复失败：', err.message));
    }
  } catch (err) {
    console.error('[live] 自动恢复失败：', err.message);
  }
}

module.exports = { runDailyWallpaper, shareDaily, tidyDesktop, toggleLiveDesktop, toggleLiveDrag, isLiveOpen, isLiveDraggable, ensureLiveAutostart };
