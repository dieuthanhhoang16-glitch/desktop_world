// test/world-learn-grill.test.js
// grill（GRILL/共识）来源：文件名命中、正文首行标题晋升、无命中不晋升、既有六类回归、PRIORITY 冻结。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scanSources, classify, PRIORITY } = require('../world/learn/sources');

function tmpProj() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dwgrill-proj-'));
}

function write(root, rel, body) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function byPath(sources) {
  const map = {};
  for (const s of sources) map[s.path] = s.kind;
  return map;
}

test('grill 文件名命中：docs/design 下的 grill/共识/consensus 文件归为 grill', () => {
  const project = tmpProj();
  // 三份内容必须各异，否则会被 duplicate-content 去重折叠掉
  write(project, 'docs/design/grill-foo.md', '# 随便什么标题 A\n\n正文不含任何触发词甲。\n');
  write(project, 'docs/design/项目共识.md', '# 随便什么标题 B\n\n正文不含任何触发词乙。\n');
  write(project, 'docs/design/consensus-notes.md', '# 随便什么标题 C\n\n正文不含任何触发词丙。\n');
  const { sources } = scanSources(project);
  const kinds = byPath(sources);
  assert.equal(kinds['docs/design/grill-foo.md'], 'grill');
  assert.equal(kinds['docs/design/项目共识.md'], 'grill');
  assert.equal(kinds['docs/design/consensus-notes.md'], 'grill');
});

test('classify 文件名规则：大小写不敏感，任意目录的 md/txt 都算', () => {
  assert.equal(classify('docs/design/GRILL-2026-10-18.md'), 'grill');
  assert.equal(classify('docs/project/grill.txt'), 'grill');
  assert.equal(classify('共识-操作界面化.md'), 'grill');
  assert.equal(classify('notes/CONSENSUS.md'), 'grill');
  assert.equal(classify('docs/design/ordinary.md'), null);
});

test('H1 晋升：路径规则没归类的文档，首行标题含 grill/共识/consensus 即归为 grill', () => {
  const project = tmpProj();
  write(project, 'docs/design/x.md', '# 项目共识：操作界面化\n\n跟什么词都没关系的正文。\n');
  write(project, 'docs/design/y.md', '# GRILL：编排台改造\n\n跟什么词都没关系的正文。\n');
  write(project, 'docs/design/z.md', '# 随便起个名\n\n正文提到共识但标题没有，不晋升。\n');
  const { sources } = scanSources(project);
  const kinds = byPath(sources);
  assert.equal(kinds['docs/design/x.md'], 'grill');
  assert.equal(kinds['docs/design/y.md'], 'grill');
  assert.equal(kinds['docs/design/z.md'], undefined, '正文命中但标题不命中不得晋升');
});

test('既有六类不受影响：各类规则优先于 grill 文件名规则', () => {
  const project = tmpProj();
  write(project, 'GLOSSARY.md', '# 术语表\n\n## 角色\n\n定义。\n');
  write(project, 'docs/agents/grill-setup.md', '# GRILL 标准文档\n\n文件名带 grill，但目录规则优先。\n');
  write(project, 'docs/adr/grill-001.md', '# 决策\n\n同上。\n');
  write(project, 'docs/plans/grill-spec.md', '# 设计\n\n同上。\n');
  write(project, '.scratch/feat/issues/01.md', '# 01: 工单\n\n题目不带触发词。\n');
  write(project, 'docs/handoffs/grill-note.md', '# 交接\n\n同上。\n');
  const { sources } = scanSources(project);
  const kinds = byPath(sources);
  assert.equal(kinds['GLOSSARY.md'], 'glossary');
  assert.equal(kinds['docs/agents/grill-setup.md'], 'agent-doc');
  assert.equal(kinds['docs/adr/grill-001.md'], 'adr');
  assert.equal(kinds['docs/plans/grill-spec.md'], 'spec');
  assert.equal(kinds['.scratch/feat/issues/01.md'], 'ticket');
  assert.equal(kinds['docs/handoffs/grill-note.md'], 'handoff');
});

test('既有六类 classify 返回值一字不动', () => {
  assert.equal(classify('GLOSSARY.md'), 'glossary');
  assert.equal(classify('sub/GLOSSARY.md'), 'glossary');
  assert.equal(classify('docs/agents/x.md'), 'agent-doc');
  assert.equal(classify('docs/adr/001.md'), 'adr');
  assert.equal(classify('docs/plans/x.md'), 'spec');
  assert.equal(classify('.scratch/feat/issues/01.md'), 'ticket');
  assert.equal(classify('.scratch/feat/other.md'), null);
  assert.equal(classify('docs/handoffs/x.md'), 'handoff');
  assert.equal(classify('a/handoff-b.md'), 'handoff');
});

test('PRIORITY 冻结：既有六类数值不变，grill 追加未用值', () => {
  assert.deepEqual({ ...PRIORITY }, {
    glossary: 0,
    'agent-doc': 1,
    adr: 2,
    spec: 3,
    ticket: 4,
    handoff: 5,
    grill: 6,
  });
  assert.ok(Object.isFrozen(PRIORITY));
  assert.throws(() => {
    PRIORITY.grill = 99;
  }, TypeError);
});

test('scanSources 基本字段：grill 来源照常带 title/chars/mtime', () => {
  const project = tmpProj();
  write(project, 'docs/design/grill-x.md', '# 编排台 共识\n\n第一句。\n');
  const { sources } = scanSources(project);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].kind, 'grill');
  assert.equal(sources[0].title, '编排台 共识');
  assert.ok(sources[0].chars > 0);
  assert.ok(sources[0].mtimeMs > 0);
});
