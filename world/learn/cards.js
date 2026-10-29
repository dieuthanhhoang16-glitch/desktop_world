// world/learn/cards.js
// desktop-world · 学习卡纯逻辑：主题规范化、稳定 id、起草、渲染/解析、哈希。
// 无 IO（render 需要绝对来源路径，由调用方传入）。
'use strict';

const crypto = require('crypto');

const SCHEMA = 1;
const KIND_LABEL = Object.freeze({
  glossary: '术语表',
  'agent-doc': '项目标准文档',
  adr: '架构决策记录',
  spec: '设计文档',
  ticket: '工单',
  handoff: '交接文档',
  grill: '共识',
});
const DEFAULT_VERB = Object.freeze({
  glossary: '理解',
  'agent-doc': '应用',
  adr: '决策',
  spec: '设计',
  ticket: '实现',
  handoff: '交接',
  grill: '理解',
});
const KNOWN_VERBS = new Set([
  '拆分', '落地', '实现', '设计', '理解', '决策', '减重', '注册', '检查', '生成',
  '执行', '审批', '复盘', '归档', '隔离', '命名', '排序', '扫描', '复核', '触发',
  '度量', '接入', '配置', '学习', '交接', '应用', '阅读', '部署', '测试', '治理',
  '路由', '调度', '同步', '去重', '回滚', '审计', '判定', '裁决', '提取', '索引',
]);
const GENERIC_HEADINGS = new Set([
  '背景', '目标', '问题', '方案', '验收', '测试', '风险', '状态', '依赖', '为什么',
  '怎么做', '变更', '产物', '总结', '动机', '决策', '备注', '范围', '约束', '前提',
  'out of scope', 'implementation decisions', 'testing decisions', 'further notes',
  'what to build', 'blocked by', 'status', 'problem', 'solution', 'goals',
]);

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function hashSource(text) {
  return 'sha256-' + sha256(text);
}

function asciiSlug(text, max = 40) {
  return (
    String(text || '')
      .replace(/\.[^.]+$/, '')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, max) || 'card'
  );
}

function cleanTitle(raw) {
  return String(raw || '')
    .replace(/^[\s\d]+[.):：、-]*\s*/, '')
    .replace(/[`*_>#\[\]()|]/g, ' ')
    .replace(/[，。；：、！？/\\+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 显示标题固定为「名词 动词」两段；不合法时用 kind 的默认动词补齐。 */
function normalizeTopic(raw, kind = 'ticket') {
  const clean = cleanTitle(raw);
  const parts = clean.split(' ').filter(Boolean);
  let noun = parts[0] || '项目知识';
  let verb = parts[1] || '';
  if (!verb || !KNOWN_VERBS.has(verb)) verb = DEFAULT_VERB[kind] || '理解';
  noun = noun.slice(0, 24);
  verb = verb.slice(0, 12);
  return `${noun} ${verb}`;
}

function isTwoPartTopic(topic) {
  const parts = String(topic || '').trim().split(/\s+/);
  return parts.length === 2 && parts.every((p) => p.length > 0);
}

function anchorFor(heading) {
  const slug = String(heading || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
  return slug ? `#${slug}` : '#top';
}

function oneSentence(text, max = 100) {
  const clean = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+.*$/gm, ' ')
    .replace(/[*_`>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = clean.split(/[。！？.!?]/)[0] || clean;
  return (cut.length > max ? cut.slice(0, max - 1) + '…' : cut) || '暂无摘要';
}

function sectionText(source, heading) {
  if (!heading) return source.body;
  const sec = (source.sections || []).find((s) => s.heading === heading);
  return sec ? sec.text.join('\n') : source.body;
}

function sectionChars(source, heading) {
  return [...sectionText(source, heading).replace(/\s+/g, '')].length || source.chars;
}

function glossaryTerms(source) {
  const terms = [];
  for (const sec of source.sections || []) {
    if (sec.heading && sec.level >= 2) terms.push({ term: sec.heading, heading: sec.heading });
  }
  const bullet = /^\s*[-*]\s+\*\*(.+?)\*\*\s*[:：]\s*(.+)$/gm;
  let m;
  while ((m = bullet.exec(source.body))) terms.push({ term: m[1], heading: '' });
  return terms;
}

function headingsFor(source) {
  const titles = [];
  if (source.title) titles.push({ heading: '', raw: source.title });
  for (const sec of source.sections || []) {
    if (sec.level < 2 || sec.level > 3) continue;
    const h = cleanTitle(sec.heading);
    if (!h || GENERIC_HEADINGS.has(h.toLowerCase()) || h.length < 2) continue;
    if (titles.some((t) => cleanTitle(t.raw) === h)) continue;
    titles.push({ heading: sec.heading, raw: sec.heading });
    if (titles.length >= 3) break;
  }
  return titles;
}

function estimatedMinutes(chars) {
  return Math.max(5, Math.min(180, Math.round(chars / 300 + 15)));
}

function kindLabel(kind) {
  return KIND_LABEL[kind] || '项目文档';
}

/** 确定性起草：GLM 不可用时的降级路径，也用于测试。 */
function draftDeterministic(sources) {
  const drafts = [];
  for (const source of sources) {
    const titles = source.kind === 'glossary' ? glossaryTerms(source) : headingsFor(source);
    const list = titles.length ? titles : [{ heading: '', raw: source.title || source.path }];
    list.forEach((t, i) => {
      const topic = normalizeTopic(t.raw || t.term || t.heading, source.kind);
      const chars = sectionChars(source, t.heading);
      const summary = oneSentence(sectionText(source, t.heading) || source.title);
      const pathBase = source.path.split('/').pop().replace(/\.md$/i, '');
      const id = `${source.kind}-${asciiSlug(pathBase)}-${sha256(source.path).slice(0, 4)}-${i + 1}`;
      drafts.push({
        id,
        topicId: id,
        topic,
        summary,
        points: [
          `学什么：认识「${topic}」在${kindLabel(source.kind)}里的含义与适用边界。`,
          `为什么：它直接影响项目协作时的判断与落地方式。`,
          `怎么练：读原文 ${chars} 字，用自己的话复述，并在项目里找一个实例验证。`,
          `连接：把它与相邻主题一起看，补齐项目知识的上下文。`,
        ],
        sourcePath: source.path,
        anchor: t.heading ? anchorFor(t.heading) : '#top',
        chars,
        sourceHash: hashSource(source.contentHash || source.body),
        kind: source.kind,
      });
    });
    if (drafts.length >= 60) break;
  }
  return drafts;
}

function normalizeDraft(draft, source, index) {
  const topic = normalizeTopic(draft.topic || draft.title, source.kind);
  const chars = Number.isFinite(draft.chars) ? draft.chars : sectionChars(source, '');
  const pathBase = source.path.split('/').pop().replace(/\.md$/i, '');
  const id = draft.id && /^[a-z0-9-]+$/i.test(draft.id)
    ? draft.id
    : `${source.kind}-${asciiSlug(pathBase)}-${sha256(source.path).slice(0, 4)}-${index + 1}`;
  const points = Array.isArray(draft.points) && draft.points.length >= 3
    ? draft.points.slice(0, 5).map((p) => String(p))
    : draftDeterministic([source])[0].points;
  return {
    id,
    topicId: draft.topicId || id,
    topic,
    summary: oneSentence(draft.summary || source.title),
    points,
    sourcePath: source.path,
    anchor: draft.anchor || '#top',
    chars,
    sourceHash: hashSource(source.contentHash || source.body),
    kind: source.kind,
    draftedBy: draft.draftedBy || 'glm',
  };
}

function renderCard(card) {
  const body = [
    `# ${card.topic}`,
    '',
    `- **一句话**：${card.summary}`,
    ...card.points.map((p) => `- ${p}`),
    `- **原文**：[${card.sourcePath}](${card.link || card.sourcePath}${card.anchor === '#top' ? '' : card.anchor})（${card.chars} 字）`,
    '',
  ].join('\n');
  const bodyHash = hashSource(body);
  const fm = [
    '---',
    `schema: ${SCHEMA}`,
    `id: ${card.id}`,
    `project: ${card.project}`,
    `topic: ${card.topic}`,
    `topicId: ${card.topicId}`,
    `summary: ${card.summary}`,
    'sources:',
    `  - path: ${card.sourcePath}`,
    `    anchor: "${card.anchor}"`,
    `    chars: ${card.chars}`,
  ];
  if (Array.isArray(card.prerequisites) && card.prerequisites.length) {
    fm.push('prerequisites:');
    for (const id of card.prerequisites) fm.push(`  - ${id}`);
  }
  fm.push(
    `estimatedMinutes: ${card.estimatedMinutes}`,
    `status: ${card.status}`,
    `locked: ${card.locked === true}`,
    `sourceHash: ${card.sourceHash}`,
    `bodyHash: ${bodyHash}`,
    `generatedAt: ${card.generatedAt}`,
    `generatedBy: ${card.generatedBy}`,
    '---',
    ''
  );
  return fm.join('\n') + body;
}

function parseFrontmatter(text) {
  const s = String(text || '');
  if (!s.startsWith('---\n')) return null;
  const end = s.indexOf('\n---\n', 4);
  if (end < 0) return null;
  const head = s.slice(4, end).split('\n');
  const body = s.slice(end + 5);
  const meta = { sources: [], prerequisites: [] };
  let mode = null;
  let current = null;
  for (const line of head) {
    const pathItem = line.match(/^\s*-\s+path:\s*(.+)$/);
    if (pathItem) {
      current = { path: pathItem[1].trim() };
      meta.sources.push(current);
      mode = 'sources';
      continue;
    }
    const sub = line.match(/^\s{2,}(anchor|chars):\s*(.+)$/);
    if (sub && current) {
      current[sub[1]] = sub[1] === 'chars' ? Number(sub[2]) : sub[2].replace(/^"|"$/g, '');
      continue;
    }
    if (/^sources:\s*$/.test(line)) {
      mode = 'sources';
      current = null;
      continue;
    }
    if (/^prerequisites:\s*$/.test(line)) {
      mode = 'prerequisites';
      continue;
    }
    if (mode === 'prerequisites') {
      const pre = line.match(/^\s*-\s+([A-Za-z0-9._-]+)\s*$/);
      if (pre) {
        meta.prerequisites.push(pre[1]);
        continue;
      }
    }
    if (/^\S/.test(line)) mode = null;
    const kv = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
    if (!kv || mode !== null) continue;
    meta[kv[1]] = kv[2].replace(/^"|"$/g, '');
  }
  meta.locked = meta.locked === 'true';
  meta.status = meta.status || 'active';
  meta.estimatedMinutes = Number(meta.estimatedMinutes) || 0;
  return { meta, body, text: s };
}

/** 读取已有卡片；bodyHash 不匹配或 frontmatter 损坏 → 视为用户已手改（locked）。 */
function inspectCard(text) {
  const parsed = parseFrontmatter(text);
  if (!parsed) return { meta: {}, body: String(text || ''), edited: true, locked: true, valid: false };
  const actual = hashSource(parsed.body);
  const edited = Boolean(parsed.meta.bodyHash && parsed.meta.bodyHash !== actual);
  return {
    ...parsed,
    edited,
    locked: parsed.meta.locked === true || edited,
    valid: true,
  };
}

/** 只改 frontmatter 的 status，正文逐字保留。 */
function withStatus(text, status) {
  const parsed = parseFrontmatter(text);
  if (!parsed) return text;
  const updated = text.replace(/^---\n[\s\S]*?\n---\n/, (block) =>
    block.replace(/^status:.*$/m, `status: ${status}`)
  );
  // 重新计算 bodyHash（正文没变，但 status 行也属于 frontmatter，不影响 body）
  return updated;
}

module.exports = {
  SCHEMA,
  KIND_LABEL,
  DEFAULT_VERB,
  KNOWN_VERBS,
  sha256,
  hashSource,
  asciiSlug,
  normalizeTopic,
  isTwoPartTopic,
  anchorFor,
  oneSentence,
  estimatedMinutes,
  draftDeterministic,
  normalizeDraft,
  renderCard,
  parseFrontmatter,
  inspectCard,
  withStatus,
};
