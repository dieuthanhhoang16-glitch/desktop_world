#!/usr/bin/env node
// world/roles/cli.js · 角色层命令行入口（纯 Node）。
//
//   npm run world:roles -- init
//   npm run world:roles -- check
//   npm run world:roles -- list
//   npm run world:roles -- run --role glm --project <目录> --task "实现 X" [--dry-run]
//
// init 幂等；check 只报告漂移；run 默认真的启动角色，--dry-run 只规划并落回执。
'use strict';

const launcher = require('./launcher');
const { ROLES } = require('./defaults');

const args = process.argv.slice(2);
const flagVal = (name, dflt) => {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !String(args[i + 1]).startsWith('--') ? args[i + 1] : dflt;
};
const has = (name) => args.includes(name);

function printDrift(result) {
  if (result.ok) {
    console.log(`✅ 角色层无漂移：${result.root}`);
    return 0;
  }
  console.log(`⚠️ 角色层有 ${result.drift.length} 处漂移：${result.root}`);
  for (const d of result.drift) console.log(`   - [${d.kind}] ${d.file}`);
  console.log('   处理：确认改动是有意的就重新生成基线；否则恢复文件。');
  return 1;
}

function cmdInit() {
  const r = launcher.initRoles();
  console.log(`角色根目录：${r.root}`);
  console.log(`新建 ${r.created.length} 个，已存在 ${r.existed.length} 个（不覆盖）。`);
  if (r.created.length) r.created.forEach((f) => console.log(`   + ${f}`));
  console.log(`基线：${r.manifest}`);
  return 0;
}

function cmdCheck() {
  const asJson = has('--json');
  const r = launcher.checkRoles();
  if (asJson) {
    console.log(JSON.stringify(r, null, 2));
    return r.ok ? 0 : 1;
  }
  return printDrift(r);
}

function cmdList() {
  const runs = launcher.listRuns();
  if (!runs.length) {
    console.log('还没有角色 run。启动一次：');
    console.log('  npm run world:roles -- run --role glm --project . --task "跑一次 fixture 任务" --dry-run');
    return 0;
  }
  for (const r of runs) {
    console.log(`[${r.status}] ${r.runId}  ${r.role}(${r.model})  ${r.project || '(无项目)'}`);
    console.log(`   ${String(r.startedAt || '').replace('T', ' ').slice(0, 19)}  worktree=${r.worktree && r.worktree.path ? r.worktree.path : '-'}`);
  }
  return 0;
}

function cmdRun() {
  const role = flagVal('--role', '');
  if (!ROLES[role]) {
    console.log(`--role 必须是 ${Object.keys(ROLES).join(' / ')}`);
    return 1;
  }
  const task = flagVal('--task', '');
  if (!task) {
    console.log('缺任务简报：--task "这一轮要做什么"');
    return 1;
  }
  const receipt = launcher.createRun({
    role,
    project: flagVal('--project', '') || undefined,
    task,
    runId: flagVal('--run-id', '') || undefined,
    dryRun: has('--dry-run'),
  });
  if (has('--json')) {
    console.log(JSON.stringify(receipt, null, 2));
    return receipt.ok === false ? 1 : 0;
  }
  console.log(`[${receipt.status}] ${receipt.runId}  ${receipt.role}(${receipt.model})`);
  console.log(`   config：${receipt.configDir}`);
  console.log(`   worktree：${receipt.worktree && receipt.worktree.path ? receipt.worktree.path : '-'}`);
  console.log(`   回执：${launcher.runDirs(launcher.rolesRoot(), receipt.runId).receiptFile}`);
  if (receipt.changedFiles.length) console.log(`   变更：${receipt.changedFiles.join(', ')}`);
  if (receipt.error) console.log(`   错误：${receipt.error}`);
  return receipt.ok === false ? 1 : 0;
}

function cmdCleanup() {
  const runId = args[1];
  if (!runId) {
    console.log('用法：npm run world:roles -- cleanup <runId>');
    return 1;
  }
  const r = launcher.cleanupRun({ runId });
  console.log(`已清理 worktree：${r.runId}（回执保留在 ${r.runDir}）`);
  return 0;
}

function main() {
  const cmd = args[0] || 'init';
  if (cmd === 'init') return cmdInit();
  if (cmd === 'check') return cmdCheck();
  if (cmd === 'list') return cmdList();
  if (cmd === 'run') return cmdRun();
  if (cmd === 'cleanup') return cmdCleanup();
  console.log('用法：init | check | list | run --role <ds|jev|glm> --project <目录> --task "…" [--dry-run] | cleanup <runId>');
  return 1;
}

try {
  process.exit(main() || 0);
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}
