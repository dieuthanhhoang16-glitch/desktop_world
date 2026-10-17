#!/usr/bin/env node
// world/project/cli.js · 项目注册 + 只读初始化检查的命令行入口（纯 Node，不经 Electron）。
//
// 用法：
//   npm run world:project -- add <path>      # 注册项目（幂等）并跑一次只读标记检查
//   npm run world:project -- list [--json]   # 已注册项目：路径 / 状态 / 最近检查时间
//   npm run world:project -- check [path]    # 重跑只读检查（默认全部已注册项目）
//   npm run world:project -- init [--from <dir>] [-y|--yes]
//                                            # 首启导入：扫 ~/Documents 下含 .git 的目录，默认逐个确认（-y 视为全部确认）
//   npm run world:project -- badge [--json]  # 打印动态桌面同源的「未初始化」徽标数据
//
// 边界：检查只写 <项目>/.world/project.json，不创建/修改任何标准文件
//（补缺是 04 号 ticket 的 world:project ensure，由用户触发、先出缺口报告）。
'use strict';

const path = require('path');
const readline = require('readline');

const P = require('./paths');
const registry = require('./registry');
const check = require('./check');
const scan = require('./scan');
const badge = require('./badge');
const { REQUIRED_KEYS } = require('./markers');
const { STATUS_LABELS, MARKER_LABELS, add: flowAdd, list: flowList } = require('./index');

const args = process.argv.slice(2);
const has = (...names) => names.some((n) => args.includes(n));
// 与 orch/cli.js 的同名 helper 是全仓唯二的两份拷贝（刻意不互相 import，见 createLineReader 注）。
// 有意漂移一处：orch 版只拒 `--` 开头的值，这里拒一切 `-` 开头——本 CLI 的值既可能是路径也可能是
// flag，`--from -y` 把 `-y` 当目录收下才是真事故。第三次出现同款解析时，抽 world 级公共件。
const flagVal = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  if (hit) return hit.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !String(args[i + 1]).startsWith('-') ? args[i + 1] : dflt;
};
const ROOT = P.PROJECT_DIR; // WORLD_PROJECT_DIR 已在 paths.js 完成覆盖解析

// ---------------------------------------------------------------- 打印 helpers

function printMarkers(markers) {
  for (const k of Object.keys(MARKER_LABELS)) {
    console.log(`    ${markers[k] ? '✓' : '✗'} ${k.padEnd(16)} ${MARKER_LABELS[k]}`);
  }
}

function printManifestStatus(m) {
  // triageLabels 是可选项，不进「缺 N」计数——否则六项缺它的已初始化项目也会被报成缺项。
  const missingRequired = REQUIRED_KEYS.filter((k) => !m.markers[k]);
  let head = `  初始化状态：${STATUS_LABELS[m.status] || m.status}`;
  if (missingRequired.length) head += `（缺 ${missingRequired.length}/${REQUIRED_KEYS.length} 项必需）`;
  if (!m.markers.triageLabels) head += '（可选 triageLabels 未配置）';
  console.log(head);
  printMarkers(m.markers);
  console.log(`  manifest：${path.join(m.project, P.MANIFEST_REL)}（只读检查，未写其他文件）`);
}

// ---------------------------------------------------------------- 命令

function cmdAdd() {
  const target = flagVal('--path', '') || args.slice(1).find((a) => !String(a).startsWith('-'));
  if (!target) {
    console.log('用法：npm run world:project -- add <项目路径>');
    return 1;
  }
  let r;
  try {
    r = flowAdd(ROOT, target);
  } catch (err) {
    console.log(`❌ ${err.message}`);
    return 1;
  }
  console.log(r.duplicate ? `ℹ️  已注册过（幂等，不重复记账）：${r.path}` : `✅ 已注册：${r.path}`);
  printManifestStatus(r.manifest);
  if (r.manifest.status !== 'initialized') {
    console.log('  → 缺项会在动态桌面亮「未初始化」徽标；补齐走 world:project ensure（待 04 号 ticket）');
  }
  return 0;
}

function cmdList() {
  const rows = flowList(ROOT);
  if (has('--json')) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (!rows.length) {
    console.log('还没有注册项目。先注册一个：npm run world:project -- add <项目路径>');
    return 0;
  }
  console.log(`已注册项目（${rows.length}）：`);
  for (const r of rows) {
    console.log(`  ${STATUS_LABELS[r.status] || r.status}  ${r.path}`);
    console.log(`      最近检查：${r.lastCheckedAt || '（还没查过）'}`);
  }
  return 0;
}

function cmdCheck() {
  const target = flagVal('--path', '') || args.slice(1).find((a) => !String(a).startsWith('-'));
  if (target) {
    const abs = path.resolve(target);
    const registered = registry.load(ROOT).projects.some((p) => p.path === abs);
    if (!registered) {
      console.log(`❌ ${abs} 不在注册表里。先注册：npm run world:project -- add ${target}`);
      return 1;
    }
    try {
      const m = check.run(ROOT, abs);
      printManifestStatus(m);
      return 0;
    } catch (err) {
      console.log(`❌ ${err.message}`);
      return 1;
    }
  }
  const { results, ok } = check.runAll(ROOT);
  if (!results.length) {
    console.log('注册表是空的，没有可检查的项目。');
    return 0;
  }
  for (const r of results) {
    if (r.error) {
      console.log(`❌ ${r.path}：${r.error}`);
    } else {
      console.log(`${r.manifest.status === 'initialized' ? '✅' : '⚠️ '} ${r.path} → ${STATUS_LABELS[r.manifest.status] || r.manifest.status}`);
    }
  }
  return ok ? 0 : 1;
}

/**
 * 逐条确认的行读取器（语义与 world/orch/cli.js 的 confirmEach 一致：
 * EOF=e=什么都不写；y 收；n 拒；a 之后全收）。orch 那份是它 cli 的私有件，这里自带一管。
 */
function createLineReader(input, output) {
  const queue = [];
  let ended = false;
  let wake = null;
  const rl = readline.createInterface({ input, output, terminal: false });
  rl.on('line', (line) => {
    queue.push(String(line).trim().toLowerCase());
    if (wake) { const w = wake; wake = null; w(); }
  });
  rl.on('close', () => {
    ended = true;
    if (wake) { const w = wake; wake = null; w(); }
  });
  return {
    async ask(prompt) {
      output.write(prompt);
      if (queue.length) return queue.shift();
      if (ended) return null;
      await new Promise((resolve) => { wake = resolve; });
      return queue.length ? queue.shift() : null;
    },
    close() { rl.close(); },
  };
}

async function cmdInit() {
  const from = path.resolve(flagVal('--from', scan.defaultDocumentsDir()));
  console.log(`扫描 ${from} 下含 .git 的一级目录…`);
  const candidates = scan.documents(from);
  if (!candidates.length) {
    console.log('没有发现可导入的项目（只认含 .git 的一级目录；压缩包与一次性目录不会进来）。');
    return 0;
  }
  const registered = new Set(registry.load(ROOT).projects.map((p) => p.path));
  const fresh = candidates.filter((c) => !registered.has(path.resolve(c)));
  const skipped = candidates.length - fresh.length;
  if (skipped) console.log(`（${skipped} 个已在注册表里，跳过）`);
  if (!fresh.length) return 0;
  const yesAll = has('--yes', '-y');
  console.log(`发现 ${fresh.length} 个候选项目，逐个确认（Downloads 树从不进这份名单）：`);
  const reader = yesAll ? null : createLineReader(process.stdin, process.stdout);
  let acceptRest = yesAll;
  let accepted = 0;
  try {
    for (const c of fresh) {
      if (!acceptRest) {
        const answer = await reader.ask(`  注册 ${c} ？[Y]es / [n]o / [a]ll / [e]xit > `);
        if (answer === null || answer === 'e' || answer === 'exit' || answer === 'q') {
          console.log('\n已退出：本轮到此为止（已确认的已落账，未确认的不注册）。');
          break;
        }
        if (answer === 'a' || answer === 'all') {
          acceptRest = true;
        } else if (answer === 'n' || answer === 'no') {
          console.log('  → 跳过');
          continue;
        }
      }
      const r = flowAdd(ROOT, c);
      accepted += 1;
      console.log(`  ✅ 已注册（${STATUS_LABELS[r.manifest.status] || r.manifest.status}）：${r.path}`);
    }
  } finally {
    if (reader) reader.close();
  }
  console.log(`\n本轮导入 ${accepted}/${fresh.length} 个。`);
  return 0;
}

function cmdBadge() {
  const view = badge.build({ root: ROOT });
  if (has('--json')) {
    console.log(JSON.stringify(view, null, 2));
    return 0;
  }
  if (!view.uninitialized.length) {
    console.log(`没有未初始化的项目（注册表里共 ${view.total} 个）。`);
    return 0;
  }
  console.log(`未初始化项目（${view.uninitialized.length}/${view.total}）：`);
  for (const p of view.uninitialized) {
    const missing = p.missing.map((k) => MARKER_LABELS[k] || k).join('、');
    console.log(`  🏷  ${p.name}  ${p.path}${p.gone ? '（目录已不存在）' : ''}`);
    console.log(`      状态：${STATUS_LABELS[p.status] || p.status}  缺：${missing}`);
  }
  return 0;
}

// ---------------------------------------------------------------- 分发

async function main() {
  const cmd = args[0];
  if (cmd === 'add') return cmdAdd();
  if (cmd === 'list') return cmdList();
  if (cmd === 'check') return cmdCheck();
  if (cmd === 'init') return cmdInit();
  if (cmd === 'badge') return cmdBadge();
  console.log('用法：');
  console.log('  add <项目路径>          注册（幂等）并只读检查');
  console.log('  list [--json]           路径 / 状态 / 最近检查时间');
  console.log('  check [项目路径]        重跑只读检查（默认全部已注册）');
  console.log('  init [--from <dir>] [-y|--yes]   首启导入 ~/Documents 含 .git 目录（默认逐个确认；-y 视为全确认）');
  console.log('  badge [--json]          未初始化徽标数据（动态桌面同源）');
  return cmd ? 1 : 0;
}

main()
  .then((code) => process.exit(code || 0))
  .catch((err) => {
    console.error(`❌ ${err.message || err}`);
    process.exit(1);
  });
