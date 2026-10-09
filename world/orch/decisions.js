// world/orch/decisions.js
// desktop-world · LLM 决策记录的落盘（复盘用）。
//
// 为什么落盘：编排链路里"为什么拆成这几条""为什么退回本地"是最需要事后能回答的问题。
// Jev 是概率模型，同一目标两次拆分可能不同；没有落盘就只能靠猜。
//
// 落什么：**端点、模型、耗时、成功/失败原因、HTTP 状态、原始响应**。
// 不落什么：**API key**（任何形式）、请求体里的用户目标原文另存于工单账本，
// 决策记录只留模型给出的结构化结果与元信息 —— 复盘要的是"模型说了什么"，
// 不是"我问了什么"（后者已经在 tickets.json 里了）。
//
// 隐私边界：这些文件**只落在本机** ~/.desktop-world/orch/decisions/，0600，永不出网。
// 唯一的出网动作是用户显式 opt-in 后那一次 JEV 请求本身。
'use strict';

const fs = require('fs');
const path = require('path');
const { ORCH_DIR } = require('./paths');

const DECISIONS_DIR = 'decisions';
// 单次响应原文的落盘上限。超出只留摘要 —— decisions 是复盘材料，不是模型输出仓库。
const MAX_STORED_CHARS = 20000;
// 目录里最多留多少个决策文件，超了按时间淘汰最旧的。不设上限的话
// 一个反复重试的端点能很快把目录堆成几千个文件。
const MAX_FILES = 200;

/** decisions 目录（延迟解析 ORCH_DIR，便于单测注入 root）。 */
function decisionsDir(root = ORCH_DIR) {
  return path.join(root, DECISIONS_DIR);
}

/**
 * 决定落盘文件名。带时间戳是为了排序可读；防碰撞用随机后缀。
 * 不用纯时间戳：同一毫秒内两次调用会互相覆盖，那次失败的记录就丢了。
 * @param {Date} [now] 注入时间（单测要确定性）
 * @param {number} [nonce] 注入随机源，0–1；不传则真随机
 */
function decisionFileName(now = new Date(), nonce = Math.random()) {
  const d = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const iso = d.toISOString().replace(/[:.]/g, '-');
  const n = typeof nonce === 'number' && Number.isFinite(nonce) ? Math.abs(nonce) % 1 : Math.random();
  const suffix = Math.floor(n * 0x10000)
    .toString(16)
    .padStart(4, '0');
  return `${iso}-${suffix}.json`;
}

/**
 * 清洗一条决策记录：剥掉一切可能带密钥的字段，并截断。
 * 纯函数，可单测。**这是隐私边界的代码落点**——宁可多删字段。
 *
 * 注意落的是 **probs（0..1 的概率）而不是文本**：Jev 不生成文本（见 llm.js 文件头），
 * 它给出的是一组判断概率。复盘要看的是"当初模型给这个判断打了多少分"，那正是 probs。
 * state（用户目标原文）不进这里 —— 它已经在 tickets.json 里了，不重复存。
 */
function sanitizeEntry(entry = {}) {
  const out = {
    at: entry.at || new Date().toISOString(),
    ok: entry.ok === true,
    source: entry.source || 'local',
    attempts: Number.isFinite(entry.attempts) ? entry.attempts : 0,
    durationMs: Number.isFinite(entry.durationMs) ? entry.durationMs : 0,
  };
  if (entry.purpose) out.purpose = String(entry.purpose).slice(0, 60);
  if (entry.reason) out.reason = String(entry.reason).slice(0, 60);
  if (entry.httpStatus) out.httpStatus = entry.httpStatus;
  if (entry.endpoint) out.endpoint = String(entry.endpoint).slice(0, 300);
  if (entry.model) out.model = String(entry.model).slice(0, 80);
  if (entry.asked) out.asked = entry.asked;
  if (entry.answered) out.answered = entry.answered;
  if (entry.chars) out.chars = entry.chars;
  if (entry.errorSnippet) out.errorSnippet = String(entry.errorSnippet).slice(0, 200);
  if (entry.probs && typeof entry.probs === 'object') {
    // 只留合法概率：NaN / Infinity / 非数字都不该进 decisions
    const probs = {};
    let n = 0;
    for (const [k, v] of Object.entries(entry.probs)) {
      if (!Number.isFinite(v)) continue;
      probs[String(k).slice(0, 60)] = v;
      if (++n >= 20) break;
    }
    if (n) out.probs = probs;
  }
  if (entry.usage && typeof entry.usage === 'object') {
    // token 用量：只看两个计数字段，别把整个 usage 对象带进来
    const u = {};
    if (Number.isFinite(entry.usage.input_tokens)) u.input_tokens = entry.usage.input_tokens;
    if (Number.isFinite(entry.usage.output_tokens)) u.output_tokens = entry.usage.output_tokens;
    if (Object.keys(u).length) out.usage = u;
  }
  // 兼容：老形状（text）仍可落，但截断
  if (typeof entry.text === 'string' && entry.text) {
    out.text = entry.text.slice(0, MAX_STORED_CHARS);
    out.textTruncated = entry.text.length > MAX_STORED_CHARS;
  }
  return out;
}

/**
 * 写一条决策记录。**永不throw** —— 落盘失败不该影响编排结果。
 * @returns {string|null} 写出的文件路径；失败返回 null
 */
function record(root, entry) {
  try {
    const dir = decisionsDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, decisionFileName());
    fs.writeFileSync(file, JSON.stringify(sanitizeEntry(entry), null, 2), { mode: 0o600 });
    prune(dir);
    return file;
  } catch {
    return null;
  }
}

/** 淘汰超出 MAX_FILES 的最旧文件。任何一步出错都静默 —— 清理不该抛。 */
function prune(dir = decisionsDir(), maxFiles = MAX_FILES) {
  try {
    const names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
    const excess = names.length - maxFiles;
    if (excess <= 0) return 0;
    for (const name of names.slice(0, excess)) {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch {
        /* 这个删不掉就跳过，不影响其他 */
      }
    }
    return excess;
  } catch {
    return 0;
  }
}

/** 列出最近的决策记录（新→旧），limit 默认 20。UI/CLI 看复盘用。 */
function list(root = ORCH_DIR, limit = 20) {
  try {
    const dir = decisionsDir(root);
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, Math.max(1, limit))
      .map((name) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 给 llm.js 用的 onDecision 回调工厂：把每次决策写到 root 下的 decisions/。
 * 返回的函数**永远不抛**（llm.js 那边也会再兜一层）。
 */
function recorderFor(root = ORCH_DIR) {
  return (entry) => {
    record(root, entry);
  };
}

module.exports = {
  DECISIONS_DIR,
  MAX_STORED_CHARS,
  MAX_FILES,
  decisionsDir,
  decisionFileName,
  sanitizeEntry,
  record,
  prune,
  list,
  recorderFor,
};