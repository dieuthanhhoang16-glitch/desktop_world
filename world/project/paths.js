// world/project/paths.js
// desktop-world · 项目注册层落盘位置与标准常量的唯一真相。
// 与 world/orch/paths.js 同款约定：registry 落在 ~/.desktop-world/projects/ 下，
// WORLD_PROJECT_DIR 可覆盖（单测与便携场景）；manifest 落在各项目自己的 .world/project.json。
'use strict';

const os = require('os');
const path = require('path');

const CONFIG_DIR = path.join(os.homedir(), '.desktop-world');
const PROJECT_DIR = process.env.WORLD_PROJECT_DIR || path.join(CONFIG_DIR, 'projects');

const REGISTRY_FILE = 'registry.json';
// manifest 相对项目根的路径（spec user story 18：.world/project.json 记录标准版本与检查时间）
const MANIFEST_REL = path.join('.world', 'project.json');

// 当前对标的 setup-matt-pocock-skills 版本（写入 manifest，供未来迁移比对）
const STANDARD = 'mattpocock-skills';
const STANDARD_VERSION = '1.3.1';

function registryFile(root = PROJECT_DIR) {
  return path.join(root, REGISTRY_FILE);
}
function manifestFile(projectDir) {
  return path.join(projectDir, MANIFEST_REL);
}

module.exports = {
  PROJECT_DIR,
  REGISTRY_FILE,
  MANIFEST_REL,
  STANDARD,
  STANDARD_VERSION,
  registryFile,
  manifestFile,
};
