// world/projects/markers.js
// desktop-world · 只读检查 setup-matt-pocock-skills 的标准标记。
//
// 检查只读：不建目录、不写 manifest、不碰项目文件。缺什么就报什么，
// 不"顺手补一个空文件"——那会让未初始化项目看起来像初始化过。
'use strict';

const fs = require('fs');
const path = require('path');

const REQUIRED = Object.freeze(['issueTracker', 'domainDocs', 'agentSkillsBlock', 'glossary']);
const OPTIONAL = Object.freeze(['triageLabels', 'adrDir']);
const ALL = Object.freeze([...REQUIRED, ...OPTIONAL]);

const EXPECTED = Object.freeze({
  issueTracker: 'docs/agents/issue-tracker.md',
  domainDocs: 'docs/agents/domain.md',
  triageLabels: 'docs/agents/triage-labels.md',
  agentSkillsBlock: 'AGENTS.md 或 CLAUDE.md 中的 "## Agent skills" 块',
  glossary: 'GLOSSARY.md',
  adrDir: 'docs/adr/',
});

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function agentSkillsBlock(projectPath) {
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const file = path.join(projectPath, name);
    if (!isFile(file)) continue;
    let body = '';
    try {
      body = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (/^##\s+Agent skills\s*$/m.test(body)) return { found: true, file: name };
  }
  return { found: false, file: null };
}

/**
 * @returns {{markers:object, status:'initialized'|'partial'|'missing', missing:string[], optionalMissing:string[], files:object}}
 */
function checkMarkers(projectPath) {
  const root = path.resolve(String(projectPath || ''));
  const skills = agentSkillsBlock(root);
  const markers = {
    issueTracker: isFile(path.join(root, 'docs', 'agents', 'issue-tracker.md')),
    domainDocs: isFile(path.join(root, 'docs', 'agents', 'domain.md')),
    triageLabels: isFile(path.join(root, 'docs', 'agents', 'triage-labels.md')),
    agentSkillsBlock: skills.found,
    glossary: isFile(path.join(root, 'GLOSSARY.md')),
    adrDir: isDir(path.join(root, 'docs', 'adr')),
  };
  const hit = ALL.filter((id) => markers[id]).length;
  const requiredHit = REQUIRED.filter((id) => markers[id]).length;
  const status = requiredHit === REQUIRED.length ? 'initialized' : hit === 0 ? 'missing' : 'partial';
  const missing = REQUIRED.filter((id) => !markers[id]);
  const optionalMissing = OPTIONAL.filter((id) => !markers[id]);
  return {
    markers,
    status,
    missing,
    optionalMissing,
    files: {
      agentSkillsFile: skills.file,
      issueTracker: path.join(root, 'docs', 'agents', 'issue-tracker.md'),
      domainDocs: path.join(root, 'docs', 'agents', 'domain.md'),
      glossary: path.join(root, 'GLOSSARY.md'),
      adrDir: path.join(root, 'docs', 'adr'),
    },
  };
}

function badge(status) {
  if (status === 'initialized') return null;
  return { label: status === 'missing' ? '未初始化' : '部分初始化', tone: status === 'missing' ? 'warn' : 'info', status };
}

module.exports = { REQUIRED, OPTIONAL, ALL, EXPECTED, checkMarkers, badge, agentSkillsBlock };
