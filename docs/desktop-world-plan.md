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
  - **版式二修**：总结+灵感挪到右栏底部（看板在上总结钉底），会话卡片改用 LLM 产的 sessionBriefs「干了什么」做主标题（原首条输入降为副行）；修复看板列 `#boardBody` 未受 flex 约束溢压住总结区（DOM 级 scrollHeight 检查守门）；动态桌面首次启动自动开启一次。
  - **新皮肤「Girl 蓝双马尾」**（2026-10-05）：用户自制素材（8 段 AI 视频 + 1 张静态图）→ `world/creature/convert-girl.sh` 制备（ffmpeg 取中段 2s、lanczos 缩 200²、colorkey 去白底、二遍调色板 256 色压到 190–620KB/个）；15 主状态全映射（缺的状态用语义最近的动画顶档，如 waking=开心挥手、roam=idle），工作分级 敲键盘/三颗星星/搬砖，子代理分级 + 指挥棒，拖动=转星星，点击=挥手；miniMode 暂不支持（无 mini 素材）；官方校验器全绿零警告。
- **v0.6**（方向已定，读码清单见 [docs/v0.6-research.md](v0.6-research.md)）：真·图标下方壁纸层（mac 读 Plash、Windows 读 Lively，各取一招）；widget 面板化（短期看 Übersicht + Rainmeter 的 measure/meter 分层，把早报拆 tile）；芽芽 v2 素材（Shimeji-ee 的动作拆法 + Calico 实测分档：常驻 41 帧/反应 ~30/过场 ~20，单文件 ≤800KB，最近邻引擎已保）；另有桌宠形态随世界等级进化、tidy 联动长杂草、其他 agent 采集（Gemini/Kimi 复用 codex 模式）。
  - **mac 桌面层 PoC ✅（2026-10-05，adf604b0）**：`world/live/poc/` —— Plash 源码实读（官方闭源→fork 快照）+ Swift 最小复现，公开 API 复验窗口 layer == kCGDesktopWindowLevel（-2147483623）比图标层低 20 级；下一段 = Electron 映射评估（N-API 薄桥 setLevel/collectionBehavior vs Swift sidecar 宿主）。
  - **v0.6.1 动态桌面 widget 化（2026-10-05，用户定调）**：无卡片化（透明 widget 风、文字投影、body.live/body.bake 双形态，烘焙壁纸一像素不动）；**组件永不碰系统壁纸**（跨日流水线 setWallpaper:false，壁纸只留手动入口）；默认可交互可拖动（app-region，老配置 clickThrough:true 一次性迁移）；**桌宠入住景观**（girl APNG 进像素世界带，workingTiers 分级/深夜睡觉/引擎可 `setPetState` 覆盖）；右栏**随手记**（按天 notes.json 0600，仅本机不进烘焙）。
  - **v0.6.2 看板增强（2026-10-05，用户点菜）**：已完成列卡片**隐藏该条**（悬停「×」，按天存 dismissed.json，可「全部恢复」，不动原始会话记录；补采集层 `id` 透传做稳定键，无 id 退内容哈希）+ 列**全量滚动**（不再封顶 4 张，细滚动条）；日报新增**今日卡点/技术总结 tips**（LLM 增量产出 → report 字段 → `writeDayNotes` 落 `<outDir>/blockers|tips-YYYY-MM-DD.md`），动态桌面右栏双 chip **点击系统默认程序打开当日 md**（主进程白名单校验 kind+日期后才 shell.openPath）；烘焙形态不含新元素。37 条单测全绿。
  - **v0.6.3 番茄钟 × 任务（2026-10-06，用户点菜）**：左栏单行横条（统计之下景观之上），25+5 标准循环、开始/暂停/跳过；**主进程唯一时钟源**（存 endAt deadline + 幂等 tick，渲染层 1Hz 轮询 poll，重载/重启/睡眠不丢）；按天存 pomodoro.json（0600，30 天，sid/text 分开记账，跳过按已花时长记账不计满钟）。看板联动：可选关联进行中会话卡、🍅 时长角标、✓ 手动完成挪列。像素世界联动（抄 munder-difflin 设计不抄代码，「信息即动作」）：专注期角色头顶 🍅 任务名标签 + 任务类型→动作映射（research→thinking/整理→sweeping/搬运→carrying/会议→attention/余者→working 顶档），引擎 override 仍最高优先。IPC 六通道走 __worldPomo 最小桥；烘焙 PNG 零新元素；10 条 node:test 全绿。（后续打补丁：v0.6.3.1 位置守卫修"双屏下重启看不见组件"——pos.js 相交判可见性 + 坏坐标回退默认位；v0.6.3.2 横条 `.pomo` 补 `app-region:no-drag` 修"按钮点击被整页拖拽吃掉"——CGEvent 合成系统级点击端到端验证通过。）
  - **v0.6.4 取消壁纸设计（2026-10-06，用户要求"将跟壁纸相关的设计都取消掉"）**：用户发现壁纸被强制覆盖。全部写系统壁纸的代码路径连根拆除：`bake.js` 的 macOS osascript / Windows SystemParametersInfo / Linux gsettings 三分支与 `applyWallpaper/execFileP/setWallpaper` 参数整删（`bakeWallpaper`→`bakePng`，产物 `wallpaper-*.png`→`daily-*.png`）；托盘「🌅 生成今日早报壁纸」菜单项与 `app-integration.runDailyWallpaper` 整体删除；CLI 去掉 `--no-set`；live 跨日流水线去 setWallpaper 实参；share/send 文件名跟随。README 与模板注释全量清扫。今后 PNG 仅作 IM 分享底稿，系统壁纸交还系统/用户全部管理——macOS 无壁纸历史，被覆盖的壁纸需用户在系统设置里重选。
  - **v0.6.4.1 修任务选择器不弹（2026-10-06，用户报"能点但是不弹任务选择器"）**：根因是 `esc` 只声明在 render() 内部而 renderPomo 在 IIFE 顶层——点「▶ 开始」走选择器分支抛 `ReferenceError: esc is not defined`，选择器展开为空虚线。esc 提到 IIFE 顶层；顺带修选择器展开时左栏溢出压出窗口（worldband 改 flex-end + overflow，天空可压、地面保）；新增 test/world-live-template.test.js 结构守门（esc 不得声明在 render 内部、renderPomo 必须顶层可达）。隔离实例同源复现验证：点击后 10 个进行中会话选项 + 自由输入正确成形，栏位无遮挡无溢出。
  - **v0.6.5 定向学习 × 八股化 techTips（2026-10-06，用户点菜）**：技术总结从「被动总结」升级「用户定向」。新增 `world/techstack/`：`config.js`（`~/.desktop-world/techstack.json` 0600、`WORLD_TECHSTACK_FILE` 覆盖、关键词白名单去重封顶、同方向幂等覆盖）＋ `memory.js`（项目记忆聚合：watch 专案 + 近 7 天日报项目/标题/工具 + 历史 tips/blockers，纯读盘坏文件跳过）＋ `propose.js`（候选关键词：LLM 结合记忆出题 → 失败静默退确定性词典 25 条 LEXICON，4–8 条硬契约、方向过白名单打头）＋纯 Node CLI（`--list/--add/--remove`；不带 `--keywords` 的 `--add` 只出候选不落盘，agent 拿候选在对话里收敛——每次最多一问、选完重跑才写盘）。summarizer `buildPrompt(digest,{techstack})`：无目标时提示词与旧版逐字一致（全链静默），有目标时 techTips 走结构化考点 spec（topic/project/answer/hook/action，材料对不上跳过）；`normalizeTechTips` 字符串/对象混合归一封顶 4 条。writeDayNotes tips md 行段排版（旧字符串兼容）；动态桌面右栏新增「🎯 定向学习」区（contenteditable 方向输入 → `__worldTech` 桥 propose/add/list → 候选点选落盘，记忆与写盘全在主进程）；烘焙 PNG/分享文案不变。watch/config.loadWatch 加可选 file 参数（增量）。9 条 node:test 全绿 + CLI 真机冒烟（LLM 出题命中真实项目素材）+ widget 隔离实例端到端（输入→候选→点选→落盘 0600）。
  - **v0.6.6 三态生命周期（2026-10-08，用户报"桌面世界不能隐藏"）**：closed / hidden / open 三态显式化，`live.js` 的 `state()` 唯一真源（托盘/快捷键/渲染层 ui 全现读）。hide() 换形态不销毁：窗口缩成右上角 148×30 胶囊（🌱等级·🍅圈数·💡考点数），webContents/15 分钟 timer 全程保活（番茄钟继续跑、随手记在途保留），show() 精确还原收起前边界并复用 open() 的 macOS 位置守卫（漂移拉回）；真关闭只剩托盘「关闭动态桌面」`closeLive()`（窗口销毁 + enabled:false）。live.json 增 `state` 字段，自启 hidden→hidden（`show:false` 建窗直接胶囊登场，绝不先炸全尺寸）；旧文件无 state 按 enabled 推导归一、不写回物化。穿透锁全程保持（hide 态仍 `setIgnoreMouseEvents(cfg.clickThrough,{forward:true})`；锁定时胶囊穿透点不到是预期，title 有提示，唤回靠托盘/快捷键）。全局快捷键 Cmd(mac)/Ctrl+Shift+D：`shortcut` 字段可改（白名单预校验 + register 终裁），`isRegistered` 冲突预检 + 失败只 warn，绝不覆盖既有快捷键。窗口右上角控制组三钮（—/🔒↔️/⚙）+ 胶囊点击全走 `__worldLive` preload 桥（world:live:* IPC 限本窗 webContents）；烘焙 PNG 绝不含 pill/控制组（默认 hidden + body.bake `!important` 双保险）。纯逻辑拆 `world/live/lifecycle.js`（胶囊边界/持久态归一/位置守卫/加速器白名单，无 Electron 依赖）与 `live/cfg.js`（live.json 读写 0600，saveCfg 自盖 v61 戳）。冒烟抓回两个真 bug 并修：'closed' 事件异步晚到清掉重开窗口引用/timer（`const created = win` 身份守卫）、手动锁穿透被 v61 迁移刷回 false（saveCfg 自盖戳）。15 条 node:test 全绿 + 39 项冒烟（phase1 32 + phase2 7，macOS 26 隔离实例：收起保活/双路唤回位置逐像素一致/重启 hidden→hidden 首次可见即胶囊/closeLive 重开番茄钟从落盘恢复）+ audit:assets 0 errors；npm test 仅 3 条存量红（idle-visual/settings-recap，纯基线 79b8cd5f 复现同红，与本改动无关）。
  - **v0.6.6.1 取消幽灵模式（2026-10-08，用户真机受困后定调"取消幽灵模式"）**：「锁定动态桌面（点击穿透）」整体退役。两代事故：v0.6.5 迁移把手动锁无声刷没（v0.6.6 已修）；修好后用户又真机受困——锁定后整窗穿透，连窗口内解锁钮自己都点不到，唯一出口是托盘里一项名字听着像「解锁位置」的菜单。窗口从此永远可交互：托盘锁项与控制组 🔒/↔️ 钮整删，`live.js` 的 `toggleClickThrough/isLiveClickable` 与 `world:live:click-through` IPC、`__worldLive.toggleClickThrough` 桥、`setIgnoreMouseEvents` 调用点全拔；`cfg.js` 双保险——历史 `clickThrough:true` 读取归零（不写回物化）+ `saveCfg` 写盘强制 false（补丁注入也堵死）。15 条 node:test 同步改写全绿（旧锁类断言改为「归零/不可复活」断言，模板守门加「不得再有锁钮与穿透文案」）。用户现场配置已手工翻回 `clickThrough:false` 救急。
## 开发备忘

- 新代码放 `world/`，CommonJS、只用 Node/Electron 内置能力（与上游约束一致）。
- `npm run world:daily` 是最小验证路径；单测 `node --test test/world-collector.test.js`。
- 更名/品牌化、icon、上游 rebase 策略均待后续定。
