// world/summarizer.js
// desktop-world · 把今日 digest 交给本地 `claude -p` 无头模式，
// 生成"一句话总结 + 3 条新思路"。不依赖网络 API key，复用本机 Claude Code 登录。
// 任何一步失败都降级为模板总结，保证每日壁纸流水线不断。
'use strict';

const { spawn } = require('child_process');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const SUMMARY_TIMEOUT_MS = 240000;

function buildPrompt(digest) {
  // 给模型的输入要尽量小且稳定：只带总结所需字段，不带原始 prompt 大段文本。
  const compact = {
    日期: digest.date,
    星期: digest.weekday,
    会话数: digest.totals.sessions,
    用户输入条数: digest.totals.prompts,
    工具调用次数: digest.totals.toolCalls,
    高频工具: digest.topTools,
    涉及项目: digest.projects,
    每小时活跃量: digest.hours,
    各助手会话数: Object.fromEntries((digest.agents || []).map((a) => [a.agent, a.sessions])),
    会话: digest.sessions.slice(0, 10).map((s) => ({
      助手: s.agent || 'claude',
      分类: s.category || null,
      项目: s.project,
      首个输入: s.title,
      状态: s.status,
      时长分钟: s.durationMin,
      工具调用: s.toolCalls,
    })),
  };
  return [
    '你是我的个人工作日报助手。下面这份 JSON 是我今天使用 AI 编程助手（Claude Code、Codex 等）在本机的活动统计。',
    '请输出：',
    '1) oneline：今日一句话总结，≤40 个汉字。要具体（带上项目名/做了什么/卡在哪），口语化，禁止"今天很努力"式空话。',
    '2) ideas：3 条"明天值得尝试的新思路"，每条 ≤30 字，必须可从数据里真实出现的内容延伸（例如反复手工做的事可以脚本化/交给 agent 的新玩法）。',
    '3) sessionBriefs：按"会话"数组的顺序，为每条会话写 ≤22 字的"干了什么"，让不在这条会话里的人一眼看懂（动词开头，例"修复托盘菜单溢出问题""续写论文实验章节"）。数组长度必须是 min(会话数, 10)，顺序一一对应；实在看不出内容就写"项目里零散探索"。',
    '4) blockers：今日卡点——从会话标题/首个输入里能看出的卡住、返工、报错、权限受阻的痕迹，最多 4 条，每条 ≤22 字，写明卡点和（若可推断）它影响的事；看不出卡点就给空数组，禁止硬编。',
    '5) techTips：今日技术总结——从今天做的事里沉淀的可复用经验/技巧（工具用法、调参结论、避坑），最多 4 条，每条 ≤26 字，要具体可操作；没有可沉淀的就给空数组。',
    '6) 若数据很少（会话数 ≤1），oneline 如实表达今天较安静，ideas 给明日规划或休息类建议。',
    '严格只输出 JSON，形如 {"oneline":"...","ideas":["..."],"sessionBriefs":["..."],"blockers":["..."],"techTips":["..."]}，不要 markdown 代码块、不要任何解释。',
    '',
    '数据：',
    JSON.stringify(compact),
  ].join('\n');
}

// 清掉 Claude Code 注入的会话环境变量，避免嵌套会话保护误伤。
function envForClaude() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) delete env[key];
  }
  return env;
}

function runClaudeHeadless(prompt, timeoutMs = SUMMARY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(CLAUDE_BIN, ['-p'], {
      env: envForClaude(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`claude -p 超时（${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`无法启动 ${CLAUDE_BIN}：${err.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) resolve(stdout.trim());
      else reject(new Error(`claude -p 退出码 ${code}：${stderr.slice(-300) || '无输出'}`));
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// 从模型输出里宽容地抠出 JSON 对象。
function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// 超长截断：优先在标点处收尾，避免切在半句话中间。
function trimSentence(text, max = 80) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastPunct = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('，'), cut.lastIndexOf('；'), cut.lastIndexOf('、'));
  return (lastPunct > max * 0.5 ? cut.slice(0, lastPunct + 1) : cut + '…');
}
// 无 LLM 时的保底总结（数据本身也是真实的）。
function fallbackSummary(digest) {
  const t = digest.totals;
  const mainProject = digest.projects[0] ? digest.projects[0].name : '几个项目';
  const oneline =
    t.sessions === 0
      ? '今天桌面很安静，没有 agent 会话记录。'
      : `今天推进了 ${t.sessions} 个会话，主战场是 ${mainProject}，共调用工具 ${t.toolCalls} 次。`;
  const ideas =
    t.sessions === 0
      ? ['给明天定一个小目标', '整理一下桌面文件吧', '试试让 agent 帮你复盘旧代码']
      : [
          '把反复手工做的事写成任务清单交给 agent',
          '给最活跃的项目跑一次代码体检',
          '把今天的成果贴进早报分享一下',
        ];
  // 卡点/技术总结没有 LLM 就不硬凑——UI 对空数组静默
  return { oneline, ideas, blockers: [], techTips: [], source: 'fallback' };
}

/**
 * @param {object} digest collector.collect() 的输出
 * @returns {Promise<{oneline:string, ideas:string[], source:string, raw?:string}>}
 */
async function summarize(digest, options = {}) {
  if (options.noLlm || process.env.WORLD_NO_LLM === '1') return fallbackSummary(digest);
  try {
    const raw = await runClaudeHeadless(buildPrompt(digest), options.timeoutMs);
    const obj = extractJson(raw);
    if (obj && typeof obj.oneline === 'string' && Array.isArray(obj.ideas)) {
      const sessionBriefs = Array.isArray(obj.sessionBriefs)
        ? obj.sessionBriefs.filter((x) => typeof x === 'string' && x.trim()).map((x) => trimSentence(x, 26)).slice(0, 10)
        : null;
      const pickList = (v, maxLen, maxN) => {
        if (!Array.isArray(v)) return undefined;
        const list = v.filter((x) => typeof x === 'string' && x.trim()).map((x) => trimSentence(x, maxLen)).slice(0, maxN);
        return list.length ? list : undefined;
      };
      return {
        oneline: trimSentence(obj.oneline),
        ideas: obj.ideas.filter((x) => typeof x === 'string').slice(0, 3),
        sessionBriefs: sessionBriefs && sessionBriefs.length ? sessionBriefs : undefined,
        blockers: pickList(obj.blockers, 26, 4), // 今日卡点（看不出就交给 UI 静默）
        techTips: pickList(obj.techTips, 30, 4), // 技术总结
        source: 'claude',
        raw,
      };
    }
    console.warn('[world] claude 输出无法解析，使用模板总结。原文尾部：', raw.slice(-200));
  } catch (err) {
    console.warn('[world] claude 总结失败，使用模板总结：', err.message);
  }
  return fallbackSummary(digest);
}

// 直接运行：node world/summarizer.js  → 采集今日 + 调 claude 总结 + 打印
if (require.main === module) {
  const { collect } = require('./collector');
  collect()
    .then((d) => summarize(d).then((s) => console.log(JSON.stringify({ digest: { totals: d.totals, projects: d.projects }, ...s }, null, 2))))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

module.exports = { summarize, buildPrompt, extractJson, fallbackSummary, runClaudeHeadless };
