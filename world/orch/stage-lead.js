// world/orch/stage-lead.js
// desktop-world · 老二（Stage Lead）：窗口关口裁定 + 回执核验。
//
// 老二的职责就三件，且全部可裁定、可审计：
//   ① 收回执（submitReport）：协议校验 → 九项边界 → 机器抽查 → 归档 → 黑板留痕
//   ② 裁定推进（advanceWindow confirm:false）：七道关只读裁定，给出 readyForHuman
//   ③ 落地推进（advanceWindow confirm:true）：人确认后写盘 + 黑板留痕
//
// 红线：本层**永不抛异常**（与 actions.js 同纪律），一切失败以
// {ok:false, problems:[{code,reason,fix}]} 表达；永不自动推进——confirm:true
// 才能写，且任何一道关不过都拒写（绝不半截落地）。
'use strict';

const { ORCH_DIR, ticketsFile, blackboardFile, roadmapFile } = require('./paths');
const protocol = require('./protocol');
const boundary = require('./boundary-check');
const roadmap = require('./roadmap');
const reportsMod = require('./reports');
const store = require('./store');
const blackboard = require('./blackboard');

function problem(code, reason, fix) {
  return { code, reason, fix };
}

function windowIdOf(win) {
  return `${win.stageId}.${win.subtaskId}`;
}

/** 黑板留痕：尽力而为，失败绝不反噬裁定结果。 */
function note(file, text, ticketIds = []) {
  try {
    blackboard.append(file, { kind: 'report', text, ticketIds });
  } catch {
    /* 留痕失败不挡正事，但绝不静默改状态（这里没状态可改，纯记录面） */
  }
}

/** 排序后展平的子任务序列里，当前窗口的下一个（跨阶段按阶段序走）。 */
function nextSubtaskOf(rm, stageId, subtaskId) {
  const flat = [];
  for (const s of rm.stages || []) {
    for (const t of s.subtasks || []) flat.push({ stageId: s.id, subtaskId: t.id, stageAuthorized: s.authorized });
  }
  const i = flat.findIndex((e) => e.stageId === stageId && e.subtaskId === subtaskId);
  return i >= 0 && i + 1 < flat.length ? flat[i + 1] : null;
}

function loadTickets(root) {
  try {
    return store.list(ticketsFile(root));
  } catch {
    return [];
  }
}

/**
 * ① 收回执。
 * @param payload {windowId?:'A.a', milestone?:string, report:{...协议字段}}
 * @param deps    {root}
 */
function submitReport(payload = {}, deps = {}) {
  const root = deps.root || ORCH_DIR;
  try {
    const rm = roadmap.load(roadmapFile(root));
    const active = roadmap.windowOf(rm);
    const isEmpty = !rm.stages.length;

    // 窗口解析：显式 windowId 优先，缺省取当前活跃窗口
    let win = active;
    if (payload.windowId) {
      const [stageId, subtaskId] = String(payload.windowId).split('.');
      const subtask = roadmap.findSubtask(rm, stageId, subtaskId);
      const stage = roadmap.findStage(rm, stageId);
      if (!stage || !subtask) {
        return { ok: false, problems: [problem('window-unknown', `roadmap 里没有窗口 ${payload.windowId}`, 'npm run world:orch -- roadmap 查看阶段与子任务')] };
      }
      win = { stageId, subtaskId, state: subtask.windowState, stageTitle: stage.title, subtaskTitle: subtask.title, ticketIds: subtask.ticketIds };
    }
    if (isEmpty && !win) {
      return { ok: false, problems: [problem('roadmap-missing', '还没有 roadmap——回执无处可归', 'npm run world:orch -- roadmap init')] };
    }
    if (!win) {
      return { ok: false, problems: [problem('window-none-active', '没有活跃窗口——先指定当前任务窗口再交回执', 'npm run world:orch -- roadmap 查看；用 --window A.a 显式指定')] };
    }

    // 协议校验（形状/类型/截断全在 protocol，问题码原样透传）
    const v = protocol.validateStageReport(payload.report);
    if (!v.ok) return { ok: false, problems: v.problems };
    const report = v.report;

    // 回执申报的状态必须就是窗口当前状态——拿旧状态的回执冒充现在的，是裁定面最常见的脏数据
    if (report.stageState !== win.state) {
      return {
        ok: false,
        problems: [problem(
          'report-state-mismatch',
          `回执 stageState=${report.stageState}，但窗口 ${windowIdOf(win)} 当前是 ${win.state}`,
          `核对--state；如果窗口已推进，先补交 ${win.state} 的回执`,
        )],
      };
    }

    // 九项边界：pass 系 verdict 必须逐项齐全且全过（机器抽查并入同一问题表）
    const problems = [
      ...boundary.validateChecklist(report.boundaryCheck.items, { requireAllPassed: protocol.verdictOkForAdvance(report.verdict) }),
      ...boundary.assertEvidenceConsistency(report),
    ];
    if (problems.length) return { ok: false, problems };

    const rec = reportsMod.record(root, report, {
      milestone: payload.milestone || rm.milestone,
      window: { stageId: win.stageId, subtaskId: win.subtaskId, state: win.state },
      at: payload.at, // 注入时钟（测试确定性；缺省取当前时刻）
    });
    if (!rec.ok) {
      return { ok: false, problems: [problem('report-record-failed', '回执落盘失败（磁盘/权限）', '检查 ~/.desktop-world/orch 可写后重交')] };
    }

    const sum = reportsMod.boundarySummaryOf(report);
    note(
      blackboardFile(root),
      `回执 ${windowIdOf(win)} ${report.stageState} verdict=${report.verdict} 边界 ${sum.passed}/${sum.checked}`,
      win.ticketIds || [],
    );
    return { ok: true, id: rec.id, windowId: windowIdOf(win), verdict: report.verdict };
  } catch (err) {
    return { ok: false, problems: [problem('stage-lead-error', `内部异常：${err && err.message ? err.message : err}`, '保留现场提 issue')] };
  }
}

/**
 * ②③ 裁定/落地推进。
 * @param payload {to?:目标态（默认前进方向）, confirm:boolean}
 * @param deps    {root, roadmapFile?}
 */
function adjudicate(deps = {}) {
  const root = deps.root || ORCH_DIR;
  const rm = roadmap.load(roadmapFile(root));
  const win = roadmap.windowOf(rm);
  const problems = [];

  const out = {
    current: win
      ? { windowId: windowIdOf(win), state: win.state, stageTitle: win.stageTitle, subtaskTitle: win.subtaskTitle }
      : null,
    next: null,
    verdict: null,
    boundary: { passed: 0, failed: [] },
    tickets: { linked: [], allDone: true, offending: [] },
    authorization: { authorized: true, nextStageId: null },
    readyForHuman: false,
  };

  if (!win) {
    problems.push(problem('window-none-active', '没有活跃窗口', 'npm run world:orch -- roadmap 查看并指定当前任务窗口'));
    return { problems, adjudication: out, rm, root, win };
  }

  const to = deps.to || protocol.nextWindowState(win.state);
  out.next = to;
  if (!to) {
    problems.push(problem('window-transition-invalid', `${win.state} 已是终态，无处可去`, 'closed 之后需要新窗口，回 roadmap 指定下个子任务'));
    return { problems, adjudication: out, rm, root, win };
  }
  if (!protocol.canTransitionWindow(win.state, to)) {
    problems.push(problem('window-transition-invalid', `非法窗口状态迁移：${win.state} → ${to}`, `合法去向：${(protocol.WINDOW_TRANSITIONS[win.state] || []).join(' / ') || '(无)'}`));
    return { problems, adjudication: out, rm, root, win };
  }

  const forward = to === protocol.nextWindowState(win.state);
  const winId = windowIdOf(win);
  const latest = reportsMod.latestFor(root, winId);
  out.verdict = latest ? latest.verdict : null;

  // 关③：任何方向都得有回执（回执是"讨论过这个状态"的物证）
  if (!latest) {
    problems.push(problem('report-missing', `窗口 ${winId} 还没有 ${win.state} 的回执`, `npm run world:orch -- report submit --state ${win.state} --file <json>`));
  } else if (!latest.report || latest.report.stageState !== win.state) {
    problems.push(problem('report-stale', `最新回执验证的是 ${latest.report ? latest.report.stageState : '?'}，不是当前状态 ${win.state}`, `先补交 --state ${win.state} 的回执`));
  } else if (forward) {
    // 前进：必须 pass 系 + 边界九项全过
    if (!protocol.verdictOkForAdvance(latest.verdict)) {
      problems.push(problem(
        latest.verdict === 'blocked' ? 'report-verdict-blocked' : 'report-verdict-failed',
        `最新回执 verdict=${latest.verdict}，不允许前进`,
        '回执里给出 recommendedNextStep，人改判后重交或走回边',
      ));
    }
    const items = latest.report.boundaryCheck ? latest.report.boundaryCheck.items : [];
    const norm = boundary.normalizeChecklist(items);
    out.boundary = { passed: norm.filter((i) => i.passed).length, failed: norm.filter((i) => !i.passed).map((i) => i.id) };
    problems.push(...boundary.validateChecklist(items, { requireAllPassed: true }));
  }

  // 关④：关联工单聚合（只在特定迁移查；永远现读，不缓存）
  const linked = win.ticketIds || [];
  const tickets = loadTickets(root);
  const byId = new Map(tickets.map((t) => [t.id, t]));
  out.tickets.linked = linked.slice();
  if (forward && win.state === 'execution' && to === 'review') {
    for (const id of linked) {
      const t = byId.get(id);
      if (!t || t.status !== 'done') {
        out.tickets.allDone = false;
        out.tickets.offending.push({ id, status: t ? t.status : 'missing' });
      }
    }
    for (const o of out.tickets.offending) {
      problems.push(problem('ticket-not-done', `关联工单 ${o.id} 还是 ${o.status} —— execution 收官要求关联工单全部 done`, '先收敛工单（world:orch converge），或确认它不属于本窗口再 unlink'));
    }
  }
  if (forward && win.state === 'planning' && to === 'execution') {
    for (const id of linked) {
      const t = byId.get(id);
      if (t && t.status === 'draft') {
        out.tickets.offending.push({ id, status: 'draft' });
        problems.push(problem('ticket-still-draft', `关联工单 ${id} 仍是草案——开工前需要人确认工单`, 'npm run world:orch -- confirm ' + id));
      }
    }
  }

  // 关⑤：授权。开工（planning→execution）要求本阶段已授权；关窗（closeout→closed）
  // 要求下一个子任务的阶段已授权（跨阶段才查，同阶段顺延）。
  if (forward && win.state === 'planning' && to === 'execution') {
    const p = roadmap.requireAuthorization(rm, win.stageId);
    if (p) {
      out.authorization = { authorized: false, nextStageId: win.stageId };
      problems.push(p);
    }
  }
  if (forward && win.state === 'closeout' && to === 'closed') {
    const nextSub = nextSubtaskOf(rm, win.stageId, win.subtaskId);
    if (nextSub && nextSub.stageId !== win.stageId) {
      const p = roadmap.requireAuthorization(rm, nextSub.stageId);
      if (p) {
        out.authorization = { authorized: false, nextStageId: nextSub.stageId };
        problems.push(p);
      }
    }
  }

  out.readyForHuman = problems.length === 0;
  return { problems, adjudication: out, rm, root, win, to, latest };
}

function advanceWindow(payload = {}, deps = {}) {
  const root = deps.root || ORCH_DIR;
  try {
    const { problems, adjudication, win, to } = adjudicate({ ...deps, root, to: payload.to });
    if (!payload.confirm) {
      // 只读裁定：永远 ok，结果交给人去拍板
      return { ok: true, adjudication, problems };
    }
    if (!win || problems.length) {
      return { ok: false, problems: problems.length ? problems : [problem('window-none-active', '没有活跃窗口', '先指定当前任务窗口')] };
    }
    // 全过才写，绝不半截
    const rmFile = roadmapFile(root);
    roadmap.setWindowState(rmFile, win.stageId, win.subtaskId, to);
    let nextWindow = null;
    if (to === 'closed') {
      const rmNow = roadmap.load(rmFile);
      const nextSub = nextSubtaskOf(rmNow, win.stageId, win.subtaskId);
      roadmap.setActiveWindow(rmFile, nextSub ? nextSub.stageId : null, nextSub ? nextSub.subtaskId : null);
      if (nextSub) {
        const rm2 = roadmap.load(rmFile);
        const st = roadmap.findStage(rm2, nextSub.stageId);
        nextWindow = { windowId: `${nextSub.stageId}.${nextSub.subtaskId}`, state: 'planning', stageTitle: st ? st.title : '' };
      }
    }
    note(blackboardFile(root), `窗口推进 ${windowIdOf(win)} ${win.state}→${to}（人确认）`, win.ticketIds || []);
    return { ok: true, from: { windowId: windowIdOf(win), state: win.state }, to, nextWindow, adjudication };
  } catch (err) {
    return { ok: false, problems: [problem('stage-lead-error', `内部异常：${err && err.message ? err.message : err}`, '保留现场提 issue')] };
  }
}

/**
 * 只读窗口快照（UI 五态条/窗口卡/回执面板的唯一数据源）。
 */
function windowStatus(deps = {}) {
  const root = deps.root || ORCH_DIR;
  try {
    const rm = roadmap.load(roadmapFile(root));
    const win = roadmap.windowOf(rm);
    if (!win) return null;
    const winId = windowIdOf(win);
    const tickets = loadTickets(root);
    const byId = new Map(tickets.map((t) => [t.id, t]));
    return {
      header: protocol.windowHeader({ milestone: rm.milestone, windowState: win.state }),
      window: win,
      windowId: winId,
      color: protocol.WINDOW_STATE_COLORS[win.state],
      stateLabel: protocol.WINDOW_STATE_LABELS[win.state],
      tickets: (win.ticketIds || []).map((id) => {
        const t = byId.get(id);
        return { id, status: t ? t.status : 'missing', title: t ? t.title || '' : '' };
      }),
      roadmap: (rm.stages || []).map((s) => ({
        id: s.id,
        title: s.title,
        authorized: s.authorized === true,
        subtasks: s.subtasks.map((t) => ({
          id: t.id,
          title: t.title,
          state: t.windowState,
          active: rm.activeWindow ? rm.activeWindow.stageId === s.id && rm.activeWindow.subtaskId === t.id : false,
        })),
      })),
      milestone: rm.milestone,
      latestReport: reportsMod.summaryForTree(root, { windowId: winId }),
    };
  } catch {
    return null;
  }
}

module.exports = { submitReport, advanceWindow, windowStatus };
