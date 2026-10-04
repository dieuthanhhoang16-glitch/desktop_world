// world 模块单测：collector 的转录解析 + summarizer 的纯函数。
// 用临时目录伪造 ~/.claude/projects 结构，不触碰真实用户数据。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { collect } = require('../world/collector');
const { extractJson, fallbackSummary, buildPrompt } = require('../world/summarizer');

function makeProjectDir(t, slug, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'world-test-'));
  const dir = path.join(root, slug);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, lines] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), lines.join('\n'));
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const NOW_ISO = () => new Date().toISOString();

test('collector：今日会话被采集，工具回执不计入用户输入', async (t) => {
  const root = makeProjectDir(t, '-tmp-projA', {
    'abc123.jsonl': [
      JSON.stringify({ type: 'user', timestamp: NOW_ISO(), cwd: '/tmp/projA', message: { role: 'user', content: '帮我修个 bug' } }),
      // 纯工具回执的 user 消息必须被过滤
      JSON.stringify({ type: 'user', timestamp: NOW_ISO(), cwd: '/tmp/projA', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
      JSON.stringify({ type: 'assistant', timestamp: NOW_ISO(), message: { role: 'assistant', content: [
        { type: 'tool_use', name: 'Edit', input: {} },
        { type: 'tool_use', name: 'Edit', input: {} },
        { type: 'tool_use', name: 'Bash', input: {} },
      ] } }),
    ],
  });

  const d = await collect({ projectsDir: root });
  assert.equal(d.totals.sessions, 1);
  assert.equal(d.totals.prompts, 1);
  assert.equal(d.totals.toolCalls, 3);
  assert.equal(d.sessions[0].project, 'projA');
  assert.equal(d.sessions[0].title, '帮我修个 bug');
  assert.equal(d.sessions[0].status, '进行中'); // 刚发生的会话视为活跃
  assert.equal(d.topTools[0].name, 'Edit');
  assert.equal(d.topTools[0].count, 2);
});

test('collector：昨天的文件不参与今日 digest', async (t) => {
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
  const root = makeProjectDir(t, '-tmp-projB', {
    'old.jsonl': [
      JSON.stringify({ type: 'user', timestamp: threeDaysAgo.toISOString(), cwd: '/tmp/projB', message: { role: 'user', content: '旧会话' } }),
    ],
  });
  fs.utimesSync(path.join(root, '-tmp-projB', 'old.jsonl'), threeDaysAgo, threeDaysAgo);

  const d = await collect({ projectsDir: root });
  assert.equal(d.totals.sessions, 0);
  assert.deepEqual(d.sessions, []);
});

test('collector：目录不存在时返回空 digest 而不是抛错', async () => {
  const d = await collect({ projectsDir: path.join(os.tmpdir(), 'definitely-not-exists-' + process.pid) });
  assert.equal(d.totals.sessions, 0);
  assert.ok(d.note);
});

test('summarizer::extractJson：容忍模型输出前后的废话', () => {
  assert.deepEqual(extractJson('好的，结果如下：\n{"a":1}\n以上'), { a: 1 });
  assert.equal(extractJson('没有 JSON'), null);
});

test('summarizer::fallbackSummary：安静日与忙碌日都给出完整结构', () => {
  const empty = fallbackSummary({ totals: { sessions: 0, prompts: 0, toolCalls: 0 }, projects: [] });
  assert.equal(typeof empty.oneline, 'string');
  assert.equal(empty.ideas.length, 3);
  const busy = fallbackSummary({ totals: { sessions: 5, prompts: 9, toolCalls: 99 }, projects: [{ name: 'x' }] });
  assert.match(busy.oneline, /5 个会话/);
});

test('summarizer::buildPrompt：约束与数据都进 prompt', () => {
  const p = buildPrompt({
    date: '2026-10-05', weekday: '周一',
    totals: { sessions: 2, prompts: 3, toolCalls: 10 },
    topTools: [], projects: [], hours: [], sessions: [],
  });
  assert.match(p, /严格只输出 JSON/);
  assert.match(p, /2026-10-05/);
});
