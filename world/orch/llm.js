// world/orch/llm.js
// desktop-world · 编排层的 JEV 决策客户端（纯 Node，无新依赖）。
//
// ════════════════════════════════════════════════════════════════
//⚠️ Jev **不是** OpenAI 兼容的 chat/completions —— 网上流传的那个说法是错的。
//   这一点是本模块全部设计的出发点，所以放在最前面：
//
//   端点：POST https://api.typesafe.ai/v1/systemone
//         （注意不是 api.jev.ai —— 那个子域没有 A 记录，根本解析不出来；
//           Jev.ai是官网域名，API 挂在 typesafe.ai 下，TypeSafe AI 是同一家公司）
//   鉴权：Authorization: Bearer $JEV_API
//   请求体：{ state, model, questions }
//     - state    ：被判断的文本（对编排层来说就是用户的目标）
//     - model    ：模型名，控制台实际显示为准
//     - questions：**声明式问题表** { 名字: { type: "noul", instructions: "..." } }
//   响应：{ model, answers: { 名字: { type:"noul", noul: 0..1 } }, usage: {...} }
//
//   所以 Jev **不生成文本**，它输出的是**结构化概率**。这恰好决定了它在本项目里的
//   位置：只做判断与打分，不做文本生成。曾经按"OpenAI兼容"写的 chat/completions 版本
//   实测全部 404 —— 留着这段注释是为了下一个人不要再走一遍。
//
// ── 那它能做什么，不能做什么 ───────────────────────────────────
//   ✅ 判断目标是否可拆分、该派给哪个已装 agent、失败原因归类、风险高低、置信度校准
//   ✅ 一次调用问多个问题（省时省钱，且各问题的答案互相独立可解释）
//   ❌ 生成长文技术总结 —— 继续走 world/summarizer.js 的 claude -p，别动它
//   ❌ 生��子任务文本 —— 它不写文本，拆分措辞仍由本地确定性规则产出
//   ❌ 自由决定 spawn 进程 / cd 到哪 / 执行什么命令 —— 绝不
//
//   换句话说：**Jev 负责"判断该不该拆、该派给谁、风险多大"，本地规则负责"具体怎么写"，
//   人负责"确认与放行"。** 三者职责不重叠。
//
// ── 降级哲学（照 world/summarizer.js 的既有约定）─────────────────
// 编排链路不能因为一个外部 API 挂了就断。任何失败（未启用 / 无密钥 / 端点错 / 超时 /
// 熔断 / 响应形状不对）都**静默退回Stage C-1 的本地确定性拆分器**，并把原因如实带回。
// 本模块**永不throw**，永不阻塞超过 timeout 总预算。
//
// ── 密钥读取：双通道（这是最容易踩坑的地方）────────────────────
// JEV_API 写在 ~/.zshrc 里。而 **open -a 启动的 Electron GUI 进程不加载 .zshrc**，
// 所以打包后 process.env.JEV_API 读不到 —— 只有 `npm start`（走 shell）才读得到。
// 因此读取顺序是：Settings 显式配置 > 环境变量，且两个变量名都兼容
// （JEV_API 与 JEV_API_KEY —— 用户的 .zshrc 用前者，文档里常见后者）。
// 密钥只走既有 src/settings-store.js 体系，**不新建任何 secrets 文件**。
//
// ── 默认关闭 ──────────────────────────────────────────────────
// enabled 默认 false。未显式开启时连请求都不构造、更不发出去（不是"发了被拒"）。
// 这条是产品红线「数据不出本机是默认态」的实现：唯一的出网请求必须经过人点头。
'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

const DEFAULT_BASE_URL = 'https://api.typesafe.ai/v1';
const DEFAULT_PATH = '/systemone';
const DEFAULT_MODEL = 'jev-latest';
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_RETRIES = 1; // 首次 + 1 次重试
const MAX_OUTPUT_CHARS = 200000; // 单次响应上限，防止失控的超长回复吃满内存
const MAX_QUESTIONS = 12; // 一次调用最多几个问题（多了延迟与费用都不划算）

// 环境变量候选名（用户的 .zshrc 里是 JEV_API；JEV_API_KEY 是文档常见写法）
const ENV_KEYS = Object.freeze(['JEV_API', 'JEV_API_KEY']);
const ENV_BASE_KEYS = Object.freeze(['JEV_BASE_URL']);
const ENV_MODEL_KEYS = Object.freeze(['JEV_MODEL']);

// 状态标记：熔断器认这个。**不带原因文本** —— 原因里可能夹带端点/密钥片段，
// 不该跟着状态在内存里到处传（状态会被记进 decisions 落盘）。
const FAIL = Object.freeze({
  disabled: 'disabled',
  noKey: 'no-key',
  badEndpoint: 'bad-endpoint',
  timeout: 'timeout',
  network: 'network',
  http: 'http',
  shape: 'shape',
});

/** 熔断阈值：连续失败多少次后停止发请求，等冷却。 */
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 60000;

/**
 * 从环境变量里取第一个非空值（纯函数，便于单测注入 env）。
 * @param {string[]} names候选名，按优先级排
 * @param {object} [env] 注入的环境，默认 process.env
 */
function envFirst(names, env = process.env) {
  for (const name of names) {
    const v = env ? env[name] : undefined;
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/**
 * 问题表归一化（纯函数）。Jev 的 questions 每一项至少要有 instructions ——
 * 实测缺 instructions 会返回 "Noul question must have criteria or instructions"。
 * 名字只允许 ASCII 字母数字下划线（它是响应里的 key）。
 * 非法项直接丢掉，不做"尽力修复" —— 发一个必失败的请求没有意义。
 *
 * @param {object} questions { name: { type?, instructions?, criteria? } }
 * @returns {{ok:boolean, questions:object, dropped:number}}
 */
function normalizeQuestions(questions) {
  const out = {};
  let dropped = 0;
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) {
    return { ok: false, questions: {}, dropped: 0 };
  }
  for (const [name, spec] of Object.entries(questions)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name || ''))) {
      dropped += 1;
      continue;
    }
    if (!spec || typeof spec !== 'object') {
      dropped += 1;
      continue;
    }
    const instructions = typeof spec.instructions === 'string' ? spec.instructions.trim().slice(0, 500) : '';
    const criteria = spec.criteria;
    // instructions 与 criteria 至少要有一个，否则服务端必然拒绝
    if (!instructions && criteria === undefined) {
      dropped += 1;
      continue;
    }
    const item = { type: 'noul' };
    if (instructions) item.instructions = instructions;
    if (criteria !== undefined) item.criteria = criteria;
    // 实测 enum/options 不会报错但也不改变返回形状（仍是 noul），故不透传，
    // 避免"传了一个看起来生效其实没用的参数"这种误导。
    out[name] = item;
    if (Object.keys(out).length >= MAX_QUESTIONS) break;
  }
  return { ok: Object.keys(out).length > 0, questions: out, dropped };
}

/**
 * 解析并校验配置。**纯函数** —— 不读文件、不读全局 env 之外的任何东西，
 * env 全部靠参数注入，所以单测不需要改process.env 也不会互相污染。
 *
 * @param {object} [opts]
 * @param {object} [opts.settings] Settings 显式配置（来自 src/settings-store.js）
 * @param {object} [opts.env]       环境变量（默认 process.env）
 * @returns {{ok:boolean, reason?:string, baseUrl?:string, model?:string, apiKey?:string,
 *            source?:string, timeoutMs?:number, retries?:number, requestUrl?:URL}}
 *   ok=false 时 reason 说明为什么不可用；调用方据此退回本地拆分器。
 */
function resolveConfig(opts = {}) {
  const env = opts.env || process.env;
  const s = opts.settings && typeof opts.settings === 'object' ? opts.settings : {};

  // 开关只认 Settings 显式值。**不接受环境变量单独打开**——环境变量是你 shell 里
  // 顺手带的，不等于"我在这个应用里同意把数据发出去"。
  if (s.orchJevEnabled !== true) {
    return { ok: false, reason: FAIL.disabled };
  }

  const apiKey = typeof s.orchJevApiKey === 'string' && s.orchJevApiKey.trim()
    ? s.orchJevApiKey.trim()
    : envFirst(ENV_KEYS, env);
  if (!apiKey) return { ok: false, reason: FAIL.noKey };

  const baseUrlRaw = (typeof s.orchJevBaseUrl === 'string' && s.orchJevBaseUrl.trim())
    || envFirst(ENV_BASE_KEYS, env)
    || DEFAULT_BASE_URL;

  const model = (typeof s.orchJevModel === 'string' && s.orchJevModel.trim())
    || envFirst(ENV_MODEL_KEYS, env)
    || DEFAULT_MODEL;

  const parsed = parseEndpoint(baseUrlRaw);
  if (!parsed.ok) return { ok: false, reason: FAIL.badEndpoint };

  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const retries = Number.isFinite(opts.retries) && opts.retries >= 0 ? Math.floor(opts.retries) : DEFAULT_RETRIES;

  // source 记录密钥是从哪来的 —— 复盘时能区分"GUI 里配的"和"shell 里带的"，
  // 这正是 JEV_API 那个坑的诊断依据。只记来源类型，不记密钥本身。
  const source = typeof s.orchJevApiKey === 'string' && s.orchJevApiKey.trim() ? 'settings' : 'env';

  return {
    ok: true,
    baseUrl: baseUrlRaw,
    model,
    apiKey,
    source,
    timeoutMs,
    retries,
    // requestUrl 是 URL 实例：transport 直接拿它调 https.request，不需要再转字符串。
    requestUrl: parsed.url,
    protocol: parsed.protocol,
  };
}

/**
 * 端点解析：base_url + /systemone。只允许 http/https，其余（file:、ftp:、
 * 未知协议）一律拒绝 —— 端点最终会变成一个真实的网络请求，协议白名单是
 * "数据不会被发到别处"的第一道闸。
 *
 * 用户可能填 `https://api.typesafe.ai/v1`（基址）、`.../v1/systemone`（完整端点），
 * 或干脆填到域根。三种都要能认。
 *
 * @returns {{ok:boolean, url?:URL, protocol?:string}}
 */
function parseEndpoint(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return { ok: false };
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false };
  const pathname = u.pathname.replace(/\/+$/, '');
  if (!pathname.endsWith(DEFAULT_PATH)) u.pathname = `${pathname}${DEFAULT_PATH}`;
  u.search = '';
  u.hash = '';
  return { ok: true, url: u, protocol: u.protocol };
}

/**
 * 建请求体。**注意这里没有 temperature / max_tokens / stream** ——
 * systemone 不是 chat/completions，发这些字段过去没有意义（实测被忽略）。
 *
 * 单独抽出来是为了单测能直接断言线上发的到底是什么形状。
 */
function buildRequestBody({ model, state, questions }) {
  return { model, state: String(state == null ? '' : state), questions };
}

/**
 * 默认 transport：真的走网络。**只在生产路径被调用**，单测一律注入假 transport。
 *
 * 拆成独立函数而不是内联，是为了让"这个模块能不能在测试里不发请求"这件事
 * 在结构上就是显然的 —— 没有任何地方隐式调用 https.request。
 *
 * @returns {Promise<{status:number, body:string}>} 网络层错误也 resolve 成 {error}，不 reject
 */
function httpsTransport(url, { apiKey, body, timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    let payload;
    try {
      payload = JSON.stringify(body);
    } catch (err) {
      done({ error: `请求体序列化失败：${err.message}` });
      return;
    }

    const mod = url.protocol === 'http:' ? http : https;
    const req = mod.request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${apiKey}`,
          'content-length': Buffer.byteLength(payload),
          'user-agent': 'desktop-world-orch/1.0',
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          // 超大响应直接掐断：不该把内存吃满，也不该继续往 decisions 落盘
          if (size > MAX_OUTPUT_CHARS) {
            req.destroy();
            done({ error: `响应超过 ${MAX_OUTPUT_CHARS} 字节上限` });
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => done({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', (err) => done({ error: `读响应失败：${err.message}` }));
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      done({ error: FAIL.timeout, timedOut: true });
    });
    req.on('error', (err) => done({ error: `网络请求失败：${err.message}` }));
    req.end(payload);
  });
}

/**
 * 从 systemone 响应里抠出 answers 表。
 * 返回 { ok, answers, model, usage }；形状不对时 ok=false。
 * 宽容处理：直接给 {answers:{...}}，或包一层 {data:{...}} / {result:{...}}。
 */
function extractAnswers(raw) {
  let obj = typeof raw === 'string' ? safeParse(raw) : raw;
  if (!obj || typeof obj !== 'object') return { ok: false, answers: {}, model: null, usage: null };
  for (const key of ['data', 'result']) {
    if (!obj.answers && obj[key] && typeof obj[key] === 'object') {
      const nested = safeParse(typeof obj[key] === 'string' ? obj[key] : JSON.stringify(obj[key]));
      if (nested && nested.answers) obj = nested;
      break;
    }
  }
  const answers = obj.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return { ok: false, answers: {}, model: null, usage: null };
  }
  return { ok: true, answers, model: obj.model || null, usage: obj.usage || null };
}

/** 取单个问题的概率值（0..1）。答不上来返回 null，绝不返回 0（0 是有效概率）。 */
function noulOf(answers, name) {
  const a = answers && answers[name];
  if (!a || typeof a !== 'object') return null;
  const v = typeof a.noul === 'number' ? a.noul : null;
  if (v == null || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(1, v));
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * 客户端工厂。返回一个"永不 throw、永不阻塞超过总预算"的调用函数。
 *
 * @param {object} [opts]
 * @param {object} [opts.settings] Settings 显式配置
 * @param {object} [opts.env]       环境变量（单测注入）
 * @param {Function} [opts.transport] 注入的 transport（单测必用）
 * @param {Function} [opts.onDecision]  每次调用的落盘回调（落 decisions/ 用）
 * @param {object} [opts.breakerState]  熔断器状态（可注入，便于单测预置"已熔断"）
 */
function createClient(opts = {}) {
  const cfg = resolveConfig(opts);
  const transport = typeof opts.transport === 'function' ? opts.transport : httpsTransport;
  const onDecision = typeof opts.onDecision === 'function' ? opts.onDecision : null;

  // 熔断器状态放在闭包里：连续失败到阈值就停止发请求，冷却期内直接返回 fail。
  // 这是编排链路不被外部 API 拖死的关键 —— 一个挂掉的端点不该让每次拆分都等30 秒。
  const breaker = opts.breakerState || { fails: 0, openedAt: 0 };

  function breakerState() {
    if (!breaker.fails) return 'closed';
    if (breaker.fails < BREAKER_THRESHOLD) return 'half-open';
    const elapsed = Date.now() - breaker.openedAt;
    if (elapsed >= BREAKER_COOLDOWN_MS) return 'half-open';
    return 'open';
  }

  /**
   * 问一组问题，拿回一组概率。**不生成文本**（见文件头的能力边界说明）。
   *
   * @param {{state:string, questions:object, purpose?:string}} req
   * @returns {Promise<{ok:boolean, answers?:object, probs?:object, model?:string,
   *   usage?:object, reason?:string, source:string, attempts:number}>}
   *   ok=false 时**不带 answers**，调用方必须走本地拆分器。
   */
  async function decide(req) {
    const started = Date.now();
    const base = { source: 'local', attempts: 0, model: cfg.ok ? cfg.model : null, purpose: req.purpose || '' };

    if (!cfg.ok) {
      record({ ...base, ok: false, reason: cfg.reason, endpoint: null, durationMs: 0 });
      return { ok: false, reason: cfg.reason, source: 'local', attempts: 0 };
    }

    const norm = normalizeQuestions(req.questions);
    if (!norm.ok) {
      record({ ...base, ok: false, reason: FAIL.shape, errorSnippet: '问题表为空或全非法', endpoint: safeEndpoint(cfg.baseUrl), durationMs: 0 });
      return { ok: false, reason: FAIL.shape, source: 'local', attempts: 0 };
    }

    const state = breakerState();
    if (state === 'open') {
      record({ ...base, ok: false, reason: 'circuit-open', endpoint: safeEndpoint(cfg.baseUrl), durationMs: 0 });
      return { ok: false, reason: 'circuit-open', source: 'local', attempts: 0 };
    }

    const body = buildRequestBody({ model: cfg.model, state: req.state, questions: norm.questions });

    let lastReason = FAIL.network;
    let attempts = 0;
    for (let i = 0; i <= cfg.retries; i += 1) {
      attempts += 1;
      let res;
      try {
        res = await transport(cfg.requestUrl, {
          apiKey: cfg.apiKey,
          body,
          timeoutMs: cfg.timeoutMs,
        });
      } catch (err) {
        // transport 自己不该 throw，但真throw 了也不能让编排断在这里
        lastReason = FAIL.network;
        record({
          ...base,
          ok: false,
          reason: lastReason,
          error: err && err.message,
          endpoint: safeEndpoint(cfg.baseUrl),
          durationMs: Date.now() - started,
          attempts,
        });
        return { ok: false, reason: lastReason, source: 'local', attempts };
      }

      if (res && res.timedOut) {
        lastReason = FAIL.timeout;
        continue; // 超时值得重试
      }
      if (res && res.error) {
        lastReason = /超时|timeout/i.test(String(res.error)) ? FAIL.timeout : FAIL.network;
        continue;
      }
      const status = res && typeof res.status === 'number' ? res.status : 0;
      if (status < 200 || status >= 300) {
        lastReason = FAIL.http;
        record({
          ...base,
          ok: false,
          reason: lastReason,
          httpStatus: status,
          // 响应体可能含服务端错误细节，落盘前截断；它不该含我们的请求体
          errorSnippet: String((res && res.body) || '').slice(0, 200),
          endpoint: safeEndpoint(cfg.baseUrl),
          durationMs: Date.now() - started,
          attempts,
        });
        // 4xx 基本是配置错（鉴权/请求体形状），重试没有意义 —— 立刻返回，别浪费一轮
        if (status >= 400 && status < 500 && status !== 429) {
          return { ok: false, reason: lastReason, httpStatus: status, source: 'local', attempts };
        }
        continue;
      }

      const parsed = extractAnswers(res.body);
      if (!parsed.ok) {
        lastReason = FAIL.shape;
        continue;
      }

      // 成功：清零熔断计数
      breaker.fails = 0;
      breaker.openedAt = 0;
      // 把答案压成 名字→概率，便于调用方直接用；原始 answers 也留着（可能有别的形状）
      const probs = {};
      for (const name of Object.keys(norm.questions)) {
        const v = noulOf(parsed.answers, name);
        if (v !== null) probs[name] = v;
      }
      record({
        ...base,
        ok: true,
        endpoint: safeEndpoint(cfg.baseUrl),
        durationMs: Date.now() - started,
        attempts,
        asked: Object.keys(norm.questions).length,
        answered: Object.keys(probs).length,
        usage: parsed.usage,
        // 概率本身落盘：复盘时能看到"当初模型给这个判断打了多少分"
        probs,
      });
      return { ok: true, answers: parsed.answers, probs, model: parsed.model || cfg.model, usage: parsed.usage, source: 'jev', attempts };
    }

    // 重试耗尽 → 熔断计数 +1
    breaker.fails += 1;
    breaker.openedAt = Date.now();
    record({ ...base, ok: false, reason: lastReason, endpoint: safeEndpoint(cfg.baseUrl), durationMs: Date.now() - started, attempts });
    return { ok: false, reason: lastReason, source: 'local', attempts };
  }

  function record(entry) {
    if (!onDecision) return;
    try {
      onDecision(entry);
    } catch {
      /* 落盘失败绝不能影响决策结果 */
    }
  }

  return {
    decide,
    breaker: { state: breakerState, snapshot: () => ({ ...breaker }) },
    describe() {
      return {
        available: cfg.ok,
        reason: cfg.ok ? null : cfg.reason,
        // 只暴露"有没有配"，绝不把密钥本身交给调用方（会被日志/UI 拿到）
        hasKey: Boolean(cfg.apiKey),
        keySource: cfg.ok ? cfg.source : null,
        endpoint: cfg.ok ? safeEndpoint(cfg.baseUrl) : null,
        model: cfg.ok ? cfg.model : null,
        breaker: breakerState(),
      };
    },
  };
}

/** 端点只留 origin + 路径，丢查询参数与凭据 —— 落盘/日志里不需要更细的东西。 */
function safeEndpoint(baseUrl) {
  try {
    const u = new URL(String(baseUrl || ''));
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}${DEFAULT_PATH}`;
  } catch {
    return null;
  }
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_PATH,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RETRIES,
  MAX_QUESTIONS,
  ENV_KEYS,
  FAIL,
  BREAKER_THRESHOLD,
  BREAKER_COOLDOWN_MS,
  envFirst,
  normalizeQuestions,
  resolveConfig,
  parseEndpoint,
  buildRequestBody,
  extractAnswers,
  noulOf,
  httpsTransport,
  createClient,
  safeEndpoint,
};