// world/techstack/propose.js
// desktop-world · 关键词收敛的候选生成：把"模糊方向 + 项目记忆"变成 4–8 个具体关键词。
// 两层：LLM（claude -p，结合真实记忆出题）→ 失败/关闭时静默退到确定性词典匹配。
// 确定性层是纯函数，直接可单测（extractKeywords）。
'use strict';

const { cleanKeywords } = require('./config');

// 技术词典：「方向词/项目用材」→「具体考点词」。进词典的原则是"能出八股题"，
// 所以词都落到可考的具体点（持久化/多屏/桥），而不是"前端""框架"这种大词。
const LEXICON = [
  { kw: 'zustand persist 持久化', alias: ['zustand', 'persist', '状态管理', '持久化', 'store'] },
  { kw: 'electron 多屏多 Space 窗口定位', alias: ['electron', '多屏', 'space', '显示器', 'display', '窗口', 'window', 'frameless'] },
  { kw: 'IPC contextBridge 最小桥设计', alias: ['ipc', 'contextbridge', 'preload', '桥', 'sandbox', 'sandbox:true'] },
  { kw: 'CSS app-region 拖拽与点击', alias: ['app-region', '拖拽', 'drag', 'no-drag', '点击穿透'] },
  { kw: 'BrowserWindow 透明无框窗口', alias: ['browserwindow', '透明', '无框', 'transparent'] },
  { kw: 'node:test 单测与夹具隔离', alias: ['node:test', 'test', '单测', '测试', '夹具', 'fixture'] },
  { kw: 'ffmpeg 视频素材取帧与调色板', alias: ['ffmpeg', 'apng', '视频', '素材', '调色板', 'lanczos', 'colorkey'] },
  { kw: '正则白名单输入校验', alias: ['正则', 'regex', '校验', '白名单', 'validate'] },
  { kw: 'JSONL 转录增量解析', alias: ['jsonl', '转录', 'transcript', '解析', '解析器'] },
  { kw: 'cli.js 无头流水线设计', alias: ['cli', '流水线', 'pipeline', '无头', 'headless'] },
  { kw: 'osascript / AppleScript 系统自动化', alias: ['osascript', 'applescript', '自动化', '授权'] },
  { kw: 'macOS CGWindow/桌面层级', alias: ['cgwindow', '层级', 'dock', 'layer', '桌面层', 'plash'] },
  { kw: 'TypeScript 严格模式迁移', alias: ['typescript', 'ts', 'strict', '类型'] },
  { kw: 'React 状态与渲染批处理', alias: ['react', 'setstate', 'useeffect', 'hook', '渲染'] },
  { kw: 'Redux/zustand 选型取舍', alias: ['redux', '选型', '中间件'] },
  { kw: 'Vite/esbuild 构建提速', alias: ['vite', 'esbuild', '构建', 'hmr'] },
  { kw: 'Git worktree 并行开发', alias: ['worktree', 'git', '分支'] },
  { kw: 'Prompt 工程结构化输出', alias: ['prompt', '提示词', 'llm', '结构化输出', 'json output'] },
  { kw: '幂等设计与同日重跑', alias: ['幂等', 'idempotent', '重跑', '去重'] },
  { kw: '文件权限 0600 与隐私落盘', alias: ['0600', '权限', '隐私', 'chmod'] },
  { kw: '防抖节流与渲染轮询', alias: ['防抖', 'debounce', '节流', '轮询', 'setinterval'] },
  { kw: 'SVG 程序化生成与种子随机', alias: ['svg', 'mulberry32', 'fnv', '像素', '种子'] },
  { kw: 'webhook 机器人接入与签名校验', alias: ['webhook', '机器人', '加签', '企业微信', '钉钉', '飞书'] },
  { kw: 'screencapture / 截图验证', alias: ['screencapture', '截图', 'capturepage'] },
  { kw: 'Electron 打包 files 白名单', alias: ['打包', 'electron-builder', 'files', 'asar'] },
];

// 方向 → 各词典条目的命中分：方向原名权 3，出现在记忆标题/项目/工具里权 1（封顶）
function scoreEntry(entry, dirTokens, memoryText) {
  let s = 0;
  for (const a of entry.alias) {
    const t = a.toLowerCase();
    if (dirTokens.some((d) => d.includes(t) || t.includes(d))) s += 3;
    if (memoryText.includes(t)) s += 1;
  }
  return s;
}

function tokenizeDirection(direction) {
  return String(direction || '')
    .toLowerCase()
    .split(/[\s,，、/|]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 1);
}

/**
 * 确定性候选（纯函数）：方向命中权重的词典项 + 方向本身（若过校验）按序去重，4–8 条。
 * @param {string} direction 模糊方向（如"状态管理"）
 * @param {object} memory    buildMemory() 的结果（可为空对象）
 */
function extractKeywords(direction, memory = {}) {
  const dirTokens = tokenizeDirection(direction);
  const memoryText = [
    ...(memory.titles || []),
    ...(memory.projects || []).map((p) => p.name),
    ...(memory.tools || []).map((t) => t.name),
    ...(memory.tips || []),
    ...(memory.blockers || []),
    ...(memory.watch || []).map((w) => `${w.name} ${w.path}`),
  ]
    .join('\n')
    .toLowerCase();

  const scored = LEXICON.map((e) => ({ kw: e.kw, s: scoreEntry(e, dirTokens, memoryText) }))
    .filter((e) => e.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((e) => e.kw);

  // 方向本身若能过白名单，作为第一候选（用户原话往往最贴）
  const seed = cleanKeywords([direction]);
  const merged = [...seed, ...scored];
  const seen = new Set();
  const out = [];
  for (const kw of merged) {
    if (seen.has(kw.toLowerCase())) continue;
    seen.add(kw.toLowerCase());
    out.push(kw);
    if (out.length >= 8) break;
  }
  // ✅ 至少 4 条：不足时用"记忆里有但没命中方向"的高分词补齐（让候选永远有得挑）；
  // 记忆也全空（全新用户）就按词典顺序补——"至少 4 条"是本函数对调用方的硬契约
  if (out.length < 4) {
    const fill = LEXICON.map((e) => ({ kw: e.kw, s: scoreEntry(e, [], memoryText) }))
      .sort((a, b) => b.s - a.s);
    for (const f of fill) {
      if (out.length >= 4) break;
      if (!seen.has(f.kw.toLowerCase())) {
        seen.add(f.kw.toLowerCase());
        out.push(f.kw);
      }
    }
  }
  return out;
}

function buildProposePrompt(direction, memory) {
  return [
    '你是面试官 + 技术教练。用户给了一个模糊学习方向，请结合他最近 7 天真实在做的项目和活动，提出 4–8 个**具体到可考八股**的关键词/考点（每条 ≤22 字）。',
    '要求：必须能从下面的项目/标题/工具材料里找到依据；不给大词（如"前端""架构"），只给具体点（如"zustand persist 持久化""electron 多屏窗口定位"）；按与用户方向的相关性排序。',
    '严格只输出 JSON：{"keywords":["...","..."]}，不要 markdown、不要解释。',
    '',
    `方向：${direction}`,
    `最近专案：${JSON.stringify(memory.watch || [])}`,
    `最近项目分布：${JSON.stringify(memory.projects || [])}`,
    `最近工具：${JSON.stringify(memory.tools || [])}`,
    `最近会话标题：${JSON.stringify((memory.titles || []).slice(0, 15))}`,
    `历史 tips 主题：${JSON.stringify((memory.tips || []).slice(0, 10))}`,
  ].join('\n');
}

/**
 * 高层入口：LLM 优先（结合记忆出题），失败/禁用静默退回确定性词典层。
 * @param {string} direction
 * @param {object} memory  buildMemory() 结果
 * @param {object} [opts]  { noLlm, timeoutMs }；返回 { keywords, source, fallbackErr? }
 */
async function proposeKeywords(direction, memory = {}, opts = {}) {
  const staticPick = extractKeywords(direction, memory) || [];
  if (opts.noLlm || process.env.WORLD_NO_LLM === '1') {
    return { keywords: staticPick.slice(0, 8), source: 'static' };
  }
  try {
    const { runClaudeHeadless, extractJson } = require('../summarizer');
    const raw = await runClaudeHeadless(buildProposePrompt(direction, memory), opts.timeoutMs || 90000);
    const obj = extractJson(raw);
    const llmKws = cleanKeywords(Array.isArray(obj && obj.keywords) ? obj.keywords : []);
    if (llmKws.length) {
      // LLM 在前、确定性补尾，去重封顶 8（用户多选空间）——LLM 跑通了也不丢保底
      const seen = new Set(llmKws.map((k) => k.toLowerCase()));
      const merged = [...llmKws];
      for (const k of staticPick) {
        if (merged.length >= 8) break;
        if (!seen.has(k.toLowerCase())) merged.push(k);
      }
      return { keywords: merged.slice(0, 8), source: 'claude' };
    }
    return { keywords: staticPick.slice(0, 8), source: 'static', fallbackErr: 'LLM 输出无法解析' };
  } catch (err) {
    return { keywords: staticPick.slice(0, 8), source: 'static', fallbackErr: err.message };
  }
}

module.exports = { LEXICON, tokenizeDirection, extractKeywords, buildProposePrompt, proposeKeywords };
