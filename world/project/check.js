// world/project/check.js
// desktop-world · 注册/打开项目时的只读初始化检查：评估六项标准标记，
// 只把结果写进 .world/project.json 的 lastCheckedAt 与 status——项目其余文件一律不碰，
// 更不会去创建任何标准文件（那是 04 号 ticket「ensure」的活，而且要用户触发）。
//
// 安全边界（与 markers.js 同一约定）：检查只访问固定的标记相对路径，不 glob、
// 不读 .env / *.pem / .config/agentero/settings.json 之类的密钥文件；
// 标记文件本身读不出来（EACCES 等）按"缺"处理，绝不因权限报错中断整轮检查。
'use strict';

const path = require('path');
const markers = require('./markers');
const registry = require('./registry');
const manifest = require('./manifest');

/**
 * 对一个项目跑只读检查并落 manifest。
 * root 是 registry 根（找 registeredAt 用）；项目没在注册表里也能查（registeredAt 留原值）。
 * 返回落盘的 manifest。
 */
function run(root, projectDir) {
  const abs = path.resolve(String(projectDir || ''));
  const evaluation = markers.evaluate(abs); // 目录不存在在这里抛错
  const reg = registry.load(root);
  const entry = reg.projects.find((p) => p.path === abs);
  const prev = manifest.load(abs);
  return manifest.update(abs, {
    registeredAt: (prev && prev.registeredAt) || (entry && entry.registeredAt) || null,
    lastCheckedAt: new Date().toISOString(),
    status: evaluation.status,
    markers: evaluation.markers,
  });
}

/** 按注册表逐个检查。返回 { results: [{path, manifest|error}], ok }。 */
function runAll(root) {
  const reg = registry.load(root);
  const results = reg.projects.map((p) => {
    try {
      return { path: p.path, manifest: run(root, p.path) };
    } catch (err) {
      return { path: p.path, error: err.message || String(err) };
    }
  });
  return { results, ok: results.every((r) => !r.error) };
}

module.exports = { run, runAll };
