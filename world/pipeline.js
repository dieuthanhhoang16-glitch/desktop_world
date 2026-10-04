// world/pipeline.js
// desktop-world · 每日流水线：采集 → 总结 → 落盘报告 → 烘焙壁纸。
// 被 cli.js（electron 命令行）和 app-integration.js（App 内菜单）共用。
'use strict';

const fs = require('fs');
const path = require('path');
const { collect } = require('./collector');
const { summarize } = require('./summarizer');

function reportPath(outDir, date) {
  return path.join(outDir, `daily-${date}.json`);
}

function saveReport(outDir, report) {
  fs.mkdirSync(outDir, { recursive: true });
  const file = reportPath(outDir, report.meta.date);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}

// 找 outDir 里最新的一份 daily-*.json（--reuse 模式用）。
function loadLatestReport(outDir) {
  try {
    const files = fs
      .readdirSync(outDir)
      .filter((f) => /^daily-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort();
    if (!files.length) return null;
    return JSON.parse(fs.readFileSync(path.join(outDir, files[files.length - 1]), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.outDir
 * @param {boolean} [opts.setWallpaper=true]
 * @param {boolean} [opts.noLlm]        跳过 claude 调用，用模板总结
 * @param {boolean} [opts.reuseReport]  用最近一次已生成的报告直接烘焙（调模板样式用）
 * @param {(msg:string)=>void} [opts.onStep]
 * @returns {Promise<{report:object, pngPath:string, reportFile:string}>}
 */
async function runDaily({ outDir, setWallpaper = true, noLlm = false, reuseReport = false, onStep = () => {} }) {
  // bake 依赖 Electron，这里惰性 require 让 collector/summarizer 可在纯 Node 单测
  const { bakeWallpaper } = require('./bake');

  let report = null;
  if (reuseReport) {
    report = loadLatestReport(outDir);
    if (!report) throw new Error(`--reuse：在 ${outDir} 找不到任何 daily-*.json，请先跑一次完整流水线`);
    onStep(`复用报告：${report.meta.date}`);
  } else {
    onStep('采集今日 Claude Code 活动…');
    const digest = await collect();
    onStep(`采集完成：${digest.totals.sessions} 个会话 / ${digest.totals.toolCalls} 次工具调用`);
    onStep('调用本地 claude 生成一句话总结…');
    const summary = await summarize(digest, { noLlm });
    report = {
      meta: { date: digest.date, weekday: digest.weekday, generatedAt: digest.generatedAt, source: digest.source },
      digest,
      oneline: summary.oneline,
      ideas: summary.ideas,
      source: summary.source,
    };
  }

  const reportFile = saveReport(outDir, report);
  onStep(`报告已保存：${reportFile}`);

  onStep('渲染壁纸…');
  const pngPath = await bakeWallpaper({ report, outDir, setWallpaper });
  onStep(setWallpaper ? `壁纸已设置：${pngPath}` : `壁纸 PNG 已生成（未设置）：${pngPath}`);
  return { report, pngPath, reportFile };
}

module.exports = { runDaily, loadLatestReport, saveReport };
