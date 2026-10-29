// world/orch/llm-prefs.js
// desktop-world · 把 Settings（clawd-prefs.json）里的 JEV 配置喂给 world/orch/llm.js。
//
// 为什么需要这一层：llm.js 是纯 Node、不依赖 Electron 的；而 Settings 只在 App 进程里
// 以 snapshot 形式存在。两边要接上，就得有一个地方把「从哪读配置」这件事统一起来，
// 而不是让 llm.js 自己去找文件（它找不到 —— GUI 进程的 userData 探测已在
// prefs-source.js 里，那依赖 src/prefs.js 的迁移语义）。
//
// 三个入口，三种配置来源，同一套字段名：
//   App（Electron）：src/settings-controller.js 的 snapshot —— 已验证、无需读盘
//   CLI（纯 Node）  ：prefs-source.js 的 loadPrefs()
//   单测：直接注入
//
// **密钥只在这一个模块被读取**，llm.js 拿到手之后不再往别处传；describe() 也不会把
// 密钥吐给调用方（调用方是 UI 与日志，那是最容易泄露的地方）。
'use strict';

const prefsSource = require('./prefs-source');
const llm = require('./llm');
const decisions = require('./decisions');

// 从 snapshot 里挑出 llm.resolveConfig 认识的字段名。
// **显式白名单**，不是对象整体透传 —— snapshot 里有几十个字段（含路径、状态），
// 整体传进 LLM 配置结构是信息泄露的温床。
function settingsFromSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    // 读不到 Settings 一律当作"没配"——默认不信任，与 dispatch 那边同一条纪律。
    return { orchJevEnabled: false, orchJevApiKey: '', orchJevBaseUrl: '', orchJevModel: '' };
  }
  return {
    orchJevEnabled: snapshot.orchJevEnabled === true,
    orchJevApiKey: typeof snapshot.orchJevApiKey === 'string' ? snapshot.orchJevApiKey : '',
    orchJevBaseUrl: typeof snapshot.orchJevBaseUrl === 'string' ? snapshot.orchJevBaseUrl : '',
    orchJevModel: typeof snapshot.orchJevModel === 'string' ? snapshot.orchJevModel : '',
  };
}

/**
 * 读当前 Settings（App 与 CLI 通用）。
 *
 * App 侧可以直接把 snapshot 传进来避免读盘；CLI 侧走 prefs-source。
 *
 * @param {object} [opts]
 * @param {object} [opts.snapshot]  已有的 prefs snapshot（App 侧传）
 * @param {object} [opts.env]环境变量（单测注入）
 * @returns {{ok:boolean, settings:object, reason:string}}
 */
function readSettings(opts = {}) {
  if (opts.snapshot) {
    return { ok: true, settings: settingsFromSnapshot(opts.snapshot), reason: '' };
  }
  const loaded = prefsSource.loadPrefs();
  if (!loaded.ok) {
    // 读不到 Settings **不等于**"启用 JEV"。返回 enabled:false，编排层据此不发出网请求。
    // 这与 dispatch 那边"读不到 prefs 就拒绝派单"是同一条纪律：默认不信任。
    return {
      ok: false,
      settings: { orchJevEnabled: false, orchJevApiKey: '', orchJevBaseUrl: '', orchJevModel: '' },
      reason: loaded.reason,
    };
  }
  return { ok: true, settings: settingsFromSnapshot(loaded.snapshot), reason: '' };
}

/**
 * 建一个接好 Settings 与 decisions 落盘的 JEV 客户端。
 *
 * @param {object} [opts]
 * @param {object} [opts.snapshot] App 侧已有的 prefs snapshot
 * @param {object} [opts.settings] 直接指定配置（优先级最高，单测用）
 * @param {object} [opts.env]       环境变量
 * @param {string} [opts.root]      decisions 落盘根目录
 * @param {Function} [opts.transport] 注入 transport（单测必用）
 * @param {boolean} [opts.recordDecisions] 是否落盘决策记录，默认 true
 * @returns {{client:object, describe:Function, source:string}}
 *   client 可直接喂给 split.draftWithLlm({ client })
 */
function createOrchLlmClient(opts = {}) {
  let settings = opts.settings;
  let source = 'settings';
  if (!settings) {
    const read = readSettings(opts);
    settings = read.settings;
    source = read.ok ? 'prefs' : 'prefs-unavailable';
  }

  const onDecision =
    opts.recordDecisions === false ? null : decisions.recorderFor(opts.root);

  const client = llm.createClient({
    settings,
    env: opts.env || process.env,
    transport: opts.transport,
    onDecision,
    timeoutMs: opts.timeoutMs,
    retries: opts.retries,
    breakerState: opts.breakerState,
  });

  const describe = () => {
    const d = client.describe();
    // 补一条"配置从哪来"，复盘 JEV_API 那个坑时要用
    return { ...d, configSource: source };
  };

  return { client, describe, source };
}

/**
 * 给 UI 用的状态视图。**绝不包含密钥本身**，只有"配没配"和"从哪配的"。
 */
function llmStatus(opts = {}) {
  const { describe, source } = createOrchLlmClient({ ...opts, recordDecisions: false });
  const d = describe();
  return {
    enabled: d.available === true,
    reason: d.reason,
    hasKey: d.hasKey === true,
    keySource: d.keySource,
    endpoint: d.endpoint,
    model: d.model,
    breaker: d.breaker,
    configSource: source,
  };
}

module.exports = { settingsFromSnapshot, readSettings, createOrchLlmClient, llmStatus };