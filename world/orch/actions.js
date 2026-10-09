// world/orch/actions.js
// desktop-world · 编排层写操作的动作层（v0.7 M2：CLI 之外的第二条写入口，IPC 挂载点）。
//
// 为什么单独成层：cli.js 的写路径（confirm/dispatch/converge）散在各 cmd 函数里，
// 输出是 console.log；App 内的调度树要的是**结构化返回**（成功给新工单，失败给可上墙
// 的 problems）。本层把同一套写语义收拢成纯函数式的动作，CLI 与 IPC 谁调都一样：
//
//   ① 同一套闸门：confirm/dispatch 复用 dispatch.js 的 checkTicket/checkBatch，
//      状态推进只走 store.setStatus（非法迁移由状态机拒绝，不在这里发明例外）。
//   ② 永不抛错：任何内部异常都折成 {ok:false, problems:[{code:'internal-error',…}]}。
//      IPC handler 拿到的永远是可以直接贴进守门员栏的错误协议。
//   ③ 错误协议与 dispatch.js CHECKS 同形状：{code, reason, fix, id?}。
//      reason 给人看，fix 给"下一步怎么办"，UI 只认这一种形状。
//   ④ 不写进程、不拉会话：本层能做的最多是把信封写进收件箱文件（mailbox.deliver），
//      与 CLI 完全同一个上限。守门员红线在这里同样成立。
//
// 测试注入 {root, prefs}；生产环境两个都缺省（root=ORCH_DIR，prefs 走 prefs-source）。
'use strict';

const { ORCH_DIR, ticketsFile, blackboardFile, STATUS_LABELS, sanitizeSessionId } = require('./paths');
const store = require('./store');
const T = require('./tickets');
const dispatch = require('./dispatch');
const mailbox = require('./mailbox');
const blackboard = require('./blackboard');
const { loadPrefs } = require('./prefs-source');

const TICKET_ID_RE = /^ORCH-\d{3,}$/;

// 动作 → 目标状态。confirm/dispatch/converge 有各自的附加语义（闸门/投递/黑板），
// fail/block/redraft/reconfirm 是纯状态机推进（可选人话备注上黑板）。
const ACTIONS = Object.freeze({
  confirm: 'confirmed',
  dispatch: 'dispatched',
  converge: 'done',
  fail: 'failed',
  block: 'blocked',
  redraft: 'draft',
  reconfirm: 'confirmed',
});

// patch 允许动的字段（白名单）：结构字段只在"还没派出去"（含 blocked 停车库）能改；
// acceptanceDone 是收敛勾选，执行中也得能勾，唯独 done 之后不再改。
const PATCH_STRUCT_FIELDS = new Set(['title', 'agent', 'cwd', 'dependsOn', 'acceptance']);
const PATCH_FIELDS = new Set([...PATCH_STRUCT_FIELDS, 'acceptanceDone']);

function problem(code, reason, fix, extra) {
  return { code, reason, fix, ...(extra || {}) };
}

function fail(problems) {
  return { ok: false, problems: Array.isArray(problems) ? problems : [problems] };
}

function internalError(err) {
  // 内部异常不向上抛（纪律②），但 message 对人类仍有价值 —— 上次把 message 吞掉后，
  // 「随手记保存失败」这类问题排查了半小时。message 里没有密钥（写路径不碰 LLM）。
  return fail(problem('internal-error', `动作层内部错误：${err && err.message ? err.message : err}`, '截屏这条信息提 issue；账本可能被改到一半，`npm run world:orch -- status` 核对'));
}

/** 载入账本+找工单。找不到返回 {problems} 短路形状。 */
function loadTicket(root, id) {
  if (!TICKET_ID_RE.test(String(id || ''))) {
    return { problems: [problem('ticket-id-invalid', `工单号不合法：${id}`, '工单号形如 ORCH-001（账本发号，不手编）')] };
  }
  const ledger = store.load(ticketsFile(root));
  const ticket = ledger.tickets.find((t) => t.id === id);
  if (!ticket) {
    return { problems: [problem('ticket-not-found', `找不到工单 ${id}`, '可能已被删除；状态行里的计数是实时账本，刷新一下树')], };
  }
  return { ledger, ticket };
}

/** prefs 快照：注入优先，缺省走 prefs-source。读不到 → 显式拒绝（默认不信任）。 */
function prefsSnapshot(deps) {
  if (Object.prototype.hasOwnProperty.call(deps, 'prefs')) {
    if (deps.prefs && typeof deps.prefs === 'object') return deps.prefs;
    return null;
  }
  const r = loadPrefs();
  return r.ok ? r.snapshot : null;
}

function prefsProblem() {
  return problem('prefs-unavailable', '读不到 clawd-prefs.json，agent 闸门无法判定', '先启动一次桌宠 App 生成 prefs；或 WORLD_PREFS_FILE 指定路径');
}

/** 目标状态机在当前状态下是否可达（不可达 → 结构化拒绝，不让 store 抛字符串）。 */
function transitionProblem(ticket, target) {
  if (T.canTransition(ticket.status, target)) return null;
  const cur = STATUS_LABELS[ticket.status] || ticket.status;
  const want = STATUS_LABELS[target] || target;
  return problem(
    'transition-invalid',
    `${ticket.id} 当前是「${cur}」，不能直接到「${want}」`,
    target === 'confirmed' ? '草案才能确认；已派出的先收敛或标失败' :
    target === 'dispatched' ? `先确认这张单（当前 ${cur}）` :
    target === 'done' ? '只有已派发/执行中的工单能收敛' :
    '按状态机一步步来（看 statusLabel 旁的可用按钮）',
    { id: ticket.id },
  );
}

// ---------------------------------------------------------------- 动作实现

function doConfirm(root, ledger, ticket, deps) {
  const bad = transitionProblem(ticket, 'confirmed');
  if (bad) return fail(bad);
  const prefs = prefsSnapshot(deps);
  if (!prefs) return fail(prefsProblem());
  // 与 cmdConfirm 同一道闸门：agent gate + cwd + 前置就绪
  const r = dispatch.checkTicket(ticket, { allTickets: ledger.tickets, prefs });
  if (!r.ok) return fail(r.problems);
  const next = store.setStatus(ticketsFile(root), ticket.id, 'confirmed');
  return { ok: true, ticket: next };
}

function doDispatch(root, ledger, ticket, payload, deps) {
  // CLI 同款前置：只有 confirmed 能派（这是业务规则，不只是状态机）
  if (ticket.status !== 'confirmed') {
    return fail(problem('dispatch-not-confirmed', `${ticket.id} 当前是「${STATUS_LABELS[ticket.status] || ticket.status}」，只有「已确认」的工单能派发`, '先确认这张单；failed/blocked 的先重确', { id: ticket.id }));
  }
  const sessionId = String((payload && payload.sessionId) || '').trim();
  if (!sessionId) {
    return fail(problem('session-required', '派发需要选定目标会话', '从会话选择器里挑一个（同 agent 同 cwd 的排在最前）；编排层不自己挑、更不拉进程', { id: ticket.id }));
  }
  const prefs = prefsSnapshot(deps);
  if (!prefs) return fail(prefsProblem());
  const batch = dispatch.checkBatch([ticket], { prefs, allTickets: ledger.tickets });
  if (!batch.ok) return fail(batch.problems);
  // —— 以下与 cmdDispatch 同一个写序，别调整顺序：先翻账本，再投信封，最后上黑板 ——
  store.setStatus(ticketsFile(root), ticket.id, 'dispatched');
  mailbox.deliver(sessionId, {
    kind: 'ticket', from: 'orchestrator', ticketId: ticket.id,
    body: `${ticket.id} ${ticket.title}`, acceptance: ticket.acceptance,
  }, root);
  blackboard.append(blackboardFile(root), {
    kind: 'fact',
    text: `派发 ${ticket.id} → ${sanitizeSessionId(sessionId)}`,
    ticketIds: [ticket.id],
  });
  return { ok: true, ticket: store.get(ticketsFile(root), ticket.id) };
}

function doConverge(root, ticket, payload) {
  if (ticket.status !== 'running' && ticket.status !== 'dispatched') {
    return fail(problem('converge-not-running', `${ticket.id} 当前是「${STATUS_LABELS[ticket.status] || ticket.status}」，只有已派发/执行中的工单能收敛`, '草案/已确认的先派发；失败的先重确再跑', { id: ticket.id }));
  }
  // 验收勾选先落账（即使后面 summary 为空也不丢勾选状态）
  if (payload && Array.isArray(payload.acceptanceDone)) {
    store.patchTicket(ticketsFile(root), ticket.id, { acceptanceDone: payload.acceptanceDone.map(Boolean) });
  }
  const file = ticketsFile(root);
  // dispatched → done 不是合法直跳：CLI 在这里补一跳 running，含义是"这中间确实在跑"，
  // 不是绕过状态机（cmdConverge 同款注释，同一个理由）
  if (ticket.status === 'dispatched') store.setStatus(file, ticket.id, 'running');
  store.setStatus(file, ticket.id, 'done');
  const summary = String((payload && payload.summary) || '').trim().slice(0, 200);
  blackboard.reportConvergence(blackboardFile(root), {
    ticketIds: [ticket.id],
    summary: summary || `${ticket.id} 收敛：${ticket.title}`,
  });
  return { ok: true, ticket: store.get(file, ticket.id) };
}

function doSimple(root, ticket, action, payload) {
  const target = ACTIONS[action]; // fail | block | redraft | reconfirm
  const bad = transitionProblem(ticket, target);
  if (bad) return fail(bad);
  const next = store.setStatus(ticketsFile(root), ticket.id, target);
  // 人话备注（可选）：失败/阻塞上黑板，session log 马上能看见"为什么"
  const reason = String((payload && payload.reason) || '').trim().slice(0, 200);
  if (reason && (action === 'fail' || action === 'block')) {
    blackboard.append(blackboardFile(root), {
      kind: 'blocker',
      text: `标记${action === 'fail' ? '失败' : '阻塞'} ${ticket.id}：${reason}`,
      ticketIds: [ticket.id],
    });
  }
  return { ok: true, ticket: next };
}

/**
 * 状态推进统一入口。
 * @param id      ORCH-XXX
 * @param action  confirm|dispatch|converge|fail|block|redraft|reconfirm
 * @param payload dispatch:{sessionId} converge:{summary, acceptanceDone} fail/block:{reason?}
 * @param deps    {root=ORCH_DIR, prefs}（测试注入用）
 * @returns {ok:true, ticket} | {ok:false, problems[]}
 */
function transition(id, action, payload = {}, deps = {}) {
  const root = deps.root || ORCH_DIR;
  try {
    if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) {
      return fail(problem('action-unknown', `未知动作：${action}`, `白名单：${Object.keys(ACTIONS).join(' / ')}`));
    }
    const ctx = loadTicket(root, id);
    if (ctx.problems) return fail(ctx.problems);
    if (action === 'confirm') return doConfirm(root, ctx.ledger, ctx.ticket, deps);
    if (action === 'dispatch') return doDispatch(root, ctx.ledger, ctx.ticket, payload, deps);
    if (action === 'converge') return doConverge(root, ctx.ticket, payload);
    return doSimple(root, ctx.ticket, action, payload);
  } catch (err) {
    return internalError(err);
  }
}

/** 单字段消毒。返回 {value} 或 {problem}。 */
function sanitizePatchField(key, value, selfId) {
  switch (key) {
    case 'title': {
      const v = String(value == null ? '' : value).trim().slice(0, 200);
      if (!v) return { problem: problem('patch-value-invalid', '标题不能为空', '工单标题是树卡上的主文字，至少写一个字', { id: selfId }) };
      return { value: v };
    }
    case 'agent': {
      const v = String(value == null ? '' : value).trim().slice(0, 80);
      if (!v || !/^[\w.:-]+$/.test(v)) {
        return { problem: problem('patch-value-invalid', `agent 不合法：${value}`, '填已注册的 agent id（custom- 前缀的自定义 agent 也行）；派发时三闸门会再验一次', { id: selfId }) };
      }
      return { value: v };
    }
    case 'cwd': {
      const v = String(value == null ? '' : value).trim().slice(0, 400);
      if (!v) return { problem: problem('patch-value-invalid', 'cwd 不能为空', '编排层不猜目录：填一个真实存在的目录', { id: selfId }) };
      return { value: v };
    }
    case 'dependsOn': {
      if (!Array.isArray(value)) {
        return { problem: problem('patch-value-invalid', 'dependsOn 必须是工单号数组', '形如 ["ORCH-001"]；不依赖谁就传 []', { id: selfId }) };
      }
      const deps = [...new Set(value.map(String).map((s) => s.trim()).filter((s) => TICKET_ID_RE.test(s)))];
      if (deps.includes(selfId)) {
        return { problem: problem('patch-value-invalid', '不能依赖自己', '把 dependsOn 里的自己去掉', { id: selfId }) };
      }
      return { value: deps };
    }
    case 'acceptance': {
      if (!Array.isArray(value)) {
        return { problem: problem('patch-value-invalid', 'acceptance 必须是字符串数组', '每条验收标准是单独一项', { id: selfId }) };
      }
      return { value: value.map((a) => String(a == null ? '' : a).trim().slice(0, 200)).filter(Boolean).slice(0, 12) };
    }
    case 'acceptanceDone': {
      if (!Array.isArray(value)) {
        return { problem: problem('patch-value-invalid', 'acceptanceDone 必须是布尔数组', '与 acceptance 一一对齐的勾选状态', { id: selfId }) };
      }
      return { value: value.map(Boolean) };
    }
    default:
      return { problem: problem('patch-field-unknown', `不允许 patch 字段：${key}`, `白名单：${[...PATCH_FIELDS].join(' / ')}`, { id: selfId }) };
  }
}

/**
 * 改工单字段。结构字段（标题/agent/cwd/依赖/验收）只在 pre-dispatch + blocked 可改；
 * acceptanceDone 在 done 之前随时可勾。任何一步不合格都整单不改（不落半截 patch）。
 */
function patch(id, patchObj = {}, deps = {}) {
  const root = deps.root || ORCH_DIR;
  try {
    const ctx = loadTicket(root, id);
    if (ctx.problems) return fail(ctx.problems);
    const { ticket } = ctx;
    if (!patchObj || typeof patchObj !== 'object' || Array.isArray(patchObj)) {
      return fail(problem('patch-value-invalid', 'patch 必须是对象', '形如 {title:"新标题"} 或 {acceptanceDone:[true,false]}', { id: ticket.id }));
    }
    const keys = Object.keys(patchObj);
    if (!keys.length) return { ok: true, ticket }; // 空 patch：什么都不做，幂等成功

    const unknown = keys.filter((k) => !PATCH_FIELDS.has(k));
    if (unknown.length) {
      return fail(problem('patch-field-unknown', `不允许 patch 字段：${unknown.join(', ')}`, `白名单：${[...PATCH_FIELDS].join(' / ')}（id 与 status 走 transition，不走 patch）`, { id: ticket.id }));
    }

    const touchesStruct = keys.some((k) => PATCH_STRUCT_FIELDS.has(k));
    if (touchesStruct && !(T.isPreDispatch(ticket.status) || ticket.status === 'blocked')) {
      return fail(problem('patch-forbidden', `已派出的工单不能改结构字段（${ticket.id} 当前 ${STATUS_LABELS[ticket.status] || ticket.status}）`, '先标失败/阻塞退回，改完再重确；执行中能动的只有验收勾选', { id: ticket.id }));
    }
    if (keys.includes('acceptanceDone') && ticket.status === 'done') {
      return fail(problem('patch-forbidden', '已完成的工单不再改验收勾选', '验收在收敛之前勾；done 是账本的终点', { id: ticket.id }));
    }

    const clean = {};
    const problems = [];
    for (const k of keys) {
      const r = sanitizePatchField(k, patchObj[k], ticket.id);
      if (r.problem) problems.push(r.problem);
      else clean[k] = r.value;
    }
    if (problems.length) return fail(problems);

    return { ok: true, ticket: store.patchTicket(ticketsFile(root), ticket.id, clean) };
  } catch (err) {
    return internalError(err);
  }
}

/** 删单：只 draft/confirmed 可删（store 层把着这道门），已派出去的是既成事实。 */
function removeTicket(id, deps = {}) {
  const root = deps.root || ORCH_DIR;
  try {
    const ctx = loadTicket(root, id);
    if (ctx.problems) return fail(ctx.problems);
    try {
      store.remove(ticketsFile(root), id);
    } catch (err) {
      return fail(problem('remove-refused', err.message, '已派出的工单：标失败，或阻塞后改派', { id }));
    }
    return { ok: true, removed: id };
  } catch (err) {
    return internalError(err);
  }
}

/**
 * 派发会话选择器的候选列表（纯函数）：同 agent 同 cwd 的会话置顶，
 * 与 index.js matchSession 的"同 cwd > 在干活 > 任意"同一套优先级口径，
 * 避免"选择器推荐的"和"工位实际匹配的"不是同一个人。
 * snapshot 形状对齐 session snapshot（{sessions:[{id,agentId,agentName,state,cwd,headless}]}）。
 */
function sessionsFor(ticket, snapshot) {
  const agent = String((ticket && ticket.agent) || '');
  const cwd = String((ticket && ticket.cwd) || '');
  let wantCwd = '';
  try { wantCwd = cwd ? require('path').resolve(cwd) : ''; } catch { wantCwd = ''; }
  const list = (snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions : [])
    .filter((s) => s && s.id)
    .map((s) => {
      const sAgent = String(s.agentId || s.agentName || '');
      const sCwd = String(s.cwd || '');
      let sameCwd = false;
      if (wantCwd && sCwd) {
        try { sameCwd = require('path').resolve(sCwd) === wantCwd; } catch { sameCwd = false; }
      }
      return {
        id: String(s.id),
        agentId: sAgent,
        agentName: String(s.agentName || sAgent),
        state: String(s.state || 'idle'),
        cwd: sCwd,
        headless: s.headless === true,
        sameAgent: !!agent && sAgent === agent,
        sameCwd,
      };
    });
  // 排序与 matchSession 同口径：headless 全局沉底（matchSession 只在没有任何
  // 非 headless 会话时才拿 headless 兜底），组内 同agent+同cwd > 同agent > 其他
  list.sort((a, b) =>
    Number(a.headless) - Number(b.headless)
    || Number(b.sameAgent && b.sameCwd) - Number(a.sameAgent && a.sameCwd)
    || Number(b.sameAgent) - Number(a.sameAgent)
    || a.id.localeCompare(b.id));
  return list;
}

module.exports = {
  ACTIONS,
  PATCH_FIELDS,
  transition,
  patch,
  removeTicket,
  sessionsFor,
};
