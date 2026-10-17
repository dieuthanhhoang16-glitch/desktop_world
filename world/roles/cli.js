#!/usr/bin/env node
// world/roles/cli.js · world:roles 命令行入口（纯 Node，不经 Electron）。
//
// 子命令：
//   world:roles init
//     在 ROLES 根目录生成 contract.md 与 cards/{ds,jev,glm}.md。重复运行不覆盖已有文件。
//
//   world:roles launch glm --task <brief.md> [--repo <git repo>] [--model jd-glm53] [--runner fixture]
//     在空 config dir / 独立 worktree / 独立 session 里跑一次 glm 任务并写 receipt。
//
// 环境变量：
//   WORLD_ROLES_DIR   覆盖 ROLES 根目录（默认 ~/.desktop-world/roles/）。
//                     单测与便携场景必须经由它指定，否则会写脏用户家。
'use strict';

const path = require('path');

const initRoles = require('./init');
const launcher = require('./launcher');
const paths = require('./paths');

const args = process.argv.slice(2);
const sub = args[0];

function flagVal(name, dflt) {
  const eq = args.find((a) => String(a).startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !String(args[i + 1]).startsWith('--') ? args[i + 1] : dflt;
}

function usage() {
  return [
    '用法：',
    '  world:roles init',
    '  world:roles launch glm --task <brief.md> [--repo <repo>] [--model <id>] [--runner fixture]',
    '',
    '环境变量：WORLD_ROLES_DIR（默认 ~/.desktop-world/roles/）',
  ].join('\n');
}

function fail(msg, code = 1) {
  console.error(`[world:roles] ❌ ${msg}`);
  process.exit(code);
}

if (!sub || sub === '--help' || sub === '-h') {
  console.log(usage());
  process.exit(0);
}

if (sub === 'init') {
  const res = initRoles.run({ root: paths.ROLES_DIR });
  console.log(`[world:roles] root=${res.root}`);
  for (const rel of res.created) console.log(`  ✅ 生成 ${rel}`);
  for (const rel of res.skipped) console.log(`  ⏭️  跳过（已存在）${rel}`);
  process.exit(0);
}

if (sub === 'launch') {
  const role = args[1];
  if (!paths.ROLES.includes(role)) {
    fail(`未知角色 "${role}"；可选：${paths.ROLES.join(', ')}`, 2);
  }
  if (role !== 'glm') {
    fail(`ticket 01 只实现了 glm 启动器；${role} 的启动器在后续 ticket 实现`, 2);
  }
  const taskPath = flagVal('--task', null);
  const repo = path.resolve(flagVal('--repo', process.cwd()));
  const model = flagVal('--model', 'jd-glm53');
  const runner = flagVal('--runner', 'fixture');
  if (!taskPath) fail(`缺 --task <brief.md>\n\n${usage()}`, 2);

  const result = launcher.launchGlm({
    rolesRoot: paths.ROLES_DIR,
    repo,
    briefPath: path.resolve(taskPath),
    model,
    runnerKind: runner,
  });

  if (!result.ok) {
    fail(result.error);
  }
  console.log(`[world:roles] ✅ glm 完成 runId=${result.runId}`);
  console.log(`[world:roles] runDir: ${result.runDir}`);
  console.log(`receipt: ${result.receiptPath}`);
  process.exit(0);
}

fail(`未知子命令 "${sub}"\n\n${usage()}`, 2);
