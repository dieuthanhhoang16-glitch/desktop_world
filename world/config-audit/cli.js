#!/usr/bin/env node
// world/config-audit/cli.js
// desktop-world · 配置层审计 CLI：audit / propose / show / decide / execute / restore。
'use strict';

const fs = require('fs');
const path = require('path');

const { auditConfig } = require('./audit');
const { buildConfigProposal, writeConfigProposal, readConfigProposal, renderConfigProposal } = require('./proposal');
const { configProposalDir, configProposalRoot } = require('./paths');
const { buildDecisions, writeDecisions, readDecisions } = require('../cleanup/decisions');
const { executeConfig, restoreConfig, readConfigReceipt } = require('./execute');
const { recordCleanupProposal, recordCleanupExecute, recordCleanupRestore } = require('../metrics/events');

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
  return `用法: node world/config-audit/cli.js <命令>

  audit    [--claude-dir DIR] [--json]                 只读审计三层记忆/技能/session
  propose  [--claude-dir DIR] [--root DIR] [--json]   生成配置清理提案（复用清理面板）
  show     [--date YYYY-MM-DD] [--json]               查看配置提案
  decide   --select-all | --select a,b [--date]       写入 decisions.json
  execute  [--yes] [--date]                           默认 dry-run，--yes 先归档再删除
  restore  [--date]                                   从归档恢复
  receipt  [--date] [--json]                          查看执行回执
`;
}

function latestDir(root) {
  const base = configProposalRoot(root);
  try {
    const dates = fs.readdirSync(base).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    if (!dates.length) return null;
    return path.join(base, dates[dates.length - 1]);
  } catch {
    return null;
  }
}

function resolveDir(root, date) {
  return date ? configProposalDir(root, date) : latestDir(root);
}

async function main() {
  const cmd = process.argv[2];
  const json = has('--json');
  const claudeDir = flagVal('--claude-dir', undefined);
  const root = flagVal('--root', undefined);
  const date = flagVal('--date', undefined);
  const metricsDir = flagVal('--metrics-dir', undefined);

  switch (cmd) {
    case 'audit': {
      const result = auditConfig({ claudeDir, root });
      if (json) return print(result, true);
      if (!result.ok) return print(`审计失败：${result.reason}`);
      const m = result.memory;
      print(`配置目录：${result.root}`);
      print(`身份/语气 ${m.layers.identity.count}/${m.layers.identity.limit} 条 · 工作流 ${m.layers.workflow.count}/${m.layers.workflow.limit} 条 · 项目事实 ${m.layers.project.count} 条（${m.ttlDays} 天 TTL）`);
      print(`技能 ${result.skills.uniqueCount}/${result.skills.limit} · 重复 ${result.skills.duplicateCount} · 60 天未用 ${result.skills.unusedCount}`);
      print(`悬空索引条目 ${result.indexes.danglingEntries} · session ${result.sessions.count}（超 30 天 ${result.sessions.oldCount}）`);
      print(`候选：确认删除 ${result.counts.confirmed} · 待定 ${result.counts.pending}`);
      return;
    }
    case 'propose': {
      const audit = auditConfig({ claudeDir, root });
      if (!audit.ok) {
        print(`审计失败：${audit.reason}`);
        process.exitCode = 1;
        return;
      }
      const proposal = buildConfigProposal({ audit });
      const dir = configProposalDir(root, audit.date);
      const files = writeConfigProposal(dir, proposal);
      recordCleanupProposal(metricsDir, {
        proposalId: proposal.proposalId,
        candidates: proposal.totalCandidates,
        confirmed: proposal.counts.confirmed,
        kind: 'config',
      });
      if (json) return print({ ok: true, ...files, proposal }, true);
      print(renderConfigProposal(proposal));
      print(`提案：${files.mdPath}`);
      return;
    }
    case 'show': {
      const dir = resolveDir(root, date);
      if (!dir) return print('尚无配置清理提案。');
      const proposal = readConfigProposal(dir);
      if (!proposal) return print(`提案不可读：${dir}`);
      if (json) return print(proposal, true);
      return print(renderConfigProposal(proposal));
    }
    case 'decide': {
      const dir = resolveDir(root, date);
      if (!dir) throw new Error('尚无配置清理提案');
      const proposal = readConfigProposal(dir);
      if (!proposal) throw new Error('提案不可读');
      const selectAll = has('--select-all');
      const raw = flagVal('--select', '');
      const selectedPaths = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
      const result = buildDecisions({ proposal, selectedPaths, selectAll });
      if (!result.ok) {
        if (json) return print(result, true);
        print(`无法生成决策：${result.message}`);
        process.exitCode = 1;
        return;
      }
      const file = writeDecisions(dir, result.decisions);
      if (json) return print({ ok: true, file, decisions: result.decisions }, true);
      return print(`已写入 ${file}\n勾选删除 ${result.decisions.selectedCount} 项（先归档再删除）。`);
    }
    case 'execute': {
      const dir = resolveDir(root, date);
      if (!dir) throw new Error('尚无配置清理提案');
      const decisions = readDecisions(dir);
      if (!decisions) throw new Error('尚无审批决策');
      const result = executeConfig({ dir, decisions, dryRun: !has('--yes') });
      if (json) return print(result, true);
      if (!result.ok) {
        print(`执行失败：${result.reason}\n${result.message || ''}`);
        process.exitCode = 1;
        return;
      }
      if (result.dryRun) {
        print(`dry-run：${result.deleteCount} 个配置项将先归档再删除`);
        for (const p of result.preview) print(`- ${p.path} → ${p.archiveTo}`);
        print('确认后运行：node world/config-audit/cli.js execute --yes');
        return;
      }
      if (result.noop) return print(result.message);
      recordCleanupExecute(metricsDir, {
        proposalId: decisions.proposalId,
        confirmed: decisions.items.filter((i) => i.action === 'delete').length,
        removed: result.archivedDeleted,
        failed: result.failed,
        kind: 'config',
      });
      print(`执行完成：归档并删除 ${result.archivedDeleted} · 失败 ${result.failed} · 未找到 ${result.notFound}`);
      print(`回执：${result.receiptPath}`);
      if (result.failed) process.exitCode = 1;
      return;
    }
    case 'restore': {
      const dir = resolveDir(root, date);
      if (!dir) throw new Error('尚无配置清理提案');
      const result = restoreConfig({ dir });
      if (json) return print(result, true);
      if (!result.ok) return print(result.message);
      if (result.restored.length) {
        const receipt = readConfigReceipt(dir);
        recordCleanupRestore(metricsDir, { proposalId: receipt ? receipt.proposalId : null, restored: result.restored.length, kind: 'config' });
      }
      print(`已恢复 ${result.restored.length} 项`);
      for (const r of result.restored) print(`- ${r.path}`);
      for (const s of result.skipped) print(`- 跳过 ${s.path}：${s.reason}`);
      return;
    }
    case 'receipt': {
      const dir = resolveDir(root, date);
      if (!dir) throw new Error('尚无配置清理提案');
      const receipt = readConfigReceipt(dir);
      if (json) return print(receipt, true);
      if (!receipt) return print('尚无执行回执。');
      return print(`执行于 ${receipt.executedAt}，${receipt.counts.archivedDeleted} 项已归档并删除，可恢复至 ${receipt.results[0]?.recoverableUntil || '-'}。`);
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

module.exports = { main, latestDir, resolveDir };
