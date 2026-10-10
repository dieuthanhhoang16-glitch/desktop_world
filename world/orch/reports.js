// world/orch/reports.js
// desktop-world · 阶段回执（StageReport）的落盘账本（只追加）。
//
// 回执是窗口协作的"结构化通信"载体：每个任务窗口在每个状态收尾时交一份，
// 老二（stage-lead）拿最新一份做关口裁定。落盘纪律与 decisions.js 完全同源：
// 一文件一回执、时间戳文件名、0600、超出上限按时间淘汰、读取永不抛。
//
// 落什么：协议字段全量（protocol.validateStageReport 收形后的形状）+ 元信息
// （milestone / window / verdict 快照 / boundarySummary）。不落什么：不做任何
// 改写与删除——回执一旦归档不可变，补交只能再写一份（最新覆盖语义在 latestFor）。
'use strict';

const fs = require('fs');
const path = require('path');
const { ORCH_DIR, reportsDir } = require('./paths');
const protocol = require('./protocol');

// 目录里最多留多少份回执（与 decisions 同上限：复盘材料不是无限仓库）
const MAX_FILES = 200;
// 单份回执全部 evidence content 合计的落盘上限
const MAX_EVIDENCE_CHARS = 2000;

/**
 * 回执文件名。带时间戳排序可读；随机后缀防同毫秒覆盖（同 decisionFileName 的理由）。
 * @param {Date} [now] 注入时间（单测要确定性）
 * @param {number} [nonce] 注入随机源 0–1
 */
function reportFileName(now = new Date(), nonce = Math.random()) {
  const d = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const iso = d.toISOString().replace(/[:.]/g, '-');
  const n = typeof nonce === 'number' && Number.isFinite(nonce) ? Math.abs(nonce) % 1 : Math.random();
  const suffix = Math.floor(n * 0x10000).toString(16).padStart(4, '0');
  return `${iso}-${suffix}.json`;
}

/**
 * 收形回执：最后一道消毒闸门。先过 protocol.validateStageReport（形状/白名单/截断），
 * 再对 evidence 合计长度设防。**绝不改写语义**，只做减法。
 * @returns 收形后的 StageReport | null（形状不合格）
 */
function sanitizeReport(raw) {
  const r = protocol.validateStageReport(raw);
  if (!r.ok) return null;
  const report = r.report;
  let chars = 0;
  report.evidence = report.evidence.filter((ev) => {
    chars += ev.content.length;
    return chars <= MAX_EVIDENCE_CHARS;
  });
  return report;
}

function boundarySummaryOf(report) {
  const items = (report && report.boundaryCheck && Array.isArray(report.boundaryCheck.items)) ? report.boundaryCheck.items : [];
  const failed = items.filter((i) => i && i.passed !== true).map((i) => String(i.id || '').slice(0, 40)).filter(Boolean);
  return { checked: items.length, passed: items.length - failed.length, failed };
}

/**
 * 写一份回执。**永不抛**——落盘失败不该影响窗口协作的结果。
 * @param root orch 根（tests 注入 tmp）
 * @param report 协议形状的回执（这里会再过一遍 sanitizeReport）
 * @param meta  {milestone, window:{stageId,subtaskId,state}, at?}
 * @returns {{ok:true, file, id} | {ok:false}}
 */
function record(root = ORCH_DIR, report, meta = {}) {
  try {
    const sanitized = sanitizeReport(report);
    if (!sanitized) return { ok: false };
    const dir = reportsDir(root);
    fs.mkdirSync(dir, { recursive: true });
    // meta.at 可注入到文件名（测试里同一毫秒连发回执也能保持确定性时序；
    // 真实场景用当前时刻，nonce 后缀防同毫秒覆盖）。
    const file = path.join(dir, reportFileName(meta.at ? new Date(meta.at) : undefined));
    const at = meta.at || new Date().toISOString();
    const win = meta.window && typeof meta.window === 'object' ? meta.window : {};
    const body = {
      id: `r-${at}`,
      at,
      milestone: String(meta.milestone || '').slice(0, 200),
      window: {
        stageId: String(win.stageId || '').slice(0, 16),
        subtaskId: String(win.subtaskId || '').slice(0, 16),
        state: protocol.isWindowState(win.state) ? win.state : sanitized.stageState,
      },
      verdict: sanitized.verdict,
      report: sanitized,
      boundarySummary: boundarySummaryOf(sanitized),
    };
    fs.writeFileSync(file, JSON.stringify(body, null, 2), { mode: 0o600 });
    prune(dir);
    return { ok: true, file, id: body.id };
  } catch {
    return { ok: false };
  }
}

/** 淘汰超出 MAX_FILES 的最旧文件。任何一步出错静默——清理不该抛。 */
function prune(dir = reportsDir(), maxFiles = MAX_FILES) {
  try {
    const names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
    const excess = names.length - maxFiles;
    if (excess <= 0) return 0;
    for (const name of names.slice(0, excess)) {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch {
        /* 删不掉就跳过 */
      }
    }
    return excess;
  } catch {
    return 0;
  }
}

function readAll(root = ORCH_DIR) {
  try {
    const dir = reportsDir(root);
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .sort()
      .reverse()
      .map((name) => {
        try {
          const obj = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
          return obj && typeof obj === 'object' && typeof obj.id === 'string' ? obj : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function windowIdOf(entry) {
  return entry && entry.window ? `${entry.window.stageId}.${entry.window.subtaskId}` : '';
}

/**
 * 列出回执（新→旧）。
 * @param opts {limit=20, windowId?:'A.a', milestone?:string}
 */
function list(root = ORCH_DIR, opts = {}) {
  let entries = readAll(root);
  if (opts.windowId) entries = entries.filter((e) => windowIdOf(e) === opts.windowId);
  if (opts.milestone) entries = entries.filter((e) => e.milestone === opts.milestone);
  return entries.slice(0, Math.max(1, opts.limit || 20));
}

/** 某个窗口的最新一份回执（关口裁定的输入）；没有回 null。 */
function latestFor(root = ORCH_DIR, windowId) {
  return list(root, { windowId, limit: 1 })[0] || null;
}

/**
 * 给树/UI 的紧凑投影（最新一份的展示形状；无回执回 null）。
 * 自由文本都已经过协议截断，UI 侧照常 esc。
 */
function summaryForTree(root = ORCH_DIR, opts = {}) {
  const latest = opts.windowId ? latestFor(root, opts.windowId) : list(root, { limit: 1 })[0] || null;
  if (!latest) return null;
  const r = latest.report || {};
  return {
    id: latest.id,
    at: latest.at,
    milestone: latest.milestone,
    windowId: windowIdOf(latest),
    windowState: latest.window ? latest.window.state : '',
    verdict: latest.verdict,
    deliverable: Array.isArray(r.deliverable) ? r.deliverable : [],
    evidenceCount: Array.isArray(r.evidence) ? r.evidence.length : 0,
    risks: r.risks && typeof r.risks === 'object' ? r.risks : { blocker: [], nonBlocker: [] },
    checklist: (r.boundaryCheck && Array.isArray(r.boundaryCheck.items) ? r.boundaryCheck.items : []).map((i) => ({
      id: i.id,
      passed: i.passed === true,
      note: i.note || '',
    })),
    blockingDecision: r.blockingDecision || { blocker: '', blocksStageClose: false, blocksNextStage: false },
    recommendedNextStep: r.recommendedNextStep || '',
  };
}

module.exports = {
  MAX_FILES,
  MAX_EVIDENCE_CHARS,
  reportFileName,
  sanitizeReport,
  boundarySummaryOf,
  record,
  prune,
  list,
  latestFor,
  summaryForTree,
};
