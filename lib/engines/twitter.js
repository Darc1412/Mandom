'use strict';
// X / Twitter 专用引擎。
// 用公开的 syndication 接口取推文的媒体地址，不需要登录，也不需要 yt-dlp。
// 拿不到（需要登录、已删除、纯文字）时返回 null，交给 yt-dlp 兜底。

const https = require('https');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const hls = require('../hls');
const { createItem, siteOf, normalizeUrl } = require('../models');

function tweetId(url) {
  const m = String(url).match(
    /(?:x|twitter)\.com\/(?:[^/?#]+\/status|i\/status|i\/web\/status)\/(\d+)/i,
  );
  return m ? m[1] : null;
}

function syndToken(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

// 读取 cookies/twitter.txt，支持两种格式：
//   1. Cookie-Editor 导出的 JSON 数组
//   2. Netscape cookies.txt（tab 分隔）
// 只取 x.com / twitter.com 的条目。
function loadCookies() {
  const file = path.join(config.COOKIES, 'twitter.txt');
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return '';

    if (raw.startsWith('[') || raw.startsWith('{')) {
      let items;
      try {
        const parsed = JSON.parse(raw);
        items = Array.isArray(parsed) ? parsed : (parsed.cookies || []);
      } catch {
        items = null;
      }
      if (Array.isArray(items)) {
        return items
          .filter((c) => c && c.name && c.value !== undefined
            && /(^|\.)(x|twitter)\.com$/i.test(String(c.domain || '')))
          .map((c) => `${c.name}=${c.value}`)
          .join('; ');
      }
    }

    const pairs = [];
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const parts = t.split('\t');
      if (parts.length < 7) continue;
      if (!/(^|\.)(x|twitter)\.com$/i.test(parts[0])) continue;
      pairs.push(`${parts[5]}=${parts[6]}`);
    }
    return pairs.join('; ');
  } catch {
    return '';
  }
}

// 供前端/诊断使用
function cookieStatus() {
  const file = path.join(config.COOKIES, 'twitter.txt');
  try {
    const st = fs.statSync(file);
    const raw = fs.readFileSync(file, 'utf8');
    const header = loadCookies();
    return {
      exists: true,
      bytes: st.size,
      mtime: st.mtime.toISOString(),
      count: header ? header.split('; ').filter(Boolean).length : 0,
      hasAuth: /\bauth_token=/.test(header),
    };
  } catch {
    return { exists: false, bytes: 0, count: 0, hasAuth: false };
  }
}

const COOKIE_FILE = () => path.join(config.COOKIES, 'twitter.txt');
const YTDLP_COOKIE_FILE = () => path.join(config.COOKIES, '_x_for_ytdlp.txt');

function countXCookies(text) {
  if (!text) return { ok: false, count: 0 };
  const t = text.trim();
  if (t.startsWith('[') || t.startsWith('{')) {
    try {
      const parsed = JSON.parse(t);
      const items = Array.isArray(parsed) ? parsed : (parsed.cookies || []);
      const xs = items.filter((c) => c && c.name
        && /(^|\.)(x|twitter)\.com$/i.test(String(c.domain || '')));
      return { ok: xs.some((c) => c.name === 'auth_token'), count: xs.length };
    } catch {
      return { ok: false, count: 0, parseError: true };
    }
  }
  const lines = t.split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  const xs = lines.filter((l) => {
    const p = l.split('\t');
    return p.length >= 7 && /(^|\.)(x|twitter)\.com$/i.test(p[0]);
  });
  return { ok: xs.some((l) => l.split('\t')[5] === 'auth_token'), count: xs.length };
}

function saveCookies(raw) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, error: '内容为空' };
  const check = countXCookies(text);
  if (check.parseError) return { ok: false, error: 'JSON 解析失败，检查一下复制完整没有' };
  if (!check.count) return { ok: false, error: '里面没有 x.com 的 cookie' };
  if (!check.ok) return { ok: false, error: '缺少 auth_token，确认是在 x.com 页面导出的' };
  fs.mkdirSync(config.COOKIES, { recursive: true });
  fs.writeFileSync(COOKIE_FILE(), text, 'utf8');
  try { fs.unlinkSync(YTDLP_COOKIE_FILE()); } catch { /* 下次自动重建 */ }
  return { ok: true, count: check.count, status: cookieStatus() };
}

function clearCookies() {
  try { fs.unlinkSync(COOKIE_FILE()); } catch { /* ignore */ }
  try { fs.unlinkSync(YTDLP_COOKIE_FILE()); } catch { /* ignore */ }
  return { ok: true, status: cookieStatus() };
}

const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

async function testCookies() {
  const header = loadCookies();
  if (!header) return { valid: false, reason: '没有配置 cookie' };
  const ct0 = (header.match(/(?:^|;\s*)ct0=([^;]+)/) || [])[1] || '';
  if (!ct0) return { valid: false, reason: 'cookie 里缺 ct0' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch('https://x.com/i/api/1.1/dm/inbox_initial_state.json?include_conversation_info=false', {
      headers: {
        'Cookie': header,
        'Authorization': 'Bearer ' + BEARER,
        'x-csrf-token': ct0,
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes',
        'x-twitter-client-language': 'en',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    try { if (res.body && res.body.cancel) res.body.cancel(); } catch { /* ignore */ }
    if (res.status === 200) {
      const twid = (header.match(/(?:^|;\s*)twid=u%3D(\d+)/) || [])[1] || '';
      return { valid: true, userId: twid, checkedAt: new Date().toISOString() };
    }
    if (res.status === 401 || res.status === 403) {
      return { valid: false, reason: `cookie 已失效（HTTP ${res.status}），重新导出一份` };
    }
    return { valid: false, reason: `检测失败（HTTP ${res.status}）` };
  } catch (e) {
    clearTimeout(timer);
    return { valid: false, reason: '网络错误：' + (e.message || e) };
  }
}

async function fetchJson(url, timeout = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const cookie = loadCookies();
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text || text[0] !== '{') return null;
    return JSON.parse(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function pickBest(videos) {
  let mp4 = null;
  let m3u8 = null;
  for (const v of videos) {
    const info = v.video_info || {};
    for (const variant of info.variants || []) {
      const ct = String(variant.content_type || '');
      const url = variant.url || '';
      if (!url) continue;
      if (ct === 'video/mp4') {
        if (!mp4 || (variant.bitrate || 0) > (mp4.bitrate || 0)) mp4 = { ...variant, kind: 'mp4' };
      } else if (/mpegurl|m3u8/i.test(ct) || /\.m3u8/i.test(url)) {
        if (!m3u8 || (variant.bitrate || 0) > (m3u8.bitrate || 0)) m3u8 = { ...variant, kind: 'hls' };
      }
    }
    if (!mp4 && !m3u8 && info.url) mp4 = { url: info.url, kind: 'mp4', bitrate: 0 };
  }
  return mp4 || m3u8;
}

async function probe(url) {
  const id = tweetId(url);
  if (!id) return null;

  const api = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=${syndToken(id)}`;
  const data = await fetchJson(api);
  const hasCookie = !!loadCookies();

  if (!data) {
    throw Object.assign(
      new Error(hasCookie
        ? '这条推文取不到内容（可能已删除或需要更高权限）'
        : 'X 需要登录才能看这条推文。把 x.com 的 cookies 导出到 cookies/twitter.txt 再试'),
      { kind: 'auth' },
    );
  }
  if (data.__typename === 'TweetTombstone' || data.tombstone) {
    throw Object.assign(
      new Error(hasCookie
        ? '这条推文被 X 限制（敏感内容或需要关注），当前 cookie 权限不够'
        : '这条推文被 X 限制（敏感内容）。把 x.com 的 cookies 导出到 cookies/twitter.txt 再试'),
      { kind: 'auth' },
    );
  }

  const media = Array.isArray(data.mediaDetails) ? data.mediaDetails : [];
  const videos = media.filter((m) => m.type === 'video' || m.type === 'animated_gif');
  const photos = media.filter((m) => m.type === 'photo');

  // 纯图片推文：交给后续图集引擎，这里先不处理
  if (!videos.length && !photos.length) return null;

  const best = videos.length ? pickBest(videos) : null;
  if (!best) return null;

  const first = videos[0] || {};
  const info = first.video_info || {};
  const text = String(data.text || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const user = data.user || {};
  const date = data.created_at ? String(data.created_at).slice(0, 10) : '';

  const item = createItem({
    url: normalizeUrl(url),
    site: 'twitter',
    kind: 'video',
    title: text || `tweet ${id}`,
    author: user.name || user.screen_name || '',
    date,
    thumb: first.media_url_https || user.profile_image_url_https || '',
    duration: info.duration_millis ? info.duration_millis / 1000 : 0,
    engine: 'twitter',
    meta: {
      tweetId: id,
      directUrl: best.url,
      directKind: best.kind,
      bitrate: best.bitrate || 0,
      face: user.screen_name || '',
    },
  });
  item.assets = [{
    url: best.url,
    ext: 'mp4',
    quality: best.bitrate ? `${Math.round(best.bitrate / 1000)}k` : '',
    bytes: 0,
    outputPath: '',
    meta: { kind: best.kind },
  }];
  return item;
}

function httpDownload(url, dest, onProgress, ctx) {
  return new Promise((resolve, reject) => {
    const go = (u, depth = 0) => {
      if (depth > 5) return reject(new Error('重定向过多'));
      const parsed = new URL(u);
      const mod = parsed.protocol === 'http:' ? require('http') : https;
      const req = mod.get(u, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Referer': 'https://x.com/',
        },
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.destroy();
          return go(new URL(res.headers.location, u).href, depth + 1);
        }
        if (res.statusCode !== 200) {
          res.destroy();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const total = Number(res.headers['content-length']) || 0;
        let got = 0;
        const out = fs.createWriteStream(dest);
        res.on('data', (c) => {
          got += c.length;
          onProgress({ percent: total ? (got / total) * 100 : 0, bytes: got, total, speed: 0, eta: 0 });
        });
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve()));
        out.on('error', reject);
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(30000, () => req.destroy(new Error('连接超时')));
      ctx && ctx.registerChild && ctx.registerChild({ kill: () => { try { req.destroy(); } catch { /* ignore */ } } });
    };
    go(url, 0);
  });
}

async function download(task, ctx, onProgress) {
  const target = task.item.meta && task.item.meta.directUrl;
  if (!target) throw new Error('没有可下载地址');
  const tmpDir = path.join(config.DATA, 'tmp', task.id);
  fs.mkdirSync(tmpDir, { recursive: true });
  const outFile = path.join(tmpDir, `${task.id}.mp4`);

  if (/\.m3u8/i.test(target)) {
    const res = await hls.downloadHlsTo(target, outFile, {
      onProgress,
      referer: 'https://x.com/',
      userAgent: 'Mozilla/5.0',
    });
    return { files: [res.file], tmpDir };
  }

  await httpDownload(target, outFile, onProgress, ctx);
  return { files: [outFile], tmpDir };
}

module.exports = {
  name: 'twitter',
  priority: 5,
  probe,
  download,
  cookieStatus,
  saveCookies,
  clearCookies,
  testCookies,
  available: () => true,
};
