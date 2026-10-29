// world/projects/setup-runner.js
// desktop-world · 默认的干净会话 runner：在项目里跑 /setup-matt-pocock-skills。
//
// 隔离方式与角色启动器一致：独立 CLAUDE_CONFIG_DIR（空目录），不继承用户级
// skills/plugins/memory。只暴露项目目录，不传任何模型密钥（凭据由本机
// cc-switch 的 jd 通道负责，env 白名单只保留 PATH/HOME）。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SETUP_PROMPT = [
  '你在一个项目根目录中，只做一件事：运行 /setup-matt-pocock-skills。',
  '硬约束：',
  '1. 只创建缺失的标准文件（docs/agents/、GLOSSARY.md、AGENTS.md 里的 "## Agent skills" 块等）。',
  '2. 已存在的文件只读，绝对不要覆盖或重写；需要追加块时也不得改动原有内容。',
  '3. 不读取 .env、密钥、凭据文件。',
  '4. 完成后停下，不要执行其他任务。',
].join('\n');

function emptyConfigDir(base) {
  const dir = fs.mkdtempSync(path.join(base || os.tmpdir(), 'dw-setup-cfg-'));
  for (const name of ['claude', 'codex', 'pi', 'xdg']) fs.mkdirSync(path.join(dir, name), { recursive: true });
  return path.join(dir, 'claude');
}

/**
 * @returns {{status:number, stdout:string, stderr:string, error?:{code:string}}}
 */
function runSetupSkill({ projectPath, env = process.env, spawn = spawnSync, configBaseDir } = {}) {
  const cwd = path.resolve(String(projectPath || ''));
  if (!fs.existsSync(cwd)) return { status: 1, stdout: '', stderr: `项目不存在：${cwd}`, error: { code: 'ENOENT' } };
  const configDir = emptyConfigDir(configBaseDir);
  const fence = {
    PATH: env.PATH || '',
    HOME: env.HOME || os.homedir(),
    CLAUDE_CONFIG_DIR: configDir,
    XDG_CONFIG_HOME: path.join(path.dirname(configDir), 'xdg'),
    WORLD_ROLE: 'setup',
    TERM: env.TERM || 'dumb',
  };
  const args = ['-p', SETUP_PROMPT, '--model', env.WORLD_SETUP_MODEL || 'jd-ds'];
  const result = spawn(env.WORLD_SETUP_COMMAND || 'claude', args, {
    cwd,
    env: fence,
    encoding: 'utf8',
    timeout: Number(env.WORLD_SETUP_TIMEOUT_MS || 10 * 60 * 1000),
  });
  if (result && result.error && result.error.code === 'ENOENT') {
    return { status: 127, stdout: '', stderr: 'claude 不可用', error: { code: 'ENOENT' } };
  }
  return {
    status: typeof result.status === 'number' ? result.status : 1,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

module.exports = { SETUP_PROMPT, runSetupSkill, emptyConfigDir };
