// world/orch/boundary-check.js
// desktop-world · 九项边界检查清单（纯函数，零 IO）。
//
// 清单是任务窗口回执（StageReport.boundaryCheck）的裁判尺：回执自报九项 ✅/❌，
// 老二（stage-lead）在关口核对。九项分两类：
//   人工判定（scope / overreach / unauthorized / authority / masking / legacy）
//     —— 机器没有上下文，诚实做法是让窗口自报 + 关口抽查，代码只保证"逐项都在"。
//   机器可抽查（fake-evidence / garbage / second-source）
//     —— assertEvidenceConsistency 从回执内容本身就能看出的自相矛盾，
//        提交回执时即拦（pass 系 verdict 但被机器抽查命中 = 直接拒收）。
'use strict';

const BOUNDARY_RULES = Object.freeze([
  { id: 'scope', label: '范围', intent: '所有改动仍在当前任务/阶段范围内' },
  { id: 'overreach', label: '越界', intent: '未顺手做下一任务的事' },
  { id: 'unauthorized', label: '未授权启动', intent: '未擅自启动后续阶段' },
  { id: 'authority', label: '权威变更', intent: '未修改不属于本任务的核心决策模块' },
  { id: 'second-source', label: '第二事实源', intent: '未引入第二个 formal artifact' },
  { id: 'garbage', label: '垃圾入库', intent: 'runtime/tmp/cache 产物未入库' },
  { id: 'masking', label: '掩盖式修复', intent: '未用 patch 掩盖底层问题' },
  { id: 'legacy', label: '旧污染', intent: '未带入旧项目的修补逻辑' },
  { id: 'fake-evidence', label: '证据真实性', intent: '证据未被误标/伪造' },
]);

const RULE_IDS = BOUNDARY_RULES.map((r) => r.id);
const RULE_BY_ID = new Map(BOUNDARY_RULES.map((r) => [r.id, r]));

// 机器可抽查的三项（其余六项维持人工判定，代码绝不假装能判）
const MACHINE_CHECKABLE = Object.freeze(['fake-evidence', 'garbage', 'second-source']);

// deliverable 里出现这些路径段 = 垃圾入库（tmp/cache/runtime 产物进交付清单）
const GARBAGE_PATH_RE = /(^|[/\\])(tmp|temp|cache|runtime|\.cache|node_modules)([/\\]|$)/i;

function listRules() {
  return BOUNDARY_RULES.slice();
}

/** 九项全 ❌ 的空清单（回执起草起点——默认不过，逐项声明才算数）。 */
function defaultChecklist() {
  return BOUNDARY_RULES.map((r) => ({ id: r.id, passed: false }));
}

function sanitizeNote(value, max = 200) {
  return String(value == null ? '' : value)
    .replace(/\r\n?|\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * 收形成规范清单：只保留九个合法 id（未知 id 丢弃）、按清单顺序、passed 强制布尔、
 * note 收形。缺项不在这里补——validateChecklist 会以 boundary-item-missing 报出，
 * 因为"缺项"本身就是回执不合格的信号，静默补齐会把失职洗成通过。
 */
function normalizeChecklist(items) {
  if (!Array.isArray(items)) return [];
  const byId = new Map();
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const id = String(it.id || '');
    if (!RULE_BY_ID.has(id) || byId.has(id)) continue;
    const item = { id, passed: it.passed === true };
    const note = sanitizeNote(it.note);
    if (note) item.note = note;
    const tag = sanitizeNote(it.evidenceTag, 40);
    if (tag) item.evidenceTag = tag;
    byId.set(id, item);
  }
  return RULE_IDS.filter((id) => byId.has(id)).map((id) => byId.get(id));
}

/**
 * 校验回执自报清单：九项必须齐全；requireAllPassed 时逐项必须 passed。
 * @returns problems[]（空数组 = 合格），与 actions 层 {code, reason, fix} 同形。
 */
function validateChecklist(items, opts = {}) {
  const problems = [];
  const list = normalizeChecklist(items);
  const seen = new Set(list.map((i) => i.id));
  for (const rule of BOUNDARY_RULES) {
    if (!seen.has(rule.id)) {
      problems.push({
        code: 'boundary-item-missing',
        reason: `边界清单缺项「${rule.label}」（${rule.id}）——九项必须逐项声明，缺失视同未检查`,
        fix: `补上 {id:"${rule.id}", passed:…}，判定标准：${rule.intent}`,
      });
    }
  }
  if (opts.requireAllPassed) {
    for (const item of list) {
      if (item.passed) continue;
      const rule = RULE_BY_ID.get(item.id);
      problems.push({
        code: 'boundary-item-failed',
        reason: `边界项「${rule.label}」（${item.id}）未通过${item.note ? `：${item.note}` : ''}`,
        fix: `处理后再交；判定标准：${rule.intent}`,
      });
    }
  }
  return problems;
}

/**
 * 机器抽查：从回执内容本身能看出的自相矛盾。
 * 只负责"内容与声明打架"的硬证据；判不出的一律不报（宁缺毋滥，人工补位）。
 * @param report 已经过 protocol.validateStageReport 收形的回执
 * @returns problems[]（空 = 抽查通过），code 形如 boundary-<ruleId>。
 */
function assertEvidenceConsistency(report) {
  const problems = [];
  if (!report || typeof report !== 'object') return problems;

  // 证据真实性：synthetic（演示/占位）不能被标成 command/file/test 这类机器证据。
  for (const ev of report.evidence || []) {
    if (ev && ev.synthetic === true && ['command', 'file', 'test'].includes(ev.type)) {
      problems.push({
        code: 'boundary-fake-evidence',
        reason: `证据"${ev.content.slice(0, 60)}"标了 ${ev.type} 但带 synthetic:true——占位证据不能冒充机器可复核证据`,
        fix: '要么换成真实命令/文件证据，要么把 type 改成 manual',
      });
    }
  }

  // 垃圾入库：交付清单里出现 tmp/cache/runtime 路径段。
  for (const d of report.deliverable || []) {
    if (GARBAGE_PATH_RE.test(d)) {
      problems.push({
        code: 'boundary-garbage',
        reason: `deliverable 含临时产物路径"${d}"`,
        fix: '临时产物不是交付物——移出 deliverable，或正式落位后重交回执',
      });
    }
  }

  // 第二事实源：清单里出现多于一个 roadmap 类正式工件（单一事实源原则）。
  const roadmaps = (report.deliverable || []).filter((d) => /roadmap/i.test(d));
  if (roadmaps.length > 1) {
    problems.push({
      code: 'boundary-second-source',
      reason: `deliverable 出现 ${roadmaps.length} 份 roadmap 类工件（${roadmaps.join(' / ')}）——同一阶段只应有一份事实源`,
      fix: '保留唯一权威 roadmap，其余改为引用或删除',
    });
  }

  return problems;
}

module.exports = {
  BOUNDARY_RULES,
  RULE_IDS,
  MACHINE_CHECKABLE,
  listRules,
  defaultChecklist,
  normalizeChecklist,
  validateChecklist,
  assertEvidenceConsistency,
};
