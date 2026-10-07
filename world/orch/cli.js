#!/usr/bin/env node
// world/orch/cli.js · 多智能体编排命令行入口（纯 Node，不经 Electron）。
//
// 拆分流程（确定性优先，stage ③ 人确认是硬闸门）：
//   目标 → ①本地拆分器出工单草案 → ②dispatch 可行性检查 → ③【人确认】逐条 y/n
//        → ④写 tickets.json 并投递到目标 agent 的 mailbox → ⑤观察 agent 状态变化
//        → ⑥工单收敛后回报进 blackboard
//
// 明确不做（也不该被加回来的东西）：
//   · 不 spawn 任何进程、不决定启动哪个 agent、不指定执行什么命令
//   · 不碰权限链路：工单只是写进目标 session 的收件箱，agent 要不要动手、
//     工具要不要批准，仍完全走 src/permission.js 原链路
//   · 编排的是**已存在的、可被观察的** coding agent 会话，不是自己拉 PTY
//
// 用法：
//   npm run world:orch -- list                      # 看工单看板
//   npm run world:orch -- status                    # 看板 + 工位 + 收件箱概览
//   npm run world:orch -- plan "<目标>" --agent claude-code [--cwd .] [--independent]
//   npm run world:orch -- plan "<目标>" ... --dry-run   # 只拆分+检查，不写盘不进确认
//   npm run world:orch -- plan "<目标>" ... --yes        # 跳过逐条确认（批量场景，慎用）
//   npm run world:orch -- confirm ORCH-001 [--to <sessionId>]
//   npm run world:orch -- dispatch ORCH-001 [--to <sessionId>]
//   npm run world:orch -- check                      # 只跑可行性检查（含成环）
//   npm run world:orch -- converge ORCH-001 --summary "…"
//   npm run world:orch -- note "一条共享事实"
//   npm run world:orch -- facts                      # 看黑板
//   npm run world:orch -- agents                     # 列出可派单的目标 agent
'use strict';

const path = require('path');
const readline = require('readline');

const T = require('./tickets');
const store = require('./store');
const blackboard = require('./blackboard');
const mailbox = require('./mailbox');
const dispatch = require('./dispatch');
const scene = require('./scene-agents');
const orch = require('./index');
const { loadPrefs } = require('./prefs-source');
const { ORCH_DIR, ticketsFile, blackboardFile, STATUSES, STATUS_LABELS, sanitizeSessionId } = require('./paths');
const { getAllAgents } = require('../../agents/registry');

const args = process.argv.slice(2);
const flagVal = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  if (hit) return hit.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !String(args[i + 1]).startsWith('--') ? args[i + 1] : dflt;
};
const has = (name) => args.includes(name);
const ROOT = process.env.WORLD_ORCH_DIR || ORCH_DIR;

// ---------------------------------------------------------------- 目标文本

/** CLI 会消费掉的值型 flag —— 它们的下一个 token 不是目标文本。 */
const VALUE_FLAGS = new Set(['--agent', '--cwd', '--to', '--summary', '--kind', '--confirm', '--dispatch', '--converge', '--note', '--goal']);

/**
 * --plan / --note 的自由文本：--goal="…" 优先，否则取第一个"不是子命令、不是 flag、
 * 也不是某个值型 flag 的值"的裸串。
 * 注意 args[0] 是子命令名本身（plan/note/…），必须跳过 —— 否则目标会变成 "plan"。
 */
function readGoal() {
  const eq = args.find((a) => String(a).startsWith('--goal='));
  if (eq) return eq.slice('--goal='.length);
  const i = args.indexOf('--goal');
  if (i >= 0 && args[i + 1] && !String(args[i + 1]).startsWith('--')) return args[i + 1];

  // 标记出所有"被 flag 吃掉的位置"，避免把 flag 的值误当目标
  const consumed = new Set([0]); // args[0] 是子命令
  args.forEach((a, k) => {
    if (VALUE_FLAGS.has(a) && k + 1 < args.length) consumed.add(k + 1);
  });

  for (let k = 1; k < args.length; k += 1) {
    if (consumed.has(k)) continue;
    const a = args[k];
    if (String(a).startsWith('-')) continue;
    return a;
  }
  return '';
}

// ---------------------------------------------------------------- 打印helpers

function printTickets(tickets = []) {
  if (!tickets.length) return '（没有工单）';
  const ICON = { draft: '📝', confirmed: '✅', dispatched: '📤', running: '⚙️', done: '🌳', failed: '❌', blocked: '🚧' };
  return tickets
    .map((t) => {
      const deps = T.depsOf(t);
      const acc = Array.isArray(t.acceptance) ? t.acceptance : [];
      return [
        `${ICON[t.status] || '·'} ${t.id}  [${STATUS_LABELS[t.status] || t.status}]  ${t.title}`,
        `     agent=${t.agent || '(未指定)'}  cwd=${t.cwd || '(未指定)'}  action=${t.action || '-'}`,
        deps.length ? `     依赖：${deps.join(', ')}` : null,
        acc.length ? `     验收：${acc.map((a, i) => `${i + 1}. ${a}`).join(' / ')}` : null,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');
}

function printProblems(problems = []) {
  if (!problems.length) return '';
  return `\n可行性检查未通过，已停止（不硬派）：\n${dispatch.formatProblems(problems)}\n`;
}

// ---------------------------------------------------------------- 命令

function cmdList() {
  const ledger = store.load(ticketsFile(ROOT));
  const tickets = ledger.tickets;
  if (!tickets.length) {
    console.log('还没有工单。先拆一个：');
    console.log('  npm run world:orch -- plan "把 X 做完，然后补测试" --agent claude-code --cwd .');
    return 0;
  }
  const s = T.summarize(tickets);
  console.log(`工单账本：${ticketsFile(ROOT)}`);
  console.log(`共 ${s.total} 张 · 待确认 ${s.pending} · 在跑 ${s.active}\n`);
  const cols = T.groupByStatus(tickets);
  for (const status of STATUSES) {
    if (!cols[status].length) continue;
    console.log(`── ${STATUS_LABELS[status]} (${cols[status].length}) ──`);
    console.log(printTickets(cols[status]));
    console.log('');
  }
  return 0;
}

function cmdCheck() {
  const ledger = store.load(ticketsFile(ROOT));
  const graph = dispatch.checkGraph(ledger.tickets);
  const prefs = loadPrefs();
  const batch = dispatch.checkBatch(ledger.tickets, { prefs: prefs.ok ? prefs.snapshot : null });
  console.log(`依赖图：${graph.ok ? '无环' : '有环 ❌'}`);
  if (graph.order) console.log(`拓扑序：${graph.order.join(' → ')}`);
  if (!prefs.ok) console.log(`\n⚠️ prefs 读取失败：${prefs.reason}\n   → agent gate 判定不可信，下面这些结论只覆盖结构性问题。`);
  console.log(printProblems(batch.problems) || '\n可行性检查通过 ✅');
  return batch.ok ? 0 : 1;
}

function cmdAgents() {
  const prefs = loadPrefs();
  if (!prefs.ok) {
    console.log(`⚠️ prefs 读取失败：${prefs.reason}`);
    console.log('   → 下面按"无 prefs 时默认 fail closed"标注。');
  }
  const snapshot = prefs.ok ? prefs.snapshot : { agents: {} };
  const rows = getAllAgents().map((a) => {
    const r = dispatch.checkAgent(a.id, snapshot);
    return { id: a.id, name: a.displayName || a.name || a.id, ok: r.ok, note: r.ok ? '' : r.code };
  });
  console.log(`prefs：${prefs.ok ? prefs.file : '(读不到)'}\n`);
  console.log('可派单（已安装且已启用）：');
  for (const r of rows.filter((x) => x.ok)) console.log(`  ✅ ${r.id.padEnd(18)} ${r.name}`);
  console.log('\n不可派单：');
  for (const r of rows.filter((x) => !x.ok)) console.log(`  ❌ ${r.id.padEnd(18)} ${r.name}（${r.note}）`);
  return 0;
}

async function cmdPlan() {
  const goal = readGoal();
  if (!goal) {
    console.log('用法：npm run world:orch -- plan "<目标>" [--agent <id>] [--cwd <目录>] [--independent] [--dry-run] [--yes]');
    return 1;
  }
  const agent = flagVal('--agent', '');
  const cwd = path.resolve(flagVal('--cwd', process.cwd()));
  const ledger = store.load(ticketsFile(ROOT));

  // ① 确定性拆分
  const drafts = T.draftTickets(goal, {
    agent,
    cwd,
    existingIds: ledger.tickets.map((t) => t.id),
    independent: has('--independent'),
  });
  if (!drafts.length) {
    console.log('❌ 没能从目标里拆出任何子句（目标为空或全是标点）。');
    return 1;
  }
  console.log(`【目标】${goal}`);
  console.log(`【拆分】确定性规则拆出 ${drafts.length} 张草案（不调 LLM、不含随机）\n`);
  console.log(printTickets(drafts));

  // ② 可行性检查（草案还没落盘，用临时 id 参与依赖图检查）
  const preview = drafts.map((d, i) => ({ ...d, id: T.formatId(ledger.seq + i + 1) }));
  const prefs = loadPrefs();
  if (!prefs.ok) {
    console.log(`\n⚠️ prefs 读取失败：${prefs.reason}`);
  }
  const batch = dispatch.checkBatch(preview, { prefs: prefs.ok ? prefs.snapshot : null, allTickets: preview });
  if (!batch.ok) {
    console.log(printProblems(batch.problems));
    console.log('修正 --agent / --cwd，或去 Settings 把目标 agent 装上并启用，再重跑。');
    return 1;
  }
  console.log('\n【可行性检查】通过 ✅');

  if (has('--dry-run')) {
    console.log('\n--dry-run：到此为止，不写盘、不进确认。');
    return 0;
  }

  // ③ 人确认（硬闸门）——--yes 才跳过；交互模式下逐条 y/n
  const accepted = has('--yes') ? drafts.slice() : await confirmEach(drafts);
  if (!accepted.length) {
    console.log('\n没有工单被确认，未写盘。');
    return 0;
  }
  console.log(`\n【确认】保留 ${accepted.length}/${drafts.length} 张`);
  const acceptedIds = new Set(accepted.map((t) => t.id));
  // 被丢弃的工单如果被保留项当依赖，那条依赖就指向了不存在的 id（dispatch 会报
  // dep-missing，整批都派不出去）。这里把依赖重挂到"最近一张还保留的前置"上，
  // 保持链条连续；没有任何保留前置的就直接删掉这条依赖。
  const repairDeps = (list) => {
    for (const t of list) {
      const kept = [];
      for (const dep of T.depsOf(t)) {
        if (acceptedIds.has(dep)) {
          kept.push(dep);
          continue;
        }
        const idx = list.indexOf(t);
        let replacement = '';
        for (let k = idx - 1; k >= 0; k -= 1) {
          if (acceptedIds.has(list[k].id)) {
            replacement = list[k].id;
            break;
          }
        }
        kept.push(replacement); // 空串会在落账前被过滤
      }
      t.dependsOn = kept.filter(Boolean);
    }
  };
  repairDeps(accepted);

  // ④ 写账本 + 投递到目标 agent 的收件箱
  const saved = store.appendTickets(ticketsFile(ROOT), accepted);
  blackboard.append(blackboardFile(ROOT), {
    kind: 'fact',
    text: `立单 ${accepted.map((t) => t.id).join(', ')}：${goal.slice(0, 120)}`,
    ticketIds: accepted.map((t) => t.id),
  });
  console.log(`【落账】${ticketsFile(ROOT)}`);

  const deliverable = saved.tickets.filter((t) => acceptedIds.has(t.id));
  for (const ticket of deliverable) store.setStatus(ticketsFile(ROOT), ticket.id, 'confirmed');
  const sessionId = flagVal('--to', '');
  if (sessionId) {
    for (const ticket of deliverable) {
      mailbox.deliver(sessionId, {
        kind: 'ticket',
        from: 'orchestrator',
        ticketId: ticket.id,
        body: `${ticket.id} ${ticket.title}`,
        acceptance: ticket.acceptance,
      }, ROOT);
    }
    console.log(`【投递】${sanitizeSessionId(sessionId)} 的收件箱（${deliverable.length} 封）`);
  } else {
    console.log('【投递】跳过（没给 --to <sessionId>）：工单已 confirmed，等你指定目标会话再投。');
  }
  console.log('\n下一步：npm run world:orch -- dispatch ORCH-001 --to <sessionId>');
  return 0;
}

/**
 * 一次一行地问。stdin 收完（EOF）时返回 null，让调用方能干净地退出。
 *
 * 刻意**不用** readline.question：它按"提问→等一行"绑定，管道输入（`printf 'y\nn\n' |`）
 * 时若一次问完，后面的行会丢；而且 EOF 时 promise 悬着不 resolve，表现为进程静默退出、
 * 什么都没写盘。这里改成自己攒行、按需取，取不到就是 EOF。
 */
function createLineReader(input, output) {
  const queue = [];
  let ended = false;
  let wake = null;

  const rl = readline.createInterface({ input, output, terminal: false });
  rl.on('line', (line) => {
    queue.push(String(line).trim().toLowerCase());
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  });
  rl.on('close', () => {
    ended = true;
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  });

  return {
    async ask(prompt) {
      output.write(prompt);
      if (queue.length) return queue.shift();
      if (ended) return null;
      await new Promise((resolve) => { wake = resolve; });
      return queue.length ? queue.shift() : null;
    },
    close() {
      rl.close();
    },
  };
}

/**
 * 逐条确认（stage ③ 的硬闸门实现）。
 * y/回车保留 · n 丢弃 · a 之后全留 · e/q/EOF 立刻全部退出（什么都没写盘）
 */
async function confirmEach(drafts) {
  const reader = createLineReader(process.stdin, process.stdout);
  const accepted = [];
  // 明确被拒的 id 必须记住：循环正常走完后补齐尾部时，绝不能把 n 掉的又捡回来。
  const rejected = new Set();
  let acceptRest = false;
  try {
    for (const d of drafts) {
      if (acceptRest) {
        accepted.push(d);
        continue;
      }
      console.log(`\n───── ${d.id} ─────`);
      console.log(`  标题：${d.title}`);
      console.log(`  agent：${d.agent || '(未指定)'}    cwd：${d.cwd || '(未指定)'}`);
      console.log(`  依赖：${T.depsOf(d).join(', ') || '(无)'}`);
      console.log(`  验收：${(d.acceptance || []).map((a, i) => `${i + 1}. ${a}`).join(' / ')}`);
      const answer = await reader.ask('  保留这张？[Y]es / [n]o / [a]ll / [e]xit > ');
      // EOF（管道输入用完 / Ctrl-D）与 e 同语义：放弃，什么都不写盘
      if (answer === null || answer === 'e' || answer === 'exit' || answer === 'q') {
        console.log('\n已退出：什么都没写盘。');
        return [];
      }
      if (answer === 'a' || answer === 'all') {
        console.log('  → 这张及其余全部保留');
        accepted.push(d);
        acceptRest = true;
        continue;
      }
      if (answer === 'n' || answer === 'no') {
        console.log('  → 丢弃');
        rejected.add(d.id);
        continue;
      }
      accepted.push(d);
      console.log('  → 保留');
    }
  } finally {
    reader.close();
  }
  return accepted.filter((t) => !rejected.has(t.id));
}

function cmdConfirm() {
  const id = flagVal('--confirm', '') || args.find((a) => /^ORCH-\d+$/.test(a));
  if (!id) return 0; // 位置参数形式由 main 分发处理
  const ledger = store.load(ticketsFile(ROOT));
  const ticket = ledger.tickets.find((t) => t.id === id);
  if (!ticket) {
    console.log(`❌ 找不到工单 ${id}`);
    return 1;
  }
  const r = dispatch.checkTicket(ticket, { allTickets: ledger.tickets, prefs: loadPrefs().snapshot });
  if (!r.ok) {
    console.log(`❌ ${id} 还不能确认：\n${dispatch.formatProblems(r.problems)}`);
    return 1;
  }
  const next = store.setStatus(ticketsFile(ROOT), id, 'confirmed');
  console.log(`✅ ${id} 已确认`);
  const sessionId = flagVal('--to', '');
  if (sessionId) {
    mailbox.deliver(sessionId, {
      kind: 'ticket', from: 'orchestrator', ticketId: id,
      body: `${id} ${next.title}`, acceptance: next.acceptance,
    }, ROOT);
    console.log(`📤 已投递到 ${sanitizeSessionId(sessionId)} 的收件箱`);
  }
  return 0;
}

function cmdDispatch() {
  const id = flagVal('--dispatch', '') || args.find((a) => /^ORCH-\d+$/.test(a));
  if (!id) return 0;
  const file = ticketsFile(ROOT);
  const ledger = store.load(file);
  const ticket = ledger.tickets.find((t) => t.id === id);
  if (!ticket) {
    console.log(`❌ 找不到工单 ${id}`);
    return 1;
  }
  if (ticket.status !== 'confirmed') {
    console.log(`❌ ${id} 当前是 ${STATUS_LABELS[ticket.status]}，只有「已确认」的工单能派发（先 npm run world:orch -- confirm ${id}）`);
    return 1;
  }
  const prefs = loadPrefs();
  const batch = dispatch.checkBatch([ticket], { prefs: prefs.ok ? prefs.snapshot : null, allTickets: ledger.tickets });
  if (!batch.ok) {
    console.log(`❌ ${id} 不满足派发条件，不硬派：\n${dispatch.formatProblems(batch.problems)}`);
    return 1;
  }
  const sessionId = flagVal('--to', '');
  if (!sessionId) {
    console.log(`❌ 派发需要 --to <sessionId>（编排层不自己挑会话、更不自己拉进程）。`);
    console.log(`   在 App 的 Sessions Dashboard 里看真实 sessionId，或先用 status 看收件箱概览。`);
    return 1;
  }
  store.setStatus(file, id, 'dispatched');
  mailbox.deliver(sessionId, {
    kind: 'ticket', from: 'orchestrator', ticketId: id,
    body: `${id} ${ticket.title}`, acceptance: ticket.acceptance,
  }, ROOT);
  blackboard.append(blackboardFile(ROOT), {
    kind: 'fact',
    text: `派发 ${id} → ${sanitizeSessionId(sessionId)}`,
    ticketIds: [id],
  });
  console.log(`📤 ${id} 已派发到 ${sanitizeSessionId(sessionId)}`);
  console.log(`   接下来观察那个会话的状态变化：npm run world:orch -- status`);
  return 0;
}

function cmdConverge() {
  const id = flagVal('--converge', '') || args.find((a) => /^ORCH-\d+$/.test(a));
  const summary = flagVal('--summary', '');
  if (!id) {
    console.log('用法：npm run world:orch -- converge ORCH-001 --summary "收敛结论"');
    return 1;
  }
  const file = ticketsFile(ROOT);
  const ticket = store.get(file, id);
  if (!ticket) {
    console.log(`❌ 找不到工单 ${id}`);
    return 1;
  }
  if (ticket.status !== 'running' && ticket.status !== 'dispatched') {
    console.log(`❌ ${id} 当前是 ${STATUS_LABELS[ticket.status]}，只有已派发/执行中的工单能收敛`);
    return 1;
  }
  // dispatched → done 不是合法直跳（必须先 running）。CLI 是单次调用，看不到
  // 中间那一步，所以在这里补一跳running —— 它表达的是"这中间确实在跑"这个观察，
  // 不是绕过状态机。
  if (ticket.status === 'dispatched') store.setStatus(file, id, 'running');
  store.setStatus(file, id, 'done');
  blackboard.reportConvergence(blackboardFile(ROOT), {
    ticketIds: [id],
    summary: summary || `${id} 收敛：${ticket.title}`,
  });
  console.log(`🌳 ${id} 已完成，结论写进黑板。`);
  return 0;
}

function cmdNote() {
  const text = flagVal('--note', '') || readGoal();
  if (!text) {
    console.log('用法：npm run world:orch -- note "一条共享事实"');
    return 1;
  }
  const kind = flagVal('--kind', 'fact');
  blackboard.append(blackboardFile(ROOT), { kind, text });
  console.log(`📌 已写进黑板（${kind}）。`);
  return 0;
}

function cmdFacts() {
  const facts = blackboard.list(blackboardFile(ROOT));
  if (!facts.length) {
    console.log('黑板还是空的。');
    return 0;
  }
  const ICON = { fact: '·', decision: '⚖️', blocker: '🚧', convergence: '🌳', correction: '✏️' };
  console.log(`共享事实（${facts.length} 条，最新在前）：`);
  for (const f of facts) {
    const stamp = new Date(f.at).toLocaleString();
    console.log(`  ${ICON[f.kind] || '·'} [${stamp}]${f.ticketIds.length ? ` (${f.ticketIds.join(', ')})` : ''} ${f.text}`);
  }
  return 0;
}

function cmdStatus() {
  const view = orch.buildOrchView({ root: ROOT });
  console.log('══ 工位场景 ══');
  console.log(view.scene.svg);
  console.log(`工位 ${view.scene.stations.length} 个：${view.scene.stations.map((s) => `${s.id}:${s.status}`).join('  ') || '(空)'}`);
  if (view.cycles.length) {
    console.log(`\n⚠️ 依赖成环：${view.cycles.map((c) => c.join(' → ')).join('；')}`);
  }
  console.log('\n══ 工单 ══');
  console.log(printTickets(view.tickets));
  console.log('\n══ 收件箱 ══');
  if (!view.inbox.length) console.log('（没有未读信封）');
  for (const b of view.inbox) console.log(`  ✉️ ${b.sessionId}：${b.unread} 封未读`);
  return 0;
}

function cmdScene() {
  const view = orch.buildOrchView({ root: ROOT });
  console.log(view.scene.svg);
  console.log(view.scene.stations.map((s) => `${s.id} ${s.action} @(${s.x},${s.y})`).join('\n'));
  return 0;
}

// ---------------------------------------------------------------- 分发

async function main() {
  const cmd = args[0];

  if (cmd === 'plan') return cmdPlan();
  if (cmd === 'confirm') return cmdConfirm();
  if (cmd === 'dispatch') return cmdDispatch();
  if (cmd === 'converge') return cmdConverge();
  if (cmd === 'note') return cmdNote();
  if (cmd === 'facts') return cmdFacts();
  if (cmd === 'status') return cmdStatus();
  if (cmd === 'scene') return cmdScene();
  if (cmd === 'check') return cmdCheck();
  if (cmd === 'agents') return cmdAgents();
  if (cmd === 'list' || !cmd) return cmdList();

  console.log('用法：');
  console.log('  list | status | check | agents | facts | scene');
  console.log('  plan "<目标>" [--agent <id>] [--cwd <目录>] [--independent] [--dry-run] [--yes]');
  console.log('  confirm <ORCH-xxx> [--to <sessionId>]');
  console.log('  dispatch <ORCH-xxx> --to <sessionId>');
  console.log('  converge <ORCH-xxx> --summary "结论"');
  console.log('  note "一条共享事实"');
  return 1;
}

main()
  .then((code) => process.exit(code || 0))
  .catch((err) => {
    console.error(`❌ ${err.message || err}`);
    process.exit(1);
  });