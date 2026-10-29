// test/world-live-orch-console-ipc.test.js
// 编排台 R2 主进程 IPC 守门（world/live/orch-console-ipc.js）：
//   ① 全通道外窗伪造一律 window-mismatch（措辞与 live.js 逐字一致），函数一律不抛。
//   ② run/steer 白名单透传 + 成功才 refresh；model 缺省时读角色卡兜底，协议失败不透刷新。
//   ③ runLog：run-not-found 协议 / tail 按字节截断 / receipt 原文随行。
//   ④ artifacts 三分支：有 run 走 worktree stat（越界条目跳过）；无 run 列 cwd/out/；
//      out/ 不存在 → 空表不报错。
//   ⑤ reveal 白名单：roles runs/ 放行（shell 收到），/etc/passwd 一律 path-not-allowed。
//   ⑥ note 落黑板可回读；空串被 note-empty 拦截。
//   ⑦ roles:list 宽容解析默认模型；roles:save 改模型行后 manifest 重建零漂移；
//      未知角色 / 空白正文 / 空提交各有错误协议。
//   ⑧ roadmapInit 不覆盖既有 / example 播种 / roadmapLink 白名单过滤与错误协议。
//   ⑨ reports 账本投影新在前、字段瘦身；console 快照 lanes 三泳道 + roadmap 切片。
//   ⑩ authorize：approve 两路（真写 roadmap + 黑板留痕 vs 什么都不写）+ 幂等 + 未知阶段。
//   ⑪ learn:list 只读 learnRoot；open 越界 path-not-allowed、缺文件 learn-file-missing。
// 隔离：全部 env 根指 mkdtemp（须在 require 前设，paths 模块在加载时定格 env）；
// executor/shell/refresh 全注入假件——文件可 node --test 直跑，不碰 electron。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── 隔离根（require 前生效）──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'world-orch-console-ipc-'));
const ORCH = path.join(tmp, 'orch');
const ROLES_DIR = path.join(tmp, 'roles');
const LEARN_DIR = path.join(tmp, 'learn');
const OUT_DIR = path.join(tmp, 'out');
process.env.WORLD_ORCH_DIR = ORCH;
process.env.WORLD_ROLES_DIR = ROLES_DIR;
process.env.WORLD_PROJECT_STUDY_DIR = LEARN_DIR;
process.env.WORLD_OUT_DIR = OUT_DIR;
process.env.WORLD_PROJECTS_FILE = path.join(tmp, 'projects.json');

const { registerOrchConsoleIpc } = require('../world/live/orch-console-ipc');
const launcher = require('../world/roles/launcher');
const store = require('../world/orch/store');
const roadmap = require('../world/orch/roadmap');
const blackboard = require('../world/orch/blackboard');
const { ticketsFile, blackboardFile, roadmapFile, reportsDir } = require('../world/orch/paths');

// ── 假件 ──
class FakeIpcMain {
  constructor() { this.handlers = new Map(); }
  handle(channel, handler) { this.handlers.set(channel, handler); }
  invoke(channel, sender, ...args) {
    const handler = this.handlers.get(channel);
    assert.strictEqual(typeof handler, 'function', `missing IPC handler ${channel}`);
    return handler({ sender }, ...args);
  }
}

function makeHarness() {
  const ipcMain = new FakeIpcMain();
  const mine = { kind: 'mine-web-contents' };
  const calls = { refresh: 0, shell: [] };
  const executor = {
    rolesRoot: ROLES_DIR,
    calls: [],
    runs: [],
    runResult: { ok: true, runId: 'exec-fake' },
    steerResult: { ok: true },
    async runTicket(id, opts) { this.calls.push(['runTicket', id, opts]); return this.runResult; },
    async steer(runId, text, opts) { this.calls.push(['steer', runId, text, opts]); return this.steerResult; },
    list() { return this.runs; },
    sweep() { this.calls.push(['sweep']); },
    on() { /* EventEmitter 形（注入路径不 sweep） */ },
  };
  const shell = {
    showItemInFolder: (p) => calls.shell.push(['showItemInFolder', p]),
    openPath: async (p) => { calls.shell.push(['openPath', p]); return ''; },
  };
  registerOrchConsoleIpc({
    ipcMain,
    ok: (e) => Boolean(e) && e.sender === mine,
    refresh: () => { calls.refresh += 1; },
    shell,
    executor,
  });
  return { ipcMain, mine, calls, executor };
}

const FOREIGN = { kind: 'foreign-web-contents' };

const CHANNELS = [
  ['world:orch:console'],
  ['world:orch:run', 'ORCH-001', {}],
  ['world:orch:runs'],
  ['world:orch:steer', 'r-x', 'go'],
  ['world:orch:runLog', 'r-x'],
  ['world:orch:artifacts', 'ORCH-001'],
  ['world:orch:reveal', '/tmp/x'],
  ['world:orch:note', 'hi'],
  ['world:orch:roadmapInit', {}],
  ['world:orch:roadmapLink', {}],
  ['world:orch:authorize', {}],
  ['world:orch:reports'],
  ['world:roles:list'],
  ['world:roles:save', { id: 'ds' }],
  ['world:learn:list'],
  ['world:learn:open', 'x.md'],
];

function seedRoles() {
  launcher.initRoles({ root: ROLES_DIR });
}

function seedTickets() {
  store.appendTickets(ticketsFile(ORCH), [
    { id: 'ORCH-001', title: '工单甲', agent: 'ds', cwd: tmp, status: 'confirmed' },
    { id: 'ORCH-002', title: '工单乙', agent: 'glm', cwd: tmp, status: 'dispatched' },
  ]);
}

test('外窗伪造：16 个通道全部 window-mismatch，措辞与 live.js 逐字一致', async () => {
  const { ipcMain, calls, executor } = makeHarness();
  assert.deepEqual(executor.calls, [], '注册时注入 executor 不得被懒建分支的 sweep 污染');
  for (const [channel, ...args] of CHANNELS) {
    const res = await ipcMain.invoke(channel, FOREIGN, ...args);
    assert.strictEqual(res.ok, false, `${channel} 不该放行外窗`);
    assert.strictEqual(res.problems[0].code, 'window-mismatch', `${channel} 错误码`);
    assert.strictEqual(res.problems[0].reason, '写请求不是组件窗发出的', `${channel} reason 措辞`);
    assert.strictEqual(res.problems[0].fix, '在桌面组件的调度树里操作', `${channel} fix 措辞`);
  }
  assert.strictEqual(calls.refresh, 0, '外窗请求不得触发 refresh');
  assert.deepEqual(calls.shell, [], '外窗请求不得触达 shell');
  assert.deepEqual(executor.calls, [], '外窗请求不得触达执行器');
});

test('run/steer：白名单透传 + 成功 refresh；model 缺省读角色卡；协议失败不透刷新', async () => {
  seedRoles();
  seedTickets();
  const { ipcMain, mine, calls, executor } = makeHarness();

  // ① 全权托管：agent=ds → 模型兜底读 ds 角色卡
  let res = await ipcMain.invoke('world:orch:run', mine, 'ORCH-001', {});
  assert.deepEqual(res, { ok: true, runId: 'exec-fake' });
  assert.deepEqual(executor.calls[0], ['runTicket', 'ORCH-001', { model: 'jd-ds' }], '缺省 model 读角色卡兜底');
  assert.strictEqual(calls.refresh, 1);

  // ② 白名单：role/timeoutMs 透传，model=null 仍走兜底（按新 role=glm），未知键被丢弃
  res = await ipcMain.invoke('world:orch:run', mine, 'ORCH-001', { role: 'glm', timeoutMs: 500, model: null, evil: 'x' });
  assert.strictEqual(res.ok, true);
  assert.deepEqual(executor.calls[1], ['runTicket', 'ORCH-001', { role: 'glm', timeoutMs: 500, model: 'jd-glm53' }]);

  // ③ 显式 model 一律用它，不读卡
  res = await ipcMain.invoke('world:orch:run', mine, 'ORCH-001', { model: 'm-explicit' });
  assert.strictEqual(res.ok, true);
  assert.deepEqual(executor.calls[2], ['runTicket', 'ORCH-001', { model: 'm-explicit' }]);
  assert.strictEqual(calls.refresh, 3);

  // ④ 协议失败：原样透传，不 refresh
  executor.runResult = { ok: false, problems: [{ code: 'ticket-not-confirmed', reason: 'r', fix: 'f' }] };
  res = await ipcMain.invoke('world:orch:run', mine, 'ORCH-001', { model: 'm' });
  assert.deepEqual(res, { ok: false, problems: [{ code: 'ticket-not-confirmed', reason: 'r', fix: 'f' }] });
  assert.strictEqual(calls.refresh, 3, 'run 失败不得 refresh');

  // ⑤ steer：ok 时 refresh + 参数透传；失败原样透传
  executor.steerResult = { ok: true };
  res = await ipcMain.invoke('world:orch:steer', mine, 'r-1', '继续干');
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(executor.calls[4], ['steer', 'r-1', '继续干', {}]);
  assert.strictEqual(calls.refresh, 4);
  executor.steerResult = { ok: false, problems: [{ code: 'steer-denied', reason: 'r', fix: 'f' }] };
  res = await ipcMain.invoke('world:orch:steer', mine, 'r-1', '停');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.problems[0].code, 'steer-denied');
  assert.strictEqual(calls.refresh, 4, 'steer 失败不得 refresh');
});

test('runs/console：执行器列表直通；快照含 lanes 三泳道与 roadmap 切片', async () => {
  roadmap.saveAll(roadmapFile(ORCH), roadmap.exampleRoadmap());
  const { ipcMain, mine, executor } = makeHarness();
  let res = await ipcMain.invoke('world:orch:runs', mine);
  assert.deepEqual(res, { ok: true, runs: [] });
  executor.runs = [{ runId: 'r-9', ticketId: 'ORCH-001', active: true }];
  res = await ipcMain.invoke('world:orch:runs', mine);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.runs.length, 1);
  assert.strictEqual(res.runs[0].runId, 'r-9');

  res = await ipcMain.invoke('world:orch:console', mine);
  assert.strictEqual(res.ok, true);
  const snap = res.snapshot;
  assert.ok(snap && typeof snap === 'object', '缺 snapshot');
  for (const lane of ['needs', 'working', 'done']) {
    assert.ok(Array.isArray(snap.lanes[lane]), `lanes.${lane} 应是数组`);
  }
  assert.ok(Array.isArray(snap.runs), '快照缺 runs');
  assert.ok(snap.roadmap, 'roadmap 切片缺省——activeWindow 播种后应当非空');
  const dsCard = snap.lanes.working.find((c) => c.id === 'ORCH-001');
  assert.ok(dsCard, 'confirmed 工单应进 working 泳道');
});

test('runLog：缺 run 给 run-not-found；tail 按字节截尾；receipt 原文随行', async () => {
  const { ipcMain, mine, executor } = makeHarness();
  let res = await ipcMain.invoke('world:orch:runLog', mine, 'no-such-run');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.problems[0].code, 'run-not-found');

  const runDir = launcher.runDirs(ROLES_DIR, 'r-1').runDir;
  fs.mkdirSync(runDir, { recursive: true });
  const stdout = 'ab'.repeat(200000); // 400KB
  const stderr = 'err!'.repeat(50000);
  fs.writeFileSync(path.join(runDir, 'stdout.log'), stdout);
  fs.writeFileSync(path.join(runDir, 'stderr.log'), stderr);
  fs.writeFileSync(path.join(runDir, 'receipt.json'), '{"ok":true,"runId":"r-1"}');
  executor.runs = [{ runId: 'r-1', ticketId: 'ORCH-001' }]; // 不给 runDir，走 launcher.runDirs 兜底

  res = await ipcMain.invoke('world:orch:runLog', mine, 'r-1', 1234);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.stdout.length, 1234, 'tail 应按字节截尾');
  assert.strictEqual(res.stdout, stdout.slice(-1234));
  assert.strictEqual(res.stderr, stderr.slice(-1234));
  assert.strictEqual(res.receipt, '{"ok":true,"runId":"r-1"}');

  res = await ipcMain.invoke('world:orch:runLog', mine, 'r-1');
  assert.strictEqual(res.stdout.length, 64 * 1024, '缺省 tail=64KB');
});

test('artifacts：有 run 走 worktree stat（越界/失踪跳过）；无 run 列 out/；out 缺失空表', async () => {
  const projA = fs.mkdtempSync(path.join(tmp, 'projA-'));
  const wtA = path.join(projA, 'wt');
  fs.mkdirSync(path.join(wtA, 'out'), { recursive: true });
  fs.writeFileSync(path.join(wtA, 'out', 'one.md'), '12345');
  const projB = fs.mkdtempSync(path.join(tmp, 'projB-'));
  fs.mkdirSync(path.join(projB, 'out'), { recursive: true });
  fs.writeFileSync(path.join(projB, 'out', 'f1.md'), 'aa');
  fs.writeFileSync(path.join(projB, 'out', 'f2.md'), 'bbb');
  const projC = fs.mkdtempSync(path.join(tmp, 'projC-'));
  store.appendTickets(ticketsFile(ORCH), [
    { id: 'ORCH-501', title: '有 run', agent: 'ds', cwd: projA, status: 'confirmed' },
    { id: 'ORCH-502', title: '无 run 有 out', agent: 'ds', cwd: projB, status: 'confirmed' },
    { id: 'ORCH-503', title: '无 run 无 out', agent: 'ds', cwd: projC, status: 'confirmed' },
  ]);
  const { ipcMain, mine, executor } = makeHarness();
  executor.runs = [{
    runId: 'r-A',
    ticketId: 'ORCH-501',
    startedAt: '2026-02-01T00:00:00.000Z',
    runDir: path.join(ROLES_DIR, 'runs', 'r-A'),
    worktreeDir: wtA,
    changedFiles: ['out/one.md', '../evil.md', 'out/gone.md'],
  }];

  // ① 越出 worktree 的条目与磁盘失踪条目都跳过，只剩 one.md
  let res = await ipcMain.invoke('world:orch:artifacts', mine, 'ORCH-501');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.files.length, 1);
  assert.strictEqual(res.files[0].rel, 'out/one.md');
  assert.strictEqual(res.files[0].size, 5);
  assert.strictEqual(res.files[0].path, path.join(wtA, 'out', 'one.md'));
  assert.strictEqual(res.worktreeDir, wtA);
  assert.strictEqual(res.runDir, path.join(ROLES_DIR, 'runs', 'r-A'));

  // ② 没 run 过：列 cwd/out/ 前 50
  res = await ipcMain.invoke('world:orch:artifacts', mine, 'ORCH-502');
  assert.strictEqual(res.ok, true);
  assert.deepEqual(res.files.map((f) => f.rel).sort(), ['f1.md', 'f2.md']);
  assert.strictEqual(res.files.find((f) => f.rel === 'f2.md').size, 3);
  assert.strictEqual(res.runDir, '');
  assert.strictEqual(res.worktreeDir, '');

  // ③ out/ 不存在：空表不报错
  res = await ipcMain.invoke('world:orch:artifacts', mine, 'ORCH-503');
  assert.deepEqual(res, { ok: true, files: [], runDir: '', worktreeDir: '' });

  // ④ 未知工单走协议
  res = await ipcMain.invoke('world:orch:artifacts', mine, 'ORCH-999');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.problems[0].code, 'ticket-not-found');
});

test('reveal：runs/ 白名单放行触达 shell；/etc/passwd 被 path-not-allowed 拦截', async () => {
  const { ipcMain, mine, calls } = makeHarness();
  const inside = path.join(ROLES_DIR, 'runs', 'r-1');
  let res = await ipcMain.invoke('world:orch:reveal', mine, inside);
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(calls.shell, [['showItemInFolder', inside]]);
  assert.strictEqual(calls.refresh, 0, 'reveal 是只读动作，不 refresh');

  res = await ipcMain.invoke('world:orch:reveal', mine, '/etc/passwd');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.problems[0].code, 'path-not-allowed');
  assert.strictEqual(res.problems[0].fix, '只能打开运行目录、产物目录、账本目录或已注册项目内的路径');
  assert.deepEqual(calls.shell, [['showItemInFolder', inside]], '越权请求不得触达 shell');
});

test('note：速记落黑板可回读（kind=fact）；空串被 note-empty 拦截', async () => {
  const { ipcMain, mine, calls } = makeHarness();
  const res = await ipcMain.invoke('world:orch:note', mine, '界规速记：写完再说');
  assert.deepEqual(res, { ok: true });
  assert.strictEqual(calls.refresh, 1);
  const entries = blackboard.list(blackboardFile(ORCH));
  assert.ok(entries.some((e) => e.kind === 'fact' && e.text === '界规速记：写完再说'), '黑板应能回读到速记');

  const bad = await ipcMain.invoke('world:orch:note', mine, '   ');
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.problems[0].code, 'note-empty');
  assert.strictEqual(calls.refresh, 1, '空串不得 refresh');
});

test('roles:list 宽容解析三卡默认模型；save 改模型行后零漂移；非法参数走协议', async () => {
  const { ipcMain, mine, calls } = makeHarness();
  let res = await ipcMain.invoke('world:roles:list', mine);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.roles.length, 3);
  const byId = Object.fromEntries(res.roles.map((r) => [r.id, r]));
  assert.strictEqual(byId.ds.model, 'jd-ds');
  assert.strictEqual(byId.glm.model, 'jd-glm53');
  assert.strictEqual(byId.jev.model, 'jev-latest');
  assert.strictEqual(byId.ds.title, '思考');
  assert.deepEqual(res.drift, [], '种子卡理应零漂移');

  // 改模型行：行内容替换 + manifest 重建——checkRoles 依旧零漂移
  const before = calls.refresh;
  res = await ipcMain.invoke('world:roles:save', mine, { id: 'ds', model: 'jd-ds-v2' });
  assert.strictEqual(res.ok, true);
  assert.deepEqual(res.drift, [], 'save 后漂移应被 manifest 重建清零');
  const cardBody = fs.readFileSync(path.join(ROLES_DIR, 'cards', 'ds.md'), 'utf8');
  assert.ok(cardBody.includes('- 默认模型：jd-ds-v2（任务级可覆盖，职责与权限不可覆盖）'), '模型行未按模板同构改写');
  assert.deepEqual(launcher.checkRoles({ root: ROLES_DIR }).drift, []);
  assert.strictEqual(calls.refresh, before + 1, 'roles:save 成功后要 refresh');

  // 非法参数全部走错误协议
  const unknown = await ipcMain.invoke('world:roles:save', mine, { id: 'wat', model: 'm' });
  assert.strictEqual(unknown.ok, false);
  assert.strictEqual(unknown.problems[0].code, 'role-unknown');
  const empty = await ipcMain.invoke('world:roles:save', mine, { id: 'ds', cardBody: '   ' });
  assert.strictEqual(empty.problems[0].code, 'card-body-empty');
  const nothing = await ipcMain.invoke('world:roles:save', mine, { id: 'ds' });
  assert.strictEqual(nothing.problems[0].code, 'card-nothing-to-save');
});

test('roadmapInit 不覆盖既有；example 播种；roadmapLink 白名单过滤与错误协议', async () => {
  const { ipcMain, mine } = makeHarness();
  // 此刻 roadmap 已有 example（runs/console 测试播种）→ init 必须拒覆盖
  let res = await ipcMain.invoke('world:orch:roadmapInit', mine, {});
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.problems[0].code, 'roadmap-exists');
  assert.ok(res.problems[0].fix.includes('手动删'), 'fix 必须指路人工删文件');

  // 清到空 roadmap → init 以 example 播种
  roadmap.saveAll(roadmapFile(ORCH), roadmap.emptyRoadmap());
  res = await ipcMain.invoke('world:orch:roadmapInit', mine, { example: true });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.example, true);
  assert.strictEqual(res.milestone, 'multi-agent-refactor');
  assert.strictEqual(roadmap.load(roadmapFile(ORCH)).stages.length, 4);

  // 白名单过滤：非工单 id 一律丢掉
  res = await ipcMain.invoke('world:orch:roadmapLink', mine, { windowId: 'A.a', ticketIds: ['ORCH-001', 'nope', 'ORCH-002'] });
  assert.strictEqual(res.ok, true);
  assert.deepEqual(res.ticketIds, ['ORCH-001', 'ORCH-002']);
  // 窗口号形状错 / 窗口不存在
  res = await ipcMain.invoke('world:orch:roadmapLink', mine, { windowId: 'xx', ticketIds: [] });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.problems[0].code, 'window-id-invalid');
  res = await ipcMain.invoke('world:orch:roadmapLink', mine, { windowId: 'Z.z', ticketIds: ['ORCH-001'] });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.problems[0].code, 'window-unknown');
});

test('reports：回执账本投影新在前、字段瘦身（与 CLI 同一数据源）', async () => {
  const dir = reportsDir(ORCH);
  fs.mkdirSync(dir, { recursive: true });
  const base = {
    milestone: 'm1',
    window: { stageId: 'A', subtaskId: 'a', state: 'planning' },
    verdict: 'pass',
    report: { heavy: '不投影' },
    boundarySummary: { checked: 9, passed: 9 },
  };
  fs.writeFileSync(path.join(dir, '2026-01-01T00-00-00-000Z-ab12.json'), JSON.stringify({ ...base, id: 'r-old', at: '2026-01-01T00:00:00.000Z' }));
  fs.writeFileSync(path.join(dir, '2026-01-02T00-00-00-000Z-cd34.json'), JSON.stringify({ ...base, id: 'r-new', at: '2026-01-02T00:00:00.000Z', boundarySummary: null }));
  const { ipcMain, mine } = makeHarness();
  const res = await ipcMain.invoke('world:orch:reports', mine);
  assert.strictEqual(res.ok, true);
  assert.deepEqual(res.reports.map((e) => e.id), ['r-new', 'r-old'], '新的必须在前');
  assert.strictEqual(res.reports[0].windowId, 'A.a');
  assert.strictEqual(res.reports[0].state, 'planning');
  assert.strictEqual(res.reports[0].boundarySummary, null);
  assert.deepEqual(res.reports[1].boundarySummary, { passed: 9, checked: 9 });
  assert.strictEqual(res.reports[0].report, undefined, 'fat 字段不得投影');
});

test('authorize：approve=false 什么都不写；approve=true 真写+留痕+refresh；幂等与未知阶段', async () => {
  roadmap.saveAll(roadmapFile(ORCH), roadmap.exampleRoadmap());
  const { ipcMain, mine, calls } = makeHarness();

  // 拒绝路：默认拒绝语义——不写盘、不留痕、不 refresh
  let res = await ipcMain.invoke('world:orch:authorize', mine, { approve: false, stageId: 'A' });
  assert.deepEqual(res, { ok: true, stageId: 'A', stageTitle: '纯协议与边界', authorized: false });
  assert.strictEqual(roadmap.load(roadmapFile(ORCH)).stages.find((s) => s.id === 'A').authorized, false);
  assert.ok(!blackboard.list(blackboardFile(ORCH)).some((e) => e.text.includes('已授权')), '拒绝路不得留痕');
  assert.strictEqual(calls.refresh, 0);

  // 授权路：真写 + 黑板留痕 + refresh
  res = await ipcMain.invoke('world:orch:authorize', mine, { approve: true, stageId: 'A', note: 'UI 两步确认' });
  assert.deepEqual(res, { ok: true, stageId: 'A', stageTitle: '纯协议与边界', authorized: true });
  assert.strictEqual(roadmap.load(roadmapFile(ORCH)).stages.find((s) => s.id === 'A').authorized, true);
  assert.ok(blackboard.list(blackboardFile(ORCH)).some((e) => String(e.text).includes('阶段 A「纯协议与边界」已授权')), '授权必须留痕');
  assert.strictEqual(calls.refresh, 1);

  // 幂等：已授权重复调用不重复写
  res = await ipcMain.invoke('world:orch:authorize', mine, { approve: true, stageId: 'A' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.alreadyAuthorized, true);
  assert.strictEqual(calls.refresh, 2);

  // 未知阶段走协议
  res = await ipcMain.invoke('world:orch:authorize', mine, { approve: true, stageId: 'ZZ' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.problems[0].code, 'stage-unknown');
});

test('learn：list 只读 learnRoot 内卡；open 越界被拦；缺文件给协议', async () => {
  const cardsDir = path.join(LEARN_DIR, 'demo-proj', 'cards');
  fs.mkdirSync(cardsDir, { recursive: true });
  const cardBody = '# 卡一\n\n学习卡正文。\n';
  fs.writeFileSync(path.join(cardsDir, 'card-one.md'), cardBody);
  const { ipcMain, mine, calls } = makeHarness();

  let res = await ipcMain.invoke('world:learn:list', mine);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.root, path.resolve(LEARN_DIR));
  const card = res.cards.find((c) => c.file.endsWith('card-one.md'));
  assert.ok(card, '应列出 learnRoot 内的卡');
  assert.strictEqual(card.title, 'card-one', '无 frontmatter 时标题回落文件名');
  assert.strictEqual(card.kind, 'note');
  assert.ok(card.mtime, 'mtime 不得为空');

  res = await ipcMain.invoke('world:learn:open', mine, '/etc/passwd');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.problems[0].code, 'path-not-allowed');

  res = await ipcMain.invoke('world:learn:open', mine, path.join(cardsDir, 'missing.md'));
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.problems[0].code, 'learn-file-missing');
  assert.strictEqual(calls.shell.length, 0, '被拦请求不得触达 shell');

  res = await ipcMain.invoke('world:learn:open', mine, path.join(cardsDir, 'card-one.md'));
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(calls.shell, [['openPath', path.join(cardsDir, 'card-one.md')]]);
});
