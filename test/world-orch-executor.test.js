// test/world-orch-executor.test.js
// R2 编排执行器守门：
//   ① launcher 增量——model 原地覆盖 / extraArgs 位置 / worktreeOverride 复用不重建 /
//      createRunAsync 成功·失败·超时·流式事件（spawnImpl 两种契约都覆盖）。
//   ② executor——confirmed 闸门 / jev 与落不出角色的拒绝 / dispatch 失败原样回传 /
//      成功链 dispatch→run→converge 顺序与收敛摘要 / claude JSON 包解析 / steer 两 runtime /
//      list 活跃合并 / sweep 中断改判。
// 全部临时目录 + 注入 spawnImpl/actions/clock：禁真网、禁真模型、禁 spawn 真命令。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const launcher = require('../world/roles/launcher');
const actions = require('../world/orch/actions');
const store = require('../world/orch/store');
const blackboard = require('../world/orch/blackboard');
const { ticketsFile, blackboardFile } = require('../world/orch/paths');
const { createExecutor } = require('../world/orch/executor');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'dw-exec-'));
}

/** 造一个最小可派项目目录（glm worktree 的复制源）。 */
function makeProject() {
  const dir = tmpDir('dw-exec-proj-');
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  return dir;
}

/** 在临时 orch 账本里立一张已确认工单（draft → confirmed 是合法迁移，直接 setStatus）。 */
function seedConfirmed(root, over = {}) {
  const draft = {
    title: '修 fixture',
    agent: 'pi',
    cwd: makeProject(),
    dependsOn: [],
    acceptance: ['测试通过'],
    action: 'implement',
    status: 'draft',
    ...over,
  };
  const ledger = store.appendTickets(ticketsFile(root), [draft]);
  const t = ledger.tickets[ledger.tickets.length - 1];
  store.setStatus(ticketsFile(root), t.id, 'confirmed');
  return store.get(ticketsFile(root), t.id);
}

/** child 句柄风格假执行器：手动推数据、手动收场。 */
class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = [];
  }
  kill(sig) {
    this.killed.push(sig);
    // 真 child 被 kill 后会异步发 exit——假执行器必须照做，否则超时路径永远等不到收场
    setImmediate(() => this.emit('exit', null, sig));
    return true;
  }
  say(text) {
    this.stdout.emit('data', Buffer.from(text));
  }
  complain(text) {
    this.stderr.emit('data', Buffer.from(text));
  }
  finish(code, signal) {
    this.emit('exit', code, signal || null);
  }
}

/** 全程录单 actions：dispatch/converge 结果可配，缺省放行。 */
function fakeActions(behavior = {}) {
  const calls = [];
  return {
    calls,
    transition(id, action, payload, deps) {
      calls.push({ id, action, payload, deps });
      if (action === 'dispatch' && behavior.dispatchFail) return behavior.dispatchFail;
      if (action === 'converge' && behavior.convergeFail) return behavior.convergeFail;
      return { ok: true, ticket: { id, status: action === 'dispatch' ? 'dispatched' : 'done' } };
    },
  };
}

function fixedClock() {
  let n = 1730000000000;
  return () => new Date((n += 1000));
}

function prefsOk() {
  return { agents: {} };
}

function expectProblems(res, code) {
  assert.equal(res.ok, false, `应失败：${JSON.stringify(res)}`);
  assert.ok(Array.isArray(res.problems) && res.problems.length, 'problems 必须是非空数组');
  for (const p of res.problems) assert.ok(p.code && p.reason && p.fix, `problem 缺字段：${JSON.stringify(p)}`);
  assert.equal(res.problems[0].code, code);
}

// ---------------------------------------------------------------- launcher 增量

test('opts.model：原地覆盖已有 --model 的值，不追加第二个；回执 model 同步', () => {
  const root = tmpDir('dwroles-');
  launcher.initRoles({ root });
  const receipt = launcher.createRun({ role: 'ds', task: '分析', root, runId: 'm1', dryRun: true, model: 'claude-x1' });
  const args = receipt.command.args;
  assert.equal(args.filter((a) => a === '--model').length, 1, '--model 只能出现一次（原地换值，不是追加）');
  assert.equal(args[args.indexOf('--model') + 1], 'claude-x1');
  assert.equal(receipt.model, 'claude-x1');
});

test('opts.extraArgs：插在 role.args 之后、promptFlag 之前', () => {
  const root = tmpDir('dwroles-');
  launcher.initRoles({ root });
  const receipt = launcher.createRun({
    role: 'glm',
    task: '干活',
    root,
    runId: 'm2',
    dryRun: true,
    extraArgs: ['--output-format', 'json'],
  });
  // 回执 command.args 是 command.slice(1, -1)：含 promptFlag，不含 prompt 本体
  assert.deepEqual(receipt.command.args, ['--model', 'jd-glm53', '--output-format', 'json', '-p']);
  // 不带 model 时回执 model 仍是角色默认
  assert.equal(receipt.model, 'jd-glm53');
});

test('opts.model + opts.extraArgs 同时给：先换值再追加', () => {
  const root = tmpDir('dwroles-');
  launcher.initRoles({ root });
  const receipt = launcher.createRun({
    role: 'ds',
    task: '分析',
    root,
    runId: 'm3',
    dryRun: true,
    model: 'claude-y9',
    extraArgs: ['--output-format', 'json'],
  });
  assert.deepEqual(receipt.command.args, ['--model', 'claude-y9', '--output-format', 'json', '-p']);
});

test('worktreeOverride（glm）：跳过重建，cwd/回执都指向既有 worktree', () => {
  const root = tmpDir('dwroles-');
  launcher.initRoles({ root });
  const existing = makeProject();
  const project = makeProject();
  let seen = null;
  const receipt = launcher.createRun({
    role: 'glm',
    project,
    task: '在既有 worktree 续作',
    root,
    runId: 'm4',
    worktreeOverride: existing,
    spawn(command, args, opts) {
      seen = { command, args, opts };
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.worktree.kind, 'reused');
  assert.equal(receipt.worktree.created, false);
  assert.equal(receipt.worktree.path, existing);
  assert.equal(seen.opts.cwd, existing, 'cwd 必须落在复用的 worktree，而不是新复制的');
  assert.equal(fs.existsSync(path.join(root, 'runs', 'm4', 'worktree')), false, '复用时不得新建默认 worktree');
  assert.equal(fs.existsSync(path.join(existing, 'README.md')), true, '复用的 worktree 内容原样保留');
});

test('createRunAsync：流式 stdout/stderr 到日志，事件序 start→stdout→done，回执 completed', async () => {
  const root = tmpDir('dwroles-');
  launcher.initRoles({ root });
  const project = makeProject();
  const events = [];
  let child = null;
  const calls = [];
  const spawnImpl = (command, args, opts) => {
    calls.push({ command, args, opts });
    child = new FakeChild(4321);
    return child;
  };
  const p = launcher.createRunAsync({
    role: 'ds',
    project,
    task: '分析 README',
    root,
    runId: 'a1',
    spawnImpl,
  }, (ev) => events.push(ev));

  // start 同步来
  assert.equal(events[0].kind, 'start');
  assert.equal(events[0].pid, 4321);
  assert.equal(calls[0].command, 'claude');
  assert.equal(calls[0].opts.cwd, project, 'ds 只读角色 cwd=项目本身');
  assert.equal(calls[0].opts.env.WORLD_ROLE, 'ds');

  child.say('first chunk\n');
  child.complain('warn line\n');
  child.say('second chunk\n');
  child.finish(0);
  const receipt = await p;

  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.ok, true);
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.pid, 4321, '运行期 pid 进回执（sweep 要拿它做硬判据）');

  const kinds = events.map((e) => `${e.kind}:${e.stream || ''}`);
  assert.deepEqual(kinds, ['start:', 'stdout:stdout', 'stdout:stderr', 'stdout:stdout', 'done:']);
  assert.equal(fs.readFileSync(path.join(root, 'runs', 'a1', 'stdout.log'), 'utf8'), 'first chunk\nsecond chunk\n');
  assert.equal(fs.readFileSync(path.join(root, 'runs', 'a1', 'stderr.log'), 'utf8'), 'warn line\n');

  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'runs', 'a1', 'receipt.json'), 'utf8'));
  assert.equal(onDisk.status, 'completed');
  assert.equal(onDisk.pid, 4321);
});

test('createRunAsync：非零退出 → failed；error 事件 → failed 带原因', async () => {
  const root = tmpDir('dwroles-');
  launcher.initRoles({ root });
  const project = makeProject();

  let c1 = null;
  const p1 = launcher.createRunAsync({
    role: 'ds', project, task: 't', root, runId: 'a2',
    spawnImpl: () => { c1 = new FakeChild(1); return c1; },
  });
  c1.finish(2);
  const r1 = await p1;
  assert.equal(r1.status, 'failed');
  assert.equal(r1.ok, false);
  assert.equal(r1.exitCode, 2);

  let c2 = null;
  const p2 = launcher.createRunAsync({
    role: 'ds', project, task: 't', root, runId: 'a3',
    spawnImpl: () => { c2 = new FakeChild(2); return c2; },
  });
  c2.emit('error', new Error('spawn claude ENOENT'));
  const r2 = await p2;
  assert.equal(r2.status, 'failed');
  assert.match(r2.error, /ENOENT/);
});

test('createRunAsync：超时 kill——error=timeout、SIGKILL 送达、done 照常', async () => {
  const root = tmpDir('dwroles-');
  launcher.initRoles({ root });
  const project = makeProject();
  let child = null;
  const events = [];
  const p = launcher.createRunAsync({
    role: 'ds', project, task: 't', root, runId: 'a4', timeoutMs: 40,
    spawnImpl: () => { child = new FakeChild(777); return child; },
  }, (ev) => events.push(ev));
  const receipt = await p; // 永不自行退场的 child，全靠超时了结
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.error, 'timeout');
  assert.ok(child.killed.includes('SIGKILL'));
  assert.equal(events[events.length - 1].kind, 'done');
});

test('createRunAsync：Promise 风格假执行器（spawnSync 同形状结果）', async () => {
  const root = tmpDir('dwroles-');
  launcher.initRoles({ root });
  const project = makeProject();
  const receipt = await launcher.createRunAsync({
    role: 'glm',
    project,
    task: '干活',
    root,
    runId: 'a5',
    spawnImpl: () => Promise.resolve({ status: 0, stdout: 'pi done', stderr: '' }),
  });
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.worktree.kind, 'copy'); // fixture 不是 git 仓库 → 复制
  assert.equal(fs.readFileSync(path.join(root, 'runs', 'a5', 'stdout.log'), 'utf8'), 'pi done');
});

// ---------------------------------------------------------------- executor 闸门

function makeExec(root, rolesRoot, over = {}) {
  return createExecutor({
    root,
    rolesRoot,
    prefsProvider: prefsOk,
    clock: fixedClock(),
    ...over,
  });
}

test('runTicket 闸门：非 confirmed 拒绝 / 非法号 / 找不到单', async () => {
  const root = tmpDir('dw-exec-');
  const rolesRoot = tmpDir('dw-exec-roles-');
  const t = seedConfirmed(root);
  store.setStatus(ticketsFile(root), t.id, 'draft'); // 退回草案
  const exec = makeExec(root, rolesRoot, { actions: fakeActions() });

  expectProblems(await exec.runTicket(t.id, { role: 'glm' }), 'ticket-not-confirmed');
  expectProblems(await exec.runTicket('xxx', { role: 'glm' }), 'ticket-id-invalid');
  expectProblems(await exec.runTicket('ORCH-999', { role: 'glm' }), 'ticket-not-found');
  assert.equal(launcher.listRuns({ root: rolesRoot }).length, 0, '闸门拒绝不得落 run');
});

test('runTicket 角色解析：显式 jev 拒（role-no-command）、agent 落不出角色映射也拒', async () => {
  const root = tmpDir('dw-exec-');
  const rolesRoot = tmpDir('dw-exec-roles-');
  const exec = makeExec(root, rolesRoot, { actions: fakeActions() });

  const t1 = seedConfirmed(root);
  expectProblems(await exec.runTicket(t1.id, { role: 'jev' }), 'role-no-command');

  const t2 = seedConfirmed(root, { agent: 'claude-code' });
  expectProblems(await exec.runTicket(t2.id), 'role-no-command');

  assert.equal(launcher.listRuns({ root: rolesRoot }).length, 0, '拒绝不留 run 尸体');
});

test('runTicket：agent=jev/空 → 落 glm 并真跑通（假 actions + 假执行器）', async () => {
  const root = tmpDir('dw-exec-');
  const rolesRoot = tmpDir('dw-exec-roles-');
  const fak = fakeActions();
  const spawnCalls = [];
  const exec = makeExec(root, rolesRoot, {
    actions: fak,
    spawnImpl: (command, args, opts) => {
      spawnCalls.push({ command, args });
      return Promise.resolve({ status: 0, stdout: 'glm 输出：done', stderr: '' });
    },
  });
  const t = seedConfirmed(root, { agent: 'jev' });
  const res = await exec.runTicket(t.id);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, 'pi', 'jev agent 落 glm 角色（pi runtime）');
  assert.equal(res.receipt.ticketId, t.id, '回执必须织回工单号（snapshot 的 latestRun 靠它关联）');
  assert.equal(fak.calls.map((c) => c.action).join(','), 'dispatch,converge');
  assert.match(fak.calls[0].payload.sessionId, /^exec:exec-orch-\d+-\d+$/, 'sessionId = exec:<runId>');
  assert.match(fak.calls[1].payload.summary, new RegExp(`run ${res.runId} :completed`));
  assert.match(fak.calls[1].payload.summary, /glm 输出：done/, '收敛摘要带 stdout 尾帧');
});

test('runTicket：dispatch 失败原样回传，账本不伤、不落 run', async () => {
  const root = tmpDir('dw-exec-');
  const rolesRoot = tmpDir('dw-exec-roles-');
  const fak = fakeActions({
    dispatchFail: { ok: false, problems: [{ code: 'agent-unknown', reason: '未注册的 agent：pi', fix: '去 Settings 注册或改派' }] },
  });
  let spawned = 0;
  const exec = makeExec(root, rolesRoot, {
    actions: fak,
    spawnImpl: () => { spawned += 1; return Promise.resolve({ status: 0 }); },
  });
  const t = seedConfirmed(root);
  const res = await exec.runTicket(t.id, { role: 'glm' });
  expectProblems(res, 'agent-unknown');
  assert.equal(spawned, 0, 'dispatch 不过绝不 spawn');
  assert.equal(launcher.listRuns({ root: rolesRoot }).length, 0);
  assert.equal(fak.calls.length, 1, 'converge 不得尾随失败的 dispatch');
});

test('runTicket 全链路（真 actions + 真账本）：confirmed → dispatched(信封) → run → done(收敛事实)', async () => {
  const root = tmpDir('dw-exec-');
  const rolesRoot = tmpDir('dw-exec-roles-');
  const exec = makeExec(root, rolesRoot, {
    actions,
    spawnImpl: () => Promise.resolve({ status: 0, stdout: '任务完成报告', stderr: '' }),
  });
  const t = seedConfirmed(root);
  const res = await exec.runTicket(t.id, { role: 'glm' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.ticket.status, 'done');
  assert.equal(store.get(ticketsFile(root), t.id).status, 'done');

  // 信封照常投（sessionId=exec:<runId>）
  const box = require('../world/orch/mailbox').list(`exec:${res.runId}`, { root });
  assert.equal(box.length, 1);
  assert.equal(box[0].ticketId, t.id);

  // 收敛事实上黑板，摘要带 runId 与 stdout 尾帧
  const conv = blackboard.listByKind(blackboardFile(root), 'convergence');
  assert.equal(conv.length, 1);
  assert.match(conv[0].text, new RegExp(`run ${res.runId} :completed`));
  assert.match(conv[0].text, /任务完成报告/);

  // 围栏在位：glm worktree 是独立复制
  assert.equal(res.receipt.worktree.kind, 'copy');
  assert.ok(fs.existsSync(res.receipt.worktree.path));
});

test('runTicket：claude runtime 强制 --output-format json 并解析 session_id/result', async () => {
  const root = tmpDir('dw-exec-');
  const rolesRoot = tmpDir('dw-exec-roles-');
  const spawnCalls = [];
  const exec = makeExec(root, rolesRoot, {
    actions: fakeActions(),
    spawnImpl: (command, args) => {
      spawnCalls.push({ command, args });
      return Promise.resolve({ status: 0, stdout: JSON.stringify({ session_id: 'sid-9', result: '分析完成' }), stderr: '' });
    },
  });
  const t = seedConfirmed(root, { agent: 'ds' });
  const res = await exec.runTicket(t.id);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(spawnCalls[0].command, 'claude');
  const pi = spawnCalls[0].args.indexOf('-p');
  const oi = spawnCalls[0].args.indexOf('--output-format');
  assert.ok(oi > -1 && oi < pi, '--output-format json 在 prompt 之前');
  assert.equal(spawnCalls[0].args[oi + 1], 'json');
  assert.equal(res.receipt.sessionId, 'sid-9');
  assert.equal(res.receipt.result, '分析完成');
  // 落盘回执里也织进去了（steer 靠磁盘回执找 sessionId）
  const onDisk = launcher.listRuns({ root: rolesRoot }).find((r) => r.runId === res.runId);
  assert.equal(onDisk.sessionId, 'sid-9');
});

test('runTicket：run 失败仍自动收敛（:failed 进摘要）；converge 失败不丢回执', async () => {
  const root = tmpDir('dw-exec-');
  const rolesRoot = tmpDir('dw-exec-roles-');

  const fak1 = fakeActions();
  const exec1 = makeExec(root, rolesRoot, {
    actions: fak1,
    spawnImpl: () => Promise.resolve({ status: 1, stdout: '', stderr: 'boom' }),
  });
  const t1 = seedConfirmed(root);
  const r1 = await exec1.runTicket(t1.id, { role: 'glm' });
  assert.equal(r1.ok, true);
  assert.equal(r1.receipt.status, 'failed');
  assert.match(fak1.calls[1].payload.summary, /:failed/);

  const fak2 = fakeActions({
    convergeFail: { ok: false, problems: [{ code: 'converge-not-running', reason: '状态不可达', fix: '刷新后重试' }] },
  });
  const exec2 = makeExec(root, rolesRoot, {
    actions: fak2,
    spawnImpl: () => Promise.resolve({ status: 0, stdout: 'ok', stderr: '' }),
  });
  const t2 = seedConfirmed(root);
  const r2 = await exec2.runTicket(t2.id, { role: 'glm' });
  expectProblems(r2, 'converge-not-running');
  assert.ok(r2.runId && r2.receipt, 'converge 失败也要把回执/ runId 带回给调用方');
  assert.equal(r2.receipt.status, 'completed', '回执本身是落盘的，没被收敛失败弄丢');
});

// ---------------------------------------------------------------- steer

test('steer（claude 有 sessionId）：直发 resume，复用父 config env 与 prompt 链', async () => {
  const root = tmpDir('dw-exec-');
  const rolesRoot = tmpDir('dw-exec-roles-');
  const spawnCalls = [];
  let n = 0;
  const exec = makeExec(root, rolesRoot, {
    actions: fakeActions(),
    spawnImpl: (command, args, opts) => {
      n += 1;
      spawnCalls.push({ command, args, opts });
      const body = n === 1
        ? { session_id: 'sid-parent', result: '第一版分析' }
        : { session_id: 'sid-parent', result: '修订版分析' };
      return Promise.resolve({ status: 0, stdout: JSON.stringify(body), stderr: '' });
    },
  });
  const t = seedConfirmed(root, { agent: 'ds' });
  const r1 = await exec.runTicket(t.id);
  assert.equal(r1.ok, true);

  const r2 = await exec.steer(r1.runId, '把风险段再展开一下');
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.receipt.parentRunId, r1.runId, 'steer 回执必须链回父 run');
  assert.equal(r2.receipt.sessionId, 'sid-parent');
  assert.equal(r2.receipt.result, '修订版分析');

  const call2 = spawnCalls[1];
  assert.equal(call2.command, 'claude');
  assert.deepEqual(call2.args.slice(0, 5), ['-p', '--resume', 'sid-parent', '--output-format', 'json']);
  const prompt = call2.args[5];
  assert.match(prompt, /## 前次结果摘要/);
  assert.match(prompt, /第一版分析/, '摘要带父 run 的 result');
  assert.match(prompt, /## 用户追加指示\n把风险段再展开一下/);
  assert.equal(call2.opts.env.WORLD_RUN_ID, r2.runId);
  assert.equal(call2.opts.env.CLAUDE_CONFIG_DIR, path.join(r1.receipt.configDir, 'claude'), '复用父 config（否则 resume 会话续不上）');
  assert.equal(call2.opts.cwd, r1.receipt.cwd || r1.receipt.project, 'cwd=父 worktree 或项目');
});

test('steer（pi / 无 sessionId）：follow-up 新 run，复用父 worktree + 拼接简报', async () => {
  const root = tmpDir('dw-exec-');
  const rolesRoot = tmpDir('dw-exec-roles-');
  const spawnCalls = [];
  const exec = makeExec(root, rolesRoot, {
    actions: fakeActions(),
    spawnImpl: (command, args, opts) => {
      spawnCalls.push({ command, args, opts });
      return Promise.resolve({ status: 0, stdout: 'pi 产出物说明', stderr: '' });
    },
  });
  const t = seedConfirmed(root);
  const r1 = await exec.runTicket(t.id, { role: 'glm' });
  assert.equal(r1.ok, true);
  const parentWorktree = r1.receipt.worktree.path;
  assert.ok(parentWorktree);

  const r2 = await exec.steer(r1.runId, '补一组边界测试');
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.receipt.parentRunId, r1.runId);
  assert.equal(r2.receipt.worktree.kind, 'reused', 'follow-up 不重建 worktree');
  assert.equal(r2.receipt.worktree.path, parentWorktree, '复用父 run 的现场');
  assert.equal(r2.receipt.cwd, parentWorktree);
  assert.equal(spawnCalls[1].command, 'pi');
  assert.equal(spawnCalls[1].opts.cwd, parentWorktree);

  // 拼接简报落在 task.md 里：原 task + 前次摘要（stdout 尾）+ 追加指示
  const taskMd = fs.readFileSync(path.join(rolesRoot, 'runs', r2.runId, 'task.md'), 'utf8');
  assert.match(taskMd, /修 fixture/);
  assert.match(taskMd, /## 前次结果摘要/);
  assert.match(taskMd, /pi 产出物说明/);
  assert.match(taskMd, /## 用户追加指示\n补一组边界测试/);
});

test('steer：空指示 / 父 run 不存在 → 结构化拒绝', async () => {
  const root = tmpDir('dw-exec-');
  const rolesRoot = tmpDir('dw-exec-roles-');
  const exec = makeExec(root, rolesRoot, { actions: fakeActions() });
  expectProblems(await exec.steer('run-nope', '继续'), 'run-not-found');
  expectProblems(await exec.steer('whatever', '   '), 'steer-text-empty');
});

// ---------------------------------------------------------------- list / sweep / 事件

test('list：活跃 run 合并（active/pid/elapsedMs），完成后回落为账本态', async () => {
  const root = tmpDir('dw-exec-');
  const rolesRoot = tmpDir('dw-exec-roles-');
  let child = null;
  const exec = makeExec(root, rolesRoot, {
    actions: fakeActions(),
    spawnImpl: () => { child = new FakeChild(5150); return child; },
  });
  const t = seedConfirmed(root);
  const p = exec.runTicket(t.id, { role: 'glm' });
  await new Promise((r) => setImmediate(r)); // 等 start 落账

  let runs = exec.list();
  const live = runs.find((r) => r.active === true);
  assert.ok(live, '活跃 Map 必须并进列表');
  assert.equal(live.pid, 5150);
  assert.equal(typeof live.elapsedMs, 'number');
  assert.ok(live.elapsedMs >= 0);
  assert.ok(live.runDir.endsWith(path.join('runs', live.runId)));

  child.finish(0);
  await p;
  runs = exec.list();
  const done = runs.find((r) => r.runId === live.runId);
  assert.equal(done.active, false);
  assert.equal(done.status, 'completed');
});

test('run 事件总线：start/stdout/done 带 runId+ticketId', async () => {
  const root = tmpDir('dw-exec-');
  const rolesRoot = tmpDir('dw-exec-roles-');
  let child = null;
  const exec = makeExec(root, rolesRoot, {
    actions: fakeActions(),
    spawnImpl: () => { child = new FakeChild(6001); return child; },
  });
  const events = [];
  exec.on('run', (ev) => events.push(ev));
  const t = seedConfirmed(root);
  const p = exec.runTicket(t.id, { role: 'glm' });
  await new Promise((r) => setImmediate(r));
  child.say('tick');
  child.finish(0);
  const res = await p;

  assert.deepEqual(events.map((e) => e.kind), ['start', 'stdout', 'done']);
  for (const ev of events) {
    assert.equal(ev.runId, res.runId);
    assert.equal(ev.ticketId, t.id);
  }
  assert.equal(events[2].receipt.status, 'completed');
});

test('sweep：running 回执 + 死 pid → 改判 failed/interrupted；活 pid 不动', async () => {
  const root = tmpDir('dw-exec-');
  const rolesRoot = tmpDir('dw-exec-roles-');
  const exec = makeExec(root, rolesRoot, { actions: fakeActions() });

  const seed = (runId, pid) => {
    const dir = path.join(rolesRoot, 'runs', runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify({
      schemaVersion: 1, runId, role: 'glm', status: 'running', ok: null, pid,
      startedAt: '2026-10-18T00:00:00.000Z', finishedAt: null, worktree: { path: '', kind: 'none', created: false },
      task: 't', error: '',
    }, null, 2));
  };
  seed('r-dead', 999999); // 远超 macOS pid 上限 → 必 ESRCH
  seed('r-alive', process.pid); // 本进程活着，绝不能被扫掉

  const swept = exec.sweep();
  assert.deepEqual(swept, ['r-dead']);
  const dead = JSON.parse(fs.readFileSync(path.join(rolesRoot, 'runs', 'r-dead', 'receipt.json'), 'utf8'));
  assert.equal(dead.status, 'failed');
  assert.equal(dead.ok, false);
  assert.equal(dead.error, 'interrupted');
  assert.ok(dead.finishedAt);
  const alive = JSON.parse(fs.readFileSync(path.join(rolesRoot, 'runs', 'r-alive', 'receipt.json'), 'utf8'));
  assert.equal(alive.status, 'running', '活 pid 的 run 绝不能被误杀');
});
