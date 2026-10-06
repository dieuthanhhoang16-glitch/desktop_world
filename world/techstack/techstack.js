#!/usr/bin/env node
// world/techstack/techstack.js · 定向学习配置 CLI（纯 Node，不经 Electron）。
//
//   node world/techstack/techstack.js --list
//   node world/techstack/techstack.js --add <模糊方向>            # 只出候选不写盘（收敛对话素材）
//   node world/techstack/techstack.js --add <方向> --keywords a,b # 收敛后落盘（0600）
//   node world/techstack/techstack.js --remove <id 或方向>
//
// agent 用法约定（关键词收敛对话）：
//   1) 先跑不带 --keywords 的 --add，拿到【项目记忆】+【候选关键词】；
//   2) agent 拿候选在对话里向用户确认（多选/可自定义，一次最多一问），可反复跑本步修正；
//   3) 收敛定了再带 --keywords 重跑，才写入 techstack.json。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadTechstack, addGoal, removeGoal, TECHSTACK_FILE } = require('./config');
const { buildMemory } = require('./memory');
const { proposeKeywords } = require('./propose');

const args = process.argv.slice(2);
const getFlag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

// CLI 侧定位日报目录（读最近 7 天记忆）：env > App userData > 仓库 world/out，坏目录跳过
function resolveOutDir() {
  const cands = [
    process.env.WORLD_OUT_DIR,
    path.join(os.homedir(), 'Library', 'Application Support', 'clawd-on-desk', 'world'), // macOS
    path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'clawd-on-desk', 'world'), // Linux
    process.env.APPDATA ? path.join(process.env.APPDATA, 'clawd-on-desk', 'world') : null, // Windows
    path.join(__dirname, '..', 'out'),
  ].filter(Boolean);
  for (const d of cands) {
    try {
      if (fs.readdirSync(d).some((f) => /^daily-\d{4}-\d{2}-\d{2}\.json$/.test(f))) return d;
    } catch {
      /* 目录不存在就不参与 */
    }
  }
  return null;
}

function printList() {
  const cfg = loadTechstack();
  if (!cfg.goals.length) {
    console.log('还没有定向学习目标。示例：');
    console.log('  node world/techstack/techstack.js --add 状态管理');
    console.log('  …先看候选关键词，确认后：');
    console.log('  node world/techstack/techstack.js --add 状态管理 --keywords "zustand persist 持久化,Redux/zustand 选型取舍"');
    return;
  }
  console.log(`学习目标：${TECHSTACK_FILE}\n`);
  for (const g of cfg.goals) {
    console.log(`  🎯 ${g.direction}   （id: ${g.id}）`);
    for (const kw of g.keywords) console.log(`      · ${kw}`);
  }
}

(async () => {
  try {
    if (args.includes('--list') || !args.length) {
      printList();
    } else if (args.includes('--add')) {
      const dirRaw = getFlag('--add');
      if (!dirRaw || dirRaw.startsWith('--')) throw new Error('缺少方向：--add 后面跟模糊方向词（如 状态管理）');
      const direction = dirRaw.trim();
      const kwFlag = getFlag('--keywords');

      if (kwFlag && kwFlag.trim()) {
        // 收敛后落盘：关键词白名单/上限在 config 层把关
        const keywords = kwFlag
          .split(/[,，、]/)
          .map((s) => s.trim())
          .filter(Boolean);
        const { goal, updated } = await Promise.resolve(addGoal({ direction, keywords }));
        console.log(`${updated ? '♻️ 已更新' : '✅ 已新增'}学习目标：${goal.direction}（id: ${goal.id}）`);
        for (const kw of goal.keywords) console.log(`   · ${kw}`);
        process.exit(0);
      }

      // 候选模式：只出题不写盘 —— 项目记忆 + 4–8 个候选关键词 + 给 agent 的收敛指引
      const outDir = resolveOutDir();
      const memory = buildMemory({ outDir, days: 7 });
      const { keywords, source, fallbackErr } = await proposeKeywords(direction, memory, {
        noLlm: args.includes('--no-llm'),
      });
      console.log(`【模糊方向】${direction}`);
      console.log(`【记忆来源】${outDir || '(没找到日报目录，只剩 watch.json)'} · 近 ${memory.reportDays || 0} 天日报`);
      if (memory.watch.length) {
        console.log(`【专案】${memory.watch.map((w) => `${w.name}(${w.category})`).join(' · ')}`);
      }
      if (memory.projects.length) {
        console.log(`【近期项目】${memory.projects.slice(0, 5).map((p) => `${p.name}×${p.count}`).join(' · ')}`);
      }
      if (fallbackErr) console.log(`【降级】LLM 不可用，走确定性词典：${fallbackErr}`);
      console.log(`【候选关键词】（${source === 'claude' ? 'LLM 结合记忆出题' : '确定性词典'}，可多选/可自定义）`);
      keywords.forEach((kw, i) => console.log(`   ${i + 1}. ${kw}`));
      console.log('\n【下一步】agent：在对话里向用户确认多选/自定义（每次最多一问），确认后重跑：');
      console.log(`  node world/techstack/techstack.js --add ${JSON.stringify(direction)} --keywords "选中的词,自定义的词"`);
      process.exit(0);
    } else if (args.includes('--remove')) {
      const target = getFlag('--remove');
      if (!target) throw new Error('缺少 id 或方向词');
      removeGoal(target.trim());
      console.log(`🗑️ 已移除：${target}`);
      process.exit(0);
    } else {
      console.log('用法：--list | --add <方向> [--keywords a,b] [--no-llm] | --remove <id 或方向>');
      process.exit(1);
    }
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
})();
