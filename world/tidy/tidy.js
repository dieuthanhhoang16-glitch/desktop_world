// world/tidy/tidy.js · 桌面整理 CLI（纯 Node，不需要 Electron）。
//
//   node world/tidy/tidy.js --scan        # 只扫描+分类预览，不移动任何东西
//   node world/tidy/tidy.js               # 预览 → 逐个文件列出来 → 询问确认 → 执行
//   node world/tidy/tidy.js --yes         # 预览 → 直接执行（适合脚本/定时任务）
//   node world/tidy/tidy.js --undo        # 撤销最近一次整理
//
// 可选项：
//   --root <目录>      归档根目录（默认 ~/Desktop/_归档）
//   --desktop <目录>   扫描目标（默认 ~/Desktop，测试时可指向别的目录）
//   --min-age-min <n>  跳过最近 n 分钟改动的文件（默认 60，防止动到在用的）
//   --no-llm           不让 claude 给"其他"桶细分类（默认会调一次，失败自动跳过）
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const { scanDesktop, DEFAULT_DESKTOP } = require('./scan');
const { classifyByRules, refineOthersWithLLM, OTHER } = require('./classify');
const { buildPlan } = require('./plan');
const { applyPlan, undo, latestUndoFile } = require('./apply');

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

const UNDO_DIR = path.join(__dirname, '..', 'out');

function askYesNo(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^(y|yes|是|好|嗯)$/i.test(answer.trim()));
    });
  });
}

function printPlan(plan, files) {
  const skipped = files.length - plan.moves.length;
  console.log(`\n📋 整理计划（共 ${plan.fileCount} 个散文件，拟归档 ${plan.moves.length} 个到 ${plan.rootDir}）：`);
  for (const [cat, n] of Object.entries(plan.byCategory)) console.log(`   ${cat}：${n} 个`);
  if (skipped > 0) console.log(`   （另有 ${skipped} 个未分类/被跳过）`);
  console.log('');
  for (const m of plan.moves) {
    console.log(`   ${m.name || ''}${path.basename(m.from)}\n      → ${m.category}/`);
  }
}

async function main() {
  if (args.includes('--undo')) {
    const file = latestUndoFile(UNDO_DIR);
    if (!file) {
      console.log('没有找到撤销日志（挪过文件才会产生）：', UNDO_DIR);
      process.exitCode = 1;
      return;
    }
    const ok = args.includes('--yes') || (await askYesNo(`将按 ${path.basename(file)} 撤销最近一次整理，继续？[y/N] `));
    if (!ok) return console.log('已取消。');
    const { restored, skipped } = undo(file);
    console.log(`✅ 已还原 ${restored} 个文件。`);
    skipped.forEach((s) => console.log(`   ⚠️ 跳过 ${path.basename(s.to)}：${s.reason}`));
    return;
  }

  const desktopDir = argValue('--desktop') || DEFAULT_DESKTOP;
  const rootDir = argValue('--root') || path.join(desktopDir, '_归档');
  const minAgeMin = Number(argValue('--min-age-min') || 60);
  const scanOnly = args.includes('--scan');

  const files = scanDesktop({ dir: desktopDir, minAgeMin });
  if (!files.length) {
    console.log('桌面很干净 ✨（没有可归档的散文件）');
    return;
  }

  const { groups, others } = classifyByRules(files);

  // "其他"桶 → 可选 LLM 细分类
  if (others.length && !args.includes('--no-llm') && !scanOnly && process.env.WORLD_NO_LLM !== '1') {
    process.stdout.write(`🤖 ${others.length} 个"其他"文件请 claude 帮忙想分类… `);
    const { runClaudeHeadless } = require('../summarizer');
    const refined = await refineOthersWithLLM(others.map((f) => f.name), runClaudeHeadless);
    if (refined.size) {
      groups.delete(OTHER);
      const remaining = [];
      for (const f of others) {
        const cat = refined.get(f.name) || OTHER;
        if (cat === OTHER) remaining.push(f);
        if (!groups.has(cat)) groups.set(cat, []);
        groups.get(cat).push(f);
      }
      console.log(`细化了 ${refined.size} 个` + (remaining.length ? `（余 ${remaining.length} 个仍是"其他"）` : ''));
    } else {
      console.log('未能细化，维持原分类');
    }
  }

  if (scanOnly) {
    printPlan(buildPlan({ files, groups, rootDir }), files);
    console.log('（--scan 模式，未移动任何文件）');
    return;
  }

  const plan = buildPlan({ files, groups, rootDir });
  printPlan(plan, files);
  if (!plan.moves.length) {
    console.log('没有可归档的文件。');
    return;
  }

  const ok = args.includes('--yes') || (await askYesNo(`\n确认把 ${plan.moves.length} 个文件归档到 ${rootDir}？[y/N] `));
  if (!ok) return console.log('已取消，未移动任何文件。');

  const { moved, failed, undoFile } = applyPlan(plan, { undoDir: UNDO_DIR });
  console.log(`\n✅ 已归档 ${moved} 个文件 → ${rootDir}`);
  failed.forEach((f) => console.log(`   ❌ ${path.basename(f.from)}：${f.error}`));
  if (undoFile) console.log(`   （后悔了可以反悔：node world/tidy/tidy.js --undo）`);
}

main().catch((err) => {
  console.error('tidy 失败：', err);
  process.exitCode = 1;
});
