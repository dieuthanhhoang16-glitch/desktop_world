# world/ — Desktop World 每日早报模块（v0.6.5）

> 本项目 fork 自 clawd-on-desk（AGPL-3.0）。本目录是 fork 后的差异化模块，
> 与上游 `src/` 引擎保持解耦：只新增、不改动（唯一接线点见下方「App 内集成」）。

## 功能

每天把本机 AI 助手（Claude Code + Codex）的活动汇总成**一句话总结 + 3 条新思路 + 任务看板**，
再结算进一个**跨天生长的像素小世界**，以**动态桌面组件**（透明热刷新 widget）与
**早报 PNG**（IM 分享底稿）两种形态呈现。

> **v0.6.4：「壁纸」设计整体取消**——本模块不存在任何会设置系统桌面壁纸的代码路径
> （原 macOS osascript / Windows SystemParametersInfo / Linux gsettings 三个设壁纸分支、
> 托盘「生成今日早报壁纸」菜单项、CLI `--no-set` 开关全部移除）。
> 用户的桌面壁纸由系统/用户全权管理，本模块永远只读不写。

数据全程不出本机：采集只读 `~/.claude/projects/*.jsonl` 与 `~/.codex/sessions/**/*.jsonl` 转录；
总结走本机 `claude -p` 无头模式（复用本机登录，无需 API key）。

## 用法

```bash
npm run world:daily          # 采集 → 总结 → 世界结算 → 产出早报 PNG（绝不设壁纸）
npx electron world/cli.js --no-llm   # 跳过 LLM，用模板兜底总结
npx electron world/cli.js --reuse    # 用最近一次报告重渲染 PNG（调模板样式用）
npx electron world/cli.js --share    # 出 PNG 后顺手分享到全部已配置渠道
```

## 分享（v0.2）

```bash
# 1. 配置渠道（webhook 即密钥，存 ~/.desktop-world/channels.json，0600）
npm run world:channels -- --list
npm run world:channels -- --set wework  "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=XXX"
npm run world:channels -- --set dingtalk "https://oapi.dingtalk.com/robot/send?access_token=XXX" --secret SECxxx
npm run world:channels -- --set feishu  "https://open.feishu.cn/open-apis/bot/v2/hook/XXX" --secret xxx
npm run world:channels -- --remove feishu

# 2. 分享最近一份日报
npm run world:share                          # 全部已配置渠道（带图）
npx electron world/share/send.js --to wework,dingtalk --no-image   # 指定渠道/纯文字
```

渠道能力矩阵：

| 渠道 | 文字 | 图片 | 安全机制 | 备注 |
|---|---|---|---|---|
| 企业微信 | ✅ markdown | ✅ base64 直发（自动压到 ≤2MB） | — | 发图最省事的渠道 |
| 钉钉 | ✅ markdown | ⚠️ media_upload 换 media_id，失败自动降级纯文字 | 加签 ✅ / 关键词 ✅ | 图片路径部分机器人不开放 |
| 飞书 | ✅ 富文本 post | ❌ 需自建应用 image_key（待评估） | 签名校验 ✅ / 关键词 ✅ | v0.2 只发文字 |

关键词安全设置：三个渠道若开了关键词校验，把关键词设为 **日报** 即可（分享标题固定含这两个字）。

环境变量：`WORLD_CHANNELS_FILE` 可覆盖配置文件路径（冒烟测试/便携场景）。

## 生长世界（v0.4）

动态桌面与早报 PNG 的左下角是一条**跨天持久的像素景观带**：每天第一次结算把当日成果兑现成 xp，
世界随天数与投入逐步解锁形态 —— 🫘种子 → 🌱新芽(100xp) → 🌿树苗(300) → 🌸开花树(600) → 🌳果林(1000) → 🏰空中花园(1500)。

- 结算规则：出勤 30xp + 会话 ×10（封顶 20）+ 工具 ×0.25（封顶 400）；**同日重跑幂等不重复加分**
- 状态落盘 `<outDir>/world-state.json`（`daysActive/streak/xp/totalSessions`）；
  数值只用加法、随时可手改后悔，`loadState` 坏了就重回种子不会崩
- 场景渲染 `world/garden/scene.js` 是纯函数且**确定性**（同一状态永远同一张图），
  由 FNV-1a 哈希 + mulberry32 驱动植被/星光散布；分享文案自动带一行「🗺️ 世界 Lv…」

## 多 agent 采集（v0.4）

除 Claude Code 外自动探测 `~/.codex/sessions/**/*.jsonl`（今天有消息的）合并进同一份 digest，
`digest.agents` 记录各来源会话数，模板/总结提示词都会区分助手。
关闭方式：代码 `options.codex === false`；目录可用 `CODEX_SESSIONS_DIR` 覆盖。
Codex 转录 schema 演进快，解析策略"宽进严出"：坏行跳过、字段缺失用兜底。

## 桌宠皮肤：芽芽 Sprout（v0.4）

`world/creature/` 程序化生成 16-bit 像素桌宠「芽芽」（ sprites.js 定义 23 个状态，
`generate.js` 输出 `themes/sprout/`：assets/*.svg + theme.json schemaVersion 1）。
重启后 Settings → Theme 选 **「芽芽 Sprout」** 即可上桌；改造型改 `sprites.js` 再跑：

```bash
npm run world:theme          # 重新生成 + 跑 scripts/validate-theme.js 官方校验
```

定位说明：这是**程序化占位皮肤**（先让"世界园丁"上任）。量产美术仍走
docs/art-style-research.md 的 AI 出图管线 —— 届时只需换 `themes/sprout/assets/` 位图，
theme.json 与生成器不动。passing 关键约束：追眼状态必须 SVG（本皮肤 eyeTracking=off）、
miniMode 8 状态必填、sleepSequence full 四个过渡态都要真实文件。

## 桌面整理（v0.3）

```bash
npm run world:tidy -- --scan     # 只预览分类，不动文件
npm run world:tidy               # 预览 → 逐个列出 → 确认[y/N] → 归档到 ~/Desktop/_归档/<类别>/
npm run world:tidy -- --yes      # 跳过确认直接执行（定时任务用）
npm run world:tidy -- --undo     # 还原最近一次整理
npm run world:tidy -- --no-llm   # 不用 claude 给"其他"桶细分类
```

安全设计（这个模块的原则是"绝不让你后悔无门"）：
- **先申请后移动**：CLI 需 y 确认；App 托盘入口走系统确认对话框
- **一键撤销**：每次执行写 undo 日志，`--undo` 逆序还原（逆序避免连锁冲突）
- **重名零覆盖**：目标已存在自动 `-1`/`-2` 加序号，磁盘现状 + 计划内部双重避让
- **不碰正在用的文件**：默认跳过最近 60 分钟内改动的文件（`--min-age-min` 可调）
- **只收顶层散文件**：桌面上的文件夹保持原地不动（v0.3 取舍，未来再评估）

分类：扩展名规则（安装包/图片/文档/音视频/压缩包/代码/设计稿）+ 文件名矫正（截屏、票据）+ LLM 给"其他"桶想细分（调本地 `claude -p` 一次，失败自动维持原分类）。

⚠️ 若你开着 macOS「iCloud 桌面与文稿」同步，归档移动会同步上传，属正常行为。

输出位置：`world/out/`（CLI 模式）或 `<userData>/world/`（App 内）。
产物：`daily-YYYY-MM-DD.json`（报告）、`daily-YYYY-MM-DD.png`（早报分享底稿；不会设为壁纸）。

环境变量：
- `WORLD_OUT_DIR` — 自定义输出目录
- `WORLD_NO_LLM=1` — 全局禁用 LLM，等价 `--no-llm`
- `CLAUDE_BIN` — claude CLI 路径（默认 `claude`）
- `CLAUDE_PROJECTS_DIR` — Claude 转录目录（默认 `~/.claude/projects`）
- `CODEX_SESSIONS_DIR` — Codex 转录目录（默认 `~/.codex/sessions`）
- `WORLD_WATCH_FILE` — 专案追踪配置路径（默认 `~/.desktop-world/watch.json`）
- `WORLD_LIVE_FILE` — 动态桌面配置路径（默认 `~/.desktop-world/live.json`）

## 专案追踪（v0.5）

把「特定文件夹」登记进追踪列表，早报（卡片 / 分享文案 / 动态桌面）里就会出现它的进度卡：
今日会话数、累计天数、连击🔥、14 天柱图；会话卡片还会带分类角标（学习 / 工作 / 生活 / 开源 / 其他）。

```bash
npm run world:watch -- --add 工作 ~/Documents/desktop-world --name 桌面世界
npm run world:watch -- --add 学习 ~/Documents/co-agent-paper
npm run world:watch -- --list
npm run world:watch -- --remove 桌面世界
```

- 配置存 `~/.desktop-world/watch.json`（0600，`WORLD_WATCH_FILE` 可覆盖）。
- 分类挂在文件夹上；`--add` 时不给分类就按名字启发式猜（带 paper/thesis/学习… → 学习，否则工作）。
- 匹配规则：会话 cwd 的最长路径前缀命中；子目录可以单独登记。
- 结算按天、同日幂等：一天跑多次流水线不会重复累计，只会刷新"今天"的柱高。
  特例同日升级：凌晨 0 会话先结算过、当天之后才开工，仍会按新的一天补记。
- 没配置任何文件夹时，整个功能在模板和分享文案里完全静默（不显示）。

## 动态桌面（v0.6.1 重做形态，v0.6.2 看板增强，v0.6.3 番茄钟 × 任务）

烘焙 PNG 是把早报"截图"用于 IM 分享，有裁剪、会糊；动态桌面是另一个思路——
透明无框、常驻的桌面组件，直接渲染早报模板本身（原生清晰度），数据每 15 分钟自动热刷。
v0.6.1 起它从「实体卡片」重做为真正融进桌面的可互动 widget（用户定调）：

- **无卡片化**：没有底板和边框，内容直接"印"在桌面上；文字带投影保证任何系统壁纸上可读，
  暗色半透明小片承接芯片/卡片分组。（烘焙 PNG 走 `body.bake`，排版与 v0.5 一个像素不动。）
- **默认可交互**：随手记点击即可输入；窗口按住左栏/空白处可拖动（`app-region:drag`，看板区 no-drag）；
  想回到「完全不影响操作」就菜单里「🔒 锁定动态桌面（点击穿透）」。老配置里 v0.5 默认存的
  `clickThrough:true` 有一次性迁移刷成可交互。
- **桌宠入住景观**：左侧像素世界带里有当前主题桌宠（默认 girl，可 `WORLD_PET_THEME` 换）的
  APNG 动画——有进行中会话按引擎 workingTiers 语义分级（1 敲键盘 / 2 三颗星 / 3 搬砖），
  深夜（23–7 点）无活动时睡觉；纯数据驱动（`world/live/pet.js`），App 侧可用
  `live.setPetState()` 注入引擎真状态覆盖。烘焙 PNG 保持纯静态世界，不含桌宠。
- **随手记**：右栏底部可编辑便签区，按天存 `<outDir>/notes.json`（0600，仅本机；
  不进烘焙 PNG、不进分享图）。防抖 400ms 落盘，换日自动切换当日条目（`world/live/notes.js`）。
- **已完成列清理（v0.6.2）**：每张已完成卡片悬停出现「×」**隐藏该条**——只把卡片从今天
  的看板拿掉（按天存 `<outDir>/dismissed.json`，0600），不动原始会话记录；footer 出现
  「已隐藏 N 条 · 全部恢复」一键撤销。已完成列不再封顶 4 张，全量展示 + 细滚动条。
  隐藏键是采集层面的稳定会话 id（`agent:id`，无 id 退内容哈希，`world/live/board.js`）。
- **今日卡点 / 技术总结（v0.6.2）**：日报总结时 LLM 顺带产出当天**卡点**（卡住/返工/报错/
  受阻，≤4 条）与**技术总结 tips**（可复用经验，≤4 条）；流水线把它们写成
  `<outDir>/blockers-YYYY-MM-DD.md`、`tips-YYYY-MM-DD.md`。动态桌面右栏出现
  「🚧 今日卡点」「💡 技术总结」两个 chip（悬停看全文），点击**用系统默认程序打开当日 md**；
  当天没产出就静默不出现。烘焙 PNG 不含这两个 chip。
- **番茄钟 × 任务（v0.6.3）**：左栏统计之下、像素景观之上一条单行横条（用户定调形态）。
  标准 25 分钟专注 + 5 分钟休息循环：▶ 开始（可选关联看板里某张进行中会话卡，或自由输入任务名）/⏸ 暂停/⏭ 跳过；
  专注满钟自动进休息，休息结束回 idle（不强推下一个）。
  **主进程是唯一时钟源**——状态存 deadline 时间戳（endAt）而非"已过时长"，渲染层 1Hz 轮询
  `world:pomo:poll`（内含幂等 tick 推进/结算），窗口重载、App 重启、睡眠唤醒都不丢时间。
  数据按天存 `<outDir>/pomodoro.json`（0600，留最近 30 天）：完成番茄数、当日累计专注、
  各任务累计毫秒（会话卡键 `sid:<稳定会话键>` 与自由任务键 `text:<标题>` 分开记账）、
  手动完成的会话清单。跳过/被挤掉的专注段按已花时长记账但不计满钟番茄。
  **看板联动**：进行中卡片带「✓」手动完成（卡片挪进已完成列，当日幂等）；专注时段的任务累计
  时长以 🍅 角标显示在对应卡片上。**像素世界联动**（抄 [munder-difflin](https://github.com/HarnessMD/munder-difflin) 的设计，不抄代码——
  "信息即动作"）：专注期间桌宠头顶浮出 `🍅 任务名` 标签，且角色动作按任务类型映射
  （`pomodoro.taskActionFor`：读/研究→thinking，整理/归档→sweeping，搬运/同步→carrying，
  会议/沟通→attention，其余→working 顶档）；引擎 `setPetState()` 显式覆盖仍最高优先。
  整条横条、头顶标签、🍅 角标都只在 live 组件出现，烘焙 PNG 一律不含。
- **组件永不碰系统壁纸（v0.6.4 起代码层根除）**：跨零点升级完整流水线只做世界结算 + 新一句话 + 分享 PNG，
  没有任何设置系统壁纸的调用；CLI `world:daily` 亦然——PNG 纯作 IM 分享底稿。
- 配置存 `~/.desktop-world/live.json`（`WORLD_LIVE_FILE` 覆盖）：`{enabled, clickThrough, refreshMin, w, h, x, y}`；
  `enabled:true` 时 App 启动自动恢复窗口。
- 开发预览：`npm run world:live`（独立进程，行为与正式窗口一致）。

边界：窗口浮在桌面图标**上方**（与桌宠同一层）。图标下方的真·壁纸层 PoC 已验证可用
（`world/live/poc/`，Plash 招式在 macOS 26 全部生效），接回 Electron（N-API 小桥或 sidecar 宿主）是 v0.6 后续段。

## 定向学习（v0.6.5）：技术总结从"被动总结"变"用户定向"

配置想深入的技术方向，每天的 💡 技术总结就从"泛泛经验"升级为**贴着当日真实材料的八股考点**。
全链路只在配置层与提示词层插桩，现有流水线只读契约不动；没配目标时旧行为一个字符不变。

**配置渠道（CLI，`world/techstack/`，范式同 world:watch）：**

```bash
npm run world:techstack                              # 列出目标
npm run world:techstack -- --add 状态管理             # 出候选关键词（不写盘）——agent 收敛对话的素材
npm run world:techstack -- --add 状态管理 \
  --keywords "zustand persist 持久化,Redux/zustand 选型取舍"   # 收敛后才落盘
npm run world:techstack -- --remove 状态管理
```

- **关键词收敛对话（核心）**：`--add` 不带 `--keywords` 时只出候选——CLI 聚合「项目记忆」
  （watch.json 专案 + 近 7 天日报的项目/标题/工具分布 + 历史 tips/blockers），
  给 4–8 个具体候选（LLM 结合记忆出题，挂了静默退确定性词典）。agent 拿到候选后在对话里
  向用户确认（多选/自定义，每次最多一问），收敛定了带 `--keywords` 重跑才写
  `~/.desktop-world/techstack.json`（0600，`WORLD_TECHSTACK_FILE` 可覆盖）。
  关键词白名单校验（中英文/数字/常见技术符号，≤30 字，每目标 ≤8 个）。
- **动态桌面里也能配**：右栏「🎯 定向学习」区输入方向回车 → IPC 出候选 → 点选 → 落盘
  （contenteditable + `__worldTech` 最小桥，照随手记模式；记忆聚合与写盘全在主进程）。
- **八股化 techTips**：summarizer 提示词注入目标关键词，产出 `{topic, project, answer, hook,
  action}` 结构（【考点】+ 标准答案 2-4 句 + 记忆钩子 1 句 + 今天就能做的一步）；材料对不上
  的目标静默跳过。tips md 按行段排版，动态桌面 💡 chip 悬停展示全文；**烘焙 PNG/分享文案不变**。
- 降级：文件读坏回空、LLM 失败回确定性词典/模板总结，流水线永不被本功能打断。

## 学习卡片（v0.7）：让「配了关键词」真的产出东西

v0.6.5 补上的是「怎么把方向收敛成关键词」，但**关键词落盘之后链路上没有任何 writer**——
`techstack.json` 写完就结束，唯一的 md writer（`writeDayNotes`）只在日报流水线里写按天的
「今日卡点/技术总结」，与 keyword 没有任何绑定。所以「配了关键词却从没生成过学习 md」是
必然结果，不是偶发。v0.7 把**今日 tips** 与**学习卡片**明确拆成两种东西：

| | 今日 tips（v0.6.5） | 学习卡片（v0.7） |
|---|---|---|
| 粒度 | 一天一份 | **一个关键词一份** |
| 反映 | 今天发生了什么 | 这个考点我学到什么 |
| 写入 | 按日报覆盖式重写 | **只追加，永不覆盖** |
| 没内容时 | 静默不写文件 | **照样建档**，写「空白区」明确告知还在等 |

```bash
npm run world:study -- --list                        # 列全部卡片与进度（顺带刷新 index.md）
npm run world:study -- --sync                        # 扫近 7 天日报，补回填历史欠账
npm run world:study -- --sync --days 30              # 扫近 30 天
npm run world:study -- --ensure                      # 只补齐没建档的关键词
npm run world:study -- --open                        # 打印 index.md 路径
```

- **落盘位置**：`~/.desktop-world/study/index.md` + `study/<goal-slug>/<keyword-slug>.md`
  （0600，`WORLD_STUDY_DIR` 可覆盖）。**刻意不跟 outDir**：outDir 在 App 里是
  `userData/world`、在 CLI 里是仓库 `world/out`，两处路径不同；卡片跟 outDir 走会分裂成两份，
  `--sync` 也补不上 App 那份。与 `live.json` / `techstack.json` 同源放在 `~/.desktop-world/` 下。
- **文件名用稳定 hash id**（`kw-<hash8>`，FNV-1a，见 `techstack/config.js` 的 `keywordId`），
  **绝不用中文标题**——标题里一个标点的增删就会改掉文件名，历史卡片直接失联。改标题 = 新考点。
  id 落盘在 goal 的 `kwIds` 里冻结，将来换算法老卡片也不搬家。
- **写入时机（两条，都幂等）**：① `runDaily()` 末尾调 `study.scanAndAppend()`，把当天 techTips
  按关键词回填（`pipeline.js` 里包在 try/catch 里，学习卡片出问题绝不打断日报）；
  ② `world:study -- --sync` 扫近 N 天补历史欠账。**同日幂等**靠 `card.appendEvidence` 见到
  当天分节就返回 null 实现，不依赖任何额外状态文件。回看窗口按**日期**算而不是「最后 N 个
  文件」——目录里若有一份跨年残留的旧日报，数量切片会把它当最近的收进来。
- **匹配口径宁缺毋滥**：只有结构化考点（`{topic,...}`）才会被归属；旧的字符串 tips 无法可靠
  对应到具体关键词，一律不收。短通用词（`ipc`、`状态`）不做弱匹配，避免乱认亲。
  **配目标之前的历史日报无法自动归属**，只能人工整理。
- **建档即补白**：没材料的关键词也会建一张卡并写「🧩 空白区」——否则用户看到的仍然是
  「配了关键词但什么都没有」。
- **动态桌面里看**：右栏「定向学习」下方新增「📚 学习卡片」区，列出每个关键词的卡片与实证天数，
  点开用系统默认程序打开对应 md（`__worldStudy` 最小桥：列卡片 / 开卡片 / 开总览；路径白名单
  校验，只放行 `STUDY_DIR` 之下的已存在文件）。**烘焙 PNG 形态不含此区**。
- **`normalizeTechTips()` 空数组语义**：过去空输入返回 `undefined`，让「今天确实没料」和
  「功能坏了」变成同一个信号——调用方一律当「没有」处理，学习卡片因此无法给没命中的关键词
  建档。现改为返回 `[]`，由调用方决定静默（日报 md 的既有行为不变）还是补白（学习卡片）。
  所有既有消费点判的都是 `.length`，`[]` 与 `undefined` 在那里等价，UI 行为不变。

## 模块

| 文件 | 职责 |
|---|---|
| `collector.js` | 采集当日会话 → digest（项目/标题/时长/工具分布/活跃直方图/看板状态） |
| `summarizer.js` | digest → `{oneline, ideas[3], blockers[≤4], techTips[≤4]}`（`claude -p`，失败降级模板，降级时卡点/tips 为空） |
| `template/daily-card.html` | 早报卡片模板（左：日期/统计/世界景观；右：专案+看板列在上，一句话+灵感钉底；`window.__worldRender` 热刷） |
| `bake.js` | 隐藏窗口渲染 → `capturePage` → 早报 PNG（仅 IM 分享底稿；v0.6.4 起不设系统壁纸） |
| `pipeline.js` | 串联 collect → summarize → 世界结算 → 落盘（含当日卡点/tips md → 学习卡片回填）→ bake，CLI 与 App 共用 |
| `cli.js` | 独立 Electron 命令行入口 |
| `app-integration.js` | 桌宠 App 内入口（托盘菜单调用、系统通知反馈、防抖） |
| `collector-codex.js` | Codex 会话采集（宽进严出解析，可 `options.codex:false` 关闭） |
| `watch/` | 专案追踪：`config.js`（文件夹登记/分类/最长前缀匹配）、`state.js`（按天结算同日幂等/视图）、`watch.js`（CLI） |
| `live/` | 动态桌面：`live.js`（widget 窗口 + 15 分钟热刷新 + 随手记/看板隐藏/开 md/番茄钟 IPC）、`notes.js`（按天便签存储）、`board.js`（按天隐藏清单 + 稳定会话键）、`pet.js`（景观桌宠动画挑选）、`pomodoro.js`（番茄钟状态机：主进程时钟 + 按天存储 + 任务类型→动作映射）、`preload.js`（最小 contextBridge）、`preview.js`（开发预览入口）、`poc/`（桌面层 PoC：Swift 桌面层窗口 + 层级验证器） |
| `techstack/` | 定向学习：`config.js`（目标读写/关键词白名单/稳定 keyword id 0600）、`memory.js`（项目记忆聚合：专案+近7天日报）、`propose.js`（候选关键词：LLM 结合记忆 + 确定性词典兜底）、`techstack.js`（CLI） |
| `study/` | 学习卡片：`index.js`（读写主入口/建档/回填/index 总览/CLI 入口）、`card.js`（卡片渲染与追加的纯函数，同日幂等与「只追加不覆盖」都在这里）、`scanner.js`（把日报结构化考点匹配回关键词，宁缺毋滥）、`cli.js`（`world:study` 的 --list/--sync/--ensure/--open） |
| `garden/` | 生长世界：`state.js`（持久状态/结算/阶段表）、`scene.js`（确定性像素 SVG）、`index.js`（门面） |
| `orch/` | 多智能体编排：`tickets.js`（工单模型 + id 发号 + 依赖图 + 状态机 + 确定性拆分器）、`store.js`（tickets.json 唯一写入口）、`blackboard.js`（共享事实，只追加）、`mailbox.js`（每 session 收件箱，只追加）、`dispatch.js`（派单可行性硬闸门）、`scene-agents.js`（工位场景，确定性像素 + 飞行信封路线）、`index.js`（只读视图门面）、`prefs-source.js`（纯 Node 读 clawd-prefs.json）、`cli.js`（`world:orch` 拆分/确认/派发/收敛）、`paths.js`（落盘根目录与常量） |
| `creature/` | 桌宠皮肤「芽芽」：`sprites.js`（23 状态像素精灵库）、`generate.js`（themes/sprout 生成器） |

## 多智能体编排（v0.7）：把已有会话当工位来编排

对象模型借鉴 [munder-difflin](https://github.com/HarnessMD/munder-difflin)（Ticket / Envelope /
Blackboard / task ledger 与「左 roster · 中 2D 办公室 · 右 Command Center」的信息架构），
**不抄它的代码**，并且做了一个关键替换：

> munder-difflin 编排的是自己用 `node-pty` 拉起来的 agent 进程；
> **这里编排的是 `src/agent-runtime-main.js` 已经观察到的 26 个 agent 的真实会话。**

因为本仓库最强的地方就是它已经把多 agent 状态收敛成了统一的 session snapshot，
再叠一套 PTY + 终端渲染栈只会拖垮打包。所以：

| munder-difflin | 这里的映射 |
|---|---|
| Agent / Session（node-pty 进程） | `src/state.js` 的 session snapshot + `agents[customId]` 注册的真实 HTTP Agent |
| Ticket / task ledger | `~/.desktop-world/orch/tickets.json`（看板复用 `world/live/board.js` 的按天存储模式） |
| Blackboard | `~/.desktop-world/orch/blackboard.json`（**只追加**，永不覆盖） |
| Envelope / inbox | `~/.desktop-world/orch/mailbox/<sessionId>.json` |
| Michael（编排者） | 本 Stage 不做（见 Stage C-2） |

### 明确不做（越界了就等于把项目带歪）

- **不引入 `node-pty` / `xterm.js` / `Pixi.js`**：原生依赖 + 全新渲染栈，且与本仓库
  「透明无框热刷新 HTML 组件」的既定形态冲突。`package.json` 里也没加。
- **不做自由 spawn**：没有任何代码决定启动哪个进程、在什么目录跑、执行什么命令。
  工单里**不含** command / argv 字段——本模块没有能力 spawn。
- **不新增第三个窗口**：编排视图是动态桌面里的**第二个 tab**（Stage A 刚把窗口数量问题解决掉）。
- **权限链路零改动**：工单只是写进目标 session 的收件箱。那个 agent 要不要动手、工具要不要批准，
  仍完全走 `src/permission.js` 原链路，编排层**不新增任何绕过口**。

### 拆分流程（确定性优先）

```
目标 → ①本地拆分器出工单草案 → ②dispatch 可行性检查 → ③【人确认】逐条勾选/改派/删
     → ④写 tickets.json 并投递到目标 agent 的 mailbox → ⑤观察 agent 状态变化
     → ⑥工单收敛后回报进 blackboard
```

第 ③ 步的**人确认是硬要求**。本 Stage 先只做 CLI 交互（逐条 `y`/`n`/`a`/`e`），
UI 上的勾选下个 Stage 再做。`--yes` 可以跳过逐条提问，但**永远跳不过可行性检查**。

### 用法

```bash
npm run world:orch -- agents            # 哪些 agent 现在可派单（复用 agent-gate 语义）
npm run world:orch -- plan "<目标>" --agent claude-code --cwd .
npm run world:orch -- plan "<目标>" --agent claude-code --dry-run    # 只拆+检查，不写盘
npm run world:orch -- plan "<目标>" --agent claude-code --independent  # 并行而非线性链
npm run world:orch -- list              # 工单看板（按状态列）
npm run world:orch -- status            # 工位场景 + 工单 + 收件箱概览
npm run world:orch -- check             # 只跑可行性检查（含依赖成环）
npm run world:orch -- confirm ORCH-001 --to <sessionId>
npm run world:orch -- dispatch ORCH-001 --to <sessionId>
npm run world:orch -- converge ORCH-001 --summary "收敛结论"
npm run world:orch -- note "一条共享事实"   # 写黑板
npm run world:orch -- facts               # 读黑板
```

`sessionId` 取自 App 的 Sessions Dashboard（真实 session snapshot 的 `id`）。
编排层**不自己挑会话**：`dispatch` 不给 `--to` 就直接拒绝。

### 三个硬闸门（`world/orch/dispatch.js`，任一不满足就明确报错，不硬派）

1. **目标 agent 必须已安装且已启用** —— 判定完全复用 `src/agent-gate.js` 的
   `isAgentIntegrationInstalled` / `isAgentEnabled`，**不自造第二套名单**。
   区分两种失败并给不同建议：未安装 → 去 Settings 点 Install；已装未启用 → 去开开关
   （只启用不卸载 hooks/plugins）。伪造/未注册的 `custom-` id 直接拒绝，
   **绝不降级成某个内置 agent**。注册的自定义 HTTP agent 按 prefs 契约
   `integrationInstalled` 恒为 false，所以只查 `enabled`。
2. **cwd 必须真实存在且是目录** —— 空 cwd 也算不满足（不猜当前目录）。
3. **依赖不成环** —— 整批一起看（单看一张看不出环）。三节点环、自环、悬空依赖、
   自依赖分别报出，并给出打断环的修复建议。

### 工单数据模型

```
{ id: "ORCH-001", title, action, agent, cwd, dependsOn: ["ORCH-001"],
  status: draft|confirmed|dispatched|running|done|failed|blocked,
  acceptance: ["可判定的完成条件", ...] }
```

- **id**：`ORCH-001` 形式，按账本里已存在的最大序号 +1（`ORCH-999` 用尽后明确报错，
  不静默进 `ORCH-1000`）。
- **拆分器**：本地确定性规则（标点 + 连接词切句 → 归一 → 逐条成单），
  **不调 LLM、不含随机**。同一输入永远同一输出——测试直接断言这一点。
  默认出**线性链**（第 N 条依赖第 N-1 条），`--independent` 走并行。
- **只追加 vs 可改写**：黑板与收件箱**只追加**（已写入的事实永不改写，事实错了就再追加一条
  `correction` 用 `supersedes` 指向旧的）；只有 `tickets.json` 允许改状态，且必须过状态机
  （`done` 是终态，`draft` 不能跳级到 `dispatched`）。
- 自由文本（标题/结论/信封正文）进盘前一律收掉换行——否则一条 entry 能带换行伪造出第二条。

### 工位场景（`world/orch/scene-agents.js`）

复用 `world/garden/scene.js` 的两条纪律：**纯函数 + 确定性随机**（FNV-1a + mulberry32）。
同一份工单描述永远渲染出同一张 SVG，热刷新不会每次换座位。
动作映射参考 `world/live/pomodoro.js` 的 `taskActionFor`（读/研究→thinking、
整理→sweeping、搬运→carrying、会议→attention、其余→working）。

**引擎真实状态与工单状态是两个独立信号**：引擎状态（来自 session snapshot）画成工位头顶的
信号条，工单状态（人确认推进的）画成台灯。这样「工单已派发但会话还没动」和「会话在跑」
是两件能分别看见的事——两者不同就必须画出不同的像素，否则联动等于没做。

飞行信封（依赖边）只用 CSS `transform` + `@keyframes`，JS 仅在渲染时算一次坐标
写进 CSS 变量，**不做逐帧 JS 动画**；并尊重 `prefers-reduced-motion`。

### 动态桌面里的工单看板 tab

`world/template/daily-card.html` 加第二个 tab（`body.live` 下、**bake 形态完全不含**）：
工位 SVG + 工单列 + 收件箱 + 黑板。这个 tab 走「有底板」而不是早报那侧的
无卡片化 widget——它是**工作面**，信息密度高、需要明确的区块分隔；两者的取舍依据不同。
`display: contents` 保证早报两栏的排版一个像素不动。

托盘菜单「🎫 工单看板」切到这个 tab（文案每次 build 现读 `orchState()`，不闭包缓存）。
菜单项在动态桌面关闭时 `enabled:false`——不开新窗口。

配置落 `~/.desktop-world/orch/`（`WORLD_ORCH_DIR` 可覆盖）。不跟 `outDir`：那是日报的产物目录，
而编排状态是长期状态，与 `live.json` / `techstack.json` / `study/` 同源。

## App 内集成

托盘菜单 →「📮 分享今日早报」「🧹 整理桌面文件」「🖥️ 动态桌面」「↔️ 解锁拖动」「🎫 工单看板」（`src/menu.js`，click 内懒 require `world/app-integration.js`）。「🌅 生成今日早报壁纸」菜单项已随 v0.6.4 取消壁纸一并移除；跑完整流水线请用 CLI `npm run world:daily`。

工单相关三个入口（`orchState()` / `showOrchBoard()` / `orchPreflight()`）都在 `world/app-integration.js`，
菜单每次 `buildTrayMenu` 现读状态，不闭包缓存布尔。`src/` 侧只碰 `menu.js` 的接线段。

## 已知取舍

- Codex 采集按"事件类型名含 call/tool 即计工具调用"的粗粒度策略，数字仅供趋势参考。
- 看板"进行中/已完成"按 45 分钟活跃窗口启发式判定，会随使用精化。
- 正在运行的会话（含触发生成动作的那个会话本身）也会进统计，属预期行为。
- 生长世界与桌宠的状态联动（桌宠形态随世界等级/tidy 出杂草）待 v0.6。
- 动态桌面窗口浮在桌面图标上方；图标下面的真·壁纸层 PoC 验证通过（`world/live/poc/`），
  Electron 映射（N-API / sidecar）待做；Windows WorkerW 时序笔记待补。
- 皮肤素材为程序化占位像素，生效需要 App 里手动切主题一次；AI 美术替换后升级为正式皮肤。
- 打包（electron-builder）时需确认 `world/`、`themes/sprout/` 未被 `files` 规则排除——发版前核对。
