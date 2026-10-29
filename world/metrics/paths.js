// world/metrics/paths.js
// desktop-world · 指标日志、报告与复盘模板的落盘位置。
'use strict';

const os = require('os');
const path = require('path');

const ROOT = process.env.WORLD_METRICS_DIR || path.join(os.homedir(), '.desktop-world', 'metrics');

function metricsRoot(dir) {
  return path.resolve(dir || ROOT);
}

function eventsFile(dir) {
  return path.join(metricsRoot(dir), 'events.jsonl');
}

function reportsDir(dir) {
  return path.join(metricsRoot(dir), 'reports');
}

function reviewsDir(dir) {
  return path.join(metricsRoot(dir), 'reviews');
}

module.exports = { ROOT, metricsRoot, eventsFile, reportsDir, reviewsDir };
