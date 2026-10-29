// world/cleanup/paths.js
// desktop-world · 清理提案与决策的落盘位置。
'use strict';

const os = require('os');
const path = require('path');

const { projectSlug } = require('../projects/paths');

const ROOT = process.env.WORLD_CLEANUP_DIR || path.join(os.homedir(), '.desktop-world', 'cleanup');

function cleanupRoot(root) {
  return path.resolve(root || ROOT);
}

function proposalDir(root, projectPath, date) {
  return path.join(cleanupRoot(root), projectSlug(projectPath), date);
}

function proposalId(projectPath, date) {
  return `cleanup-${projectSlug(projectPath).replace(/-\w+$/, '')}-${date}`;
}

module.exports = { ROOT, cleanupRoot, proposalDir, proposalId, projectSlug };
