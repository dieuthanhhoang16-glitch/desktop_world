// world/learn/index.js
// desktop-world · 学习卡全局索引（跨项目按主题聚合）。
'use strict';

const fs = require('fs');
const path = require('path');

const { learnRoot, indexFile } = require('./paths');
const { inspectCard } = require('./cards');

function readAllCards(root) {
  const base = learnRoot(root);
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  } catch {
    return out;
  }
  for (const dir of dirs) {
    const cards = path.join(base, dir.name, 'cards');
    let files = [];
    try {
      files = fs.readdirSync(cards).filter((f) => f.endsWith('.md')).sort();
    } catch {
      continue;
    }
    for (const file of files) {
      const abs = path.join(cards, file);
      let text = '';
      try {
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      const card = inspectCard(text);
      out.push({
        file: abs,
        rel: path.relative(base, abs).split(path.sep).join('/'),
        slug: dir.name,
        meta: card.meta,
        body: card.body,
        locked: card.locked,
        status: card.meta.status || 'active',
      });
    }
  }
  return out;
}

function buildIndex(root, { now = () => new Date() } = {}) {
  const cards = readAllCards(root);
  const active = cards.filter((c) => c.status !== 'stale');
  const byProject = new Map();
  for (const card of cards) {
    const project = card.meta.project || card.slug;
    if (!byProject.has(project)) byProject.set(project, []);
    byProject.get(project).push(card);
  }
  const lines = ['# 项目学习索引', '', `> 生成时间：${now().toISOString()}`, ''];
  for (const project of [...byProject.keys()].sort((a, b) => a.localeCompare(b, 'zh-CN'))) {
    lines.push(`## ${project}`, '');
    const list = byProject.get(project).sort((a, b) => String(a.meta.topic || '').localeCompare(String(b.meta.topic || ''), 'zh-CN'));
    for (const card of list) {
      const flags = [card.status === 'stale' ? '来源已失效' : '', card.locked ? '已锁定' : ''].filter(Boolean);
      lines.push(
        `- [${card.meta.topic || card.meta.id}](${card.rel}) — ${card.meta.summary || ''} · ${card.meta.estimatedMinutes || 0} 分钟${flags.length ? `（${flags.join('，')}）` : ''}`
      );
    }
    lines.push('');
  }
  if (!cards.length) lines.push('_暂无学习卡。_', '');
  const topics = new Map();
  for (const card of active) {
    const topic = card.meta.topic || card.meta.id;
    if (!topics.has(topic)) topics.set(topic, []);
    topics.get(topic).push(card);
  }
  if (topics.size) {
    lines.push('## 按主题', '');
    for (const topic of [...topics.keys()].sort((a, b) => a.localeCompare(b, 'zh-CN'))) {
      lines.push(`### ${topic}`, '');
      for (const card of topics.get(topic)) {
        lines.push(`- [${card.meta.project || card.slug}](${card.rel})`);
      }
      lines.push('');
    }
  }
  return { markdown: lines.join('\n'), cards };
}

function writeIndex(root, { now = () => new Date() } = {}) {
  const file = indexFile(root);
  const { markdown, cards } = buildIndex(root, { now });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, markdown);
  fs.renameSync(tmp, file);
  return { file, count: cards.length };
}

module.exports = { readAllCards, buildIndex, writeIndex };
