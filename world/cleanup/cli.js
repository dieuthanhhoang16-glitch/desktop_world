#!/usr/bin/env node
// world/cleanup/cli.js
// desktop-world · 项目清理 CLI：scan / propose / show / decide / execute / restore / purge。
'use strict';

const fs = require('fs');
const path = require('path');

const { scanProject } = require('./scan');
const { runRound1 } = require('./round1');
const { runRound2 } = require('./round2');
const { buildProposal, writeProposal, readProposal, renderProposalMarkdown } = require('./proposal');
const { buildDecisions, writeDecisions, readDecisions, decisionsPath } = require('./decisions');
const { execute, restore, purge, readReceipt } = require('./execute');
const { cleanupRoot, projectSlug, proposalDir } = require('./paths');
const { createJevDecider } = require('../learn/drafter');
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
  return `用法: node world/cleanup/cli.js <命令>

  scan     <project> [--json]                                只读扫描候选
  propose  <project> [--no-jev] [--json]                     JEV 一轮 + GLM 二轮 → proposal.md/json
  show     <project> [--date YYYY-MM-DD] [--json]            查看提案
  decide   <project> --select-all | --select a,b [--date]    写入 decisions.json
  execute  <project> [--yes] [--date]                        默认 dry-run，--yes 真执行
  restore  <project> [--date]                                30 天内恢复
  purge    <project>                                         清除超过 30 天的回收站内容
`;
}

function latestDir(root, project) {
  const base = path.join(cleanupRoot(root), projectSlug(project));
  try {
    const dates = fs.readdirSync(base).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    if (!dates.length) return null;
    return path.join(base, dates[dates.length - 1]);
  } catch {
    return null;
  }
}

function resolveDir(root, project, date) {
  if (date) return proposalDir(root, project, date);
  return latestDir(root, project);
}

async function main() {
  const cmd = process.argv[2];
  const projectArg = process.argv[3];
  const project = projectArg ? path.resolve(projectArg) : null;
  const json = has('--json');
  const root = flagVal('--root', undefined);
  const date = flagVal('--date', undefined);
  const metricsDir = flagVal('--metrics-dir', undefined);

  switch (cmd) {
    case 'scan': {
      if (!project) throw new Error('缺少项目路径');
      const result = scanProject(project);
      if (json) return print(result, true);
      if (!result.ok) return print(`扫描失败：${result.reason}`);
      print(`候选 ${result.totalCandidates} 个（${Object.entries(result.counts).map(([k, v]) => `${k} ${v}`).join(' · ') || '无'}）`);
      for (const c of result.candidates) print(`- [${c.category}] ${c.path}\n  ${c.evidenceLines.join('\n  ')}`);
      return;
    }
    case 'propose': {
      if (!project) throw new Error('缺少项目路径');
      const decider = has('--no-jev') ? undefined : createJevDecider();
      const r1 = await runRound1({ projectPath: project, root, decider });
      if (json && !r1.ok) return print(r1, true);
      if (!r1.ok) {
        print(`未生成提案：${r1.reason}${r1.message ? `（${r1.message}）` : ''}`);
        process.exitCode = 1;
        return;
      }
      if (r1.empty) return print(r1.message);
      const r2 = await runRound2({ projectPath: project, candidates: r1.candidates, model: flagVal('--glm-model', 'jd-glm53') });
      const proposal = buildProposal({ round1: r1, round2: r2 });
      const files = writeProposal(r1.dir, proposal);
      recordCleanupProposal(metricsDir, {
        proposalId: proposal.proposalId,
        candidates: proposal.totalCandidates,
        confirmed: proposal.counts.confirmed,
      });
      if (json) return print({ ok: true, ...files, proposal }, true);
      print(renderProposalMarkdown(proposal));
      print(`提案：${files.mdPath}`);
      return;
    }
    case 'show': {
      if (!project) throw new Error('缺少项目路径');
      const dir = resolveDir(root, project, date);
      if (!dir) return print('尚无清理提案。');
      const proposal = readProposal(dir);
      if (!proposal) return print(`提案不可读：${dir}`);
      if (json) return print(proposal, true);
      return print(renderProposalMarkdown(proposal));
    }
    case 'decide': {
      if (!project) throw new Error('缺少项目路径');
      const dir = resolveDir(root, project, date);
      if (!dir) throw new Error('尚无清理提案');
      const proposal = readProposal(dir);
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
      const d = result.decisions;
      return print(`已写入 ${file}\n勾选删除 ${d.selectedCount} 项；未勾选与待定/保留项均标记为 keep。`);
    }
    case 'execute': {
      if (!project) throw new Error('缺少项目路径');
      const dir = resolveDir(root, project, date);
      if (!dir) throw new Error('尚无清理提案');
      const decisions = readDecisions(dir);
      if (!decisions) throw new Error(`尚无审批决策：${decisionsPath(dir)}`);
      const result = execute({ projectPath: project, dir, decisions, dryRun: !has('--yes') });
      if (json) return print(result, true);
      if (!result.ok) {
        print(`执行失败：${result.reason}\n${result.message || ''}`);
        process.exitCode = 1;
        return;
      }
      if (result.dryRun) {
        print(`dry-run：${result.deleteCount} 个文件将被处理（未修改任何文件）`);
        for (const p of result.preview) print(`- ${p.path} → ${p.destination}`);
        print('确认后运行：node world/cleanup/cli.js execute <project> --yes');
        return;
      }
      if (result.noop) return print(result.message);
      recordCleanupExecute(metricsDir, {
        proposalId: decisions.proposalId,
        confirmed: decisions.items.filter((i) => i.action === 'delete').length,
        removed: result.removed,
        moved: result.moved,
        failed: result.failed,
      });
      print(`执行完成：git rm ${result.removed} · 移入回收站 ${result.moved} · 失败 ${result.failed} · 未找到 ${result.notFound}`);
      if (result.receipt.git) print(`专用分支：${result.receipt.git.branch}${result.receipt.git.commit ? ` @ ${result.receipt.git.commit.slice(0, 8)}` : ''}`);
      print(`回执：${result.receiptPath}`);
      if (result.failed) process.exitCode = 1;
      return;
    }
    case 'restore': {
      if (!project) throw new Error('缺少项目路径');
      const dir = resolveDir(root, project, date);
      if (!dir) throw new Error('尚无清理提案');
      const result = restore({ projectPath: project, dir });
      if (json) return print(result, true);
      if (!result.ok) return print(result.message);
      if (result.restored.length) {
        const receipt = readReceipt(dir);
        recordCleanupRestore(metricsDir, { proposalId: receipt ? receipt.proposalId : null, restored: result.restored.length });
      }
      print(`已恢复 ${result.restored.length} 个文件`);
      for (const r of result.restored) print(`- ${r.path}（${r.action}）`);
      for (const s of result.skipped) print(`- 跳过 ${s.path}：${s.reason}`);
      return;
    }
    case 'purge': {
      if (!project) throw new Error('缺少项目路径');
      const result = purge({ projectPath: project });
      if (json) return print(result, true);
      print(`已清除 ${result.purged.length} 个过期日期目录`);
      for (const k of result.kept) print(`- ${k.date} 保留至 ${k.expiresAt}`);
      return;
    }
    case 'receipt': {
      if (!project) throw new Error('缺少项目路径');
      const dir = resolveDir(root, project, date);
      if (!dir) throw new Error('尚无清理提案');
      const receipt = readReceipt(dir);
      if (json) return print(receipt, true);
      if (!receipt) return print('尚无执行回执。');
      return print(`执行于 ${receipt.executedAt}，${receipt.results.length} 项；恢复期限 ${receipt.retentionDays} 天。`);
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
