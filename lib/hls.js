'use strict';
// HLS 下载：自己拉 m3u8 和分片，本地拼接后再交给 ffmpeg remux。
// 好处：不依赖 ffmpeg 的网络栈（schannel 有问题时也能用），能带 Referer，
// 能处理 AES-128 加密，进度可控。

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const spawnUtil = require('./spawn-util');

function requestBuffer(url, { headers = {}, timeout = 30000, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const go = (u, left) => {
      let parsed;
      try { parsed = new URL(u); } catch (e) { return reject(e); }
      const mod = parsed.protocol === 'http:' ? http : https;
      const req = mod.get(u, { headers }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.destroy();
          if (left <= 0) return reject(new Error('重定向过多'));
          const loc = res.headers.location;
          return go(new URL(loc, u).href, left - 1);
        }
        if (res.statusCode !== 200) {
          res.destroy();
          return reject(new Error(`HTTP ${res.statusCode} ${u.slice(0, 80)}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.setTimeout(timeout, () => req.destroy(new Error('请求超时')));
      req.on('error', reject);
    };
    go(url, redirects);
  });
}

function parseAttrs(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[3] !== undefined ? m[3] : m[2];
  return out;
}

function parseMaster(text, base) {
  const lines = text.split(/\r?\n/);
  let best = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l.startsWith('#EXT-X-STREAM-INF:')) continue;
    const attrs = parseAttrs(l.slice(18));
    const bw = Number(attrs.BANDWIDTH) || 0;
    const next = (lines[i + 1] || '').trim();
    if (next && !next.startsWith('#')) {
      const url = new URL(next, base).href;
      if (!best || bw > best.bandwidth) best = { bandwidth: bw, url, attrs };
    }
  }
  return best;
}

function parseMedia(text, base) {
  const lines = text.split(/\r?\n/);
  let seq = 0;
  let key = null;
  let map = null;
  let endList = false;
  const segments = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = Number(l.split(':')[1]) || 0;
    else if (l.startsWith('#EXT-X-KEY:')) key = parseAttrs(l.slice(11));
    else if (l.startsWith('#EXT-X-MAP:')) map = parseAttrs(l.slice(12));
    else if (l.startsWith('#EXT-X-ENDLIST')) endList = true;
    else if (!l.startsWith('#')) {
      segments.push({ url: new URL(l, base).href, seq: seq++ });
    }
  }
  return { segments, key, map, endList };
}

function ivFromSeq(seq) {
  const b = Buffer.alloc(16);
  b.writeUInt32BE(seq >>> 0, 12);
  return b;
}

function ivFromAttr(v) {
  let s = String(v || '').replace(/^0x/i, '');
  if (!s) return null;
  if (s.length % 2) s = '0' + s;
  const b = Buffer.from(s, 'hex');
  if (b.length >= 16) return b.subarray(0, 16);
  const out = Buffer.alloc(16);
  b.copy(out, 16 - b.length);
  return out;
}

function decryptSegment(data, keyBuf, iv) {
  const d = crypto.createDecipheriv('aes-128-cbc', keyBuf, iv);
  return Buffer.concat([d.update(data), d.final()]);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

async function downloadHls(url, outDir, { onProgress, referer, userAgent } = {}) {
  const headers = {};
  if (referer) headers.Referer = referer;
  if (userAgent) headers['User-Agent'] = userAgent;

  let text = (await requestBuffer(url, { headers })).toString('utf8');
  let base = url;

  if (text.includes('#EXT-X-STREAM-INF')) {
    const best = parseMaster(text, base);
    if (!best) throw new Error('主播放列表里没有可用的清晰度');
    base = best.url;
    text = (await requestBuffer(base, { headers })).toString('utf8');
  }

  const media = parseMedia(text, base);
  if (!media.segments.length) throw new Error('播放列表里没有分片');
  if (!media.endList) throw new Error('这是直播流，没有结束标记，不能作为文件下载');

  fs.mkdirSync(outDir, { recursive: true });

  // init 段（fMP4）
  let initData = null;
  if (media.map && media.map.URI) {
    initData = await requestBuffer(new URL(media.map.URI, base).href, { headers });
  }

  // key
  let keyBuf = null;
  if (media.key && String(media.key.METHOD).toUpperCase() === 'AES-128') {
    if (!media.key.URI) throw new Error('加密但缺少 key URI');
    keyBuf = await requestBuffer(new URL(media.key.URI, base).href, { headers });
    if (keyBuf.length < 16) throw new Error('key 长度异常');
  } else if (media.key && String(media.key.METHOD).toUpperCase() !== 'NONE') {
    throw new Error(`不支持的加密方式：${media.key.METHOD}`);
  }

  const total = media.segments.length;
  let done = 0;
  let bytes = 0;
  const parts = await mapLimit(media.segments, 4, async (seg) => {
    const buf = await requestBuffer(seg.url, { headers });
    let data = buf;
    if (keyBuf) {
      const iv = (media.key.IV && ivFromAttr(media.key.IV)) || ivFromSeq(seg.seq);
      data = decryptSegment(buf, keyBuf, iv);
    }
    done++;
    bytes += data.length;
    if (onProgress) onProgress({ percent: (done / total) * 100, bytes, total: 0, speed: 0, eta: 0, segments: `${done}/${total}` });
    return data;
  });

  const joinedName = path.join(outDir, '_hls_joined.bin');
  const fd = fs.openSync(joinedName, 'w');
  try {
    if (initData) fs.writeSync(fd, initData);
    for (const p of parts) fs.writeSync(fd, p);
  } finally {
    fs.closeSync(fd);
  }

  return { joined: joinedName, bytes, isFmp4: !!initData };
}

async function downloadHlsTo(url, outFile, opts = {}) {
  const outDir = path.dirname(outFile);
  const res = await downloadHls(url, outDir, opts);
  const ext = res.isFmp4 ? '.mp4' : '.ts';
  const src = res.joined.replace(/\.[^.]+$/, '') + ext;
  try { fs.renameSync(res.joined, src); } catch { /* 已存在 */ }

  // 用本地 ffmpeg remux 成 mp4（不联网，避开 schannel）
  if (config.toolExists('ffmpeg')) {
    const proc = spawnUtil.run(config.tool('ffmpeg'), [
      '-y', '-hide_banner', '-loglevel', 'error', '-nostats',
      '-i', src, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart',
      outFile,
    ], {});
    let r;
    try { r = await proc.promise; } catch { r = null; }
    if (r && r.code === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 0) {
      try { fs.unlinkSync(src); } catch { /* ignore */ }
      return { file: outFile, bytes: fs.statSync(outFile).size };
    }
  }

  // ffmpeg 失败就直接用拼接结果
  if (fs.existsSync(src)) return { file: src, bytes: fs.statSync(src).size };
  throw new Error('HLS 合并失败');
}

module.exports = { downloadHls, downloadHlsTo, requestBuffer };
