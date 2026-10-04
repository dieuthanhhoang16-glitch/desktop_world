// world/share/channels/wework.js · 企业微信群机器人
// webhook 形如 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=XXX
// 支持 markdown 文字 + base64 图片直发（渠道里发图最简单的一个）。
'use strict';

const { postJson } = require('../http');

function checkResp(resp) {
  // 企微错误码：errcode 0 = 成功
  if (resp.json && resp.json.errcode === 0) return null;
  return (resp.json && `${resp.json.errcode}: ${resp.json.errmsg}`) || `HTTP ${resp.status}`;
}

module.exports = {
  id: 'wework',
  name: '企业微信',
  supportsImage: true,

  /**
   * @param {object} ctx { cfg:{webhook}, text:{title,markdown}, image? }
   * @returns {Promise<{ok:boolean, degraded?:boolean, detail:string}>}
   */
  async send({ cfg, text, image }) {
    const textErr = checkResp(
      await postJson(cfg.webhook, { msgtype: 'markdown', markdown: { content: text.markdown } })
    );
    if (textErr) return { ok: false, detail: `文字发送失败（${textErr}）` };
    if (!image) return { ok: true, detail: '已发送文字' };

    const imgErr = checkResp(
      await postJson(cfg.webhook, { msgtype: 'image', image: { base64: image.base64, md5: image.md5 } })
    );
    return imgErr
      ? { ok: true, degraded: true, detail: `文字已发，图片失败（${imgErr}）` }
      : { ok: true, detail: '已发送文字+图片' };
  },
};
