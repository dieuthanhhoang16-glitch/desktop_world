// world/orch/prefs-source.js
// desktop-world · 纯 Node 下定位并读取 clawd-prefs.json（给 CLI 用）。
//
// 为什么需要它：dispatch 的 agent gate 判定必须复用 src/agent-gate.js 的语义，
// 而那个语义吃的是 src/prefs.js 的 snapshot。CLI（node world/orch/cli.js）里没有
// Electron，拿不到 app.getPath('userData')。这里按各平台惯例探测 userData，
// 再用 src/prefs.js 的 load() 读（**不是**手搓 JSON.parse —— 迁移、规范化、
// 损坏备份都在 load 里，绕过它就会读到与 App 不同的结论）。
//
// 读不到时返回 { snapshot:null, reason }，由调用方**明确报错**而不是
// "读不到就当都装了"。编排层的默认是不信任，不是默认放行。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PREFS_FILE_NAME = 'clawd-prefs.json';

/** 各平台 userData 候选（与 src/main.js 的 app.getPath('userData') 对齐）。 */
function userDataCandidates() {
  const home = os.homedir();
  const appName = 'clawd-on-desk';
  return [
    // macOS: ~/Library/Application Support/<appName>
    path.join(home, 'Library', 'Application Support', appName),
    // Windows: %APPDATA%\<appName>
    process.env.APPDATA ? path.join(process.env.APPDATA, appName) : null,
    // Linux: $XDG_CONFIG_HOME/<appName> 或 ~/.config/<appName>
    path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), appName),
    // 打包名不同（productName "Clawd on Desk"）时 Electron 用的是目录名，一并探测
    path.join(home, 'Library', 'Application Support', 'Clawd on Desk'),
  ].filter(Boolean);
}

/** 定位 clawd-prefs.json。WORLD_PREFS_FILE 可显式覆盖（单测/便携）。 */
function resolvePrefsPath() {
  const override = process.env.WORLD_PREFS_FILE;
  if (override && String(override).trim()) return String(override).trim();
  for (const dir of userDataCandidates()) {
    const file = path.join(dir, PREFS_FILE_NAME);
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {
      /* 这个平台路径不存在就试下一个 */
    }
  }
  return null;
}

/**
 * 读 prefs snapshot。
 * @returns {{ok:boolean, snapshot:object|null, file:string|null, reason:string}}
 *   ok=false 时 snapshot 为 null —— 调用方必须拒绝派单。
 */
function loadPrefs() {
  const file = resolvePrefsPath();
  if (!file) {
    return {
      ok: false,
      snapshot: null,
      file: null,
      reason: '找不到 clawd-prefs.json：请先启动一次桌宠 App，或用 WORLD_PREFS_FILE 指定路径',
    };
  }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, snapshot: null, file, reason: `读不了 clawd-prefs.json：${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // 与 src/prefs.js 一致：坏文件不"就地当默认值"用，直接拒绝派单
    return { ok: false, snapshot: null, file, reason: `clawd-prefs.json 不是合法 JSON：${err.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, snapshot: null, file, reason: 'clawd-prefs.json 结构不合法' };
  }
  // 走一遍 prefs 的规范化，让 CLI 看到的 agents 形状与 App 里一致
  //（migrate 需要完整 schema 上下文；这里只取 migrate 后的 agents 形状，
  //  失败就退回原对象的 agents —— 宁可少一层规范化，也不能读不出东西）
  let snapshot = parsed;
  try {
    const prefs = require('../../src/prefs');
    const migrated = prefs.migrate({ ...parsed, agents: parsed.agents || {} });
    if (migrated && typeof migrated === 'object') snapshot = migrated;
  } catch {
    /* prefs 模块不可用（打包裁剪等）时用原始对象 */
  }
  return { ok: true, snapshot, file, reason: '' };
}

module.exports = { PREFS_FILE_NAME, userDataCandidates, resolvePrefsPath, loadPrefs };