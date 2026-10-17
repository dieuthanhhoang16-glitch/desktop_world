#!/usr/bin/env node
// world/roles/runners/glm-fixture.js · 确定性 glm 桩。
//
// 它是 ticket 01 的 "fixture 任务" 执行者：收到简报后，在 worktree 里写
// HELLO.txt，把会话记录写到 session-dir 里，退出码 0。
//
// 为什么不用真 glm？ticket 01 的验收只看启动器的隔离与回执契约，不看模型输出。
// 调真模型会让测试慢/脆/费钱；runner 借用 env 接口，未来换真 glm 时
// launcher 与本桩的协议不变。
'use strict';

const fs = require('fs');
const path = require('path');

function must(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[glm-fixture] 缺环境变量 ${name}`);
    process.exit(2);
  }
  return v;
}

const WORKTREE = must('WORLD_WORKTREE');
const SESSION_DIR = must('WORLD_SESSION_DIR');
const BRIEF = must('WORLD_BRIEF_PATH');
const RUN_ID = must('WORLD_RUN_ID');
const MODEL = must('WORLD_MODEL');
const ROLE = must('WORLD_ROLE');

if (ROLE !== 'glm') {
  console.error(`[glm-fixture] 期望 WORLD_ROLE=glm，实际 ${ROLE}`);
  process.exit(2);
}

// 只碰 worktree 与 session-dir。任何向 worktree 之外的写入都是越权。
const firstLine = fs.readFileSync(BRIEF, 'utf8').split('\n', 1)[0].replace(/^#+\s*/, '').trim() || '(empty brief)';
const hello = `hello from ${ROLE} (${MODEL}) @ run ${RUN_ID}\n任务: ${firstLine}\n`;
fs.writeFileSync(path.join(WORKTREE, 'HELLO.txt'), hello, 'utf8');

// 会话目录占个位：以后真 glm 把对话 / tool 日志写在这
fs.writeFileSync(
  path.join(SESSION_DIR, 'transcript.md'),
  `# session ${RUN_ID}\n\n- role: ${ROLE}\n- model: ${MODEL}\n- brief: ${firstLine}\n`,
  'utf8',
);

// 留一份环境目击清单，让 launcher 的"env 白名单"有测试钩子：
// 测试在父进程注入 canary env var，再断言它没有出现在这个清单里。
const envWitness = {
  keys: Object.keys(process.env).sort(),
  worldVars: Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k.startsWith('WORLD_')),
  ),
};
fs.writeFileSync(path.join(SESSION_DIR, 'env-witness.json'), JSON.stringify(envWitness, null, 2) + '\n', 'utf8');

console.log(`[glm-fixture] wrote HELLO.txt and session/transcript.md (run=${RUN_ID})`);
process.exit(0);
