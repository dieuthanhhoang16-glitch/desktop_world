# CONTEXT.md · 词汇契约

> **这份文件是硬约束，不是参考文档。**
> 新增任何标识符（文件名、函数、类、配置键、IPC 通道、CLI 子命令）之前，先读这一页。
>
> 与 `AGENTS.md` 的分工：`AGENTS.md` 回答「改哪里会炸」，本文件回答「这东西到底叫什么」。

---

## 0. 三条规则

1. **先搜后写**
   写任何新符号之前先 `git grep -w <候选名>`，把命中结果贴进 PR / 回复里。命中不等于不能复用，但你必须先看见它。

2. **一概念一词**
   同一个概念，在代码、IPC 通道、配置键、文档、提交信息里只允许一个规范名。同义词表见第 2 节。

3. **造词要申报**
   新词只能通过 PR 里的「词汇 diff」一节申请。批准后写进第 3 节的白名单，否则视为违规。
   生成词汇 diff：`npm run verify:naming -- --vocabulary`。

---

## 1. 规范词汇（唯一真名）

| 规范名 | 含义 | 代码归属 | 禁止别名 |
|---|---|---|---|
| `agent` | 被观测的 AI 编码工具，如 Claude Code / Codex | `agents/*.js`、`src/agent-gate.js` | tool、assistant、provider、bot、cli |
| `agentId` | agent 的稳定小写 id（`claude-code`、`qwenwork`） | 同上 | agentName、toolId、key |
| `integration` | 某 agent 的 hook / plugin / extension 安装状态 | `src/integration-sync.js` | install、plugin、adapter |
| `gate` | 控制 agent 是否安装 / 启用 / 弹权限气泡的开关集合 | `src/agent-gate.js` | switch、toggle、flag |
| `hook` | agent 侧被调用、向 Clawd 上报或阻塞等待的脚本 | `hooks/*-hook.js` | callback、listener、webhook |
| `installer` | 写 / 删 agent 配置、带 marker 所有权的脚本 | `hooks/*-install.js` | setup、register |
| `session` | 一次 agent 会话，跨 agent 的规范单位 | `src/state.js` | conversation、chat、thread¹ |
| `turn` | 一次 prompt → 结束的回合 | `src/*-turn-fence.js` | round、cycle、iteration |
| `snapshot` | `state.js` 产出的会话快照，Dashboard / HUD / 移动端的共享合约 | `src/state-session-snapshot.js` | view、model、payload |
| `prefs` | 用户设置的唯一持久化文件 | `src/prefs.js` | settings、config、options |
| `settingsStore` | prefs 的内存真相 | `src/settings-store.js` | prefs store、state |
| `settingsController` | prefs 的唯一写入者 | `src/settings-controller.js` | manager、service |
| `effect` | 设置提交后的运行时副作用 | `src/settings-effect-router.js` | side effect、action |
| `bubble` | 权限 / 更新气泡窗口 | `src/bubble-*.js` | popup、dialog、modal |
| `theme` | 视觉主题包 | `src/theme-*.js`、`themes/` | skin、pack、style |
| `accessory` | 挂在宠物身上的装饰 | `src/pet-accessory-*.js` | decoration、prop |
| `display` | 一块物理 / 逻辑屏幕 | `src/display-*.js` | monitor、screen |
| `digest` | 一天内采集到的原始活动汇总 | `world/collector*.js` | summary、raw |
| `dailyReport` | digest 经总结后的每日成品（json + png） | `world/summarizer.js` | summary、daily |
| `garden` | 跨天生长的像素世界状态 | `world/garden/` | world、scene² |
| `ticket` | 可独立完成的工作项 | `world/orch/tickets.js` | task、issue、job |
| `stage` | roadmap 的阶段（A / B / C…） | `world/orch/roadmap.js` | phase、milestone |
| `orchWindow` | planning / execution / review / closeout 四个人工关口之一 | `world/orch/*-window.js` | 裸 `window`³ |
| `receipt` | 窗口提交的结构化回执（StageReport） | `world/orch/reports.js` | report⁴、result |
| `boundaryCheck` | 回执里的九项边界自检 | `world/orch/boundary-check.js` | guard、gate |
| `keyword` | 用户配置的学习关键词 | `world/techstack/` | topic、tag、subject |
| `keywordCard` | 由 keyword 长期累积的证据卡（追加、永不覆盖） | `world/study/` | card、learning card |
| `projectCard` | 由项目文档 / 工单生成的卡片 | `world/learn/` | card、learning card |
| `project` | 被跟踪的代码仓库 | `world/projects/` | repo、workspace |

**脚注**

1. `thread` 只用于 Codex 的原生概念（`codex-thread-id.js`），不得跨 agent 泛化。
2. `garden` 是唯一允许叫「世界」的东西；`world/` 是目录名，不是概念名。
3. `window` 在本仓库已被 Electron `BrowserWindow` 占用。协作层必须写 `orchWindow` / `windowState`，禁止裸用。
4. `report` 已被每日早报占用。回执必须叫 `receipt`。

---

## 2. 同义词收敛表

### 2.1 一词一义（代码里只许用左列）

| 语义 | 规范名 | 禁止 |
|---|---|---|
| 读磁盘 | `read*` | `load*`、`fetch*`、`get*FromFile` |
| 写磁盘 | `write*` | `save*`、`persist*`、`store*`、`dump*` |
| 取内存值 | `get*` | `read*`、`fetch*` |
| 取远端 / HTTP | `fetch*` | `pull*`、`retrieve*`、`query*` |
| 构造对象 | `build*` | `create*`¹、`make*`、`compose*` |
| 校验输入 | `validate*` | `check*`、`verify*`（`verify:` npm 脚本除外） |
| 规范化 | `normalize*` | `coerce*`、`canonicalize*` |
| 删除 | `remove*` | `delete*`、`destroy*`、`drop*`（`purge` 仅限 cleanup 的不可恢复删除） |

¹ `create` 已被 `createPlan` / `createJevDecider` 等工厂语义占用；构造函数式用法保留 `create`，其余用 `build`。

### 2.2 一词多义（必须限定前缀）

以下词在本仓库已经承载了不止一个概念，裸用即违规：

| 词 | 已占用的含义 | 正确写法 |
|---|---|---|
| `state` | 宠物动画状态 / settings 内存 / orch 窗口状态 | `petState` / `settingsState` / `windowState` |
| `window` | Electron BrowserWindow / 协作窗口 | `browserWindow` / `orchWindow` |
| `report` | 每日早报 / 窗口回执 | `dailyReport` / `receipt` |
| `card` | 关键词卡 / 项目卡 | `keywordCard` / `projectCard` |
| `config` | prefs / channels.json / techstack.json / watch.json | 按文件名限定：`channelsConfig` 等 |
| `store` | 设置存储 / orch 账本 | `settingsStore` / `orchStore` |
| `plan` | 学习计划 / 桌面整理计划 / roadmap 计划 | `learningPlan` / `tidyPlan` / `roadmapPlan` |

---

## 3. 禁用命名

### 3.1 禁用后缀（新增文件 / 类 / 函数一律不许用）

```
Manager  Helper  Util  Utils  Processor  Service  Core  Engine
Adapter  Wrapper  Controller  Factory  Provider  Resolver
Registry  Store  Runtime  Renderer  Handler  Impl  Base
```

现有存量（`renderer` ×11、`runtime` ×10、`store` ×7、`utils` ×5 …）按 grandfather 处理：
**不改名不算债，新增第二个同名后缀就是债。**

理由：这些词不描述职责，只描述「它在架构里占了个位置」。它们让 AI 觉得「我已经命名了」，
于是下一个模块又发明 `AccountSyncer`、`AccountManager`、`AccountService` 三兄弟。

### 3.2 禁用裸名

```
utils.js  helpers.js  common.js  misc.js  core.js  data.js  temp.js
new*.js   *2.js  *-old.js  *-backup.js  *-copy.js
```

### 3.3 文件名不得跨目录重名

新增文件的 basename 若已在别的目录存在，必须先说明为什么不能复用或合并。
现有重名（`cards.js`、`cli.js`、`state.js`、`plan.js`、`paths.js` …）是第 6 波清理目标。

---

## 4. 需要先提案才能改的架构取舍

改动以下任何一项，必须先写 ADR 进 `docs/project/`，不得在实现 PR 里顺手做：

| 取舍 | 现状 | 改动成本 |
|---|---|---|
| 无 TypeScript | 全 CJS + 浏览器全局脚本 | 全仓类型化，收益大但一次性成本极高 |
| 无打包器 / 无浏览器模块系统 | `settings.html` 挂 23 个 `<script>`，靠 `ClawdSettingsCore` 全局对象 | 需要先定 ESM 还是 IIFE 注册表 |
| 无 lint / formatter | 只有 `node --test` | 引入即产生巨量存量 diff，需先定基线策略 |
| `world/` 与上游 `src/` 解耦 | fork 只新增、不改上游引擎 | 一旦跨层引用，上游合并会持续冲突 |

---

## 5. 已登记新词（造词白名单）

> 只登记**现有词汇表装不下**的概念。登记即承诺：全仓统一使用，不再接受第二个名字。

| 新词 | 为什么现有词不行 | 批准日期 | 归属 |
|---|---|---|---|
| `receipt` | `report` 已被每日早报占用；`result` 太泛 | 2026-10-10 | `world/orch/reports.js` |
| `orchWindow` | `window` 与 Electron BrowserWindow 冲突 | 2026-10-10 | `world/orch/*-window.js` |
| `boundaryCheck` | `gate` 已指 agent 开关；九项自检是独立概念 | 2026-10-10 | `world/orch/boundary-check.js` |

---

## 6. 提交前的词汇自检（贴进 PR 描述）

```markdown
## 词汇 diff
本次新增的、仓库里此前不存在的名词：

| 新词 | 为什么不能复用已有名词 | 是否已登记 CONTEXT.md |
|---|---|---|
| （无） | | |

本次新增的标识符总数：N
`npm run verify:naming -- --vocabulary` 输出：（粘贴）
```

**没有这一节，不允许合并。**
