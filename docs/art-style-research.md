# 美术风格选型报告 ——「会生长的桌面世界」v0.4

调研日期：2026-10。结论先行：**主推 16-bit 像素风（APNG 逐状态帧动画） + 备选扁平矢量 SVG+CSS（Cloudling 路线）**。像素风素材生态与 AI 生成管线都最成熟；矢量风与引擎原生能力（眼球追踪要求 SVG、SMIL/CSS 动画）契合度最高。低多边形 3D→2D 留作二期质感升级；黏土、国风水墨、CRT 蒸汽波否决或降级为限定皮肤。

---

## 一、clawd-on-desk 主题包格式（fork 必读，全部经源码核实）

仓库：[rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk)，官方文档 [guide-theme-creation.md](https://github.com/rullerzhou-afk/clawd-on-desk/blob/main/docs/guides/guide-theme-creation.md)。

**目录结构**：一个主题 = 一个文件夹 `themes/<id>/`，内含 `theme.json` + `assets/`（+可选 `sounds/`）。用户主题安装到 userData 下（macOS `~/Library/Application Support/clawd-on-desk/themes/<id>/`）。脚手架 `node scripts/create-theme.js`，校验器 `node scripts/validate-theme.js`。保留 ID：clawd/calico/cloudling/hash-sage/whale-chan。

**theme.json 字段**（`schemaVersion: 1`）：
- 元数据：`name / author / version / description / license`（license 仅展示用）
- `viewBox`：SVG 逻辑画布（Clawd 用 `{-15,-25,45,45}`），所有素材共享比例；`layout`（contentBox/baselineY 等）微调可见体
- `states`：核心映射，状态→文件数组或 `{files, fallbackTo}`。**支持 SVG/GIF/APNG/WebP/PNG/JPG**；`eyeTracking.states` 列出的状态（要做光标追眼）**必须是 SVG** 且含 `#eyes-js / #body-js / #shadow-js`
- 主状态约 15 个：`idle, roam, yawning, dozing, collapsing, thinking, working, juggling, sweeping, error, attention, notification, carrying, sleeping, waking`，可覆盖产品的「12 种状态」需求
- 分层：`workingTiers`（1 会话 typing / 2 juggling / ≥3 building）、`jugglingTiers`（子代理分级）、`idleAnimations`（随机 idle 轮播，file+duration）、`reactions`（点击左/右、双击、可分左右拖拽）、`hitBoxes`、`timings`、`sounds`、`objectScale`、`customization.petTint`、`accessories` 挂点
- **Mini 模式**：`miniMode.supported=true` 须提交 8 状态：mini-idle/enter/enter-sleep/crabwalk/peek/alert/happy/sleep（另 2 个可选），见 [src/theme-schema.js](https://github.com/rullerzhou-afk/clawd-on-desk/blob/main/src/theme-schema.js)
- 安全：外部主题 SVG 会被消毒（禁 script/外链，保留 CSS 动画）

**内置主题=格式活例**：Clawd=像素 SVG（28 个文件）；Calico=**28 个 APNG**；Cloudling=SVG+CSS keyframe。官方可下载主题 [clawd-themes](https://github.com/rullerzhou-afk/clawd-themes)：Hash Sage=32 个 APNG（**美术版权全保留，禁复用**）、Whale-chan=animated WebP（CC BY-NC-SA）。源码本身 AGPL-3.0-only，fork 分发需遵守。

**Codex Pet 包格式与导入**（[codex-pet-adapter.js](https://github.com/rullerzhou-afk/clawd-on-desk/blob/main/src/codex-pet-adapter.js)）：
- zip 内 = `pet.json`（id/displayName/description/spritesheetPath/spriteVersionNumber）+ `spritesheet.png`（或 webp）
- v1 图集：1536×1872、8 列×9 行、单帧 192×208；行序固定：idle / running-right / running-left / waving / jumping / failed / waiting / running / review，每行逐帧时长是硬编码契约；v2：1536×2288、8×11 行（加 16 方向光标注视）
- 导入：设置→主题→「导入宠物 zip」，适配器自动把 atlas 每行生成 loop/once/static SVG 包装器，做透明像素校验，落成托管主题（ID 前缀 `codex-pet-`）
- 生态：[awesome-codex-pet](https://github.com/legeling/awesome-codex-pet)、[codexpet.xyz](https://codexpet.xyz)（1500+ 只）、[Petdex](https://github.com/crafter-station/petdex)（3995+ 只）。**死胡同：社区宠物素材几乎全是 CC BY-NC 4.0，商用 fork 不能直接取用，只能借格式。**

---

## 二、候选风格对比（6 个方向）

单人制作基准：12 状态 × 4~8 帧 ≈ 70–100 帧动画 + 一套景观素材。

**1. 像素风（16-bit，主推）** — 观感：怀旧、节奏明快、小尺寸高信息密度。代表作：[Rusty's Retirement](https://store.steampowered.com/app/2666510/Rustys_Retirement/)（桌面条带放置农场，与「会生长的桌面」概念几乎同构，Steam 好评如潮）、[Stardew Valley](https://www.stardewvalley.net/)。成本：Aseprite（$19.99）熟练工 2–4 周；不熟 1–2 月。素材：丰富且许可干净——[SuperRetroWorld 农场包（CC0）](https://gif-superretroworld.itch.io/farming-pack)（作物多生长阶段+农夫角色）、[Kenney Tiny Town（CC0）](https://kenney.nl/assets/tiny-town)、[Free RPG Farm 180+ 精灵（免费可商用）](https://freepixelart.itch.io/free-rpg-farm-agriculture-pixel-art-180-sprites)、付费 [Farming Crops & Growing Plants](https://itch.io/jam/gbcompo25/rate/3651041)（€2.49 商用免署名）。**死胡同提示：没有现成的「CC0/可商用 12 状态桌宠角色包」，角色必须自绘/约稿/AI。** 集成：每状态导出一个 APNG 即插 Calico 同款路径；Chromium 原生播 APNG/动画 WebP，零额外运行时。契合度：★★★★★——壁纸分层叠 tile、植物按生长阶段换帧、早报卡片烤成贴图文字，全部现成范式。

**2. 扁平矢量 / SVG+CSS（备选主推）** — 观感：圆润几何、Duolingo 式角色。代表作：Cloudling（仓库内置）、[Duolingo 角色体系](https://design.duolingo.com/)、[LottieFiles](https://lottiefiles.com/)。成本：Figma/Illustrator 画件 + 手写 keyframe，12 状态约 1–3 周，单人完全可控。素材：LottieFiles 免费素材多数要署名且部分限商用，需逐个核对；矢量风主要靠自绘。集成：Cloudling 已验证此路径；追眼状态本就要求 SVG；生长动画（藤蔓抽出、花苞绽放）可用 SMIL 程序化生成而非逐帧手绘，**这是它对「生长世界」的独有优势**。契合度：★★★★☆，无限缩放+体积小，但「手作温度」弱于像素。

**3. 低多边形 3D 渲 2D 帧** — 观感：Eevee 平面着色柔光质感，高级感强。代表作：Donkey Kong Country（[预渲染先河](https://en.wikipedia.org/wiki/Donkey_Kong_Country)）；工作流见 [Blender 低模教程](https://learn-blender.org/blog/blender-low-poly-tutorial)（正交相机+toon shader+逐角度渲 PNG 序列）。成本：建模+绑定是重头，角色 2–5 天、12 状态渲染修帧 2–4 周；单人可行但管线最重。素材：[Kenney 3D 系（CC0）](https://kenney.nl/assets) 可拼景观。集成：渲出帧→APNG/sprite atlas。契合度：★★★☆，景观效果好但迭代慢，**建议二期质感升级再启用**。

**4. 黏土 / 毛绒质感** — 观感：治愈捏塑感，园丁概念契合。代表作：[Kirby and the Rainbow Curse](https://en.wikipedia.org/wiki/Kirby_and_the_Rainbow_Curse)。成本：雕塑/程序材质最贵，12 状态 ≥1 个月；**itch.io/OpenGameArt 上无可用的成套黏土动画素材（死胡同）**，全部从零做。集成同 3。契合度：★★★（情绪价值高，成本不可控），v0.4 否决。

**5. 国风水墨** — 观感：差异化最强、文化辨识度。代表作：[Ōkami](https://en.wikipedia.org/wiki/%C5%8Ckami)；生态内的 [Hash Sage（国风像素）](https://github.com/rullerzhou-afk/clawd-themes) 说明官方也选了像素化国风而非纯水墨。成本：水墨动画近乎逐帧手绘或定制 shader，12 状态 ≥2 个月；无现成素材包。集成：只能走重 APNG 或自研滤镜。契合度：★★☆，早报卡片做成卷轴很妙，但整体 ROI 低，留作远期限定皮肤。

**6. 复古 CRT 蒸汽波** — 观感：扫描线+品青霓虹+VHS 噪点。代表作：[Hypnospace Outlaw](https://store.steampowered.com/app/844590/Hypnospace_Outlaw/)。成本：滤镜便宜（CSS/CRT 后期即可），角色仍需另画。素材少且调性与「有机生长的花园」天然冲突；受众窄。契合度：★☆，**否决**（如要保留可做成壁纸的 CRT 夜间模式彩蛋）。

---

## 三、AI 生成管线可行性

**最成熟路径恰好在本生态内**（Codex Pet 工具链，产出即 clawd 可导的 atlas）：
- [codex-cyber-pet](https://github.com/chenbaiji518-oss/codex-cyber-pet)：照片→9 动作+16 方向 v2 图集，含 atlas 校验/边距修复脚本，中文文档
- [codex-pet-gen](https://github.com/mergisi/codex-pet-gen)：CLI 把手绘/AI 的 192×208 帧打包成 atlas+预览 GIF
- [awesome-codex-pet](https://github.com/legeling/awesome-codex-pet)：AI 辅助创作教程集散地
- 通用图像管线：MJ/SD/Nano Banana 出角色概念图 → 固定 seed/参考图/LoRA 锁角色 → 逐状态逐帧生成 → rembg 去底 → 降采样+调色板收缩（Aseprite/Lospec）→ 拼 APNG/atlas

**已知坑**：① 帧间角色漂移（五官/配饰会变），必须锁 seed+强参考；② 帧时长受限——Codex atlas 每行时长是硬契约，AI 出动作节奏要先按契约规划；③ 像素化后线条脏，仍需 10–30% 人工修帧；④ 景观 tile 比角色好生成得多（无动画、可定调色板后批量出）；⑤ 商用注意：MJ 需付费档才能商用，SD 自托管输出相对安全，AI 生成图版权登记存在政策不确定性；⑥ **千万别直接搬社区 pet 包（CC BY-NC）**。

---

## 四、最终推荐与下一步

**Top 1：16-bit 像素风（APNG）**。理由：① 与「生长花园」概念同构的先例已验证市场（Rusty's Retirement 96% 好评）；② 景观素材 CC0 管够，v0.4 可零美术成本搭原型；③ AI 管线成熟且与 clawd 导入格式 1:1 对口；④ 每状态一 APNG 直接复用引擎能力，无渲染技术风险。四路成本——自绘：人均 2–4 周（时间成本为主）；素材包：景观 $0–10（角色无包可买）；约稿：12 状态成套 ¥3k–15k（米画师/自由画师，视精度）；AI：算力 $10–50 + 3–5 天清理修帧。
**下一步**：先用 Kenney/SuperRetroWorld CC0 素材 + AI 生成角色草稿跑通全链路 demo → 锁定调色板与角色设定 → 再用约稿或精修 AI 出新皮肤主题包（按 theme.json 逐状态交付 APNG）。

**Top 2：扁平矢量 SVG+CSS**。理由：乘以 Cloudling 验证过的原生路径，追眼/mini/反应全支持；「生长」程序化动画成本最低；文件小、任意缩放。成本——自绘 1–3 周或约稿 ¥5k–20k；AI 矢量管线弱（位图转矢量质量差），基本靠人工。下一步：复刻 Cloudling theme.json 结构，先交付 idle/thinking/working/sleeping 4 核心状态验证观感。

**明确降级**：低模 3D→2D（二期）、国风水墨（限定皮肤）、黏土与 CRT（否决）。

---

### 主要来源
- [clawd-on-desk 仓库](https://github.com/rullerzhou-afk/clawd-on-desk) ＋ [主题制作指南](https://github.com/rullerzhou-afk/clawd-on-desk/blob/main/docs/guides/guide-theme-creation.md) ＋ [codex-pet-adapter.js](https://github.com/rullerzhou-afk/clawd-on-desk/blob/main/src/codex-pet-adapter.js) ＋ [clawd-themes](https://github.com/rullerzhou-afk/clawd-themes)
- [Rusty's Retirement (Steam)](https://store.steampowered.com/app/2666510/Rustys_Retirement/) ＋ [BGR 报道](https://bgr.com/entertainment/ingenious-idle-game-puts-a-pixelated-farm-on-your-desktop/)
- [Kenney Assets（CC0）](https://kenney.nl/assets) ＋ [Tiny Town](https://kenney.nl/assets/tiny-town) ＋ [SuperRetroWorld Farming（CC0）](https://gif-superretroworld.itch.io/farming-pack)
- [codex-cyber-pet](https://github.com/chenbaiji518-oss/codex-cyber-pet) ＋ [codex-pet-gen](https://github.com/mergisi/codex-pet-gen) ＋ [awesome-codex-pet](https://github.com/legeling/awesome-codex-pet) ＋ [Petdex](https://github.com/crafter-station/petdex) ＋ [codexpet.xyz](https://codexpet.xyz) ＋ [OpenAI 社区宠物帖](https://community.openai.com/t/show-us-your-custom-codex-pet/1387591/24)
- [Blender 低模工作流](https://learn-blender.org/blog/blender-low-poly-tutorial) ＋ [Electron 中的 Lottie](https://dev.to/fazalshah/using-lottie-animations-in-electron-desktop-apps-3hpo) ＋ [Hypnospace Outlaw](https://store.steampowered.com/app/844590/Hypnospace_Outlaw/)
