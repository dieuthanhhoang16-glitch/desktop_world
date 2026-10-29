// test/world-plan.test.js
// 学习计划：拓扑/阶段顺序、JEV 同层取舍、降级、时长区间、单日上限、重新规划差异、错误。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { generateCards, updateAfterTicket } = require('../world/learn/generate');
const { createPlan, readPlan, baseMinutes, rangeOf, planDays } = require('../world/learn/plan');
const { projectDir } = require('../world/learn/paths');

function tmpDir(prefix = 'dwplan-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(root, rel, body) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function makeProject(name = 'alpha') {
  const dir = path.join(tmpDir('dwplan-proj-'), name);
  fs.mkdirSync(dir, { recursive: true });
  write(dir, 'GLOSSARY.md', '# 术语表\n\n## 角色\n\n角色定义。\n\n## 权限\n\n权限边界。\n');
  write(dir, 'docs/agents/domain.md', '# 工单 拆分\n\n把工单拆成小任务。\n');
  write(dir, 'docs/adr/001-slim.md', '# 配置 减重\n\n清理过期配置。\n');
  write(dir, 'docs/plans/spec.md', '# 学习系统 设计\n\n设计学习卡。\n');
  write(dir, '.scratch/feat/issues/01.md', '# 01: 项目注册 + 只读初始化检查\n\n注册并检查。\n');
  return dir;
}

test('时长公式与单日上限：±25% 区间，多卡日基础时长 ≤120 分钟', () => {
  assert.equal(baseMinutes(0), 15);
  assert.equal(baseMinutes(2850), 25);
  assert.deepEqual(rangeOf(40), { low: 30, high: 50 });

  const items = [
    { id: 'a', minutes: { base: 60, low: 45, high: 75 } },
    { id: 'b', minutes: { base: 60, low: 45, high: 75 } },
    { id: 'c', minutes: { base: 60, low: 45, high: 75 } },
    { id: 'd', minutes: { base: 150, low: 113, high: 188 } },
  ];
  const days = planDays(items);
  assert.deepEqual(days.map((d) => d.cards), [['a', 'b'], ['c'], ['d']]);
});

test('生成计划：术语/标准/ADR/spec/ticket 分层，plan.md 记录顺序、区间、前置与输入', async () => {
  const project = makeProject();
  const root = tmpDir('dwplan-root-');
  await generateCards({ projectPath: project, root });

  const result = await createPlan({
    projectPath: project,
    root,
    now: () => new Date('2026-10-18T00:00:00Z'),
  });
  assert.equal(result.ok, true);
  assert.equal(result.ordering.mode, 'deterministic');
  assert.ok(result.plan.cards.length >= 6);

  const topics = result.plan.cards.map((c) => c.topic);
  const idx = (t) => topics.indexOf(t);
  assert.ok(idx('角色 理解') < idx('工单 拆分'));
  assert.ok(idx('工单 拆分') < idx('项目注册 实现'));
  assert.ok(idx('配置 减重') < idx('项目注册 实现'));

  for (const c of result.plan.cards) {
    assert.ok(c.minutes.low <= c.minutes.base && c.minutes.base <= c.minutes.high);
    assert.ok(c.minutes.low >= 1);
    assert.ok(c.file.startsWith(root));
  }
  assert.ok(result.plan.totalMinutes.low > 0);

  const md = fs.readFileSync(result.planPath, 'utf8');
  assert.match(md, /# 学习计划 · alpha/);
  assert.match(md, /生成时间：2026-10-18T00:00:00.000Z/);
  assert.match(md, /## 输入/);
  assert.match(md, /前置/);
  assert.match(md, /## 第 1 天/);
  const json = JSON.parse(fs.readFileSync(result.jsonPath, 'utf8'));
  assert.equal(json.inputs.cards.length, result.plan.cards.length);
  assert.equal(json.ordering.mode, 'deterministic');
  assert.equal(json.dailyCapMinutes, 120);
});

test('JEV 同层取舍：按概率排序并记录模型；JEV 不可用退化为确定性', async () => {
  const project = makeProject();
  const root = tmpDir('dwplan-root-');
  await generateCards({ projectPath: project, root });

  let firstIds = null;
  const jev = await createPlan({
    projectPath: project,
    root,
    decider: async ({ questions, purpose }) => {
      assert.equal(purpose, 'study-plan-order');
      const ids = Object.keys(questions);
      if (!firstIds) firstIds = ids;
      const answers = {};
      ids.forEach((id, i) => {
        answers[id] = { type: 'noul', noul: (i + 1) / (ids.length + 1) };
      });
      return { ok: true, model: 'jev-test', answers };
    },
  });
  assert.equal(jev.ok, true);
  assert.equal(jev.ordering.mode, 'jev');
  assert.equal(jev.ordering.model, 'jev-test');
  assert.equal(jev.plan.cards[0].id, firstIds[firstIds.length - 1]);

  const fallback = await createPlan({
    projectPath: project,
    root,
    decider: async () => ({ ok: false, reason: 'disabled', source: 'local', attempts: 0 }),
  });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.ordering.mode, 'deterministic');
  assert.equal(fallback.ordering.model, null);
});

test('重新规划：记录新增/删除/字数变化/顺序变化', async () => {
  const project = makeProject();
  const root = tmpDir('dwplan-root-');
  await generateCards({ projectPath: project, root });
  const first = await createPlan({ projectPath: project, root });
  assert.equal(first.ok, true);

  // 新增来源 → 新增卡片
  write(project, 'docs/agents/new.md', '# 权限 隔离\n\n新增标准。\n');
  await updateAfterTicket({ projectPath: project, root });
  const second = await createPlan({ projectPath: project, root });
  assert.equal(second.ok, true);
  assert.ok(second.diff.added.length >= 1);

  // 删除一张卡片文件 → 计划里删除
  const victim = second.plan.cards[second.plan.cards.length - 1];
  fs.rmSync(victim.file);
  const third = await createPlan({ projectPath: project, root });
  assert.equal(third.ok, true);
  assert.ok(third.diff.removed.some((x) => x.id === victim.id));

  // 改字数 → 变化
  const target = third.plan.cards[0];
  const body = fs.readFileSync(target.file, 'utf8');
  const bumped = body.replace(/^(\s+)chars:\s*\d+$/m, (m, sp) => `${sp}chars: ${target.chars + 3000}`);
  fs.writeFileSync(target.file, bumped);
  const fourth = await createPlan({ projectPath: project, root });
  assert.equal(fourth.ok, true);
  assert.ok(fourth.diff.changed.some((x) => x.id === target.id && x.chars.to === target.chars + 3000));

  const md = fs.readFileSync(fourth.planPath, 'utf8');
  assert.match(md, /## 重新规划差异/);
});

test('无卡片：给出可读错误，不写计划文件', async () => {
  const project = tmpDir('dwplan-empty-');
  const root = tmpDir('dwplan-root-');
  const result = await createPlan({ projectPath: project, root });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-cards');
  assert.match(result.message, /学习卡/);
  assert.equal(fs.existsSync(path.join(projectDir(root, project), 'plan.md')), false);
});

test('前置成环：拒绝生成，不覆盖上一版计划；错误包含环路径', async () => {
  const project = makeProject();
  const root = tmpDir('dwplan-root-');
  await generateCards({ projectPath: project, root });
  const good = await createPlan({ projectPath: project, root });
  assert.equal(good.ok, true);
  const before = fs.readFileSync(good.planPath, 'utf8');

  const glossary = good.plan.cards.filter((c) => c.id.startsWith('glossary-')).slice(0, 2);
  assert.equal(glossary.length, 2);
  for (let i = 0; i < 2; i += 1) {
    const other = glossary[1 - i];
    const text = fs.readFileSync(glossary[i].file, 'utf8');
    const injected = text.replace(/^estimatedMinutes:/m, `prerequisites:\n  - ${other.id}\nestimatedMinutes:`);
    fs.writeFileSync(glossary[i].file, injected);
  }

  const bad = await createPlan({ projectPath: project, root });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'dependency-cycle');
  assert.ok(bad.cycle.length >= 2);
  assert.match(bad.message, /前置依赖成环/);
  assert.equal(fs.readFileSync(good.planPath, 'utf8'), before);
  assert.equal(readPlan({ root, projectPath: project }).generatedAt, good.plan.generatedAt);
});
