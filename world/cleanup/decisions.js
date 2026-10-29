// world/cleanup/decisions.js
// desktop-world · 用户审批结果。decisions.json 是执行器唯一依据。
'use strict';

const fs = require('fs');
const path = require('path');

const RETENTION_DAYS = 30;

function decisionsPath(dir) {
  return path.join(dir, 'decisions.json');
}

function branchFor(proposal) {
  if (proposal.kind === 'config' || (proposal.policy && proposal.policy.branch === null)) return null;
  return `cleanup/${proposal.proposalId}`;
}

/**
 * @param {object} opts
 * @param {object} opts.proposal
 * @param {string[]} [opts.selectedPaths] 勾选要删除的路径（必须属于可执行桶）
 * @param {boolean} [opts.selectAll]
 */
function buildDecisions({ proposal, selectedPaths = [], selectAll = false, now = () => new Date() } = {}) {
  if (!proposal || proposal.status !== 'complete') {
    return { ok: false, reason: 'proposal-incomplete', message: '提案不完整，不能生成可执行决策。' };
  }
  const selectableBuckets = (proposal.policy && Array.isArray(proposal.policy.selectableBuckets))
    ? proposal.policy.selectableBuckets
    : ['confirmed'];
  const allSelectable = new Set();
  for (const bucket of selectableBuckets) {
    for (const item of (proposal.buckets && proposal.buckets[bucket]) || []) allSelectable.add(item.path);
  }
  const selected = selectAll ? [...allSelectable] : [...new Set(selectedPaths)];
  const invalid = selected.filter((p) => !allSelectable.has(p));
  if (invalid.length) {
    return { ok: false, reason: 'not-confirmed', paths: invalid, message: `只能勾选可执行桶中的文件：${invalid.join('、')}` };
  }
  const chosen = new Set(selected);
  const branch = branchFor(proposal);
  const kind = proposal.kind || 'project';
  const items = [];
  for (const bucket of ['confirmed', 'pending', 'keep']) {
    for (const item of proposal.buckets[bucket] || []) {
      const selectable = allSelectable.has(item.path);
      const action = selectable && chosen.has(item.path) ? 'delete' : 'keep';
      const entry = {
        path: item.path,
        bucket,
        action,
        tracked: Boolean(item.tracked),
        kind: item.kind || (item.tracked ? 'file' : 'file'),
        reason: action === 'delete' ? item.bucketReason : selectable ? '用户未勾选' : item.bucketReason,
        destination: action === 'delete'
          ? kind === 'config'
            ? `archive:${item.archiveTo || ''}`
            : item.tracked ? `git-branch:${branch}` : `.trash/<date>/${item.path}`
          : null,
        archiveTo: action === 'delete' ? item.archiveTo || null : null,
        root: proposal.root || null,
      };
      // 配置层的索引条目删除与记忆文件索引行清理需要随决策一起交给执行器。
      if (action === 'delete') {
        if (Array.isArray(item.entries)) entry.entries = item.entries;
        if (item.removeIndexLine) entry.removeIndexLine = true;
        if (item.archiveMonth) entry.archiveMonth = item.archiveMonth;
      }
      items.push(entry);
    }
  }
  const at = now();
  return {
    ok: true,
    decisions: {
      schemaVersion: 1,
      kind,
      proposalId: proposal.proposalId,
      project: proposal.project,
      root: proposal.root || null,
      createdAt: at.toISOString(),
      branch,
      retentionDays: RETENTION_DAYS,
      sourceProposal: 'proposal.json',
      selectedCount: selected.length,
      items,
    },
  };
}

function writeDecisions(dir, decisions) {
  fs.mkdirSync(dir, { recursive: true });
  const file = decisionsPath(dir);
  fs.writeFileSync(file, JSON.stringify(decisions, null, 2) + '\n');
  return file;
}

function readDecisions(dir) {
  try {
    return JSON.parse(fs.readFileSync(decisionsPath(dir), 'utf8'));
  } catch {
    return null;
  }
}

module.exports = {
  RETENTION_DAYS,
  decisionsPath,
  branchFor,
  buildDecisions,
  writeDecisions,
  readDecisions,
};
