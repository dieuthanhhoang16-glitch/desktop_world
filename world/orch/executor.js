// world/orch/executor.js
// desktop-world · 编排执行器：把「已确认」工单真跑起来（派发 → spawn 角色 run → 回执 → 自动收敛）。
//
// 为什么存在：dispatch 原来只把信封投进会话收件箱，跑不跑取决于人；编排台要的是
// 「确认派发后能直接开跑」——本模块把同一条链路闭环：actions.dispatch 照常投信封
// （账本/黑板语义不变），然后用 world/roles/launcher 的隔离围栏真起一个角色 run，
// 结束后把回执落盘并自动 converge（summary = run 状态 + stdout 尾帧）。
//
// 红线（与 actions/dispatch 同源）：
//   ① 永不抛错：所有失败都折成 {ok:false, problems:[{code, reason, fix}]}，人话。
//   ② 闸门：只跑 status==='confirmed' 的工单；jev 无 command 绝不造假执行（不起假进程）。
//   ③ 本模块不写进程配置、不拉会话：隔离/env/权限全部交给 launcher。
//   ④ 可测试性：执行器一律经 spawnImpl 注入点走，测试禁真网、禁真模型、禁 spawn 真命令。
//
// 依赖全部注入（createExecutor 参数）：{root, rolesRoot, prefsProvider, actions, launcher, spawnImpl, clock}。
// spawnImpl 契约与 launcher.createRunAsync 相同（Promise 风格或 child 句柄风格），
// 既喂给 launcher，也喂给 steer 的 claude 直发分支。
'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const { ORCH_DIR, ticketsFile, STATUS_LABELS } = require('./paths');
const orchStore = require('./store');
const defaultActions = require('./actions');
const defaultLauncher = require('../roles/launcher');
const { ROLES } = require('../roles/defaults');
const { loadPrefs } = require('./prefs-source');

const TICKET_ID_RE = /^ORCH-\d{3,}$/;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const SUMMARY_STDOUT_TAIL = 200; // 收敛摘要带 stdout 尾部 200 字（规格 §3）
const STEER_PREV_TAIL = 500; // steer 简报带前次结果尾部 500 字
const CLAUDE_JSON_ARGS = ['--output-format', 'json']; // claude runtime 一律 JSON 包，方便解析 session_id/result

function problem(code, reason, fix, extra) {
  return { code, reason, fix, ...(extra || {}) };
}

function fail(problems) {
  return { ok: false, problems: Array.isArray(problems) ? problems : [problems] };
}

/** 工单号/存在性校验 → {ticket} 或 {problems}。 */
function loadTicket(root, ticketId) {
  if (!TICKET_ID_RE.test(String(ticketId || ''))) {
    return { problems: [problem('ticket-id-invalid', `工单号不合法：${ticketId}`, '工单号形如 ORCH-001（账本发号，不手编）')] };
  }
  const ledger = orchStore.load(ticketsFile(root));
  const ticket = ledger.tickets.find((t) => t.id === ticketId);
  if (!ticket) {
    return { problems: [problem('ticket-not-found', `找不到工单 ${ticketId}`, '可能已被删除；刷新编排台重试')] };
  }
  return { ledger, ticket };
}

/**
 * 角色解析：显式 role 优先；ticket.agent ∈ {ds, glm} 用之；'jev' 或空 → glm；
 * 其余（如会话 agent id 'pi'/'claude-code'）落不出角色 → 显式拒绝，必须显式传 role 或改派。
 */
function resolveRole(ticket, explicitRole) {
  if (explicitRole) return { role: String(explicitRole) };
  const agent = String((ticket && ticket.agent) || '').trim();
  if (agent === 'ds' || agent === 'glm') return { role: agent };
  if (agent === 'jev' || !agent) return { role: 'glm' };
  return {
    problems: [problem(
      'role-no-command',
      `工单 agent「${agent}」映射不到可执行角色`,
      'executor 只认角色 id（ds/glm）：派单时把 agent 改成 glm/ds，或调用时显式传 role；会话 agent id（pi/claude-code 等）是 mailbox 概念，不是角色',
      { id: ticket && ticket.id },
    )],
  };
}

/** 角色可执行性校验：未知角色 / 无 command（jev 判断角色）都拒绝，绝不造假执行。 */
function roleCommandProblem(roleId, ticketId) {
  const role = ROLES[roleId];
  if (!role) {
    return problem('role-unknown', `未知角色：${roleId}`, `角色白名单：${Object.keys(ROLES).join(' / ')}`, { id: ticketId });
  }
  if (!role.command.length) {
    return problem('role-no-command', `角色「${roleId}（${role.title}）」没有可执行命令`, 'jev 是判断角色，只产出建议；executor 不给它造假执行。改派 glm（执行）或 ds（思考）', { id: ticketId });
  }
  return null;
}

/** 工单 → 任务简报：标题 + 验收标准 + 工作目录（落 prompt/task.md，可审计）。 */
function briefForTicket(ticket) {
  const parts = [String(ticket.title || '').trim()];
  const acc = Array.isArray(ticket.acceptance) ? ticket.acceptance.filter(Boolean) : [];
  if (acc.length) parts.push(`## 验收标准\n${acc.map((a) => `- ${a}`).join('\n')}`);
  if (ticket.cwd) parts.push(`## 工作目录\n${ticket.cwd}`);
  return parts.filter(Boolean).join('\n\n');
}

function tail(text, n) {
  const s = String(text == null ? '' : text);
  return s.length > n ? s.slice(-n) : s;
}

function readTail(file, n) {
  try {
    const s = fs.readFileSync(file, 'utf8');
    return tail(s, n);
  } catch {
    return '';
  }
}

/** 前次 run 的结果摘要（steer 简报用）：receipt.result 优先，缺则 stderr/stdout 日志尾帧。 */
function prevSummary(parentReceipt, parentRunDir) {
  const parts = [];
  if (parentReceipt.result) parts.push(String(parentReceipt.result));
  const stderr = readTail(path.join(parentRunDir, 'stderr.log'), STEER_PREV_TAIL);
  const stdout = readTail(path.join(parentRunDir, 'stdout.log'), STEER_PREV_TAIL);
  if (stderr) parts.push(`stderr 尾帧：${stderr}`);
  if (stdout) parts.push(`stdout 尾帧：${stdout}`);
  return tail(parts.filter(Boolean).join('\n'), STEER_PREV_TAIL);
}

/** steer 两分支共用同一段拼接文本：原 task → 前次结果摘要 → 用户追加指示。 */
function composeSteerTask(parentReceipt, prevTail, text) {
  return `${parentReceipt.task}\n\n## 前次结果摘要\n${prevTail || '(无输出)'}\n\n## 用户追加指示\n${text}`;
}

/** claude JSON 包解析：stdout 是单个 JSON 对象，抽 session_id/result；解析失败静默（不丢回执）。 */
function parseClaudeJson(stdoutText, receipt) {
  try {
    const parsed = JSON.parse(String(stdoutText || '').trim());
    if (parsed && typeof parsed === 'object') {
      if (parsed.session_id != null) receipt.sessionId = String(parsed.session_id);
      if (parsed.result != null) receipt.result = String(parsed.result);
    }
  } catch {
    /* 非 JSON 输出（比如模型把 markdown 吐出来）：回执原样保留，stdout.log 已存原文 */
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM'; // EPERM = 进程在但无权 kill，仍算活着
  }
}

function defaultPrefsProvider() {
  const r = loadPrefs();
  return r.ok ? r.snapshot : null;
}

function createExecutor(opts = {}) {
  const root = opts.root || ORCH_DIR; // 编排账本根（tickets/blackboard/mailbox）
  const actions = opts.actions || defaultActions;
  const launcher = opts.launcher || defaultLauncher;
  const rolesRoot = launcher.rolesRoot(opts.rolesRoot); // 角色 run 根（runs/ 落盘处）
  const prefsProvider = typeof opts.prefsProvider === 'function' ? opts.prefsProvider : defaultPrefsProvider;
  const spawnImpl = typeof opts.spawnImpl === 'function' ? opts.spawnImpl : undefined;
  const clock = typeof opts.clock === 'function' ? opts.clock : () => new Date();

  const exec = new EventEmitter();
  const active = new Map(); // runId → {pid, startedMs, ticketId}（进程内存，sweep 之外的"真在跑"真相）

  const dirsOf = (runId) => launcher.runDirs(rolesRoot, runId);

  /** 回执合并落盘：起步后补 ticketId/parentRunId/sessionId 等运行期字段。 */
  function patchReceipt(receipt) {
    const dirs = dirsOf(receipt.runId);
    try {
      fs.writeFileSync(dirs.receiptFile, JSON.stringify(receipt, null, 2), { mode: 0o600 });
    } catch {
      /* 回执二次落盘失败：launcher 已经写过底稿，这里不丢主流程 */
    }
  }

  /** 事件转发：launcher 事件 → 'run' 总线；维护活跃 Map。 */
  function forward(ticketId, runId) {
    return (ev) => {
      if (ev.kind === 'start') {
        active.set(runId, { pid: ev.pid, startedMs: clock().getTime(), ticketId });
        exec.emit('run', { kind: 'start', runId, ticketId, pid: ev.pid });
      } else if (ev.kind === 'done') {
        active.delete(runId);
        exec.emit('run', { kind: 'done', runId, ticketId, receipt: ev.receipt });
      } else {
        exec.emit('run', { kind: 'stdout', runId, ticketId, stream: ev.stream, text: ev.text });
      }
    };
  }

  /**
   * 派发 + 执行 + 自动收敛一张已确认工单。
   * @param ticketId ORCH-XXX
   * @param runOpts {role?, model?, timeoutMs?, sourceEnv?}
   * @returns {ok:true, runId, receipt, ticket} | {ok:false, problems[], runId?, receipt?}
   */
  async function runTicket(ticketId, runOpts = {}) {
    try {
      const ctx = loadTicket(root, ticketId);
      if (ctx.problems) return fail(ctx.problems);
      const { ticket } = ctx;
      if (ticket.status !== 'confirmed') {
        return fail(problem(
          'ticket-not-confirmed',
          `${ticketId} 当前是「${STATUS_LABELS[ticket.status] || ticket.status}」，只有「已确认」的工单能开跑`,
          '先在编排台确认这张单；failed/blocked 的先重确再跑',
          { id: ticketId },
        ));
      }

      const resolved = resolveRole(ticket, runOpts.role);
      if (resolved.problems) return fail(resolved.problems);
      const roleId = resolved.role;
      const cmdProblem = roleCommandProblem(roleId, ticketId);
      if (cmdProblem) return fail(cmdProblem);
      const runtime = ROLES[roleId].runtime;
      const runId = `exec-${String(ticketId).toLowerCase()}-${clock().getTime()}`;
      const prefs = prefsProvider();

      // 先投信封（账本/黑板语义与人在 CLI 派发完全一致）：失败原样回传，账本不伤。
      const dispatched = actions.transition(ticketId, 'dispatch', { sessionId: `exec:${runId}` }, { root, prefs });
      if (!dispatched.ok) return fail(dispatched.problems);

      // 开跑：claude runtime 统一要 JSON 包（executor 依赖 session_id/result 做 steer 链）
      const extraArgs = runtime === 'claude' ? CLAUDE_JSON_ARGS.slice() : [];
      let receipt;
      try {
        receipt = await launcher.createRunAsync({
          role: roleId,
          model: runOpts.model,
          project: ticket.cwd,
          task: briefForTicket(ticket),
          runId,
          root: rolesRoot,
          timeoutMs: runOpts.timeoutMs,
          sourceEnv: runOpts.sourceEnv,
          extraArgs,
          spawnImpl,
          now: clock,
        }, forward(ticketId, runId));
      } catch (err) {
        return fail(problem('run-launch-failed', `开跑失败：${err && err.message ? err.message : err}`, '项目目录在不在？角色卡在不在？看 runs/ 下的回执底稿定位', { id: ticketId }));
      }

      // 回执补织：ticketId 关联 + claude JSON 包解析（sessionId/result 进回执，供 steer 续会话）
      receipt.ticketId = ticketId;
      if (runtime === 'claude') {
        parseClaudeJson(readTail(path.join(dirsOf(runId).runDir, 'stdout.log'), 1024 * 1024), receipt);
      }
      patchReceipt(receipt);

      // 自动收敛：summary = run 状态 + stdout 尾 200 字；converge 失败也不丢回执（问题里带回去）。
      const stdoutTail = readTail(path.join(dirsOf(runId).runDir, 'stdout.log'), SUMMARY_STDOUT_TAIL);
      const summary = `run ${runId} :${receipt.status}${stdoutTail ? ` — ${stdoutTail}` : ''}`;
      const converged = actions.transition(ticketId, 'converge', { summary }, { root, prefs });
      if (!converged.ok) {
        return { ok: false, problems: converged.problems, runId, receipt };
      }
      return { ok: true, runId, receipt, ticket: converged.ticket };
    } catch (err) {
      return fail(problem('internal-error', `执行器内部错误：${err && err.message ? err.message : err}`, '截屏提 issue；回执若已落盘仍在 runs/ 里，账本可用 status 命令核对', { id: ticketId }));
    }
  }

  /**
   * steer：对一次已完成的 run 追加指示，产出链式 follow-up run。
   *   - 父 run runtime=claude 且有 sessionId：复用父 env(config)+父 worktree，直发
   *     `claude -p --resume <sid> --output-format json <拼接文本>`（不走新一轮隔离准备——
   *     会话续命必须挂在父 config/session 上，重起空 config 就续不上了）。
   *   - 其余（pi 或无 sessionId）：launcher.createRunAsync + worktreeOverride 复用父 worktree，
   *     简报 = 原 task + 前次结果摘要 + 追加指示，走过往新 run 的完整围栏。
   * @returns {ok:true, runId, receipt} | {ok:false, problems[]}
   */
  async function steer(runId, text, steerOpts = {}) {
    try {
      const appended = String(text == null ? '' : text).trim();
      if (!appended) {
        return fail(problem('steer-text-empty', '追加指示是空的', '在对话输入框里先写一句话再发（比如「接着把测试补上」）'));
      }
      const parent = launcher.listRuns({ root: rolesRoot }).find((r) => r.runId === runId);
      if (!parent) {
        return fail(problem('run-not-found', `找不到 run：${runId}`, 'run 目录可能已被清理；列表里的 runId 以 runs/ 落盘为准'));
      }
      const roleId = String(parent.role || '');
      const roleCmdProblem = roleCommandProblem(roleId, (parent.ticketId || ''));
      if (roleCmdProblem) return fail(roleCmdProblem);
      const runtime = ROLES[roleId].runtime;
      const timeoutMs = Number.isFinite(steerOpts.timeoutMs) && steerOpts.timeoutMs > 0 ? steerOpts.timeoutMs : DEFAULT_TIMEOUT_MS;
      const parentDir = dirsOf(parent.runId).runDir;
      const composed = composeSteerTask(parent, prevSummary(parent, parentDir), appended);
      const newRunId = `${parent.runId}-steer-${clock().getTime()}`.slice(0, 100);
      const ticketId = parent.ticketId || '';

      if (runtime === 'claude' && parent.sessionId) {
        // —— 直发分支：复用父 env/worktree，stdout/stderr 照流进新 runDir 日志 ——
        const dirs = dirsOf(newRunId);
        fs.mkdirSync(dirs.runDir, { recursive: true });
        const parentWorktreePath = parent.worktree && parent.worktree.path ? String(parent.worktree.path) : '';
        const cwd = parentWorktreePath || parent.project || parent.cwd || undefined;
        const env = launcher.buildEnv(roleId, {
          configDir: parent.configDir,
          runId: newRunId,
          sourceEnv: steerOpts.sourceEnv || process.env,
          network: parent.network || ROLES[roleId].network,
        });
        const args = ['-p', '--resume', parent.sessionId, ...CLAUDE_JSON_ARGS, composed];
        const receipt = {
          schemaVersion: 1,
          runId: newRunId,
          role: roleId,
          roleTitle: parent.roleTitle || (ROLES[roleId] && ROLES[roleId].title) || roleId,
          model: parent.model || (ROLES[roleId] && ROLES[roleId].defaultModel) || '',
          project: parent.project || '',
          task: composed,
          status: 'planned',
          ok: null,
          startedAt: clock().toISOString(),
          finishedAt: null,
          worktree: parentWorktreePath ? { path: parentWorktreePath, kind: 'reused', created: false } : { path: '', kind: 'none', created: false },
          cwd: cwd || '',
          network: parent.network || ROLES[roleId].network,
          command: { file: 'claude', args, promptFile: null },
          changedFiles: [],
          exitCode: null,
          signal: null,
          error: '',
          parentRunId: parent.runId,
          ticketId,
        };
        fs.writeFileSync(dirs.receiptFile, JSON.stringify(receipt, null, 2), { mode: 0o600 });
        const onEvent = forward(ticketId, newRunId);

        return await new Promise((resolveSteer) => {
          let child;
          try {
            const impl = spawnImpl || ((cmd, a, o) => require('child_process').spawn(cmd, a, { cwd: o.cwd, env: o.env }));
            child = impl('claude', args, { cwd, env, timeoutMs });
          } catch (err) {
            receipt.status = 'failed';
            receipt.ok = false;
            receipt.error = String(err && err.message ? err.message : err);
            receipt.finishedAt = clock().toISOString();
            patchReceipt(receipt);
            onEvent({ kind: 'done', receipt });
            resolveSteer({ ok: false, problems: [problem('steer-launch-failed', `steer 开跑失败：${receipt.error}`, '父 run 的 config/会话还在不在？', {})], runId: newRunId, receipt });
            return;
          }
          const settle = ({ exitCode, signal, error, stdout, stderr }) => {
            if (stdout) { try { fs.appendFileSync(path.join(dirs.runDir, 'stdout.log'), stdout); } catch { /* 日志失败不丢回执 */ } }
            if (stderr) { try { fs.appendFileSync(path.join(dirs.runDir, 'stderr.log'), stderr); } catch { /* 同上 */ } }
            receipt.finishedAt = clock().toISOString();
            receipt.exitCode = typeof exitCode === 'number' ? exitCode : null;
            receipt.signal = signal || null;
            receipt.error = error || '';
            receipt.status = receipt.error ? 'failed' : receipt.exitCode === 0 ? 'completed' : 'failed';
            receipt.ok = receipt.status === 'completed';
            if (receipt.status === 'completed') {
              parseClaudeJson(stdout != null ? stdout : readTail(path.join(dirs.runDir, 'stdout.log'), 1024 * 1024), receipt);
            }
            patchReceipt(receipt);
            onEvent({ kind: 'done', receipt });
            resolveSteer({ ok: true, runId: newRunId, receipt });
          };

          if (child && typeof child.then === 'function') {
            let settled = false;
            const timer = setTimeout(() => {
              if (settled) return;
              settled = true;
              settle({ exitCode: null, signal: null, error: 'timeout' });
            }, timeoutMs);
            onEvent({ kind: 'start', pid: undefined });
            child.then(
              (r) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                const res = r || {};
                settle({
                  exitCode: typeof res.status === 'number' ? res.status : (typeof res.code === 'number' ? res.code : null),
                  signal: res.signal || null,
                  error: res.error ? String(res.error.message || res.error) : '',
                  stdout: res.stdout != null ? String(res.stdout) : '',
                  stderr: res.stderr != null ? String(res.stderr) : '',
                });
              },
              (err) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                settle({ exitCode: null, signal: null, error: String(err && err.message ? err.message : err) });
              },
            );
            return;
          }

          const pid = child && typeof child.pid === 'number' ? child.pid : undefined;
          receipt.pid = pid;
          receipt.status = 'running';
          patchReceipt(receipt);
          onEvent({ kind: 'start', pid });
          let settled = false;
          let timedOut = false;
          let spawnErr = '';
          const timer = setTimeout(() => {
            timedOut = true;
            try { if (child && typeof child.kill === 'function') child.kill('SIGKILL'); } catch { /* 已死 */ }
          }, timeoutMs);
          const done = (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            settle({ exitCode: code, signal, error: timedOut ? 'timeout' : spawnErr });
          };
          if (child && child.stdout && typeof child.stdout.on === 'function') {
            child.stdout.on('data', (buf) => {
              const t = String(buf);
              try { fs.appendFileSync(path.join(dirs.runDir, 'stdout.log'), t); } catch { /* 日志失败不丢回执 */ }
              onEvent({ kind: 'stdout', stream: 'stdout', text: t });
            });
          }
          if (child && child.stderr && typeof child.stderr.on === 'function') {
            child.stderr.on('data', (buf) => {
              const t = String(buf);
              try { fs.appendFileSync(path.join(dirs.runDir, 'stderr.log'), t); } catch { /* 同上 */ }
              onEvent({ kind: 'stdout', stream: 'stderr', text: t });
            });
          }
          if (child && typeof child.on === 'function') {
            child.on('error', (err) => {
              spawnErr = String(err && err.message ? err.message : err);
              done(null, null);
            });
            child.on('exit', (code, signal) => done(code, signal));
          } else {
            done(null, null);
          }
        });
      }

      // —— follow-up 分支：完整围栏新 run，worktree 复用父现场 ——
      const override = (parent.worktree && parent.worktree.path) || parent.cwd || parent.project || undefined;
      let receipt;
      try {
        receipt = await launcher.createRunAsync({
          role: roleId,
          project: parent.project || parent.cwd || undefined,
          task: composed,
          runId: newRunId,
          root: rolesRoot,
          worktreeOverride: override,
          timeoutMs,
          sourceEnv: steerOpts.sourceEnv,
          extraArgs: runtime === 'claude' ? CLAUDE_JSON_ARGS.slice() : [],
          spawnImpl,
          now: clock,
        }, forward(ticketId, newRunId));
      } catch (err) {
        return fail(problem('steer-launch-failed', `steer 开跑失败：${err && err.message ? err.message : err}`, '父 run 的 worktree/项目目录在不在？', {}));
      }
      receipt.parentRunId = parent.runId;
      receipt.ticketId = ticketId;
      if (runtime === 'claude') {
        parseClaudeJson(readTail(path.join(dirsOf(newRunId).runDir, 'stdout.log'), 1024 * 1024), receipt);
      }
      patchReceipt(receipt);
      return { ok: true, runId: newRunId, receipt };
    } catch (err) {
      return fail(problem('internal-error', `执行器内部错误：${err && err.message ? err.message : err}`, '截屏提 issue；父 run 回执不受影响', {}));
    }
  }

  /** run 列表：账本（runs/ 落盘回执）合并进程内活跃 Map（active/pid/elapsedMs）。 */
  function list() {
    return launcher.listRuns({ root: rolesRoot }).map((r) => {
      const dirs = dirsOf(r.runId);
      const base = { ...r, runDir: dirs.runDir, worktreeDir: (r.worktree && r.worktree.path) || '' };
      const a = active.get(r.runId);
      if (a) {
        return { ...base, active: true, pid: a.pid, elapsedMs: Math.max(0, clock().getTime() - a.startedMs), ticketId: a.ticketId || base.ticketId };
      }
      return { ...base, active: false };
    });
  }

  /**
   * 启动时扫一次（P1B 在 App 启动时调）：回执说 running 但 pid 已死 → 改判 interrupted。
   * 硬判据只看 pid 存活（process.kill(pid,0) 抛 ESRCH = 死透了；EPERM = 活着）。
   * @returns {string[]} 被改判的 runId 列表
   */
  function sweep() {
    const swept = [];
    for (const r of launcher.listRuns({ root: rolesRoot })) {
      if (r.status !== 'running') continue;
      if (typeof r.pid !== 'number' || !Number.isFinite(r.pid)) continue;
      if (pidAlive(r.pid)) continue;
      const dirs = dirsOf(r.runId);
      const receipt = {
        ...r,
        status: 'failed',
        ok: false,
        error: r.error || 'interrupted',
        finishedAt: r.finishedAt || clock().toISOString(),
      };
      try {
        fs.writeFileSync(dirs.receiptFile, JSON.stringify(receipt, null, 2), { mode: 0o600 });
        swept.push(r.runId);
      } catch {
        /* 单个回执写失败不拖垮整个 sweep */
      }
    }
    return swept;
  }

  exec.runTicket = runTicket;
  exec.steer = steer;
  exec.list = list;
  exec.sweep = sweep;
  exec.rolesRoot = rolesRoot; // 暴露给集成方（P1B 组 snapshot 时派生 runDir 用）
  return exec;
}

module.exports = { createExecutor, composeSteerTask, prevSummary, pidAlive };
