// world/config-audit/proposal.js
// desktop-world · 配置清理提案：复用清理面板的三桶与 decisions.json，
// 但不经过两轮模型复核——审计是确定性的，每一桶都可由证据复核。
'use strict';

const fs = require('fs');
const path = require('path');

function buildConfigProposal({ audit, now = () => new Date() } = {}) {
  if (!audit || !audit.ok) return audit || { ok: false, reason: 'audit-failed' };
  const buckets = { confirmed: [], pending: [], keep: [] };
  for (const c of audit.candidates) {
    const bucket = c.bucket === 'confirmed' ? 'confirmed' : c.bucket === 'keep' ? 'keep' : 'pending';
    buckets[bucket].push({
      ...c,
      bucketReason: c.bucketReason || (bucket === 'confirmed' ? '确定性审计确认' : '需要人工判断'),
      jev: { probability: null, delete: false, reason: '未使用 JEV（配置审计为确定性规则）' },
      glm: { verdict: bucket === 'confirmed' ? 'delete' : 'uncertain', evidence: '本地元数据审计，未调用模型' },
    });
  }
  const counts = { confirmed: buckets.confirmed.length, pending: buckets.pending.length, keep: 0 };
  return {
    schemaVersion: 1,
    kind: 'config',
    proposalId: audit.proposalId,
    project: audit.root,
    projectName: 'Claude 配置',
    root: audit.root,
    date: audit.date,
    createdAt: now().toISOString(),
    status: 'complete',
    policy: { selectableBuckets: ['confirmed', 'pending'], branch: null },
    rounds: {
      jev: { ok: true, model: 'deterministic-audit', source: 'local', calls: 0, at: now().toISOString() },
      glm: { ok: true, model: 'deterministic-audit', calls: 0, at: now().toISOString() },
    },
    audit: {
      memory: audit.memory,
      skills: audit.skills,
      indexes: audit.indexes,
      sessions: audit.sessions,
      scannedAt: audit.scannedAt,
    },
    scanParams: {
      identityLimit: 20,
      workflowLimit: 50,
      skillLimit: 20,
      skillUnusedDays: 60,
      projectTtlDays: 180,
      sessionArchiveDays: 30,
    },
    exclusions: {
      recentDays: 0,
      ticketScope: [],
      excludedDirs: ['settings*.json', 'history.jsonl', 'session 正文', '密钥/凭据文件'],
    },
    totalCandidates: audit.candidates.length,
    counts,
    buckets,
  };
}

function renderConfigProposal(proposal) {
  const m = proposal.audit;
  const lines = [
    `# 配置清理提案 · ${proposal.createdAt.slice(0, 10)}`,
    '',
    `> 状态：完整（本地确定性审计，未调用模型） · 候选 ${proposal.totalCandidates} · 确认删除 ${proposal.counts.confirmed} · 待定 ${proposal.counts.pending}`,
    '',
    '## 审计摘要',
    '',
    '| 层 | 条数 | 体积 | 预算/TTL |',
    '|---|---|---|---|',
    `| 身份/语气 | ${m.memory.layers.identity.count} | ${m.memory.layers.identity.bytes} B | ≤${m.memory.layers.identity.limit} 条 |`,
    `| 工作流习惯 | ${m.memory.layers.workflow.count} | ${m.memory.layers.workflow.bytes} B | ≤${m.memory.layers.workflow.limit} 条 |`,
    `| 项目事实 | ${m.memory.layers.project.count} | ${m.memory.layers.project.bytes} B | ${m.memory.ttlDays} 天 TTL |`,
    `| 用户技能 | ${m.skills.uniqueCount} | — | ≤${m.skills.limit} 个 |`,
    '',
    `- 悬空索引条目：${m.indexes.danglingEntries}（${m.indexes.files} 个索引文件）`,
    `- 重复技能：${m.skills.duplicateCount} · 60 天未用技能：${m.skills.unusedCount} · zip 重复：${m.skills.zips}`,
    `- session：${m.sessions.count} 个，超过 30 天 ${m.sessions.oldCount} 个，按月归档`,
    '',
  ];
  const sections = [
    ['confirmed', '确认删除（确定性规则）'],
    ['pending', '待定（需要人工判断）'],
    ['keep', '保留'],
  ];
  for (const [key, title] of sections) {
    lines.push(`## ${title}`, '');
    if (!proposal.buckets[key].length) {
      lines.push('- 无', '');
      continue;
    }
    for (const item of proposal.buckets[key]) {
      lines.push(`### \`${item.path}\``, '');
      lines.push(`- 类别：${item.category} · 风险：${item.risk} · ${item.kind}`);
      lines.push(`- 结论：${item.bucketReason}`);
      for (const e of item.evidenceLines) lines.push(`- 证据：${e}`);
      if (item.kind === 'index-entries' && item.entries) {
        for (const entry of item.entries.slice(0, 10)) lines.push(`  - 待移除：\`${entry.target}\``);
      }
      if (item.archiveTo) lines.push(`- 归档：${item.archiveTo}`);
      lines.push('');
    }
  }
  lines.push('> 删除前一律归档；归档路径写入回执，可恢复。审计不读取 settings、session 正文或密钥内容。', '');
  return lines.join('\n');
}

function writeConfigProposal(dir, proposal) {
  fs.mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, 'proposal.json');
  const mdPath = path.join(dir, 'proposal.md');
  fs.writeFileSync(jsonPath, JSON.stringify(proposal, null, 2) + '\n');
  fs.writeFileSync(mdPath, renderConfigProposal(proposal));
  return { jsonPath, mdPath };
}

function readConfigProposal(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'proposal.json'), 'utf8'));
  } catch {
    return null;
  }
}

module.exports = { buildConfigProposal, renderConfigProposal, writeConfigProposal, readConfigProposal };
