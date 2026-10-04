// world/creature/sprites.js
// desktop-world · 桌宠"芽芽 Sprout"像素精灵库（纯函数 → SVG 字符串）。
// 定位：v0.4 占位皮肤 —— 用程序化 16-bit 像素风把 23 个状态全部铺满，
// 让"世界园丁"今天就能上桌；后续换成 AI 出图管线（见 docs/art-style-research.md）时
// 只需替换 assets 目录，theme.json 与生成器结构不变。
'use strict';

// 调色板：晨露系（与早报壁纸的夜色景观互补）
const P = {
  b: '#8ce078', // 身体主色（嫩绿团子）
  d: '#5cb85c', // 身体阴影
  l: '#37b24d', // 芽叶
  e: '#1b2537', // 眼睛/深色
  w: '#ffffff', // 高光
  y: '#ffd43b', // 暖黄（⚠️/✨）
  o: '#ffa94d', // 橙
  p: '#ff9ec6', // 粉
  u: '#74c0fc', // 蓝（汗滴/速度线）
  k: '#495057', // 器物深色
  t: '#8a5a2b', // 木色
  g: '#adb5bd', // 灰（尘土/气泡）
  c: '#f1f3f5', // 浅色器物
  m: '#c98a4b', // 包裹木箱
};

function r(out, x, y, w, h, c, op) {
  if (w <= 0 || h <= 0) return;
  out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}"${op != null ? ` fill-opacity="${op}"` : ''}/>`);
}
function stamp(out, grid, x, y, c) {
  grid.forEach((row, dy) => {
    [...row].forEach((v, dx) => {
      if (v !== '0' && v !== '.') r(out, x + dx, y + dy, 1, 1, c);
    });
  });
}

// —— 主角身体（16x16 里的 10x8 团子，头顶两片芽叶）——
function body(out, { eyes = 'open', lean = 0 } = {}) {
  const x0 = 3 + lean; // 身体左缘
  const rows = [[3, 10], [2, 12], [2, 12], [2, 12], [2, 12], [2, 12], [3, 10], [4, 8]];
  rows.forEach(([dx, w], i) => r(out, dx + lean, 6 + i, w, 1, P.b));
  // 右下阴影增加体积感
  r(out, x0 + 9, 7, 1, 5, P.d, 0.55);
  r(out, x0 + 3, 13, 6, 1, P.d, 0.55);
  // 芽叶
  stamp(out, ['11.', '.11'], x0 + 1, 3, P.l);
  stamp(out, ['.11', '11.'], x0 + 6, 3, P.l);
  r(out, x0 + 4, 5, 1, 1, P.l); // 茎尖
  // 眼睛（x 相对身体中心）
  const lx = x0 + 2, rx = x0 + 7;
  if (eyes === 'open') {
    r(out, lx, 8, 1, 2, P.e); r(out, rx, 8, 1, 2, P.e);
    r(out, lx, 8, 1, 1, P.w); r(out, rx, 8, 1, 1, P.w);
  } else if (eyes === 'closed') {
    r(out, lx, 9, 2, 1, P.e); r(out, rx, 9, 2, 1, P.e);
  } else if (eyes === 'happy') {
    stamp(out, ['11', '1.'], lx, 8, P.e); stamp(out, ['11', '.1'], rx, 8, P.e);
  } else if (eyes === 'worry') {
    r(out, lx, 8, 1, 2, P.e); r(out, rx, 8, 1, 2, P.e);
    stamp(out, ['1', '1'], lx, 10, P.p); stamp(out, ['1', '1'], rx + 1, 10, P.p); // 脸红
  }
}
function zzz(out, x, y, scale = 1) {
  // 一步斜向下的 Z
  r(out, x, y, 3 * scale, 1, P.c);
  r(out, x + 2 * scale, y + scale, scale, scale, P.c);
  r(out, x + scale, y + 2 * scale, scale, scale, P.c);
  r(out, x, y + 3 * scale, 3 * scale, 1, P.c);
}
const SPARK = ['.1.', '111', '.1.'];

// —— 主状态（16x16）：每格即 1px ——
const MAIN = {
  idle: (out) => body(out),
  roam: (out) => {
    body(out, { lean: 1 });
    r(out, 0, 10, 2, 1, P.u, 0.8); r(out, 1, 12, 2, 1, P.u, 0.6); // 速度线
  },
  yawning: (out) => {
    body(out, { eyes: 'closed' });
    r(out, 7, 10, 3, 2, P.e); r(out, 8, 12, 1, 1, P.e); // 打哈欠的嘴
    r(out, 12, 9, 1, 2, P.d); // 揉眼的小手
  },
  dozing: (out) => { body(out, { eyes: 'closed' }); zzz(out, 12, 2, 1); },
  collapsing: (out) => { body(out, { eyes: 'closed' }); zzz(out, 12, 2, 1); r(out, 2, 13, 1, 1, P.u, 0.7); r(out, 13, 12, 1, 1, P.u, 0.7); },
  thinking: (out) => {
    body(out);
    r(out, 12, 4, 1, 1, P.g); r(out, 13, 2, 2, 1, P.g); r(out, 13, 1, 1, 1, P.g); // 思考气泡
  },
  working: (out) => {
    body(out);
    r(out, 3, 14, 10, 1, P.k); r(out, 4, 13, 8, 1, P.k); // 键盘
    r(out, 3, 11, 1, 2, P.d); r(out, 12, 11, 1, 2, P.d); // 前伸的手
  },
  juggling: (out) => {
    body(out, { eyes: 'happy' });
    r(out, 3, 4, 1, 2, P.d); r(out, 12, 4, 1, 2, P.d); // 举起的手
    r(out, 4, 2, 1, 1, P.o); r(out, 8, 0, 1, 1, P.y); r(out, 12, 2, 1, 1, P.p); // 空中小球
  },
  building: (out) => {
    body(out);
    r(out, 1, 12, 3, 2, P.o); r(out, 1, 14, 4, 1, P.o); // 砖堆
    r(out, 12, 5, 1, 7, P.t); r(out, 12, 5, 4, 1, P.t); // 脚手架立柱+横梁
    r(out, 12, 9, 3, 1, P.t);
  },
  conducting: (out) => {
    body(out, { eyes: 'happy' });
    r(out, 12, 5, 1, 1, P.d); // 举棒的手
    r(out, 13, 3, 3, 1, P.c); // 指挥棒
    stamp(out, SPARK, 1, 1, P.p); // 音符感
  },
  attention: (out) => { body(out, { eyes: 'happy' }); stamp(out, SPARK, 12, 0, P.y); stamp(out, SPARK, 0, 2, P.y); },
  notification: (out) => {
    body(out);
    r(out, 11, 2, 4, 3, P.c); r(out, 11, 2, 1, 1, P.k); r(out, 14, 2, 1, 1, P.k); // 信封
    r(out, 1, 1, 1, 3, P.y); r(out, 1, 5, 1, 1, P.y); // 感叹号
  },
  error: (out) => {
    body(out, { eyes: 'worry' });
    r(out, 12, 1, 1, 2, P.u); r(out, 12, 3, 1, 1, P.u); // 汗滴
  },
  sweeping: (out) => {
    body(out);
    r(out, 12, 4, 1, 5, P.t); r(out, 13, 8, 2, 1, P.t); // 扫帚杆
    r(out, 12, 9, 3, 3, P.y); r(out, 13, 12, 2, 1, P.y); // 帚头
    r(out, 1, 13, 1, 1, P.g); r(out, 2, 12, 1, 1, P.g); // 尘土
  },
  carrying: (out) => {
    body(out, { eyes: 'happy' });
    r(out, 5, 11, 6, 4, P.m); r(out, 7, 11, 2, 4, P.t); // 怀抱的包裹
    r(out, 4, 11, 1, 2, P.d); r(out, 11, 11, 1, 2, P.d); // 托举的手
  },
  sleeping: (out) => { body(out, { eyes: 'closed' }); zzz(out, 11, 1, 1); zzz(out, 13, 0, 1); },
  waking: (out) => {
    body(out);
    r(out, 2, 5, 1, 2, P.d); r(out, 13, 5, 1, 2, P.d); // 伸懒腰
    stamp(out, SPARK, 13, 0, P.y);
  },
  // idleAnimations 的随机小动作
  'idle-happy': (out) => { body(out, { eyes: 'happy' }); stamp(out, SPARK, 12, 1, P.p); },
};

// —— Mini 模式（8x8）：3x5 小团子 + 单点眼 ——
function miniBody(out, { x = 1, happy = false } = {}) {
  r(out, x + 1, 2, 5, 1, P.b); r(out, x, 3, 6, 3, P.b); r(out, x + 1, 6, 5, 1, P.b);
  r(out, x + 4, 3, 1, 3, P.d, 0.5);
  r(out, x + 2, 1, 1, 1, P.l); r(out, x + 3, 0, 1, 1, P.l); // 头顶小芽
  if (happy) { r(out, x + 1, 4, 1, 1, P.e); r(out, x + 4, 4, 1, 1, P.e); }
  else { r(out, x + 1, 4, 1, 1, P.e); r(out, x + 4, 4, 1, 1, P.e); }
}
const MINI = {
  'mini-idle': (out) => miniBody(out),
  'mini-alert': (out) => { miniBody(out); r(out, 0, 0, 1, 3, P.y); r(out, 0, 4, 1, 1, P.y); },
  'mini-happy': (out) => { miniBody(out, { happy: true }); r(out, 7, 1, 1, 1, P.p); },
  'mini-enter': (out) => { miniBody(out); r(out, 0, 5, 1, 1, P.u, 0.7); },
  'mini-peek': (out) => miniBody(out, { x: 3 }), // 只探半个身子
  'mini-working': (out) => { miniBody(out); r(out, 2, 7, 4, 1, P.k); },
  'mini-crabwalk': (out) => { miniBody(out); r(out, 0, 4, 1, 1, P.u, 0.7); r(out, 7, 3, 1, 1, P.u, 0.5); },
  'mini-enter-sleep': (out) => { miniBody(out); r(out, 6, 1, 1, 1, P.c); },
  'mini-sleep': (out) => { miniBody(out); r(out, 6, 1, 1, 1, P.c); r(out, 7, 0, 1, 1, P.c); },
};

function drawToSvg(drawFn, size) {
  const out = [];
  drawFn(out);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges">${out.join('')}</svg>`;
}

/** @returns {Map<string,string>} 文件名（不含扩展名）→ SVG 字符串 */
function renderAll() {
  const files = new Map();
  for (const [name, fn] of Object.entries(MAIN)) files.set(`sprout-${name}`, drawToSvg(fn, 16));
  for (const [name, fn] of Object.entries(MINI)) files.set(`sprout-${name}`, drawToSvg(fn, 8));
  return files;
}

module.exports = { P, MAIN_KEYS: Object.keys(MAIN), MINI_KEYS: Object.keys(MINI), renderAll, drawToSvg };
