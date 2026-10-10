// world/orch/roadmap.js
// desktop-world · roadmap.json 的读写与阶段授权（窗口协作的唯一事实源）。
//
// 这是**唯一**会读写 <orchDir>/roadmap.json 的模块。roadmap 回答三个问题：
//   ① 阶段与子任务怎么排（stages[].subtasks[]）
//   ② 哪个窗口是"当前唯一活跃窗口"（activeWindow 指针——同一时刻只许有一个）
//   ③ 阶段是否已被人工授权（authorized——老二推进到下一阶段前的硬闸门）
//
// 与工单账本的关系：只存 ORCH 工单 id 的**引用**（subtask.ticketIds），绝不复制
// 工单状态——聚合永远在裁定时现读（见 stage-lead），避免两份账本漂移。
//
// window 状态只存在 subtask.windowState 上（单一事实源），当前活跃窗口的状态
// 由 windowOf() 派生，不做冗余字段（同文件内的第二事实源也是第二事实源）。
'use strict';

const fs = require('fs');
const path = require('path');
const { roadmapFile } = require('./paths');
const protocol = require('./protocol');

const VERSION = 1;
const TICKET_ID_RE = /^ORCH-\d{3,}$/;

function emptyRoadmap() {
  return { version: VERSION, milestone: '', stages: [], activeWindow: null, updatedAt: null };
}

function sanitizeText(value, max = 200) {
  return String(value == null ? '' : value)
    .replace(/\r\n?|\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function sortStages(stages) {
  for (const s of stages) {
    s.subtasks.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }
  stages.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return stages;
}

function normalizeRoadmap(raw) {
  const out = emptyRoadmap();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  out.milestone = sanitizeText(raw.milestone);

  const seenStage = new Set();
  const stages = [];
  for (const rs of Array.isArray(raw.stages) ? raw.stages : []) {
    if (!rs || typeof rs !== 'object') continue;
    const id = sanitizeText(rs.id, 16);
    if (!id || seenStage.has(id)) continue;
    seenStage.add(id);
    const seenSub = new Set();
    const subtasks = [];
    for (const rt of Array.isArray(rs.subtasks) ? rs.subtasks : []) {
      if (!rt || typeof rt !== 'object') continue;
      const sid = sanitizeText(rt.id, 16);
      if (!sid || seenSub.has(sid)) continue;
      seenSub.add(sid);
      subtasks.push({
        id: sid,
        title: sanitizeText(rt.title),
        windowState: protocol.isWindowState(rt.windowState) ? rt.windowState : 'planning',
        ticketIds: Array.isArray(rt.ticketIds)
          ? [...new Set(rt.ticketIds.filter((t) => typeof t === 'string' && TICKET_ID_RE.test(t)))].sort()
          : [],
      });
    }
    stages.push({ id, title: sanitizeText(rs.title), authorized: rs.authorized === true, subtasks });
  }
  out.stages = sortStages(stages);

  // activeWindow 指针必须解析得到真实 stage+subtask，悬空指针归 null（不崩、不虚构）
  if (raw.activeWindow && typeof raw.activeWindow === 'object') {
    const p = { stageId: sanitizeText(raw.activeWindow.stageId, 16), subtaskId: sanitizeText(raw.activeWindow.subtaskId, 16) };
    const stage = out.stages.find((s) => s.id === p.stageId);
    if (stage && stage.subtasks.some((t) => t.id === p.subtaskId)) out.activeWindow = p;
  }
  out.updatedAt = typeof raw.updatedAt === 'string' ? sanitizeText(raw.updatedAt, 40) : null;
  return out;
}

/** 载入 roadmap（缺失/损坏/形状不对一律回空 roadmap，永不抛）。 */
function load(file = roadmapFile()) {
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return emptyRoadmap();
  }
  return normalizeRoadmap(obj);
}

/** 写盘：收形 + 排序 + mkdir + 0600（与 store.saveAll 同纪律）。 */
function saveAll(file = roadmapFile(), roadmap, opts = {}) {
  const normalized = normalizeRoadmap(roadmap);
  normalized.updatedAt = opts.updatedAt || new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(normalized, null, 2), { mode: 0o600 });
  return normalized;
}

function findStage(roadmap, stageId) {
  return (roadmap.stages || []).find((s) => s.id === stageId) || null;
}

function findSubtask(roadmap, stageId, subtaskId) {
  const stage = findStage(roadmap, stageId);
  if (!stage) return null;
  return stage.subtasks.find((t) => t.id === subtaskId) || null;
}

/** 解析活跃窗口指针 → {stage, subtask, state}；未设/悬空回 null。 */
function windowOf(roadmap) {
  if (!roadmap || !roadmap.activeWindow) return null;
  const stage = findStage(roadmap, roadmap.activeWindow.stageId);
  const subtask = stage && stage.subtasks.find((t) => t.id === roadmap.activeWindow.subtaskId);
  if (!stage || !subtask) return null;
  return {
    stageId: stage.id,
    stageTitle: stage.title,
    subtaskId: subtask.id,
    subtaskTitle: subtask.title,
    state: subtask.windowState,
    ticketIds: subtask.ticketIds.slice(),
  };
}

/** 全部子任务引用的工单 id（去重排序）——裁定时现读工单的输入。 */
function allTicketIds(roadmap) {
  const ids = new Set();
  for (const s of (roadmap && roadmap.stages) || []) {
    for (const t of s.subtasks || []) for (const id of t.ticketIds || []) ids.add(id);
  }
  return [...ids].sort();
}

/** 指定活跃窗口（同一时刻只能有一个；null 清空）。目标必须真实存在。 */
function setActiveWindow(file = roadmapFile(), stageId, subtaskId) {
  const roadmap = load(file);
  if (stageId == null) {
    roadmap.activeWindow = null;
    return saveAll(file, roadmap);
  }
  if (!findSubtask(roadmap, stageId, subtaskId)) {
    throw new Error(`找不到子任务：${stageId}.${subtaskId}`);
  }
  roadmap.activeWindow = { stageId, subtaskId };
  return saveAll(file, roadmap);
}

/**
 * 推进指定窗口的状态（过 protocol 迁移表；非法迁移抛错，与 store.setStatus 同纪律）。
 * 实际"能不能现在走"由 stage-lead 裁定——这里只管状态机合法。
 */
function setWindowState(file = roadmapFile(), stageId, subtaskId, state) {
  if (!protocol.isWindowState(state)) throw new Error(`非法窗口状态：${state}`);
  const roadmap = load(file);
  const subtask = findSubtask(roadmap, stageId, subtaskId);
  if (!subtask) throw new Error(`找不到子任务：${stageId}.${subtaskId}`);
  if (!protocol.canTransitionWindow(subtask.windowState, state)) {
    throw new Error(`非法窗口状态迁移：${subtask.windowState} → ${state}（${stageId}.${subtaskId}）`);
  }
  subtask.windowState = state;
  return saveAll(file, roadmap);
}

/** 阶段授权（人工关口）。返回授权后的 stage。 */
function authorizeStage(file = roadmapFile(), stageId) {
  const roadmap = load(file);
  const stage = findStage(roadmap, stageId);
  if (!stage) throw new Error(`找不到阶段：${stageId}`);
  stage.authorized = true;
  saveAll(file, roadmap);
  return stage;
}

function deauthorizeStage(file = roadmapFile(), stageId) {
  const roadmap = load(file);
  const stage = findStage(roadmap, stageId);
  if (!stage) throw new Error(`找不到阶段：${stageId}`);
  stage.authorized = false;
  saveAll(file, roadmap);
  return stage;
}

/**
 * 阶段授权门槛（纯函数，老二裁定用）。
 * @returns null（已授权）| problem（{code, reason, fix}）
 */
function requireAuthorization(roadmap, stageId) {
  const stage = findStage(roadmap, stageId);
  if (!stage) {
    return {
      code: 'stage-unknown',
      reason: `roadmap 里没有阶段 ${stageId}`,
      fix: `npm run world:orch -- roadmap 查看阶段表，或先补建阶段`,
    };
  }
  if (stage.authorized !== true) {
    return {
      code: 'stage-not-authorized',
      reason: `阶段 ${stageId} 尚未人工授权——跨阶段推进必须先过这道关`,
      fix: `npm run world:orch -- stage-authorize ${stageId}`,
    };
  }
  return null;
}

/** 把子任务关联到工单（白名单过滤；返回收形后的 ticketIds）。 */
function upsertSubtaskTickets(file = roadmapFile(), stageId, subtaskId, ticketIds = []) {
  const roadmap = load(file);
  const subtask = findSubtask(roadmap, stageId, subtaskId);
  if (!subtask) throw new Error(`找不到子任务：${stageId}.${subtaskId}`);
  const cleaned = [...new Set((Array.isArray(ticketIds) ? ticketIds : []).filter((t) => typeof t === 'string' && TICKET_ID_RE.test(t)))].sort();
  subtask.ticketIds = cleaned;
  saveAll(file, roadmap);
  return cleaned;
}

module.exports = {
  VERSION,
  emptyRoadmap,
  normalizeRoadmap,
  load,
  saveAll,
  findStage,
  findSubtask,
  windowOf,
  allTicketIds,
  setActiveWindow,
  setWindowState,
  authorizeStage,
  deauthorizeStage,
  requireAuthorization,
  upsertSubtaskTickets,
};
