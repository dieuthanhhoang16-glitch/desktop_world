// world/orch/planning-window.js
// desktop-world · Planning 任务窗口的提示词模板（纯函数，确定性，无 LLM）。
//
// 用法：新开的 planning 对话窗口把 buildPrompt 的输出原样贴进系统提示/首条消息，
// 窗口就拿到了结构化协作所需的全部上下文：窗口头、职责、关联工单、红线、
// 回执格式与九项边界清单。提示词由代码确定性起草（规范：提示词由 AI 起草=由
// 编排代码起草，而不是让另一个模型现场编）。
'use strict';

const protocol = require('./protocol');
const boundary = require('./boundary-check');

const NAME = 'planning-window';

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
    : '  （本窗口暂未关联 ORCH 工单；规划产出后经 `world:orch plan` 立单）';

  return `# Planning 窗口（${h.currentMilestone || '未命名任务'} · ${ctx.stageTitle || ''}.${ctx.subtaskTitle || ''}）

## 窗口头
- currentMilestone: ${h.currentMilestone || '(待定)'}
- currentWindowState: ${h.currentWindowState}
- soleGoal: ${h.soleGoal}
- nextAllowedState: ${h.nextAllowedState || '(终态)'}

## 你的职责（只此一件）
拆解任务而不是执行它：读现有代码，列出可复用的实现样例与工具函数，给出
分步拆解与每步的验收标准。**不修改任何业务代码**，只允许读、只允许产出计划。

## 输入材料（关联工单）
${ticketLines}

## 越权红线（触线即失职，回执边界逐项判 ❌）
- 不启动 execution：写代码、改配置、跑迁移都属后续状态
- 不绕过审批：规划未回执 pass 前，任何人/代理不得开工
- 不引入第二事实源：计划只进本回执与 roadmap，不另立 wiki/文档副本
- 调度动作只经既有编排链路（npm run world:orch -- …），不发明新通道

## 收尾动作（planning 的回执）
状态收尾时交出 StageReport（stageState=planning）：
  npm run world:orch -- report submit --state planning --file <receipt.json>
receipt.json 字段：stageState / verdict(pass|pass-with-non-blocker|fail|blocked) /
deliverable[≤12]（计划文件与拆解清单位置）/ evidence[≤24] / risks{blocker,nonBlocker} /
boundaryCheck.items（九项逐项自报）/ blockingDecision / recommendedNextStep。

## 九项边界检查（收尾自报，逐项声明）
${boundaryTable()}

## 升级规则
拿不准的架构决策：注释 // TODO: Architecture decision needed，并进回执
risks.blocker + blockingDecision，等关口裁决，不要自行拍板。`;
}

module.exports = { NAME, buildPrompt };
