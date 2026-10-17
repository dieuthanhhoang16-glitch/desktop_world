// world/project/index.js
// desktop-world · 项目注册层流程编排：add（注册+只读检查）、list（账本读出）、checkAll。
// CLI 是薄壳，桌面徽标走 badge.js；这里是三条命令背后的主流程，全部可单测。
'use strict';

const path = require('path');
const registry = require('./registry');
const check = require('./check');
const manifestMod = require('./manifest');

const STATUS_LABELS = Object.freeze({ initialized: '已初始化', partial: '部分初始化', missing: '未初始化' });

const MARKER_LABELS = Object.freeze({
  issueTracker: '工单规范',
  domainDocs: '领域文档',
  triageLabels: '分诊标签',
  agentSkillsBlock: 'Agent skills 块',
  glossary: '术语表',
  adrDir: 'ADR 目录',
});

/**
 * 注册 + 只读检查一气呵成（ticket 03 的「注册或首次打开时检查」）。
 * 重复注册幂等：registry 记账返回 duplicate=true 时仍顺手重查一次标记
 * （检查无副作用，用户重跑 add 就是想知道最新状态）。
 */
function add(root, projectPath) {
  const r = registry.add(root, projectPath); // 路径非法在这里抛
  const m = check.run(root, r.path);
  return { path: r.path, registeredAt: r.registeredAt, duplicate: r.duplicate, manifest: m };
}

/** `world project list` 的读账：registry × 各项目 manifest，不做活检查（list 不该有副作用感）。 */
function list(root) {
  const reg = registry.load(root);
  return reg.projects.map((p) => {
    const abs = path.resolve(p.path);
    const m = manifestMod.load(abs);
    return {
      path: abs,
      registeredAt: p.registeredAt || null,
      status: m && typeof m.status === 'string' ? m.status : 'missing',
      lastCheckedAt: (m && m.lastCheckedAt) || null,
    };
  });
}

module.exports = { STATUS_LABELS, MARKER_LABELS, add, list };
