// world/live/preview.js
// 开发者预览：npx electron world/live/preview.js
// 与 tray App 无关的独立进程，用来调动态桌面的窗口形态 / 模板热刷新。
// v0.6.1 起正式窗口默认可交互可拖动，预览与正式行为完全一致。
'use strict';

const path = require('path');
const os = require('os');
const { app } = require('electron');
const live = require('./live');

const OUT_DIR = process.env.WORLD_OUT_DIR || path.join(os.homedir(), '.desktop-world', 'out');

app.whenReady().then(async () => {
  await live.open(OUT_DIR);
  console.log('[preview] 动态桌面预览已开启（可交互可拖动）。关闭窗口即退出。');
  console.log('[preview] 数据目录：' + OUT_DIR);
});

app.on('window-all-closed', () => app.quit());
