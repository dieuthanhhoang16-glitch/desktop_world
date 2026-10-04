// world/share/send.js · 分享命令行入口（Electron）。
//
// 用法：
//   npx electron world/share/send.js                    # 分享最近一份日报到全部已配置渠道（带图）
//   npx electron world/share/send.js --to wework,feishu # 指定渠道
//   npx electron world/share/send.js --no-image         # 只发文字
//   WORLD_OUT_DIR=... npx electron world/share/send.js
'use strict';

const path = require('path');
const { app } = require('electron');
const { loadLatestReport } = require('../pipeline');
const { share } = require('./index');

const args = process.argv.slice(2);
const OUT_DIR = process.env.WORLD_OUT_DIR || path.join(__dirname, '..', 'out');

app.whenReady().then(async () => {
  const exit = (code) => setTimeout(() => app.exit(code), 300);
  try {
    const report = loadLatestReport(OUT_DIR);
    if (!report) {
      console.error(`[share] 在 ${OUT_DIR} 找不到 daily-*.json，先跑一次 npm run world:daily`);
      return exit(1);
    }

    const toArg = args.find((a) => a.startsWith('--to='));
    const targets = toArg ? toArg.slice(5).split(',').map((s) => s.trim()).filter(Boolean) : null;
    const imagePath = args.includes('--no-image')
      ? null
      : path.join(OUT_DIR, `wallpaper-${report.meta.date}.png`);

    const { ok, results, hint } = await share({
      report,
      imagePath,
      targets,
      log: (m) => console.log(`[share] ${m}`),
    });
    for (const r of results) {
      console.log(`[share] ${r.ok ? '✅' : '❌'} ${r.channel}: ${r.detail}`);
    }
    if (hint) console.log(`[share] ${hint}`);
    exit(ok ? 0 : 1);
  } catch (err) {
    console.error(`[share] 失败 ❌ ${err.stack || err.message}`);
    exit(1);
  }
});
