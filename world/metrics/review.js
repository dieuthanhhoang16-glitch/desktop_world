// world/metrics/review.js
// desktop-world · 30 天复盘模板：数字直接引用 metrics report。
'use strict';

const fs = require('fs');
const path = require('path');

const { buildReport, pct } = require('./report');
const { reviewsDir } = require('./paths');

function fmt(value, fallback = '—') {
  return value == null ? fallback : String(value);
}

function renderReview(report) {
  const m = report.metrics;
  const rep = m.repetition;
  const cfg = m.config.latest;
  const cl = m.cleanup;
  const top = rep.topSubjects.slice(0, 3).map((s) => `${s.subject} ×${s.count}`).join('、') || '无';
  return [
    `# 30 天复盘 · ${report.sinceLabel} → ${report.untilLabel}`,
    '',
    '> 本模板由 `world:metrics review` 生成，数字直接引用同期报告。只填结论，不改数字。',
    '',
    '## 1. 我还在重复解释吗？',
    '',
    `- 重复解释/纠正事件：**${rep.events} 次**（解释 ${rep.explanations} · 纠正 ${rep.corrections}），上一周期 ${fmt(report.previous.repetition.events, '无数据')} 次`,
    `- 重复出现的主题：**${rep.repeatedSubjects} 个**（共 ${rep.repeatedEvents} 次）；最常重复：${top}`,
    `- 判断：${rep.repeatedSubjects === 0 ? '没有反复解释同一件事，说明记忆/角色配置在起作用。' : '仍有主题需要反复解释，下周期优先把它们写进记忆或角色卡。'}`,
    '',
    '## 2. 配置层是否更轻？',
    '',
  ].concat(
    cfg
      ? [
          `- 悬空索引条目：**${cfg.dangling}**（目标 0）`,
          `- 重复技能 / zip：**${cfg.duplicates}**（目标 0）`,
          `- 超预算层：${cfg.overBudget} · 技能总数：${cfg.skillsUnique} · 超 30 天 session：${cfg.sessionsOld}`,
          `- 判断：${cfg.dangling === 0 && cfg.duplicates === 0 ? '索引与技能没有悬空/重复。' : '仍有悬空或重复项，下周期运行配置审计并处理确认桶。'}`,
        ]
      : ['- 本周期没有配置审计快照。先运行 `npm run world:config-audit -- propose`，再生成复盘。'],
    [
      '',
      '## 3. 清理是否安全、值得？',
      '',
      `- 提案 **${cl.proposals} 个**，覆盖候选 **${cl.proposedCandidates} 项**`,
      `- 确认删除 **${cl.confirmedDeletes} 项**；采纳率 **${pct(cl.adoptionRate)}**`,
      `- 恢复 **${cl.restores} 项**；误删率 **${pct(cl.falseDeleteRate)}**`,
      `- 判断：${cl.confirmedDeletes === 0 ? '本周期没有执行删除，无法判断误删率。' : cl.restores === 0 ? '没有恢复记录，删除判断稳定。' : '出现恢复，检查候选证据与两轮复核的边界。'}`,
      '',
      '## 4. 结论（勾选一项）',
      '',
      '- [ ] 值得保留：继续按当前节奏运行',
      '- [ ] 需要调整：调整____（记忆层 / 角色权限 / 清理阈值 / 学习卡）',
      '- [ ] 停用：成本高于收益，停止自动提案与审计',
      '',
      '## 5. 下 30 天只做三件事',
      '',
      '1. ____',
      '2. ____',
      '3. ____',
      '',
      '---',
      `数据来源：\`${report.generatedAt}\` 生成的指标报告（${report.windowDays} 天窗口）。`,
      '指标日志不含原文、文件名或密钥。',
    ].join('\n')
  ).join('\n') + '\n';
}

function writeReview(metricsDir, report) {
  const dir = reviewsDir(metricsDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `review-${report.untilLabel}.md`);
  fs.writeFileSync(file, renderReview(report));
  return file;
}

function buildReview({ metricsDir, since, now } = {}) {
  const report = buildReport({ metricsDir, since, now });
  const file = writeReview(metricsDir, report);
  return { ok: true, file, report };
}

module.exports = { renderReview, writeReview, buildReview };
