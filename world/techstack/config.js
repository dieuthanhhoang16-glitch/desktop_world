// world/techstack/config.js
// desktop-world · 定向学习目标配置：用户想深入的技术方向（模糊方向 + 收敛后的具体关键词）。
// 配置存 ~/.desktop-world/techstack.json（0600）；纯 Node，无 Electron 依赖。
// 范式照 world/watch/config.js：env 覆盖路径、读坏回空、写盘 0600。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = path.join(os.homedir(), '.desktop-world');
const TECHSTACK_FILE = process.env.WORLD_TECHSTACK_FILE || path.join(CONFIG_DIR, 'techstack.json');

const MAX_GOALS = 20;
const MAX_KEYWORDS = 8; // 每个目标最多 8 个关键词
const MAX_DIRECTION_LEN = 40;
const MAX_KEYWORD_LEN = 30;
// 关键词白名单：中英文、数字、常见技术符号（C++ / node:test / .NET / #include / web-socket 都放行；
// 首字符也收 #+.，否则 .NET 会被误杀）
const KEYWORD_RE = /^[一-鿿A-Za-z0-9#+.][一-鿿A-Za-z0-9#+._\-/: ]{0,29}$/;

function validKeyword(kw) {
  const s = String(kw == null ? '' : kw).trim();
  return s.length > 0 && s.length <= MAX_KEYWORD_LEN && KEYWORD_RE.test(s) ? s : null;
}

function cleanKeywords(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const kw = validKeyword(raw);
    if (kw && !seen.has(kw.toLowerCase())) {
      seen.add(kw.toLowerCase());
      out.push(kw);
      if (out.length >= MAX_KEYWORDS) break;
    }
  }
  return out;
}

// FNV-1a 32 位哈希（与 world/garden/scene.js 同一族算法，纯本地、确定性、跨平台一致）。
// 对码点而非 UTF-16 码元取低位，中文关键词也能稳定散列（surrogate pair 会被整体跳过）。
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    const code = str.codePointAt(i);
    h = Math.imul(h ^ (code & 0xffff), 0x01000193) >>> 0;
    if (code > 0xffff) i += 1; // 代理对只取一次，避免另一半重复参与
  }
  return h >>> 0;
}

/**
 * 关键词 → 稳定 id（kw-<hash8>）。学习卡片用它做文件名，**绝不能用中文标题直接做文件名**：
 * 标题里一个标点的增删就会改掉文件名，历史卡片直接失联。改标题 = 新考点（新的 id），
 * 保留同标题的历史——这正是我们想要���语义。
 * 大小写不敏感，与 cleanKeywords 的去重口径一致（同一个词只有一个 id）。
 */
function keywordId(keyword) {
  const s = String(keyword == null ? '' : keyword).trim().toLowerCase();
  if (!s) return null;
  return `kw-${fnv1a32(s).toString(16).padStart(8, '0')}`;
}

// 关键词数组 → { keyword: id } 映射；已存在的 id 原样保留（冻结，避免将来换算法让老卡片漂移）
function keywordIds(keywords, existing) {
  const map = {};
  for (const kw of cleanKeywords(keywords)) {
    const prev = existing && existing[kw];
    map[kw] = typeof prev === 'string' && /^kw-[0-9a-f]{8}$/.test(prev) ? prev : keywordId(kw);
  }
  return map;
}

function loadTechstack(file = TECHSTACK_FILE) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const goals = Array.isArray(raw.goals) ? raw.goals : [];
    return {
      goals: goals
        .filter((g) => g && g.id && g.direction)
        .map((g) => ({
          id: String(g.id).slice(0, 40),
          direction: String(g.direction).slice(0, MAX_DIRECTION_LEN),
          keywords: cleanKeywords(g.keywords),
          // v0.7：老配置没有 kwIds，读时按现算法补齐（内存里补，不为迁移去写用户的盘）
          kwIds: keywordIds(g.keywords, g.kwIds),
          createdAt: g.createdAt || null,
        }))
        .slice(0, MAX_GOALS),
    };
  } catch {
    return { goals: [] };
  }
}

function saveTechstack(cfg, file = TECHSTACK_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, goals: cfg.goals }, null, 2), { mode: 0o600 });
}

/**
 * 落定一个学习目标。keywords 必须是"收敛对话"之后的具体词（CLI 的 --add 不带
 * --keywords 只出候选不写盘，正是为了保证这条）。关键词白名单校验，脏数据直接拒绝。
 */
function addGoal({ direction, keywords }, file = TECHSTACK_FILE) {
  const dir = String(direction || '').trim();
  if (!dir) throw new Error('缺少学习方向（--add 后面跟方向词）');
  if (dir.length > MAX_DIRECTION_LEN) throw new Error(`方向太长（${dir.length} 字，上限 ${MAX_DIRECTION_LEN}）`);
  const kws = cleanKeywords(keywords);
  if (!kws.length) {
    throw new Error(
      '没有有效关键词——先跑不带 --keywords 的 --add 看候选（结合项目记忆），确认后再带 --keywords 落盘',
    );
  }
  const cfg = loadTechstack(file);
  if (cfg.goals.some((g) => g.direction === dir)) {
    // 同方向 = 改关键词，幂等覆盖而不是堆重复目标
    const g = cfg.goals.find((g) => g.direction === dir);
    // kwIds 要跟着更新，但保留仍然存在的旧词的 id（历史卡片不搬家）
    g.kwIds = keywordIds(kws, g.kwIds);
    g.keywords = kws;
    saveTechstack(cfg, file);
    return { goals: cfg.goals, goal: g, updated: true };
  }
  if (cfg.goals.length >= MAX_GOALS) throw new Error(`目标太多（上限 ${MAX_GOALS}），先 --remove 几个`);
  const goal = {
    id: `t${Date.now().toString(36)}`,
    direction: dir,
    keywords: kws,
    kwIds: keywordIds(kws),
    createdAt: new Date().toISOString(),
  };
  cfg.goals.push(goal);
  saveTechstack(cfg, file);
  return { goals: cfg.goals, goal, updated: false };
}

function removeGoal(idOrDirection, file = TECHSTACK_FILE) {
  const cfg = loadTechstack(file);
  const before = cfg.goals.length;
  cfg.goals = cfg.goals.filter((g) => g.id !== idOrDirection && g.direction !== idOrDirection);
  if (cfg.goals.length === before) throw new Error(`没找到这个学习目标：${idOrDirection}`);
  saveTechstack(cfg, file);
  return cfg;
}

module.exports = {
  TECHSTACK_FILE,
  MAX_GOALS,
  MAX_KEYWORDS,
  MAX_DIRECTION_LEN,
  MAX_KEYWORD_LEN,
  KEYWORD_RE,
  validKeyword,
  cleanKeywords,
  keywordId,
  keywordIds,
  loadTechstack,
  saveTechstack,
  addGoal,
  removeGoal,
};
