# AGENT.md · 五级 Agent 窗口协作体系使用说明

> 本文档介绍 `world/orch/` 之上的**窗口协作层**（multi-agent-refactor 交付）。
> 与既有 `AGENTS.md` 互补，不替代。

## 角色拓扑

```
老大（Main Orchestrator）── 对话角色：统筹 roadmap、授权阶段、不执行
  └─ 老二（Stage Lead）──── stage-lead.js：关口裁定 + 回执核验（7 道关）
       ├─ Planning 窗口 ─── planning-window.js：拆解任务，产出计划回执
       ├─ Execution 窗口 ── execution-window.js：阶段范围内增量实现
       └─ Review/Closeout ─ review-window.js：客观验证 + 归档
```

**老大/老二是协作角色，不是代码里的进程**——代码绝不 spawn 子代理、绝不自动推进
关口；人只在状态转换处裁决。窗口 = 一个真实地对话窗口（人或某个 AI），代码给它
提供协议载体：提示词、回执格式、边界清单、裁定与账本。

## 两套正交状态机

| 状态机 | 载体 | 驱动 |
|---|---|---|
| 工单 `draft→confirmed→dispatched→running→done/failed/blocked` | `tickets.json`（v0.7 既有） | 工单动作（confirm/dispatch/converge） |
| 窗口 `planning→execution→review→closeout→closed` | `roadmap.json`（新增） | **回执 pass + 人工 stage-advance 确认** |

子任务通过 `ticketIds[]` 引用工单（只存 id，聚合永远在裁定时现读，不缓存）。

## 快速开始（全部 CLI，落盘在 `~/.desktop-world/orch/`，`WORLD_ORCH_DIR` 可覆盖）

```bash
# ① 初始化 roadmap（示例 = 本仓库的五级重构路线）
npm run world:orch -- roadmap init --example
npm run world:orch -- roadmap                # 看阶段树 / --json 出原始账本

# ② 老大动作：人工授权阶段（不开这道闸门，任何窗口开不了工）
npm run world:orch -- stage-authorize A

# ③ 开窗口：把提示词原样贴进新对话窗口
npm run world:orch -- window-prompt          # 当前窗口对应状态；--state execution 可指定

# ④ 关联工单（子任务 ←→ ORCH 工单）
npm run world:orch -- roadmap link A.a ORCH-001 ORCH-002

# ⑤ 窗口收尾：交 StageReport（九项边界逐项自报；pass 系必须九项全过 + deliverable 非空）
npm run world:orch -- report submit --state planning --file receipt.json

# ⑥ 人确认推进（先打印老二裁定表，再 y 确认；EOF/n 什么都不写）
npm run world:orch -- stage-advance          # [--to execution] 可指定回边（如 review 打回）

# ⑦ 复盘
npm run world:orch -- reports                # 回执账本一览
npm run world:orch -- facts                  # 黑板（回执/推进以 📋 留痕）
```

## StageReport 字段（receipt.json）

```jsonc
{
  "stageState": "execution",            // 必填：必须是这份回执所验证的窗口当前状态
  "verdict": "pass",                    // pass | pass-with-non-blocker | fail | blocked
  "deliverable": ["world/orch/protocol.js"],   // ≤12 条；pass 系必填
  "evidence": [                          // ≤24 条；字符串等价 {type:"manual"}
    {"type": "test", "content": "node --test 全绿"}
    // type: command|file|screenshot|test|manual；synthetic:true=占位证据（只能配 manual）
  ],
  "risks": {"blocker": [], "nonBlocker": []},
  "boundaryCheck": {"items": [           // 九项逐项 {id, passed, note?}，缺项=拒收
    {"id": "scope", "passed": true}     /* …共九项：scope/overreach/unauthorized/
      authority/second-source/garbage/masking/legacy/fake-evidence */
  ]},
  "blockingDecision": {"blocker": "", "blocksStageClose": false, "blocksNextStage": false},
  "recommendedNextStep": "…单行"
}
```

## 老二推进裁定（七道关，confirm:false 永远只读）

1. 有活跃窗口（`window-none-active`）
2. 迁移合法（`window-transition-invalid`；每态至多一条回边）
3. 回执新鲜且 verdict 为 pass 系（`report-missing` / `report-stale` / `report-verdict-*`；
   **回边例外**：review fail 回执是打回 execution 的燃料）
4. 边界九项全过（`boundary-item-missing/failed` + 机器抽查 `boundary-fake-evidence/garbage/second-source`）
5. 关联工单聚合（execution→review 要求全部 `done`；planning→execution 草案报警）
6. 阶段授权（开工要求本阶段已授权；跨阶段关窗要求下一阶段已授权）
7. 全过 → `readyForHuman=true`，等人敲 `y`

## 文件与目录

| 位置 | 内容 |
|---|---|
| `~/.desktop-world/orch/roadmap.json` | 运行时 roadmap 账本（**唯一事实源**，0600） |
| `~/.desktop-world/orch/reports/` | 回执账本（一文件一回执，0600，prune 200） |
| 仓库根 `roadmap.json` | **示例工件**：本模块自己的五级重构路线，与运行时账本无关 |
| `handoffs/execution-report.md` | 本次重构的结构化回执样例 |

## 常见问题

- **推进被拒**：`stage-advance` 会先打印裁定表与带修复指引的问题码，照 fix 做。
- **窗口状态改错了**：直接编辑 `roadmap.json` 不违规（账本是给人看的），但走
  `roadmap.setWindowState` 的合法迁移更安全；回边用 `stage-advance --to <回边>`。
- **JEV 判断层不参与**：窗口协议完全确定性，不调 LLM；JEV 只在拆单（plan）时用。
- **UI**：v0.7.x 的动态桌面工单树展示窗口五态条/回执面板/roadmap 带（见 world/README.md
  「五级窗口协作」节）；UI 里只有「推进」一个写动作（两步确认），授权永远走 CLI。
