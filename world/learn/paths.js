// world/learn/paths.js
// desktop-world · 项目学习卡的落盘位置。与现有 world/study（关键词卡）隔离，互不覆盖。
'use strict';

const os = require('os');
const path = require('path');

const { projectSlug } = require('../projects/paths');

const ROOT = process.env.WORLD_PROJECT_STUDY_DIR || path.join(os.homedir(), '.desktop-world', 'project-study');

function learnRoot(root) {
  return path.resolve(root || ROOT);
}

function projectDir(root, projectPath) {
  return path.join(learnRoot(root), projectSlug(projectPath));
}

function cardsDir(root, projectPath) {
  return path.join(projectDir(root, projectPath), 'cards');
}

function indexFile(root) {
  return path.join(learnRoot(root), 'index.md');
}

function candidatesFile(root, projectPath) {
  return path.join(projectDir(root, projectPath), 'candidates.json');
}

function backupsDir(root) {
  return path.join(learnRoot(root), '.backups');
}

module.exports = { ROOT, learnRoot, projectDir, cardsDir, indexFile, candidatesFile, backupsDir, projectSlug };
