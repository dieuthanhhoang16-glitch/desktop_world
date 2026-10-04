# world/ — Desktop World 每日早报模块（v0.4）

> 本项目 fork 自 clawd-on-desk（AGPL-3.0）。本目录是 fork 后的差异化模块，
> 与上游 `src/` 引擎保持解耦：只新增、不改动（唯一接线点见下方「App 内集成」）。

## 功能

每天把本机 AI 助手（Claude Code + Codex）的活动汇总成**一句话总结 + 3 条新思路 + 任务看板**，
再结算进一个**跨天生长的像素小世界**，渲染成一张"今日早报"壁纸并设为桌面壁纸。

数据全程不出本机：采集只读 `~/.claude/projects/*.jsonl` 与 `~/.codex/sessions/**/*.jsonl` 转录；
总结走本机 `claude -p` 无头模式（复用本机登录，无需 API key）。

## 用法

```bash
npm run world:daily          # 采集 → 总结 → 生成并设置壁纸
npx electron world/cli.js --no-set   # 只产出 PNG，不动壁纸（调试）
npx electron world/cli.js --no-llm   # 跳过 LLM，用模板兜底总结
npx electron world/cli.js --reuse    # 用最近一次报告重烘焙（调模板样式用）
npx electron world/cli.js --share    # 烘焙后顺手分享到全部已配置渠道
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

壁纸左下角是一条**跨天持久的像素景观带**：每天第一次烘焙把当日成果结算成 xp，
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
产物：`daily-YYYY-MM-DD.json`（报告）、`wallpaper-YYYY-MM-DD.png`（壁纸）。

环境变量：
- `WORLD_OUT_DIR` — 自定义输出目录
- `WORLD_NO_LLM=1` — 全局禁用 LLM，等价 `--no-llm`
- `CLAUDE_BIN` — claude CLI 路径（默认 `claude`）
- `CLAUDE_PROJECTS_DIR` — Claude 转录目录（默认 `~/.claude/projects`）
- `CODEX_SESSIONS_DIR` — Codex 转录目录（默认 `~/.codex/sessions`）

## 模块

| 文件 | 职责 |
|---|---|
| `collector.js` | 采集当日会话 → digest（项目/标题/时长/工具分布/活跃直方图/看板状态） |
| `summarizer.js` | digest → `{oneline, ideas[3]}`（`claude -p`，失败降级模板） |
| `template/daily-card.html` | 早报卡片模板（数据经 `window.__REPORT__` 注入） |
| `bake.js` | 隐藏窗口渲染 → `capturePage` → PNG → 设壁纸（macOS/Windows/Linux） |
| `pipeline.js` | 串联 collect → summarize → 世界结算 → 落盘 → bake，CLI 与 App 共用 |
| `cli.js` | 独立 Electron 命令行入口 |
| `app-integration.js` | 桌宠 App 内入口（托盘菜单调用、系统通知反馈、防抖） |
| `collector-codex.js` | Codex 会话采集（宽进严出解析，可 `options.codex:false` 关闭） |
| `garden/` | 生长世界：`state.js`（持久状态/结算/阶段表）、`scene.js`（确定性像素 SVG）、`index.js`（门面） |
| `creature/` | 桌宠皮肤「芽芽」：`sprites.js`（23 状态像素精灵库）、`generate.js`（themes/sprout 生成器） |

## App 内集成

托盘 & 右键菜单 → "🌅 生成今日早报壁纸"（`src/menu.js`，一处新增代码块即全部接线）。

## 已知取舍

- Codex 采集按"事件类型名含 call/tool 即计工具调用"的粗粒度策略，数字仅供趋势参考。
- 看板"进行中/已完成"按 45 分钟活跃窗口启发式判定，会随使用精化。
- 正在运行的会话（含触发生成动作的那个会话本身）也会进统计，属预期行为。
- 生长世界 v0.4 只长在壁纸上；与桌宠的状态联动（桌宠形态随世界等级/tidy 出杂草）待 v0.5。
- 皮肤素材为程序化占位像素，生效需要 App 里手动切主题一次；AI 美术替换后升级为正式皮肤。
- 设壁纸的 Linux 分支只覆盖 GNOME（gsettings）；KDE 等需后续补。
- 打包（electron-builder）时需确认 `world/`、`themes/sprout/` 未被 `files` 规则排除——发版前核对。
- macOS 首次设置壁纸会弹「自动化/System Events」授权框，授权一次即可。
