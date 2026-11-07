'use strict';
// 磁力搜索聚合：多源并发查询 → 归一化 → infohash 去重 → 垃圾过滤 → 打分排序。
// 加一个源 = 在 SOURCES 里加一个对象，不改其他代码。

const fs = require('fs');
const path = require('path');
const config = require('./config');
const bencode = require('./bencode');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function fetchWithTimeout(url, opts = {}, ms = 9000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': '*/*', ...(opts.headers || {}) },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, ms = 9000) {
  const res = await fetchWithTimeout(url, {}, ms);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

async function fetchJson(url, ms = 9000) {
  const res = await fetchWithTimeout(url, {}, ms);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function fetchBuffer(url, ms = 15000) {
  const res = await fetchWithTimeout(url, {}, ms);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function magnetOf(hash, name) {
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name || '')}`;
}

function parseSize(str) {
  const m = String(str || '').match(/([\d.]+)\s*(B|KiB|MiB|GiB|TiB|KB|MB|GB|TB)/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const u = m[2].toLowerCase();
  const mul = {
    b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
    kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, tb: 1000 ** 4,
  }[u] || 1;
  return Math.round(n * mul);
}

/* ---------------- 源 ---------------- */

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x3D;/g, '=')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const SOURCES = [
  {
    name: 'apibay',
    label: 'TPB',
    async search(q) {
      const data = await fetchJson(`https://apibay.org/q.php?q=${encodeURIComponent(q)}&cat=0`);
      if (!Array.isArray(data)) return [];
      return data
        .filter((x) => x && x.id !== '0' && x.info_hash)
        .map((x) => ({
          source: 'apibay',
          sourceLabel: 'TPB',
          infohash: String(x.info_hash).toUpperCase(),
          title: String(x.name || ''),
          size: Number(x.size) || 0,
          seeders: Number(x.seeders) || 0,
          leechers: Number(x.leechers) || 0,
          files: Number(x.num_files) || 0,
          added: Number(x.added) || 0,
          category: Number(x.category) || 0,
          magnet: magnetOf(x.info_hash, x.name),
          torrentUrl: `https://itorrents.org/torrent/${x.info_hash}.torrent`,
        }));
    },
  },
  {
    name: 'nyaa',
    label: 'Nyaa',
    async search(q, page = 1) {
      const xml = await fetchText(`https://nyaa.si/?page=rss&q=${encodeURIComponent(q)}&c=0_0&f=0&p=${page}`);
      const items = [];
      const re = /<item>([\s\S]*?)<\/item>/g;
      let m;
      while ((m = re.exec(xml))) {
        const block = m[1];
        const pick = (tag) => {
          const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
          const x = block.match(r);
          return x ? x[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
        };
        const infoHash = pick('nyaa:infoHash');
        if (!infoHash) continue;
        const title = decodeEntities(pick('title'));
        items.push({
          source: 'nyaa',
          sourceLabel: 'Nyaa',
          infohash: infoHash.toUpperCase(),
          title,
          size: parseSize(pick('nyaa:size')),
          seeders: Number(pick('nyaa:seeders')) || 0,
          leechers: Number(pick('nyaa:leechers')) || 0,
          files: 0,
          added: Math.floor(new Date(pick('pubDate')).getTime() / 1000) || 0,
          category: 0,
          magnet: magnetOf(infoHash, title),
          torrentUrl: pick('link'),
        });
      }
      return items;
    },
  },
  {
    name: 'limetorrents',
    label: 'Lime',
    async search(q, page = 1) {
      const html = await fetchText(`https://www.limetorrents.lol/search/all/${encodeURIComponent(q)}/${page}/`, 12000);
      const rows = html.match(/<tr[\s\S]*?<\/tr>/g) || [];
      const out = [];
      for (const row of rows) {
        const hm = row.match(/itorrents\.net\/torrent\/([0-9A-F]{40})\.torrent/i);
        if (!hm) continue;
        const tm = row.match(/-torrent-\d+\.html">([^<]+)<\/a>/);
        if (!tm) continue;
        const tds = [...row.matchAll(/<td[^>]*class="tdnormal"[^>]*>([^<]*)</g)].map((x) => x[1]);
        const hash = hm[1];
        const title = decodeEntities(tm[1]);
        out.push({
          source: 'limetorrents',
          sourceLabel: 'Lime',
          infohash: hash.toUpperCase(),
          title,
          size: parseSize(tds[1] || ''),
          seeders: Number((row.match(/tdseed">(\d+)/) || [])[1]) || 0,
          leechers: Number((row.match(/tdleech">(\d+)/) || [])[1]) || 0,
          files: 0,
          added: 0,
          category: 0,
          magnet: magnetOf(hash, title),
          torrentUrl: `http://itorrents.net/torrent/${hash}.torrent`,
        });
      }
      return out;
    },
  },
  {
    name: 'rutor',
    label: 'Rutor',
    async search(q, page = 1) {
      const html = await fetchText(`https://rutor.info/search/0/0/000/0/${encodeURIComponent(q)}/${page}`, 12000);
      const rows = html.match(/<tr class="(?:gai|tum)">[\s\S]*?<\/tr>/g) || [];
      const out = [];
      for (const row of rows) {
        const mm = row.match(/href="(magnet:\?xt=urn:btih:([0-9a-fA-F]{40})[^"]*)"/i);
        if (!mm) continue;
        const tm = row.match(/<a href="\/torrent\/\d+\/[^"]*">([^<]+)<\/a>/);
        if (!tm) continue;
        const title = decodeEntities(tm[1]).replace(/&nbsp;/g, ' ').trim();
        const sizeM = row.match(/<td align="right">([\d.]+)&nbsp;([KMGTP]B)<\/td>/);
        const dl = row.match(/href="(\/\/d\.rutor\.info\/download\/\d+)"/);
        out.push({
          source: 'rutor',
          sourceLabel: 'Rutor',
          infohash: mm[2].toUpperCase(),
          title,
          size: sizeM ? parseSize(sizeM[1] + ' ' + sizeM[2]) : 0,
          seeders: Number((row.match(/arrowup\.gif[^>]*>[\s\S]{0,80}?(\d+)/) || [])[1]) || 0,
          leechers: Number((row.match(/arrowdown\.gif[^>]*>[\s\S]{0,120}?(\d+)/) || [])[1]) || 0,
          files: 0,
          added: 0,
          category: 0,
          magnet: decodeEntities(mm[1]),
          torrentUrl: dl ? 'https:' + dl[1] : '',
        });
      }
      return out;
    },
  },
  {
    name: 'bitsearch',
    label: 'BitSearch',
    async search(q, page = 1) {
      const html = await fetchText(`https://bitsearch.to/search?q=${encodeURIComponent(q)}&page=${page}`, 15000);
      // 只在 body 之后切卡片，避免把 <style> 里的类名当成结果
      const body = html.slice(Math.max(0, html.indexOf('<body')));
      const cards = body.split('<div class="torrent-result-card').slice(1);
      const out = [];
      for (const rawCard of cards) {
        // HTML 里的 = 被写成 &#x3D;，先解码再匹配
        const card = decodeEntities(rawCard);
        const mm = card.match(/href="(magnet:\?xt=urn:btih:([0-9A-F]{40})[^"]*)"/i);
        if (!mm) continue;
        const tm = card.match(/<h3[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/);
        if (!tm) continue;
        const title = decodeEntities(tm[1]).trim();
        out.push({
          source: 'bitsearch',
          sourceLabel: 'BitSearch',
          infohash: mm[2].toUpperCase(),
          title,
          size: parseSize((card.match(/([\d.]+ (?:[KMGTP]?B))/i) || [])[1] || ''),
          seeders: Number((card.match(/(\d+)\s*(?:seeders?|seeds)/i) || [])[1]) || 0,
          leechers: Number((card.match(/(\d+)\s*(?:leechers?|leeches)/i) || [])[1]) || 0,
          files: 0,
          added: 0,
          category: 0,
          magnet: decodeEntities(mm[1]),
          torrentUrl: '',
        });
      }
      return out;
    },
  },
];

/* ---------------- 垃圾过滤 ---------------- */

const JUNK_WORDS = [
  '加群', '加微信', '加qq', '客服qq', '最新地址', '永久地址', '发布页', '官网地址',
  'app下载', '扫码下载', '手机观看', '免费观看', '在线观看', '高清免费', '午夜',
  '约炮', '约啪', '探花', '国产自拍', '偷拍', '迷奸', '萝莉', '幼女',
  '澳门', '赌场', '博彩', '棋牌', '彩票', '六合彩',
  '黄色', '色情', '成人网站', 'av下载', '看片',
];

const BAD_QUALITY = /\b(cam|camrip|hdcam|ts|hdts|telesync|tc|telecine|screener|scr|dvdscr)\b/i;
const GOOD_QUALITY = /\b(2160p|1080p|720p|bluray|blu-ray|bdrip|web-dl|webrip|remux|hevc|h265|x265|hdr|dolby)\b/i;

// 只删除明确没有内容的条目，不再因为标题里有广告词就整条丢掉
function isJunk(r) {
  if (!r.title || !r.title.trim()) return true;
  if (r.seeders === 0 && r.leechers === 0 && r.size === 0) return true;
  if (r.size > 0 && r.size < 1024 * 1024 && !/\.(iso|exe|msi|apk|zip|rar|7z|pdf|epub)$/i.test(r.title)) {
    return true;
  }
  return false;
}

// 广告词只扣分，不删除——有些正常资源标题里就是会带这些
function junkPenalty(r) {
  const t = String(r.title || '').toLowerCase();
  let p = 0;
  for (const w of JUNK_WORDS) if (t.includes(w)) p += 25;
  if (r.source === 'apibay' && r.category >= 500 && r.category < 600) p += 20;
  return Math.min(p, 70);
}

// 标题指纹：去掉标点和空格后比较，用于识别"同一名字反复发"
function titleKey(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[\s\-_.·|/\\()[\]{}【】「」『』<>《》]+/g, '')
    .replace(/[^\w\u4e00-\u9fff]/g, '')
    .slice(0, 70);
}

function qualityScore(r) {
  let s = 0;
  if (GOOD_QUALITY.test(r.title)) s += 15;
  if (BAD_QUALITY.test(r.title)) s -= 20;
  if (/中字|字幕|简中|繁中|双语|chinese|chs|cht/i.test(r.title)) s += 8;
  if (/s\d{2}e\d{2}|season|全集|complete/i.test(r.title)) s += 6;
  return s;
}

function scoreOf(r) {
  const seed = Math.min(r.seeders, 5000);
  const base = Math.log10(seed + 1) * 20;
  const ratio = r.leechers > 0 ? Math.min(r.seeders / r.leechers, 10) : Math.min(r.seeders, 10);
  return base + ratio * 2 + qualityScore(r) - junkPenalty(r);
}

/* ---------------- 别名扩展 ---------------- */

async function wikiQuery(title) {
  const api = `https://zh.wikipedia.org/w/api.php?action=query&format=json&prop=langlinks&lllimit=500&redirects=1&titles=${encodeURIComponent(title)}`;
  const res = await fetchWithTimeout(api, {}, 6000);
  if (!res.ok) return null;
  return await res.json();
}

async function wikiSearch(query) {
  const api = `https://zh.wikipedia.org/w/api.php?action=query&format=json&list=search&srlimit=1&srsearch=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(api, {}, 6000);
  if (!res.ok) return '';
  const data = await res.json();
  const hit = data.query && data.query.search && data.query.search[0];
  return hit ? String(hit.title || '') : '';
}

function langlinksOf(data) {
  const pages = (data && data.query && data.query.pages) || {};
  const out = [];
  for (const p of Object.values(pages)) {
    if (p.missing !== undefined) continue;
    for (const ll of p.langlinks || []) {
      if ((ll.lang === 'ja' || ll.lang === 'en') && ll['*']) out.push(ll['*']);
    }
  }
  return out;
}

const ALIAS_CACHE = new Map();

async function wikiQueryWithRetry(title) {
  for (let i = 0; i < 2; i++) {
    try {
      const data = await wikiQuery(title);
      if (data) return data;
    } catch { /* 重试一次 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

async function wikiAliasesRaw(query) {
  try {
    let data = await wikiQueryWithRetry(query);
    let links = langlinksOf(data);
    if (!links.length) {
      // 条目名对不上时，先用维基搜索找最可能的条目
      const found = await wikiSearch(query);
      if (!found || found === query) return [];
      data = await wikiQueryWithRetry(found);
      links = langlinksOf(data);
    }
    return [...new Set(links)].slice(0, 3);
  } catch {
    return [];
  }
}

async function wikiAliases(query) {
  const hit = ALIAS_CACHE.get(query);
  if (hit && Date.now() - hit.at < 24 * 3600 * 1000) return hit.list;
  const list = await wikiAliasesRaw(query);
  if (list.length) {
    if (ALIAS_CACHE.size > 200) ALIAS_CACHE.clear();
    ALIAS_CACHE.set(query, { at: Date.now(), list });
  }
  return list;
}

/* ---------------- 相关性 ---------------- */

// 短词（比如 "W"）必须作为独立词出现，避免匹配到 Windows 里的 w
function wordMatches(t, w) {
  if (!w) return false;
  if (w.length <= 2) {
    return new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(t);
  }
  return t.includes(w);
}

function isRelevant(title, alts) {
  const t = String(title || '').toLowerCase();
  if (!t) return false;
  for (const raw of alts) {
    const a = String(raw || '').toLowerCase();
    if (!a) continue;
    if (t.includes(a)) return true;
    const cjk = a.replace(/[^\u4e00-\u9fff]/g, '');
    if (cjk.length >= 2) {
      let hits = 0;
      const grams = Math.max(1, cjk.length - 1);
      for (let i = 0; i < grams; i++) if (t.includes(cjk.slice(i, i + 2))) hits++;
      if (hits >= Math.min(2, grams)) return true;
    }
    const words = a.split(/[\s\-_.]+/).filter(Boolean);
    if (words.length && words.every((w) => wordMatches(t, w))) return true;
  }
  return false;
}

// 0~1 的匹配度：完整短语 1.0，词全中 0.6，部分命中按比例
function relevanceScore(title, alts) {
  const t = String(title || '').toLowerCase();
  let best = 0;
  for (const raw of alts) {
    const a = String(raw || '').toLowerCase();
    if (!a) continue;
    if (t.includes(a)) { best = Math.max(best, 1); continue; }
    const words = a.split(/[\s\-_.]+/).filter(Boolean);
    if (words.length) {
      const hit = words.filter((w) => wordMatches(t, w)).length;
      best = Math.max(best, (hit / words.length) * 0.6);
    }
    const cjk = a.replace(/[^\u4e00-\u9fff]/g, '');
    if (cjk.length >= 2) {
      let hits = 0;
      const grams = Math.max(1, cjk.length - 1);
      for (let i = 0; i < grams; i++) if (t.includes(cjk.slice(i, i + 2))) hits++;
      best = Math.max(best, (hits / grams) * 0.7);
    }
  }
  return best;
}

/* ---------------- 聚合 ---------------- */

function normalizeInfohash(h) {
  return String(h || '').trim().toUpperCase();
}

// 元信息完整度打分：谁的字段更全，就让谁当底
function infoScore(r) {
  let s = 0;
  if (r.title) s += 2;
  if (r.size > 0) s += 2;
  if (r.added > 0) s += 2;
  if (r.files > 0) s += 1;
  if (r.category > 0) s += 1;
  if (r.torrentUrl) s += 1;
  return s;
}

// 同一个 infohash 被多个源收录时，合并成一条信息最全的记录
function mergeItem(prev, item) {
  const base = infoScore(item) > infoScore(prev) ? item : prev;
  const other = base === item ? prev : item;

  base.seeders = Math.max(prev.seeders || 0, item.seeders || 0);
  base.leechers = Math.max(prev.leechers || 0, item.leechers || 0);
  base.size = Math.max(prev.size || 0, item.size || 0);
  base.files = Math.max(prev.files || 0, item.files || 0);
  base.added = Math.max(prev.added || 0, item.added || 0);
  if (!base.title) base.title = other.title;
  if (!base.torrentUrl) base.torrentUrl = other.torrentUrl;
  if (!base.category) base.category = other.category;
  if (!base.magnet) base.magnet = other.magnet;
  base.sources = [...new Set([...(prev.sources || []), ...(item.sources || [])])];
  return base;
}

async function collect(q, opts = {}) {
  const enabled = opts.sources && opts.sources.length
    ? SOURCES.filter((s) => opts.sources.includes(s.name))
    : SOURCES;

  const settled = await Promise.all(enabled.map(async (s) => {
    const start = Date.now();
    const runOnce = async () => {
      try {
        const list = await s.search(q, opts.page || 1);
        return { source: s.name, label: s.label, ok: true, count: list.length, ms: Date.now() - start, list };
      } catch (e) {
        return { source: s.name, label: s.label, ok: false, count: 0, ms: Date.now() - start, error: String(e.message || e) };
      }
    };
    let r = await runOnce();
    // 第一次失败就再试一次，站点偶发超时是常态
    if (!r.ok) {
      await new Promise((res) => setTimeout(res, 600));
      r = await runOnce();
    }
    return r;
  }));

  const merged = new Map();
  let raw = 0;
  let filtered = 0;

  for (const r of settled) {
    if (!r.ok) continue;
    for (const item of r.list) {
      raw++;
      item.infohash = normalizeInfohash(item.infohash);
      if (!item.infohash) { filtered++; continue; }
      if (isJunk(item)) { filtered++; continue; }
      const prev = merged.get(item.infohash);
      if (prev) {
        merged.set(item.infohash, mergeItem(prev, item));
      } else {
        item.sources = [item.sourceLabel];
        merged.set(item.infohash, item);
      }
    }
  }

  return { settled, merged, raw, filtered };
}

const CACHE = new Map();
const CACHE_TTL = 2 * 60 * 1000;

async function search(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return { results: [], stats: { sources: [], elapsed: 0, filtered: 0, total: 0 } };

  // 快速模式：跳过别名扩展和相关度过滤，用选中的源（没指定就用三个最快的）
  const mode = opts.mode === 'fast' ? 'fast' : 'precise';
  const picked = Array.isArray(opts.sources) ? opts.sources.filter(Boolean) : [];
  if (mode === 'fast') {
    opts = {
      ...opts,
      sources: picked.length ? picked : ['apibay', 'nyaa', 'rutor'],
      expand: false,
      sort: opts.sort || 'seeders',
      page: opts.page || 1,
    };
  }

  const cacheKey = `${q}|${mode}|${(opts.sources || []).join(',')}|${opts.sort || 'relevance'}|${opts.order || 'desc'}|${opts.page || 1}|${opts.expand === false ? 0 : 1}`;
  if (!opts.force) {
    const hit = CACHE.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL) return { ...hit.data, cached: true };
  }

  const t0 = Date.now();

  const first = await collect(q, opts);
  const merged = first.merged;
  let raw = first.raw;
  let filtered = first.filtered;
  let aliases = [];

  const relevantOf = (alts) => [...merged.values()].filter((r) => isRelevant(r.title, alts));
  let rel = relevantOf([q]);

  // 中文查询默认做多语言别名扩展（"假面骑士" → Kamen Rider / 仮面ライダー），
  // 因为只搜中文会漏掉大量用原名发布的资源。英文/数字查询不扩展。
  const isCjk = /[\u4e00-\u9fff]/.test(q);
  if (opts.expand !== false && isCjk) {
    const found = await wikiAliases(q);
    if (process.env.COLLECTOR_DEBUG) console.log('[torrents] alias for', q, '=>', found);
    // 别名扩展只用三个快源，并且并发，别把慢源拖进来
    const aliasOpts = { ...opts, sources: ['apibay', 'nyaa', 'rutor'] };
    const extras = await Promise.all(found.map((a) => collect(a, aliasOpts)));
    for (const extra of extras) {
      raw += extra.raw;
      filtered += extra.filtered;
      for (const [hash, item] of extra.merged) {
        if (merged.has(hash)) continue;
        item.alias = item.sourceLabel;
        merged.set(hash, item);
      }
    }
    aliases = found;
    if (found.length) rel = relevantOf([q, ...aliases]);
  }

  const beforeRelevance = merged.size;
  let results;
  let irrelevant = 0;
  if (mode === 'fast') {
    // 快速模式不过滤相关度，源给的都保留，靠排序压垃圾
    results = [...merged.values()];
  } else {
    results = rel;
    irrelevant = beforeRelevance - results.length;
  }

  // 标题指纹去重：同一个名字被反复发布的，只留做种最好的那条
  const seen = new Map();
  let titleDupes = 0;
  const deduped = [];
  for (const r of results) {
    const k = titleKey(r.title);
    if (!k) { deduped.push(r); continue; }
    const idx = seen.get(k);
    if (idx === undefined) { seen.set(k, deduped.length); deduped.push(r); continue; }
    titleDupes++;
    const prev = deduped[idx];
    const keep = (r.seeders + r.leechers) > (prev.seeders + prev.leechers) ? r : prev;
    const drop = keep === r ? prev : r;
    keep.sources = [...new Set([...(keep.sources || []), ...(drop.sources || [])])];
    deduped[idx] = keep;
  }
  results = deduped;

  const alts = [q, ...aliases];
  results = results.map((r) => ({
    ...r,
    score: scoreOf(r),
    relevance: relevanceScore(r.title, alts),
  }));

  const sort = opts.sort || 'relevance';
  const dir = opts.order === 'asc' ? -1 : 1;
  const cmp = {
    relevance: (a, b) => (b.relevance - a.relevance) || (b.seeders - a.seeders),
    seeders: (a, b) => b.seeders - a.seeders,
    size: (a, b) => b.size - a.size,
    date: (a, b) => b.added - a.added,
    score: (a, b) => b.score - a.score,
  }[sort] || ((a, b) => b.score - a.score);
  results.sort((a, b) => cmp(a, b) * dir);

  const limit = Math.min(Number(opts.limit) || 300, 500);
  results = results.slice(0, limit);

  const out = {
    results,
    stats: {
      query: q,
      aliases,
      sources: first.settled.map((s) => ({
        name: s.source, label: s.label, ok: s.ok, count: s.count, ms: s.ms, error: s.error || '',
      })),
      raw,
      afterDedupe: merged.size,
      titleDupes,
      filtered,
      irrelevant,
      elapsed: Date.now() - t0,
    },
  };

  // 结果太少的查询不缓存，下次重新打源，避免"搜不到"被记住
  if (results.length >= 5) {
    if (CACHE.size > 60) CACHE.clear();
    CACHE.set(cacheKey, { at: Date.now(), data: out });
  }
  return out;
}

/* ---------------- 详情（文件列表） ---------------- */

async function detail(torrentUrl) {
  if (!torrentUrl || !/^https?:\/\//i.test(torrentUrl)) throw new Error('没有可用的 .torrent 地址');
  const buf = await fetchBuffer(torrentUrl, 20000);
  const t = bencode.decode(buf);
  const files = bencode.torrentFiles(t);
  const totalSize = files.reduce((a, f) => a + f.size, 0);
  return {
    name: String((t.info && (t.info['name.utf-8'] || t.info.name)) || ''),
    files,
    totalSize,
  };
}

const sourceStatus = SOURCES.map((s) => ({ name: s.name, label: s.label }));

module.exports = { search, detail, SOURCES, sourceStatus, JUNK_WORDS, wikiAliases };
