// test/world-milestone-prompt.test.js
// desktop-world · ticket 12：阶段/里程碑关闭后的清理提示与账本。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mp = require('../world/cleanup/milestone-prompt');
const { cleanupRoot, projectSlug } = require('../world/cleanup/paths');

const NOW = new Date('2026-10-18T12:00:00.000Z');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milestone-prompt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function roadmap(stages, milestone = 'M1') {
  return {
    milestone,
    stages: stages.map((s) => ({
      id: s.id,
      title: s.title || s.id,
      authorized: true,
      subtasks: (s.subtasks || []).map((t) => ({
        id: t.id,
        title: t.title || t.id,
        windowState: t.windowState || 'closed',
      })),
    })),
  };
}

test('阶段未全关时不提示；阶段关闭后提示一次且可去创建提案', (t) => {
  const orchRoot = tmp(t);
  const projectPath = '/projects/demo';
  const rm = roadmap([
    { id: 'S1', subtasks: [{ id: 'S1.1', windowState: 'closed' }, { id: 'S1.2', windowState: 'review' }] },
    { id: 'S2', subtasks: [{ id: 'S2.1', windowState: 'execution' }] },
  ]);
  assert.deepEqual(mp.evaluateClose({ orchRoot, roadmap: rm, stageId: 'S1', subtaskId: 'S1.1', projectPath, root: path.join(orchRoot, 'cleanup'), now: () => NOW }), []);

  rm.stages[0].subtasks[1].windowState = 'closed';
  const prompts = mp.evaluateClose({ orchRoot, roadmap: rm, stageId: 'S1', subtaskId: 'S1.2', projectPath, root: path.join(orchRoot, 'cleanup'), now: () => NOW });
  assert.equal(prompts.length, 1);
  const p = prompts[0];
  assert.equal(p.kind, 'stage');
  assert.equal(p.trigger, 'auto');
  assert.equal(p.autoExecute, false);
  assert.equal(p.stageId, 'S1');
  assert.equal(p.navigate.view, 'cleanup');
  assert.equal(p.navigate.projectPath, projectPath);
  assert.equal(p.navigate.hasProposal, false);
  assert.equal(p.navigate.action, 'create-proposal');
  assert.match(p.message, /阶段/);
  assert.match(p.message, /不会自动删除/);

  // 重开再关：同一阶段不重复提示
  assert.deepEqual(mp.evaluateClose({ orchRoot, roadmap: rm, stageId: 'S1', subtaskId: 'S1.2', projectPath, root: path.join(orchRoot, 'cleanup'), now: () => NOW }), []);
  assert.equal(mp.listPrompts(orchRoot).length, 1);
  assert.equal(fs.statSync(mp.ledgerFile(orchRoot)).mode & 0o777, 0o600);
});

test('全部阶段关闭时升级为里程碑提示，同一里程碑不重复', (t) => {
  const orchRoot = tmp(t);
  const root = path.join(orchRoot, 'cleanup');
  const open = roadmap([
    { id: 'S1', subtasks: [{ id: 'S1.1' }] },
    { id: 'S2', subtasks: [{ id: 'S2.1', windowState: 'execution' }] },
  ]);
  assert.equal(mp.evaluateClose({ orchRoot, roadmap: open, stageId: 'S1', subtaskId: 'S1.1', projectPath: '/p', root, now: () => NOW }).length, 1);

  open.stages[1].subtasks[0].windowState = 'closed';
  const prompts = mp.evaluateClose({ orchRoot, roadmap: open, stageId: 'S2', subtaskId: 'S2.1', projectPath: '/p', root, now: () => NOW });
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].kind, 'milestone');
  assert.equal(prompts[0].key, 'milestone:M1');
  assert.match(prompts[0].message, /里程碑/);

  // 重开再关整条里程碑：不重复
  open.stages[1].subtasks[0].windowState = 'execution';
  assert.equal(mp.evaluateClose({ orchRoot, roadmap: open, stageId: 'S2', subtaskId: 'S2.1', projectPath: '/p', root, now: () => NOW }).length, 0);
  open.stages[1].subtasks[0].windowState = 'closed';
  assert.equal(mp.evaluateClose({ orchRoot, roadmap: open, stageId: 'S2', subtaskId: 'S2.1', projectPath: '/p', root, now: () => NOW }).length, 0);
});

test('已有清理提案时提示跳转到最新提案目录', (t) => {
  const orchRoot = tmp(t);
  const root = path.join(orchRoot, 'cleanup');
  const projectPath = '/projects/demo';
  const base = path.join(cleanupRoot(root), projectSlug(projectPath));
  fs.mkdirSync(path.join(base, '2026-10-01'), { recursive: true });
  fs.writeFileSync(path.join(base, '2026-10-01', 'proposal.json'), JSON.stringify({ proposalId: 'cleanup-demo-2026-10-01' }));
  fs.mkdirSync(path.join(base, '2026-10-18'), { recursive: true });
  fs.writeFileSync(path.join(base, '2026-10-18', 'scan.json'), '{}'); // 只有扫描，不算提案

  const rm = roadmap([{ id: 'S1', subtasks: [{ id: 'S1.1' }] }]);
  const [p] = mp.evaluateClose({ orchRoot, roadmap: rm, stageId: 'S1', subtaskId: 'S1.1', projectPath, root, now: () => NOW });
  assert.equal(p.navigate.hasProposal, true);
  assert.equal(p.navigate.action, 'open-proposal');
  assert.equal(p.navigate.proposalId, 'cleanup-demo-2026-10-01');
  assert.equal(p.navigate.proposalDir, path.join(base, '2026-10-01'));
});

test('手动触发不受里程碑状态影响，且每次记账', (t) => {
  const orchRoot = tmp(t);
  const root = path.join(orchRoot, 'cleanup');
  const a = mp.manualPrompt({ orchRoot, milestone: 'M1', projectPath: '/p', root, now: () => NOW });
  const b = mp.manualPrompt({ orchRoot, milestone: 'M1', projectPath: '/p', root, now: () => NOW });
  assert.notEqual(a.key, b.key);
  assert.equal(a.trigger, 'manual');
  assert.equal(b.trigger, 'manual');
  assert.equal(mp.listPrompts(orchRoot).length, 2);

  // 没有项目时引导去选项目
  const c = mp.manualPrompt({ orchRoot, milestone: 'M1', root, now: () => NOW });
  assert.equal(c.navigate.action, 'select-project');
  assert.equal(c.navigate.projectPath, null);
});

test('账本损坏时回退为空账本，不影响再次提示', (t) => {
  const orchRoot = tmp(t);
  fs.writeFileSync(path.join(orchRoot, 'milestone-prompts.json'), '{broken');
  assert.deepEqual(mp.listPrompts(orchRoot), []);
  const rm = roadmap([{ id: 'S1', subtasks: [{ id: 'S1.1' }] }]);
  assert.equal(mp.evaluateClose({ orchRoot, roadmap: rm, stageId: 'S1', subtaskId: 'S1.1', projectPath: '/p', root: path.join(orchRoot, 'cleanup'), now: () => NOW }).length, 1);
  assert.equal(mp.listPrompts(orchRoot).length, 1);
});
