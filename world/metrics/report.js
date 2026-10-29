// world/metrics/report.js
// desktop-world · 30 天指标报告：重复解释/纠正、配置层健康、清理采纳与误删。
//
// 报告只读 events.jsonl，不读取项目文件、会话内容或密钥。
'use strict';

const { readEvents } = require('./events');

const DAY = 24 * 3600 * 1000;
const DEFAULT_WINDOW_DAYS = 30;
const MAX_SERIES_DAYS = 366;

function parseSince(value, now) {
  if (value == null || value === '') {
    return { since: new Date(now.getTime() - DEFAULT_WINDOW_DAYS * DAY), label: '默认 30 天' };
  }
  const s = String(value).trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const ms = Date.parse(dateOnly ? `${s}T00:00:00.000Z` : s);
  if (!Number.isFinite(ms)) throw new Error(`无法解析 --since：${value}`);
  return { since: new Date(ms), label: s };
}

function eventMs(event) {
  const ms = Date.parse(event.at);
  return Number.isFinite(ms) ? ms : 0;
}

function inWindow(events, start, end, { inclusiveEnd = false } = {}) {
  return events.filter((e) => {
    const ms = eventMs(e);
    if (ms < start.getTime()) return false;
    return inclusiveEnd ? ms <= end.getTime() : ms < end.getTime();
  });
}

function n(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function aggregate(events) {
  let explanations = 0;
  let corrections = 0;
  const bySubject = new Map();
  const snapshots = [];
  const proposals = new Map();
  const executes = new Map();
  let restores = 0;
  let restoreEvents = 0;

  for (const e of events) {
    const count = n(e.counts.count) || 1;
    if (e.type === 'explanation') {
      explanations += count;
      const key = e.subject || '未标注';
      bySubject.set(key, (bySubject.get(key) || 0) + count);
    } else if (e.type === 'correction') {
      corrections += count;
      const key = e.subject || '未标注';
      bySubject.set(key, (bySubject.get(key) || 0) + count);
    } else if (e.type === 'config-snapshot') {
      snapshots.push(e);
    } else if (e.type === 'cleanup-proposal') {
      const key = e.ref || e.id;
      if (!proposals.has(key)) proposals.set(key, e);
    } else if (e.type === 'cleanup-execute') {
      const key = e.ref || e.id;
      if (!executes.has(key)) executes.set(key, e);
    } else if (e.type === 'cleanup-restore') {
      restores += n(e.counts.restored);
      restoreEvents += 1;
    }
  }

  const subjects = [...bySubject.entries()]
    .map(([subject, count]) => ({ subject, count }))
    .sort((a, b) => b.count - a.count || a.subject.localeCompare(b.subject));
  const repeated = subjects.filter((s) => s.count >= 2);

  snapshots.sort((a, b) => eventMs(a) - eventMs(b));
  const latestSnapshot = snapshots.length ? snapshots[snapshots.length - 1] : null;
  const firstSnapshot = snapshots.length ? snapshots[0] : null;
  const snapshotShape = (e) => (e ? {
    at: e.at,
    dangling: n(e.counts.dangling),
    duplicates: n(e.counts.duplicates),
    overBudget: n(e.counts.overBudget),
    skillsUnique: n(e.counts.skillsUnique),
    sessionsOld: n(e.counts.sessionsOld),
  } : null);

  let proposedCandidates = 0;
  let proposedConfirmed = 0;
  for (const e of proposals.values()) {
    proposedCandidates += n(e.counts.candidates);
    proposedConfirmed += n(e.counts.confirmed);
  }
  let confirmedDeletes = 0;
  for (const e of executes.values()) confirmedDeletes += n(e.counts.confirmed);

  return {
    repetition: {
      events: explanations + corrections,
      explanations,
      corrections,
      subjects: subjects.length,
      repeatedSubjects: repeated.length,
      repeatedEvents: repeated.reduce((sum, s) => sum + s.count, 0),
      topSubjects: subjects.slice(0, 10),
    },
    config: {
      snapshots: snapshots.length,
      latest: snapshotShape(latestSnapshot),
      first: snapshotShape(firstSnapshot),
      targetZero: {
        dangling: latestSnapshot ? n(latestSnapshot.counts.dangling) : null,
        duplicates: latestSnapshot ? n(latestSnapshot.counts.duplicates) : null,
      },
    },
    cleanup: {
      proposals: proposals.size,
      proposedCandidates,
      proposedConfirmed,
      confirmedDeletes,
      restores,
      restoreEvents,
      adoptionRate: proposedCandidates > 0 ? confirmedDeletes / proposedCandidates : null,
      falseDeleteRate: confirmedDeletes > 0 ? restores / confirmedDeletes : null,
      executes: executes.size,
    },
  };
}

function change(current, previous) {
  if (current == null || previous == null) return null;
  const delta = current - previous;
  let pct = null;
  if (previous !== 0) pct = delta / previous;
  else pct = current === 0 ? 0 : null;
  return { previous, current, delta, pct };
}

function buildSeries(events, since, until) {
  const days = Math.min(MAX_SERIES_DAYS, Math.max(0, Math.floor((until.getTime() - since.getTime()) / DAY)));
  const buckets = new Map();
  for (let i = 0; i < days; i += 1) {
    const date = new Date(since.getTime() + i * DAY).toISOString().slice(0, 10);
    buckets.set(date, { date, explanations: 0, corrections: 0, confirmed: 0, restored: 0 });
  }
  for (const e of events) {
    const date = new Date(eventMs(e)).toISOString().slice(0, 10);
    const b = buckets.get(date);
    if (!b) continue;
    if (e.type === 'explanation') b.explanations += n(e.counts.count) || 1;
    else if (e.type === 'correction') b.corrections += n(e.counts.count) || 1;
    else if (e.type === 'cleanup-execute') b.confirmed += n(e.counts.confirmed);
    else if (e.type === 'cleanup-restore') b.restored += n(e.counts.restored);
  }
  return [...buckets.values()];
}

/**
 * @param {object} opts
 * @param {string} [opts.metricsDir]
 * @param {string|Date} [opts.since] YYYY-MM-DD 或 ISO
 * @param {Function|Date} [opts.now]
 */
function buildReport({ metricsDir, since, now = () => new Date() } = {}) {
  const at = typeof now === 'function' ? now() : now;
  const parsed = parseSince(since, at);
  const start = parsed.since;
  let end = at;
  if (start.getTime() >= end.getTime()) end = new Date(start.getTime() + DAY);
  const span = end.getTime() - start.getTime();
  const prevStart = new Date(start.getTime() - span);
  const all = readEvents(metricsDir);
  const currentEvents = inWindow(all, start, end, { inclusiveEnd: true });
  const previousEvents = inWindow(all, prevStart, start);
  const current = aggregate(currentEvents);
  const previous = aggregate(previousEvents);
  const days = Math.max(1, Math.floor(span / DAY));
  const dated = (d) => d.toISOString().slice(0, 10);

  return {
    schemaVersion: 1,
    generatedAt: at.toISOString(),
    since: start.toISOString(),
    until: end.toISOString(),
    sinceLabel: dated(start),
    untilLabel: dated(end),
    windowDays: days,
    hasData: currentEvents.length > 0,
    metrics: current,
    previous,
    trend: {
      repetitionEvents: change(current.repetition.events, previous.repetition.events),
      repeatedSubjects: change(current.repetition.repeatedSubjects, previous.repetition.repeatedSubjects),
      confirmedDeletes: change(current.cleanup.confirmedDeletes, previous.cleanup.confirmedDeletes),
      adoptionRate: change(current.cleanup.adoptionRate, previous.cleanup.adoptionRate),
      falseDeleteRate: change(current.cleanup.falseDeleteRate, previous.cleanup.falseDeleteRate),
      config: {
        first: current.config.first,
        latest: current.config.latest,
        danglingDelta: current.config.first && current.config.latest ? current.config.latest.dangling - current.config.first.dangling : null,
        duplicatesDelta: current.config.first && current.config.latest ? current.config.latest.duplicates - current.config.first.duplicates : null,
      },
    },
    series: buildSeries(currentEvents, start, end),
  };
}

function pct(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

function arrow(trend, { good = 'down' } = {}) {
  if (!trend) return '无上一周期数据';
  if (trend.delta === 0) return '持平';
  const dir = trend.delta > 0 ? 'up' : 'down';
  const symbol = dir === 'up' ? '↑' : '↓';
  const amount = trend.pct == null ? `${trend.delta}` : `${Math.abs(trend.pct * 100).toFixed(1)}%`;
  const verdict = dir === good ? '好转' : '变差';
  return `${symbol} ${amount}（${verdict}）`;
}

function renderReport(report) {
  const m = report.metrics;
  const lines = [
    `# 指标报告 · ${report.sinceLabel} → ${report.untilLabel}（${report.windowDays} 天）`,
    '',
  ];
  if (!report.hasData) lines.push('> 本周期还没有事件记录。用 `world:metrics record` 记录解释/纠正，或运行清理与配置审计。', '');
  lines.push(
    '## ① 重复解释 / 纠正',
    '',
    `- 事件：${m.repetition.events} 次（解释 ${m.repetition.explanations} · 纠正 ${m.repetition.corrections}）`,
    `- 涉及主题：${m.repetition.subjects} 个；重复出现（≥2 次）：${m.repetition.repeatedSubjects} 个，共 ${m.repetition.repeatedEvents} 次`,
    `- 趋势：${arrow(report.trend.repetitionEvents)}`,
  );
  if (m.repetition.topSubjects.length) {
    lines.push('- 最常重复：' + m.repetition.topSubjects.slice(0, 5).map((s) => `${s.subject} ×${s.count}`).join(' · '));
  }
  lines.push(
    '',
    '## ② 配置层健康',
    '',
  );
  if (!m.config.latest) {
    lines.push('- 尚无审计快照。运行 `npm run world:config-audit -- audit` 或 `metrics snapshot-config`。');
  } else {
    const c = m.config.latest;
    lines.push(
      `- 悬空索引条目：${c.dangling}（目标 0）`,
      `- 重复技能 / zip：${c.duplicates}（目标 0）`,
      `- 超预算层：${c.overBudget} · 技能总数：${c.skillsUnique} · 超 30 天 session：${c.sessionsOld}`,
      `- 快照：${c.at} · 本周期共 ${m.config.snapshots} 次`,
    );
    if (report.trend.config.danglingDelta != null) {
      lines.push(`- 周期内变化：悬空 ${report.trend.config.danglingDelta >= 0 ? '+' : ''}${report.trend.config.danglingDelta} · 重复 ${report.trend.config.duplicatesDelta >= 0 ? '+' : ''}${report.trend.config.duplicatesDelta}`);
    }
  }
  lines.push(
    '',
    '## ③ 清理采纳与误删',
    '',
    `- 提案：${m.cleanup.proposals} 个，覆盖候选 ${m.cleanup.proposedCandidates} 项`,
    `- 确认删除：${m.cleanup.confirmedDeletes} 项（执行 ${m.cleanup.executes} 次）`,
    `- 采纳率（确认删除 / 候选）：${pct(m.cleanup.adoptionRate)} · 趋势：${arrow(report.trend.adoptionRate, { good: 'up' })}`,
    `- 恢复：${m.cleanup.restores} 项 · 误删率（恢复 / 确认删除）：${pct(m.cleanup.falseDeleteRate)} · 趋势：${arrow(report.trend.falseDeleteRate, { good: 'down' })}`,
    '',
    '> 报告只读本地事件日志；不含原文、文件名或密钥。',
  );
  return lines.join('\n') + '\n';
}

module.exports = {
  DAY,
  DEFAULT_WINDOW_DAYS,
  parseSince,
  aggregate,
  buildReport,
  renderReport,
  pct,
};
