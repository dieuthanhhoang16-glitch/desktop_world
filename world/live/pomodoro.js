// world/live/pomodoro.js
// desktop-world · 动态桌面番茄钟（纯模块，可单测，无 Electron 依赖）。
// 设计要点：
// - 主进程是唯一时钟源：状态里存的是"截止时刻"（endAt 时间戳）和暂停余量，
//   渲染层每秒来问一次剩余毫秒数，窗口重载/App 重启都不丢时间。
// - 标准节奏：25 分钟专注 + 5 分钟休息；专注结束自动进休息，休息结束回 idle（不强推下一番茄）。
// - 存储 <outDir>/pomodoro.json：按天归档（键 YYYY-MM-DD），0600，留最近 30 天。
//   当天结构：{ cycles 完成专注数, focusMs 当日累计专注毫秒, tasks 各任务累计毫秒, current 进行中的一段 }
// - 任务关联：可选。关联对象 = 看板会话卡（sid 复用 board.sidOf 的稳定键）或自由文本。
//   同一段番茄的时长只记一份账：自由文本键 text:<标题>，会话卡键 sid:<sid>。
'use strict';

const fs = require('fs');
const path = require('path');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FOCUS_MS = 25 * 60 * 1000;
const BREAK_MS = 5 * 60 * 1000;
const MAX_TASK_TITLE = 60;

function todayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function load(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

function saveAll(file, all) {
  const keys = Object.keys(all).sort();
  const keep = {};
  for (const k of keys.slice(-30)) keep[k] = all[k];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(keep, null, 2), { mode: 0o600 });
  return keep;
}

function dayOf(all, date) {
  return all[date] || { cycles: 0, focusMs: 0, tasks: {}, doneSids: [], current: null };
}

/** 任务引用规范化：{sid} 会话卡 / {text} 自由任务 / null 不关联。返回值含记账键。 */
function normTask(sel) {
  if (!sel || typeof sel !== 'object') return null;
  if (typeof sel.sid === 'string' && sel.sid) {
    return { kind: 'sid', sid: sel.sid.slice(0, 200), title: String(sel.title || '').slice(0, MAX_TASK_TITLE), key: `sid:${sel.sid}` };
  }
  if (typeof sel.text === 'string' && sel.text.trim()) {
    const t = sel.text.trim().slice(0, MAX_TASK_TITLE);
    return { kind: 'text', title: t, key: `text:${t}` };
  }
  return null;
}

/** 当前视图（给渲染层的快照）：阶段、剩余毫秒、任务、当日计数。now 默认取"现在"，测试可注入。 */
function view(all, date, now = Date.now()) {
  const day = dayOf(all, date);
  const cur = day.current;
  if (!cur) {
    return { phase: 'idle', remainMs: 0, totalMs: 0, task: null, cycles: day.cycles, focusMs: day.focusMs, tasks: day.tasks, doneSids: day.doneSids || [] };
  }
  if (cur.paused) {
    return { phase: `${cur.phase}-paused`, remainMs: cur.remainMs, totalMs: cur.totalMs, task: cur.task || null, cycles: day.cycles, focusMs: day.focusMs, tasks: day.tasks, doneSids: day.doneSids || [] };
  }
  return {
    phase: cur.phase,
    remainMs: Math.max(0, cur.endAt - now),
    totalMs: cur.totalMs,
    task: cur.task || null,
    cycles: day.cycles,
    focusMs: day.focusMs,
    tasks: day.tasks,
    doneSids: day.doneSids || [],
  };
}

/** 落地一段：专注段结算进 cycles/focusMs/tasks，休息段不结算。 */
function settle(day, cur, endedEarly) {
  const elapsed = cur.totalMs - (cur.paused ? cur.remainMs : cur.remainMs || 0);
  if (cur.phase === 'focus') {
    if (!endedEarly) day.cycles += 1; // 提前跳过不认作一个完整番茄，但时长照记
    const realMs = Math.max(0, endedEarly ? elapsed : cur.totalMs);
    day.focusMs += realMs;
    if (cur.task) day.tasks[cur.task.key] = (day.tasks[cur.task.key] || 0) + realMs;
  }
}

/**
 * 主时钟 tick：持续时间只在这里流转（当前段自然到期则推进下一阶段）。
 * 幂等——随便多久调一次都行（render 轮询、App 唤醒、深夜跨过都安全）。
 */
function tick(file, date, now = Date.now()) {
  if (!DATE_RE.test(date)) throw new Error(`非法日期键：${date}`);
  const all = load(file);
  const day = dayOf(all, date);
  let cur = day.current;
  let changed = false;
  while (cur && !cur.paused && now >= cur.endAt) {
    settle(day, { ...cur, remainMs: 0 }, false);
    changed = true;
    if (cur.phase === 'focus') {
      // 专注满钟 → 进休息
      cur = { phase: 'break', task: null, totalMs: BREAK_MS, endAt: cur.endAt + BREAK_MS, paused: false };
    } else {
      // 休息结束 → 回 idle（不自动开下一个番茄，开不开是人的决定）
      cur = null;
    }
    day.current = cur;
  }
  if (cur !== day.current) day.current = cur;
  if (changed) {
    if (day.current) all[date] = day;
    else all[date] = day.cycles || day.focusMs ? day : undefined;
    if (!all[date]) delete all[date];
    saveAll(file, all);
  }
  return view(load(file), date, now);
}

/** 开始一个番茄（可选关联任务 sel）。已有进行中段：直接挤掉重开（等价于旧段提前跳过）。 */
function start(file, date, sel, now = Date.now()) {
  if (!DATE_RE.test(date)) throw new Error(`非法日期键：${date}`);
  tick(file, date, now); // 先让自然到期的结算掉
  const all = load(file);
  const day = dayOf(all, date);
  if (day.current && !day.current.paused) settle(day, { ...day.current, remainMs: day.current.endAt - now }, true);
  else if (day.current) settle(day, day.current, true);
  day.current = { phase: 'focus', task: normTask(sel), totalMs: FOCUS_MS, endAt: now + FOCUS_MS, paused: false };
  all[date] = day;
  saveAll(file, all);
  return view(all, date, now);
}

function pause(file, date, now = Date.now()) {
  if (!DATE_RE.test(date)) throw new Error(`非法日期键：${date}`);
  tick(file, date, now);
  const all = load(file);
  const day = dayOf(all, date);
  const cur = day.current;
  if (!cur || cur.paused) return view(all, date, now);
  cur.paused = true;
  cur.remainMs = Math.max(0, cur.endAt - now);
  all[date] = day;
  saveAll(file, all);
  return view(all, date, now);
}

function resume(file, date, now = Date.now()) {
  if (!DATE_RE.test(date)) throw new Error(`非法日期键：${date}`);
  const all = load(file);
  const day = dayOf(all, date);
  const cur = day.current;
  if (cur && cur.paused) {
    cur.paused = false;
    cur.endAt = now + cur.remainMs;
    all[date] = day;
    saveAll(file, all);
  }
  return view(all, date, now);
}

/** 跳过当前段：专注→按已花时长结算并进休息（不算满钟番茄）；休息→直接结束。 */
function skip(file, date, now = Date.now()) {
  if (!DATE_RE.test(date)) throw new Error(`非法日期键：${date}`);
  tick(file, date, now);
  const all = load(file);
  const day = dayOf(all, date);
  const cur = day.current;
  if (!cur) return view(all, date, now);
  settle(day, cur.paused ? cur : { ...cur, remainMs: cur.endAt - now }, true);
  day.current = cur.phase === 'focus'
    ? { phase: 'break', task: null, totalMs: BREAK_MS, endAt: now + BREAK_MS, paused: false }
    : null;
  if (day.current) all[date] = day;
  else { all[date] = day; }
  saveAll(file, all);
  return view(all, date, now);
}

/** 手动完成任务：把会话卡标记为"已完成"（看板据此从进行中挪到已完成，幂等）。 */
function completeTask(file, date, sid, now = Date.now()) {
  if (!DATE_RE.test(date)) throw new Error(`非法日期键：${date}`);
  if (typeof sid !== 'string' || !sid || sid.length > 200) throw new Error(`非法会话键：${sid}`);
  const all = load(file);
  const day = dayOf(all, date);
  day.doneSids = day.doneSids || [];
  if (!day.doneSids.includes(sid)) day.doneSids.push(sid);
  all[date] = day;
  saveAll(file, all);
  return view(all, date, now);
}

/**
 * 任务类型 → 角色动作（munder-difflin 式设计："行为即状态"，按任务名关键词映射）。
 * 返回桌宠主题状态键；live.js 拿它当桌宠 override（引擎显式 override 仍最高优先）。
 * 映射意图：写东西敲键盘 / 构建搬砖 / 整理扫地 / 读资料想 / 看不出来就通用 working。
 */
function taskActionFor(task) {
  const t = String((task && task.title) || '').toLowerCase();
  if (!t) return 'working';
  // 只返回主题状态机里真实存在的键（girl：working/thinking/sweeping/attention/carrying），
  // 先特异后通用，全部落空回退通用"敲键盘" working。
  const rules = [
    [/整理|清理|归纳|收拾|clean|tidy|删除|归档|杂货/, 'sweeping'],
    [/搬|下载|移动|拷贝|迁移|同步|move|copy|download|sync/, 'carrying'],
    [/读|看|研究|调研|梳理|分析|设计|review|read|research|理解|学习/, 'thinking'],
    [/聊|沟通|会议|讨论|对齐|回复|chat|meeting/, 'attention'],
  ];
  for (const [re, action] of rules) if (re.test(t)) return action;
  return 'working'; // 写/构建/开发/其他：主题各自的通用工作动画
}

module.exports = { load, view, tick, start, pause, resume, skip, completeTask, todayKey, normTask, taskActionFor, FOCUS_MS, BREAK_MS };
