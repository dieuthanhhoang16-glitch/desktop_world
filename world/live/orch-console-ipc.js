// world/live/orch-console-ipc.js
// desktop-world · 编排台 R2 主进程 IPC 接线（P1B）：console 快照 / 执行器 run·steer /
// 产物与日志 / 角色卡 / 学习卡 / roadmap·授权·回执账本，全通道挂 world:orch:* 前缀
// （角色卡与学习卡挂自己的 world:roles:* / world:learn:*）。
//
// 纪律（与 live.js 编排写入口同源）：
//   ① handler 只做三件事：本窗守卫（ok(e)）、入参白名单、写类动作成功后 refresh()。
//      闸门/账本写序/围栏全部在 executor/actions/stage-lead/roles-cards 层，不在此复制。
//   ② 错误协议逐字段透传（{ok:false, problems:[{code,reason,fix}]}），不吞 reason/fix。
//   ③ 顶层不许 require('electron')——node --test 要能直接 require 本文件；
//      shell/executor 一律注入，缺省时在使用处懒建。
//   ④ 路径白名单：reveal/learn-open 只放行渲染层该碰的根（见 revealRoots/learnInside），
//      渲染层传进来的字符串一律当不可信输入。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { ORCH_DIR, ticketsFile, blackboardFile, roadmapFile } = require('../orch/paths');
const store = require('../orch/store');
const blackboard = require('../orch/blackboard');
const roadmap = require('../orch/roadmap');
const reports = require('../orch/reports');
const stageLead = require('../orch/stage-lead');
const llmPrefs = require('../orch/llm-prefs');
const { buildConsoleSnapshot } = require('../orch/console-snapshot');
const launcher = require('../roles/launcher');
const defaultCards = require('../roles/cards');
const defaultLearn = require('../learn/index');
const learnPaths = require('../learn/paths');
const projectsRegistry = require('../projects/registry');

const TICKET_ID_RE = /^ORCH-\d{3,}$/;
const RUNLOG_TAIL_DEFAULT = 64 * 1024;
const RUNLOG_TAIL_MAX = 256 * 1024;
// 渲染产物 reveal 白名单的 outDir：与 world/live/preview.js 同一来源
const OUT_DIR = process.env.WORLD_OUT_DIR || path.join(os.homedir(), '.desktop-world', 'out');

function problem(code, reason, fix) {
  return { code, reason, fix };
}

function fail(code, reason, fix) {
  return { ok: false, problems: [problem(code, reason, fix)] };
}

/** 外窗伪造：措辞与 live.js orchBad 逐字对齐。 */
function windowMismatch() {
  return fail('window-mismatch', '写请求不是组件窗发出的', '在桌面组件的调度树里操作');
}

/** runDir 内定点文件的尾部读取；符号链接越出 runDir 的一律不跟（返回空）。 */
function readLogTail(runDir, name, tailBytes) {
  try {
    const file = path.join(runDir, name);
    if (fs.lstatSync(file).isSymbolicLink()) {
      const base = fs.realpathSync(runDir);
      const resolved = fs.realpathSync(file);
      const rel = path.relative(base, resolved);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return '';
    }
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - tailBytes);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, size - start, start);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function readReceiptRaw(runDir) {
  try {
    return fs.readFileSync(path.join(runDir, 'receipt.json'), 'utf8');
  } catch {
    return '';
  }
}

/** 最新 run：按 startedAt 取最新（字符串 ISO 序即可比）。 */
function latestRunOf(runs, ticketId) {
  let best = null;
  for (const r of runs || []) {
    if (!r || r.ticketId !== ticketId) continue;
    if (!best || String(r.startedAt || '') > String(best.startedAt || '')) best = r;
  }
  return best;
}

/**
 * 注册编排台 R2 的全部 IPC 通道。
 * @param {object} opts
 * @param {object} opts.ipcMain   Electron ipcMain（测试注入假实现）
 * @param {Function} opts.ok      live.js 的本窗守卫：sender 必须是本窗 webContents
 * @param {Function} opts.refresh 写类动作成功后的定向重推（refreshOrchView）
 * @param {object} [opts.shell]   electron shell（缺省在使用处懒 require）
 * @param {object} [opts.executor] 注入执行器（测试）；缺省懒建 createExecutor({})
 * @param {object} [opts.rolesCards] 角色卡模块（测试注入）；缺省 world/roles/cards
 * @param {object} [opts.learn]   学习卡模块（测试注入）；缺省 world/learn/index
 */
function registerOrchConsoleIpc(opts = {}) {
  const ipcMain = opts.ipcMain;
  if (!ipcMain || typeof ipcMain.handle !== 'function') throw new Error('registerOrchConsoleIpc requires ipcMain');
  const ok = typeof opts.ok === 'function' ? opts.ok : () => false;
  const refresh = typeof opts.refresh === 'function' ? opts.refresh : () => {};
  const cards = opts.rolesCards || defaultCards;
  const learn = opts.learn || defaultLearn;

  const onRunEvent = (ev) => {
    // stdout 事件不触发 refresh——防刷屏；start/done 才推进状态
    if (ev && (ev.kind === 'start' || ev.kind === 'done')) refresh();
  };

  let sharedExecutor = null;
  /** 生产缺省：懒建真执行器（真 actions/launcher/默认 root），建后 sweep + 订阅 run 事件。 */
  function getExecutor() {
    if (opts.executor) return opts.executor;
    if (!sharedExecutor) {
      const { createExecutor } = require('../orch/executor');
      sharedExecutor = createExecutor({});
      sharedExecutor.sweep();
      if (typeof sharedExecutor.on === 'function') sharedExecutor.on('run', onRunEvent);
    }
    return sharedExecutor;
  }
  // 注入的执行器若是 EventEmitter 同样订阅（生产路径的刷新节奏不该因注入而丢）；sweep 只归懒建分支
  if (opts.executor && typeof opts.executor.on === 'function') {
    opts.executor.on('run', onRunEvent);
  }

  function getShell() {
    if (opts.shell) return opts.shell;
    return require('electron').shell; // 懒加载：本文件顶层不碰 electron（测试可直 require）
  }

  /** 角色 run 根：注入 executor 用它的，否则 launcher 默认（WORLD_ROLES_DIR / ~/.desktop-world/roles）。 */
  function rolesRootOf() {
    try {
      const exec = getExecutor();
      if (exec && exec.rolesRoot) return String(exec.rolesRoot);
    } catch {
      /* 执行器没建好不影响角色卡读写 */
    }
    return launcher.rolesRoot();
  }

  /** run 缺省 model 的兜底：卡内「- 默认模型：」行（角色 tab 编辑后的真源），读不到再让 executor 用编译默认。 */
  function fallbackModel(ticketId, role) {
    try {
      let roleId = typeof role === 'string' && role ? role : '';
      if (!roleId) {
        // 与 executor.resolveRole 同口径：agent=ds/glm 用之，jev/空 → glm，其余不硬猜
        const ledger = store.load(ticketsFile(ORCH_DIR));
        const t = ledger.tickets.find((x) => x.id === ticketId);
        const agent = String((t && t.agent) || '').trim();
        if (agent === 'ds' || agent === 'glm') roleId = agent;
        else if (agent === 'jev' || !agent) roleId = 'glm';
      }
      if (!roleId) return undefined;
      return cards.readRoleModel({ root: rolesRootOf(), id: roleId }) || undefined;
    } catch {
      return undefined;
    }
  }

  /** reveal 路径白名单根：roles runs/、编排账本目录、outDir、已注册项目。 */
  function revealRoots() {
    const roots = [path.join(rolesRootOf(), 'runs'), ORCH_DIR, OUT_DIR];
    for (const p of projectsRegistry.listProjects()) {
      if (p && p.path) roots.push(p.path);
    }
    return roots;
  }

  function learnInside(abs) {
    const base = path.resolve(learnPaths.learnRoot());
    return abs === base || abs.startsWith(base + path.sep);
  }

  /** 统一外壳：本窗守卫 + 异常折成错误协议（正常路径的错误由各层自带协议透传）。 */
  function guarded(fn) {
    return async (e, ...args) => {
      if (!ok(e)) return windowMismatch();
      try {
        return await fn(e, ...args);
      } catch (err) {
        return fail('internal-error', `编排台 IPC 内部错误：${err && err.message ? err.message : err}`, '保留现场提 issue——下层本应吞掉异常');
      }
    };
  }

  // ---------------------------------------------------------------- world:orch:*

  // 编排台唯一数据源：快照组装（账本 + 执行器 run + roadmap 切片 + JEV 状态 + 黑板）
  ipcMain.handle('world:orch:console', guarded(() => {
    const exec = getExecutor();
    let jevStatus = null;
    try {
      jevStatus = llmPrefs.llmStatus({});
    } catch {
      /* JEV 状态只读装饰面，读不到不挡快照 */
    }
    const snapshot = buildConsoleSnapshot({
      tickets: store.list(ticketsFile(ORCH_DIR)),
      runs: exec.list(),
      roadmapSlice: stageLead.windowStatus({ root: ORCH_DIR }),
      jevStatus,
      blackboardFacts: blackboard.list(blackboardFile(ORCH_DIR)),
    });
    // 双形状返回：顶层展开快照字段（orchestra 台的 console() 直接读 res.lanes），
    // 同时保留 snapshot 键（既有消费方/测试按 {ok,snapshot} 读）。
    return {
      ok: true,
      lanes: snapshot.lanes,
      counts: snapshot.counts,
      runs: snapshot.runs,
      roadmap: snapshot.roadmap,
      jev: snapshot.jev,
      invoices: snapshot.invoices,
      summary: snapshot.summary,
      snapshot,
    };
  }));

  ipcMain.handle('world:orch:run', guarded(async (_e, id, runOpts) => {
    const o = runOpts && typeof runOpts === 'object' ? runOpts : {};
    const pass = {};
    if (typeof o.role === 'string' && o.role) pass.role = o.role;
    if (Number.isFinite(o.timeoutMs) && o.timeoutMs > 0) pass.timeoutMs = o.timeoutMs;
    if (o.model != null) pass.model = String(o.model);
    else {
      const m = fallbackModel(String(id || ''), pass.role);
      if (m) pass.model = m;
    }
    const res = await getExecutor().runTicket(String(id || ''), pass);
    if (res && res.ok) refresh();
    return res;
  }));

  ipcMain.handle('world:orch:runs', guarded(() => ({ ok: true, runs: getExecutor().list() })));

  ipcMain.handle('world:orch:steer', guarded(async (_e, runId, text) => {
    const res = await getExecutor().steer(String(runId || ''), String(text == null ? '' : text), {});
    if (res && res.ok) refresh();
    return res;
  }));

  // 运行日志：stdout/stderr 尾部（默认 64KB，上限 256KB）+ receipt 原文；纯只读
  ipcMain.handle('world:orch:runLog', guarded((_e, runId, tailBytes) => {
    const id = String(runId || '');
    const run = getExecutor().list().find((r) => r.runId === id);
    if (!run) {
      return fail('run-not-found', `找不到 run：${id}`, 'run 目录可能已被清理；列表里的 runId 以 runs/ 落盘为准');
    }
    const runDir = run.runDir || launcher.runDirs(rolesRootOf(), id).runDir;
    const tail = Number.isFinite(Number(tailBytes)) && Number(tailBytes) > 0
      ? Math.min(Number(tailBytes), RUNLOG_TAIL_MAX)
      : RUNLOG_TAIL_DEFAULT;
    return {
      ok: true,
      stdout: readLogTail(runDir, 'stdout.log', tail),
      stderr: readLogTail(runDir, 'stderr.log', tail),
      receipt: readReceiptRaw(runDir),
    };
  }));

  // 产物：有 run → worktree changedFiles 逐文件 stat；无 run → ticket.cwd/out/ 前 50 项
  ipcMain.handle('world:orch:artifacts', guarded((_e, id) => {
    const ticketId = String(id || '');
    const ticket = TICKET_ID_RE.test(ticketId) ? store.get(ticketsFile(ORCH_DIR), ticketId) : null;
    if (!ticket) {
      return fail('ticket-not-found', `找不到工单 ${ticketId}`, '可能已被删除；刷新编排台重试');
    }
    const run = latestRunOf(getExecutor().list(), ticketId);
    if (run) {
      const worktreeDir = String(run.worktreeDir || (run.worktree && run.worktree.path) || '');
      const files = [];
      for (const entry of Array.isArray(run.changedFiles) ? run.changedFiles : []) {
        const rel = String(entry || '');
        if (!rel) continue;
        const abs = worktreeDir ? path.resolve(worktreeDir, rel) : '';
        if (!abs || !launcher.isInside(abs, worktreeDir)) continue; // 越出 worktree 的条目跳过
        try {
          const st = fs.statSync(abs);
          files.push({ path: abs, rel, size: st.size, mtime: st.mtime.toISOString() });
        } catch {
          /* 文件已被删/不可读：跳过，不让产物面整体失败 */
        }
      }
      return { ok: true, files, runDir: String(run.runDir || ''), worktreeDir };
    }
    // 没跑过：fallback 列 ticket.cwd/out/（工单承诺的产物目录），前 50 项
    const outDir = path.join(String(ticket.cwd || ''), 'out');
    const files = [];
    try {
      for (const ent of fs.readdirSync(outDir, { withFileTypes: true }).slice(0, 50)) {
        const abs = path.join(outDir, ent.name);
        try {
          const st = fs.statSync(abs);
          files.push({ path: abs, rel: ent.name, size: st.isDirectory() ? 0 : st.size, mtime: st.mtime.toISOString(), isDirectory: st.isDirectory() });
        } catch {
          /* 单项读取失败跳过 */
        }
      }
    } catch {
      /* out/ 不存在：空列表，不报错 */
    }
    return { ok: true, files, runDir: '', worktreeDir: '' };
  }));

  // 打开所在目录：路径白名单（runs/ · 编排账本 · outDir · 已注册项目）
  ipcMain.handle('world:orch:reveal', guarded((_e, target) => {
    const abs = path.resolve(String(target || ''));
    if (!revealRoots().some((root) => launcher.isInside(abs, root))) {
      return fail('path-not-allowed', `路径不在可打开白名单内：${abs}`, '只能打开运行目录、产物目录、账本目录或已注册项目内的路径');
    }
    getShell().showItemInFolder(abs);
    return { ok: true };
  }));

  // 黑板速记：与 cli.js cmdNote 同源（kind=fact，只追加）
  ipcMain.handle('world:orch:note', guarded((_e, text) => {
    const body = String(text == null ? '' : text).trim();
    if (!body) return fail('note-empty', '速记内容是空的', '先在输入框里写一句再发');
    blackboard.append(blackboardFile(ORCH_DIR), { kind: 'fact', text: body });
    refresh();
    return { ok: true };
  }));

  // roadmap init/link：与 cli.js cmdRoadmap 同源一组函数（roadmap.load/saveAll/upsertSubtaskTickets/exampleRoadmap）
  ipcMain.handle('world:orch:roadmapInit', guarded((_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const file = roadmapFile(ORCH_DIR);
    const existing = roadmap.load(file);
    if (existing.stages.length) {
      return fail('roadmap-exists', `已有 roadmap（${existing.milestone || '(未命名)'}），不覆盖`, `要重来先手动删 ${file}`);
    }
    const body = p.example === true ? roadmap.exampleRoadmap() : roadmap.emptyRoadmap();
    roadmap.saveAll(file, body);
    refresh();
    return { ok: true, file, milestone: body.milestone || '', example: p.example === true };
  }));

  ipcMain.handle('world:orch:roadmapLink', guarded((_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const [stageId, subtaskId] = String(p.windowId || '').split('.');
    if (!stageId || !subtaskId) {
      return fail('window-id-invalid', `窗口号不合法：${p.windowId}`, '窗口号形如 A.a（阶段.子任务）');
    }
    const ticketIds = (Array.isArray(p.ticketIds) ? p.ticketIds : []).filter((t) => typeof t === 'string' && TICKET_ID_RE.test(t));
    try {
      const ids = roadmap.upsertSubtaskTickets(roadmapFile(ORCH_DIR), stageId, subtaskId, ticketIds);
      refresh();
      return { ok: true, windowId: `${stageId}.${subtaskId}`, ticketIds: ids };
    } catch (err) {
      return fail('window-unknown', String(err && err.message ? err.message : err), 'npm run world:orch -- roadmap 查看阶段与子任务');
    }
  }));

  // 阶段授权：UI 两步确认 = CLI readline 的 y，判定与写盘全在 stage-lead.authorize
  ipcMain.handle('world:orch:authorize', guarded((_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const res = stageLead.authorize(
      {
        approve: p.approve === true,
        note: typeof p.note === 'string' && p.note ? p.note : undefined,
        stageId: typeof p.stageId === 'string' && p.stageId ? p.stageId : undefined,
      },
      { root: ORCH_DIR },
    );
    if (res && res.ok && res.authorized === true) refresh();
    return res;
  }));

  // 回执账本：与 cli.js cmdReports 同一数据源（新在前，字段按 CLI 输出形状去噪）
  ipcMain.handle('world:orch:reports', guarded(() => ({
    ok: true,
    reports: reports.list(ORCH_DIR, { limit: 20 }).map((e) => ({
      id: e.id,
      at: e.at,
      windowId: e.window ? `${e.window.stageId}.${e.window.subtaskId}` : '',
      state: e.window ? e.window.state : '',
      verdict: e.verdict,
      boundarySummary: e.boundarySummary ? { passed: e.boundarySummary.passed, checked: e.boundarySummary.checked } : null,
      milestone: e.milestone,
    })),
  })));

  // ---------------------------------------------------------------- world:roles:*

  ipcMain.handle('world:roles:list', guarded(() => cards.listRoleCards({ root: rolesRootOf() })));

  ipcMain.handle('world:roles:save', guarded((_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const res = cards.saveRoleCard({
      root: rolesRootOf(),
      id: String(p.id || ''),
      cardBody: typeof p.cardBody === 'string' ? p.cardBody : undefined,
      model: typeof p.model === 'string' ? p.model : undefined,
    });
    if (res && res.ok) refresh();
    return res;
  }));

  // ---------------------------------------------------------------- world:learn:*

  ipcMain.handle('world:learn:list', guarded(() => ({
    ok: true,
    root: learnPaths.learnRoot(),
    cards: learn.readAllCards(learnPaths.learnRoot()).map((c) => {
      let mtime = null;
      try {
        mtime = fs.statSync(c.file).mtime.toISOString();
      } catch {
        /* 卡片在读列之间被删：mtime 置空 */
      }
      return {
        file: c.file,
        title: (c.meta && (c.meta.topic || c.meta.id)) || path.basename(c.file, '.md'),
        kind: (c.meta && c.meta.kind) || 'note',
        chars: String(c.body || '').length,
        mtime,
      };
    }),
  })));

  ipcMain.handle('world:learn:open', guarded(async (_e, file) => {
    const abs = path.resolve(String(file || ''));
    if (!learnInside(abs)) {
      return fail('path-not-allowed', `路径越出学习卡目录：${abs}`, '只能打开项目学习卡（learnRoot 内）的文件');
    }
    if (!fs.existsSync(abs)) {
      return fail('learn-file-missing', `学习卡不存在：${abs}`, '刷新学习卡列表后重试');
    }
    const err = await getShell().openPath(abs);
    if (err) return fail('open-failed', String(err), '文件可能被占用或系统没有默认打开方式');
    return { ok: true };
  }));
}

module.exports = { registerOrchConsoleIpc };
