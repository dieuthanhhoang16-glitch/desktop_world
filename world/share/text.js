// world/share/text.js · 把每日报告拼成分享文案（纯函数，无 I/O）。
'use strict';

function cnDate(dateStr) {
  if (!dateStr) return '';
  const m = +dateStr.slice(5, 7);
  const d = +dateStr.slice(8, 10);
  return `${m}月${d}日`;
}

/**
 * @returns {{title:string, markdown:string, lines:string[]}}
 * 注意：title 固定含"日报"二字 —— 钉钉/飞书机器人若开了关键词安全校验，
 * 把关键词设成"日报"即可通过（README 有说明）。
 */
function buildShareText(report) {
  const meta = report.meta || {};
  const digest = report.digest || {};
  const t = digest.totals || {};
  const top = (digest.topTools || []).slice(0, 3).map((x) => `${x.name}×${x.count}`).join(' ');

  const title = `🌅 Desktop World 日报 · ${cnDate(meta.date)} ${meta.weekday || ''}`.trim();
  const lines = [title, '', report.oneline || '今天还没有总结。'];

  const ideas = (report.ideas || []).slice(0, 3);
  if (ideas.length) {
    lines.push('', '💡 新思路：');
    ideas.forEach((idea, i) => lines.push(`　${i + 1}. ${idea}`));
  }

  const stats = [`会话 ${t.sessions || 0}`, `输入 ${t.prompts || 0}`, `工具调用 ${t.toolCalls || 0}`];
  if (top) stats.push(`高频 ${top}`);
  const cats = report.watch && report.watch.categories;
  if (cats && Object.keys(cats).length) {
    stats.push(Object.entries(cats).map(([c, n]) => `${c}×${n}`).join(' '));
  }
  lines.push('', `📊 ${stats.join(' · ')}`);

  // 专案追踪：今天动了哪些被 watch 的文件夹
  const watchedToday = ((report.watch && report.watch.list) || []).filter((w) => w.today > 0);
  if (watchedToday.length) {
    lines.push(`📌 今日专案：${watchedToday.map((w) => `${w.name} ×${w.today}（累计 ${w.days} 天，连击 ${w.streak}🔥）`).join('、')}`);
  }

  // 生长世界状态（v0.4+ 的日报都会有；旧报告没有就跳过）
  const w = report.world;
  if (w && typeof w.level === 'number') {
    const next = w.next ? `，距「${w.next.icon}${w.next.name}」还差 ${w.next.remain}xp` : '，已满级';
    lines.push(`🗺️ 世界 Lv${w.level} ${w.stageIcon}${w.stageName} · 连续耕种 ${w.streak} 天${next}`);
  }
  lines.push('', '#DesktopWorld日报');

  return { title, markdown: lines.join('\n'), lines };
}

module.exports = { buildShareText };
