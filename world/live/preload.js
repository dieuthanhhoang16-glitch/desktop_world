// world/live/preload.js
// 动态桌面窗口的 preload（sandbox:true 下可用 contextBridge + ipcRenderer）。
// 暴露六个最小面：随手记读写、看板隐藏/恢复、打开当日随笔 md、番茄钟（渲染层只展示，
// 时钟与落盘全在主进程——poll 拉取 view，动作只发指令）、定向学习（出候选/落目标）、
// 三态生命周期（收起/展开/穿透锁/打开 Settings）。
// 其他通道一律不开。
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

contextBridge.exposeInMainWorld('__worldPomo', {
  poll: (date) => ipcRenderer.invoke('world:pomo:poll', date), // tick + 返回视图快照（1Hz 轮询）
  start: (date, task) => ipcRenderer.invoke('world:pomo:start', date, task), // task: {sid,title}|{text}|null
  pause: (date) => ipcRenderer.invoke('world:pomo:pause', date),
  resume: (date) => ipcRenderer.invoke('world:pomo:resume', date),
  skip: (date) => ipcRenderer.invoke('world:pomo:skip', date),
  completeTask: (date, sid) => ipcRenderer.invoke('world:pomo:complete-task', date, sid),
});

// 定向学习（v0.6.5）：渲染层只发"模糊方向 / 选中的关键词"，记忆聚合与写盘全在主进程
contextBridge.exposeInMainWorld('__worldTech', {
  list: () => ipcRenderer.invoke('world:tech:list'),
  propose: (direction) => ipcRenderer.invoke('world:tech:propose', direction),
  add: (direction, keywords) => ipcRenderer.invoke('world:tech:add', direction, keywords),
});


// 三态生命周期（v0.6.6）：胶囊点击展开、右上角控制组（收起/穿透锁/打开 Settings）
// 都从这里过 invoke——渲染层不直接 require 主进程窗口能力
contextBridge.exposeInMainWorld('__worldLive', {
  hide: () => ipcRenderer.invoke('world:live:hide'),
  show: () => ipcRenderer.invoke('world:live:show'),
  ui: () => ipcRenderer.invoke('world:live:ui'),
  toggleClickThrough: () => ipcRenderer.invoke('world:live:click-through'),
  openSettings: () => ipcRenderer.invoke('world:live:open-settings'),
});
