// world/cleanup/round2.js
// desktop-world · 清理第二轮：GLM 在一次性只读 worktree 中独立复核。
//
// 每次清理只调用 GLM 一次；worktree 用完即弃。GLM 输出 delete/keep/uncertain
// 与证据。GLM 不可用时不产生任何 delete 结论。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { git, EXCLUDE_DIRS, BUILD_DIRS } = require('./scan');
const { isSecret } = require('../learn/sources');
const { extractJson } = require('../learn/drafter');

const PURPOSE = 'cleanup-round2';
const VERDICTS = new Set(['delete', 'keep', 'uncertain']);

function copyFilter(src) {
  const base = path.basename(src);
  if (EXCLUDE_DIRS.has(base) || BUILD_DIRS.has(base)) return false;
  if (base.startsWith('.') && base !== '.scratch') return false;
  return !isSecret(src.split(path.sep).join('/'));
}

function copyFileInto(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function createDisposableWorktree(projectPath) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-cleanup-round2-'));
  const isGit = git(projectPath, ['rev-parse', '--is-inside-work-tree']) === 'true\n' && Boolean(git(projectPath, ['rev-parse', '--verify', 'HEAD']));
  let dir;
  if (isGit) {
    dir = path.join(tmp, 'worktree');
    try {
      execFileSync('git', ['-C', projectPath, 'worktree', 'add', '--detach', dir, 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000,
      });
    } catch {
      dir = path.join(tmp, 'copy');
      fs.cpSync(projectPath, dir, { recursive: true, filter: copyFilter });
    }
  } else {
    dir = path.join(tmp, 'copy');
    fs.cpSync(projectPath, dir, { recursive: true, filter: copyFilter });
  }
  return {
    dir,
    disposableRoot: tmp,
    isGit,
    remove() {
      chmodTree(dir, 0o755, 0o644);
      if (isGit) {
        try {
          execFileSync('git', ['-C', projectPath, 'worktree', 'remove', '--force', dir], { stdio: 'ignore', timeout: 30000 });
        } catch {
          // fall through to rm
        }
        try {
          execFileSync('git', ['-C', projectPath, 'worktree', 'prune'], { stdio: 'ignore', timeout: 15000 });
        } catch {
          // ignore
        }
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function chmodTree(dir, dirMode, fileMode) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) {
        chmodTree(p, dirMode, fileMode);
        fs.chmodSync(p, dirMode);
      } else {
        fs.chmodSync(p, fileMode);
      }
    } catch {
      // best effort
    }
  }
  try {
    fs.chmodSync(dir, dirMode);
  } catch {
    // ignore
  }
}

function buildPrompt({ projectName, candidates }) {
  const rows = candidates.map((c, i) => {
    const evidence = (c.evidenceLines || []).join('；');
    return `[${i + 1}] path=${c.path} category=${c.category} tracked=${c.tracked ? 'yes' : 'no'} evidence=${evidence}`;
  });
  return `你是清理复核员。当前目录是项目 ${projectName} 的一次性只读副本，禁止修改任何文件、禁止联网。
请用 rg（或 grep）搜索引用、用 git log/ls-files 查看历史，对下列每个候选独立取证，判断是否应删除：
${rows.join('\n')}

判断标准：删除必须同时满足"无有效引用、无近期维护价值、信息可在别处恢复或已过时"。
拿不准时输出 uncertain，不要为了清理而删除。路径必须与输入完全一致。
只输出一个 JSON 数组，不要 Markdown 围栏、不要解释。每项：
{"path":"相对路径","verdict":"delete|keep|uncertain","evidence":"一句话证据，含具体搜索结果或 git 事实"}`;
}

function normalizeVerdicts(list, candidates) {
  const byPath = new Map();
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item.path !== 'string') continue;
    const verdict = VERDICTS.has(String(item.verdict)) ? String(item.verdict) : 'uncertain';
    byPath.set(item.path, {
      path: item.path,
      verdict,
      evidence: String(item.evidence || (verdict === 'uncertain' ? 'GLM 未给出有效结论' : '')).slice(0, 500),
    });
  }
  return candidates.map((c) => byPath.get(c.path) || {
    path: c.path,
    verdict: 'uncertain',
    evidence: 'GLM 未返回该文件的结论',
  });
}

function spawnGlmRunner({ worktree, prompt, model = 'jd-glm53', timeoutMs = 180000, env = process.env }) {
  const result = spawnSync('pi', ['-p', prompt, '--model', model], {
    cwd: worktree,
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
  if (result.error) throw new Error(`GLM 不可用：${result.error.code || result.error.message}`);
  if (result.status !== 0) throw new Error(`GLM 退出码 ${result.status}：${String(result.stderr || '').slice(-300)}`);
  return result.stdout;
}

/**
 * @param {object} opts
 * @param {string} opts.projectPath
 * @param {Array} opts.candidates 第一轮候选（全部，含 JEV 保留项）
 * @param {Function} [opts.runner] 注入的 GLM 调用，返回 stdout 字符串
 */
async function runRound2({ projectPath, candidates, runner, now = () => new Date(), model = 'jd-glm53', timeoutMs } = {}) {
  const project = path.resolve(String(projectPath || ''));
  const at = now();
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) {
    return { ok: true, verdicts: [], model: null, calls: 1, worktreeRemoved: true, at: at.toISOString() };
  }
  const worktree = createDisposableWorktree(project);
  let payload;
  try {
    // 未跟踪候选不会出现在 HEAD worktree 里，复制过去供复核
    for (const c of list) {
      if (c.tracked) continue;
      const src = path.join(project, c.path);
      const dest = path.join(worktree.dir, c.path);
      if (fs.existsSync(src) && !fs.existsSync(dest)) copyFileInto(src, dest);
    }
    chmodTree(worktree.dir, 0o555, 0o444);

    const prompt = buildPrompt({ projectName: path.basename(project), candidates: list });
    const call = runner || spawnGlmRunner;
    const stdout = await call({ worktree: worktree.dir, prompt, model, timeoutMs });
    const verdicts = normalizeVerdicts(extractJson(stdout), list);
    payload = { ok: true, verdicts, model, calls: 1, worktreeRemoved: false, at: at.toISOString() };
  } catch (error) {
    payload = {
      ok: false,
      reason: 'glm-unavailable',
      error: String((error && error.message) || error),
      verdicts: list.map((c) => ({ path: c.path, verdict: 'uncertain', evidence: 'GLM 复核不可用' })),
      model,
      calls: 1,
      worktreeRemoved: false,
      at: at.toISOString(),
    };
  } finally {
    worktree.remove();
    payload.worktreeRemoved = !fs.existsSync(worktree.disposableRoot);
  }
  return payload;
}

module.exports = {
  PURPOSE,
  VERDICTS,
  buildPrompt,
  normalizeVerdicts,
  createDisposableWorktree,
  chmodTree,
  runRound2,
};
