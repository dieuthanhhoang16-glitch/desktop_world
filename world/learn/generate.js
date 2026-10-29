// world/learn/generate.js
// desktop-world · 学习卡全量/增量生成。
//
// 失败语义：
//   - 起草阶段失败（GLM 抛错）→ 一个字节都不写，保留已有卡片，返回 drafter-failed。
//   - 写入阶段失败 → 从本次运行前的备份回滚卡片目录与索引，返回 write-failed。
//   - locked 卡片绝不覆盖；新内容进 candidates.json 供用户决定。
//   - 来源消失 → 卡片标 stale，不删除。
'use strict';

const fs = require('fs');
const path = require('path');

const cardsLib = require('./cards');
const { scanSources } = require('./sources');
const { learnRoot, projectDir, cardsDir, candidatesFile, backupsDir, projectSlug } = require('./paths');
const { writeIndex } = require('./index');

function nowIso(now) {
  return (now ? now() : new Date()).toISOString();
}

function loadExisting(dir) {
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return out;
  }
  for (const file of files) {
    const abs = path.join(dir, file);
    let text = '';
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const card = cardsLib.inspectCard(text);
    out.push({ file: abs, name: file, text, ...card });
  }
  return out;
}

function backupState({ cardDir, index, root, now }) {
  const stamp = nowIso(now).replace(/[-:.TZ]/g, '');
  const dest = path.join(backupsDir(root), stamp);
  fs.mkdirSync(dest, { recursive: true });
  if (fs.existsSync(cardDir)) fs.cpSync(cardDir, path.join(dest, 'cards'), { recursive: true });
  if (fs.existsSync(index)) fs.copyFileSync(index, path.join(dest, 'index.md'));
  return dest;
}

function restoreState({ cardDir, index, backup, root }) {
  if (!backup) return false;
  const savedCards = path.join(backup, 'cards');
  fs.rmSync(cardDir, { recursive: true, force: true });
  if (fs.existsSync(savedCards)) fs.cpSync(savedCards, cardDir, { recursive: true });
  const savedIndex = path.join(backup, 'index.md');
  if (fs.existsSync(savedIndex)) {
    fs.mkdirSync(path.dirname(index), { recursive: true });
    fs.copyFileSync(savedIndex, index);
  } else {
    fs.rmSync(index, { force: true });
  }
  return true;
}

function pruneBackups(root, keep = 5) {
  let dirs = [];
  try {
    dirs = fs.readdirSync(backupsDir(root)).sort();
  } catch {
    return;
  }
  for (const name of dirs.slice(0, Math.max(0, dirs.length - keep))) {
    fs.rmSync(path.join(backupsDir(root), name), { recursive: true, force: true });
  }
}

function fileLink(projectPath, relPath) {
  return 'file://' + encodeURI(path.join(projectPath, relPath));
}

/** 主题重名裁决：优先用 JEV 概率；缺失/失败时确定性保留优先级最高者。 */
async function arbitrateNames({ drafts, decider, now }) {
  const groups = new Map();
  for (const d of drafts) {
    if (!groups.has(d.topic)) groups.set(d.topic, []);
    groups.get(d.topic).push(d);
  }
  const conflicts = [];
  for (const [topic, list] of groups) {
    if (list.length < 2) continue;
    let winner = null;
    let by = 'deterministic';
    if (typeof decider === 'function') {
      const questions = {};
      for (const d of list) questions[d.id] = { type: 'noul', instructions: `候选 ${d.topic}（${d.sourcePath}）保留这个主题名的合适程度` };
      try {
        const res = await decider({ state: `多个学习卡主题重名：${topic}`, questions, purpose: 'study-topic-naming' });
        if (res && res.ok) {
          let best = -1;
          for (const d of list) {
            const a = res.answers && res.answers[d.id];
            const p = typeof a === 'number' ? a : a && typeof a.noul === 'number' ? a.noul : -1;
            if (p > best) {
              best = p;
              winner = d.id;
            }
          }
          if (winner) by = res.model || 'jev';
        }
      } catch {
        winner = null;
      }
    }
    if (!winner) winner = list[0].id;
    const renamed = [];
    for (const d of list) {
      if (d.id === winner) continue;
      const parts = d.topic.split(/\s+/);
      const base = d.sourcePath.split('/').pop().replace(/\.md$/i, '').slice(0, 12);
      d.topic = `${parts[0]}·${base} ${parts[1]}`;
      renamed.push({ id: d.id, topic: d.topic });
    }
    conflicts.push({ topic, winner, renamed, arbitratedBy: by, at: nowIso(now) });
  }
  return conflicts;
}

function validateDrafts(rawDrafts, sources, { generatedBy }) {
  const byPath = new Map(sources.map((s) => [s.path, s]));
  const out = [];
  for (const d of rawDrafts) {
    const source = byPath.get(d.sourcePath) || sources.find((s) => d.sourcePath && d.sourcePath.endsWith(s.path));
    if (!source) continue;
    out.push({ ...cardsLib.normalizeDraft(d, source, out.length), generatedBy: d.generatedBy || generatedBy });
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.projectPath
 * @param {string} [opts.root]
 * @param {boolean} [opts.incremental]
 * @param {Function} [opts.drafter] async ({projectPath, sources}) => drafts[]
 * @param {Function} [opts.decider] JEV decide()
 * @param {Function} [opts.beforeWrite] 测试注入：抛错以验证回滚
 */
async function generateCards(opts = {}) {
  const projectPath = path.resolve(String(opts.projectPath || ''));
  const root = learnRoot(opts.root);
  const cDir = cardsDir(root, projectPath);
  const pDir = projectDir(root, projectPath);
  const index = path.join(root, 'index.md');
  const now = opts.now || (() => new Date());
  const incremental = opts.incremental === true;
  const projectName = require('path').basename(projectPath);

  if (!fs.existsSync(projectPath)) return { ok: false, reason: 'project-not-found', project: projectPath };

  const scanned = scanSources(projectPath);
  const existing = loadExisting(cDir);
  const existingBySource = new Map();
  for (const card of existing) {
    const sourcePath = card.meta.sources && card.meta.sources[0] && card.meta.sources[0].path;
    if (!sourcePath) continue;
    if (!existingBySource.has(sourcePath)) existingBySource.set(sourcePath, []);
    existingBySource.get(sourcePath).push(card);
  }

  const sourceHashes = new Set(scanned.sources.map((s) => cardsLib.hashSource(s.contentHash)));
  const toDraft = incremental
    ? scanned.sources.filter((s) => {
        const list = existingBySource.get(s.path) || [];
        const hash = cardsLib.hashSource(s.contentHash);
        return !list.some((c) => c.meta.sourceHash === hash && c.status !== 'stale');
      })
    : scanned.sources;

  let drafts = [];
  if (toDraft.length) {
    if (opts.drafter) {
      let raw;
      try {
        raw = await opts.drafter({ projectPath, sources: toDraft, projectName });
      } catch (err) {
        return {
          ok: false,
          reason: 'drafter-failed',
          message: String((err && err.message) || err),
          project: projectPath,
          preserved: true,
          existingCards: existing.length,
        };
      }
      if (!Array.isArray(raw)) {
        return { ok: false, reason: 'drafter-failed', message: 'drafter 未返回数组', project: projectPath, preserved: true };
      }
      drafts = validateDrafts(raw, toDraft, { generatedBy: opts.model || 'glm' });
      // 模型漏掉的来源用确定性规则补齐，避免"少一张卡"变成静默数据丢失
      const covered = new Set(drafts.map((d) => d.sourcePath));
      for (const source of toDraft) {
        if (!covered.has(source.path)) {
          drafts.push(...validateDrafts(cardsLib.draftDeterministic([source]), [source], { generatedBy: 'deterministic' }));
        }
      }
    } else {
      drafts = validateDrafts(cardsLib.draftDeterministic(toDraft), toDraft, { generatedBy: 'deterministic' });
    }
  }

  // 同一来源同一主题只留一张；不同来源同主题交给命名裁决
  const seenCard = new Set();
  drafts = drafts.filter((d) => {
    const key = `${d.sourceHash}|${d.topicId}`;
    if (seenCard.has(key)) return false;
    seenCard.add(key);
    return true;
  });
  const conflicts = await arbitrateNames({ drafts, decider: opts.decider, now });

  const stamp = nowIso(now);
  const touch = [];
  const lockedCandidates = [];
  let wrote = 0;

  for (const draft of drafts) {
    const prev = existing.find((c) => c.name === `${draft.id}.md`);
    const rendered = cardsLib.renderCard({
      ...draft,
      project: projectName,
      link: fileLink(projectPath, draft.sourcePath),
      estimatedMinutes: cardsLib.estimatedMinutes(draft.chars),
      status: 'active',
      locked: false,
      generatedAt: stamp,
      generatedBy: draft.generatedBy || 'deterministic',
    });
    if (prev) {
      if (prev.locked) {
        if (prev.meta.sourceHash !== draft.sourceHash || prev.meta.topic !== draft.topic) {
          lockedCandidates.push({
            id: draft.id,
            topic: draft.topic,
            sourcePath: draft.sourcePath,
            reason: 'locked',
            draftSummary: draft.summary,
            sourceHash: draft.sourceHash,
          });
        }
        continue;
      }
      if (prev.text === rendered) continue;
      touch.push({ file: prev.file, text: rendered });
    } else {
      touch.push({ file: path.join(cDir, `${draft.id}.md`), text: rendered });
    }
    wrote += 1;
  }

  // 来源消失/改名 → stale；来源仍在但主题消失 → 该来源的旧卡也 stale
  const draftIds = new Set(drafts.map((d) => d.id));
  let stale = 0;
  for (const card of existing) {
    const sourcePath = card.meta.sources && card.meta.sources[0] && card.meta.sources[0].path;
    const sourceExists = Boolean(sourcePath) && scanned.sources.some((s) => s.path === sourcePath);
    const sourceGone = !sourceExists;
    const topicGone =
      sourceExists &&
      toDraft.some((s) => s.path === sourcePath) &&
      !draftIds.has(card.meta.id);
    if (!sourceGone && !topicGone) continue;
    if (card.meta.status === 'stale') continue;
    touch.push({ file: card.file, text: cardsLib.withStatus(card.text, 'stale') });
    stale += 1;
  }

  if (conflicts.length) {
    fs.mkdirSync(pDir, { recursive: true });
    fs.writeFileSync(path.join(pDir, 'naming-audit.json'), JSON.stringify({ generatedAt: stamp, conflicts }, null, 2) + '\n');
  }

  if (lockedCandidates.length) {
    fs.mkdirSync(pDir, { recursive: true });
    fs.writeFileSync(candidatesFile(root, projectPath), JSON.stringify({ generatedAt: stamp, candidates: lockedCandidates }, null, 2) + '\n');
  } else {
    fs.rmSync(candidatesFile(root, projectPath), { force: true });
  }

  if (!touch.length) {
    const idx = writeIndex(root, { now });
    return {
      ok: true,
      noop: true,
      project: projectPath,
      sources: scanned.sources.length,
      skippedSources: scanned.skipped,
      wrote: 0,
      stale,
      lockedCandidates,
      conflicts,
      index: idx.file,
    };
  }

  const backup = backupState({ cardDir: cDir, index, root, now });
  try {
    if (typeof opts.beforeWrite === 'function') opts.beforeWrite();
    fs.mkdirSync(cDir, { recursive: true });
    for (const item of touch) {
      fs.mkdirSync(path.dirname(item.file), { recursive: true });
      fs.writeFileSync(item.file, item.text);
    }
    const idx = writeIndex(root, { now });
    pruneBackups(root);
    return {
      ok: true,
      project: projectPath,
      sources: scanned.sources.length,
      skippedSources: scanned.skipped,
      wrote,
      stale,
      lockedCandidates,
      conflicts,
      cardsDir: cDir,
      index: idx.file,
      backup,
    };
  } catch (err) {
    const rolledBack = restoreState({ cardDir: cDir, index, backup, root });
    return {
      ok: false,
      reason: 'write-failed',
      message: String((err && err.message) || err),
      rolledBack,
      project: projectPath,
    };
  }
}

function readCandidates({ root, projectPath }) {
  try {
    return JSON.parse(fs.readFileSync(candidatesFile(root, projectPath), 'utf8')).candidates || [];
  } catch {
    return [];
  }
}

/** ticket 关闭后的增量入口：只扫新增/变化来源。 */
async function updateAfterTicket(opts = {}) {
  return generateCards({ ...opts, incremental: true });
}

module.exports = { generateCards, updateAfterTicket, arbitrateNames, readCandidates, projectSlug };
