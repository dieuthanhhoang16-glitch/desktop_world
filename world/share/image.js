// world/share/image.js · 分享用图片预处理：缩放 + 压缩到渠道限制内（仅 Electron 内可用）。
// 渠道限制参考：企业微信图片消息 ≤2MB（base64 编码前）。
'use strict';

const crypto = require('crypto');
const { nativeImage } = require('electron');

/**
 * @param {string} pngPath 壁纸原图（视网膜分辨率，通常 5-10MB）
 * @returns {Promise<{buffer:Buffer, base64:string, md5:string, contentType:string}>}
 */
async function prepareShareImage(pngPath, { maxWidth = 1280, maxBytes = 1500 * 1024 } = {}) {
  let img = nativeImage.createFromPath(pngPath);
  if (img.isEmpty()) throw new Error(`无法读取图片：${pngPath}`);
  const origSize = img.getSize();
  if (origSize.width > maxWidth) img = img.resize({ width: maxWidth });

  let quality = 82;
  let buf = img.toJPEG(quality);
  while (buf.length > maxBytes && quality > 45) {
    quality -= 10;
    buf = img.toJPEG(quality);
  }
  if (buf.length > maxBytes) {
    img = img.resize({ width: 960 });
    buf = img.toJPEG(70);
  }

  return {
    buffer: buf,
    base64: buf.toString('base64'),
    md5: crypto.createHash('md5').update(buf).digest('hex'),
    contentType: 'image/jpeg',
  };
}

module.exports = { prepareShareImage };
