// world/roles/prompt.js · 组装 system prompt：contract + card + brief。
//
// 铁律：
//   1. 拼装顺序固定 contract → card → brief；任何顺序漂移必须直接表现为 hash 漂移。
//   2. 任一段为空就拒绝拼装——发了半个 prompt 给 agent 比不发更糟。
//   3. 段内的 `\n---\n` 必须被中和，否则一段可以伪造分隔符截断/替换其他段。
//
// 本模块是纯函数；读写、落盘都不在这里。
'use strict';

const crypto = require('crypto');

const SEPARATOR = '\n\n---\n\n';
const ORDER = Object.freeze(['contract', 'card', 'brief']);

function sha256Hex(text) {
  return 'sha256-' + crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function assertNonEmpty(name, text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string (missing or empty)`);
  }
}

// 段内如出现独立一行的 `---`，换成 `— — —`。这层防御不是为了让模型更安全
// （模型不会被分隔符骗），而是为了让**hash 检查工具有一个不变量**：
// 拼装结果里出现 `\n---\n` 恰好 2 次 = 三段拼接正确，否则就是被污染。
//
// manifest 记录的是 segment 的 hash（即 trim+中和 之后的字节），不是源文件
// 原文的 hash。这样漂移检查器拿 manifest 对照已落盘的 system-prompt.md 就能
// 自检，不用把中和规则再实现一遍。
function neutralizeSeparators(text) {
  return text.replace(/\n---+\s*\n/g, '\n— — —\n');
}

function segment(text) {
  return neutralizeSeparators(String(text).trim());
}

/**
 * 组装 system prompt。
 *
 * @param {object} opts
 * @param {string} opts.contract 全局契约正文
 * @param {string} opts.card     角色卡正文
 * @param {string} opts.brief    任务简报正文
 * @param {string} opts.role     角色 id（仅用于回执/manifest，不进 prompt）
 * @returns {{ content: string, hash: string }}
 *   content 即要写到 config-dir/system-prompt.md 的全文。
 *   hash    是 content 的 sha256-…；同输入必同 hash。
 */
function assemble(opts) {
  const { contract, card, brief } = opts || {};
  assertNonEmpty('contract', contract);
  assertNonEmpty('card', card);
  assertNonEmpty('brief', brief);

  const parts = [contract, card, brief].map(segment);
  const content = parts.join(SEPARATOR) + '\n';
  return { content, hash: sha256Hex(content) };
}

/**
 * 生成 manifest（落盘为 config-dir/prompt.manifest.json）。
 *
 * manifest 是漂移检查的证据：它记录**写进 system-prompt.md 的那三段字节**的 sha256，
 * 加上拼装顺序、时间、当时选定的角色与模型。`check` 子命令（后续 ticket）拿这份
 * manifest 就能对照 config-dir 已落盘文件自检，无需重新实现拼装。
 *
 * @param {object} opts 同 assemble，另加 assembledAt / model / hash（预计算的拼装 hash，可省一次重复 assemble）。
 */
function manifest(opts) {
  const { contract, card, brief, role, model, assembledAt, hash } = opts || {};
  assertNonEmpty('contract', contract);
  assertNonEmpty('card', card);
  assertNonEmpty('brief', brief);
  const assembledSha256 = hash || assemble({ contract, card, brief, role }).hash;
  return {
    schemaVersion: 1,
    order: [...ORDER],
    role: role || null,
    model: model || null,
    assembledAt: assembledAt || new Date().toISOString(),
    contractSha256: sha256Hex(segment(contract)),
    cardSha256: sha256Hex(segment(card)),
    briefSha256: sha256Hex(segment(brief)),
    assembledSha256,
  };
}

module.exports = { assemble, manifest, sha256Hex, ORDER, SEPARATOR };
