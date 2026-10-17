// world/roles/init.js · `world:roles init` 的实现：把全局契约与三张角色卡
// 从仓内模板落到运行根目录。铁律是"重复运行不覆盖已存在文件"——角色卡可能
// 被用户手改过（见 spec 用户故事 10），init 绝不能偷走这些修改。
//
// 使用：
//   const init = require('./init');
//   const res = init.run({ root })           // root 必填，默认由 CLI 从 paths 解析
//   res = { ok, created: [...], skipped: [...], root }
'use strict';

const fs = require('fs');
const path = require('path');

const TEMPLATES_DIR = path.join(__dirname, 'templates');

const TARGETS = [
  { rel: 'contract.md', template: 'contract.md' },
  { rel: path.join('cards', 'ds.md'), template: path.join('cards', 'ds.md') },
  { rel: path.join('cards', 'jev.md'), template: path.join('cards', 'jev.md') },
  { rel: path.join('cards', 'glm.md'), template: path.join('cards', 'glm.md') },
];

function requireRoot(root) {
  if (!root || typeof root !== 'string') {
    throw new Error('root is required: initRoles.run({ root }) 需要显式根目录；默认值应由 CLI 经 world/roles/paths.js 解析后传入');
  }
  return root;
}

function run({ root }) {
  const resolvedRoot = requireRoot(root);

  const created = [];
  const skipped = [];
  for (const t of TARGETS) {
    const dest = path.join(resolvedRoot, t.rel);
    if (fs.existsSync(dest)) {
      skipped.push(t.rel);
      continue;
    }
    const src = path.join(TEMPLATES_DIR, t.template);
    const body = fs.readFileSync(src, 'utf8');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body, { encoding: 'utf8', flag: 'wx' });
    created.push(t.rel);
  }

  return { ok: true, created, skipped, root: resolvedRoot };
}

module.exports = { run, TARGETS };
