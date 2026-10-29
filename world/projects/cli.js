#!/usr/bin/env node
// world/projects/cli.js
// desktop-world · 项目层 CLI：add / list / remove / check / ensure / seed / badges。
'use strict';

const fs = require('fs');
const path = require('path');

const registry = require('./registry');
const { gapReport, ensure, detectStandardVersion } = require('./ensure');
const { checkMarkers, badge, EXPECTED } = require('./markers');
const { REGISTRY_FILE, projectSlug } = require('./paths');

function args(argv) {
  return argv.slice(2);
}

function flag(name, fallback = undefined) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : fallback;
}

function has(name) {
  return process.argv.includes(name);
}

function flagVal(name, fallback) {
  const v = flag(name);
  return typeof v === 'string' ? v : fallback;
}

function print(value, asJson) {
  if (asJson) {
    process.stdout.write(JSON.stringify(value, null, 2) + '\n');
    return;
  }
  if (typeof value === 'string') {
    process.stdout.write(value + '\n');
    return;
  }
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function fmtProject(p) {
  const lines = [`${p.name}  ${p.path}`, `  状态: ${p.status}${p.missing && p.missing.length ? `（缺 ${p.missing.length} 项）` : ''}`];
  if (p.lastCheckedAt) lines.push(`  最近检查: ${p.lastCheckedAt}`);
  return lines.join('\n');
}

function usage() {
  return `用法: node world/projects/cli.js <命令>

  add <path>              注册项目（重复注册幂等）
  list [--refresh]        列出项目；--refresh 只读重查标记
  remove <path>           从 registry 移除（不动项目文件）
  check [<path>] [--all]  只读检查标准标记，不写项目文件
  ensure <path> [--dry-run] [--no-setup]
                          缺口报告 → 干净会话运行 setup skill → manifest
  seed [--import]         列出 ~/Documents 下含 .git 的候选；--import 逐个确认导入
  badges [--json]         未初始化项目的桌面徽标数据
`;
}

function cmdAdd() {
  const p = args(process.argv)[1];
  if (!p) throw new Error('缺少项目路径');
  const { project, added } = registry.addProject(REGISTRY_FILE, p);
  print(added ? `已注册：${project.path}` : `已存在（幂等）：${project.path}`);
  print(fmtProject(project));
}

function cmdRemove() {
  const p = args(process.argv)[1];
  if (!p) throw new Error('缺少项目路径');
  const r = registry.removeProject(REGISTRY_FILE, p);
  print(r.removed ? `已移除：${r.path}（未动项目文件）` : `未注册：${r.path}`);
}

function cmdList() {
  const refresh = has('--refresh');
  const list = registry.listProjects(REGISTRY_FILE, { refresh });
  if (refresh) {
    const reg = registry.load(REGISTRY_FILE);
    reg.projects = list;
    registry.save(REGISTRY_FILE, reg);
  }
  if (has('--json')) return print(list, true);
  if (!list.length) return print('尚未注册项目。用 `world project add <path>` 添加。');
  print(list.map(fmtProject).join('\n\n'));
}

function cmdCheck() {
  const target = args(process.argv)[1];
  if (has('--all') || !target) {
    const list = registry.listProjects(REGISTRY_FILE);
    const results = list.map((p) => {
      const r = checkMarkers(p.path);
      return { path: p.path, name: p.name, ...r };
    });
    if (has('--json')) return print(results, true);
    if (!results.length) return print('尚未注册项目。');
    return print(
      results
        .map((r) => `${r.name}  ${r.status}\n  缺少: ${r.missing.length ? r.missing.join(', ') : '无'}`)
        .join('\n\n')
    );
  }
  const r = checkMarkers(target);
  // 只更新 registry 缓存；不创建 .world/，不写项目文件。
  const reg = registry.load(REGISTRY_FILE);
  const abs = registry.normalizePath(target);
  const idx = reg.projects.findIndex((p) => p.path === abs);
  if (idx >= 0) {
    reg.projects[idx] = { ...reg.projects[idx], status: r.status, markers: r.markers, missing: r.missing, lastCheckedAt: new Date().toISOString() };
    registry.save(REGISTRY_FILE, reg);
  }
  if (has('--json')) return print({ path: abs, ...r }, true);
  print(`${abs}\n状态: ${r.status}\n缺少: ${r.missing.length ? r.missing.map((id) => `${id}（${EXPECTED[id]}）`).join('\n  ') : '无'}`);
}

async function cmdEnsure() {
  const target = args(process.argv)[1];
  if (!target) throw new Error('缺少项目路径');
  const dryRun = has('--dry-run');
  const noSetup = has('--no-setup');
  const gaps = gapReport(target);
  if (!has('--json')) {
    print(`缺口报告：${gaps.project}\n状态: ${gaps.status}`);
    print(gaps.items.length ? gaps.items.map((i) => `  - ${i.id}: ${i.expected}`).join('\n') : '  （无缺口）');
  }
  if (gaps.ok && !dryRun) {
    const r = await ensure({ projectPath: target, dryRun: false, setupRunner: null, standardVersion: detectStandardVersion() });
    if (has('--json')) return print(r, true);
    return print(r.noop ? '已是 initialized，无需 ensure。' : '已初始化。');
  }
  const result = await ensure({
    projectPath: target,
    dryRun,
    setupRunner: noSetup ? null : undefined,
    standardVersion: detectStandardVersion(),
  });
  if (has('--json')) return print({ gaps, result }, true);
  if (result.dryRun) return print('（dry-run，未执行写入）');
  if (result.ok) {
    print(`ensure 完成。生成文件: ${result.created && result.created.length ? result.created.join(', ') : '无'}`);
    print(`manifest: ${path.join(target, '.world', 'project.json')}`);
    return;
  }
  if (result.reason === 'setup-skill-unavailable') {
    print('setup skill 不可用（claude 不在 PATH 或未安装插件）。保持当前状态，未写任何项目文件。');
    print(`仍缺少: ${gaps.missing.join(', ')}`);
    return;
  }
  if (result.reason === 'existing-file-modified') {
    print(`已有文件被运行器改动，已还原：${result.restored.join(', ')}`);
    print('ensure 失败；请检查 setup skill 是否遵守"只创建缺失文件"。');
    return;
  }
  print(`ensure 未完成：${result.reason}（状态 ${result.status}）`);
  if (result.gaps) print(`仍缺少: ${result.gaps.missing.join(', ')}`);
}

async function cmdSeed() {
  const candidates = registry.seedCandidates();
  const list = candidates.map((c) => {
    const m = checkMarkers(c.path);
    return { ...c, status: m.status, missing: m.missing };
  });
  if (has('--json') && !has('--import')) return print(list, true);
  if (!list.length) return print('~/Documents 下没有含 .git 的项目。');
  if (!has('--import')) {
    print(list.map((c) => `${c.name}  ${c.path}  [${c.status}]`).join('\n'));
    return print('\n确认后执行：world project seed --import（逐个询问）或 --import --yes（全部导入）');
  }
  const yesAll = has('--yes') || !process.stdin.isTTY;
  let readline = null;
  if (!yesAll) {
    const rl = require('readline/promises').createInterface({ input: process.stdin, output: process.stdout });
    readline = rl;
  }
  const imported = [];
  try {
    for (const c of list) {
      let ok = yesAll;
      if (!ok) {
        const answer = await readline.question(`导入 ${c.path} ? [y/N] `);
        ok = /^y(es)?$/i.test(answer.trim());
      }
      if (ok) {
        registry.addProject(REGISTRY_FILE, c.path);
        imported.push(c.path);
      }
    }
  } finally {
    if (readline) readline.close();
  }
  print(has('--json') ? { imported } : `已导入 ${imported.length} 个项目。`);
}

function cmdBadges() {
  const list = registry.listProjects(REGISTRY_FILE, { refresh: true });
  const badges = list
    .map((p) => ({ path: p.path, name: p.name, badge: badge(p.status) }))
    .filter((x) => x.badge !== null);
  if (has('--json')) return print(badges, true);
  if (!badges.length) return print('所有已注册项目均已初始化。');
  print(badges.map((b) => `${b.name}  [${b.badge.label}]  ${b.path}`).join('\n'));
}

async function main() {
  const cmd = args(process.argv)[0];
  switch (cmd) {
    case 'add':
      return cmdAdd();
    case 'remove':
      return cmdRemove();
    case 'check':
      return cmdCheck();
    case 'list':
      return cmdList();
    case 'ensure':
      return cmdEnsure();
    case 'seed':
      return cmdSeed();
    case 'badges':
      return cmdBadges();
    case undefined:
    case '-h':
    case '--help':
      return print(usage());
    default:
      throw new Error(`未知命令：${cmd}\n\n${usage()}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(String((err && err.message) || err) + '\n');
    process.exit(1);
  });
}

module.exports = { main };
