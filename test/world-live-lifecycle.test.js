// test/world-live-lifecycle.test.js
// v0.6.6 三态生命周期（closed / hidden / open）：纯逻辑层全部可单测。
// 覆盖：state() 归一迁移、旧 live.json 无 state 字段兼容读取、hide/show 不销毁窗口、
// 幽灵模式取消（v0.6.6.1）后历史 clickThrough 一律归零、胶囊边界/macOS 位置守卫/快捷键加速器白名单。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const life = require('../world/live/lifecycle');

// cfg.js 在 require 时解析 WORLD_LIVE_FILE——测试改的是显式传入的临时文件路径则不受影响；
// 这里直接用环境变量隔离（在 require 前设好），避免任何真实配置的往返
process.env.WORLD_LIVE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dwlife-')), 'live.json');
const { loadCfg, saveCfg, CFG_FILE } = require('../world/live/cfg');

// ---------- 持久态归一与旧文件兼容 ----------

test('normalizePersistedState：旧文件无 state 字段时按 enabled 推导（迁移不丢行为）', () => {
  assert.equal(life.normalizePersistedState({ enabled: true }), 'open');
  assert.equal(life.normalizePersistedState({ enabled: false }), 'closed');
  assert.equal(life.normalizePersistedState({}), 'closed');
  assert.equal(life.normalizePersistedState(null), 'closed');
  // 显式 state 优先
  assert.equal(life.normalizePersistedState({ enabled: true, state: 'hidden' }), 'hidden');
  assert.equal(life.normalizePersistedState({ enabled: false, state: 'open' }), 'open');
  assert.equal(life.normalizePersistedState({ enabled: true, state: 'closed' }), 'closed');
  // 垃圾 state 值回退推导
  assert.equal(life.normalizePersistedState({ enabled: true, state: 'junk' }), 'open');
});

test('cfg：旧 live.json（无 state/clickThrough:true）兼容读取；saveCfg 补 state 0600', () => {
  // 真机上 live.json 历来由 saveCfg 以 0600 创建——夹具照真，验 saveCfg 不降级
  fs.writeFileSync(CFG_FILE, JSON.stringify({ enabled: true, clickThrough: true, w: 980, h: 620, x: -1093, y: 292 }), { mode: 0o600 });
  const cfg = loadCfg();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.clickThrough, false); // v0.6.6.1 起历史 clickThrough:true 一律读取归零
  assert.equal(cfg.x, -1093);
  assert.equal(life.normalizePersistedState(cfg), 'open'); // 无 state → enabled:true → open

  // 落盘 state 字段，其他字段原样保留
  const saved = saveCfg({ state: 'hidden' });
  assert.equal(saved.state, 'hidden');
  assert.equal(saved.x, -1093);
  assert.equal(saved.clickThrough, false);
  assert.equal((fs.statSync(CFG_FILE).mode & 0o777), 0o600);

  const reread = loadCfg();
  assert.equal(life.normalizePersistedState(reread), 'hidden');
});

test('cfg：enabled:false 的旧文件读出来是 closed；读坏回空不崩', () => {
  fs.writeFileSync(CFG_FILE, JSON.stringify({ enabled: false, v61: true }));
  assert.equal(life.normalizePersistedState(loadCfg()), 'closed');
  fs.writeFileSync(CFG_FILE, 'not-json{{{');
  assert.equal(life.normalizePersistedState(loadCfg()), 'closed'); // 回空 dflt（enabled:false）→ closed
});

test('cfg：幽灵模式取消——任何路径的 clickThrough:true 都归零，写盘也无法复活它', () => {
  // v0.6.6.1 前史：穿透锁经历两代事故（v61 迁移把手动锁刷没 / 锁死后找不到解锁出口），
  // 用户定调整体取消。现在 loadCfg 读取归零 + saveCfg 写盘强制 false，双保险。
  saveCfg({ enabled: true, clickThrough: true }); // 试图通过补丁注入
  const read1 = loadCfg();
  assert.equal(read1.clickThrough, false, 'saveCfg 强制 false，幽灵模式无法借补丁还魂');
  assert.equal(JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')).clickThrough, false, '落盘即 false');
  // 真正的旧文件（历史 clickThrough:true，带不带 v61 戳都一样）
  fs.writeFileSync(CFG_FILE, JSON.stringify({ enabled: true, clickThrough: true, v61: true, w: 980, h: 620 }), { mode: 0o600 });
  assert.equal(loadCfg().clickThrough, false);
  fs.writeFileSync(CFG_FILE, JSON.stringify({ enabled: true, clickThrough: true, w: 980, h: 620 }), { mode: 0o600 });
  assert.equal(loadCfg().clickThrough, false);
});

// ---------- 胶囊边界 ----------

test('pillBounds：胶囊贴完整窗口右上角，=-PILL_W/PILL_H 尺寸', () => {
  const b = life.pillBounds({ x: -1093, y: 292, width: 980, height: 620 });
  assert.equal(b.x, -1093 + 980 - life.PILL_W); // 右缘对齐原窗右缘
  assert.equal(b.y, 292); // 顶缘对齐
  assert.equal(b.width, life.PILL_W);
  assert.equal(b.height, life.PILL_H);
  // 窗比胶囊还窄（异常输入）也不出负数偏移
  const tiny = life.pillBounds({ x: 10, y: 20, width: 50, height: 50 });
  assert.equal(tiny.x, 10);
  assert.equal(tiny.width, life.PILL_W);
});

// ---------- hide/show 不销毁窗口（stub 同形 BrowserWindow）----------

function makeStubWin(initialBounds) {
  const calls = [];
  const stub = {
    bounds: { ...initialBounds },
    destroyed: false,
    visible: true,
    calls,
    getBounds() { calls.push('getBounds'); return { ...this.bounds }; },
    setBounds(b) { calls.push(['setBounds', b]); this.bounds = { ...b }; },
    getPosition() { calls.push('getPosition'); return [this.bounds.x, this.bounds.y]; },
    setPosition(x, y) { calls.push(['setPosition', x, y]); this.bounds.x = x; this.bounds.y = y; },
    hide() { calls.push('hide'); this.visible = false; },
    show() { calls.push('show'); this.visible = true; },
    showInactive() { calls.push('showInactive'); this.visible = true; },
    isDestroyed() { return this.destroyed; },
    close() { calls.push('close'); this.destroyed = true; },
    destroy() { calls.push('destroy'); this.destroyed = true; },
  };
  return stub;
}

function flatCalls(stub) {
  return stub.calls.map((c) => (Array.isArray(c) ? c[0] : c));
}

test('collapseToPill / expandFromPill：绝不 close/destroy，webContents 与 timer 都不动', () => {
  const stub = makeStubWin({ x: 100, y: 200, width: 980, height: 620 });
  const modes = [];
  const full = life.collapseToPill(stub, (m) => modes.push(m));

  assert.deepEqual(full, { x: 100, y: 200, width: 980, height: 620 });
  assert.deepEqual(modes, ['hidden']);
  assert.deepEqual(stub.bounds, life.pillBounds({ x: 100, y: 200, width: 980, height: 620 }));
  assert.equal(stub.visible, true); // 先摘下又作为胶囊展示了
  assert.equal(stub.destroyed, false);
  assert.ok(!flatCalls(stub).includes('close'), 'hide 绝不销毁窗口（no close）');
  assert.ok(!flatCalls(stub).includes('destroy'), 'hide 绝不销毁窗口（no destroy）');

  stub.calls.length = 0;
  life.expandFromPill(stub, full, (m) => modes.push(m));
  assert.deepEqual(stub.bounds, { x: 100, y: 200, width: 980, height: 620 }, '展开精确还原收起前边界');
  assert.ok(flatCalls(stub).includes('show'), '展开用 show()');
  assert.equal(stub.destroyed, false);
  assert.ok(!flatCalls(stub).includes('close'));
});

test('expandFromPill：macOS 位置守卫——坐标漂移时拉回原位（复用 open() 的兜底）', () => {
  const stub = makeStubWin(life.pillBounds({ x: -1093, y: 292, width: 980, height: 620 }));
  const drifted = { x: -1093, y: 292, width: 980, height: 620 };
  // setBounds 之后系统把窗口挪走了（模拟 Space/多屏改摆）
  const origSetBounds = stub.setBounds;
  stub.setBounds = function (b) {
    origSetBounds.call(this, b);
    this.bounds.x += 500; // macOS 漂移
  };
  life.expandFromPill(stub, drifted, () => {});
  const setPos = stub.calls.find((c) => Array.isArray(c) && c[0] === 'setPosition');
  assert.ok(setPos, '漂移后必须 setPosition 拉回');
  assert.equal(setPos[1], -1093);
  assert.equal(setPos[2], 292);
});

test('snapPosition：在位不动手，异位拉回；窗口异常静默不挡', () => {
  const stub = makeStubWin({ x: 5, y: 6, width: 100, height: 100 });
  assert.equal(life.snapPosition(stub, 5, 6), false); // 在位 → 无操作
  assert.deepEqual(flatCalls(stub).filter((c) => c === 'setPosition'), []);
  stub.bounds.x = 999;
  assert.equal(life.snapPosition(stub, 5, 6), true);
  assert.deepEqual([stub.bounds.x, stub.bounds.y], [5, 6]);
  const broken = { getPosition() { throw new Error('gone'); } };
  assert.equal(life.snapPosition(broken, 0, 0), false);
});

test('hide/show 与鼠标事件开关无关：转换全程不碰 setIgnoreMouseEvents（stub 干脆没有这方法）', () => {
  const stub = makeStubWin({ x: 0, y: 0, width: 980, height: 620 }); // 无 setIgnoreMouseEvents
  const full = life.collapseToPill(stub, () => {});
  life.expandFromPill(stub, full, () => {});
  assert.equal(stub.destroyed, false); // 没炸 = 全程没调过不存在的 ignore-mouse 方法
  // saveCfg({state}) 只动 state；clickThrough 永远是 false（幽灵模式已取消）
  const saved = saveCfg({ state: 'hidden' });
  assert.equal(saved.clickThrough, false);
  saveCfg({ state: 'open' });
  assert.equal(loadCfg().clickThrough, false);
});

// ---------- 快捷键加速器白名单 ----------

test('validAccelerator：默认键过、垃圾拒、末段必须是键位主体', () => {
  assert.equal(life.validAccelerator('CommandOrControl+Shift+D'), 'CommandOrControl+Shift+D');
  assert.equal(life.validAccelerator('  CommandOrControl+Shift+D  '), 'CommandOrControl+Shift+D');
  assert.equal(life.validAccelerator('Alt+F4'), 'Alt+F4');
  assert.equal(life.validAccelerator(''), null);
  assert.equal(life.validAccelerator('D'), null); // 没有修饰组合
  assert.equal(life.validAccelerator('Shift+'), null); // 末段空
  assert.equal(life.validAccelerator('<script>alert(1)</script>'), null);
  assert.equal(life.validAccelerator(42), null);
  assert.equal(life.validAccelerator('A'.repeat(65) + '+D'), null);
});
