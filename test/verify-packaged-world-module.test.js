// test/verify-packaged-world-module.test.js
// 打包产物里 world/ 模块的完整性校验。
//
// 这组测试守的是一个**不会在开发态暴露、也不会让构建失败**的缺陷：
// electron-builder 的 build.files 是白名单语义，`world/` 没列进去就整个不进包。
// 后果是用户装上 App 之后日报/动态桌面/番茄钟/定向学习/学习卡片/编排全是空的，
// 而 `npm start` 一切正常 —— 只能靠"对打包产物断言"才抓得到。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const SCRIPT = path.join(REPO, 'scripts', 'verify-packaged-world-module.js');
const pkg = require('../package.json');

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

function tmpTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwpack-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content == null ? '// stub' : content);
  }
  return dir;
}

// 从源码树抄一份"最小可用"的 world/ 结构（只含必需要求的路径，内容为 stub）
function sourceLikeTree() {
  const out = {};
  for (const rel of SOURCE_WORLD_FILES) out[rel] = fs.readFileSync(path.join(REPO, rel), 'utf8');
  return out;
}

const SOURCE_WORLD_FILES = [
  'world/app-integration.js',
  'world/pipeline.js',
  'world/live/live.js',
  'world/live/preload.js',
  'world/live/notes.js',
  'world/live/board.js',
  'world/live/pet.js',
  'world/live/pomodoro.js',
  'world/live/pos.js',
  'world/template/daily-card.html',
  'world/garden/index.js',
  'world/garden/scene.js',
  'world/garden/state.js',
  'world/creature/generate.js',
  'world/creature/sprites.js',
  'world/techstack/config.js',
  'world/techstack/techstack.js',
  'world/techstack/memory.js',
  'world/techstack/propose.js',
  'world/study/index.js',
  'world/study/card.js',
  'world/study/scanner.js',
  'world/study/cli.js',
  'world/orch/index.js',
  'world/orch/tickets.js',
  'world/orch/store.js',
  'world/orch/blackboard.js',
  'world/orch/mailbox.js',
  'world/orch/dispatch.js',
  'world/orch/scene-agents.js',
  'world/orch/paths.js',
  'world/orch/prefs-source.js',
  'world/orch/cli.js',
  'world/orch/llm.js',
  'world/orch/llm-prefs.js',
  'world/orch/split.js',
  'world/orch/decisions.js',
  'world/share/index.js',
  'world/share/config.js',
  'world/tidy/tidy.js',
  'world/tidy/scan.js',
  'world/tidy/plan.js',
  'world/tidy/apply.js',
  'world/watch/watch.js',
  'world/watch/config.js',
  'world/watch/state.js',
  'world/collector.js',
  'world/collector-codex.js',
  'world/summarizer.js',
  'world/bake.js',
  'world/cli.js',
];

// ---------- build.files 白名单本身 ----------

test('build.files：world/ 已进白名单（否则安装版里整个模块不存在）', () => {
  const files = pkg.build.files;
  const hasWorld = files.some((f) => f.startsWith('world/'));
  assert.equal(hasWorld, true, 'build.files 必须包含 world/ —— 白名单语义下漏了就是整个不进包');
  // 关键子模块逐个确认
  for (const dir of ['world/live/', 'world/template/', 'world/orch/', 'world/study/', 'world/techstack/', 'world/garden/']) {
    assert.ok(files.some((f) => f.startsWith(dir)), `build.files 缺 ${dir}`);
  }
});

test('build.files：运行期产物与开发期 PoC 被显式排除', () => {
  const files = pkg.build.files;
  assert.ok(files.includes('!world/out/**/*'), 'world/out/ 是运行期日报产物，且会把用户历史打进安装包');
  assert.ok(files.some((f) => f.includes('poc')), 'world/live/poc/ 是开发期实验，不该进包');
});

test('build.files：没有把 world/**/* 整目录无脑放进来', () => {
  // 整目录放进来会把 out/ 一起带上（4.1 MB 运行期数据 + 隐私）
  assert.ok(!pkg.build.files.includes('world/**/*'), '不要用 world/**/*，要逐目录列 + 显式排除');
});

// ---------- 验证脚本行为 ----------

test('验证脚本：完整树通过', () => {
  const dir = tmpTree(sourceLikeTree());
  const r = run(['--app-root', dir]);
  assert.equal(r.status, 0, `应当通过：\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /✅ world\/ 模块完整/);
});

test('验证脚本：缺文件时报出**具体缺了哪些**（不是泛泛说失败）', () => {
  const tree = sourceLikeTree();
  delete tree['world/orch/llm.js'];
  const dir = tmpTree(tree);
  const r = run(['--app-root', dir]);
  assert.equal(r.status, 1, '缺文件必须失败');
  assert.match(r.stderr, /world\/orch\/llm\.js/, '必须指名道姓说缺哪个文件');
  assert.match(r.stderr, /build\.files/, '必须给出修法');
});

test('验证脚本：缺一整类模块（整个 study/ 没进包）也要被抓', () => {
  const tree = {};
  for (const [k, v] of Object.entries(sourceLikeTree())) {
    if (k.startsWith('world/study/')) continue;
    tree[k] = v;
  }
  const dir = tmpTree(tree);
  const r = run(['--app-root', dir]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /world\/study\//, '学习卡片模块缺失必须被发现');
});

test('验证脚本：混进 world/out/ 判为失败（隐私：不能把用户日报打进安装包）', () => {
  const tree = sourceLikeTree();
  tree['world/out/daily-2026-10-05.json'] = '{"secret":"用户的历史工作记录"}';
  const dir = tmpTree(tree);
  const r = run(['--app-root', dir]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /world\/out\//);
  assert.match(r.stderr, /隐私|打进安装包/);
});

test('验证脚本：混进 live/poc/ 判为失败', () => {
  const tree = sourceLikeTree();
  tree['world/live/poc/window-layer-check.swift'] = '// PoC';
  const dir = tmpTree(tree);
  const r = run(['--app-root', dir]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /poc/);
});

test('验证脚本：抓「文件在但它 require 的东西不在」（启动才崩的半吊子状态）', () => {
  const tree = sourceLikeTree();
  // 让 orch/index.js require 一个不存在的文件
  tree['world/orch/index.js'] = "require('./does-not-exist.js');\nmodule.exports={};";
  const dir = tmpTree(tree);
  const r = run(['--app-root', dir]);
  assert.equal(r.status, 1, '依赖断裂必须被发现');
  assert.match(r.stderr, /does-not-exist/);
});

test('验证脚本：参数缺失时给用法并以非 0 退出', () => {
  const r = run([]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--app|--app-root/);
});

test('验证脚本：目标不存在时报错而不是崩栈', () => {
  const r = run(['--app-root', path.join(os.tmpdir(), 'definitely-absent-' + Date.now())]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /不存在/);
});

test('源码树本身通过必需项检查（防止有人把 world/ 文件挪走/改名）', () => {
  const r = run(['--app-root', REPO]);
  const missing = r.stderr.match(/·\s+(world\/[^\s]+)/g) || [];
  // 源码树下必然报出 world/out 与 poc（它们在开发态就该存在），但不该有任何必需要求项缺失
  const requiredGaps = missing.filter((m) => !m.includes('world/out/') && !m.includes('poc'));
  assert.deepEqual(requiredGaps, [], `源码树缺少必需模块：${requiredGaps.join(', ')}`);
});

test('npm script 已注册', () => {
  assert.equal(pkg.scripts['verify:world-module'], 'node scripts/verify-packaged-world-module.js');
});

test('脚本可执行（shebang + 语法正确）', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /^#!\/usr\/bin\/env node/);
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', SCRIPT]));
});
