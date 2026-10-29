// world/learn/plan.js
// desktop-world · 学习计划：前置拓扑 → 深度/阶段 → JEV 同层取舍 → 时长区间 → plan.md。
//
// 可复现性：拓扑与阶段排序是确定性的；JEV 只调整同一层内的顺序，且每次调用
// 的模型与结果都写入 plan.json。JEV 不可用时整条链路退化为纯确定性排序。
'use strict';

const fs = require('fs');
const path = require('path');

const { readAllCards } = require('./index');
const { learnRoot, projectDir, projectSlug } = require('./paths');
const { classify } = require('./sources');

const PHASES = Object.freeze(['glossary', 'agent-doc', 'adr', 'spec', 'ticket', 'handoff']);
const DAILY_CAP_MINUTES = 120;
const CHARS_PER_MINUTE = 300;
const PRACTICE_BUFFER_MINUTES = 15;
const JEV_BATCH = 12;

function cardKind(card) {
  const id = String(card.meta.id || '');
  const hit = PHASES.find((k) => id.startsWith(`${k}-`));
  if (hit) return hit;
  const p = card.meta.sources && card.meta.sources[0] && card.meta.sources[0].path;
  return (p && classify(p)) || 'ticket';
}

function phaseOf(card) {
  const idx = PHASES.indexOf(cardKind(card));
  return idx < 0 ? PHASES.length : idx;
}

function baseMinutes(chars) {
  return Math.max(5, Math.round(Number(chars || 0) / CHARS_PER_MINUTE + PRACTICE_BUFFER_MINUTES));
}

function rangeOf(base) {
  return { low: Math.max(1, Math.round(base * 0.75)), high: Math.round(base * 1.25) };
}

function deterministicCompare(a, b) {
  return (
    phaseOf(a) - phaseOf(b) ||
    (a.meta.estimatedMinutes || 0) - (b.meta.estimatedMinutes || 0) ||
    String(a.meta.topic || '').localeCompare(String(b.meta.topic || ''), 'zh-CN') ||
    String(a.meta.id).localeCompare(String(b.meta.id))
  );
}

function loadProjectCards(root, projectPath) {
  return readAllCards(root).filter(
    (c) => c.slug === projectSlug(projectPath) && (c.meta.status || 'active') === 'active'
  );
}

/**
 * 显式 prerequisites + 阶段前置：每个阶段依赖上一个非空阶段的全部卡片。
 * 这样"先术语、再标准、再决策/设计、最后工单"的深度是可解释的。
 */
function buildGraph(cards) {
  const byId = new Map(cards.map((c) => [c.meta.id, c]));
  const phaseGroups = new Map();
  for (const card of cards) {
    const p = phaseOf(card);
    if (!phaseGroups.has(p)) phaseGroups.set(p, []);
    phaseGroups.get(p).push(card);
  }
  const phases = [...phaseGroups.keys()].sort((a, b) => a - b);
  const previousPhase = new Map();
  for (let i = 0; i < phases.length; i += 1) previousPhase.set(phases[i], i > 0 ? phases[i - 1] : null);

  const prereqs = new Map();
  for (const card of cards) {
    const set = new Set();
    for (const id of card.meta.prerequisites || []) if (byId.has(id) && id !== card.meta.id) set.add(id);
    const prev = previousPhase.get(phaseOf(card));
    if (prev !== null && prev !== undefined) {
      for (const other of phaseGroups.get(prev) || []) set.add(other.meta.id);
    }
    prereqs.set(card.meta.id, set);
  }
  return { byId, prereqs };
}

function findCycle(ids, prereqs) {
  const state = new Map(); // 0 unvisited, 1 visiting, 2 done
  const stack = [];
  let cycle = null;
  function dfs(id) {
    if (cycle) return;
    state.set(id, 1);
    stack.push(id);
    for (const dep of prereqs.get(id) || []) {
      if (!state.get(dep)) dfs(dep);
      else if (state.get(dep) === 1) {
        const start = stack.indexOf(dep);
        cycle = [...stack.slice(start), dep];
        return;
      }
      if (cycle) return;
    }
    stack.pop();
    state.set(id, 2);
  }
  for (const id of ids) if (!state.get(id)) dfs(id);
  return cycle;
}

function topoLayers(cards, prereqs) {
  const indegree = new Map();
  const dependents = new Map();
  for (const card of cards) {
    indegree.set(card.meta.id, prereqs.get(card.meta.id).size);
    dependents.set(card.meta.id, []);
  }
  for (const [id, deps] of prereqs) {
    for (const dep of deps) dependents.get(dep).push(id);
  }
  const depth = new Map(cards.map((c) => [c.meta.id, 0]));
  const byId = new Map(cards.map((c) => [c.meta.id, c]));
  const queue = cards.filter((c) => indegree.get(c.meta.id) === 0).sort(deterministicCompare);
  const layers = [];
  let processed = 0;
  while (queue.length) {
    const layer = queue.splice(0).sort(deterministicCompare);
    layers.push(layer);
    const next = [];
    for (const card of layer) {
      processed += 1;
      for (const childId of dependents.get(card.meta.id)) {
        depth.set(childId, Math.max(depth.get(childId), depth.get(card.meta.id) + 1));
        indegree.set(childId, indegree.get(childId) - 1);
        if (indegree.get(childId) === 0) next.push(byId.get(childId));
      }
    }
    queue.push(...next);
  }
  if (processed !== cards.length) return { ok: false, cycle: findCycle(cards.map((c) => c.meta.id), prereqs) };
  return { ok: true, layers, depth };
}

async function orderLayer(layer, { decider }) {
  const sorted = layer.slice().sort(deterministicCompare);
  if (sorted.length < 2 || typeof decider !== 'function') return { cards: sorted, mode: 'deterministic', model: null };
  const ordered = [];
  let model = null;
  for (let i = 0; i < sorted.length; i += JEV_BATCH) {
    const chunk = sorted.slice(i, i + JEV_BATCH);
    const questions = {};
    for (const card of chunk) {
      questions[card.meta.id] = {
        type: 'noul',
        instructions: `「${card.meta.topic}」应该排在这一层更靠前的位置的程度`,
      };
    }
    let res = null;
    try {
      res = await decider({
        state: `学习顺序：同层 ${chunk.length} 张卡片，按先学优先级排序。`,
        questions,
        purpose: 'study-plan-order',
      });
    } catch {
      res = null;
    }
    if (!res || !res.ok) {
      ordered.push(...chunk);
      continue;
    }
    model = res.model || model;
    const scored = chunk.map((card) => {
      const a = res.answers && res.answers[card.meta.id];
      const p = typeof a === 'number' ? a : a && typeof a.noul === 'number' ? a.noul : 0;
      return { card, p };
    });
    scored.sort((a, b) => b.p - a.p || deterministicCompare(a.card, b.card));
    ordered.push(...scored.map((s) => s.card));
  }
  return { cards: ordered, mode: model ? 'jev' : 'deterministic', model };
}

function planDays(items) {
  const days = [];
  let current = { minutes: 0, cards: [] };
  for (const item of items) {
    if (current.cards.length && current.minutes + item.minutes.base > DAILY_CAP_MINUTES) {
      days.push(current);
      current = { minutes: 0, cards: [] };
    }
    current.minutes += item.minutes.base;
    current.cards.push(item);
  }
  if (current.cards.length) days.push(current);
  return days.map((d, i) => ({
    day: i + 1,
    minutes: {
      low: d.cards.reduce((n, c) => n + c.minutes.low, 0),
      high: d.cards.reduce((n, c) => n + c.minutes.high, 0),
    },
    cards: d.cards.map((c) => c.id),
  }));
}

function topicOf(cardsById, id) {
  return (cardsById.get(id) && cardsById.get(id).meta.topic) || id;
}

function diffAgainst(previous, currentCards) {
  if (!previous || !previous.cards) return null;
  const oldMap = new Map(previous.cards.map((c) => [c.id, c]));
  const newMap = new Map(currentCards.map((c) => [c.id, c]));
  const added = currentCards.filter((c) => !oldMap.has(c.id)).map((c) => ({ id: c.id, topic: c.topic }));
  const removed = previous.cards.filter((c) => !newMap.has(c.id)).map((c) => ({ id: c.id, topic: c.topic }));
  const changed = [];
  for (const c of currentCards) {
    const old = oldMap.get(c.id);
    if (!old) continue;
    if (old.chars !== c.chars || old.sourceHash !== c.sourceHash) {
      changed.push({ id: c.id, topic: c.topic, chars: { from: old.chars, to: c.chars }, sourceChanged: old.sourceHash !== c.sourceHash });
    }
  }
  const oldOrder = previous.cards.map((c) => c.id).filter((id) => newMap.has(id));
  const newOrder = currentCards.map((c) => c.id).filter((id) => oldMap.has(id));
  const moved = newOrder
    .map((id, i) => ({ id, from: oldOrder.indexOf(id), to: i }))
    .filter((x) => x.from !== x.to)
    .map((x) => ({ id: x.id, topic: newMap.get(x.id).topic, from: x.from + 1, to: x.to + 1 }));
  return { added, removed, changed, moved, previousGeneratedAt: previous.generatedAt || null };
}

function renderPlanMarkdown(plan) {
  const lines = [
    `# 学习计划 · ${plan.projectName}`,
    '',
    `> 生成时间：${plan.generatedAt} · 排序：${plan.ordering.mode === 'jev' ? `JEV（${plan.ordering.model || 'jev'}）` : '确定性规则'} · 卡片 ${plan.cards.length} 张 · 总计 ${plan.totalMinutes.low}–${plan.totalMinutes.high} 分钟`,
    '',
    '## 输入',
    '',
    '| # | 主题 | 来源 | 字数 | 预计 | 前置 |',
    '|---|---|---|---|---|---|',
  ];
  plan.cards.forEach((c, i) => {
    const pre = c.prerequisites.length ? c.prerequisites.map((id) => topicOf(plan.byId, id)).slice(0, 4).join('、') + (c.prerequisites.length > 4 ? ' 等' : '') : '—';
    lines.push(`| ${i + 1} | ${c.topic} | ${c.sourcePath} | ${c.chars} | ${c.minutes.low}–${c.minutes.high} 分钟 | ${pre} |`);
  });
  lines.push('');
  for (const day of plan.days) {
    lines.push(`## 第 ${day.day} 天（${day.minutes.low}–${day.minutes.high} 分钟）`, '');
    for (const id of day.cards) {
      const item = plan.cards.find((c) => c.id === id);
      lines.push(`${plan.cards.indexOf(item) + 1}. **${item.topic}** — ${item.minutes.low}–${item.minutes.high} 分钟（来源 ${item.chars} 字）`);
      if (item.prerequisites.length) {
        lines.push(`   - 前置：${item.prerequisites.map((pid) => topicOf(plan.byId, pid)).slice(0, 4).join('、')}${item.prerequisites.length > 4 ? ' 等' : ''}`);
      }
      lines.push(`   - 卡片：${item.file}`);
    }
    lines.push('');
  }
  lines.push(`> 单日上限 ${DAILY_CAP_MINUTES} 分钟（按基础时长分组，区间上限可能略超）。`, '');
  if (plan.diff) {
    lines.push('## 重新规划差异', '');
    if (!plan.diff.added.length && !plan.diff.removed.length && !plan.diff.changed.length && !plan.diff.moved.length) {
      lines.push('- 与上一版无差异。');
    } else {
      for (const x of plan.diff.added) lines.push(`- 新增：${x.topic}（${x.id}）`);
      for (const x of plan.diff.removed) lines.push(`- 删除：${x.topic}（${x.id}）`);
      for (const x of plan.diff.changed) lines.push(`- 字数/来源变化：${x.topic}（${x.chars.from} → ${x.chars.to} 字${x.sourceChanged ? '，来源已更新' : ''}）`);
      for (const x of plan.diff.moved) lines.push(`- 顺序变化：${x.topic}（第 ${x.from} → 第 ${x.to}）`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function createPlan(opts = {}) {
  const projectPath = path.resolve(String(opts.projectPath || ''));
  const root = learnRoot(opts.root);
  const now = opts.now || (() => new Date());
  const cards = loadProjectCards(root, projectPath);
  if (!cards.length) {
    return { ok: false, reason: 'no-cards', project: projectPath, message: '没有可用的学习卡；先运行 world:learn generate。' };
  }
  const { byId, prereqs } = buildGraph(cards);
  const topo = topoLayers(cards, prereqs);
  if (!topo.ok) {
    return {
      ok: false,
      reason: 'dependency-cycle',
      project: projectPath,
      cycle: topo.cycle || [],
      message: `前置依赖成环：${(topo.cycle || []).join(' → ')}`,
    };
  }

  const orderingLayers = [];
  const orderedCards = [];
  for (let index = 0; index < topo.layers.length; index += 1) {
    const layer = topo.layers[index];
    const ordered = await orderLayer(layer, { decider: opts.decider });
    orderingLayers.push({ depth: index, mode: ordered.mode, model: ordered.model, size: layer.length });
    orderedCards.push(...ordered.cards);
  }
  const usedJev = orderingLayers.some((l) => l.mode === 'jev');
  const jevModel = orderingLayers.find((l) => l.model)?.model || null;

  const items = orderedCards.map((card) => {
    const source = (card.meta.sources && card.meta.sources[0]) || {};
    const chars = Number(source.chars) || 0;
    const base = baseMinutes(chars);
    return {
      id: card.meta.id,
      topic: card.meta.topic,
      sourcePath: source.path || '',
      anchor: source.anchor || '#top',
      chars,
      sourceHash: card.meta.sourceHash || '',
      minutes: { base, ...rangeOf(base) },
      prerequisites: [...(prereqs.get(card.meta.id) || [])].sort(),
      file: card.file,
    };
  });

  const days = planDays(items);
  const generatedAt = now().toISOString();
  const planPath = path.join(projectDir(root, projectPath), 'plan.md');
  const jsonPath = path.join(projectDir(root, projectPath), 'plan.json');
  let previous = null;
  try {
    previous = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch {
    previous = null;
  }
  const inputCards = items.map((c) => ({ id: c.id, topic: c.topic, chars: c.chars, sourceHash: c.sourceHash }));
  const diff = diffAgainst(previous, inputCards);
  const plan = {
    schemaVersion: 1,
    project: projectPath,
    projectName: path.basename(projectPath),
    generatedAt,
    ordering: { mode: usedJev ? 'jev' : 'deterministic', model: usedJev ? jevModel : null, layers: orderingLayers },
    totalMinutes: {
      low: items.reduce((n, c) => n + c.minutes.low, 0),
      high: items.reduce((n, c) => n + c.minutes.high, 0),
    },
    dailyCapMinutes: DAILY_CAP_MINUTES,
    cards: items,
    days,
    byId,
    inputs: { generatedAt, cards: inputCards },
    diff,
  };

  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  const md = renderPlanMarkdown(plan);
  fs.writeFileSync(planPath, md);
  fs.writeFileSync(jsonPath, JSON.stringify({ ...plan, byId: undefined }, null, 2) + '\n');
  return { ok: true, planPath, jsonPath, plan, diff, ordering: plan.ordering, days, totalMinutes: plan.totalMinutes };
}

function readPlan({ root, projectPath } = {}) {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectDir(root, projectPath), 'plan.json'), 'utf8'));
  } catch {
    return null;
  }
}

module.exports = {
  PHASES,
  DAILY_CAP_MINUTES,
  CHARS_PER_MINUTE,
  PRACTICE_BUFFER_MINUTES,
  baseMinutes,
  rangeOf,
  cardKind,
  buildGraph,
  topoLayers,
  planDays,
  diffAgainst,
  createPlan,
  readPlan,
  renderPlanMarkdown,
};
