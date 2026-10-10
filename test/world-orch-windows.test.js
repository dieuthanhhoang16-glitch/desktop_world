// test/world-orch-windows.test.js
// 三个任务窗口提示词模板的纯逻辑守门：确定性、协议字段在场、红线与九项清单在场。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const planning = require('../world/orch/planning-window');
const execution = require('../world/orch/execution-window');
const review = require('../world/orch/review-window');
const protocol = require('../world/orch/protocol');
const boundary = require('../world/orch/boundary-check');

const WINDOWS = [
  ['planning', planning],
  ['execution', execution],
  ['review', review],
];

function ctxFor(state) {
  return {
    header: protocol.windowHeader({ milestone: 'multi-agent-refactor', windowState: state }),
    stageTitle: 'A 协议与边界',
    subtaskTitle: 'protocol',
    tickets: [{ id: 'ORCH-001', title: '协议层' }, { id: 'ORCH-002', title: '边界清单' }],
  };
}

test('三个窗口各自命名且互不覆盖', () => {
  assert.equal(planning.NAME, 'planning-window');
  assert.equal(execution.NAME, 'execution-window');
  assert.equal(review.NAME, 'review-window');
});

for (const [state, mod] of WINDOWS) {
  test(`${mod.NAME}：窗口头四字段 + soleGoal + 关联工单 + 提交命令在场`, () => {
    const p = mod.buildPrompt(ctxFor(state));
    assert.ok(p.includes('currentMilestone: multi-agent-refactor'));
    assert.ok(p.includes(`currentWindowState: ${state}`));
    assert.ok(p.includes(protocol.windowGoalFor(state).soleGoal), 'soleGoal 必须原样在场');
    assert.ok(p.includes('ORCH-001 协议层') && p.includes('ORCH-002 边界清单'), '工单引用在场');
    assert.ok(p.includes('npm run world:orch -- report submit'), '回执提交命令在场');
  });

  test(`${mod.NAME}：九项边界清单逐项在场（缺一项就是假清单）`, () => {
    const p = mod.buildPrompt(ctxFor(state));
    for (const r of boundary.listRules()) {
      assert.ok(p.includes(r.id) && p.includes(r.label), `缺边界项 ${r.id}`);
    }
  });

  test(`${mod.NAME}：确定性——同一输入两次产出逐字相等，无时间戳无随机`, () => {
    assert.equal(mod.buildPrompt(ctxFor(state)), mod.buildPrompt(ctxFor(state)));
    assert.ok(!mod.buildPrompt(ctxFor(state)).includes(new Date().toISOString().slice(0, 10) + 'T'));
  });

  test(`${mod.NAME}：空 ctx 不炸（header/工单缺省有诚实的兜底文案）`, () => {
    const p = mod.buildPrompt({});
    assert.ok(p.includes('currentWindowState: planning'), '缺省回落 planning');
    const p2 = mod.buildPrompt({ header: protocol.windowHeader({ milestone: 'm', windowState: state }) });
    assert.match(p2, /暂未关联 ORCH 工单|world:orch plan/, '工单缺省必须有说明');
  });
}

test('窗口分工可区分：planning 禁写码 / execution 禁越界 / review 禁替修', () => {
  assert.match(planning.buildPrompt(ctxFor('planning')), /不修改任何业务代码/);
  assert.match(execution.buildPrompt(ctxFor('execution')), /不做下一任务的事/);
  assert.match(review.buildPrompt(ctxFor('review')), /不替 execution 修东西/);
});

test('closeout 复用 review 模板：closeout:true 换口径与提交命令', () => {
  const c = review.buildPrompt({ ...ctxFor('closeout'), closeout: true });
  assert.ok(c.includes('# Closeout 窗口'));
  assert.ok(c.includes('--state closeout'));
  assert.ok(c.includes('清理临时产物'));
  const r = review.buildPrompt(ctxFor('review'));
  assert.ok(r.includes('--state review'));
  assert.ok(!r.includes('--state closeout'), 'review 口径不得混入 closeout 命令');
});
