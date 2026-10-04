// world/garden/scene.js
// desktop-world · 世界状态 → 像素风景 SVG（纯函数、确定性输出，无 I/O）。
// 画布：160x48 像素格，每格 2px，输出 320x96 的 SVG 字符串（crispEdges 保持像素感）。
// 同一份世界描述永远渲染出同一张图 —— 壁纸可以缓存、测试可以断言。
'use strict';

const CELL = 2;
const GW = 160; // 宽（格）
const GH = 48; // 高（格）
const GROUND_Y = 38; // 地表起始行

const SKY = ['#0b1026', '#131a3a', '#1b2452'];
const GRASS = ['#2f9e44', '#2b8a3e', '#277238', '#1f5c30'];
const DIRT = '#4a3521';
const TRUNK = '#7a4a21';
const LEAF = '#37b24d';
const LEAF_DARK = '#2f9e44';

// —— 确定性伪随机（FNV-1a 哈希 + mulberry32）——
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeRand(desc) {
  return mulberry32(hashStr(`dew:${desc.level}:${desc.daysActive}:${desc.streak}:${desc.xp}`));
}

// —— 基础绘图 ——
function rect(out, x, y, w, h, c, op) {
  out.push(`<rect x="${x * CELL}" y="${y * CELL}" width="${w * CELL}" height="${h * CELL}" fill="${c}"${op != null ? ` fill-opacity="${op}"` : ''}/>`);
}
// 按 0/1 矩阵盖像素章（'1'=c / 或每格给定字符到颜色映射表）。
function stamp(out, grid, x, y, c) {
  grid.forEach((row, dy) => {
    [...row].forEach((v, dx) => {
      if (v !== '0' && v !== '.') rect(out, x + dx, y + dy, 1, 1, typeof c === 'object' ? c[v] || c['1'] : c);
    });
  });
}

// —— 小物件像素章 ——
const MOON = ['01110', '11111', '11111', '11110', '01100'];
const STAR = ['1'];
const FLOWER = ['010', '111', '010'];
const TUFT = ['10101'];
const MUSHROOM = ['010', '111', '010'];

// —— 树（参数化）——
function tree(out, cx, baseY, size, opts = {}) {
  const trunkH = 2 + size * 2;
  for (let i = 0; i < trunkH; i++) rect(out, cx, baseY - 1 - i, 1 + (size >= 2 ? 1 : 0), 1, TRUNK);
  const cw = 4 + size * 2; // 树冠半宽
  const ch = 3 + size * 2; // 树冠高
  const cy = baseY - trunkH - ch;
  // 树冠用椭圆近似：逐行算半宽
  for (let row = 0; row < ch; row++) {
    const half = Math.max(1, Math.round(cw * Math.sqrt(1 - Math.pow((row - ch / 2 + 0.5) / (ch / 2), 2))));
    rect(out, cx + (size >= 2 ? 1 : 0) - half + 1, cy + row - 1, half * 2 - 1, 1, row < 1 ? LEAF_DARK : LEAF);
  }
  return { top: cy, canopyW: cw * 2, canopyTopY: cy, canopyH: ch, centerX: cx + (size >= 2 ? 1 : 0) };
}
function sprinkle(out, rand, x0, y0, w, h, n, colors) {
  for (let i = 0; i < n; i++) {
    const c = colors[Math.floor(rand() * colors.length)];
    rect(out, x0 + Math.floor(rand() * w), y0 + Math.floor(rand() * h), 1, 1, c);
  }
}

// —— 各阶段主景观 ——
function drawSeed(out, rand) {
  // 中央一个小土包 + 一颗待发芽的种子
  rect(out, 76, GROUND_Y - 1, 8, 1, '#5c4028');
  rect(out, 77, GROUND_Y - 2, 6, 1, '#5c4028');
  rect(out, 79, GROUND_Y - 3, 2, 1, '#e8c8a0'); // 种子
  rect(out, 80, GROUND_Y - 3, 1, 1, '#ffffff', 0.6);
}
function drawSprout(out, rand) {
  rect(out, 77, GROUND_Y - 1, 6, 1, '#5c4028');
  rect(out, 79, GROUND_Y - 4, 2, 3, LEAF); // 茎
  rect(out, 76, GROUND_Y - 6, 3, 2, LEAF); // 左叶
  rect(out, 81, GROUND_Y - 6, 3, 2, LEAF_DARK); // 右叶
  rect(out, 79, GROUND_Y - 5, 2, 1, LEAF);
}
function drawBloomCanopy(out, rand, can, colors) {
  const n = 4 + Math.floor(rand() * 4);
  for (let i = 0; i < n; i++) {
    const x = can.centerX - can.canopyW + Math.floor(rand() * can.canopyW * 2);
    const y = can.canopyTopY + Math.floor(rand() * can.canopyH);
    stamp(out, FLOWER, x - 1, y - 1, colors[Math.floor(rand() * colors.length)]);
  }
}

/**
 * @param {object} desc state.describe() 的结果：{level, stageKey, daysActive, streak, xp, ...}
 * @param {object} [opts] {seed?:string} 额外扰动种子（默认按状态确定性生成）
 * @returns {string} SVG 字符串
 */
function renderWorldSvg(desc, opts = {}) {
  const d = desc || { level: 0, stageKey: 'seed', daysActive: 0, streak: 0, xp: 0 };
  const out = [];
  const rand = makeRand(d);

  // 天空三段 + 星
  rect(out, 0, 0, GW, 14, SKY[0]);
  rect(out, 0, 14, GW, 14, SKY[1]);
  rect(out, 0, 28, GW, GROUND_Y - 28 + 2, SKY[2]);
  const stars = 14 + d.level * 6;
  for (let i = 0; i < stars; i++) {
    const op = 0.25 + Math.floor(rand() * 55) / 100;
    rect(out, Math.floor(rand() * GW), Math.floor(rand() * 26), 1, 1, '#ffffff', op.toFixed(2));
  }
  stamp(out, MOON, GW - 16, 4, '#f5f0d8');
  rect(out, GW - 13, 6, 1, 1, '#e0d9b8'); // 月斑

  // 地面：草皮 2 行 + 泥土
  rect(out, 0, GROUND_Y, GW, 1, GRASS[0]);
  rect(out, 0, GROUND_Y + 1, GW, 1, GRASS[1]);
  rect(out, 0, GROUND_Y + 2, GW, GH - GROUND_Y - 2, DIRT);
  for (let i = 0; i < 24; i++) {
    rect(out, Math.floor(rand() * GW), GROUND_Y + 2 + Math.floor(rand() * 7), 1, 1, rand() > 0.5 ? '#5c4028' : '#3c2a19');
  }

  // 零散植被：随耕种天数增多（cap 26），确定性散布
  const flora = Math.min(4 + d.daysActive, 26);
  for (let i = 0; i < flora; i++) {
    const x = Math.floor(rand() * (GW - 8)) + 4;
    const kind = rand();
    if (kind < 0.45) stamp(out, TUFT, x, GROUND_Y - 1, rand() > 0.5 ? '#51cf66' : '#40c057');
    else if (kind < 0.75) stamp(out, FLOWER, x, GROUND_Y - 3, ['#ffd43b', '#ff9ec6', '#ffa94d', '#a5d8ff'][Math.floor(rand() * 4)]);
    else stamp(out, MUSHROOM, x, GROUND_Y - 3, rand() > 0.5 ? '#ff8787' : '#e8c8a0');
  }

  // 萤火虫（新芽起）
  if (d.level >= 1) {
    const n = 2 + d.level * 2;
    for (let i = 0; i < n; i++) {
      rect(out, Math.floor(rand() * GW), 20 + Math.floor(rand() * 14), 1, 1, '#ffe066', 0.8);
    }
  }

  // 中央主景观（按阶段）
  const stage = d.stageKey || 'seed';
  if (stage === 'seed') {
    drawSeed(out, rand);
  } else if (stage === 'sprout') {
    drawSprout(out, rand);
  } else if (stage === 'sapling') {
    tree(out, 79, GROUND_Y, 1);
  } else if (stage === 'bloom') {
    const can = tree(out, 79, GROUND_Y, 2);
    drawBloomCanopy(out, rand, can, ['#ff9ec6', '#ffe3ec', '#fff0f6']);
  } else if (stage === 'grove') {
    drawBloomCanopy(out, rand, tree(out, 52, GROUND_Y, 1), ['#ffa94d']); // 果
    const can = tree(out, 79, GROUND_Y, 2);
    drawBloomCanopy(out, rand, can, ['#ffa94d', '#ffd8a8']);
    drawBloomCanopy(out, rand, tree(out, 106, GROUND_Y, 1), ['#ffa94d']);
  } else if (stage === 'wonder') {
    // 悬浮岛：草皮 + 土层 + 下垂根系 + 瀑布 + 岛上小树
    const ix = 68, iy = 14, iw = 26;
    rect(out, ix, iy, iw, 1, GRASS[0]);
    rect(out, ix, iy + 1, iw, 2, DIRT);
    rect(out, ix + 3, iy + 3, iw - 6, 1, '#5c4028');
    rect(out, ix + 6, iy + 4, iw - 12, 1, '#5c4028');
    rect(out, ix + 10, iy + 5, 6, 1, '#3c2a19');
    tree(out, ix + 6, iy, 1);
    drawBloomCanopy(out, rand, { centerX: ix + 17, canopyW: 3, canopyTopY: iy - 4, canopyH: 4 }, ['#ff9ec6']);
    // 瀑布（亮蓝断点）
    for (let y = iy + 2; y < GROUND_Y; y++) if (rand() > 0.35) rect(out, ix + 20, y, 1, 1, '#99e9f2', 0.9);
    // 地面保留小树 + 魔法闪光
    tree(out, 40, GROUND_Y, 1);
    tree(out, 120, GROUND_Y, 1);
    for (let i = 0; i < 8; i++) rect(out, Math.floor(rand() * GW), 8 + Math.floor(rand() * 24), 1, 1, ['#ffe066', '#a5d8ff', '#ff9ec6'][Math.floor(rand() * 3)], 0.85);
  }

  const title = `世界 Lv${d.level} ${d.stageName || ''}`.trim();
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GW * CELL} ${GH * CELL}" preserveAspectRatio="xMidYMid slice" shape-rendering="crispEdges" role="img" aria-label="${title}">`,
    `<title>${title}</title>`,
    ...out,
    '</svg>',
  ].join('');
}

module.exports = { renderWorldSvg, hashStr, mulberry32, GW, GH };
