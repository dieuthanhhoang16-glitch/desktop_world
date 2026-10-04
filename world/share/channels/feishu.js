// world/share/channels/feishu.js · 飞书自定义机器人
// webhook 形如 https://open.feishu.cn/open-apis/bot/v2/hook/XXX
// 支持"签名校验"（secret）与"关键词"安全设置（文案标题已含"日报"二字）。
// 自定义机器人发图片需要自建应用的 image_key（要先有 tenant_access_token），
// v0.2 只发富文本富文本；图片支持待 v0.2.x 评估是否要引入自建应用。
'use strict';

const crypto = require('crypto');
const { postJson } = require('../http');

// 飞书签名：以 "timestamp\nsecret" 为 key，对空串做 HMAC-SHA256，base64 输出
function makeSign(timestamp, secret) {
  if (!secret) return undefined;
  return crypto.createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
}

function checkResp(resp) {
  const obj = resp.json || {};
  if (obj.code === 0 || obj.StatusCode === 0) return null;
  return (obj.code !== undefined && `${obj.code}: ${obj.msg || obj.StatusMessage}`) || `HTTP ${resp.status}`;
}

module.exports = {
  id: 'feishu',
  name: '飞书',
  supportsImage: false, // 图片需自建应用 image_key，见文件头注释
  makeSign,

  async send({ cfg, text, image }) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sign = makeSign(timestamp, cfg.secret);
    // 每一行一个段落；富文本 text 节点天然支持换行排版 & 中文
    const content = text.lines.map((line) => [{ tag: 'text', text: line }]);
    const resp = await postJson(cfg.webhook, {
      timestamp,
      ...(sign ? { sign } : {}),
      msg_type: 'post',
      content: { post: { zh_cn: { title: text.title, content } } },
    });
    const err = checkResp(resp);
    if (err) return { ok: false, detail: `发送失败（${err}）` };
    return image
      ? { ok: true, degraded: true, detail: '已发送文字；自定义机器人暂不支持图片（需自建应用 image_key）' }
      : { ok: true, detail: '已发送文字' };
  },
};
