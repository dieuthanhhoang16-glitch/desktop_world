// world/bake.js
// desktop-world · 把"今日早报"渲染成壁纸 PNG，并跨平台设为桌面壁纸。
// 必须在 Electron 主进程里运行（依赖 BrowserWindow / screen）。
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { BrowserWindow, screen } = require('electron');

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

function execFileP(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} 失败：${err.message} ${stderr || ''}`));
      else resolve(stdout);
    });
  });
}

// 跨平台设置壁纸。返回实际执行方式说明（用于日志）。
async function applyWallpaper(pngPath) {
  switch (process.platform) {
    case 'darwin':
      await execFileP('osascript', [
        '-e',
        `tell application "System Events" to set picture of every desktop to (POSIX file ${JSON.stringify(
          pngPath
        )})`,
      ]);
      return 'macOS System Events';
    case 'win32': {
      const ps = [
        'Add-Type -TypeDefinition "using System;using System.Runtime.InteropServices;' +
          'public class W{[DllImport(\\"user32.dll\\",CharSet=CharSet.Auto)]' +
          'public static extern int SystemParametersInfo(int a,int b,string c,int d);}";',
        `[W]::SystemParametersInfo(20,0,${JSON.stringify(pngPath).replace(/"/g, "'")},3)`,
      ].join(' ');
      await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
      return 'Windows SystemParametersInfo';
    }
    case 'linux': {
      const uri = `file://${pngPath}`;
      await execFileP('gsettings', ['set', 'org.gnome.desktop.background', 'picture-uri', uri]);
      try {
        await execFileP('gsettings', ['set', 'org.gnome.desktop.background', 'picture-uri-dark', uri]);
      } catch {
        /* 老版 GNOME 没有 dark 键 */
      }
      return 'GNOME gsettings（KDE 等请手动设置）';
    }
    default:
      throw new Error(`暂不支持的平台：${process.platform}`);
  }
}

/**
 * 烘焙每日壁纸。
 * @param {object} opts
 * @param {object} opts.report  {meta, digest, oneline, ideas, source}
 * @param {string} opts.outDir  输出目录
 * @param {boolean} [opts.setWallpaper=true] 是否设为桌面壁纸（false 则只产 PNG）
 * @returns {Promise<string>} PNG 文件路径
 */
async function bakeWallpaper({ report, outDir, setWallpaper = true }) {
  fs.mkdirSync(outDir, { recursive: true });
  const disp = screen.getPrimaryDisplay();
  const scale = disp.scaleFactor || 1;
  const width = Math.round(disp.size.width * scale);
  const height = Math.round(disp.size.height * scale);

  const renderFile = path.join(outDir, '.daily-card.render.html');
  renderTemplate(report, renderFile);
  const png = await capturePng(renderFile, width, height);

  const date = (report.meta && report.meta.date) || new Date().toISOString().slice(0, 10);
  const pngPath = path.join(outDir, `wallpaper-${date}.png`);
  fs.writeFileSync(pngPath, png);

  if (setWallpaper) {
    const via = await applyWallpaper(pngPath);
    console.log(`[world] 壁纸已设置（${via}）：${pngPath}`);
  }
  return pngPath;
}

module.exports = { bakeWallpaper };
