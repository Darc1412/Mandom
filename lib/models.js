'use strict';
// 数据模型：全项目唯一的 Item / Asset / Task 定义处。
// 其他模块只 import，不自己拼对象。

const crypto = require('crypto');

const SITE_RULES = [
  ['twitter', /(?:^|\.)(?:x|twitter|t\.co)$/],
  ['bilibili', /(?:^|\.)bilibili\.com$/],
  ['youtube', /(?:^|\.)(?:youtube\.com|youtu\.be)$/],
  ['pixiv', /(?:^|\.)pixiv\.net$/],
  ['konachan', /(?:^|\.)konachan\.(?:com|net)$/],
  ['weibo', /(?:^|\.)weibo\.(?:com|cn)$/],
  ['douyin', /(?:^|\.)douyin\.com$/],
  ['ixigua', /(?:^|\.)ixigua\.com$/],
];

const TRACK_PARAMS = new Set([
  's', 't', 'ref', 'ref_src', 'ref_url', 'utm_source', 'utm_medium',
  'utm_campaign', 'utm_term', 'utm_content', 'spm', 'share_token',
  'share_source', 'share_medium', 'from', 'is_from', 'scene', 'srcid',
]);

function siteOf(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const [name, re] of SITE_RULES) if (re.test(host)) return name;
    return host.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

// 归一化：去掉跟踪参数、统一域名、twitter 只保留 /status/ID
function normalizeUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  let url;
  try { url = new URL(u); } catch { return u; }
  url.hash = '';

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let path = url.pathname.replace(/\/+$/, '') || '/';

  // X / Twitter：只保留 /<user>/status/<id> 或 /i/status/<id>
  if (/(^|\.)(x|twitter)\.com$/.test(host)) {
    const m = path.match(/^(?:\/i)?\/[^/]+\/status\/(\d+)/) || path.match(/^\/i\/status\/(\d+)/);
    if (m) return `https://x.com/i/status/${m[1]}`;
    url.hostname = 'x.com';
  }

  // bilibili：BV / av / 短链保留原样，去掉查询参数里的分享项
  if (/bilibili\.com$/.test(host)) {
    const m = path.match(/\/video\/(BV[0-9A-Za-z]+|av\d+)/i);
    if (m) return `https://www.bilibili.com/video/${m[1]}`;
  }

  const params = url.searchParams;
  for (const k of [...params.keys()]) {
    if (TRACK_PARAMS.has(k.toLowerCase())) params.delete(k);
  }
  const q = params.toString();
  return `${url.protocol}//${url.host}${path}${q ? '?' + q : ''}`;
}

function hashId(seed) {
  return crypto.createHash('sha1').update(String(seed)).digest('hex').slice(0, 12);
}

function createAsset({ url, ext = '', quality = '', bytes = 0, meta = {} }) {
  return { url, ext, quality, bytes, outputPath: '', meta };
}

function createItem({
  url, site, kind = 'video', title = '', author = '', date = '',
  thumb = '', duration = 0, engine = '', assets = [], meta = {},
}) {
  const norm = normalizeUrl(url);
  return {
    id: hashId(norm),
    url: norm,
    site: site || siteOf(norm),
    kind,
    title: title || norm,
    author,
    date,
    thumb,
    duration,
    engine,
    assets,
    meta,
    status: 'new',
    error: '',
  };
}

function createTask(item) {
  return {
    id: item.id,
    item,
    state: 'queued',
    progress: { percent: 0, bytes: 0, total: 0, speed: 0, eta: 0 },
    file: '',
    error: '',
    log: [],
    startedAt: 0,
    finishedAt: 0,
  };
}

module.exports = {
  siteOf, normalizeUrl, createItem, createAsset, createTask, hashId,
  SITE_RULES,
};
