'use strict';
// 探测链：URL → Item 草稿。不写文件、不发事件。

const engines = require('./engines');
const config = require('./config');
const { normalizeUrl, siteOf, createItem } = require('./models');

const cache = new Map();          // url -> { item, at }
const CACHE_TTL = 10 * 60 * 1000;

function diagnose(url, failures) {
  const joined = failures.join(' | ');
  if (/drm/i.test(joined)) return { ok: false, reason: '该视频受 DRM 保护，无法下载', hint: '只能录屏' };
  if (/抖音|douyin/i.test(url)) return { ok: false, reason: '抖音需要额外签名，当前不支持', hint: '可尝试浏览器嗅探' };
  if (/Unsupported URL/i.test(joined)) return { ok: false, reason: '没有引擎认得这个链接', hint: '可能是需要登录或动态加载的页面' };
  return { ok: false, reason: '所有引擎都无法解析这个链接', hint: joined.slice(0, 200) };
}

async function resolve(rawUrl, ctx = {}) {
  const url = normalizeUrl(rawUrl);
  if (!url) return { ok: false, reason: '空链接' };
  if (!/^https?:/i.test(url)) return { ok: false, reason: '不是 http(s) 链接' };

  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL) return { ok: true, item: hit.item, cached: true };

  const probeCtx = {
    probeTimeout: config.get().probeTimeoutMs,
    registerChild: ctx.registerChild,
    unregisterChild: ctx.unregisterChild,
  };

  let result;
  try {
    result = await engines.probe(url, probeCtx);
  } catch (err) {
    return {
      ok: false,
      reason: err.message || '解析失败',
      hint: err.kind === 'drm' ? '只能录屏'
        : err.kind === 'auth' ? '需要登录 cookie：cookies/twitter.txt'
        : '',
    };
  }

  if (!result.item) {
    const d = diagnose(url, result.failures);
    console.log(`[resolve] 失败 ${url} → ${d.reason} | ${result.failures.join(' | ')}`);
    return d;
  }

  const item = result.item;
  item.status = 'resolved';
  cache.set(url, { item, at: Date.now() });
  return { ok: true, item };
}

// 同一批链接批量解析，保留顺序和错误
async function resolveMany(urls, ctx = {}) {
  const out = [];
  for (const u of urls) {
    const r = await resolve(u, ctx);
    out.push({ url: u, ...r });
  }
  return out;
}

// 并发解析（默认 3 路），避免 20 条链接排几分钟
async function resolveBatch(urls, limit = 3, ctx = {}) {
  const out = new Array(urls.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, urls.length) }, async () => {
    while (i < urls.length) {
      const idx = i++;
      const u = urls[idx];
      try {
        out[idx] = { url: u, ...(await resolve(u, ctx)) };
      } catch (e) {
        out[idx] = { url: u, ok: false, reason: String(e.message || e) };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

function clearCache() { cache.clear(); }

module.exports = { resolve, resolveMany, resolveBatch, clearCache, siteOf, createItem };
