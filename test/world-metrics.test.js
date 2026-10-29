// test/world-metrics.test.js
// desktop-world · ticket 14：指标事件、30 天报告与复盘模板。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { appendEvent, readEvents, recordExplanation, recordCorrection, recordConfigSnapshot } = require('../world/metrics/events');
const { buildReport, renderReport, aggregate } = require('../world/metrics/report');
const { buildReview, renderReview } = require('../world/metrics/review');
const { eventsFile } = require('../world/metrics/paths');

const NOW = new Date('2026-10-18T12:00:00.000Z');
const SINCE = '2026-09-18';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function add(metricsDir, raw) {
  const result = appendEvent(metricsDir, raw, { now: () => NOW });
  assert.equal(result.ok, true);
  return result;
}

function seed(metricsDir) {
  // 本周期：同一主题被重复解释/纠正
  add(metricsDir, { type: 'explanation', subject: '回复长度', at: '2026-10-01T10:00:00.000Z', counts: { count: 3 }, ref: 'e1' });
  add(metricsDir, { type: 'correction', subject: '回复长度', at: '2026-10-02T10:00:00.000Z', counts: { count: 1 }, ref: 'e2' });
  add(metricsDir, { type: 'correction', subject: '工单流程', at: '2026-10-03T10:00:00.000Z', counts: { count: 1 }, ref: 'e3' });

  // 上一周期
  add(metricsDir, { type: 'explanation', subject: '回复长度', at: '2026-08-25T10:00:00.000Z', counts: { count: 2 }, ref: 'p1' });
  add(metricsDir, { type: 'correction', subject: '工单流程', at: '2026-08-26T10:00:00.000Z', counts: { count: 1 }, ref: 'p2' });

  // 配置快照：周期内从差变好
  add(metricsDir, { type: 'config-snapshot', subject: 'config', at: '2026-09-20T10:00:00.000Z', counts: { dangling: 4, duplicates: 3, overBudget: 1, skillsUnique: 24, sessionsOld: 10 } });
  add(metricsDir, { type: 'config-snapshot', subject: 'config', at: '2026-10-15T10:00:00.000Z', counts: { dangling: 1, duplicates: 0, overBudget: 0, skillsUnique: 20, sessionsOld: 2 } });

  // 清理：2 个提案、16 个候选、确认删除 7、恢复 1
  add(metricsDir, { type: 'cleanup-proposal', subject: 'project-cleanup', ref: 'cleanup-a', at: '2026-09-25T10:00:00.000Z', counts: { candidates: 10, confirmed: 4, proposals: 1 } });
  add(metricsDir, { type: 'cleanup-proposal', subject: 'project-cleanup', ref: 'cleanup-b', at: '2026-10-05T10:00:00.000Z', counts: { candidates: 6, confirmed: 3, proposals: 1 } });
  add(metricsDir, { type: 'cleanup-execute', subject: 'project-cleanup', ref: 'cleanup-a', at: '2026-09-26T10:00:00.000Z', counts: { confirmed: 4, removed: 3, moved: 1, failed: 0 } });
  add(metricsDir, { type: 'cleanup-execute', subject: 'project-cleanup', ref: 'cleanup-b', at: '2026-10-06T10:00:00.000Z', counts: { confirmed: 3, removed: 3, moved: 0, failed: 0 } });
  add(metricsDir, { type: 'cleanup-restore', subject: 'project-cleanup', ref: 'cleanup-a:restore:2026-09-28', at: '2026-09-28T10:00:00.000Z', counts: { restored: 1 } });

  // 上一周期清理：采纳率 50%，误删率 0
  add(metricsDir, { type: 'cleanup-proposal', subject: 'project-cleanup', ref: 'cleanup-0', at: '2026-08-20T10:00:00.000Z', counts: { candidates: 4, confirmed: 2, proposals: 1 } });
  add(metricsDir, { type: 'cleanup-execute', subject: 'project-cleanup', ref: 'cleanup-0', at: '2026-08-21T10:00:00.000Z', counts: { confirmed: 2, removed: 2, moved: 0, failed: 0 } });
}

test('事件日志只保留白名单字段：不含原文、密钥，且 ref 幂等', (t) => {
  const dir = tmp(t);
  const bad = appendEvent(dir, { type: 'explanation', subject: 'sk-ant-api03-secret', at: NOW.toISOString(), counts: { count: 1 } }, { now: () => NOW });
  assert.equal(bad.ok, true);
  assert.equal(bad.event.subject, null);

  add(dir, {
    type: 'cleanup-proposal',
    subject: 'project-cleanup',
    ref: 'cleanup-x',
    at: NOW.toISOString(),
    counts: { candidates: 2, confirmed: 1 },
    text: '这是不应落盘的原文',
    path: '/Users/private/project/file.js',
  });
  const dup = appendEvent(dir, { type: 'cleanup-proposal', subject: 'project-cleanup', ref: 'cleanup-x', counts: { candidates: 99 } }, { now: () => NOW });
  assert.equal(dup.duplicate, true);

  const text = fs.readFileSync(eventsFile(dir), 'utf8');
  assert.ok(!text.includes('sk-ant'));
  assert.ok(!text.includes('不应落盘'));
  assert.ok(!text.includes('/Users/private'));
  assert.equal(readEvents(dir).length, 2);
  assert.equal(fs.statSync(eventsFile(dir)).mode & 0o777, 0o600);
});

test('30 天报告：三项指标、趋势与每日序列', (t) => {
  const dir = tmp(t);
  seed(dir);
  const report = buildReport({ metricsDir: dir, since: SINCE, now: () => NOW });

  assert.equal(report.windowDays, 30);
  assert.equal(report.hasData, true);
  assert.equal(report.metrics.repetition.events, 5);
  assert.equal(report.metrics.repetition.explanations, 3);
  assert.equal(report.metrics.repetition.corrections, 2);
  assert.equal(report.metrics.repetition.repeatedSubjects, 1); // 回复长度 4 次；工单流程 1 次
  assert.equal(report.metrics.repetition.repeatedEvents, 4);
  assert.equal(report.metrics.repetition.topSubjects[0].subject, '回复长度');
  assert.equal(report.trend.repetitionEvents.previous, 3);
  assert.equal(report.trend.repetitionEvents.delta, 2);

  assert.equal(report.metrics.config.latest.dangling, 1);
  assert.equal(report.metrics.config.latest.duplicates, 0);
  assert.equal(report.metrics.config.first.dangling, 4);
  assert.equal(report.trend.config.danglingDelta, -3);
  assert.equal(report.trend.config.duplicatesDelta, -3);

  assert.equal(report.metrics.cleanup.proposals, 2);
  assert.equal(report.metrics.cleanup.proposedCandidates, 16);
  assert.equal(report.metrics.cleanup.confirmedDeletes, 7);
  assert.equal(report.metrics.cleanup.restores, 1);
  assert.equal(report.metrics.cleanup.adoptionRate, 7 / 16);
  assert.equal(report.metrics.cleanup.falseDeleteRate, 1 / 7);
  assert.equal(report.previous.cleanup.adoptionRate, 2 / 4);
  assert.equal(report.previous.cleanup.falseDeleteRate, 0);

  assert.equal(report.series.length, 30);
  const day = report.series.find((d) => d.date === '2026-10-01');
  assert.equal(day.explanations, 3);
  const execDay = report.series.find((d) => d.date === '2026-09-26');
  assert.equal(execDay.confirmed, 4);

  const md = renderReport(report);
  assert.match(md, /重复解释 \/ 纠正/);
  assert.match(md, /配置层健康/);
  assert.match(md, /清理采纳与误删/);
  assert.match(md, /43\.8%/);
  assert.match(md, /14\.3%/);
  assert.match(md, /不含原文、文件名或密钥/);
});

test('报告无事件时给出空态，不崩', (t) => {
  const dir = tmp(t);
  const report = buildReport({ metricsDir: dir, since: SINCE, now: () => NOW });
  assert.equal(report.hasData, false);
  assert.equal(report.metrics.cleanup.adoptionRate, null);
  assert.match(renderReport(report), /本周期还没有事件记录/);
});

test('30 天复盘模板直接引用报告数字', (t) => {
  const dir = tmp(t);
  seed(dir);
  const built = buildReview({ metricsDir: dir, since: SINCE, now: () => NOW });
  assert.equal(built.ok, true);
  assert.ok(fs.existsSync(built.file));
  assert.match(built.file, /reviews[/\\]review-2026-10-18\.md$/);
  const md = fs.readFileSync(built.file, 'utf8');
  assert.match(md, /# 30 天复盘/);
  assert.match(md, /本周期|重复解释\/纠正事件：\*\*5 次\*\*/);
  assert.match(md, /采纳率 \*\*43\.8%\*\*/);
  assert.match(md, /误删率 \*\*14\.3%\*\*/);
  assert.match(md, /值得保留/);
  assert.match(md, /指标日志不含原文、文件名或密钥/);
});

test('CLI：record、snapshot-config、import-orch 幂等且不导入原文', (t) => {
  const dir = tmp(t);
  const claude = path.join(dir, 'claude');
  const mem = path.join(claude, 'memory');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), '# 索引\n\n- [缺失](gone.md) — x\n');

  const cli = path.join(__dirname, '..', 'world', 'metrics', 'cli.js');
  const run = (...args) => {
    const res = spawnSync(process.execPath, [cli, ...args, '--metrics-dir', dir], { encoding: 'utf8' });
    return res;
  };

  const rec = run('record', '--type', 'correction', '--subject', '回复长度', '--count', '2', '--json');
  assert.equal(rec.status, 0, rec.stderr);
  assert.equal(JSON.parse(rec.stdout).event.counts.count, 2);

  const bad = run('record', '--type', 'explanation', '--subject', 'sk-ant-api03-abcdef');
  assert.notEqual(bad.status, 0);
  assert.ok(!fs.readFileSync(eventsFile(dir), 'utf8').includes('sk-ant'));

  const snap = run('snapshot-config', '--claude-dir', claude, '--json');
  assert.equal(snap.status, 0, snap.stderr);
  const snapJson = JSON.parse(snap.stdout);
  assert.equal(snapJson.dangling, 1);
  assert.equal(snapJson.duplicates, 0);

  const orch = path.join(dir, 'orch');
  fs.mkdirSync(orch, { recursive: true });
  const recent = Date.now() - 3600 * 1000;
  fs.writeFileSync(path.join(orch, 'blackboard.json'), JSON.stringify({
    entries: [
      { id: 'bb-0001', at: recent, kind: 'correction', text: '这是黑板原文，不应导入', ticketIds: ['ORCH-001'] },
      { id: 'bb-0002', at: recent - 1000, kind: 'correction', text: '另一段原文', ticketIds: [] },
      { id: 'bb-0003', at: recent - 2000, kind: 'fact', text: '事实' },
    ],
  }));
  const imp = run('import-orch', '--orch-dir', orch, '--json');
  assert.equal(imp.status, 0, imp.stderr);
  assert.equal(JSON.parse(imp.stdout).recorded, 2);
  const imp2 = run('import-orch', '--orch-dir', orch, '--json');
  assert.equal(JSON.parse(imp2.stdout).recorded, 0);
  assert.equal(JSON.parse(imp2.stdout).skipped, 2);

  const events = readEvents(dir);
  assert.equal(events.filter((e) => e.source === 'orch').length, 2);
  assert.ok(events.some((e) => e.subject === 'ticket:ORCH-001'));
  const text = fs.readFileSync(eventsFile(dir), 'utf8');
  assert.ok(!text.includes('黑板原文'));
  assert.ok(!text.includes('另一段原文'));

  const rep = run('report', '--since', SINCE, '--json');
  assert.equal(rep.status, 0, rep.stderr);
  const report = JSON.parse(rep.stdout);
  assert.equal(report.metrics.repetition.corrections, 4); // 2 条 CLI + 2 条导入
  assert.equal(report.metrics.config.latest.dangling, 1);
});

test('aggregate 对重复执行同一提案只计一次', () => {
  const events = [
    { type: 'cleanup-proposal', ref: 'a', counts: { candidates: 4 } },
    { type: 'cleanup-execute', ref: 'a', counts: { confirmed: 2 } },
    { type: 'cleanup-execute', ref: 'a', counts: { confirmed: 2 } },
    { type: 'cleanup-restore', ref: 'a:restore:1', counts: { restored: 1 } },
    { type: 'cleanup-restore', ref: 'a:restore:2', counts: { restored: 1 } },
  ];
  const agg = aggregate(events);
  assert.equal(agg.cleanup.proposals, 1);
  assert.equal(agg.cleanup.confirmedDeletes, 2);
  assert.equal(agg.cleanup.restores, 2);
  assert.equal(agg.cleanup.falseDeleteRate, 1);
});
