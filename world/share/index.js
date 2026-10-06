// world/share/index.js · 分享调度：text + 图片预处理 → 各渠道插件。
'use strict';

const { loadConfig, configuredChannels } = require('./config');
const { buildShareText } = require('./text');

const channels = {
  wework: require('./channels/wework'),
  dingtalk: require('./channels/dingtalk'),
  feishu: require('./channels/feishu'),
};

const CHANNEL_IDS = Object.keys(channels);

/**
 * @param {object} opts
 * @param {object} opts.report  每日报告（daily-*.json 内容）
 * @param {string} [opts.imagePath] 早报 PNG 路径（缺省则只发文字）
 * @param {string[]} [opts.targets] 指定渠道 id 列表；缺省 = 全部已配置渠道
 * @param {(msg:string)=>void} [opts.log]
 * @returns {Promise<{ok:boolean, results:Array<{channel:string, ok:boolean, degraded?:boolean, detail:string}>}>}
 */
async function share({ report, imagePath, targets, log = () => {} }) {
  const cfg = loadConfig();
  const ids = targets && targets.length ? targets : configuredChannels();
  if (!ids.length) {
    return {
      ok: false,
      results: [],
      error: 'no-channels',
      hint: '还没配置任何渠道：node world/share/configure.js --set <wework|dingtalk|feishu> <webhookurl>',
    };
  }

  const text = buildShareText(report);
  let image = null;
  if (imagePath) {
    try {
      const { prepareShareImage } = require('./image'); // 依赖 Electron，惰性加载
      image = await prepareShareImage(imagePath);
      log(`图片预处理完成：${(image.buffer.length / 1024).toFixed(0)}KB`);
    } catch (err) {
      log(`图片预处理失败，降级为纯文字：${err.message}`);
    }
  }

  const results = [];
  for (const id of ids) {
    const ch = channels[id];
    if (!ch) {
      results.push({ channel: id, ok: false, detail: `未知渠道（支持：${CHANNEL_IDS.join('/')}）` });
      continue;
    }
    if (!cfg[id] || !cfg[id].webhook) {
      results.push({ channel: id, ok: false, detail: '未配置 webhook' });
      continue;
    }
    try {
      log(`发送到 ${ch.name}…`);
      const r = await ch.send({ cfg: cfg[id], text, image: ch.supportsImage ? image : null });
      results.push({ channel: id, degraded: !!r.degraded, ok: r.ok, detail: r.detail });
    } catch (err) {
      results.push({ channel: id, ok: false, detail: err.message });
    }
  }
  return { ok: results.some((r) => r.ok), results };
}

module.exports = { share, channels, CHANNEL_IDS };
