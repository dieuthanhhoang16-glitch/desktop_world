// world/orch/review-window.js
// desktop-world · Review 任务窗口的提示词模板（纯函数，确定性，无 LLM）。
// closeout（收尾）复用本模板——审查与收尾在规范里是同一窗口角色（验证+回执），
// 仅 stageState 不同；差异通过 ctx.header/state 参数自然体现。
'use strict';

const protocol = require('./protocol');
const boundary = require('./boundary-check');

const NAME = 'review-window';

function boundaryTable() {
  return boundary.listRules().map((r) => `  - [ ] ${r.id}（${r.label}）：${r.intent}`).join('\n');
}

/**
 * @param ctx {header:WindowStateHeader, stageTitle, subtaskTitle, tickets:[{id,title}], closeout?}
 *            closeout:true 时按收尾口径生成（清理产物/更新文档/交最终回执）
 */
function buildPrompt(ctx = {}) {
  const h = ctx.header || protocol.windowHeader({});
  const tickets = Array.isArray(ctx.tickets) ? ctx.tickets : [];
  const ticketLines = tickets.length
    ? tickets.map((t) => `  - ${t.id} ${t.title || ''}`.trim()).join('\n')
    : '  （本窗口暂未关联 ORCH 工单）';
  const closeout = ctx.closeout === true;
  const state = closeout ? 'closeout' : 'review';

  const duty = closeout
    ? `归档这一子任务：清理临时产物与中间文件，更新受影响文档，
补齐最终回执后交老二关窗（closed）。**不做新改动**——发现缺陷记 risks 上报。`
    : `对照验收标准**客观验证** execution 的交付：重跑测试、抽查证据、
核对 deliverable 与声明一致。不替 execution 修东西——发现缺陷 verdict=fail
并给出 recommendedNextStep，把返工权还给 execution。`;

  const close = closeout
    ? `收尾的回执（stageState=closeout）：
  npm run world:orch -- report submit --state closeout --file <receipt.json>
deliverable 列出归档/文档更新清单；evidence 含"临时产物已清"的可复核说明。
跨阶段关窗需要下一阶段已授权（老大动作），老二裁定不过时会明说。`
    : `审查的回执（stageState=review）：
  npm run world:orch -- report submit --state review --file <receipt.json>
verdict 只有四档：pass / pass-with-non-blocker（非阻塞风险必须进
risks.nonBlocker）/ fail（缺什么说什么）/ blocked（裁决卡在哪说什么）。
失格就打回 execution 返工（老二会把窗口推回去）。`;

  return `# ${closeout ? 'Closeout' : 'Review'} 窗口（${h.currentMilestone || '未命名任务'} · ${ctx.stageTitle || ''}.${ctx.subtaskTitle || ''}）

## 窗口头
- currentMilestone: ${h.currentMilestone || '(待定)'}
- currentWindowState: ${h.currentWindowState}
- soleGoal: ${h.soleGoal}
- nextAllowedState: ${h.nextAllowedState || '(终态)'}

## 你的职责（只此一件）
${duty}

## 输入材料（关联工单）
${ticketLines}

## 越权红线（触线即失职，回执边界逐项判 ❌）
- 不做掩盖式审查：复现不了的成功不能写成 pass
- 不伪造证据：演示/占位材料标 synthetic，type 只能是 manual
- 不修改被审代码：审查窗口只读业务代码（文档类收尾改动仅限 closeout）
- 不带入旧项目修补逻辑：旧仓库的 workaround 一律视为旧污染

## 收尾动作
${close}

## 九项边界检查（收尾自报，逐项声明）
${boundaryTable()}

## 升级规则
裁定依据不足（证据缺环/验收标准含糊）：verdict=blocked +
blockingDecision 写明卡点，交关口裁决，不要猜着过。`;
}

module.exports = { NAME, buildPrompt };
