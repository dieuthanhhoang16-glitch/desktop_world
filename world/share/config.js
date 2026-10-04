// world/share/config.js
// desktop-world · 分享渠道配置存取。
// webhook URL 即密钥：存 ~/.desktop-world/channels.json（0600），绝不进仓库。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// 可用 WORLD_CHANNELS_FILE 环境变量覆盖（本地冒烟测试 / 便携配置用）。
const DEFAULT_CONFIG_FILE =
  process.env.WORLD_CHANNELS_FILE || path.join(os.homedir(), '.desktop-world', 'channels.json');

function loadConfig(configFile = DEFAULT_CONFIG_FILE) {
  try {
    return JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(cfg, configFile = DEFAULT_CONFIG_FILE) {
  fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.chmodSync(configFile, 0o600); // 覆盖已有文件时修正权限
}

function setChannel(id, opts, configFile = DEFAULT_CONFIG_FILE) {
  const cfg = loadConfig(configFile);
  cfg[id] = { webhook: opts.webhook.trim(), ...(opts.secret ? { secret: opts.secret.trim() } : {}) };
  saveConfig(cfg, configFile);
}

function removeChannel(id, configFile = DEFAULT_CONFIG_FILE) {
  const cfg = loadConfig(configFile);
  delete cfg[id];
  saveConfig(cfg, configFile);
}

// 已配置（有 webhook）的渠道 id 列表
function configuredChannels(configFile = DEFAULT_CONFIG_FILE) {
  const cfg = loadConfig(configFile);
  return Object.entries(cfg)
    .filter(([, v]) => v && typeof v.webhook === 'string' && v.webhook.startsWith('http'))
    .map(([id]) => id);
}

// 列表展示时隐藏密钥主体，只留头尾可辨识
function maskWebhook(url) {
  return url.length <= 24 ? url.slice(0, 8) + '…' : url.slice(0, 28) + '…' + url.slice(-6);
}

module.exports = { loadConfig, saveConfig, setChannel, removeChannel, configuredChannels, maskWebhook, DEFAULT_CONFIG_FILE };
