// test/world-orch-roadmap.test.js
// Stage B 三节一段：roadmap.js（读写/授权/窗口指针）、reports.js（回执账本）、
// stage-lead.js（老二裁定与落地）。纪律与 world-orch-store.test.js 同源：
// mkdtemp 临时 root，绝不碰真实 ~/.desktop-world。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { roadmapFile, ticketsFile, blackboardFile, reportsDir } = require('../world/orch/paths');
const roadmap = require('../world/orch/roadmap');
const reports = require('../world/orch/reports');
const boundary = require('../world/orch/boundary-check');
const lead = require('../world/orch/stage-lead');
const store = require('../world/orch/store');
const blackboard = require('../world/orch/blackboard');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dw-roadmap-'));
}

function allPassedChecklist() {
  return { version: 1, checkedAt: null, items: boundary.defaultChecklist().map((i) => ({ ...i, passed: true })) };
}

function reportFor(state, over = {}) {
  return {
    stageState: state,
    verdict: 'pass',
    deliverable: ['world/orch/protocol.js'],
    evidence: ['人工走查一遍'],
    risks: { blocker: [], nonBlocker: [] },
    boundaryCheck: allPassedChecklist(),
    blockingDecision: { blocker: '', blocksStageClose: false, blocksNextStage: false },
    recommendedNextStep: '',
    ...over,
  };
}

function seedRoadmap(root, over = {}) {
  const rm = {
    version: 1,
    milestone: 'test-milestone',
    stages: [
      {
        id: 'A', title: '协议与边界', authorized: true,
        subtasks: [
          { id: 'a', title: 'protocol', windowState: 'planning', ticketIds: [] },
          { id: 'b', title: 'boundary', windowState: 'planning', ticketIds: [] },
        ],
      },
      {
        id: 'B', title: '存储与裁定', authorized: false,
        subtasks: [{ id: 'a', title: 'roadmap', windowState: 'planning', ticketIds: [] }],
      },
    ],
    activeWindow: { stageId: 'A', subtaskId: 'a' },
    ...over,
  };
  roadmap.saveAll(roadmapFile(root), rm);
  return roadmap.load(roadmapFile(root));
}

// ===================== roadmap =====================

test('roadmap：缺失/损坏文件回空 roadmap，永不抛', () => {
  const root = tmpRoot();
  assert.deepEqual(roadmap.load(roadmapFile(root)), roadmap.emptyRoadmap());
  fs.writeFileSync(roadmapFile(root), '{broken json');
  assert.deepEqual(roadmap.load(roadmapFile(root)), roadmap.emptyRoadmap());
  fs.writeFileSync(roadmapFile(root), '["array"]');
  assert.deepEqual(roadmap.load(roadmapFile(root)).stages, []);
});

test('roadmap：saveAll 收形+排序+0600；非法 windowState 归 planning；悬空指针归 null', () => {
  const root = tmpRoot();
  const file = roadmapFile(root);
  roadmap.saveAll(file, {
    milestone: 'm\n带换行',
    activeWindow: { stageId: 'Z', subtaskId: 'z' }, // 悬空
    stages: [
      { id: 'B', title: 'b', authorized: 1, subtasks: [] },
      {
        id: 'A', title: 'a', authorized: true,
        subtasks: [
          { id: 'b', title: 'x', windowState: 'weird', ticketIds: ['ORCH-002', 'garbage', 'ORCH-001', 'ORCH-002'] },
          { id: 'a', title: 'y', windowState: 'review', ticketIds: [] },
        ],
      },
    ],
  });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'roadmap 必须 0600');
  const rm = roadmap.load(file);
  assert.equal(rm.milestone, 'm 带换行');
  assert.deepEqual(rm.stages.map((s) => s.id), ['A', 'B'], '阶段按 id 排序');
  assert.deepEqual(rm.stages[0].subtasks.map((t) => t.id), ['a', 'b'], '子任务按 id 排序');
  assert.equal(rm.stages[0].subtasks[1].windowState, 'planning', '非法状态归 planning');
  assert.deepEqual(rm.stages[0].subtasks[1].ticketIds, ['ORCH-001', 'ORCH-002'], '工单 id 白名单+去重+排序');
  assert.equal(rm.stages[1].authorized, false, 'authorized 只认字面 true');
  assert.equal(rm.activeWindow, null, '悬空活跃窗口指针归 null');
});

test('roadmap：setActiveWindow 唯一指针；未知目标抛；null 清指针', () => {
  const root = tmpRoot();
  const file = roadmapFile(root);
  seedRoadmap(root);
  roadmap.setActiveWindow(file, 'B', 'a');
  assert.deepEqual(roadmap.load(file).activeWindow, { stageId: 'B', subtaskId: 'a' });
  assert.throws(() => roadmap.setActiveWindow(file, 'B', 'zzz'), /找不到子任务/);
  roadmap.setActiveWindow(file, null);
  assert.equal(roadmap.load(file).activeWindow, null);
});

test('roadmap：setWindowState 过协议迁移表，非法迁移抛（与 store.setStatus 同纪律）', () => {
  const root = tmpRoot();
  const file = roadmapFile(root);
  seedRoadmap(root);
  roadmap.setWindowState(file, 'A', 'a', 'execution');
  assert.equal(roadmap.load(file).stages[0].subtasks[0].windowState, 'execution');
  assert.throws(() => roadmap.setWindowState(file, 'A', 'a', 'closed'), /非法窗口状态迁移/);
  assert.throws(() => roadmap.setWindowState(file, 'A', 'a', 'nope'), /非法窗口状态/);
  assert.throws(() => roadmap.setWindowState(file, 'C', 'a', 'review'), /找不到子任务/);
});

test('roadmap：authorize/deauthorize 与 requireAuthorization（闸门三态）', () => {
  const root = tmpRoot();
  const file = roadmapFile(root);
  const rm = seedRoadmap(root);

  assert.equal(roadmap.requireAuthorization(rm, 'A'), null, 'A 已授权');
  const pB = roadmap.requireAuthorization(rm, 'B');
  assert.equal(pB.code, 'stage-not-authorized');
  assert.equal(roadmap.requireAuthorization(rm, 'Z').code, 'stage-unknown');

  roadmap.authorizeStage(file, 'B');
  assert.equal(roadmap.requireAuthorization(roadmap.load(file), 'B'), null);
  roadmap.deauthorizeStage(file, 'A');
  assert.equal(roadmap.requireAuthorization(roadmap.load(file), 'A').code, 'stage-not-authorized');
  assert.throws(() => roadmap.authorizeStage(file, 'Z'), /找不到阶段/);
});

test('roadmap：upsertSubtaskTickets 白名单收形；windowOf/allTicketIds 派生正确', () => {
  const root = tmpRoot();
  const file = roadmapFile(root);
  seedRoadmap(root);
  const ids = roadmap.upsertSubtaskTickets(file, 'A', 'a', ['ORCH-002', 'bad', 'ORCH-001']);
  assert.deepEqual(ids, ['ORCH-001', 'ORCH-002']);
  assert.throws(() => roadmap.upsertSubtaskTickets(file, 'A', 'zzz', ['ORCH-001']), /找不到子任务/);

  const rm = roadmap.load(file);
  const win = roadmap.windowOf(rm);
  assert.equal(win.stageId, 'A');
  assert.equal(win.subtaskId, 'a');
  assert.equal(win.state, 'planning');
  assert.deepEqual(win.ticketIds, ['ORCH-001', 'ORCH-002']);
  assert.deepEqual(roadmap.allTicketIds(rm), ['ORCH-001', 'ORCH-002']);
  assert.equal(roadmap.windowOf(roadmap.emptyRoadmap()), null);
});

// ===================== reports =====================

test('reports：文件名确定性（注入时间与 nonce）， sanitize 拒非协议输入', () => {
  const n = reports.reportFileName(new Date('2026-10-10T01:02:03.456Z'), 0.5);
  assert.equal(n, '2026-10-10T01-02-03-456Z-8000.json');
  assert.equal(reports.sanitizeReport('garbage'), null);
  assert.equal(reports.sanitizeReport({ stageState: 'nope', verdict: 'pass' }), null);
  assert.ok(reports.sanitizeReport(reportFor('planning')), '合法回执过消毒');
});

test('reports：record 落盘 0600 + 永不抛；list 新→旧 + 窗口/milestone 过滤；latestFor', () => {
  const root = tmpRoot();
  const r1 = reports.record(root, reportFor('planning'), {
    at: '2026-10-10T01:00:00.000Z',
    milestone: 'm1',
    window: { stageId: 'A', subtaskId: 'a', state: 'planning' },
  });
  assert.equal(r1.ok, true);
  assert.equal(fs.statSync(r1.file).mode & 0o777, 0o600);
  assert.match(r1.id, /^r-2026-10-10T01:00:00/);

  // 手写一个更新的回执文件（避免依赖真实毫秒序）
  const newer = {
    id: 'r-2027', at: '2027-01-01T00:00:00.000Z', milestone: 'm2', verdict: 'fail',
    window: { stageId: 'B', subtaskId: 'a', state: 'planning' },
    report: reportFor('planning', { verdict: 'fail', deliverable: [] }),
    boundarySummary: { checked: 9, passed: 9, failed: [] },
  };
  fs.writeFileSync(path.join(reportsDir(root), '2027-01-01T00-00-00-000Z-aaaa.json'), JSON.stringify(newer), { mode: 0o600 });

  const all = reports.list(root);
  assert.equal(all.length, 2);
  assert.equal(all[0].id, 'r-2027', '新→旧');
  assert.equal(reports.list(root, { windowId: 'A.a' }).length, 1);
  assert.equal(reports.list(root, { milestone: 'm2' })[0].id, 'r-2027');
  assert.equal(reports.latestFor(root, 'A.a').id, r1.id);
  assert.equal(reports.latestFor(root, 'Z.z'), null);
  assert.deepEqual(reports.list('/nonexistent/root/path'), [], '不存在的 root 不抛');
});

test('reports：prune 只留 MAX_FILES；summaryForTree 投影形状；空目录回 null', () => {
  const root = tmpRoot();
  const dir = reportsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < reports.MAX_FILES + 3; i++) {
    const name = `2026-01-01T00-00-${String(i).padStart(3, '0')}-aa.json`;
    fs.writeFileSync(path.join(dir, name), '{}');
  }
  reports.prune(dir);
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.json')).length, reports.MAX_FILES);

  assert.equal(reports.summaryForTree(root), null);
  reports.record(root, reportFor('planning', {
    risks: { blocker: ['磁盘快满'], nonBlocker: [] },
    blockingDecision: { blocker: '磁盘快满', blocksStageClose: true, blocksNextStage: false },
    recommendedNextStep: '先清磁盘',
  }), { window: { stageId: 'A', subtaskId: 'a', state: 'planning' } });
  const s = reports.summaryForTree(root, { windowId: 'A.a' });
  assert.equal(s.windowId, 'A.a');
  assert.equal(s.verdict, 'pass');
  assert.equal(s.evidenceCount, 1);
  assert.equal(s.checklist.length, 9);
  assert.ok(s.checklist.every((c) => c.passed === true));
  assert.deepEqual(s.risks.blocker, ['磁盘快满']);
  assert.equal(s.blockingDecision.blocksStageClose, true);
  assert.equal(s.recommendedNextStep, '先清磁盘');
});

// ===================== stage-lead =====================

test('stage-lead.submitReport：空 roadmap 与无活跃窗口各有专属问题码', () => {
  const root = tmpRoot();
  const empty = lead.submitReport({ report: reportFor('planning') }, { root });
  assert.equal(empty.ok, false);
  assert.equal(empty.problems[0].code, 'roadmap-missing');

  seedRoadmap(root, { activeWindow: null });
  const none = lead.submitReport({ report: reportFor('planning') }, { root });
  assert.equal(none.problems[0].code, 'window-none-active');

  const unknown = lead.submitReport({ windowId: 'Z.z', report: reportFor('planning') }, { root });
  assert.equal(unknown.problems[0].code, 'window-unknown');
});

test('stage-lead.submitReport：协议问题透传 + 状态错配 + 边界必查 + 机器抽查', () => {
  const root = tmpRoot();
  seedRoadmap(root);

  const bad = lead.submitReport({ report: { stageState: 'x' } }, { root });
  assert.ok(bad.problems.some((p) => p.code === 'report-state-invalid'));

  const mismatch = lead.submitReport({ report: reportFor('execution') }, { root });
  assert.equal(mismatch.problems[0].code, 'report-state-mismatch', '窗口在 planning，回执报 execution 必须拒');

  const missing = lead.submitReport({ report: reportFor('planning', { boundaryCheck: { items: [{ id: 'scope', passed: true }] } }) }, { root });
  assert.ok(missing.problems.some((p) => p.code === 'boundary-item-missing'));

  const failed = lead.submitReport({
    report: reportFor('planning', { boundaryCheck: { items: boundary.defaultChecklist() } }),
  }, { root });
  assert.ok(failed.problems.some((p) => p.code === 'boundary-item-failed'));

  const fake = lead.submitReport({
    report: reportFor('planning', { evidence: [{ type: 'command', content: 'npm test 全绿', synthetic: true }] }),
  }, { root });
  assert.ok(fake.problems.some((p) => p.code === 'boundary-fake-evidence'));

  // fail 判定不要求边界全过（没通过什么，自然谈不上边界失守）
  const failOk = lead.submitReport({
    report: reportFor('planning', { verdict: 'fail', deliverable: [], boundaryCheck: { items: boundary.defaultChecklist() } }),
  }, { root });
  assert.equal(failOk.ok, true, failOk.ok ? '' : JSON.stringify(failOk.problems));
});

test('stage-lead.submitReport：合格回执归档 + 黑板 report 留痕', () => {
  const root = tmpRoot();
  seedRoadmap(root);
  const r = lead.submitReport({ report: reportFor('planning') }, { root });
  assert.equal(r.ok, true);
  assert.equal(r.windowId, 'A.a');
  assert.match(r.id, /^r-/);
  const latest = reports.latestFor(root, 'A.a');
  assert.equal(latest.verdict, 'pass');
  assert.equal(latest.report.stageState, 'planning');
  const bblog = blackboard.list(blackboardFile(root)).filter((e) => e.kind === 'report');
  assert.equal(bblog.length, 1);
  assert.match(bblog[0].text, /回执 A\.a planning verdict=pass 边界 9\/9/);
});

test('stage-lead.advanceWindow：裁定（只读）的关口顺序——无回执不过，齐了 readyForHuman', () => {
  const root = tmpRoot();
  seedRoadmap(root);

  const dry0 = lead.advanceWindow({ confirm: false }, { root });
  assert.equal(dry0.ok, true, '只读裁定永不失败返回');
  assert.equal(dry0.adjudication.readyForHuman, false);
  assert.ok(dry0.problems.some((p) => p.code === 'report-missing'));

  lead.submitReport({ report: reportFor('planning') }, { root });
  const dry1 = lead.advanceWindow({ confirm: false }, { root });
  assert.equal(dry1.adjudication.readyForHuman, true, JSON.stringify(dry1.problems));
  assert.equal(dry1.adjudication.next, 'execution');
  assert.equal(dry1.adjudication.boundary.passed, 9);
  // 只读裁定绝不写：窗口仍是 planning
  assert.equal(roadmap.load(roadmapFile(root)).stages[0].subtasks[0].windowState, 'planning');
});

test('stage-lead.advanceWindow：开工要求本阶段已人工授权', () => {
  const root = tmpRoot();
  seedRoadmap(root);
  roadmap.deauthorizeStage(roadmapFile(root), 'A');
  lead.submitReport({ report: reportFor('planning') }, { root });
  const dry = lead.advanceWindow({ confirm: false }, { root });
  assert.ok(dry.problems.some((p) => p.code === 'stage-not-authorized'));
  assert.equal(dry.adjudication.readyForHuman, false);
});

test('stage-lead.advanceWindow：confirm:true 落地推进 + 留痕；新问题挡新推进', () => {
  const root = tmpRoot();
  seedRoadmap(root);
  lead.submitReport({ report: reportFor('planning') }, { root });

  const done = lead.advanceWindow({ confirm: true }, { root });
  assert.equal(done.ok, true);
  assert.equal(done.to, 'execution');
  assert.equal(roadmap.load(roadmapFile(root)).stages[0].subtasks[0].windowState, 'execution');

  // 回执还是 planning 的——再推进就是旧回执冒充
  const stale = lead.advanceWindow({ confirm: false }, { root });
  assert.ok(stale.problems.some((p) => p.code === 'report-stale'));
  const blocked = lead.advanceWindow({ confirm: true }, { root });
  assert.equal(blocked.ok, false, '裁定不过 confirm:true 必须拒写');
  assert.equal(roadmap.load(roadmapFile(root)).stages[0].subtasks[0].windowState, 'execution', '拒写后状态不变');

  const log = blackboard.list(blackboardFile(root)).filter((e) => e.kind === 'report');
  assert.ok(log.some((e) => /窗口推进 A\.a planning→execution（人确认）/.test(e.text)));
});

test('stage-lead.advanceWindow：execution→review 要求关联工单全部 done（现读聚合）', () => {
  const root = tmpRoot();
  const file = roadmapFile(root);
  seedRoadmap(root);
  roadmap.setWindowState(file, 'A', 'a', 'execution');
  roadmap.upsertSubtaskTickets(file, 'A', 'a', ['ORCH-001']);
  store.appendTickets(ticketsFile(root), [{ id: 'ORCH-001', title: '协议层', status: 'running', agent: 'x', cwd: '/tmp' }]);

  lead.submitReport({ report: reportFor('execution', { deliverable: ['world/orch/protocol.js'] }) }, { root });
  const dry = lead.advanceWindow({ confirm: false }, { root });
  assert.ok(dry.problems.some((p) => p.code === 'ticket-not-done'));
  assert.equal(dry.adjudication.tickets.allDone, false);
  assert.deepEqual(dry.adjudication.tickets.offending, [{ id: 'ORCH-001', status: 'running' }]);

  store.patchTicket(ticketsFile(root), 'ORCH-001', { status: 'done' });
  const dry2 = lead.advanceWindow({ confirm: false }, { root });
  assert.equal(dry2.adjudication.readyForHuman, true, JSON.stringify(dry2.problems));
});

test('stage-lead.advanceWindow：planning→execution 时关联草案工单报警（ticket-still-draft）', () => {
  const root = tmpRoot();
  const file = roadmapFile(root);
  seedRoadmap(root);
  roadmap.upsertSubtaskTickets(file, 'A', 'a', ['ORCH-001']);
  store.appendTickets(ticketsFile(root), [{ id: 'ORCH-001', title: 'x', status: 'draft' }]);
  lead.submitReport({ report: reportFor('planning') }, { root });
  const dry = lead.advanceWindow({ confirm: false }, { root });
  assert.ok(dry.problems.some((p) => p.code === 'ticket-still-draft'));
});

test('stage-lead.advanceWindow：review 打回返工走回边（fail 回执是回边的燃料，不是前进的路障）', () => {
  const root = tmpRoot();
  const file = roadmapFile(root);
  seedRoadmap(root);
  roadmap.setWindowState(file, 'A', 'a', 'execution');
  roadmap.setWindowState(file, 'A', 'a', 'review');
  const fail = lead.submitReport({
    report: reportFor('review', { verdict: 'fail', deliverable: [], recommendedNextStep: 'protocol 漏了截断，回 execution 补' }),
  }, { root });
  assert.equal(fail.ok, true);

  const forward = lead.advanceWindow({ confirm: false }, { root });
  assert.ok(forward.problems.some((p) => p.code === 'report-verdict-failed'), 'fail 回执不许前进');

  const back = lead.advanceWindow({ confirm: true, to: 'execution' }, { root });
  assert.equal(back.ok, true);
  assert.equal(back.to, 'execution');
  assert.equal(roadmap.load(file).stages[0].subtasks[0].windowState, 'execution', '打回落到 execution');
});

test('stage-lead.advanceWindow：跨阶段关窗要求下一阶段已授权；关窗后指针走下一个子任务', () => {
  const root = tmpRoot();
  const file = roadmapFile(root);
  // 只留 A.a 在 closeout，下一个子任务在 B 阶段（未授权）
  seedRoadmap(root, {
    stages: [
      { id: 'A', title: 'a', authorized: true, subtasks: [{ id: 'a', title: 'x', windowState: 'closeout', ticketIds: [] }] },
      { id: 'B', title: 'b', authorized: false, subtasks: [{ id: 'a', title: 'y', windowState: 'planning', ticketIds: [] }] },
    ],
    activeWindow: { stageId: 'A', subtaskId: 'a' },
  });
  lead.submitReport({ report: reportFor('closeout') }, { root });

  const dry = lead.advanceWindow({ confirm: false }, { root });
  assert.ok(dry.problems.some((p) => p.code === 'stage-not-authorized'));
  assert.equal(dry.adjudication.authorization.nextStageId, 'B');

  roadmap.authorizeStage(file, 'B');
  const done = lead.advanceWindow({ confirm: true }, { root });
  assert.equal(done.ok, true, JSON.stringify(done.problems));
  assert.equal(done.to, 'closed');
  assert.deepEqual(done.nextWindow, { windowId: 'B.a', state: 'planning', stageTitle: 'b' });
  const rm = roadmap.load(file);
  assert.equal(rm.stages[0].subtasks[0].windowState, 'closed');
  assert.deepEqual(rm.activeWindow, { stageId: 'B', subtaskId: 'a' }, '关窗后活跃指针自动走下一个子任务');
});

test('stage-lead.advanceWindow：全程走通 planning→execution→review→closeout→closed', () => {
  const root = tmpRoot();
  seedRoadmap(root);
  const STATES = ['planning', 'execution', 'review', 'closeout'];
  STATES.forEach((state, i) => {
    // 注入递增时刻：同一毫秒连发回执时 latestFor 仍按申报时序取最新
    const sub = lead.submitReport({ report: reportFor(state), at: `2026-10-10T0${i + 1}:00:00.000Z` }, { root });
    assert.equal(sub.ok, true, `${state} 交回执失败：${JSON.stringify(sub.problems)}`);
    const adv = lead.advanceWindow({ confirm: true }, { root });
    assert.equal(adv.ok, true, `${state} 推进失败：${JSON.stringify(adv.problems)}`);
  });
  const rm = roadmap.load(roadmapFile(root));
  assert.equal(rm.stages[0].subtasks[0].windowState, 'closed');
  assert.deepEqual(rm.activeWindow, { stageId: 'A', subtaskId: 'b' }, '同阶段顺延到 A.b');
});

test('stage-lead.windowStatus：无 roadmap 回 null；有窗口给 UI 投影全字段', () => {
  const root = tmpRoot();
  assert.equal(lead.windowStatus({ root }), null);
  seedRoadmap(root);
  const ws = lead.windowStatus({ root });
  assert.equal(ws.windowId, 'A.a');
  assert.equal(ws.header.currentWindowState, 'planning');
  assert.equal(ws.header.currentMilestone, 'test-milestone');
  assert.equal(ws.color, '#3b82f6');
  assert.equal(ws.stateLabel, '规划');
  assert.equal(ws.roadmap.length, 2);
  assert.equal(ws.roadmap[0].authorized, true);
  assert.equal(ws.roadmap[0].subtasks[0].active, true);
  assert.equal(ws.latestReport, null, '没交过回执就是 null（UI 静默）');

  lead.submitReport({ report: reportFor('planning') }, { root });
  assert.equal(lead.windowStatus({ root }).latestReport.verdict, 'pass');
});
