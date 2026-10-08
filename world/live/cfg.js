// world/live/cfg.js
// 动态桌面配置（~/.desktop-world/live.json，0600）的读写。
// 从 live.js 拆出成无 Electron 依赖的纯 fs 模块：旧 live.json 无 state 字段的
// 兼容读取、0600 权限都能直接 node:test（见 test/world-live-lifecycle.test.js）。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CFG_FILE = process.env.WORLD_LIVE_FILE || path.join(os.homedir(), '.desktop-world', 'live.json');

function loadCfg() {
  // v0.6.6.1 起「幽灵模式（点击穿透锁定）」整体取消：窗口永远可交互。旧配置里残留的
  // clickThrough:true 一律在读取时归一为 false（不写回物化，只让运行态看到干净值）。
  // state 字段（v0.6.6+）缺失时不在此补——归一交给 lifecycle.normalizePersistedState，
  // 避免 load/save 往返把推导值当用户意图物化进文件。
  const dflt = { enabled: false, clickThrough: false, refreshMin: 15, w: 980, h: 620, x: null, y: null };
  let cfg;
  try {
    cfg = { ...dflt, ...JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) };
  } catch {
    return { ...dflt };
  }
  if (cfg.clickThrough) cfg.clickThrough = false; // 幽灵模式取消：历史 true 一律归零
  return cfg;
}

function saveCfg(patch) {
  // clickThrough 由补丁注入的路径也要堵死：任何写盘都强制 false，幽灵模式无法借尸还魂。
  // v61 戳保留（只表示文件出自 v0.6.1+ 的写路径），其原迁移职责已随幽灵模式一起退役。
  const cfg = { ...loadCfg(), ...patch, clickThrough: false, v61: true };
  fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true });
  fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return cfg;
}

module.exports = { CFG_FILE, loadCfg, saveCfg };
