// world/live/preload.js
// 动态桌面窗口的 preload（sandbox:true 下可用 contextBridge + ipcRenderer）。
// 暴露三个最小面：随手记读写、看板隐藏/恢复、打开当日随笔 md。其他通道一律不开。
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__worldNotes', {
  load: (date) => ipcRenderer.invoke('world:notes:load', date),
  save: (date, text) => ipcRenderer.invoke('world:notes:save', date, text),
});

contextBridge.exposeInMainWorld('__worldBoard', {
  hide: (date, sid) => ipcRenderer.invoke('world:board:hide', date, sid),
  unhideAll: (date) => ipcRenderer.invoke('world:board:unhide-all', date),
});

contextBridge.exposeInMainWorld('__worldOpen', {
  md: (kind, date) => ipcRenderer.invoke('world:open:md', kind, date),
});
