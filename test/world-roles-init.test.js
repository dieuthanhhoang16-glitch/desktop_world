// test/world-roles-init.test.js
// world/roles/init.js：`world:roles init` 在运行根目录生成全局契约与 ds/jev/glm
// 三张角色卡。
//
// 这一层的关键不在"写出来"，而在**重复运行绝不能覆盖**用户已手改的角色卡。
// 角色卡是要随仓库/运行根版本化的（见 spec §2），覆盖 =  Review 历史被偷走。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const initRoles = require('../world/roles/init');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'world-roles-init-'));
}

test('init 在空根目录生成 contract.md + ds/jev/glm 三张角色卡', () => {
  const root = tmpRoot();
  const res = initRoles.run({ root });

  assert.ok(fs.existsSync(path.join(root, 'contract.md')), 'contract.md 必须落盘');
  for (const role of ['ds', 'jev', 'glm']) {
    const p = path.join(root, 'cards', `${role}.md`);
    assert.ok(fs.existsSync(p), `${role}.md 必须落盘`);
  }
  // 返回值要把每个产物交代清楚，CLI 据此向用户打印
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.created.length, 4, '首次 init 四个文件都应是 created');
  assert.strictEqual(res.skipped.length, 0);
});

test('角色卡内容非空且各自不同（不能是一份模板复读三遍）', () => {
  const root = tmpRoot();
  initRoles.run({ root });
  const contract = fs.readFileSync(path.join(root, 'contract.md'), 'utf8');
  const ds = fs.readFileSync(path.join(root, 'cards', 'ds.md'), 'utf8');
  const jev = fs.readFileSync(path.join(root, 'cards', 'jev.md'), 'utf8');
  const glm = fs.readFileSync(path.join(root, 'cards', 'glm.md'), 'utf8');

  for (const [name, text] of [['contract', contract], ['ds', ds], ['jev', jev], ['glm', glm]]) {
    assert.ok(text.trim().length > 20, `${name} 看起来是空的`);
  }
  assert.notStrictEqual(ds, jev);
  assert.notStrictEqual(ds, glm);
  assert.notStrictEqual(jev, glm);
  // 角色卡至少要自报家门，否则启动后 agent 不知道自己是谁
  assert.match(ds, /ds/i);
  assert.match(jev, /jev/i);
  assert.match(glm, /glm/i);
});

test('重复 init 不覆盖用户手改过的角色卡', () => {
  const root = tmpRoot();
  initRoles.run({ root });

  const glmPath = path.join(root, 'cards', 'glm.md');
  const customized = '# 我手改过的 glm 卡\n不要覆盖我。\n';
  fs.writeFileSync(glmPath, customized, 'utf8');

  const res = initRoles.run({ root });
  // 第二次跑：什么都没 created，全部 skipped
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.created.length, 0);
  assert.strictEqual(res.skipped.length, 4, '四个目标文件都应跳过');

  const after = fs.readFileSync(glmPath, 'utf8');
  assert.strictEqual(after, customized, '手改过的角色卡绝不能被 init 覆盖');
});

test('部分缺失时只补缺：已存在的仍跳过，缺的 created', () => {
  const root = tmpRoot();
  initRoles.run({ root });

  // 删掉 ds.md，把 glm.md 改成自定义内容
  fs.unlinkSync(path.join(root, 'cards', 'ds.md'));
  const customized = '# custom glm\n';
  fs.writeFileSync(path.join(root, 'cards', 'glm.md'), customized, 'utf8');

  const res = initRoles.run({ root });
  assert.strictEqual(res.created.length, 1, '只有 ds.md 应被补');
  assert.match(res.created[0], /ds\.md$/);
  assert.strictEqual(res.skipped.length, 3);

  const glmAfter = fs.readFileSync(path.join(root, 'cards', 'glm.md'), 'utf8');
  assert.strictEqual(glmAfter, customized);
});

test('root 缺省时拒绝静默用 home 目录（避免单测写脏用户家）', () => {
  assert.throws(() => initRoles.run({}), /root/i);
});
