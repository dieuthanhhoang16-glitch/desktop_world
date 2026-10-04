// world/collector-codex + collector 多 agent 合并单测。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');

const { collectCodex, parseCodexFile } = require('../world/collector-codex');
const { collect } = require('../world/collector');

function tmpDir(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const NOW = new Date();
// 时间戳必须保证落在"今天"（凌晨 0 点附近跑测试时，"x 分钟前"其实是昨天）。
// 基线取 max(今天零点, NOW-90min)，偏移量往未来加也无害（只影响 进行中 判定）。
const DAY0 = new Date(NOW); DAY0.setHours(0, 0, 0, 0);
const TS_BASE = Math.max(DAY0.getTime(), NOW.getTime() - 90 * 60000);
const TS = (minOffset) => new Date(TS_BASE + minOffset * 60000).toISOString();

function makeCodexSession(dir, { cwd }) {
  // 按 codex 真实目录结构放文件：sessions/2026/10/05/rollout-*.jsonl
  const sub = path.join(dir, '2026', '10', '05');
  fs.mkdirSync(sub, { recursive: true });
  const file = path.join(sub, `rollout-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
  const lines = [
    { timestamp: TS(0), type: 'session_meta', payload: { session_id: 't1', cwd, originator: 'codex_cli' } },
    { timestamp: TS(2), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '把 eda 工程的 lint 修完，然后跑测试' }] } },
    { timestamp: TS(5), type: 'response_item', payload: { type: 'function_call', name: 'shell' } },
    { timestamp: TS(8), type: 'response_item', payload: { type: 'function_call', name: 'shell' } },
    { timestamp: TS(10), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '修好了 3 个 lint 错误。' }] } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

test('parseCodexFile：提取 cwd/标题/工具调用/时间跨度，容忍坏行', (t) => {
  const dir = tmpDir(t, 'world-codex-parse-');
  const file = makeCodexSession(dir, { cwd: '/Users/x/Documents/eda' });
  fs.appendFileSync(file, 'not-json\n{broken\n');
  const s = parseCodexFile(file);
  assert.equal(s.cwd, '/Users/x/Documents/eda');
  assert.equal(s.prompts[0], '把 eda 工程的 lint 修完，然后跑测试');
  assert.equal(s.toolCalls, 2);
  assert.ok(s.end > s.start);
});

test('collector 合并 codex：sessions 带 agent 标记，totals/agents 汇总正确', async (t) => {
  const codexDir = tmpDir(t, 'world-codex-dir-');
  makeCodexSession(codexDir, { cwd: '/Users/x/Documents/eda' });
  const claudeDir = tmpDir(t, 'world-codex-claude-');
  // 一个最小的 claude 会话
  const proj = path.join(claudeDir, '-Users-x-eda');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(
    path.join(proj, 's1.jsonl'),
    [
      JSON.stringify({ timestamp: TS(20), type: 'user', cwd: '/Users/x/Documents/eda', message: { role: 'user', content: '继续 desktop world v0.4' } }),
      JSON.stringify({ timestamp: TS(25), type: 'assistant', cwd: '/Users/x/Documents/eda', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] } }),
    ].join('\n') + '\n'
  );

  const digest = await collect({ projectsDir: claudeDir, codexDir, now: NOW });
  assert.equal(digest.totals.sessions, 2);
  assert.equal(digest.totals.toolCalls, 3); // 1 claude + 2 codex
  const agents = Object.fromEntries(digest.agents.map((a) => [a.agent, a.sessions]));
  assert.deepEqual(agents, { 'claude-code': 1, codex: 1 });
  const codexSession = digest.sessions.find((s) => s.agent === 'codex');
  assert.ok(codexSession);
  assert.equal(codexSession.project, 'eda');
  assert.match(codexSession.title, /lint/);
});

test('options.codex=false 关闭合并； Codex 目录不存在时静默跳过', async (t) => {
  const claudeDir = tmpDir(t, 'world-codex-off-');
  const digest1 = await collect({ projectsDir: claudeDir, codex: false, now: NOW });
  assert.deepEqual(digest1.agents, [{ agent: 'claude-code', sessions: 0 }]);
  const digest2 = await collect({ projectsDir: claudeDir, codexDir: path.join(os.tmpdir(), 'no-such-dir-xyz'), now: NOW });
  assert.deepEqual(digest2.agents, [{ agent: 'claude-code', sessions: 0 }]);
});
