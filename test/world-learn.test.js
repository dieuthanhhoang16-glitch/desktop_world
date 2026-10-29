// test/world-learn.test.js
// 学习卡：来源扫描、全量生成、主题格式、全局索引、增量、locked、stale、回滚、命名裁决。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scanSources } = require('../world/learn/sources');
const { generateCards, updateAfterTicket } = require('../world/learn/generate');
const { readAllCards, buildIndex } = require('../world/learn/index');
const cards = require('../world/learn/cards');
const { cardsDir } = require('../world/learn/paths');

function tmpDir(prefix = 'dwlearn-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(root, rel, body) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

const LONG = '这是一段不该被复制进卡片的超长原文，'.repeat(30) + '结束标记。';

function makeProject(name = 'alpha') {
  const dir = path.join(tmpDir('dwlearn-proj-'), name);
  fs.mkdirSync(dir, { recursive: true });
  write(dir, 'docs/agents/domain.md', '# 工单 拆分\n\n把工单拆成可独立完成的小任务。\n\n' + LONG + '\n');
  write(dir, 'GLOSSARY.md', '# 术语表\n\n## 角色\n\n角色的定义。\n\n## 权限\n\n权限的边界。\n');
  write(dir, 'docs/adr/001-slim.md', '# 配置 减重\n\n定期清理过期配置。\n');
  write(dir, 'docs/plans/spec.md', '# 学习系统 设计\n\n设计学习卡的生成与索引。\n');
  write(dir, '.scratch/feat/issues/01.md', '# 01: 项目注册 + 只读初始化检查\n\n注册项目并只读检查标记。\n');
  write(dir, 'node_modules/dep/README.md', '# 依赖 说明\n\n不该被扫描。\n');
  write(dir, 'dist/bundle.md', '# 构建 产物\n\n不该被扫描。\n');
  write(dir, 'docs/agents/secret.md', '# 密钥 说明\n\n不该被扫描。');
  write(dir, '.env', 'SECRET=1\n');
  return dir;
}

test('scanSources：覆盖标准文档/术语/ADR/spec/ticket，排除依赖、构建产物与密钥', () => {
  const project = makeProject();
  const { sources, skipped } = scanSources(project);
  const paths = sources.map((s) => s.path).sort();
  assert.deepEqual(paths, [
    '.scratch/feat/issues/01.md',
    'GLOSSARY.md',
    'docs/adr/001-slim.md',
    'docs/agents/domain.md',
    'docs/plans/spec.md',
  ]);
  assert.equal(paths.some((p) => /node_modules|dist|secret|\.env/.test(p)), false);
});

test('全量生成：主题两段式、稳定 ASCII id、frontmatter 完整、不复制原文', async () => {
  const project = makeProject();
  const root = tmpDir('dwlearn-root-');
  const result = await generateCards({ projectPath: project, root, now: () => new Date('2026-10-18T00:00:00Z') });
  assert.equal(result.ok, true);
  assert.ok(result.wrote >= 5);

  const list = readAllCards(root);
  assert.ok(list.length >= 5);
  for (const c of list) {
    assert.match(c.meta.topic, /^\S+ \S+$/, `主题必须是两段：${c.meta.topic}`);
    assert.equal(c.meta.schema, '1');
    assert.match(c.meta.id, /^[a-z0-9-]+$/);
    assert.equal(c.meta.project, 'alpha');
    assert.ok(c.meta.summary.length > 0 && c.meta.summary.length <= 101);
    assert.ok(c.meta.estimatedMinutes >= 5);
    assert.ok(c.meta.sources.length >= 1);
    assert.ok(c.meta.sourceHash.startsWith('sha256-'));
    assert.equal(c.meta.locked, false);
    assert.equal(c.meta.status, 'active');
    assert.ok(!c.body.includes('结束标记'), `卡片正文不得复制原文：${c.file}`);
    const lineCount = c.body.split('\n').filter((l) => l.startsWith('- ')).length;
    assert.ok(lineCount >= 3 && lineCount <= 6);
  }
  const topics = list.map((c) => c.meta.topic);
  assert.ok(topics.includes('工单 拆分'));
  assert.ok(topics.includes('配置 减重'));
  assert.ok(topics.includes('项目注册 实现'));

  const index = buildIndex(root);
  assert.match(index.markdown, /## alpha/);
  assert.match(index.markdown, /## 按主题/);
  assert.match(index.markdown, /工单 拆分/);
});

test('内容哈希去重：两份完全相同来源只生成一份卡片；索引跨项目聚合', async () => {
  const a = makeProject('alpha');
  const b = makeProject('beta');
  write(b, 'docs/plans/copy-of-domain.md', fs.readFileSync(path.join(a, 'docs/agents/domain.md'), 'utf8'));
  const root = tmpDir('dwlearn-root-');

  const ra = await generateCards({ projectPath: a, root });
  const rb = await generateCards({ projectPath: b, root });
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);
  assert.ok(rb.skippedSources.some((s) => s.reason === 'duplicate-content'));

  const index = buildIndex(root);
  assert.match(index.markdown, /## alpha/);
  assert.match(index.markdown, /## beta/);
  assert.match(index.markdown, /按主题/);
});

test('增量：无变化为 no-op；来源变化只为该来源重写；来源消失标 stale 不删除', async () => {
  const project = makeProject();
  const root = tmpDir('dwlearn-root-');
  const first = await generateCards({ projectPath: project, root });
  assert.equal(first.ok, true);

  const noop = await updateAfterTicket({ projectPath: project, root });
  assert.equal(noop.ok, true);
  assert.equal(noop.noop, true);
  assert.equal(noop.wrote, 0);
  assert.equal(noop.stale, 0);

  const before = readAllCards(root).find((c) => c.meta.topic === '配置 减重');
  const mtime = fs.statSync(before.file).mtimeMs;
  fs.appendFileSync(path.join(project, 'docs/adr/001-slim.md'), '\n补充：ADR 的适用范围。\n');
  const changed = await updateAfterTicket({ projectPath: project, root });
  assert.equal(changed.ok, true);
  assert.ok(changed.wrote >= 1);
  const after = readAllCards(root).find((c) => c.meta.topic === '配置 减重');
  assert.ok(fs.statSync(after.file).mtimeMs >= mtime);

  // 删除一个来源 → stale，文件仍在
  fs.rmSync(path.join(project, 'docs/plans/spec.md'));
  const gone = await updateAfterTicket({ projectPath: project, root });
  assert.equal(gone.ok, true);
  assert.ok(gone.stale >= 1);
  const stale = readAllCards(root).find((c) => c.meta.sources[0].path === 'docs/plans/spec.md');
  assert.equal(stale.meta.status, 'stale');
  assert.ok(fs.existsSync(stale.file));
});

test('locked：用户手改后不被覆盖，新内容进入候选列表', async () => {
  const project = makeProject();
  const root = tmpDir('dwlearn-root-');
  await generateCards({ projectPath: project, root });

  const target = readAllCards(root).find((c) => c.meta.topic === '配置 减重');
  fs.appendFileSync(target.file, '\n用户手改：这一行必须保留。\n');
  const editedText = fs.readFileSync(target.file, 'utf8');

  fs.appendFileSync(path.join(project, 'docs/adr/001-slim.md'), '\n来源也变了。\n');
  const result = await updateAfterTicket({ projectPath: project, root });
  assert.equal(result.ok, true);
  assert.ok(result.lockedCandidates.length >= 1);
  assert.equal(fs.readFileSync(target.file, 'utf8'), editedText);
  const candidateFile = path.join(path.dirname(path.dirname(target.file)), 'candidates.json');
  assert.ok(fs.existsSync(candidateFile));
  const parsed = JSON.parse(fs.readFileSync(candidateFile, 'utf8'));
  assert.equal(parsed.candidates[0].reason, 'locked');
});

test('起草失败：保留已有卡片，不写半成品', async () => {
  const project = makeProject();
  const root = tmpDir('dwlearn-root-');
  await generateCards({ projectPath: project, root });
  const before = readAllCards(root).map((c) => fs.readFileSync(c.file, 'utf8')).sort();

  fs.appendFileSync(path.join(project, 'docs/agents/domain.md'), '\n变化。\n');
  const result = await updateAfterTicket({
    projectPath: project,
    root,
    drafter: async () => {
      throw new Error('glm down');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'drafter-failed');
  assert.equal(result.preserved, true);
  const after = readAllCards(root).map((c) => fs.readFileSync(c.file, 'utf8')).sort();
  assert.deepEqual(after, before);
});

test('写入失败：回滚到运行前的卡片与索引', async () => {
  const project = makeProject();
  const root = tmpDir('dwlearn-root-');
  await generateCards({ projectPath: project, root });
  const before = readAllCards(root).map((c) => fs.readFileSync(c.file, 'utf8')).sort();
  const indexBefore = fs.readFileSync(path.join(root, 'index.md'), 'utf8');

  fs.appendFileSync(path.join(project, 'docs/agents/domain.md'), '\n变化。\n');
  const result = await updateAfterTicket({
    projectPath: project,
    root,
    beforeWrite: () => {
      throw new Error('disk full');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'write-failed');
  assert.equal(result.rolledBack, true);
  const after = readAllCards(root).map((c) => fs.readFileSync(c.file, 'utf8')).sort();
  assert.deepEqual(after, before);
  assert.equal(fs.readFileSync(path.join(root, 'index.md'), 'utf8'), indexBefore);
});

test('命名冲突：产生两段式唯一主题并留下裁决审计；JEV 可用时按概率选赢家', async () => {
  const project = makeProject();
  write(project, 'docs/agents/second.md', '# 工单 拆分\n\n另一份同名主题。\n');
  const root = tmpDir('dwlearn-root-');
  let asked = 0;

  const result = await generateCards({
    projectPath: project,
    root,
    decider: async ({ questions }) => {
      asked += 1;
      const ids = Object.keys(questions);
      return { ok: true, model: 'jev-test', answers: { [ids[1]]: { type: 'noul', noul: 0.9 }, [ids[0]]: { type: 'noul', noul: 0.1 } } };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(asked, 1);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].arbitratedBy, 'jev-test');
  const topics = readAllCards(root).map((c) => c.meta.topic);
  assert.equal(new Set(topics).size, topics.length);
  for (const t of topics) assert.match(t, /^\S+ \S+$/);
  const audit = JSON.parse(fs.readFileSync(path.join(path.dirname(cardsDir(root, project)), 'naming-audit.json'), 'utf8'));
  assert.equal(audit.conflicts[0].winner, result.conflicts[0].winner);
});

test('cards 纯逻辑：主题规范化与 frontmatter 往返', () => {
  assert.equal(cards.normalizeTopic('03: 项目注册 + 只读初始化检查', 'ticket'), '项目注册 实现');
  assert.equal(cards.normalizeTopic('工单 拆分', 'agent-doc'), '工单 拆分');
  assert.equal(cards.normalizeTopic('清理协议', 'agent-doc'), '清理协议 应用');
  assert.equal(cards.isTwoPartTopic('名词 动词'), true);
  assert.equal(cards.isTwoPartTopic('只有一个词'), false);

  const text = cards.renderCard({
    id: 'ticket-x-1',
    project: 'p',
    topic: '工单 拆分',
    topicId: 'ticket-x-1',
    summary: '摘要',
    points: ['学什么：a', '为什么：b', '怎么练：c'],
    sourcePath: 'docs/a.md',
    link: 'file:///tmp/docs/a.md',
    anchor: '#top',
    chars: 100,
    estimatedMinutes: 15,
    status: 'active',
    locked: false,
    sourceHash: 'sha256-x',
    generatedAt: '2026-10-18T00:00:00Z',
    generatedBy: 'deterministic',
  });
  const parsed = cards.inspectCard(text);
  assert.equal(parsed.meta.topic, '工单 拆分');
  assert.equal(parsed.meta.sources[0].path, 'docs/a.md');
  assert.equal(parsed.locked, false);
  assert.equal(parsed.edited, false);
});
