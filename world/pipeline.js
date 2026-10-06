// world/pipeline.js
// desktop-world · 每日流水线：采集 → 总结 → 落盘报告 → 烘焙壁纸。
// 被 cli.js（electron 命令行）和 app-integration.js（App 内菜单）共用。
'use strict';

const fs = require('fs');
const path = require('path');
const { collect } = require('./collector');
const { summarize } = require('./summarizer');
const { worldForReport, worldForReuse } = require('./garden');
const { prepareWatch } = require('./watch/state');

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

// 把今日卡点/技术总结写成可在系统里直接打开的 md。
// 生成/复用报告后调用；没料就不写文件（UI 也会静默）。返回写出的文件路径数组。
function writeDayNotes(outDir, report) {
  const date = report.meta && report.meta.date;
  if (!date) return [];
  const hour = String(new Date().getHours()).padStart(2, '0');
  const minute = String(new Date().getMinutes()).padStart(2, '0');
  const sections = [
    ['blockers', '今日卡点', report.blockers, '从会话标题反推，可能有误报，点开对照当天记录自己判断。'],
    ['tips', '技术总结', report.techTips, '今天沉淀的可复用经验；能落地的建议配合"明日新思路"一起用。'],
  ];
  const files = [];
  for (const [key, title, list, foot] of sections) {
    if (!Array.isArray(list) || !list.length) continue;
    const body = [
      `# ${date} ${title}`,
      '',
      ...list.map((x) => `- ${x}`),
      '',
      '---',
      `_由 Desktop World 日报生成（${report.source === 'claude' ? '本地 Claude' : '本地模板'}，${hour}:${minute}）。${foot}_`,
      '',
    ].join('\n');
    const file = path.join(outDir, `${key}-${date}.md`);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(file, body);
    files.push(file);
  }
  return files;
}

/**
 * @param {object} opts
 * @param {string} opts.outDir
 * @param {boolean} [opts.noLlm]        跳过 claude 调用，用模板总结
 * @param {boolean} [opts.reuseReport]  用最近一次已生成的报告直接烘焙（调模板样式用）
 * @param {(msg:string)=>void} [opts.onStep]
 * @returns {Promise<{report:object, pngPath:string, reportFile:string}>}
 */
async function runDaily({ outDir, noLlm = false, reuseReport = false, onStep = () => {} }) {
  // bake 依赖 Electron，这里惰性 require 让 collector/summarizer 可在纯 Node 单测。
  // 产物只有 PNG（分享底稿）；本仓库没有任何代码路径会设置系统桌面壁纸。
  const { bakePng } = require('./bake');

  let report = null;
  if (reuseReport) {
    report = loadLatestReport(outDir);
    if (!report) throw new Error(`--reuse：在 ${outDir} 找不到任何 daily-*.json，请先跑一次完整流水线`);
    onStep(`复用报告：${report.meta.date}`);
    // 复用旧报告时没有 digest 可结算，优先沿用报告里保存的世界快照，没有再读当前状态
    if (!report.world) report.world = worldForReuse(outDir);
  } else {
    onStep('采集今日 Claude Code 活动…');
    const digest = await collect();
    onStep(`采集完成：${digest.totals.sessions} 个会话 / ${digest.totals.toolCalls} 次工具调用`);
    // 专案追踪：给会话标分类（学习/工作/…）+ 结算各文件夹累计进度（同日幂等）
    const watch = prepareWatch(outDir, digest, digest.date);
    if (watch.active) {
      const todayWatched = watch.list.filter((w) => w.today > 0);
      if (todayWatched.length) onStep(`专案：${todayWatched.map((w) => `${w.name}×${w.today}`).join(' · ')}`);
    }
    onStep('调用本地 claude 生成一句话总结…');
    const summary = await summarize(digest, { noLlm });
    report = {
      meta: { date: digest.date, weekday: digest.weekday, generatedAt: digest.generatedAt, source: digest.source },
      digest,
      watch: watch.active ? watch : undefined,
      oneline: summary.oneline,
      ideas: summary.ideas,
      sessionBriefs: summary.sessionBriefs, // 每条会话的"干了什么"（顺序对应 digest.sessions 前 10 条）
      blockers: summary.blockers, // 今日卡点（LLM 有料才有，UI 对空静默）
      techTips: summary.techTips, // 技术总结 tips
      source: summary.source,
    };
    // 生长世界：把今日成果结算进持久世界（同日重复运行幂等，不重复加分）
    report.world = worldForReport(outDir, digest, digest.date);
    onStep(`世界结算：Lv${report.world.level} ${report.world.stageIcon}${report.world.stageName}（+${report.world.todayXp}xp，连续耕种第 ${report.world.streak} 天）`);
  }

  const reportFile = saveReport(outDir, report);
  onStep(`报告已保存：${reportFile}`);

  // 今日卡点 / 技术总结写成 md（动态桌面里点 chip 打开的就是这两个文件；没料就不写）
  const mdFiles = writeDayNotes(outDir, report);
  if (mdFiles.length) onStep(`随笔 md：${mdFiles.map((f) => path.basename(f)).join('、')}`);

  onStep('渲染早报 PNG…');
  const pngPath = await bakePng({ report, outDir });
  onStep(`早报 PNG 已生成（不设壁纸）：${pngPath}`);
  return { report, pngPath, reportFile };
}

module.exports = { runDaily, loadLatestReport, saveReport, writeDayNotes };
