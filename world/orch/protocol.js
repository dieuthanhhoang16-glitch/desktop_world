// world/orch/protocol.js
// desktop-world · 五级窗口协作的结构化协议（纯函数，零 IO）。
//
// 这份协议是"老大/老二/任务窗口"对话协作的机械载体：窗口五态机、窗口头
// （WindowStateHeader）与阶段回执（StageReport）的形状、校验、消毒全部在这里。
// 它与 tickets.js 的工单状态机**正交**——工单走 draft→…→done，窗口走
// planning→…→closed；两边只通过 ORCH 工单 id 互相引用，绝不共享状态。
//
// 纪律：本模块不 require 任何文件系统/网络/本仓库其他模块，也不读环境变量，
// 保证 view-model 层与 CLI/UI/测试拿到的是同一个确定性真相。
'use strict';

// 窗口五态。顺序即推进顺序（严格单向，回边见 WINDOW_TRANSITIONS）。
const WINDOW_STATES = Object.freeze(['planning', 'execution', 'review', 'closeout', 'closed']);

const WINDOW_STATE_LABELS = Object.freeze({
  planning: '规划',
  execution: '执行',
  review: '审查',
  closeout: '收尾',
  closed: '关闭',
});

// 状态色（任务书指定值；UI 侧再映射到 --ot-ws-* token，这里保留单一真相）。
const WINDOW_STATE_COLORS = Object.freeze({
  planning: '#3b82f6',
  execution: '#10b981',
  review: '#f59e0b',
  closeout: '#8b5cf6',
  closed: '#6b7280',
});

// 回执判定。pass-with-non-blocker = 通过但带非阻塞风险（仍允许推进，风险必须入 risks.nonBlocker）。
const VERDICTS = Object.freeze(['pass', 'pass-with-non-blocker', 'fail', 'blocked']);

// 窗口状态迁移表：每态至多一条回边，且每条边的落地都必须过老二裁定 + 人工确认
// （见 stage-lead.advanceWindow；本表只回答"合不合法"，不回答"能不能现在走"）。
const WINDOW_TRANSITIONS = Object.freeze({
  planning: ['execution'],              // 规划批准 → 开工
  execution: ['review', 'planning'],    // 完工送审 / 放弃重规划
  review: ['closeout', 'execution'],    // 审查通过收尾 / 打回返工
  closeout: ['closed', 'review'],       // 回执归档关窗 / 回执不全复验
  closed: [],
});

const WINDOW_STATE_SET = new Set(WINDOW_STATES);
const VERDICT_SET = new Set(VERDICTS);

// 证据类型白名单。manual = 人工描述（最低强度）；synthetic:true 表示演示/占位证据，
// 与 command|file|test 组合即"伪标"，boundary-check 的机器抽查会抓。
const EVIDENCE_TYPES = Object.freeze(['command', 'file', 'screenshot', 'test', 'manual']);

// 回执字段消毒上限（与 blackboard 的 400 字纪律同源）
const MAX_TEXT = 400;
const MAX_PATH = 200;
const MAX_DELIVERABLE = 12;
const MAX_EVIDENCE = 24;
const MAX_RISKS = 12;
const MAX_ITEMS = 24;

function sanitizeText(value, max = MAX_TEXT) {
  return String(value == null ? '' : value)
    .replace(/\r\n?|\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function sanitizeStringList(value, { maxEntry = MAX_TEXT, maxCount, dropEmpty = true }) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const item of value) {
    const s = sanitizeText(item, maxEntry);
    if (!s && dropEmpty) continue;
    out.push(s);
    if (out.length >= maxCount) break;
  }
  return out;
}

/** 状态是否合法。 */
function isWindowState(state) {
  return WINDOW_STATE_SET.has(state);
}

/** verdict 是否合法。 */
function isVerdict(verdict) {
  return VERDICT_SET.has(verdict);
}

/**
 * 迁移合法性（镜像 tickets.canTransition 语义：from===to 🤝 true，未知态 false）。
 * 注意：合法 ≠ 现在就能走——实际推进必须过 stage-lead 的七道关。
 */
function canTransitionWindow(from, to) {
  if (from === to) return true;
  if (!WINDOW_STATE_SET.has(from) || !WINDOW_STATE_SET.has(to)) return false;
  return (WINDOW_TRANSITIONS[from] || []).includes(to);
}

/** 前进方向的下一态（不含回边）；closed 返回 null。 */
function nextWindowState(state) {
  const i = WINDOW_STATES.indexOf(state);
  if (i < 0 || i >= WINDOW_STATES.length - 1) return null;
  return WINDOW_STATES[i + 1];
}

/** 终态判定。 */
function isTerminalWindowState(state) {
  return state === 'closed' || !WINDOW_STATE_SET.has(state);
}

/** pass 系判定（允许推进的两档）。 */
function verdictOkForAdvance(verdict) {
  return verdict === 'pass' || verdict === 'pass-with-non-blocker';
}

// 每个状态的"唯一目标"。soleGoal 是窗口头上最重要的字段：它在任何时刻都回答
// "这个窗口现在只应该干什么"，越界检查（范围/越界/未授权启动）都拿它当尺。
const WINDOW_GOALS = Object.freeze({
  planning: '明确路径并拆解任务，产出现有代码样例和可复用工具清单，等待批准',
  execution: '在阶段范围内增量修改，不启动后续阶段，不顺手做下一任务',
  review: '对照验收标准验证成果，生成客观回执，不做掩盖式修复',
  closeout: '清理临时产物，更新文档，提交结构化最终回执',
  closed: '阶段已关闭，任何新工作必须重开负责人窗口',
});

/**
 * 某状态的唯一目标与下一个允许去向。
 * @returns {{currentWindowState:string, soleGoal:string, nextAllowedState:string|null}}
 */
function windowGoalFor(state) {
  const s = WINDOW_STATE_SET.has(state) ? state : 'planning';
  const forward = nextWindowState(s);
  // nextAllowedState 只露前进方向；回边是裁定失败时的退路，不写进窗口头
  // （窗口头是给执行者看的，退路是给裁定者看的）。
  return { currentWindowState: s, soleGoal: WINDOW_GOALS[s], nextAllowedState: forward };
}

/**
 * 组装 WindowStateHeader（协议四字段：currentMilestone / currentWindowState /
 * soleGoal / nextAllowedState）。
 * @param slice {milestone, windowState?} —— 缺 state 时回 planning（"还没开工"的诚实表达）
 */
function windowHeader(slice = {}) {
  const goal = windowGoalFor(slice.windowState);
  return {
    currentMilestone: sanitizeText(slice.milestone, MAX_PATH),
    ...goal,
  };
}

function normalizeEvidenceItem(raw) {
  if (typeof raw === 'string') {
    const content = sanitizeText(raw);
    return content ? { type: 'manual', content } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const content = sanitizeText(raw.content);
  if (!content) return null;
  const item = {
    type: EVIDENCE_TYPES.includes(raw.type) ? raw.type : 'manual',
    content,
  };
  if (raw.synthetic === true) item.synthetic = true;
  return item;
}

function normalizeBoundaryCheck(raw) {
  const check = { version: 1, checkedAt: null, items: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return check;
  if (typeof raw.checkedAt === 'string' && raw.checkedAt.trim()) {
    check.checkedAt = sanitizeText(raw.checkedAt, 40);
  }
  if (Array.isArray(raw.items)) {
    for (const it of raw.items.slice(0, MAX_ITEMS)) {
      if (!it || typeof it !== 'object') continue;
      const id = sanitizeText(it.id, 40);
      if (!id) continue;
      const item = { id, passed: it.passed === true };
      const note = sanitizeText(it.note, MAX_PATH);
      if (note) item.note = note;
      const tag = sanitizeText(it.evidenceTag, 40);
      if (tag) item.evidenceTag = tag;
      check.items.push(item);
    }
  }
  return check;
}

/**
 * 校验 + 消毒一份 StageReport。白名单重建：未知字段丢弃，已知字段全部收形。
 * 校验失败返回 problems（与 actions 层 {code, reason, fix} 协议同形）。
 *
 * @param raw 任意输入（CLI --file 读入的 JSON / IPC payload）
 * @returns {{ok:true, report:StageReport} | {ok:false, problems:Array}}
 */
function validateStageReport(raw) {
  const problems = [];
  const push = (code, reason, fix) => problems.push({ code, reason, fix });

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    push('report-not-object', '回执必须是一个 JSON 对象', '按 StageReport 字段清单补齐后重交');
    return { ok: false, problems };
  }

  if (!isWindowState(raw.stageState)) {
    push(
      'report-state-invalid',
      `stageState 必须是五态之一（${WINDOW_STATES.join('/')}），收到：${sanitizeText(raw.stageState, 40) || '(空)'}`,
      'stageState 填这份回执所验证的窗口状态（如 execution）',
    );
  }
  if (!isVerdict(raw.verdict)) {
    push(
      'report-verdict-invalid',
      `verdict 必须是 ${VERDICTS.join(' / ')}，收到：${sanitizeText(raw.verdict, 40) || '(空)'}`,
      'pass=通过；pass-with-non-blocker=通过但带非阻塞风险；fail=不过关；blocked=阻塞待决',
    );
  }

  let deliverable = [];
  if (raw.deliverable != null) {
    deliverable = sanitizeStringList(raw.deliverable, { maxEntry: MAX_PATH, maxCount: MAX_DELIVERABLE });
    if (deliverable == null) {
      push('report-deliverable-type', 'deliverable 必须是字符串数组', '列出本阶段交付的文件/行为，每条一行');
      deliverable = [];
    }
  }
  if (isVerdict(raw.verdict) && verdictOkForAdvance(raw.verdict) && deliverable.length === 0) {
    push('report-deliverable-required', 'verdict 为 pass 系时 deliverable 不能为空（通过了什么必须可指认）', '至少列出一条交付物路径或行为描述');
  }

  let evidence = [];
  if (raw.evidence != null) {
    if (!Array.isArray(raw.evidence)) {
      push('report-evidence-type', 'evidence 必须是数组（字符串或 {type, content} 对象）', '例：{"type":"test","content":"node --test 全绿"}');
    } else {
      evidence = raw.evidence.map(normalizeEvidenceItem).filter(Boolean).slice(0, MAX_EVIDENCE);
    }
  }

  let risks = { blocker: [], nonBlocker: [] };
  if (raw.risks != null) {
    if (typeof raw.risks !== 'object' || Array.isArray(raw.risks)) {
      push('report-risks-type', 'risks 必须是 {blocker:[], nonBlocker:[]} 对象', '阻塞风险进 blocker，其余进 nonBlocker');
    } else {
      risks = {
        blocker: (sanitizeStringList(raw.risks.blocker, { maxCount: MAX_RISKS }) || []),
        nonBlocker: (sanitizeStringList(raw.risks.nonBlocker, { maxCount: MAX_RISKS }) || []),
      };
    }
  }

  let boundaryCheck = { version: 1, checkedAt: null, items: [] };
  if (raw.boundaryCheck != null) {
    if (typeof raw.boundaryCheck !== 'object' || Array.isArray(raw.boundaryCheck)) {
      push('report-boundary-type', 'boundaryCheck 必须是 {version, checkedAt, items[]} 对象', 'items 逐条 {id, passed, note?}，九项清单见 boundary-check.js');
    } else {
      boundaryCheck = normalizeBoundaryCheck(raw.boundaryCheck);
    }
  }

  let blockingDecision = { blocker: '', blocksStageClose: false, blocksNextStage: false };
  if (raw.blockingDecision != null) {
    if (typeof raw.blockingDecision !== 'object' || Array.isArray(raw.blockingDecision)) {
      push('report-blocking-type', 'blockingDecision 必须是 {blocker, blocksStageClose, blocksNextStage} 对象', '无阻塞也要显式给 false，不许省略');
    } else {
      blockingDecision = {
        blocker: sanitizeText(raw.blockingDecision.blocker),
        blocksStageClose: raw.blockingDecision.blocksStageClose === true,
        blocksNextStage: raw.blockingDecision.blocksNextStage === true,
      };
    }
  }

  if (problems.length) return { ok: false, problems };

  return {
    ok: true,
    report: {
      stageState: raw.stageState,
      verdict: raw.verdict,
      deliverable,
      evidence,
      risks,
      boundaryCheck,
      blockingDecision,
      recommendedNextStep: sanitizeText(raw.recommendedNextStep),
    },
  };
}

module.exports = {
  WINDOW_STATES,
  WINDOW_STATE_LABELS,
  WINDOW_STATE_COLORS,
  VERDICTS,
  WINDOW_TRANSITIONS,
  EVIDENCE_TYPES,
  isWindowState,
  isVerdict,
  canTransitionWindow,
  nextWindowState,
  isTerminalWindowState,
  verdictOkForAdvance,
  windowGoalFor,
  windowHeader,
  validateStageReport,
};
