// world/garden/index.js
// desktop-world · 生长世界门面：pipeline/bake 只认这一个入口。
'use strict';

const { applyDailyReport, loadState, initialState, describe } = require('./state');
const { renderWorldSvg } = require('./scene');

/**
 * 计算本次报告的世界视图：结算当日成果（幂等）→ 描述 → 不给 svg（svg 在烘焙时才渲染）。
 */
function worldForReport(outDir, digest, dateStr) {
  const { state } = applyDailyReport(outDir, digest, dateStr);
  return describe(state);
}

/** --reuse 模式：不结算，只读取现有状态；没有就给一颗种子。 */
function worldForReuse(outDir) {
  return describe(loadState(outDir) || initialState(null));
}

/** bake 时调用：给 world 描述补上 svg 字符串（无副作用，返回新对象）。 */
function withSvg(world) {
  return { ...world, svg: renderWorldSvg(world) };
}

module.exports = { worldForReport, worldForReuse, withSvg, renderWorldSvg, describe };
