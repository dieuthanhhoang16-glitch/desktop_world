// world/cleanup/proposal.js
// desktop-world · 两轮结果合并为三桶，生成 proposal.json / proposal.md。
//
// 确认删除 = JEV 与 GLM 都判 delete；GLM 判 keep 一票否决；任一轮不可用则
// proposal 标记 incomplete，确认删除桶强制为空。
'use strict';

const fs = require('fs');
const path = require('path');

function mergeBuckets(round1, round2) {
  const incomplete = !round2 || !round2.ok;
  const verdicts = new Map(((round2 && round2.verdicts) || []).map((v) => [v.path, v]));
  const buckets = { confirmed: [], pending: [], keep: [] };

  for (const c of (round1 && round1.candidates) || []) {
    const glm = verdicts.get(c.path) || { path: c.path, verdict: 'uncertain', evidence: 'GLM 未返回结论' };
    const item = {
      path: c.path,
      category: c.category,
      risk: c.risk,
      size: c.size,
      tracked: Boolean(c.tracked),
      evidence: c.evidence || {},
      evidenceLines: c.evidenceLines || [],
      jev: { probability: c.probability, delete: Boolean(c.votedDelete), reason: c.jevReason },
      glm: { verdict: glm.verdict, evidence: glm.evidence },
    };
    if (!c.votedDelete) {
      buckets.keep.push({ ...item, bucketReason: 'JEV 判保留' });
    } else if (incomplete) {
      buckets.pending.push({ ...item, bucketReason: 'GLM 复核不可用，不能确认删除' });
    } else if (glm.verdict === 'keep') {
      buckets.keep.push({ ...item, bucketReason: 'GLM 判保留（一票否决）' });
    } else if (glm.verdict === 'delete') {
      buckets.confirmed.push({ ...item, bucketReason: '两轮都判 delete' });
    } else {
      buckets.pending.push({ ...item, bucketReason: 'GLM 判 uncertain，需人工判断' });
    }
  }
  return { buckets, incomplete };
}

function renderProposalMarkdown(proposal) {
  const { buckets, counts } = proposal;
  const lines = [
    `# 清理提案 · ${proposal.projectName}`,
    '',
    `> ${proposal.status === 'complete' ? '完整（两轮均完成）' : '不完整（有复核轮次不可用，不会产生确认删除）'} · 生成 ${proposal.createdAt}`,
    `> 候选 ${proposal.totalCandidates} · 确认删除 ${counts.confirmed} · 待定 ${counts.pending} · 保留 ${counts.keep}`,
    '',
    '## 复核轮次',
    '',
    `- JEV：调用 ${proposal.rounds.jev.calls} 次${proposal.rounds.jev.model ? `，模型 ${proposal.rounds.jev.model}` : ''}`,
    `- GLM：调用 ${proposal.rounds.glm.calls} 次${proposal.rounds.glm.model ? `，模型 ${proposal.rounds.glm.model}` : ''}${proposal.rounds.glm.ok ? '' : `（不可用：${proposal.rounds.glm.reason || 'unknown'}）`}`,
    '',
  ];
  const sections = [
    ['confirmed', '确认删除（两轮一致）'],
    ['pending', '待定（需人工判断）'],
    ['keep', '保留（JEV 或 GLM 判保留）'],
  ];
  for (const [key, title] of sections) {
    lines.push(`## ${title}`, '');
    if (!buckets[key].length) {
      lines.push('- 无', '');
      continue;
    }
    for (const item of buckets[key]) {
      lines.push(`### \`${item.path}\``, '');
      lines.push(`- 类别：${item.category} · 风险：${item.risk} · ${item.tracked ? 'git 已跟踪' : '未跟踪'} · ${item.size} 字节`);
      lines.push(`- 结论：${item.bucketReason}`);
      for (const e of item.evidenceLines) lines.push(`- 证据：${e}`);
      lines.push(`- JEV：${item.jev.reason}`);
      lines.push(`- GLM：${item.glm.verdict} — ${item.glm.evidence}`);
      lines.push('');
    }
  }
  lines.push('## 扫描参数与排除项', '');
  lines.push(`- 参数：\`${JSON.stringify(proposal.scanParams)}\``);
  lines.push(`- 近 ${proposal.exclusions.recentDays} 天修改的文件不进候选。`);
  lines.push(`- 当前 ticket 范围（不进候选）：${proposal.exclusions.ticketScope.length ? proposal.exclusions.ticketScope.map((p) => `\`${p}\``).join('、') : '无'}`);
  lines.push(`- 排除目录：${proposal.exclusions.excludedDirs.map((p) => `\`${p}\``).join('、')}`);
  lines.push('');
  return lines.join('\n');
}

function buildProposal({ round1, round2, now = () => new Date() } = {}) {
  const at = now();
  const { buckets, incomplete } = mergeBuckets(round1, round2);
  const counts = {
    confirmed: buckets.confirmed.length,
    pending: buckets.pending.length,
    keep: buckets.keep.length,
  };
  return {
    schemaVersion: 1,
    proposalId: round1.proposalId,
    project: round1.project,
    projectName: round1.projectName,
    date: round1.date,
    createdAt: at.toISOString(),
    status: incomplete ? 'incomplete' : 'complete',
    rounds: {
      jev: round1.round1.rounds.jev,
      glm: round2 && round2.ok
        ? { ok: true, model: round2.model, calls: round2.calls, at: round2.at }
        : { ok: false, model: (round2 && round2.model) || null, calls: (round2 && round2.calls) || 0, at: (round2 && round2.at) || null, reason: (round2 && (round2.reason || round2.error)) || 'glm-unavailable' },
    },
    scanParams: round1.round1.scanParams,
    exclusions: round1.round1.exclusions,
    totalCandidates: round1.candidates.length,
    counts,
    buckets,
  };
}

function writeProposal(dir, proposal) {
  fs.mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, 'proposal.json');
  const mdPath = path.join(dir, 'proposal.md');
  fs.writeFileSync(jsonPath, JSON.stringify(proposal, null, 2) + '\n');
  fs.writeFileSync(mdPath, renderProposalMarkdown(proposal));
  return { jsonPath, mdPath };
}

function readProposal(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'proposal.json'), 'utf8'));
  } catch {
    return null;
  }
}

module.exports = { mergeBuckets, buildProposal, writeProposal, readProposal, renderProposalMarkdown };
