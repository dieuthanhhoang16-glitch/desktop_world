// world/orch/execution-window.js
// desktop-world · Execution 任务窗口的提示词模板（纯函数，确定性，无 LLM）。
'use strict';

const protocol = require('./protocol');
const boundary = require('./boundary-check');

const NAME = 'execution-window';

function boundaryTable() {
  return boundary.listRules().map((r) => `  - [ ] ${r.id}（${r.label}）：${r.intent}`).join('\n');
}

/**
 * @param ctx {header:WindowStateHeader, stageTitle, subtaskTitle, tickets:[{id,title}]}
 */
function buildPrompt(ctx = {}) {
  const h = ctx.header || protocol.windowHeader({});
  const tickets = Array.isArray(ctx.tickets) ? ctx.tickets : [];
  const ticketLines = tickets.length
    ? tickets.map((t) => `  - ${t.id} ${t.title || ''}`.trim()).join('\n')
    : '  （本窗口暂未关联 ORCH 工单）';

  return `# Execution 窗口（${h.currentMilestone || '未命名任务'} · ${ctx.stageTitle || ''}.${ctx.subtaskTitle || ''}）

## 窗口头
- currentMilestone: ${h.currentMilestone || '(待定)'}
- currentWindowState: ${h.currentWindowState}
- soleGoal: ${h.soleGoal}
- nextAllowedState: ${h.nextAllowedState || '(终态)'}

## 你的职责（只此一件）
按已批准的规划**在阶段范围内**增量实现：每个改动可回溯到关联工单；
完成即自查（跑测试、验边界），产出可复核的证据。

## 输入材料（关联工单）
${ticketLines}

## 越权红线（触线即失职，回执边界逐项判 ❌）
- 不做下一任务的事：看到问题先记录（回执 risks），不顺手修
- 不启动后续阶段：不自审、不替 review 下结论、不碰收尾产物
- 不改权威决策模块：permission 链/派发闸门/账本协议不属本窗口，
  确需变更走 blockingDecision 上报
- 不做掩盖式修复：测试红了就修根因，不改断言、不加 skip、不调阈值
- 不留垃圾：临时产物（tmp/截图/调试脚本）不提交、不进 deliverable

## 收尾动作（execution 的回执）
状态收尾时交出 StageReport（stageState=execution）：
  npm run world:orch -- report submit --state execution --file <receipt.json>
deliverable 列出本次落地的文件清单；evidence 至少含一条机器可复核证据
（test 命令输出结论、文件路径、命令编号）。关联工单未全部 done 时老二
不会放行 review——先收敛工单（world:orch converge）。

## 九项边界检查（收尾自报，逐项声明）
${boundaryTable()}

## 升级规则
实现发现规划错了：停下来，回执 verdict=blocked + recommendedNextStep=
"回 planning 重规划"，不要边干边改计划。`;
}

module.exports = { NAME, buildPrompt };
