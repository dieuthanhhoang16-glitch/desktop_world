// world/config-audit/paths.js
// desktop-world · 配置层审计的目录约定。
'use strict';

const os = require('os');
const path = require('path');

const { cleanupRoot } = require('../cleanup/paths');

const CLAUDE_DIR = process.env.WORLD_CLAUDE_DIR || path.join(os.homedir(), '.claude');
const ARCHIVE_ROOT = process.env.WORLD_CONFIG_ARCHIVE_DIR || path.join(os.homedir(), '.desktop-world', 'config-archive');

function claudeDir(dir) {
  return path.resolve(dir || CLAUDE_DIR);
}

function archiveRoot(dir) {
  return path.resolve(dir || ARCHIVE_ROOT);
}

function configProposalRoot(root) {
  return path.join(cleanupRoot(root), '_config');
}

function configProposalDir(root, date) {
  return path.join(configProposalRoot(root), date);
}

function configProposalId(date) {
  return `config-cleanup-${date}`;
}

module.exports = {
  CLAUDE_DIR,
  ARCHIVE_ROOT,
  claudeDir,
  archiveRoot,
  configProposalRoot,
  configProposalDir,
  configProposalId,
};
