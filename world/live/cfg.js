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
  // v0.6.1 起组件默认可交互（clickThrough:false）；点击穿透是菜单里的可选锁定。
  // state 字段（v0.6.6+）缺失时不在此补——归一交给 lifecycle.normalizePersistedState，
  // 避免 load/save 往返把推导值当用户意图物化进文件。
  const dflt = { enabled: false, clickThrough: false, refreshMin: 15, w: 980, h: 620, x: null, y: null };
  let cfg;
  try {
    cfg = { ...dflt, ...JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) };
  } catch {
    return { ...dflt };
  }
  // 一次性迁移：v0.5 时代默认存了 clickThrough:true，v0.6.1 起组件应是可互动的，刷掉
  if (cfg.clickThrough === true && !cfg.v61) {
    cfg = { ...cfg, clickThrough: false, v61: true };
    try {
      fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    } catch { /* 迁移失败不挡启动 */ }
  }
  return cfg;
}

function saveCfg(patch) {
  // v61 戳必须由 v0.6.1+ 的写路径自己盖：只靠 loadCfg 迁移分支盖的话，用户手动开穿透
  // （saveCfg({clickThrough:true})，文件里还没有戳）会被下一次 loadCfg 误判成 v0.5 遗产
  // 又给刷回 false——「锁定拖动」根本锁不住（真实用户可见的 bug，冒烟抓出来的）。
  const cfg = { ...loadCfg(), ...patch, v61: true };
  fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true });
  fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return cfg;
}

module.exports = { CFG_FILE, loadCfg, saveCfg };
