// world/bake.js
// desktop-world · 把"今日早报"渲染成 PNG（IM 分享底稿）。
// v0.6.4 起：绝不设置系统桌面壁纸——写系统壁纸的代码路径已整体移除
// （macOS osascript / Windows SystemParametersInfo / Linux gsettings 全部删除）。
// 必须在 Electron 主进程里运行（依赖 BrowserWindow / screen）。
'use strict';

const fs = require('fs');
const path = require('path');
const { BrowserWindow, screen } = require('electron');
const { withSvg } = require('./garden');

const TEMPLATE = path.join(__dirname, 'template', 'daily-card.html');

// 把数据注入模板（转义 < 防止 </script> 截断），落到 outDir 里的临时渲染文件。
function renderTemplate(report, outFile) {
  const tpl = fs.readFileSync(TEMPLATE, 'utf8');
  const payload = JSON.stringify(report).replace(/</g, '\\u003c');
  const injected = tpl.replace(
    '</head>',
    `<script>window.__REPORT__=${payload};</script>\n</head>`
  );
  fs.writeFileSync(outFile, injected);
}

async function capturePng(htmlFile, width, height) {
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    frame: false,
    webPreferences: { sandbox: true },
  });
  try {
    await win.loadFile(htmlFile);
    // 等布局与字体稳定；模板无网络资源，600ms 足够
    await new Promise((r) => setTimeout(r, 600));
    const img = await win.webContents.capturePage();
    return img.toPNG();
  } finally {
    win.destroy();
  }
}

/**
 * 烘焙每日早报 PNG。
 * @param {object} opts
 * @param {object} opts.report  {meta, digest, oneline, ideas, source}
 * @param {string} opts.outDir  输出目录
 * @returns {Promise<string>} PNG 文件路径
 */
async function bakePng({ report, outDir }) {
  fs.mkdirSync(outDir, { recursive: true });
  // 生长世界：烘焙时才把世界描述渲染成像素 SVG（svg 不进落盘的报告 JSON）
  if (report.world && !report.world.svg) report.world = withSvg(report.world);
  const disp = screen.getPrimaryDisplay();
  const scale = disp.scaleFactor || 1;
  const width = Math.round(disp.size.width * scale);
  const height = Math.round(disp.size.height * scale);

  const renderFile = path.join(outDir, '.daily-card.render.html');
  renderTemplate(report, renderFile);
  const png = await capturePng(renderFile, width, height);

  const date = (report.meta && report.meta.date) || new Date().toISOString().slice(0, 10);
  const pngPath = path.join(outDir, `daily-${date}.png`);
  fs.writeFileSync(pngPath, png);
  console.log(`[world] 早报 PNG 已生成（不设壁纸）：${pngPath}`);
  return pngPath;
}

module.exports = { bakePng };
