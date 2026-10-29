// world/learn/drafter.js
// desktop-world · GLM 起草 + JEV 命名裁决的默认真实实现（可注入替身）。
//
// GLM 只负责措辞；主题合法性、id、去重、写入仍由本地逻辑控制。
// 起草结果必须是 JSON 数组；解析失败直接抛错，让 generateCards 走
// drafter-failed（保留已有卡片，不产生半成品）。
'use strict';

const { spawnSync } = require('child_process');

const DRAFT_PROMPT_HEAD = `你在为项目文档生成学习卡。只输出一个 JSON 数组，不要 Markdown 代码围栏，不要解释。
每项字段：sourcePath, anchor, topic, summary, points, chars。
硬约束：
- topic 必须是「名词 动词」两段中文，用单个空格分隔（例：工单 拆分）。
- summary 一句话，不超过 80 字，不得复制原文长段。
- points 是 3–5 条字符串，每条以「学什么：」「为什么：」「怎么练：」之一开头。
- 每个来源最多 3 张卡；不确定时少而准，不要编造来源中不存在的概念。`;

function excerpt(source, max = 1400) {
  return String(source.body || '')
    .replace(/\s+/g, ' ')
    .slice(0, max);
}

function buildPrompt({ projectName, sources }) {
  const blocks = sources.slice(0, 20).map((s, i) => {
    return `[${i + 1}] path=${s.path} kind=${s.kind} title=${s.title}\n${excerpt(s)}`;
  });
  return `${DRAFT_PROMPT_HEAD}\n\n项目：${projectName}\n\n来源：\n${blocks.join('\n\n')}`;
}

function extractJson(text) {
  const s = String(text || '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('GLM 输出中没有 JSON 数组');
  return JSON.parse(body.slice(start, end + 1));
}

/**
 * @returns {Function} async ({projectPath, sources, projectName}) => drafts[]
 */
function createGlmDrafter({ spawn = spawnSync, command = 'pi', model = 'jd-glm53', timeoutMs = 180000, env = process.env, parse = extractJson } = {}) {
  return async function drafter({ projectPath, sources, projectName }) {
    const prompt = buildPrompt({ projectName, sources });
    const result = spawn(command, ['-p', prompt, '--model', model], {
      cwd: projectPath,
      encoding: 'utf8',
      timeout: timeoutMs,
      env: {
        PATH: env.PATH || '',
        HOME: env.HOME || '',
        TERM: env.TERM || 'dumb',
        WORLD_ROLE: 'glm',
        HTTP_PROXY: 'http://127.0.0.1:9',
        HTTPS_PROXY: 'http://127.0.0.1:9',
        ALL_PROXY: 'http://127.0.0.1:9',
      },
    });
    if (result && result.error) throw new Error(`GLM 不可用：${result.error.code || result.error.message}`);
    if (result.status !== 0) throw new Error(`GLM 退出码 ${result.status}：${String(result.stderr || '').slice(-300)}`);
    const list = parse(result.stdout);
    if (!Array.isArray(list)) throw new Error('GLM 未返回数组');
    return list.map((d) => ({ ...d, draftedBy: model }));
  };
}

/** JEV 命名裁决的默认真实实现（未启用/无密钥时 decide 会返回 ok:false，自动退化）。 */
function createJevDecider({ settings = { orchJevEnabled: true }, env = process.env } = {}) {
  const { createClient } = require('../orch/llm');
  const client = createClient({ settings, env });
  return (req) => client.decide(req);
}

module.exports = { buildPrompt, extractJson, createGlmDrafter, createJevDecider };
