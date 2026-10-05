// world/live/preload.js
// 动态桌面窗口的 preload（sandbox:true 下可用 contextBridge + ipcRenderer）。
// 只暴露「随手记」的最小编辑面：读当日、写当日。其他任何文件/IaC 通道一律不开。
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__worldNotes', {
  load: (date) => ipcRenderer.invoke('world:notes:load', date),
  save: (date, text) => ipcRenderer.invoke('world:notes:save', date, text),
});
