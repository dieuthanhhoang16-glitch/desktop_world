// world/roles/prompt.js
// desktop-world · 角色提示拼装（纯函数）。顺序固定为：全局契约 → 角色卡 → 任务简报。
// 顺序是契约的一部分：先立边界，再给身份，最后给任务；反过来会让任务细节盖过边界。
'use strict';

const crypto = require('crypto');

const SECTION = Object.freeze({
  contract: 'SECTION:CONTRACT',
  card: 'SECTION:ROLE-CARD',
  brief: 'SECTION:TASK-BRIEF',
});

function sha256(text) {
  return crypto.createHash('sha256').update(String(text == null ? '' : text)).digest('hex');
}

function normalizeBlock(s) {
  return String(s == null ? '' : s).replace(/\r\n?/g, '\n').trim();
}

/**
 * @param {{contract:string, card:string, brief:string}} parts
 * @returns {{text:string, hash:string, sections:{contract:string, card:string, brief:string}}}
 */
function composePrompt({ contract, card, brief } = {}) {
  const c = normalizeBlock(contract);
  const r = normalizeBlock(card);
  const b = normalizeBlock(brief);
  if (!c) throw new Error('缺全局契约，拒绝拼装提示');
  if (!r) throw new Error('缺角色卡，拒绝拼装提示');
  if (!b) throw new Error('缺任务简报，拒绝拼装提示');

  const text = [
    `<!-- ${SECTION.contract} -->`,
    c,
    '',
    `<!-- ${SECTION.card} -->`,
    r,
    '',
    `<!-- ${SECTION.brief} -->`,
    b,
    '',
  ].join('\n');

  return {
    text,
    hash: sha256(text),
    sections: { contract: sha256(c), card: sha256(r), brief: sha256(b) },
  };
}

module.exports = { SECTION, sha256, composePrompt };
