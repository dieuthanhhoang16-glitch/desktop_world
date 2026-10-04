#!/usr/bin/env node
// world/watch/watch.js · 专案追踪配置 CLI（纯 Node，不经 Electron）。
//
//   node world/watch/watch.js --list
//   node world/watch/watch.js --add <分类> [路径=当前目录] [--name 别名]
//   node world/watch/watch.js --remove <名字或路径>
'use strict';

const path = require('path');
const { loadWatch, addFolder, removeFolder, CATEGORIES, WATCH_FILE } = require('./config');

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const getFlag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

function printList() {
  const cfg = loadWatch();
  if (!cfg.folders.length) {
    console.log('还没有追踪任何文件夹。示例：');
    console.log('  node world/watch/watch.js --add 工作 ~/Documents/desktop-world');
    console.log('  node world/watch/watch.js --add 学习 ~/Documents/co-agent-paper');
    return;
  }
  console.log(`追踪配置：${WATCH_FILE}\n`);
  for (const f of cfg.folders) {
    console.log(`  [${f.category}] ${f.name}`);
    console.log(`      ${f.path}`);
  }
}

try {
  if (args.includes('--list') || !args.length) {
    printList();
  } else if (args.includes('--add')) {
    const i = args.indexOf('--add');
    const category = args[i + 1];
    if (!CATEGORIES.includes(category)) {
      console.error(`分类必须是：${CATEGORIES.join(' / ')}（当前：${category || '(未填)'}）`);
      process.exit(1);
    }
    const target = normalizeArg(args[i + 2]) || process.cwd();
    const cfg = addFolder({ path: target, category, name: getFlag('--name') });
    const added = cfg.folders[cfg.folders.length - 1];
    console.log(`✅ 开始追踪：[${added.category}] ${added.name}\n   ${added.path}`);
  } else if (args.includes('--remove')) {
    const target = getFlag('--remove');
    removeFolder(target);
    console.log(`🗑️ 已移除：${target}`);
  } else {
    console.log('用法：--list | --add <分类> [路径] [--name 别名] | --remove <名字或路径>');
    process.exit(1);
  }
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}

function normalizeArg(a) {
  return a && !a.startsWith('--') ? path.resolve(a) : null;
}
