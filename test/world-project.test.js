// world/project 模块单测：只读标记检查 / registry 幂等注册 / manifest 契约 /
// 首启导入扫描 / 徽标视图 / CLI 文件契约（全部在临时目录里进行）。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const markers = require('../world/project/markers');

const CLI = path.join(__dirname, '..', 'world', 'project', 'cli.js');

function makeTmp(t, prefix = 'world-project-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeRel(dir, rel, text) {
  const abs = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');
}

/** 六个标记的铺法只有这一处——makeProject 与 makeMarkerFile 共用，防两份清单漂移。 */
const MARKER_WRITERS = {
  issueTracker: (dir) => writeRel(dir, 'docs/agents/issue-tracker.md', '# issue tracker\n'),
  domainDocs: (dir) => writeRel(dir, 'docs/agents/domain.md', '# domain\n'),
  triageLabels: (dir) => writeRel(dir, 'docs/agents/triage-labels.md', '# triage\n'),
  adrDir: (dir) => writeRel(dir, 'docs/adr/0001-x.md', '# adr\n'),
  glossary: (dir) => writeRel(dir, 'GLOSSARY.md', '# glossary\n'),
  agentSkillsBlock: (dir) => writeRel(dir, 'CLAUDE.md', '# hi\n\n## Agent skills\n\n### Issue tracker\n'),
};

/** 造一个"marker 任选"的项目夹具：given 一组标记键，铺出对应文件。 */
function makeProject(t, present = []) {
  const dir = makeTmp(t, 'world-project-proj-');
  for (const k of present) MARKER_WRITERS[k](dir);
  return dir;
}

const ALL = ['issueTracker', 'domainDocs', 'triageLabels', 'agentSkillsBlock', 'glossary', 'adrDir'];

// ---------- 标记检查（纯模块缝） ----------

test('markers：六项齐全 → 全 true 且 status=initialized', (t) => {
  const dir = makeProject(t, ALL);
  const r = markers.evaluate(dir);
  for (const k of ALL) assert.equal(r.markers[k], true, `${k} 应为 true`);
  assert.equal(r.status, 'initialized');
});

test('markers：部分必需标记缺失 → partial 且 missing 列出缺项', (t) => {
  const dir = makeProject(t, ['issueTracker', 'glossary']);
  const r = markers.evaluate(dir);
  assert.equal(r.status, 'partial');
  assert.deepEqual(r.missing.sort(), ['adrDir', 'agentSkillsBlock', 'domainDocs', 'triageLabels'].sort());
});

test('markers：必需标记全缺 → missing（triageLabels 是可选项，不救场）', (t) => {
  const dir = makeProject(t, ['triageLabels']);
  const r = markers.evaluate(dir);
  assert.equal(r.status, 'missing');
});

test('markers：triageLabels 缺席不挡 initialized（可选标记）', (t) => {
  const dir = makeProject(t, ALL.filter((k) => k !== 'triageLabels'));
  const r = markers.evaluate(dir);
  assert.equal(r.markers.triageLabels, false);
  assert.equal(r.status, 'initialized');
});

test('markers：Agent skills 块写在 AGENTS.md 也认；GLOSSARY-MAP.md 顶多上下文布局', (t) => {
  const dir = makeProject(t, ALL.filter((k) => k !== 'agentSkillsBlock' && k !== 'glossary'));
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# agents\n\n## Agent skills\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'GLOSSARY-MAP.md'), '# map\n', 'utf8');
  const r = markers.evaluate(dir);
  assert.equal(r.markers.agentSkillsBlock, true);
  assert.equal(r.markers.glossary, true);
  assert.equal(r.status, 'initialized');
});

test('markers：0 字节占位文件视为缺；目录不存在抛错', (t) => {
  const dir = makeTmp(t, 'world-project-empty-');
  fs.writeFileSync(path.join(dir, 'GLOSSARY.md'), '', 'utf8'); // 0 字节不算数
  const r = markers.evaluate(dir);
  assert.equal(r.markers.glossary, false);
  assert.throws(() => markers.evaluate(path.join(dir, '不存在')), /项目目录不存在/);
});

// ---------- registry（幂等注册，纯模块缝） ----------

const registry = require('../world/project/registry');
const P = require('../world/project/paths');

test('registry：重复注册幂等——只有一条记录，registeredAt 不被改写', (t) => {
  const root = makeTmp(t, 'world-project-reg-');
  const proj = makeProject(t, []);
  const first = registry.add(root, proj);
  assert.equal(first.projects.length, 1);
  const second = registry.add(root, proj);
  assert.equal(second.projects.length, 1);
  assert.equal(second.projects[0].path, first.projects[0].path);
  assert.equal(second.projects[0].registeredAt, first.projects[0].registeredAt);
  assert.equal(second.duplicate, true);
  assert.equal(first.duplicate, false);
  // 路径写成 ./与末尾斜杠的变体也算同一项目
  const third = registry.add(root, proj + path.sep);
  assert.equal(third.projects.length, 1);
});

test('registry：落盘契约——registry.json schemaVersion + 0600；坏文件按空表重载不崩', (t) => {
  const root = makeTmp(t, 'world-project-reg-');
  const proj = makeProject(t, []);
  registry.add(root, proj);
  const file = P.registryFile(root);
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk.schemaVersion, 1);
  assert.equal(Array.isArray(disk.projects), true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, '{不是 json', 'utf8');
  const again = registry.add(root, proj);
  assert.equal(again.projects.length, 1); // 从空表重来，不炸
});

test('registry：拒绝注册不存在的路径或非目录', (t) => {
  const root = makeTmp(t, 'world-project-reg-');
  assert.throws(() => registry.add(root, path.join(root, '没有这里')), /不存在/);
  const f = path.join(root, 'file.txt');
  fs.writeFileSync(f, 'x', 'utf8');
  assert.throws(() => registry.add(root, f), /不是目录/);
});

// ---------- manifest + 只读检查（契约缝） ----------

const manifest = require('../world/project/manifest');
const check = require('../world/project/check');

/** 全树快照：相对路径 → 内容哈希，用于"除 manifest 外零写入"断言。 */
function treeSnapshot(root, walkRel = '') {
  const out = {};
  const dir = path.join(root, walkRel);
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = path.join(walkRel, e.name);
    if (e.isDirectory()) Object.assign(out, treeSnapshot(root, rel));
    else if (e.isFile()) out[rel] = require('node:crypto').createHash('sha1').update(fs.readFileSync(path.join(root, rel))).digest('hex');
  }
  return out;
}

test('check：首次检查落出完整 manifest 契约（spec §5 字段一个不缺）', (t) => {
  const proj = makeProject(t, []);
  const regRoot = makeTmp(t, 'world-project-reg-');
  const reg = registry.add(regRoot, proj);
  const m = check.run(regRoot, proj);
  assert.equal(m.schemaVersion, 1);
  assert.equal(m.standard, 'mattpocock-skills');
  assert.equal(m.standardVersion, '1.3.1');
  assert.equal(m.project, path.resolve(proj));
  assert.equal(m.registeredAt, reg.registeredAt);
  assert.equal(m.status, 'missing'); // 夹具没有标记
  assert.deepEqual(m.markers, {
    issueTracker: false, domainDocs: false, triageLabels: false,
    agentSkillsBlock: false, glossary: false, adrDir: false,
  });
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(m.lastCheckedAt), 'lastCheckedAt 是 ISO 时间');
  assert.deepEqual(m.generatedFiles, []);
  // 磁盘上读回同一份
  assert.equal(manifest.load(proj).status, 'missing');
});

test('check：只写 .world/project.json，项目其余文件一个不动', (t) => {
  const proj = makeProject(t, ['glossary']);
  fs.writeFileSync(path.join(proj, 'README.md'), '# 用户的文件\n', 'utf8');
  const regRoot = makeTmp(t, 'world-project-reg-');
  registry.add(regRoot, proj);
  const before = treeSnapshot(proj);
  check.run(regRoot, proj);
  const after = treeSnapshot(proj);
  const added = Object.keys(after).filter((k) => !(k in before));
  const changed = Object.keys(before).filter((k) => after[k] !== undefined && after[k] !== before[k]);
  assert.deepEqual(added, [path.join('.world', 'project.json')]);
  assert.deepEqual(changed, []); // 一个已有文件都不许变
});

test('check：不读取密钥文件——chmod 000 的诱饵全程不被打开', (t) => {
  const proj = makeProject(t, ['issueTracker']);
  // 在会被扫描的路径附近放不可读诱饵：一旦检查代码碰它们就会 EACCES 崩盘
  for (const rel of ['.env', 'id_rsa', path.join('.config', 'agentero', 'settings.json'), path.join('docs', 'agents', '.secret')]) {
    const f = path.join(proj, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '{"decision":{"apiKey":"sk-decoy"}}\n', 'utf8');
    fs.chmodSync(f, 0o000);
  }
  const regRoot = makeTmp(t, 'world-project-reg-');
  registry.add(regRoot, proj);
  const m = check.run(regRoot, proj); // 能跑完 = 没碰诱饵
  assert.equal(m.markers.issueTracker, true);
  assert.equal(m.status, 'partial');
});

test('check：标记补齐后再查，状态迁移 missing→initialized 且 lastCheckedAt 更新', (t) => {
  const proj = makeProject(t, []);
  const regRoot = makeTmp(t, 'world-project-reg-');
  registry.add(regRoot, proj);
  const m1 = check.run(regRoot, proj);
  assert.equal(m1.status, 'missing');
  // 补上全部标记再查
  for (const k of ALL) makeMarkerFile(proj, k);
  const m2 = check.run(regRoot, proj);
  assert.equal(m2.status, 'initialized');
  assert.ok(m2.lastCheckedAt >= m1.lastCheckedAt, 'lastCheckedAt 不后退');
});

/** 给已有项目补铺一个标记（状态迁移测试用），铺法与 makeProject 同源。 */
function makeMarkerFile(proj, k) {
  MARKER_WRITERS[k](proj);
}

test('check：ensure 后续写入的 generatedFiles/lastEnsureAt 不被检查冲掉（合并语义）', (t) => {
  const proj = makeProject(t, []);
  const regRoot = makeTmp(t, 'world-project-reg-');
  registry.add(regRoot, proj);
  check.run(regRoot, proj);
  // 模拟 04 号 ticket 的 ensure 写过 generatedFiles
  const m = manifest.load(proj);
  m.generatedFiles = ['docs/agents/issue-tracker.md'];
  m.lastEnsureAt = '2026-10-18T00:00:00.000Z';
  manifest.save(proj, m);
  const m2 = check.run(regRoot, proj);
  assert.deepEqual(m2.generatedFiles, ['docs/agents/issue-tracker.md']);
  assert.equal(m2.lastEnsureAt, '2026-10-18T00:00:00.000Z');
});

// ---------- 首启导入扫描（纯模块缝） ----------

const scan = require('../world/project/scan');

test('scan：一级仓库与「分组/仓库」二级形态都收；普通目录/隐藏目录/压缩包不收', (t) => {
  const docs = makeTmp(t, 'world-project-docs-');
  const repoDir = path.join(docs, 'proj-a');
  fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
  const wtDir = path.join(docs, 'proj-b-worktree');
  fs.mkdirSync(wtDir, { recursive: true });
  fs.writeFileSync(path.join(wtDir, '.git'), 'gitdir: /elsewhere\n', 'utf8'); // worktree 的 .git 是文件
  const grouped = path.join(docs, 'work', 'repo-c');
  fs.mkdirSync(path.join(grouped, '.git'), { recursive: true }); // Documents/<分组>/<仓库> 二级形态
  fs.mkdirSync(path.join(docs, 'plain-dir'), { recursive: true }); // 无 .git
  fs.mkdirSync(path.join(docs, '.hidden', '.git'), { recursive: true }); // 隐藏目录不收
  fs.writeFileSync(path.join(docs, '备份.zip'), 'PK', 'utf8'); // 压缩包不是目录
  const found = scan.documents(docs);
  assert.deepEqual(found, [repoDir, wtDir, grouped].sort());
});

test('scan：二层为止——三层仓库不下潜，node_modules 永不扫，遇 .git 目录不钻进去', (t) => {
  const docs = makeTmp(t, 'world-project-docs-');
  const repoDir = path.join(docs, 'proj-a');
  fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'vendored', 'inner', '.git'), { recursive: true }); // 仓库内部不另立项目
  fs.mkdirSync(path.join(docs, 'a', 'b', 'c', '.git'), { recursive: true }); // 三层太深
  fs.mkdirSync(path.join(docs, 'node_modules', 'pkg-repo', '.git'), { recursive: true }); // 依赖目录永不扫
  const twoDeep = path.join(docs, 'group', 'repo-d');
  fs.mkdirSync(path.join(twoDeep, '.git'), { recursive: true });
  fs.mkdirSync(path.join(docs, 'group', 'node_modules', 'pkg2', '.git'), { recursive: true }); // 二级里的依赖目录也不收
  const found = scan.documents(docs);
  assert.deepEqual(found, [repoDir, twoDeep].sort());
});

test('scan：Downloads 树不在扫描范围——默认根就是 Documents，传入的 Downloads 候选为空', (t) => {
  const home = makeTmp(t, 'world-project-home-');
  const docs = path.join(home, 'Documents');
  const downloads = path.join(home, 'Downloads');
  fs.mkdirSync(path.join(docs, 'real-proj', '.git'), { recursive: true });
  fs.mkdirSync(path.join(downloads, 'zip-extracted-once', '.git'), { recursive: true }); // 一次性目录
  fs.mkdirSync(path.join(downloads, '安装包解压', '.git'), { recursive: true });
  // 首启导入只扫 Documents：Downloads 里的东西永远不会作为候选出现
  const candidates = scan.documents(scan.defaultDocumentsDir(home));
  for (const c of candidates) assert.ok(!c.startsWith(downloads), `不应出现 Downloads 候选：${c}`);
  assert.deepEqual(candidates, [path.join(docs, 'real-proj')]);
});

// ---------- 徽标视图（纯模块缝） ----------

const badge = require('../world/project/badge');

test('badge：缺标记的项目进 uninitialized；齐全后消失；未注册项目总数照常', (t) => {
  const regRoot = makeTmp(t, 'world-project-reg-');
  const bare = makeProject(t, []);
  const ready = makeProject(t, ALL);
  registry.add(regRoot, bare);
  registry.add(regRoot, ready);
  check.run(regRoot, bare);
  check.run(regRoot, ready);
  let view = badge.build({ root: regRoot });
  assert.equal(view.total, 2);
  assert.equal(view.uninitialized.length, 1);
  assert.equal(view.uninitialized[0].path, path.resolve(bare));
  assert.equal(view.uninitialized[0].status, 'missing');
  assert.ok(view.uninitialized[0].missing.includes('issueTracker'));
  assert.ok(view.uninitialized[0].lastCheckedAt, '带最近检查时间');
  // 补齐标记 → 徽标消失（徽标看活标记，不等下一次 CLI check）
  for (const k of ALL) makeMarkerFile(bare, k);
  view = badge.build({ root: regRoot });
  assert.equal(view.uninitialized.length, 0);
  assert.equal(view.total, 2);
});

test('badge：项目目录被整棵搬走/删掉 → gone=true 仍亮未初始化徽标（不误当已初始化）', (t) => {
  const regRoot = makeTmp(t, 'world-project-reg-');
  const proj = makeProject(t, ALL);
  registry.add(regRoot, proj);
  check.run(regRoot, proj);
  let view = badge.build({ root: regRoot });
  assert.equal(view.uninitialized.length, 0);
  fs.rmSync(proj, { recursive: true, force: true });
  view = badge.build({ root: regRoot });
  assert.equal(view.uninitialized.length, 1);
  assert.equal(view.uninitialized[0].gone, true);
});

test('badge：空注册表 → 安静返回空视图', (t) => {
  const regRoot = makeTmp(t, 'world-project-reg-');
  const view = badge.build({ root: regRoot });
  assert.equal(view.total, 0);
  assert.deepEqual(view.uninitialized, []);
});

// ---------- CLI 缝：退出码 + 落盘契约（spec：最高缝是 CLI 命令 + 文件契约） ----------

function runCli(t, args, { env = {}, input } = {}) {
  const regRoot = makeTmp(t, 'world-project-cli-');
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, WORLD_PROJECT_DIR: regRoot, ...env },
    input,
    encoding: 'utf8',
    timeout: 30000,
  });
  return { ...r, regRoot, out: (r.stdout || '') + (r.stderr || '') };
}

test('cli add：注册 + 落 registry.json 与 manifest；项目内除 .world/project.json 零新增', (t) => {
  const proj = makeProject(t, ['glossary']);
  const before = treeSnapshot(proj);
  const r = runCli(t, ['add', proj]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /已注册/);
  assert.match(r.out, /未初始化|部分初始化/);
  const reg = JSON.parse(fs.readFileSync(path.join(r.regRoot, 'registry.json'), 'utf8'));
  assert.deepEqual(reg.projects.map((p) => p.path), [path.resolve(proj)]);
  const m = manifest.load(proj);
  assert.equal(m.status, 'partial'); // 只有 glossary
  const added = Object.keys(treeSnapshot(proj)).filter((k) => !(k in before));
  assert.deepEqual(added, [path.join('.world', 'project.json')]);
});

test('cli add：重复注册幂等——exit 0、registry 仍一条、明示已注册过', (t) => {
  const proj = makeProject(t, []);
  const r1 = runCli(t, ['add', proj]);
  assert.equal(r1.status, 0, r1.out);
  // 第二次要打到同一个 registry：复用第一次的 regRoot
  const r2 = spawnSync(process.execPath, [CLI, 'add', proj], {
    env: { ...process.env, WORLD_PROJECT_DIR: r1.regRoot }, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(r2.status, 0, (r2.stdout || '') + (r2.stderr || ''));
  assert.match(r2.stdout + r2.stderr, /已注册过|幂等/);
  const reg = JSON.parse(fs.readFileSync(path.join(r1.regRoot, 'registry.json'), 'utf8'));
  assert.equal(reg.projects.length, 1);
});

test('cli add：路径不存在 → exit 1 且不写任何 registry 文件', (t) => {
  const missing = path.join(os.tmpdir(), 'world-project-no-such-dir-xyz');
  const r = runCli(t, ['add', missing]);
  assert.equal(r.status, 1);
  assert.match(r.out, /不存在/);
  assert.equal(fs.existsSync(path.join(r.regRoot, 'registry.json')), false);
});

test('cli list：显示路径、状态、最近检查时间；--json 可解析', (t) => {
  const proj = makeProject(t, ALL);
  const r1 = runCli(t, ['add', proj]);
  assert.equal(r1.status, 0, r1.out);
  const r2 = spawnSync(process.execPath, [CLI, 'list'], {
    env: { ...process.env, WORLD_PROJECT_DIR: r1.regRoot }, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(r2.status, 0, (r2.stdout || '') + (r2.stderr || ''));
  assert.match(r2.stdout, /已初始化/);
  assert.ok(r2.stdout.includes(path.resolve(proj)), '列表要显示注册路径');
  assert.match(r2.stdout, /\d{4}-\d{2}-\d{2}T/, '列表要显示 ISO 检查时间');
  const r3 = spawnSync(process.execPath, [CLI, 'list', '--json'], {
    env: { ...process.env, WORLD_PROJECT_DIR: r1.regRoot }, encoding: 'utf8', timeout: 30000,
  });
  const rows = JSON.parse(r3.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, path.resolve(proj));
  assert.equal(rows[0].status, 'initialized');
  assert.ok(rows[0].lastCheckedAt);
});

test('cli check：默认检查全部注册项目，状态随标记补齐迁移', (t) => {
  const proj = makeProject(t, []);
  const r1 = runCli(t, ['add', proj]);
  assert.equal(r1.status, 0, r1.out);
  assert.equal(manifest.load(proj).status, 'missing');
  for (const k of ALL) makeMarkerFile(proj, k);
  const r2 = spawnSync(process.execPath, [CLI, 'check'], {
    env: { ...process.env, WORLD_PROJECT_DIR: r1.regRoot }, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(r2.status, 0, (r2.stdout || '') + (r2.stderr || ''));
  assert.equal(manifest.load(proj).status, 'initialized');
});

test('cli init：从 Documents 扫描并逐个确认——y 收 n 拒；EOF 则一个都不注册', (t) => {
  const docs = makeTmp(t, 'world-project-docs-');
  const a = path.join(docs, 'repo-accepted');
  const b = path.join(docs, 'repo-declined');
  fs.mkdirSync(path.join(a, '.git'), { recursive: true });
  fs.mkdirSync(path.join(b, '.git'), { recursive: true });
  const r1 = runCli(t, ['init', '--from', docs], { input: 'y\nn\n' });
  assert.equal(r1.status, 0, r1.out);
  const reg = registry.load(r1.regRoot);
  assert.deepEqual(reg.projects.map((p) => p.path), [a]);
  assert.ok(manifest.load(a), '被确认的项目要有 manifest');
  assert.equal(manifest.load(b), null, '被拒的项目不留任何痕迹');
  // EOF（没有输入）：什么都不写
  const r2 = runCli(t, ['init', '--from', docs], { input: '' });
  assert.equal(r2.status, 0, r2.out);
  assert.equal(registry.load(r2.regRoot).projects.length, 0);
  // --yes：全收（批量场景的显式跳过闸）
  const r3 = runCli(t, ['init', '--from', docs, '--yes']);
  assert.equal(r3.status, 0, r3.out);
  assert.equal(registry.load(r3.regRoot).projects.length, 2);
});

test('cli badge --json：输出桌面同源徽标数据', (t) => {
  const proj = makeProject(t, []);
  const r1 = runCli(t, ['add', proj]);
  assert.equal(r1.status, 0, r1.out);
  const r2 = spawnSync(process.execPath, [CLI, 'badge', '--json'], {
    env: { ...process.env, WORLD_PROJECT_DIR: r1.regRoot }, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(r2.status, 0, (r2.stdout || '') + (r2.stderr || ''));
  const view = JSON.parse(r2.stdout);
  assert.equal(view.uninitialized.length, 1);
  assert.equal(view.uninitialized[0].status, 'missing');
});

// ---------- 动态桌面集成（结构守门，同款 world-live-template 风格） ----------

const TEMPLATE = path.join(__dirname, '..', 'world', 'template', 'daily-card.html');
const LIVEJS = path.join(__dirname, '..', 'world', 'live', 'live.js');

test('桌面徽标结构：projectsSection 默认 hidden + bake 双保险 + renderProjects 数据驱动', () => {
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  assert.match(html, /<section class="projects" id="projectsSection" hidden>/, '徽标区必须默认 hidden');
  assert.ok(html.includes('id="projectsList"'), '缺 #projectsList 容器');
  assert.match(html, /body\.bake \.projects \{\s*display: none !important;\s*\}/, '缺 bake 隐藏双保险');
  assert.ok(html.includes('function renderProjects(p) {'), '缺 renderProjects 顶层函数');
  assert.ok(html.includes('renderProjects(R.projects)'), 'render 必须消费 R.projects');
  assert.ok(html.includes('PROJECT_MARKER_LABELS'), '缺标记中文名映射');
  // 数据进 DOM 必须转义（与模板其他区同一纪律）
  assert.ok(html.includes('esc(it.name || it.path ||'), '项目名必须 esc');
  assert.ok(html.includes('class="proj-badge">未初始化</span>'), '缺「未初始化」徽标元素');
});

test('桌面徽标数据：live.js 从 project/badge 构建并注入报告', () => {
  const live = fs.readFileSync(LIVEJS, 'utf8');
  assert.ok(live.includes("require('../project/badge').build("), 'live.js 必须用 badge 模块构建徽标视图');
  assert.ok(/projects,?\s*\/\/.*徽标/.test(live) || live.includes('projects,'), '报告必须携带 projects 字段');
});
