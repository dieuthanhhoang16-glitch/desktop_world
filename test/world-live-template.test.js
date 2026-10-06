// test/world-live-template.test.js
// daily-card.html 内联脚本的结构性守门：renderPomo（IIFE 顶层函数）依赖的工具函数
// 必须在顶层可达。v0.6.3.2 前的真实事故：esc 只声明在 render() 内部，点「▶ 开始」
// 展开任务选择器时 renderPomo 抛 ReferenceError: esc is not defined，选择器不弹。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TEMPLATE = path.join(__dirname, '..', 'world', 'template', 'daily-card.html');

test('esc 声明在 render 之外，且先于 render 出现（renderPomo 可达）', () => {
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  const renderStart = html.indexOf('function render(R) {');
  const renderEnd = html.indexOf('} // render 到此为止');
  assert.ok(renderStart > 0, '找不到 render 起点');
  assert.ok(renderEnd > renderStart, '找不到 render 终点标注');

  const escDecl = html.indexOf('function esc(');
  assert.ok(escDecl > 0, '模板里找不到 esc 声明');
  assert.ok(escDecl < renderStart, 'esc 必须声明在 render 之前（顶层作用域），否则 renderPomo 拿不到');

  // 同一段名字可以在 render 内部再被 var/参数遮蔽吗——目前不允许第二次 function esc 声明
  const escInRender = html.indexOf('function esc(', renderStart);
  assert.ok(escInRender === -1 || escInRender > renderEnd, 'render 内部不得再声明 esc');
});

test('renderPomo 是 IIFE 顶层函数（不被 render 包住），picker 分支引用 esc', () => {
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  const renderStart = html.indexOf('function render(R) {');
  const renderEnd = html.indexOf('} // render 到此为止');

  const pomoDecl = html.indexOf('function renderPomo(v) {');
  assert.ok(pomoDecl > 0, '找不到 renderPomo 声明');
  assert.ok(pomoDecl < renderStart || pomoDecl > renderEnd, 'renderPomo 必须在 render 外');

  // 选择器构造分支必须真实存在转义调用（数据进 DOM 不裸拼）
  const pickBranch = html.indexOf('data-pick-sid');
  assert.ok(pickBranch > 0, '找不到任务选择器分支');
  assert.ok(
    html.slice(Math.max(0, pickBranch - 400), pickBranch + 400).includes('esc(s.project)'),
    '选择器选项必须转义输出',
  );
});
