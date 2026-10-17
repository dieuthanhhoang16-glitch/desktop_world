// world/project/markers.js
// desktop-world · setup-matt-pocock-skills 标准标记的只读检查（纯 fs 判定，不写盘、不经 Electron）。
//
// 六个标记对应 setup skill 落盘的工件：
//   issueTracker     docs/agents/issue-tracker.md
//   domainDocs       docs/agents/domain.md
//   triageLabels     docs/agents/triage-labels.md   （可选——只有装了 triage 才会写；不参与状态判定）
//   agentSkillsBlock 根目录 CLAUDE.md 或 AGENTS.md 里的 `## Agent skills` 块
//   glossary         根目录 GLOSSARY.md（多上下文布局则 GLOSSARY-MAP.md）
//   adrDir           docs/adr/ 目录
//
// 状态：五个必需标记全齐 → initialized；全缺 → missing；之间 → partial。
//
// 安全约定：只访问上述固定相对路径，绝不 glob 通读项目目录（密钥文件如 .env、
// ~/.config/agentero/settings.json 永远不在读取清单里）。文件存在但 0 字节视为缺。
'use strict';

const fs = require('fs');
const path = require('path');

const MARKER_KEYS = Object.freeze([
  'issueTracker',
  'domainDocs',
  'triageLabels',
  'agentSkillsBlock',
  'glossary',
  'adrDir',
]);
// 必需标记：缺任一就谈不上 initialized。triageLabels 是可选项（spec：可选的 triage-labels.md）。
const REQUIRED_KEYS = Object.freeze(MARKER_KEYS.filter((k) => k !== 'triageLabels'));

/** 非空文件（0 字节视为缺）。 */
function hasFile(file) {
  try {
    return fs.statSync(file).isFile() && fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}
function hasDir(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** CLAUDE.md 优先、AGENTS.md 兜底（与 setup skill 的选文件规则一致）：任一含块即算有。 */
function hasAgentSkillsBlock(projectDir) {
  const re = /^##\s+Agent skills\b.*$/m;
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const file = path.join(projectDir, name);
    try {
      if (fs.statSync(file).isFile() && re.test(fs.readFileSync(file, 'utf8'))) return true;
    } catch { /* 读不到就换下一份 */ }
  }
  return false;
}

/**
 * 只读评估一个项目的六项标记。projectDir 不存在时抛错（调用方决定怎么降级）。
 * 返回 { markers: {…六个布尔}, status: 'initialized'|'partial'|'missing', missing: [键…] }。
 */
function evaluate(projectDir) {
  const root = String(projectDir || '');
  if (!root || !hasDir(root)) throw new Error(`项目目录不存在：${root || '(空)'}`);
  const result = {
    issueTracker: hasFile(path.join(root, 'docs', 'agents', 'issue-tracker.md')),
    domainDocs: hasFile(path.join(root, 'docs', 'agents', 'domain.md')),
    triageLabels: hasFile(path.join(root, 'docs', 'agents', 'triage-labels.md')),
    agentSkillsBlock: hasAgentSkillsBlock(root),
    glossary: hasFile(path.join(root, 'GLOSSARY.md')) || hasFile(path.join(root, 'GLOSSARY-MAP.md')),
    adrDir: hasDir(path.join(root, 'docs', 'adr')),
  };
  const requiredHits = REQUIRED_KEYS.filter((k) => result[k]).length;
  let status = 'partial';
  if (requiredHits === REQUIRED_KEYS.length) status = 'initialized';
  else if (requiredHits === 0) status = 'missing';
  return { markers: result, status, missing: MARKER_KEYS.filter((k) => !result[k]) };
}

module.exports = { MARKER_KEYS, REQUIRED_KEYS, evaluate };
