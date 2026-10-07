// world/live/lifecycle.js
// 动态桌面「三态生命周期」（closed / hidden / open）的纯逻辑核心（无 Electron 依赖，可单测）。
// 背景：v0.6.5 及之前只有 open/closed 两态，「关闭」= close() 销毁窗口——番茄钟/随手记
// 在途状态随之蒸发，重开还有 loadFile 空窗。v0.6.6 起 hide() 只把窗口收成一个
// 右上角胶囊（win.hide → 换小边界 → 再现），webContents、loadFile、timer 全部活着。
//
// 三态语义：
//   closed —— 没有窗口（或已销毁）。关闭行为只走 closeLive()（写 enabled:false）。
//   hidden —— 窗口活着但缩成 ~148×30 胶囊贴原窗口右上角；胶囊可点回展开；
//             clickThrough 锁定时胶囊穿透（唤回只能托盘/快捷键，这是预期行为）。
//   open   —— 完整组件窗（v0.6.1 起的既有形态）。
'use strict';

// 胶囊尺寸（逻辑像素）：贴原窗口右上角，克制不遮其他窗；信息只放极简摘要
const PILL_W = 148;
const PILL_H = 30;

/**
 * live.json 持久态归一（唯一口径：菜单/快捷键/启动恢复都读这一条链）。
 * 旧文件没有 state 字段：enabled:true 视为 open，否则 closed（迁移不丢行为）。
 */
function normalizePersistedState(cfg) {
  const s = cfg && cfg.state;
  if (s === 'open' || s === 'hidden' || s === 'closed') return s;
  return cfg && cfg.enabled ? 'open' : 'closed';
}

/** 胶囊贴完整窗口右上角（贴近原右缘与顶缘）。full: {x,y,width,height}。 */
function pillBounds(full) {
  return {
    x: Math.round(full.x + Math.max(0, full.width - PILL_W)),
    y: Math.round(full.y),
    width: PILL_W,
    height: PILL_H,
  };
}

/**
 * macOS 位置守卫（从 open() 里的 loadFile 后兜底抽出共用，hidden→open 恢复也用它）：
 * setVisibleOnAllWorkspaces / Space 切换 / 多屏断连都可能让系统把 frameless 窗改摆到
 * 别的屏或屏外，核对一次实际位置，不在目标位就拉回来。
 */
function snapPosition(winLike, x, y) {
  try {
    const [bx, by] = winLike.getPosition();
    if (bx !== x || by !== y) winLike.setPosition(x, y);
    return bx !== x || by !== y;
  } catch {
    return false; // 窗口状态异常时不挡流程（首刷照样进行，v0.6.3.1 起既有取舍）
  }
}

/**
 * open → hidden：收成一个胶囊。
 * 动作序列刻意为「先 hide 再改边界再现」：macOS 上可见状态下 setBounds 会有
 * 一帧缩放抖动；先摘下窗口，改完大小与模板形态再放回，用户只看到"组件变成胶囊"。
 * 绝不 close()/destroy()、不 reload webContents、不清 15 分钟热刷 timer——
 * 番茄钟/随手记/tomorrow 的在途状态全部随 webContents 活着。
 *
 * @param winLike  Electron BrowserWindow（生产）或同形 stub（测试）
 * @param applyTemplate  (mode: 'open'|'hidden') => void —— 把形态推给渲染层
 * @returns {x,y,width,height} 收起前的完整边界（交给调用方保存，expand 恢复用）
 */
function collapseToPill(winLike, applyTemplate) {
  const full = winLike.getBounds();
  winLike.hide();
  if (typeof applyTemplate === 'function') applyTemplate('hidden');
  winLike.setBounds(pillBounds(full));
  // showInactive 优先：收起是"退居二线"的动作，不该顺手抢焦点
  if (typeof winLike.showInactive === 'function') winLike.showInactive();
  else winLike.show();
  return { x: full.x, y: full.y, width: full.width, height: full.height };
}

/**
 * hidden → open：胶囊还原成完整组件窗。
 * 同样先摘下再恢复边界，并用 snapPosition 复用 open() 的 macOS 位置兜底
 * （Space/多屏可能在收起期间把窗口坐标挪走）。
 * @param fullBounds  collapseToPill 的返回值（或与 cfg 拼出的 {x,y,width,height}）
 */
function expandFromPill(winLike, fullBounds, applyTemplate) {
  winLike.hide();
  if (typeof applyTemplate === 'function') applyTemplate('open');
  winLike.setBounds({ x: fullBounds.x, y: fullBounds.y, width: fullBounds.width, height: fullBounds.height });
  snapPosition(winLike, fullBounds.x, fullBounds.y);
  winLike.show(); // 展开是用户主动唤回，正常 show 让它到当前 Space 前排
}

/**
 * 全局快捷键加速器（写进 live.json shortcut 字段）的宽松白名单校验。
 * 只挡明显垃圾（空串/超长/非法字符/没有键位主体）；能不能注册仍由
 * globalShortcut.register 的返回值裁决——校验通过 ≠ 一定注册得上。
 */
function validAccelerator(s) {
  if (typeof s !== 'string') return null;
  const v = s.trim();
  if (!v || v.length > 64) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9+ \-=;,\./`[\]']*$/.test(v)) return null;
  const parts = v.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null; // 至少一个修饰符 + 一个键
  if (!/[A-Za-z0-9]/.test(parts[parts.length - 1])) return null; // 末段必须是键位主体
  return v;
}

module.exports = {
  PILL_W,
  PILL_H,
  normalizePersistedState,
  pillBounds,
  snapPosition,
  collapseToPill,
  expandFromPill,
  validAccelerator,
};
