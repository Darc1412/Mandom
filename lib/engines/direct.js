'use strict';
// 直链引擎：.mp4 / .m3u8 / .mpd，以及 Content-Type 是视频的 URL。

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const spawnUtil = require('../spawn-util');
const hls = require('../hls');
const { createItem, siteOf } = require('../models');

const MEDIA_EXT = /\.(mp4|m4v|webm|mkv|mov|m3u8|mpd|flv|ts)(?:\?|#|$)/i;

function head(url, timeout = 12000) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve(null); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({
      method: 'GET',
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'User-Agent': config.get().userAgent || 'Mozilla/5.0',
        'Range': 'bytes=0-0',
        ...(config.get().referer ? { Referer: config.get().referer } : {}),
      },
    }, (res) => {
      const ct = String(res.headers['content-type'] || '').toLowerCase();
      const len = Number(res.headers['content-length']) || 0;
      res.destroy();
      resolve({ status: res.statusCode, type: ct, length: len });
    });
    req.setTimeout(timeout, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function probe(url, ctx) {
  if (!/^https?:/i.test(url)) return null;
  const u = new URL(url);
  const isMediaExt = MEDIA_EXT.test(u.pathname + (u.search || ''));
  if (isMediaExt) {
    const ext = (u.pathname.match(MEDIA_EXT) || [])[1] || 'mp4';
    // DASH 交给 yt-dlp，它处理得更完整
    if (ext.toLowerCase() === 'mpd') return null;
    const item = createItem({
      url,
      site: siteOf(url),
      kind: 'video',
      title: decodeURIComponent(path.basename(u.pathname)) || 'video',
      engine: 'direct',
      meta: { ext, direct: true },
    });
    item.assets = [{ url, ext, quality: '', bytes: 0, outputPath: '', meta: {} }];
    return item;
  }
  const r = await head(url);
  if (r && r.status < 400 && /^(video|audio)\//.test(r.type)) {
    const ext = r.type.includes('mpegurl') ? 'mp4' : (r.type.split('/')[1].split(';')[0] || 'mp4');
    const item = createItem({
      url, site: siteOf(url), kind: 'video',
      title: path.basename(u.pathname) || 'video',
      engine: 'direct',
      meta: { ext, contentType: r.type },
    });
    item.assets = [{ url, ext, quality: '', bytes: r.length, outputPath: '', meta: {} }];
    return item;
  }
  return null;
}

function ffmpegArgs(input, output) {
  const s = config.get();
  const args = ['-y', '-hide_banner', '-loglevel', 'warning', '-nostats', '-progress', 'pipe:1'];
  const headers = [];
  if (s.referer) headers.push(`Referer: ${s.referer}`);
  if (s.userAgent) headers.push(`User-Agent: ${s.userAgent}`);
  if (headers.length) args.push('-headers', headers.join('\r\n') + '\r\n');
  args.push('-i', input, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', output);
  return args;
}

async function download(task, ctx, onProgress) {
  const url = task.item.url;
  const tmpDir = path.join(config.DATA, 'tmp', task.id);
  fs.mkdirSync(tmpDir, { recursive: true });
  const isHls = /\.m3u8/i.test(url);
  const outFile = path.join(tmpDir, `${task.id}.mp4`);

  if (!isHls) {
    await downloadHttp(url, outFile, ctx, onProgress);
    return { files: [outFile], tmpDir };
  }

  const s = config.get();
  const res = await hls.downloadHlsTo(url, outFile, {
    onProgress,
    referer: s.referer,
    userAgent: s.userAgent,
  });
  return { files: [res.file], tmpDir };
}

function downloadHttp(url, dest, ctx, onProgress) {
  return new Promise((resolve, reject) => {
    const follow = (u, depth = 0) => {
      if (depth > 6) return reject(new Error('重定向过多'));
      const parsed = new URL(u);
      const mod = parsed.protocol === 'http:' ? http : https;
      const s = config.get();
      const req = mod.get(u, {
        headers: {
          'User-Agent': s.userAgent || 'Mozilla/5.0',
          ...(s.referer ? { Referer: s.referer } : {}),
        },
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.destroy();
          return follow(res.headers.location, depth + 1);
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
      // 注册一个可取消的对象（queue 只会调 kill）
      ctx && ctx.registerChild && ctx.registerChild({ kill: () => { try { req.destroy(); } catch {} } });
    };
    follow(url);
  });
}

function lastLine(tail) {
  const lines = String(tail || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] || '';
}

module.exports = {
  name: 'direct',
  priority: 10,
  probe,
  download,
  available: () => true,
};
