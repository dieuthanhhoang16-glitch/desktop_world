#!/usr/bin/env node
// world/learn/cli.js
// desktop-world · 项目学习卡 CLI：generate / update / index / list / candidates。
'use strict';

const path = require('path');

const { generateCards, updateAfterTicket, readCandidates } = require('./generate');
const { createPlan, readPlan } = require('./plan');
const { readAllCards, writeIndex } = require('./index');
const { learnRoot } = require('./paths');
const { createGlmDrafter, createJevDecider } = require('./drafter');

function has(name) {
  return process.argv.includes(name);
}

function flagVal(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

function print(value, json) {
  process.stdout.write((json ? JSON.stringify(value, null, 2) : typeof value === 'string' ? value : JSON.stringify(value, null, 2)) + '\n');
}

function usage() {
  return `用法: node world/learn/cli.js <命令>

  generate <project> [--draft deterministic|glm] [--decide jev] [--json]
  update   <project> [--draft deterministic|glm] [--json]   仅新增/变化来源
  plan     <project> [--replan] [--decide jev] [--json]     生成学习计划（plan.md）
  index    [--json]                                          重建全局索引
  list     [--json]                                          列出全部卡片
  candidates <project> [--json]                              查看 locked 卡片候选
`;
}

async function main() {
  const cmd = process.argv[2];
  const project = process.argv[3];
  const json = has('--json');
  const root = flagVal('--root', undefined);
  const draftMode = flagVal('--draft', 'deterministic');
  const useJev = has('--decide') && flagVal('--decide', '') === 'jev';

  const drafter = draftMode === 'glm' ? createGlmDrafter({ model: flagVal('--model', 'jd-glm53') }) : undefined;
  const decider = useJev ? createJevDecider() : undefined;

  switch (cmd) {
    case 'generate':
    case 'update': {
      if (!project) throw new Error('缺少项目路径');
      const fn = cmd === 'update' ? updateAfterTicket : generateCards;
      const result = await fn({ projectPath: path.resolve(project), root, drafter, decider, model: flagVal('--model', 'jd-glm53') });
      if (json) return print(result, true);
      if (!result.ok) {
        print(`生成失败：${result.reason}${result.message ? `（${result.message}）` : ''}`);
        if (result.preserved) print('已有卡片保持不变。');
        process.exitCode = 1;
        return;
      }
      print(
        `来源 ${result.sources} 个${result.skippedSources && result.skippedSources.length ? `（跳过 ${result.skippedSources.length}）` : ''}\n` +
          `新写/更新卡片 ${result.wrote} 张${result.noop ? '（无变化）' : ''}\n` +
          `标记 stale ${result.stale} 张\n` +
          `locked 候选 ${result.lockedCandidates.length} 张\n` +
          `重名裁决 ${result.conflicts.length} 组\n` +
          `索引：${result.index}`
      );
      return;
    }
    case 'plan': {
      if (!project) throw new Error('缺少项目路径');
      const result = await createPlan({ projectPath: path.resolve(project), root, decider });
      if (json) {
        print(result.ok ? { ...result, plan: result.plan } : result, true);
      } else if (!result.ok) {
        print(`计划生成失败：${result.reason}\n${result.message}`);
      } else {
        print(
          `学习计划已生成：${result.planPath}\n` +
            `卡片 ${result.plan.cards.length} 张 · 总计 ${result.totalMinutes.low}–${result.totalMinutes.high} 分钟 · ${result.days.length} 天\n` +
            `排序：${result.ordering.mode === 'jev' ? `JEV（${result.ordering.model || 'jev'}）` : '确定性规则'}`
        );
        if (result.diff && (result.diff.added.length || result.diff.removed.length || result.diff.changed.length || result.diff.moved.length)) {
          print(`与上一版差异：新增 ${result.diff.added.length} / 删除 ${result.diff.removed.length} / 变化 ${result.diff.changed.length} / 顺序变化 ${result.diff.moved.length}`);
        }
      }
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case 'plan-show': {
      if (!project) throw new Error('缺少项目路径');
      const plan = readPlan({ root, projectPath: path.resolve(project) });
      if (json) return print(plan, true);
      if (!plan) return print('尚无学习计划。');
      return print(`计划生成于 ${plan.generatedAt}，共 ${plan.cards.length} 张卡片。`);
    }
    case 'index': {
      const r = writeIndex(root);
      if (json) return print(r, true);
      return print(`索引已重建：${r.file}（${r.count} 张卡片）`);
    }
    case 'list': {
      const cards = readAllCards(root);
      if (json) {
        return print(
          cards.map((c) => ({
            id: c.meta.id,
            project: c.meta.project,
            topic: c.meta.topic,
            status: c.meta.status,
            locked: c.locked,
            minutes: c.meta.estimatedMinutes,
            file: c.file,
          })),
          true
        );
      }
      if (!cards.length) return print('暂无学习卡。');
      return print(cards.map((c) => `${c.meta.topic}  [${c.meta.status}${c.locked ? ', locked' : ''}]  ${c.meta.estimatedMinutes} 分钟  ${c.rel}`).join('\n'));
    }
    case 'candidates': {
      if (!project) throw new Error('缺少项目路径');
      const list = readCandidates({ root, projectPath: path.resolve(project) });
      if (json) return print(list, true);
      if (!list.length) return print('没有 locked 候选。');
      return print(list.map((c) => `${c.topic}  ${c.sourcePath}  ${c.reason}`).join('\n'));
    }
    default:
      return print(usage());
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(String((err && err.message) || err) + '\n');
    process.exit(1);
  });
}

module.exports = { main, learnRoot };
