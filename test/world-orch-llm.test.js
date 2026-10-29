// test/world-orch-llm.test.js
// v0.7 Stage C-2：JEV 决策层
//
// ⚠️ 这组测试**绝不允许发真网络请求**。每个用例都注入假 transport，并额外用
// https.request hook 探针确认没有真实出网（见文件末尾「网络出口探针」一节）。
// 这不是形式主义：单测里发真请求会让 CI 变成一个"偷偷花用户钱"的进程。
//
// ⚠️ 契约要点（实测得来，别按"OpenAI 兼容"的直觉改）：Jev **不是** chat/completions。
//   端点 https://api.typesafe.ai/v1/systemone，请求 { state, model, questions }，
//   响应 { answers: { name: { type:"noul", noul: 0..1 } } }。
//   `questions` 每项必须有 instructions，否则报 "Noul question must have criteria
//   or instructions"。api.jev.ai 这个子域**没有 A 记录**，别再用它。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const llm = require('../world/orch/llm');
const split = require('../world/orch/split');
const decisions = require('../world/orch/decisions');
const llmPrefs = require('../world/orch/llm-prefs');
const T = require('../world/orch/tickets');

function tmpDir(prefix = 'dwllm-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// 一个"永不throw、永不发请求"的假 transport；记录收到的参数供断言。
function fakeTransport(result) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return typeof result === 'function' ? result(url, opts, calls.length - 1) : result;
  };
  fn.calls = calls;
  return fn;
}

/** 造一个合法的 systemone 成功响应。 */
function answersBody(probs = {}) {
  const answers = {};
  for (const [k, v] of Object.entries(probs)) answers[k] = { type: 'noul', noul: v };
  return {
    status: 200,
    body: JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 280, output_tokens: 20 } }),
  };
}

const ENABLED = { orchJevEnabled: true, orchJevApiKey: 'sk-test', orchJevBaseUrl: '', orchJevModel: '' };

// ---------- 端点：这里踩过真实的坑 ----------

test('端点契约：默认是 api.typesafe.ai/v1/systemone（api.jev.ai 解析不出来）', () => {
  // api.jev.ai 没有 A 记录 —— 这是实测踩到的，写死在这里防止有人"改回正确的样子"
  assert.match(llm.DEFAULT_BASE_URL, /^https:\/\/api\.typesafe\.ai\//, 'Jev API 挂在 typesafe.ai 下');
  assert.equal(llm.DEFAULT_PATH, '/systemone');
  assert.match(llm.DEFAULT_MODEL, /latest/i);

  const cfg = llm.resolveConfig({ settings: ENABLED, env: {} });
  assert.equal(cfg.ok, true);
  assert.equal(cfg.requestUrl.href, 'https://api.typesafe.ai/v1/systemone');
});

test('parseEndpoint：三种填法都认（域根 / 基址 / 完整端点），尾部斜杠不产生双斜杠', () => {
  for (const base of [
    'https://api.typesafe.ai/v1',
    'https://api.typesafe.ai/v1/',
    'https://api.typesafe.ai/v1/systemone',
    'https://api.typesafe.ai',
  ]) {
    const r = llm.parseEndpoint(base);
    assert.equal(r.ok, true, `${base} 应被接受`);
    assert.ok(!r.url.href.includes('//systemone'), `${base} 不该产生双斜杠：${r.url.href}`);
    assert.ok(r.url.href.endsWith('/systemone'), `${base} 应以 /systemone 结尾：${r.url.href}`);
  }
});

test('parseEndpoint：只允许 http/https，丢弃查询参数与 hash', () => {
  for (const bad of ['file:///etc/passwd', 'ftp://x.dev/v1', 'javascript:alert(1)', 'not-a-url', '']) {
    assert.equal(llm.parseEndpoint(bad).ok, false, `${bad} 应被拒`);
  }
  const u = llm.parseEndpoint('https://a.dev/v1?token=secret#frag');
  assert.equal(u.ok, true);
  assert.equal(u.url.search, '', '凭据不该留在请求 URL 里');
  assert.equal(u.url.hash, '');
});

test('safeEndpoint：只留 origin + /systemone，不带查询串', () => {
  assert.equal(llm.safeEndpoint('https://api.typesafe.ai/v1'), 'https://api.typesafe.ai/v1/systemone');
  assert.equal(llm.safeEndpoint('https://a.dev/v1?k=secret'), 'https://a.dev/v1/systemone');
  assert.equal(llm.safeEndpoint('不是 url'), null);
});

// ---------- resolveConfig：双通道密钥读取 ----------

test('resolveConfig：默认关闭——未显式启用时不可用，且**不接受环境变量单独打开**', () => {
  const r = llm.resolveConfig({ settings: {}, env: { JEV_API: 'apikey_from_shell' } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, llm.FAIL.disabled, 'env 里有密钥不等于用户同意了出网');
  for (const bad of [undefined, null, false, 'true', 1, 0, 'yes']) {
    assert.equal(llm.resolveConfig({ settings: { orchJevEnabled: bad }, env: {} }).ok, false, `orchJevEnabled=${bad} 不该开启`);
  }
  assert.equal(llm.resolveConfig({ settings: { orchJevEnabled: true }, env: {} }).reason, llm.FAIL.noKey, '开了但没密钥');
});

test('resolveConfig：密钥双通道——Settings 优先于环境变量，两个变量名都兼容', () => {
  const fromSettings = llm.resolveConfig({ settings: ENABLED, env: { JEV_API: 'apikey_env' } });
  assert.equal(fromSettings.ok, true);
  assert.equal(fromSettings.source, 'settings', 'Settings 显式值优先');

  const fromEnv = llm.resolveConfig({ settings: { orchJevEnabled: true }, env: { JEV_API: 'apikey_env' } });
  assert.equal(fromEnv.ok, true);
  assert.equal(fromEnv.source, 'env');
  // ~/.zshrc 里用的是 JEV_API，文档常见 JEV_API_KEY，两个都得认
  assert.equal(llm.resolveConfig({ settings: { orchJevEnabled: true }, env: { JEV_API_KEY: 'k2' } }).ok, true);
  // 空串/空白不算配了，要能 fallthrough 到下一个候选名
  assert.equal(llm.resolveConfig({ settings: { orchJevEnabled: true }, env: { JEV_API: '  ', JEV_API_KEY: 'k2' } }).apiKey, 'k2');
});

test('resolveConfig：端点与模型可覆盖；非法端点导致不可用', () => {
  const custom = llm.resolveConfig({ settings: { ...ENABLED, orchJevBaseUrl: 'https://my-proxy.internal/v1' }, env: {} });
  assert.equal(custom.requestUrl.href, 'https://my-proxy.internal/v1/systemone');
  const model = llm.resolveConfig({ settings: { ...ENABLED, orchJevModel: 'jev-1.13.0' }, env: {} });
  assert.equal(model.model, 'jev-1.13.0');
  const bad = llm.resolveConfig({ settings: { ...ENABLED, orchJevBaseUrl: 'file:///etc/passwd' }, env: {} });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, llm.FAIL.badEndpoint);
});

test('envFirst：候选名按优先级取第一个非空', () => {
  assert.equal(llm.envFirst(['A', 'B'], { A: '  ', B: 'x' }), 'x');
  assert.equal(llm.envFirst(['A'], {}), '');
  assert.equal(llm.envFirst(['A'], null), '');
  assert.equal(llm.envFirst(['A'], { A: 'v' }), 'v');
});

// ---------- 问题表归一化 ----------

test('normalizeQuestions：缺 instructions/criteria 的项直接丢（实测会被服务端拒绝）', () => {
  const r = llm.normalizeQuestions({
    good: { instructions: '这段话是否可拆分' },
    alsoGood: { criteria: ['包含多个动作'] },
    noSpec: {},
    nullSpec: null,
    'bad name!': { instructions: 'x' },
    '1leadingDigit': { instructions: 'x' },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.questions).sort(), ['alsoGood', 'good']);
  assert.equal(r.questions.good.type, 'noul');
  assert.deepEqual(r.questions.alsoGood.criteria, ['包含多个动作']);
  assert.equal(r.dropped, 4);
  assert.equal(llm.normalizeQuestions({}).ok, false, '空问题表不可用');
  assert.equal(llm.normalizeQuestions(null).ok, false);
  assert.equal(llm.normalizeQuestions([]).ok, false);
});

test('normalizeQuestions：封顶 MAX_QUESTIONS，避免延迟与费用失控', () => {
  const many = {};
  for (let i = 0; i < 40; i += 1) many[`q${i}`] = { instructions: 'x' };
  const r = llm.normalizeQuestions(many);
  assert.equal(Object.keys(r.questions).length, llm.MAX_QUESTIONS);
});

test('normalizeQuestions：instructions 截断，不透传无效的 enum/options（实测不改变返回形状）', () => {
  const r = llm.normalizeQuestions({ a: { instructions: 'x'.repeat(2000), enum: ['甲', '乙'] } });
  assert.ok(r.questions.a.instructions.length <= 500);
  assert.equal(r.questions.a.enum, undefined, '传一个看起来生效其实没用的参数是误导');
});

// ---------- 请求体与响应解析 ----------

test('buildRequestBody：是 systemone 形状，**不带** temperature/max_tokens/stream', () => {
  const body = llm.buildRequestBody({ model: 'jev-latest', state: '目标', questions: { a: { type: 'noul', instructions: 'x' } } });
  assert.deepEqual(Object.keys(body).sort(), ['model', 'questions', 'state']);
  assert.equal(body.temperature, undefined, 'systemone 没有这个字段');
  assert.equal(body.stream, undefined);
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.questions.a.instructions, 'x');
});

test('extractAnswers：取 answers 表；包一层 data/result 也认；形状不对返回 ok:false', () => {
  const ok = llm.extractAnswers('{"model":"jev-1.13.0","answers":{"a":{"type":"noul","noul":0.87}}}');
  assert.equal(ok.ok, true);
  assert.equal(ok.model, 'jev-1.13.0');
  assert.equal(ok.answers.a.noul, 0.87);
  assert.equal(llm.extractAnswers({ answers: { a: { noul: 0.5 } } }).ok, true);
  assert.equal(llm.extractAnswers('{"data":{"answers":{"a":{"noul":0.5}}}}').ok, true);
  assert.equal(llm.extractAnswers('{"detail":"Invalid request."}').ok, false);
  assert.equal(llm.extractAnswers('not json').ok, false);
  assert.equal(llm.extractAnswers('{"answers":[]}').ok, false, '数组不是合法 answers 表');
});

test('noulOf：取概率；答不上来返回 null 而不是 0（0 是有效概率）', () => {
  assert.equal(llm.noulOf({ a: { noul: 0.87 } }, 'a'), 0.87);
  assert.equal(llm.noulOf({ a: { noul: 0 } }, 'a'), 0);
  assert.equal(llm.noulOf({}, 'a'), null);
  assert.equal(llm.noulOf({ a: {} }, 'a'), null);
  assert.equal(llm.noulOf({ a: { noul: 'x' } }, 'a'), null);
  assert.equal(llm.noulOf({ a: { noul: NaN } }, 'a'), null);
  // 越界的值被夹到 0..1，不让脏数据污染判断
  assert.equal(llm.noulOf({ a: { noul: 1.7 } }, 'a'), 1);
  assert.equal(llm.noulOf({ a: { noul: -0.3 } }, 'a'), 0);
});

// ---------- client：默认关闭绝不发送 ----------

test('默认关闭：未启用时**连请求都不构造**（transport 一次都不被调用）', async () => {
  const transport = fakeTransport(answersBody({ a: 0.5 }));
  const client = llm.createClient({ settings: {}, env: { JEV_API: 'apikey_shell' }, transport });
  const r = await client.decide({ state: '目标', questions: { a: { instructions: 'x' } } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, llm.FAIL.disabled);
  assert.equal(transport.calls.length, 0, '未启用时不得发出任何请求 —— 这是产品红线');
});

test('默认关闭：describe() 只说"配没配"，绝不吐密钥', () => {
  const client = llm.createClient({ settings: ENABLED, env: {}, transport: fakeTransport(answersBody({})) });
  const d = client.describe();
  assert.ok(!JSON.stringify(d).includes('sk-test'), '密钥不得出现在 describe 里');
  assert.equal(d.hasKey, true);
  assert.equal(d.keySource, 'settings');
  assert.equal(d.endpoint, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(d.model, llm.DEFAULT_MODEL);
});

test('端点非法 / 问题表为空时都不发请求', async () => {
  const t1 = fakeTransport(answersBody({ a: 0.5 }));
  const c1 = llm.createClient({ settings: { ...ENABLED, orchJevBaseUrl: 'file:///etc/passwd' }, env: {}, transport: t1 });
  assert.equal((await c1.decide({ state: 'x', questions: { a: { instructions: 'y' } } })).ok, false);
  assert.equal(t1.calls.length, 0);

  const t2 = fakeTransport(answersBody({ a: 0.5 }));
  const c2 = llm.createClient({ settings: ENABLED, env: {}, transport: t2 });
  assert.equal((await c2.decide({ state: 'x', questions: {} })).ok, false);
  assert.equal(t2.calls.length, 0, '空问题表不该发请求（发了必被服务端拒）');
});

// ---------- client：成功路径 ----------

test('成功：返回概率表与 token 用量，清零熔断计数', async () => {
  const transport = fakeTransport(answersBody({ splitable: 0.87, risky: 0.07 }));
  const client = llm.createClient({ settings: ENABLED, env: {}, transport });
  const r = await client.decide({
    state: '目标',
    questions: { splitable: { instructions: '可拆分吗' }, risky: { instructions: '有风险吗' } },
  });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'jev');
  assert.deepEqual(r.probs, { splitable: 0.87, risky: 0.07 });
  assert.equal(r.model, 'jev-1.13.0');
  assert.equal(r.usage.input_tokens, 280);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].opts.apiKey, 'sk-test');
  assert.equal(transport.calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.deepEqual(Object.keys(transport.calls[0].opts.body).sort(), ['model', 'questions', 'state']);
});

test('成功：答不上的问题不出现在 probs 里（而不是被当成 0）', async () => {
  const transport = fakeTransport(answersBody({ splitable: 0.87 }));
  const client = llm.createClient({ settings: ENABLED, env: {}, transport });
  const r = await client.decide({ state: 'x', questions: { splitable: { instructions: 'a' }, risky: { instructions: 'b' } } });
  assert.deepEqual(Object.keys(r.probs), ['splitable']);
});

test('决策回调拿到元信息（不含密钥），且失败时没有 probs', async () => {
  const seen = [];
  const client = llm.createClient({
    settings: ENABLED,
    env: {},
    transport: fakeTransport(answersBody({ splitable: 0.9 })),
    onDecision: (e) => seen.push(e),
  });
  await client.decide({ state: 'x', questions: { splitable: { instructions: 'a' } }, purpose: 'split' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ok, true);
  assert.equal(seen[0].purpose, 'split');
  assert.equal(seen[0].endpoint, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(seen[0].asked, 1);
  assert.equal(seen[0].answered, 1);
  assert.deepEqual(seen[0].probs, { splitable: 0.9 });
  assert.ok(!JSON.stringify(seen[0]).includes('sk-test'), '决策记录不得含密钥');

  const seen2 = [];
  const c2 = llm.createClient({ settings: {}, env: {}, transport: fakeTransport(answersBody({})), onDecision: (e) => seen2.push(e) });
  await c2.decide({ state: 'x', questions: { a: { instructions: 'y' } } });
  assert.equal(seen2[0].ok, false);
  assert.equal(seen2[0].reason, llm.FAIL.disabled);
  assert.equal(seen2[0].probs, undefined);
});

// ---------- client：失败路径全部退回 ----------

test('失败：超时/网络错/4xx/5xx/形状错都返回 ok:false，**永不 throw**', async () => {
  const cases = [
    [{ error: 'timeout', timedOut: true }, llm.FAIL.timeout],
    [{ error: 'ECONNREFUSED' }, llm.FAIL.network],
    [{ status: 401, body: 'unauthorized' }, llm.FAIL.http],
    [{ status: 500, body: 'boom' }, llm.FAIL.http],
    [{ status: 200, body: '{"detail":"Invalid request."}' }, llm.FAIL.shape],
  ];
  for (const pair of cases) {
    const client = llm.createClient({ settings: ENABLED, env: {}, transport: fakeTransport(pair[0]), retries: 0 });
    const r = await client.decide({ state: 'x', questions: { a: { instructions: 'y' } } });
    assert.equal(r.ok, false, `应失败：${pair[1]}`);
    assert.equal(r.reason, pair[1]);
    assert.equal(r.probs, undefined);
  }
});

test('失败：4xx 不重试（配置错重试没意义），5xx/429/超时才重试', async () => {
  const q = { state: 'x', questions: { a: { instructions: 'y' } } };
  const t401 = fakeTransport({ status: 401, body: 'x' });
  await llm.createClient({ settings: ENABLED, env: {}, transport: t401, retries: 3 }).decide(q);
  assert.equal(t401.calls.length, 1, '401 是配置错，重试没有意义');

  const t500 = fakeTransport({ status: 500, body: 'x' });
  await llm.createClient({ settings: ENABLED, env: {}, transport: t500, retries: 2 }).decide(q);
  assert.equal(t500.calls.length, 3, '5xx 应重试到耗尽');

  const t429 = fakeTransport({ status: 429, body: 'rate limited' });
  await llm.createClient({ settings: ENABLED, env: {}, transport: t429, retries: 1 }).decide(q);
  assert.equal(t429.calls.length, 2, '429 属可重试');

  const to = fakeTransport({ error: 'timeout', timedOut: true });
  await llm.createClient({ settings: ENABLED, env: {}, transport: to, retries: 2 }).decide(q);
  assert.equal(to.calls.length, 3, '超时应重试');
});

test('失败：transport 自己 throw 也不会把编排打断', async () => {
  const boom = async () => {
    throw new Error('transport exploded');
  };
  const r = await llm.createClient({ settings: ENABLED, env: {}, transport: boom }).decide({
    state: 'x',
    questions: { a: { instructions: 'y' } },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, llm.FAIL.network);
});

// ---------- 熔断 ----------

test('熔断：连续失败到阈值后停止发请求，冷却期满自动半开', async () => {
  const breakerState = { fails: 0, openedAt: 0 };
  const transport = fakeTransport({ status: 500, body: 'x' });
  const client = llm.createClient({ settings: ENABLED, env: {}, transport, retries: 0, breakerState });
  const q = { state: 'x', questions: { a: { instructions: 'y' } } };

  for (let i = 0; i < llm.BREAKER_THRESHOLD; i += 1) await client.decide(q);
  assert.equal(client.breaker.state(), 'open');
  const callsAtOpen = transport.calls.length;

  const r = await client.decide(q);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'circuit-open');
  assert.equal(transport.calls.length, callsAtOpen, '熔断后不得再发出请求');

  breakerState.openedAt = Date.now() - llm.BREAKER_COOLDOWN_MS - 1000;
  assert.equal(client.breaker.state(), 'half-open');

  const client2 = llm.createClient({
    settings: ENABLED,
    env: {},
    transport: fakeTransport(answersBody({ a: 0.5 })),
    retries: 0,
    breakerState: { fails: llm.BREAKER_THRESHOLD, openedAt: Date.now() - llm.BREAKER_COOLDOWN_MS - 1 },
  });
  assert.equal((await client2.decide(q)).ok, true);
  assert.equal(client2.breaker.snapshot().fails, 0, '成功应清零');
});

// ---------- 本地置信度 ----------

test('localConfidence：结构完整的拆分得分高，碎片/整句/单条得分低', () => {
  const good = split.localConfidence(['读 electron 多屏窗口定位代码并给结论', '实现位置钳制', '跑测试验证回归']);
  assert.equal(good, 1);
  assert.equal(split.localConfidence([]), 0);
  assert.equal(split.localConfidence(null), 0);
  assert.equal(split.localConfidence(['好', '的']), 0, '全是碎片应给 0');
  assert.equal(split.localConfidence(['只有一条子句']), 0, '单条 = 没拆开');
  assert.equal(split.localConfidence(['x'.repeat(200)]), 0, '整句塞进一条应给 0');
  assert.equal(split.localConfidence(['x'.repeat(60), 'y'.repeat(60)]), 0, '平均过长也应给 0');
  assert.ok(good > 0.5, '结构完整应过阈值');
});

// ---------- 判断问题表 ----------

test('buildJudgmentQuestions：固定三问 + 每个候选 agent 一问，agent 带上 __qKey', () => {
  const agents = [{ id: 'claude-code', name: 'Claude Code' }, { id: 'codex' }];
  const q = split.buildJudgmentQuestions('修复多屏窗口定位', agents);
  assert.ok(q.splitable && q.needs_research && q.risky, '三个固定判断维度');
  assert.equal(q.agent_claude_code.instructions.includes('Claude Code'), true);
  assert.equal(q.agent_codex.instructions.includes('codex'), true);
  assert.equal(agents[0].__qKey, 'agent_claude_code', '调用方要能通过 __qKey 找回问题名');
  // 问题名必须是合法标识符（同时是响应里的 key）
  for (const name of Object.keys(q)) assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/);
  // 没有 agent 时不带 agent_ 问题
  const none = split.buildJudgmentQuestions('x', []);
  assert.equal(Object.keys(none).filter((k) => k.startsWith('agent_')).length, 0);
});

test('buildJudgmentQuestions：agent id 含特殊字符时问题名仍合法', () => {
  const q = split.buildJudgmentQuestions('x', [{ id: 'qoder:raw/v2' }]);
  const key = Object.keys(q).find((k) => k.startsWith('agent_'));
  assert.match(key, /^[A-Za-z_][A-Za-z0-9_]*$/);
});

test('buildJudgmentQuestions：state 被截断，不把无限长的目标发出去', () => {
  const q = split.buildJudgmentQuestions('x'.repeat(5000), []);
  assert.ok(q.splitable.instructions.length < 1200, '超长目标必须截断');
});

// ---------- 判断结果解读 ----------

test('verdictOf：三档；中间档是 unsure（实测无关问题也会给 0.4~0.5，不能当 yes）', () => {
  assert.equal(split.verdictOf(0.9), 'yes');
  assert.equal(split.verdictOf(0.6), 'yes');
  assert.equal(split.verdictOf(0.5), 'unsure');
  assert.equal(split.verdictOf(0.4), 'no');
  assert.equal(split.verdictOf(0.07), 'no');
  assert.equal(split.verdictOf(null), 'unknown');
  assert.equal(split.verdictOf(undefined), 'unknown');
  assert.equal(split.verdictOf(NaN), 'unknown');
});

test('readJudgment：解析三问 + 路由建议；差距不够不给建议', () => {
  const agents = [{ id: 'a', name: 'A', __qKey: 'agent_a' }, { id: 'b', name: 'B', __qKey: 'agent_b' }];
  const j = split.readJudgment({ splitable: 0.87, risky: 0.07, needs_research: 0.8, agent_a: 0.7, agent_b: 0.68 }, agents);
  assert.equal(j.verdict, 'yes');
  assert.equal(j.risky, false);
  assert.equal(j.needsResearch, true);
  assert.equal(j.suggestedAgent, null, '0.7 vs 0.68 差距 0.02 < 0.15，应说分不出高下');

  const clear = split.readJudgment({ splitable: 0.9, agent_a: 0.9, agent_b: 0.3 }, agents);
  assert.equal(clear.suggestedAgent.id, 'a');
  assert.ok(clear.margin >= split.ROUTE_MARGIN);

  const allBad = split.readJudgment({ splitable: 0.1, risky: 0.95, needs_research: 0.9 }, agents);
  assert.equal(allBad.risky, true);
  assert.equal(allBad.verdict, 'no');
  assert.equal(allBad.suggestedAgent, null, '没有 agent 概率就不该硬派');
});

test('readJudgment：全空概率返回 unknown，不猜', () => {
  const j = split.readJudgment({}, [{ id: 'a', __qKey: 'agent_a' }]);
  assert.equal(j.splitable, null);
  assert.equal(j.verdict, 'unknown');
  assert.equal(j.risky, false);
  assert.equal(j.needsResearch, false);
  assert.equal(j.suggestedAgent, null);
  assert.equal(split.readJudgment(null, []).verdict, 'unknown');
});

// ---------- draftWithLlm：本地优先 ----------

test('draftWithLlm：本地置信度够时**完全不碰客户端**', async () => {
  let called = 0;
  const client = { decide: async () => { called += 1; return { ok: true, probs: { splitable: 0.9 } }; } };
  const r = await split.draftWithLlm('读 electron 多屏窗口定位代码并给结论。实现位置钳制。跑测试验证回归。', { client });
  assert.equal(r.source, 'local');
  assert.equal(r.modelTried, false);
  assert.equal(called, 0, '本地够好时不该问模型');
  assert.ok(r.tickets.length >= 2);
  assert.equal(r.judgment, null);
  assert.equal(r.tickets.every((t) => t.status === 'draft'), true, '进世界的第一状态永远是待人确认');
});

test('draftWithLlm：没有客户端时也能跑通全流程，并如实说明原因', async () => {
  const good = await split.draftWithLlm('读代码并给结论。然后实现改动。再跑测试验证。');
  assert.equal(good.source, 'local');
  assert.equal(good.modelTried, false);
  assert.match(good.reason, /置信度足够/);

  const poor = await split.draftWithLlm('嗯');
  assert.equal(poor.localConfidence, 0);
  assert.match(poor.reason, /未启用 JEV 判断/);
  assert.equal(poor.judgment, null);
});

test('draftWithLlm：空目标不炸，返回空工单', async () => {
  for (const goal of ['', '   ', null, undefined, '。，；']) {
    const r = await split.draftWithLlm(goal);
    assert.deepEqual(r.tickets, [], `目标 ${JSON.stringify(goal)} 应返回空`);
  }
});

test('draftWithLlm：client 缺 decide 方法时按不可用处理（不抛 TypeError）', async () => {
  for (const bad of [{}, { decide: 'not-fn' }, null, 42, 'x']) {
    const r = await split.draftWithLlm('读代码并给结论。然后实现改动。再跑测试验证。', { client: bad });
    assert.equal(r.source, 'local', `client=${JSON.stringify(bad)} 应退回本地`);
    assert.ok(r.tickets.length >= 1);
  }
});

test('draftWithLlm：低置信度时问JEV，工单措辞仍由本地规则产出', async () => {
  const seen = [];
  const client = {
    decide: async (req) => {
      seen.push(req);
      return { ok: true, probs: { splitable: 0.9, risky: 0.05, needs_research: 0.85, agent_claude_code: 0.8 }, source: 'jev' };
    },
  };
  const r = await split.draftWithLlm('把 agent 编排看板的工单拆分逻辑理清楚', {
    client,
    force: true,
    existingIds: ['ORCH-004'],
    agent: 'codex',
    cwd: '/repo',
    agents: [{ id: 'claude-code', name: 'Claude Code' }],
  });
  assert.equal(r.source, 'jev');
  assert.equal(r.modelTried, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].purpose, 'split-judgment');
  assert.ok(seen[0].questions.splitable, '发给 JEV 的是问题表，不是 prompt');
  assert.equal(seen[0].state.includes('工单拆分逻辑'), true);

  // 判断结论
  assert.equal(r.judgment.verdict, 'yes');
  assert.equal(r.judgment.needsResearch, true);
  assert.equal(r.judgment.risky, false);
  assert.equal(r.judgment.suggestedAgent.id, 'claude-code');

  // 工单本身：措辞/动作/依赖全部来自本地，agent 与 cwd 来自调用方
  assert.equal(r.tickets.length, 1);
  assert.equal(r.tickets[0].id, 'ORCH-005');
  assert.equal(r.tickets[0].agent, 'codex', 'agent 必须来自调用方，不能被建议覆盖');
  assert.equal(r.tickets[0].cwd, '/repo');
  assert.equal(r.tickets[0].title, '把 agent 编排看板的工单拆分逻辑理清楚', '措辞是本地切句的结果');
  assert.ok(Object.prototype.hasOwnProperty.call(T.ACCEPTANCE_TEMPLATES, r.tickets[0].action));
  assert.equal(r.tickets[0].command, undefined, '工单模型里没有命令字段');
  assert.match(r.reason, /JEV/);
  assert.match(r.reason, /建议先调研/);
});

test('draftWithLlm：JEV 不可用/无概率 → 一律退回本地，工单照样给', async () => {
  const bad = [
    { decide: async () => ({ ok: false, reason: 'timeout' }) },
    { decide: async () => ({ ok: true, probs: null }) },
    { decide: async () => ({ ok: true }) },
    { decide: async () => null },
    {
      decide: async () => {
        throw new Error('boom');
      },
    },
  ];
  for (const client of bad) {
    const r = await split.draftWithLlm('把工单拆分逻辑理清楚', { client, force: true });
    assert.equal(r.source, 'local', '模型不可用时必须退回本地');
    assert.equal(r.judgment, null);
    assert.ok(r.tickets.length >= 1, '本地结果必须仍然可用');
  }
});

test('draftWithLlm：工单永远是 draft，没有任何代码路径能产出可执行工单', async () => {
  const clients = [
    { decide: async () => ({ ok: true, probs: { risky: 0.99, agent_a: 0.99 }, source: 'jev' }) },
    null,
  ];
  for (const client of clients) {
    const r = await split.draftWithLlm('危险目标', { client, force: true, agent: 'claude-code', cwd: '/repo' });
    assert.equal(r.tickets.every((t) => t.status === 'draft'), true, '模型不得让工单绕过人确认');
    for (const t of r.tickets) {
      assert.equal(t.command, undefined);
      assert.equal(Array.isArray(t.acceptance), true);
      assert.equal(t.agent, 'claude-code');
    }
  }
  // 高风险目标时判断里会标出来，但工单照样是 draft —— 风险提示不等于放行
  const risky = await split.draftWithLlm('删掉所有历史数据', {
    client: { decide: async () => ({ ok: true, probs: { risky: 0.95 }, source: 'jev' }) },
    force: true,
  });
  assert.equal(risky.judgment.risky, true);
  assert.match(risky.reason, /不可逆操作/);
  assert.equal(risky.tickets.every((t) => t.status === 'draft'), true);
});

// ---------- decisions 落盘 ----------

test('sanitizeEntry：剥掉可能的密钥字段；只留合法概率与 token 数', () => {
  const out = decisions.sanitizeEntry({
    ok: true,
    source: 'jev',
    attempts: 1,
    durationMs: 1234,
    purpose: 'split-judgment',
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-1.13.0',
    asked: 3,
    answered: 3,
    probs: { splitable: 0.87, risky: NaN, bad: 'x', agent_a: 0.5 },
    usage: { input_tokens: 280, output_tokens: 20, secret: 'x' },
    apiKey: 'sk-should-never-appear',
    api_key: 'sk-should-never-appear',
    authorization: 'Bearer sk-should-never-appear',
    body: { state: '私密目标' },
  });
  const s = JSON.stringify(out);
  assert.ok(!s.includes('sk-should-never-appear'), '任何形态的密钥都不得落盘');
  assert.deepEqual(out.probs, { splitable: 0.87, agent_a: 0.5 }, 'NaN/非数字概率不进落盘');
  assert.deepEqual(out.usage, { input_tokens: 280, output_tokens: 20 }, '只留计数字段');
  assert.equal(out.asked, 3);
  assert.equal(out.durationMs, 1234);
  assert.equal(out.purpose, 'split-judgment');
});

test('decisions.record：落盘 0600，写坏不抛；prune 超额淘汰最旧', () => {
  const root = tmpDir();
  const f1 = decisions.record(root, { ok: true, probs: { a: 0.5 }, at: '2026-10-07T00:00:00.000Z' });
  const f2 = decisions.record(root, { ok: false, reason: 'timeout', at: '2026-10-07T00:00:01.000Z' });
  assert.ok(f1 && f2);
  assert.equal((fs.statSync(f1).mode & 0o777), 0o600);
  assert.equal(JSON.parse(fs.readFileSync(f1, 'utf8')).ok, true);
  // 目标是已存在的**文件**而不是目录 → mkdir 必然失败 → 返回 null 且不抛
  assert.equal(decisions.record(f1, { ok: true }) === null, true, '写不进去时返回 null，不抛');

  const dir = decisions.decisionsDir(root);
  for (let i = 0; i < decisions.MAX_FILES + 5; i += 1) {
    fs.writeFileSync(path.join(dir, `2026-01-01T00-00-00-000Z-${String(i).padStart(4, '0')}.json`), '{}');
  }
  assert.ok(decisions.prune(dir, 10) > 0);
  assert.equal(fs.readdirSync(dir).length, 10);
});

test('decisions.list / decisionFileName：读不存在的目录返回空；文件名带时间戳与防碰撞后缀', () => {
  assert.deepEqual(decisions.list(tmpDir()), []);
  assert.deepEqual(decisions.list(path.join(os.tmpdir(), 'definitely-not-here-' + Date.now())), []);
  const name = decisions.decisionFileName(new Date('2026-10-07T00:00:00.000Z'), 0.5);
  assert.match(name, /^2026-10-07T00-00-00-000Z-[0-9a-f]{4}\.json$/);
  const a = decisions.decisionFileName(new Date('2026-10-07T00:00:00.000Z'), 0.1);
  const b = decisions.decisionFileName(new Date('2026-10-07T00:00:00.000Z'), 0.9);
  assert.notEqual(a, b, '同一毫秒内的两次记录不能互相覆盖');
});

// ---------- Settings 接线 ----------

test('settingsFromSnapshot：显式白名单，不整体透传 snapshot', () => {
  const settings = llmPrefs.settingsFromSnapshot({
    orchJevEnabled: true,
    orchJevApiKey: 'sk-1',
    orchJevBaseUrl: 'https://x.dev/v1',
    orchJevModel: 'm',
    sessionSnapshot: { secret: 'x' },
    petWindowBounds: { x: 1 },
    telegramToken: 'nope',
  });
  assert.deepEqual(Object.keys(settings).sort(), ['orchJevApiKey', 'orchJevBaseUrl', 'orchJevEnabled', 'orchJevModel']);
  assert.ok(!JSON.stringify(settings).includes('telegramToken'), '无关字段不得进 LLM 配置');
  assert.equal(llmPrefs.settingsFromSnapshot(null).orchJevEnabled, false);
  assert.equal(llmPrefs.settingsFromSnapshot({ orchJevEnabled: 'yes' }).orchJevEnabled, false, '非 true 一律当作关');
});

test('llmStatus：给 UI 的视图不含密钥，只说有没有', () => {
  const st = llmPrefs.llmStatus({ settings: ENABLED, env: {} });
  assert.equal(st.enabled, true);
  assert.equal(st.hasKey, true);
  assert.equal(st.keySource, 'settings');
  assert.equal(st.model, llm.DEFAULT_MODEL);
  assert.equal(st.endpoint, 'https://api.typesafe.ai/v1/systemone');
  assert.ok(!JSON.stringify(st).includes('sk-test'));

  const off = llmPrefs.llmStatus({ settings: {}, env: { JEV_API: 'k' } });
  assert.equal(off.enabled, false);
  assert.equal(off.reason, llm.FAIL.disabled);
  assert.equal(off.hasKey, false);
});

test('llmStatus：Settings 读不到时视为关闭（默认不信任）', () => {
  const old = process.env.WORLD_PREFS_FILE;
  process.env.WORLD_PREFS_FILE = path.join(tmpDir(), 'nope.json');
  try {
    const st = llmPrefs.llmStatus({ env: { JEV_API: 'apikey' } });
    assert.equal(st.enabled, false, '读不到 Settings 不等于启用');
    assert.equal(st.configSource, 'prefs-unavailable');
  } finally {
    if (old === undefined) delete process.env.WORLD_PREFS_FILE;
    else process.env.WORLD_PREFS_FILE = old;
  }
});

test('prefs.js 新增字段落在 SCHEMA 里，且默认关闭、坏值被挡', () => {
  const prefs = require('../src/prefs');
  const d = prefs.getDefaults();
  assert.equal(d.orchJevEnabled, false, '默认必须关闭');
  assert.equal(d.orchJevApiKey, '');
  assert.equal(d.orchJevBaseUrl, '');
  assert.equal(d.orchJevModel, '');
  const v = prefs.validate({ orchJevEnabled: true, orchJevBaseUrl: 'file:///x', orchJevApiKey: 'k'.repeat(600) });
  assert.equal(v.orchJevEnabled, true, '合法的开关值被保留');
  assert.equal(v.orchJevBaseUrl, '', 'file: 端点被拒');
  assert.equal(v.orchJevApiKey, '', '超长密钥被拒');
  assert.equal(prefs.validate({}).orchJevEnabled, false);
});

// ---------- 网络出口探针 ----------

test('网络出口探针：默认关闭时整条链路零出网', async (t) => {
  const https = require('https');
  const http = require('http');
  const violations = [];
  const restore = [];
  for (const pair of [['https', https], ['http', http]]) {
    const orig = pair[1].request;
    pair[1].request = function () {
      violations.push(`${pair[0]}.request`);
      throw new Error('REAL NETWORK REQUEST ATTEMPTED');
    };
    restore.push(() => {
      pair[1].request = orig;
    });
  }
  t.after(() => {
    for (const fn of restore) fn();
  });

  const root = tmpDir();
  const transport = fakeTransport(answersBody({ splitable: 0.9 }));
  const scenarios = [
    ['未启用（env 里有密钥）', { settings: {}, env: { JEV_API: 'apikey_fake' } }],
    ['启用但无密钥', { settings: { orchJevEnabled: true }, env: {} }],
    ['启用+密钥但端点非法', { settings: { orchJevEnabled: true, orchJevApiKey: 'k', orchJevBaseUrl: 'file:///etc/passwd' }, env: {} }],
  ];
  for (const sc of scenarios) {
    const { client, describe } = llmPrefs.createOrchLlmClient({ settings: sc[1].settings, env: sc[1].env, transport, root });
    // 低置信度目标 → 一定会尝试问模型
    const r = await split.draftWithLlm('嗯', { client });
    assert.equal(describe().available, false, `${sc[0]} 应不可用`);
    assert.equal(r.source, 'local');
    assert.equal(r.modelTried, true, `${sc[0]} 应尝试过但失败`);
  }
  assert.deepEqual(violations, [], '不得发生任何真实出网');
});

test('本地够好时拆分器压根不问客户端，也就没有决策记录', async () => {
  const root = tmpDir();
  const transport = fakeTransport(answersBody({ splitable: 0.9 }));
  const { client } = llmPrefs.createOrchLlmClient({ settings: {}, env: { JEV_API: 'k' }, transport, root });
  const r = await split.draftWithLlm('读代码并给结论。然后实现改动。再跑测试验证。', { client });
  assert.equal(transport.calls.length, 0);
  assert.equal(r.source, 'local');
  assert.ok(r.tickets.length >= 2);
  assert.deepEqual(decisions.list(root), [], '没调用客户端就没有记录');
});

test('低置信度 + 未启用：决策记录落盘且写明原因', async () => {
  const root = tmpDir();
  const transport = fakeTransport(answersBody({ splitable: 0.9 }));
  const { client } = llmPrefs.createOrchLlmClient({ settings: {}, env: { JEV_API: 'k' }, transport, root });
  const r = await split.draftWithLlm('嗯', { client });
  assert.equal(r.modelTried, true);
  assert.equal(transport.calls.length, 0, '未启用时连请求都不发');
  const list = decisions.list(root);
  assert.equal(list.length, 1);
  assert.equal(list[0].ok, false);
  assert.equal(list[0].reason, llm.FAIL.disabled);
});