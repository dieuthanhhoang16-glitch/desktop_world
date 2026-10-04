# Desktop World · 项目计划（fork 自 clawd-on-desk）

> 本文档是 Desktop World 分支的总纲。上游文档见 `AGENTS.md` / `docs/`；本文档只管 fork 后的差异化路线。

## 产品概念：会生长的桌面世界

桌面壁纸是一个随每日 AI agent 工作成果生长的小世界；桌宠是住在里面的园丁，实时反映 agent 状态；每天早上把"世界的样子 + 一句话总结"烘焙成壁纸，并可分享到社交媒体。

## 已确认决策

| 项 | 决策 | 备注 |
|---|---|---|
| 平台 | 跨平台（Electron） | 与上游一致 |
| 代码策略 | Fork clawd-on-desk | 协议 AGPL-3.0，下游必须开源 |
| 社交渠道 | 飞书 / 钉钉 / 企业微信机器人 | webhook 插件式接入 |
| MVP | 每日总结 + 壁纸展板 | ✅ v0.1 已完成（2026-10-05） |

## 架构：上游引擎不动，新功能全部在 world/

```
clawd 引擎（src/，不改动）          world/ 模块（fork 新增）
├ agent hooks / 状态机             ├ collector.js   采集 ~/.claude/projects
├ 像素桌宠 / 主题系统              ├ summarizer.js  claude -p 一句话总结+新思路
├ 权限气泡 / 远程通知              ├ bake.js        HTML→截图→跨平台设壁纸
└ Dashboard / HUD                  ├ pipeline.js    每日流水线
                                   ├ cli.js / app-integration.js
                                   └ template/daily-card.html 早报模板
```

唯一接线点：`src/menu.js` 托盘菜单新增"🌅 生成今日早报壁纸"。

## 路线图

- **v0.1 ✅** Claude Code 采集 → 一句话总结+新思路 → 早报壁纸（CLI + 托盘入口 + 单测）
- **v0.2 ✅** 分享插件（2026-10-05）：企业微信（文字+图片 base64）/ 钉钉（加签+关键词+图片降级）/ 飞书（富文本，图片需自建应用 image_key 待评估）；配置 CLI + `npm run world:share` + 托盘「📮 分享今日早报」；本地 mock 冒烟通过（7.8MB→90KB 压缩、降级兜底均验证）
- **v0.3 ✅** 桌面文件整理（2026-10-05）：`world/tidy/` 纯 Node 管线（扫描→分类→计划→执行→撤销）；扩展名规则+文件名矫正+LLM 细分"其他"桶；申请-确认式（CLI y 确认 / App 系统对话框）；undo 一键还原、重名避让、1 小时新文件保护、只收顶层散文件；托盘「🧹 整理桌面文件」；单测覆盖 scan/classify/plan/apply/undo。皮肤联动（乱=杂草）留到 v0.4 生长世界
- **v0.4 ✅** 生长世界 + 桌宠皮肤定调 + 多 agent（2026-10-05）：
  - **生长世界**：`world/garden/` 持久化世界（world-state.json）——出勤+会话+工具结算 xp，6 阶段（种子→新芽→树苗→开花树→果林→空中花园）；景观带为**确定性**像素 SVG（scene.js 纯函数），同日重跑幂等；壁纸/分享文案都带世界状态。
  - **多 agent**：`collector-codex.js` 合并 `~/.codex/sessions`（宽进严出），`digest.agents` 分来源统计。
  - **皮肤定调**：`world/creature/` 生成内置主题 `themes/sprout`「芽芽 Sprout」——程序化 16-bit 像素，15 主状态+workingTiers+8+1 mini 状态，过官方 `validate-theme.js` 全绿。定位占位皮肤：让"世界园丁"先上任；AI 美术（$10–50 管线，见 art-style-research）替换 assets 即转正。
  - 美术方向（调研已完成，docs/art-style-research.md）：**主推 16-bit 像素风 APNG**（复用 Calico 同引擎路径，AI 生成管线最成熟，$10–50 + 3–5 天修帧）；备选扁平矢量 SVG+CSS（Cloudling 路线，"生长"可程序化生成）。低多边形 3D 留作二期；黏土/水墨/CRT 蒸汽波否决或降为限定皮肤。
  - 格式契约已核实：theme.json schemaVersion 1（约 15 主状态 + workingTiers + 8 mini 状态），追眼状态强制 SVG；脚手架 `scripts/create-theme.js` + 校验器可直接用。
  - 死胡同已标注：无可商用的成套 12 状态桌宠素材包；Codex 社区宠物素材多为 CC BY-NC 禁商用；官方主题（Hash Sage 等）版权全保留不可复用。
- **v0.5 ✅** 动态桌面 + 专案追踪（2026-10-05）：
  - **动态桌面**（`world/live/`）：透明无框、点击穿透的常驻 Electron 窗口，直接渲染早报模板（原生清晰度，无截图裁剪）；15 分钟热刷（同日轻刷只更新数据、不调 LLM、世界状态只读；跨零点自动升级完整流水线——世界结算+新一句话+重烘焙衬底壁纸）；菜单解锁拖动/锁定穿透；`~/.desktop-world/live.json` 记忆开关与位置，App 启动自动恢复。模板重构为 `render(R)` + `window.__worldRender` 热刷入口，烘焙注入路径不变。
  - **专案追踪**（`world/watch/`）：文件夹登记为专案（学习/工作/生活/开源/其他分类，cwd 最长前缀匹配、子目录可单独登记）；按天结算天数/连击/14 天柱图，同日幂等 + 「同日升级」（凌晨 0 会话先结算、当天开工仍补记）；日报卡片专案区+会话分类角标、分享文案「📌 今日专案」、统计 chips 出分类计数；无配置时全链路静默。
- **v0.6**（下一步候选）：桌宠形态随世界等级进化、tidy 联动（桌面乱 → 壁纸长杂草）、真·图标下方壁纸层调研（macOS 私有桌面 API / Windows WorkerW）、AI 美术管线出正式芽芽素材、其他 agent 采集（Gemini/Kimi 复用 codex 模式）。

## 开发备忘

- 新代码放 `world/`，CommonJS、只用 Node/Electron 内置能力（与上游约束一致）。
- `npm run world:daily` 是最小验证路径；单测 `node --test test/world-collector.test.js`。
- 更名/品牌化、icon、上游 rebase 策略均待后续定。
