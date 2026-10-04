// world/share/configure.js · 渠道配置命令行（纯 Node）。
//
//   node world/share/configure.js --list
//   node world/share/configure.js --set wework "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=XXX"
//   node world/share/configure.js --set dingtalk "https://oapi.dingtalk.com/robot/send?access_token=XXX" --secret SECxxx
//   node world/share/configure.js --set feishu "https://open.feishu.cn/open-apis/bot/v2/hook/XXX" --secret xxx
//   node world/share/configure.js --remove feishu
//
// 配置文件：~/.desktop-world/channels.json（0600，webhook 即密钥，勿外泄）
'use strict';

const { loadConfig, setChannel, removeChannel, maskWebhook, DEFAULT_CONFIG_FILE } = require('./config');
const { CHANNEL_IDS } = require('./index');

const args = process.argv.slice(2);

function usage() {
  console.log(`用法：
  --list                          查看已配置渠道
  --set <渠道> <webhook> [--secret <签名密钥>]   配置渠道（渠道：${CHANNEL_IDS.join(' / ')}）
  --remove <渠道>                 移除渠道
配置文件：${DEFAULT_CONFIG_FILE}`);
}

function main() {
  if (args.includes('--list') || args.length === 0) {
    const cfg = loadConfig();
    const entries = Object.entries(cfg);
    if (!entries.length) {
      console.log('尚未配置任何渠道。');
      return usage();
    }
    for (const [id, v] of entries) {
      console.log(`${id}\n  webhook: ${maskWebhook(v.webhook || '')}${v.secret ? '\n  secret: 已设置（不显示）' : ''}`);
    }
    return;
  }

  const setIdx = args.indexOf('--set');
  const rmIdx = args.indexOf('--remove');
  if (setIdx !== -1) {
    const id = args[setIdx + 1];
    const webhook = args[setIdx + 2];
    const secretIdx = args.indexOf('--secret');
    const secret = secretIdx !== -1 ? args[secretIdx + 1] : '';
    if (!CHANNEL_IDS.includes(id) || !webhook || !webhook.startsWith('http')) {
      console.error('参数不对：--set <渠道> <http(s) webhook>');
      process.exitCode = 1;
      return usage();
    }
    setChannel(id, { webhook, secret });
    console.log(`✅ 已配置 ${id}（webhook ${maskWebhook(webhook)}${secret ? '，含签名密钥' : ''}）`);
    return;
  }
  if (rmIdx !== -1) {
    removeChannel(args[rmIdx + 1]);
    console.log(`✅ 已移除 ${args[rmIdx + 1]}`);
    return;
  }
  usage();
}

main();
