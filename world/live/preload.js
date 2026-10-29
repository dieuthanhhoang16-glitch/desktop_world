// world/live/preload.js
// 动态桌面窗口的 preload（sandbox:true 下可用 contextBridge + ipcRenderer）。
// 暴露八个最小面：随手记读写、看板隐藏/恢复、打开当日随笔 md、番茄钟（渲染层只展示，
// 时钟与落盘全在主进程——poll 拉取 view，动作只发指令）、定向学习（出候选/落目标）、
// 学习卡片（列卡片 / 打开卡片 md）、三态生命周期（收起/展开/打开 Settings）、
// 编排写入口（确认/派发/收敛等工单动作——闸门与账本全在主进程 actions 层，这里只传话）。
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

// 学习卡片（v0.7）：渲染层只列卡片、点开某个文件；读写与索引全在主进程
contextBridge.exposeInMainWorld('__worldStudy', {
  list: () => ipcRenderer.invoke('world:study:list'),
  open: (file) => ipcRenderer.invoke('world:study:open', file),
  openIndex: () => ipcRenderer.invoke('world:study:open-index'),
});

// 三态生命周期（v0.6.6）：胶囊点击展开、右上角控制组（收起/打开 Settings）
// 都从这里过 invoke——渲染层不直接 require 主进程窗口能力
contextBridge.exposeInMainWorld('__worldLive', {
  hide: () => ipcRenderer.invoke('world:live:hide'),
  show: () => ipcRenderer.invoke('world:live:show'),
  ui: () => ipcRenderer.invoke('world:live:ui'),
  openSettings: () => ipcRenderer.invoke('world:live:open-settings'),
});

// 编排写入口（v0.7 M2/M3 + v1.0 窗口协作）：调度树上的工单动作 + 开单回路 +
// 五级窗口的回执提交/推进确认/roadmap 只读。所有方法返回裁定层错误协议
// {ok:true,...}|{ok:false, problems:[{code,reason,fix}]}，渲染层原样上墙。
// 阶段授权（R2 起按用户要求开桥）：authorize 传给主进程 stage-lead 非交互入口——
// UI 两步确认等同 CLI readline 的 y，判定与写盘仍只在 stage-lead。
contextBridge.exposeInMainWorld('__worldOrch', {
  transition: (id, action, payload) => ipcRenderer.invoke('world:orch:transition', id, action, payload),
  patch: (id, patch) => ipcRenderer.invoke('world:orch:patch', id, patch),
  remove: (id) => ipcRenderer.invoke('world:orch:remove', id),
  sessions: (ticketId) => ipcRenderer.invoke('world:orch:sessions', ticketId),
  plan: (goal, opts) => ipcRenderer.invoke('world:orch:plan', goal, opts),
  commitPlan: (tickets) => ipcRenderer.invoke('world:orch:commitPlan', tickets),
  agents: () => ipcRenderer.invoke('world:orch:agents'),
  submitReport: (payload) => ipcRenderer.invoke('world:orch:submitReport', payload),
  advanceWindow: (payload) => ipcRenderer.invoke('world:orch:advanceWindow', payload),
  roadmapRead: () => ipcRenderer.invoke('world:orch:roadmapRead'),
  // ---- R2 编排台 ----
  console: () => ipcRenderer.invoke('world:orch:console'),
  run: (id, opts) => ipcRenderer.invoke('world:orch:run', id, opts),
  runs: () => ipcRenderer.invoke('world:orch:runs'),
  steer: (runId, text) => ipcRenderer.invoke('world:orch:steer', runId, text),
  artifacts: (id) => ipcRenderer.invoke('world:orch:artifacts', id),
  reveal: (p) => ipcRenderer.invoke('world:orch:reveal', p),
  runLog: (runId, tail) => ipcRenderer.invoke('world:orch:runLog', runId, tail),
  noteOnBoard: (text) => ipcRenderer.invoke('world:orch:note', text),
  roadmapInit: (payload) => ipcRenderer.invoke('world:orch:roadmapInit', payload),
  roadmapLink: (payload) => ipcRenderer.invoke('world:orch:roadmapLink', payload),
  authorize: (payload) => ipcRenderer.invoke('world:orch:authorize', payload),
  reports: () => ipcRenderer.invoke('world:orch:reports'),
});

// 角色卡（R2）：角色 tab 的列表/保存——模板同构改写与 manifest 重建全在主进程 roles/cards
contextBridge.exposeInMainWorld('__worldRoles', {
  list: () => ipcRenderer.invoke('world:roles:list'),
  save: (p) => ipcRenderer.invoke('world:roles:save', p),
});

// 学习卡（R2）：learn tab 的列表/打开——learnRoot 围栏与 shell.openPath 全在主进程
contextBridge.exposeInMainWorld('__worldLearn', {
  list: () => ipcRenderer.invoke('world:learn:list'),
  open: (file) => ipcRenderer.invoke('world:learn:open', file),
});

// 维护 tab（v0.8）：项目徽标 / 如何学习 / 清理与配置审批 / 里程碑提示 / 指标。
// 渲染层只发项目路径、勾选与确认指令；注册校验、扫描、模型复核、归档与写盘全在主进程。
contextBridge.exposeInMainWorld('__worldMaintenance', {
  overview: () => ipcRenderer.invoke('world:maintenance:overview'),
  project: (projectPath) => ipcRenderer.invoke('world:maintenance:project', projectPath),
  plan: (projectPath) => ipcRenderer.invoke('world:maintenance:plan', projectPath),
  propose: (projectPath) => ipcRenderer.invoke('world:maintenance:propose', projectPath),
  decide: (projectPath, paths, selectAll) => ipcRenderer.invoke('world:maintenance:decide', projectPath, paths, selectAll),
  preview: (projectPath) => ipcRenderer.invoke('world:maintenance:preview', projectPath),
  execute: (projectPath) => ipcRenderer.invoke('world:maintenance:execute', projectPath),
  restore: (projectPath) => ipcRenderer.invoke('world:maintenance:restore', projectPath),
  configLoad: () => ipcRenderer.invoke('world:maintenance:config-load'),
  configPropose: () => ipcRenderer.invoke('world:maintenance:config-propose'),
  configDecide: (paths, selectAll) => ipcRenderer.invoke('world:maintenance:config-decide', paths, selectAll),
  configPreview: () => ipcRenderer.invoke('world:maintenance:config-preview'),
  configExecute: () => ipcRenderer.invoke('world:maintenance:config-execute'),
  configRestore: () => ipcRenderer.invoke('world:maintenance:config-restore'),
  ack: (key) => ipcRenderer.invoke('world:maintenance:ack', key),
});
