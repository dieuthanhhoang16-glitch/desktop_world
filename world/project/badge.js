// world/project/badge.js
// desktop-world · 动态桌面「未初始化」徽标的只读视图模型（纯 fs 模块，可单测）。
//
// 徽标语义（ticket 03）：缺标记的项目亮徽标，标记齐全就灭。
// 数据政策：
//   · 状态/missing 每次构建时**活评估**（markers.evaluate，仍只读不写盘）——
//     用户补齐标记后下一个刷新周期徽标自然消失，不必先跑一遍 CLI check；
//   · lastCheckedAt 只**读** manifest 展示（写 manifest 是 CLI check/add 的活，
//     桌面刷新路径绝不落盘）；
//   · 项目目录被搬走/删除时 gone=true，仍亮徽标（静默消失等于假装一切正常）。
'use strict';

const path = require('path');
const registry = require('./registry');
const markers = require('./markers');
const manifest = require('./manifest');

/**
 * 构建徽标视图。opts.root 指定 registry 根（CLI/测试注入；桌面走默认 PROJECT_DIR）。
 * 返回 { total, uninitialized: [{ path, name, status, missing, lastCheckedAt, gone }] }。
 * 任何单项目的异常都降级为 gone 徽标项，绝不让一个坏项目炸掉整块桌面刷新。
 */
function build(opts = {}) {
  const root = opts.root;
  const reg = registry.load(root);
  const uninitialized = [];
  for (const p of reg.projects) {
    const abs = path.resolve(p.path);
    let evaluation = null;
    let gone = false;
    try {
      evaluation = markers.evaluate(abs);
    } catch {
      gone = true; // 目录不存在/读不到：按全缺处理
    }
    const m = manifest.load(abs);
    const status = gone ? 'missing' : evaluation.status;
    if (status === 'initialized') continue;
    uninitialized.push({
      path: abs,
      name: path.basename(abs),
      status,
      missing: gone ? markers.MARKER_KEYS.slice() : evaluation.missing,
      lastCheckedAt: (m && m.lastCheckedAt) || null,
      gone,
    });
  }
  uninitialized.sort((a, b) => a.path.localeCompare(b.path));
  return { total: reg.projects.length, uninitialized };
}

module.exports = { build };
