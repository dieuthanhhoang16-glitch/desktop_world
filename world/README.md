# world/ — Desktop World 每日早报模块（v0.1）

> 本项目 fork 自 clawd-on-desk（AGPL-3.0）。本目录是 fork 后的差异化模块，
> 与上游 `src/` 引擎保持解耦：只新增、不改动（唯一接线点见下方「App 内集成」）。

## 功能

每天把本机 Claude Code 的活动汇总成**一句话总结 + 3 条新思路 + 任务看板**，
渲染成一张"今日早报"壁纸并设为桌面壁纸。

数据全程不出本机：采集只读 `~/.claude/projects/*.jsonl` 转录；
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
- `CLAUDE_PROJECTS_DIR` — 转录目录（默认 `~/.claude/projects`）

## 模块

| 文件 | 职责 |
|---|---|
| `collector.js` | 采集当日会话 → digest（项目/标题/时长/工具分布/活跃直方图/看板状态） |
| `summarizer.js` | digest → `{oneline, ideas[3]}`（`claude -p`，失败降级模板） |
| `template/daily-card.html` | 早报卡片模板（数据经 `window.__REPORT__` 注入） |
| `bake.js` | 隐藏窗口渲染 → `capturePage` → PNG → 设壁纸（macOS/Windows/Linux） |
| `pipeline.js` | 串联 collect → summarize → 落盘 → bake，CLI 与 App 共用 |
| `cli.js` | 独立 Electron 命令行入口 |
| `app-integration.js` | 桌宠 App 内入口（托盘菜单调用、系统通知反馈、防抖） |

## App 内集成

托盘 & 右键菜单 → "🌅 生成今日早报壁纸"（`src/menu.js`，一处新增代码块即全部接线）。

## 已知取舍（v0.1）

- 只采集 Claude Code；Codex 等其它 agent 待 v0.2+ 复用上游 hooks。
- 看板"进行中/已完成"按 45 分钟活跃窗口启发式判定，会随使用精化。
- 正在运行的会话（含触发生成动作的那个会话本身）也会进统计，属预期行为。
- 设壁纸的 Linux 分支只覆盖 GNOME（gsettings）；KDE 等需后续补。
- 打包（electron-builder）时需确认 `world/` 未被 `files` 规则排除——发版前核对。
- macOS 首次设置壁纸会弹「自动化/System Events」授权框，授权一次即可。
