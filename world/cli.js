// world/cli.js · desktop-world 每日流水线命令行入口（独立于桌宠主程序运行）。
//
// 用法：
//   npx electron world/cli.js                 # 采集 → 总结 → 世界结算 → 产出早报 PNG（绝不设系统壁纸）
//   npx electron world/cli.js --no-llm        # 跳过 claude 调用，用模板总结
//   npx electron world/cli.js --reuse         # 用最近一次报告直接重烘焙（调模板用）
//   npx electron world/cli.js --share         # 烘焙后顺手分享到全部已配置渠道
//   npx electron world/cli.js --share=wework,dingtalk  # 只发指定渠道
//   WORLD_OUT_DIR=/自定义/目录 npx electron world/cli.js
'use strict';

const path = require('path');
const { app } = require('electron');
const { runDaily } = require('./pipeline');

const args = process.argv.slice(2);
const OUT_DIR = process.env.WORLD_OUT_DIR || path.join(__dirname, 'out');

app.whenReady().then(async () => {
  try {
    const { report, pngPath } = await runDaily({
      outDir: OUT_DIR,
      noLlm: args.includes('--no-llm'),
      reuseReport: args.includes('--reuse'),
      onStep: (msg) => console.log(`[world] ${msg}`),
    });
    console.log(`[world] 完成 ✅  一句话：${report.oneline}`);

    const shareArg = args.find((a) => a === '--share' || a.startsWith('--share='));
    if (shareArg) {
      const targets =
        shareArg === '--share' ? null : shareArg.slice(8).split(',').map((s) => s.trim()).filter(Boolean);
      const { share } = require('./share');
      const res = await share({ report, imagePath: pngPath, targets, log: (m) => console.log(`[share] ${m}`) });
      for (const r of res.results) console.log(`[share] ${r.ok ? '✅' : '❌'} ${r.channel}: ${r.detail}`);
      if (res.hint) console.log(`[share] ${res.hint}`);
    }
    // app.exit 会截断外部子进程（osascript 等）之后的 stdout 缓冲，留一拍再退
    setTimeout(() => app.exit(0), 300);
  } catch (err) {
    console.error(`[world] 失败 ❌  ${err.stack || err.message}`);
    setTimeout(() => app.exit(1), 300);
  }
});
