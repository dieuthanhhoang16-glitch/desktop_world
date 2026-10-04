// world/share 模块单测：配置存取、文案拼装、渠道签名（纯 Node，不发网络请求）。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, setChannel, removeChannel, configuredChannels, maskWebhook } = require('../world/share/config');
const { buildShareText } = require('../world/share/text');
const dingtalk = require('../world/share/channels/dingtalk');
const feishu = require('../world/share/channels/feishu');

function tmpConfig(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-share-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'channels.json');
}

const SAMPLE_REPORT = {
  meta: { date: '2026-10-05', weekday: '周一' },
  digest: {
    totals: { sessions: 5, prompts: 7, toolCalls: 130 },
    topTools: [{ name: 'Bash', count: 50 }, { name: 'Write', count: 17 }],
  },
  oneline: '深夜连肝 co-agent-paper 两轮改动',
  ideas: ['固化脚本', '生成对比表', '先定 MVP'],
  source: 'claude',
};

test('config：配置写读删闭环，落盘权限 0600', (t) => {
  const file = tmpConfig(t);
  setChannel('wework', { webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc123' }, file);
  setChannel('dingtalk', { webhook: 'https://oapi.dingtalk.com/robot/send?access_token=tok', secret: 'SECxx' }, file);

  const cfg = loadConfig(file);
  assert.equal(cfg.wework.webhook.includes('key=abc123'), true);
  assert.equal(cfg.dingtalk.secret, 'SECxx');
  assert.equal((fs.statSync(file).mode & 0o777), 0o600);
  assert.deepEqual(configuredChannels(file).sort(), ['dingtalk', 'wework']);

  removeChannel('wework', file);
  assert.deepEqual(configuredChannels(file), ['dingtalk']);
});

test('config：maskWebhook 藏住密钥主体', () => {
  const masked = maskWebhook('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef1234567890');
  assert.equal(masked.includes('abcdef1234567890'), false);
  assert.equal(masked.startsWith('https://qyapi.weixin.qq.com/'), true);
});

test('text：分享文案包含日报关键词、一句话、统计与编号新思路', () => {
  const { title, markdown } = buildShareText(SAMPLE_REPORT);
  assert.match(title, /日报/); // 钉钉/飞书关键词校验依赖这两个字
  assert.match(title, /10月5日/);
  assert.match(markdown, /深夜连肝 co-agent-paper/);
  assert.match(markdown, /1\. 固化脚本/);
  assert.match(markdown, /会话 5/);
  assert.match(markdown, /Bash×50/);
});

test('dingtalk：加签 URL 附带 timestamp 与 urlencode 后的 sign', () => {
  const url = dingtalk.signedUrl('https://oapi.dingtalk.com/robot/send?access_token=tok', 'SECxxx');
  assert.match(url, /[?&]timestamp=\d+/);
  assert.match(url, /[?&]sign=[^&]+/);
  // 无 secret 不加签
  assert.equal(dingtalk.signedUrl('https://x', ''), 'https://x');
});

test('feishu：签名为 base64，无 secret 返回 undefined', () => {
  const sign = feishu.makeSign('1728000000', 'mysecret');
  assert.match(sign, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(feishu.makeSign('1728000000', ''), undefined);
});

test('渠道元信息：图片支持与文档声明一致', () => {
  assert.equal(dingtalk.supportsImage, true);
  assert.equal(feishu.supportsImage, false); // 自定义机器人无 image_key，见渠道文件注释
});
