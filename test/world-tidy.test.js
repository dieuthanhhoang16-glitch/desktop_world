// world/tidy 模块单测：扫描 / 分类 / 计划避让 / 执行与撤销（全部在临时目录里进行）。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scanDesktop } = require('../world/tidy/scan');
const { classifyByRules, refineOthersWithLLM, OTHER } = require('../world/tidy/classify');
const { buildPlan } = require('../world/tidy/plan');
const { applyPlan, undo, latestUndoFile } = require('../world/tidy/apply');

function makeDesktop(t, names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-tidy-'));
  // 让一个目录混进去，scan 必须忽略它
  fs.mkdirSync(path.join(dir, '一个文件夹'));
  for (const name of names) fs.writeFileSync(path.join(dir, name), `fake-${name}`);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('scan：只收散文件，忽略目录与隐藏文件', (t) => {
  const dir = makeDesktop(t, ['a.png', '.hiddenfile', 'b.pdf']);
  const files = scanDesktop({ dir });
  assert.deepEqual(files.map((f) => f.name).sort(), ['a.png', 'b.pdf']);
});

test('scan：minAgeMin 跳过刚改动的文件', (t) => {
  const dir = makeDesktop(t, ['fresh.txt']);
  const skip = scanDesktop({ dir, minAgeMin: 60 });
  assert.equal(skip.length, 0);
  const keep = scanDesktop({ dir, minAgeMin: 0 });
  assert.equal(keep.length, 1);
});

test('classify：扩展名归桶 + 截图按名字矫正 + 未知进其他', () => {
  const files = [
    { name: 'photo.jpeg', ext: 'jpeg' },
    { name: 'Screenshot 2026-10-05.png', ext: 'png' },
    { name: 'setup.dmg', ext: 'dmg' },
    { name: '什么奇怪的东西.xyz', ext: 'xyz' },
  ];
  const { groups, others } = classifyByRules(files);
  assert.equal(groups.get('图片')[0].name, 'photo.jpeg');
  assert.equal(groups.get('截图')[0].name, 'Screenshot 2026-10-05.png');
  assert.equal(groups.get('安装包')[0].name, 'setup.dmg');
  assert.equal(others[0].name, '什么奇怪的东西.xyz');
});

test('refineOthersWithLLM：假 runner 细化 + 失败静默兜底', async () => {
  const fake = async () => '{"古董存档.7z":"备份","乱码文件.qqq":"完全不对的超长类别名会被拒掉"}';
  const refined = await refineOthersWithLLM(['古董存档.7z', '乱码文件.qqq'], fake);
  assert.equal(refined.get('古董存档.7z'), '备份');
  assert.equal(refined.has('乱码文件.qqq'), false);
  const broken = await refineOthersWithLLM(['a'], async () => '这不是 JSON');
  assert.equal(broken.size, 0);
});

test('plan：重名自动加序号避让（含磁盘已存在的情况）', (t) => {
  const dir = makeDesktop(t, ['report.pdf']);
  const root = path.join(dir, '_归档');
  fs.mkdirSync(path.join(root, '文档'), { recursive: true });
  fs.writeFileSync(path.join(root, '文档', 'report.pdf'), '旧的');
  const files = [
    { name: 'report.pdf', abs: path.join(dir, 'report.pdf'), ext: 'pdf', sizeKb: 1 },
    { name: 'report.pdf', abs: path.join(dir, 'report (2).pdf'), ext: 'pdf', sizeKb: 1 }, // 计划内部同名也避让
  ];
  const groups = new Map([['文档', files]]);
  const plan = buildPlan({ files, groups, rootDir: root });
  const names = plan.moves.map((m) => path.basename(m.to)).sort();
  // 磁盘上 文档/report.pdf 已被占 → 依次落到 -1 / -2
  assert.deepEqual(names, ['report-1.pdf', 'report-2.pdf']);
});

test('apply+undo：移动闭环可还原', (t) => {
  const dir = makeDesktop(t, ['x.png', 'y.pdf']);
  const root = path.join(dir, '_归档');
  const undoDir = path.join(dir, 'undo-logs');
  const files = scanDesktop({ dir });
  const { groups } = classifyByRules(files);
  const plan = buildPlan({ files, groups, rootDir: root });
  const { moved, failed, undoFile } = applyPlan(plan, { undoDir });

  assert.equal(moved, 2);
  assert.equal(failed.length, 0);
  assert.equal(fs.existsSync(path.join(root, '图片', 'x.png')), true);
  assert.equal(fs.existsSync(path.join(dir, 'x.png')), false);
  assert.equal(undoFile, latestUndoFile(undoDir));

  const { restored, skipped } = undo(latestUndoFile(undoDir));
  assert.equal(restored, 2);
  assert.equal(skipped.length, 0);
  assert.equal(fs.existsSync(path.join(dir, 'x.png')), true);
  assert.equal(fs.existsSync(path.join(dir, 'y.pdf')), true);
});
