// world/study/card.js
// desktop-world · 学习卡片渲染与追加（纯函数，无IO，可直接单测）。
//
// 语义边界（与「今日 tips」严格区分）：
//   今日 tips  = 一天一份，反映「今天发生了什么」，按日报覆盖式重写（world/pipeline.writeDayNotes）
//   学习卡片   = 一个 keyword 一份，长期累积，**永不覆盖，只追加**（本文件）
// 所以本文件的所有渲染都是「读旧文→ 在尾部接一节 → 回写」，任何一条已有实证都不会被改写。
'use strict';

const CARD_PREFIX = 'kw-';
// 卡片里出现的分节标记。追加前用它判断「这天的这一节已经在不在」，这是同日幂等的唯一依据。
const EVIDENCE_HEADING = '## 📌 今日实证';
const BLANK_HEADING = '## 🧩 空白区';

const STATUS = {
  // 还没有任何实证 → 明确告诉用户「配了但还没命中」，而不是留一张空卡让人以为功能坏了
  pending: '待补料',
  // 有实证，但只有 1 天 → 还在攒
  learning: '学习中',
  // 实证跨了 ≥3 个不同日期 → 认为已沉淀
  settled: '已沉淀',
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(s) {
  return DAY_RE.test(String(s || ''));
}

function escapeInline(s) {
  // 关键词/方向/tips 都是模型或用户给的自由文本，进 md 前收掉会破坏卡片结构的字符。
  // 关键的一条是换行：一段文本里只要带换行，就能把内容拆成新的 "## 分节"，伪造出
  // 一条并不存在的实证（或覆盖掉空白区）。所以先把所有换行（含 \r\n）折叠成空格 ——
  // 折成空格之后 md 的行结构就不可能被伪造了，剩下的只有表格竖线需要收。
  // 只做结构字符处理，不做 HTML 转义——本文件只输出 md，不进 innerHTML。
  return String(s == null ? '' : s)
    .replace(/\r\n?|\n/g, ' ')
    .replace(/\|/g, '/')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// 一条实证（结构化考点对象）→ md 行。字段缺失就少一行，不留「undefined」。
function renderEvidence(tip) {
  if (typeof tip === 'string') {
    const t = escapeInline(tip);
    return t ? [`- 【考点】${t}`] : [];
  }
  if (!tip || typeof tip !== 'object') return [];
  const topic = escapeInline(tip.topic);
  if (!topic) return [];
  const lines = [`- 【考点】${topic}`];
  if (tip.answer) lines.push(`  - **标准答案**：${escapeInline(tip.answer)}`);
  if (tip.hook) lines.push(`  - **记忆钩子**：${escapeInline(tip.hook)}`);
  if (tip.action) lines.push(`  - **可操作方法**：${escapeInline(tip.action)}`);
  return lines;
}

// 从卡片正文里数出已沉淀的不同日期数——「已沉淀」的判定依据。
// 只认规范写法「## 📌 今日实证（YYYY-MM-DD）」，避免正文里随口写的日期被误计。
function countEvidenceDays(body) {
  const seen = new Set();
  const re = new RegExp(`${EVIDENCE_HEADING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}（(\\d{4}-\\d{2}-\\d{2})）`, 'g');
  let m = re.exec(String(body || ''));
  while (m) {
    seen.add(m[1]);
    m = re.exec(String(body || ''));
  }
  return seen;
}

function deriveStatus(body) {
  const days = countEvidenceDays(body);
  if (!days.size) return STATUS.pending;
  return days.size >= 3 ? STATUS.settled : STATUS.learning;
}

/**
 * 建一张新卡片的完整正文。
 *
 * 注意「最近命中」在建档时**恒为"尚未命中"**：新卡片此刻只有空白区，没有任何实证。
 * 把建档日期顺手写进「最近命中」是误导——用户会以为今天已经学过这个考点了。
 * 真正的最近命中日期由 appendEvidence() 在追加第一条实证时写入。
 *
 * @param {object} meta { keyword, direction, kwId, date, sourceFile }
 * @returns {string} md 正文
 */
function renderNewCard({ keyword, direction, kwId, date, sourceFile }) {
  const d = escapeInline(direction);
  return [
    `# ${escapeInline(keyword)}`,
    '',
    `- 所属方向：${d || '（未标注）'}`,
    `- 状态：${STATUS.pending}`,
    `- 关键词 id：${kwId}`,
    `- 首次收录：${isValidDate(date) ? date : '（未记录）'}`,
    '- 最近命中：尚未命中',
    '',
    BLANK_HEADING,
    '_还没有真实会话命中这个考点。做过相关的事之后，日报里的八股总结会自动回填到这里。_',
    '',
  ].join('\n');
}

/**
 * 把「某一天的一批实证」追加进已有卡片正文。**纯函数**：返回新正文，不改入参。
 *
 * 幂等保证：同一天已经有实证分节时返回 null（调用方跳过写入），所以同日重跑不会重复追加。
 * 这是「同一天重跑 runDaily 卡片不重复追加」的全部实现——不依赖任何额外状态文件。
 *
 * @param {string} body  已有卡片正文（不存在时传空串）
 * @param {object} opts  { date, tips, sourceFile }
 * @returns {string|null} 新正文；当日已追加过则返回 null
 */
function appendEvidence(body, { date, tips, sourceFile } = {}) {
  if (!isValidDate(date)) return null;
  const list = Array.isArray(tips) ? tips : [];
  const head = `${EVIDENCE_HEADING}（${date}）`;
  // 同日幂等：这天的分节已经在正文里，直接放弃追加
  if (String(body || '').includes(head)) return null;

  const blocks = [];
  for (const tip of list) {
    const lines = renderEvidence(tip);
    if (lines.length) blocks.push(lines.join('\n'));
  }
  if (!blocks.length) return null;

  const text = String(body || '');
  // 空白区是「还没命中」的占位，一旦有了实证就该让位给真实内容
  let next = text;
  if (next.includes(BLANK_HEADING)) {
    const at = next.indexOf(BLANK_HEADING);
    const end = next.indexOf('\n## ', at + BLANK_HEADING.length);
    const tail = end === -1 ? '' : next.slice(end);
    next = `${next.slice(0, at).replace(/\s+$/, '')}\n${tail}`.replace(/\n{3,}/g, '\n\n');
  }
  if (!next.trim()) return null; // 空正文不追加（应该先 renderNewCard 建档）

  const section = [head, ...blocks].join('\n');
  const appended = `${next.replace(/\s+$/, '')}\n\n${section}\n`;

  // 头部元信息跟着最新命中日走：状态重算 + 最近命中日期/来源
  const status = deriveStatus(appended);
  const withStatus = replaceMetaLine(appended, '状态', status);
  const src = escapeInline(sourceFile || '日报');
  return replaceMetaLine(withStatus, '最近命中', `${date}（来自 ${src}）`).replace(/\s+$/, '') + '\n';
}

// 头部元信息行的原地替换（只动第一处匹配；找不到就原样返回，不抛）
function replaceMetaLine(body, label, value) {
  const re = new RegExp(`^(\\- ${label}：).*$`, 'm');
  if (!re.test(body)) return body;
  return body.replace(re, `$1${value}`);
}

module.exports = {
  CARD_PREFIX,
  EVIDENCE_HEADING,
  BLANK_HEADING,
  STATUS,
  isValidDate,
  renderEvidence,
  renderNewCard,
  appendEvidence,
  deriveStatus,
  countEvidenceDays,
};
