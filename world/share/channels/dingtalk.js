// world/share/channels/dingtalk.js · 钉钉自定义机器人
// webhook 形如 https://oapi.dingtalk.com/robot/send?access_token=XXX
// 安全设置支持"加签"（secret）与"关键词"（文案标题已含"日报"二字）。
// 图片走 media/upload 换 media_id；该接口对部分自定义机器人不开放，
// 失败时自动降级为纯文字并在 detail 里说明 —— 不影响主流程。
'use strict';

const crypto = require('crypto');
const { postJson, postMultipart } = require('../http');

// 加签：timestamp + "\n" + secret → HMAC-SHA256 → base64 → urlencode
function signedUrl(webhook, secret) {
  if (!secret) return webhook;
  const ts = Date.now();
  const sign = crypto
    .createHmac('sha256', secret)
    .update(`${ts}\n${secret}`)
    .digest('base64');
  const sep = webhook.includes('?') ? '&' : '?';
  return `${webhook}${sep}timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
}

function checkResp(resp) {
  if (resp.json && resp.json.errcode === 0) return null;
  return (resp.json && `${resp.json.errcode}: ${resp.json.errmsg}`) || `HTTP ${resp.status}`;
}

async function uploadMedia(cfg, image) {
  const tokenMatch = /[?&]access_token=([^&]+)/.exec(cfg.webhook);
  if (!tokenMatch) throw new Error('webhook 里没有 access_token');
  const resp = await postMultipart(
    `https://oapi.dingtalk.com/media/upload?access_token=${tokenMatch[1]}`,
    { type: 'image', media: new Blob([image.buffer], { type: image.contentType }) }
  );
  const mediaId = resp.json && (resp.json.media_id || resp.json.media_id_string);
  if (!mediaId) {
    throw new Error((resp.json && `${resp.json.errcode}: ${resp.json.errmsg}`) || `HTTP ${resp.status}`);
  }
  return mediaId;
}

module.exports = {
  id: 'dingtalk',
  name: '钉钉',
  supportsImage: true,
  signedUrl,

  async send({ cfg, text, image }) {
    const url = signedUrl(cfg.webhook, cfg.secret);
    const textErr = checkResp(
      await postJson(url, {
        msgtype: 'markdown',
        markdown: { title: text.title, text: text.markdown },
      })
    );
    if (textErr) return { ok: false, detail: `文字发送失败（${textErr}）` };
    if (!image) return { ok: true, detail: '已发送文字' };

    try {
      const mediaId = await uploadMedia(cfg, image);
      const imgErr = checkResp(await postJson(url, { msgtype: 'image', image: { media_id: mediaId } }));
      if (imgErr) throw new Error(imgErr);
      return { ok: true, detail: '已发送文字+图片' };
    } catch (err) {
      return {
        ok: true,
        degraded: true,
        detail: `文字已发；图片降级（${err.message}）。钉钉自定义机器人发图能力受限，可改用企业微信渠道`,
      };
    }
  },
};
