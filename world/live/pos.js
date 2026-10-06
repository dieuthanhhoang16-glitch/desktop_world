// world/live/pos.js
// 动态桌面窗口坐标的纯函数守卫（无 Electron 依赖，可单测）。
// 背景：macOS 多屏下，保存的位置可能随 Space 切换/显示器断连变成"屏外点"
// 或被 macOS 自动改摆（frameless 窗被扔进当前活跃 Space 的屏），
// 窗口于是完整落在其他窗口后面/不可见区域——表现为"重启后看不见动态桌面"。
'use strict';

/** 至少露出多少像素才算"可见"（过小等于隐身，拖都拖不回来）。 */
const MIN_VISIBLE = 120;

/**
 * 判断矩形在某显示器并集上是否至少有 MIN_VISIBLE×MIN_VISIBLE 的可见面积。
 * displays: [{x,y,width,height}]（CG 全局坐标，允许负值）。
 */
function rectVisibleOn(rect, displays, minVisible = MIN_VISIBLE) {
  if (!Array.isArray(displays) || !displays.length) return true; // 拿不到屏信息时不妄杀
  if (rect.x == null || rect.y == null) return false; // 尚未指定 → 让调用方走默认位
  return displays.some((d) => {
    const ix = Math.min(rect.x + rect.w, d.x + d.width) - Math.max(rect.x, d.x);
    const iy = Math.min(rect.y + rect.h, d.y + d.height) - Math.max(rect.y, d.y);
    return ix >= minVisible && iy >= minVisible;
  });
}

module.exports = { rectVisibleOn, MIN_VISIBLE };
