#!/usr/bin/env node
// world/metrics/cli.js
// desktop-world · 指标记录与 30 天报告 CLI：
//   record / snapshot-config / import-orch / report / review
'use strict';

const fs = require('fs');
const path = require('path');

const { metricsRoot, reportsDir } = require('./paths');
const {
  normalizeSubject,
  recordExplanation,
  recordCorrection,
  recordConfigSnapshot,
} = require('./events');
const { auditConfig } = require('../config-audit/audit');
const { buildReport, renderReport } = require('./report');
const { buildReview, renderReview } = require('./review');
const { blackboardFile } = require('../orch/paths');

function has(name) {
  return process.argv.includes(name);
}

function flagVal(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

function print(value, json) {
  process.stdout.write((json ? JSON.stringify(value, null, 2) : typeof value === 'string' ? value : JSON.stringify(value, null, 2)) + '\n');
}

function usage() {
  return `用法: node world/metrics/cli.js <命令>

  record          --type explanation|correction --subject <短标签> [--count N] [--source S]
  snapshot-config [--claude-dir DIR] [--root DIR]        记录一次配置审计快照（只记计数）
  import-orch     [--orch-dir DIR]                       从编排黑板导入 correction 事件（只记 id）
  report          [--since YYYY-MM-DD] [--out FILE]       三项指标 + 与上一周期趋势
  review          [--since YYYY-MM-DD] [--out FILE]       30 天复盘模板（数字引用报告）

公共参数：--metrics-dir DIR（默认 ~/.desktop-world/metrics）--json
`;
}

function requireSubject(raw) {
  const subject = normalizeSubject(raw);
  if (!subject) throw new Error('--subject 必须是 1–64 位短标签（不含空格/密钥样式内容）');
  return subject;
}

function readBlackboard(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw && raw.entries) ? raw.entries : [];
  } catch {
    return [];
  }
}

async function main() {
  const cmd = process.argv[2];
  const json = has('--json');
  const metricsDir = flagVal('--metrics-dir', undefined);

  switch (cmd) {
    case 'record': {
      const type = flagVal('--type', '');
      if (!['explanation', 'correction'].includes(type)) throw new Error('--type 必须是 explanation 或 correction');
      const subject = requireSubject(flagVal('--subject', ''));
      const count = Math.max(1, Math.floor(Number(flagVal('--count', '1')) || 1));
      const source = flagVal('--source', 'cli');
      const result = type === 'explanation'
        ? recordExplanation(metricsDir, subject, { count }, { source })
        : recordCorrection(metricsDir, subject, { count }, { source });
      if (json) return print(result, true);
      return print(`已记录 ${type}：${subject} ×${count}`);
    }
    case 'snapshot-config': {
      const audit = auditConfig({ claudeDir: flagVal('--claude-dir', undefined), root: flagVal('--root', undefined) });
      if (!audit.ok) {
        if (json) return print(audit, true);
        print(`审计失败：${audit.reason}`);
        process.exitCode = 1;
        return;
      }
      const counts = {
        dangling: audit.indexes.danglingEntries,
        duplicates: audit.counts.duplicates,
        overBudget: audit.memory.overBudget.length,
        skillsUnique: audit.skills.uniqueCount,
        sessionsOld: audit.sessions.oldCount,
        memoryCount: audit.memory.totalCount,
      };
      const result = recordConfigSnapshot(metricsDir, counts, { ref: `config:${audit.scannedAt}` });
      if (json) return print({ ok: result.ok, ...counts, event: result.event }, true);
      return print(`配置快照：悬空 ${counts.dangling} · 重复 ${counts.duplicates} · 超预算层 ${counts.overBudget} · 技能 ${counts.skillsUnique} · 超 30 天 session ${counts.sessionsOld}`);
    }
    case 'import-orch': {
      const orchDir = flagVal('--orch-dir', undefined);
      const file = orchDir ? blackboardFile(path.resolve(orchDir)) : blackboardFile();
      const entries = readBlackboard(file);
      let recorded = 0;
      let skipped = 0;
      for (const entry of entries) {
        if (!entry || entry.kind !== 'correction') continue;
        const ticket = Array.isArray(entry.ticketIds) && entry.ticketIds.length ? entry.ticketIds[0].replace(/^ORCH-/, '') : null;
        const subject = ticket ? `ticket:ORCH-${ticket}` : 'orch';
        const ref = `bb:${String(entry.id || entry.at || '').slice(0, 60)}`;
        const result = recordCorrection(metricsDir, subject, { count: 1 }, { source: 'orch', ref, now: () => new Date(Number(entry.at) || Date.now()) });
        if (result.ok && !result.duplicate) recorded += 1;
        else skipped += 1;
      }
      if (json) return print({ ok: true, file, corrections: entries.filter((e) => e && e.kind === 'correction').length, recorded, skipped }, true);
      return print(`编排黑板 correction ${entries.filter((e) => e && e.kind === 'correction').length} 条：新增 ${recorded}，已存在 ${skipped}`);
    }
    case 'report': {
      const report = buildReport({ metricsDir, since: flagVal('--since', undefined) });
      const out = flagVal('--out', undefined);
      if (out) {
        fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
        fs.writeFileSync(out, json ? JSON.stringify(report, null, 2) + '\n' : renderReport(report));
      } else if (json) {
        return print(report, true);
      }
      if (json && out) return print({ ok: true, file: path.resolve(out), report }, true);
      return print(renderReport(report));
    }
    case 'review': {
      const built = buildReview({ metricsDir, since: flagVal('--since', undefined) });
      const out = flagVal('--out', undefined);
      let file = built.file;
      if (out) {
        fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
        fs.writeFileSync(out, renderReview(built.report));
        file = path.resolve(out);
      }
      if (json) return print({ ok: true, file, report: built.report }, true);
      print(renderReview(built.report));
      return print(`复盘模板：${file}`);
    }
    case 'paths': {
      const dir = metricsRoot(metricsDir);
      if (json) return print({ root: dir, reports: reportsDir(metricsDir) }, true);
      return print(dir);
    }
    default:
      return print(usage());
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(String((err && err.message) || err) + '\n');
    process.exit(1);
  });
}

module.exports = { main };
