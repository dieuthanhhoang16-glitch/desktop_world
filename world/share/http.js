// world/share/http.js · 极简 HTTP 助手（Node 18+ 内置 fetch，无第三方依赖）。
'use strict';

async function postJson(url, body, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 保留原文 */
    }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

async function postMultipart(url, fields, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      form.append(k, v);
    }
    const res = await fetch(url, { method: 'POST', body: form, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 保留原文 */
    }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { postJson, postMultipart };
