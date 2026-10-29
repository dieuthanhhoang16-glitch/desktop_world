#!/usr/bin/env node
// world/study/cli.js · 学习卡片命令行入口（纯 Node，不经Electron）。
//
//   npm run world:study -- --list          # 列出全部目标 × 关键词 × 卡片进度
//   npm run world:study -- --sync          # 扫近 7 天日报，补回填历史欠账
//   npm run world:study -- --sync --days30 # 扫近 30 天
//   npm run world:study -- --ensure# 只补齐没有卡片的关键词（写「空白区」）
//   npm run world:study -- --open          # 打印index.md 路径（自己开）
//
// 未配置定向学习目标时全链路零副作用：只提示，不建目录、不写文件。
'use strict';

const path = require('path');
const study = require('./index');
const { loadTechstack, TECHSTACK_FILE } = require('../techstack/config');

const args = process.argv.slice(2);
const flagVal = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  if (hit) return hit.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const has = (name) => args.includes(name);

const ICON = { 待补料: '🧩', 学习中: '📌', 已沉淀: '🌳' };

function printList() {
  const cfg = loadTechstack();
  if (!cfg.goals.length) {
    console.log('还没有定向学习目标，所以也没有学习卡片。先配一个：');
    console.log('  node world/techstack/techstack.js --add 状态管理');
    console.log('  …先看候选关键词，确认后：');
    console.log('  node world/techstack/techstack.js --add 状态管理 --keywords "zustand persist 持久化,Redux/zustand 选型取舍"');
    console.log(`\n（关键词配置：${TECHSTACK_FILE}）`);
    return;
  }
  const entries = study.listCards({ goals: cfg.goals });
  const root = study.STUDY_DIR;
  let total = 0;
  let settled = 0;
  for (const g of cfg.goals) {
    console.log(`\n🎯 ${g.direction}`);
    for (const e of entries.filter((x) => x.goalId === g.id)) {
      const days = e.dayCount ? `${e.dayCount} 天实证` : '还没命中';
      const last = e.lastHit ? ` · 最近 ${e.lastHit}` : '';
      console.log(`   ${ICON[e.status] || '·'} ${e.status}  ${e.keyword}  （${days}${last}）`);
      total += 1;
      if (e.status === '已沉淀') settled += 1;
    }
  }
  const { file } = study.writeIndex({ goals: cfg.goals });
  console.log(`\n共 ${total} 张卡片，其中已沉淀 ${settled} 张。`);
  console.log(`总览：${file}`);
}

function runSync() {
  const days = Number(flagVal('--days', '7')) || 7;
  const cfg = loadTechstack();
  if (!cfg.goals.length) {
    console.log('还没有定向学习目标，没什么可同步。');
    return;
  }
  console.log(`回看最近 ${days} 天的日报…`);
  const dirs = study.resolveOutDirs();
  if (!dirs.length) {
    console.log('没有找到任何日报目录（找过：env WORLD_OUT_DIR / userData / 仓库 world/out）。');
    console.log('先跑一次 npm run world:daily 产出日报，再回来 --sync。');
    return;
  }
  for (const d of dirs) console.log(`  读 ${d}`);
  const r = study.syncRecent({ days });
  console.log(`\n✅ 回填完成：${r.written.length} 张卡片有新增实证，建档 ${r.created.length} 张`);
  if (r.days.length) console.log(`   覆盖日期：${r.days.join(' · ')}`);
  if (!r.written.length) {
    console.log('   没有回填。两种可能：');
    console.log('   · 日报里的结构化考点没和已配关键词对上（宁缺毋滥，不硬凑）；');
    console.log('   · 或者这些日报还是旧的字符串 tips 形态——八股化考点只在配了定向学习目标之后才产出，');
    console.log('     所以配目标之前的历史日报无法自动归属到卡片，需要人工整理。');
  }
  console.log(`   总览：${r.indexFile}`);
}

function runEnsure() {
  const cfg = loadTechstack();
  if (!cfg.goals.length) {
    console.log('还没有定向学习目标，没什么可建档。');
    return;
  }
  // 建档日期用本地今天：--ensure 是"现在就建"，卡片的首次收录日应该是今天而不是留空
  const r = study.ensureCards(cfg.goals, { date: study.localToday() });
  const { file } = study.writeIndex({ goals: cfg.goals });
  console.log(`✅ 建档 ${r.created.length} 张，已有 ${r.existed.length} 张`);
  console.log(`总览：${file}`);
}

try {
  if (has('--sync')) runSync();
  else if (has('--ensure')) runEnsure();
  else if (has('--open')) console.log(path.join(study.STUDY_DIR, study.INDEX_FILE));
  else printList();
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}
