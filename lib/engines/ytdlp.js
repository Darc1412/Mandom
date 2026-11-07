'use strict';
// yt-dlp 引擎：视频站主力。probe 用 --dump-single-json，download 用进度模板。

const path = require('path');
const fs = require('fs');
const config = require('../config');
const spawnUtil = require('../spawn-util');
const ytdlpBin = require('../ytdlp-bin');
const { createItem, siteOf, normalizeUrl } = require('../models');

const PROGRESS_TAG = '__COLLECTOR_PROGRESS__';
const FILE_TAG = '__COLLECTOR_FILE__';

function cookieArgs() {
  const s = config.get();
  if (s.cookiesMode === 'browser' && s.cookiesBrowser) {
    return ['--cookies-from-browser', s.cookiesBrowser];
  }
  if (s.cookiesMode === 'file' && s.cookiesFile && fs.existsSync(s.cookiesFile)) {
    return ['--cookies', s.cookiesFile];
  }
  // 没有显式配置时，把 cookies/twitter.txt 自动转一份给 yt-dlp
  const auto = config.netscapeCookieFile();
  if (auto) return ['--cookies', auto];
  return [];
}

function cleanPct(v) {
  const n = parseFloat(String(v || '').replace('%', '').trim());
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

// --dump-single-json 输出在 stdout，用 onLine 收集后取最后一行 JSON。

// --dump-single-json 输出在 stdout。spawn-util 只把 stderr 收进 res.err，
// 所以这里改成用带 stdout 收集的 probe：给 onLine 一个收集器。
async function probeJson(url, ctx) {
  const args = [
    '--dump-single-json', '--no-warnings', '--no-playlist',
    '--socket-timeout', '15', '--retries', '2',
    ...cookieArgs(),
    url,
  ];
  const out = [];
  const spec = ytdlpBin.build(args);
  if (!spec) return null;
  const proc = spawnUtil.run(spec.exe, spec.args, {
    cwd: config.ROOT,
    timeout: (ctx && ctx.probeTimeout) || config.get().probeTimeoutMs,
    onLine: (line) => out.push(line),
    env: spec.env,
  });
  let res;
  try { res = await proc.promise; } catch { return null; }
  if (res.killed) return null;
  if (res.code !== 0) {
    const msg = lastErrorLine(res.err);
    if (/Unsupported URL|no suitable|is not a valid URL|Unable to extract|Unsupported site/i.test(msg)) return null;
    throw Object.assign(new Error(msg || 'yt-dlp 无法解析'), { kind: 'ytdlp-fail' });
  }
  const joined = out.join('\n');
  const jsonLine = findJsonLine(joined);
  if (!jsonLine) return null;

  let info;
  try { info = JSON.parse(jsonLine); } catch { return null; }
  if (info._type === 'playlist') info = (info.entries && info.entries[0]) || null;
  if (!info) return null;

  const formats = Array.isArray(info.formats) ? info.formats : [];
  const playable = formats.filter((f) => f.url || f.manifest_url);
  const drmOnly = playable.length > 0 && playable.every((f) => f.has_drm);
  if (drmOnly) throw Object.assign(new Error('该视频受 DRM 保护，无法下载'), { kind: 'drm' });

  const item = createItem({
    url: normalizeUrl(url),
    site: siteOf(url),
    kind: 'video',
    title: info.title || info.fulltitle || '',
    author: info.uploader || info.channel || info.creator || '',
    date: info.upload_date || '',
    thumb: info.thumbnail || '',
    duration: info.duration || 0,
    engine: 'ytdlp',
    meta: {
      ext: info.ext || 'mp4',
      webpage: info.webpage_url || url,
      filesize: info.filesize || info.filesize_approx || 0,
      formatCount: playable.length,
    },
  });
  item.assets = [{
    url: item.url,
    ext: info.ext || 'mp4',
    quality: '',
    bytes: info.filesize || info.filesize_approx || 0,
    outputPath: '',
    meta: {},
  }];
  return item;
}

function findJsonLine(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l.startsWith('{') && l.endsWith('}')) return l;
  }
  return '';
}

async function download(task, ctx, onProgress) {
  const s = config.get();
  const tmpDir = path.join(config.DATA, 'tmp', task.id);
  fs.mkdirSync(tmpDir, { recursive: true });

  const args = [
    '--no-playlist', '--no-warnings', '--newline',
    '--no-mtime', '--retries', '3', '--fragment-retries', '3',
    '--concurrent-fragments', '2',
    '-f', 'bv*+ba/b',
    '--merge-output-format', 'mp4',
    '--progress',
    '--progress-template', `download:${PROGRESS_TAG}%(progress.downloaded_bytes)s|%(progress.total_bytes_estimate)s|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s`,
    '--print', `after_move:${FILE_TAG}%(filepath)s`,
    '-o', path.join(tmpDir, '%(id)s.%(ext)s'),
    ...cookieArgs(),
  ];
  if (config.toolExists('ffmpeg')) {
    args.push('--ffmpeg-location', config.TOOLS);
  }
  if (s.userAgent) args.push('--user-agent', s.userAgent);
  args.push(task.item.url);

  let finalFile = '';
  let lastBytes = 0;

  const spec = ytdlpBin.build(args);
  if (!spec) throw new Error('yt-dlp 不可用');
  const proc = spawnUtil.run(spec.exe, spec.args, {
    cwd: config.ROOT,
    env: spec.env,
    onLine: (line) => {
      if (line.startsWith(PROGRESS_TAG)) {
        const [bytes, total, pct, speed, eta] = line.slice(PROGRESS_TAG.length).split('|');
        const b = Number(bytes) || 0;
        const t = Number(total) || 0;
        if (b >= lastBytes - 1024) {
          lastBytes = b;
          onProgress({
            percent: t > 0 ? Math.min(100, (b / t) * 100) : cleanPct(pct),
            bytes: b, total: t, speed: parseSpeed(speed), eta: parseEta(eta),
          });
        }
      } else if (line.startsWith(FILE_TAG)) {
        finalFile = line.slice(FILE_TAG.length).trim();
      }
    },
  });
  ctx && ctx.registerChild && ctx.registerChild(proc);

  let res;
  try {
    res = await proc.promise;
  } finally {
    ctx && ctx.unregisterChild && ctx.unregisterChild(proc);
  }

  if (res.killed) throw new Error('已取消');
  if (res.code !== 0) {
    throw Object.assign(new Error(lastErrorLine(res.err) || `yt-dlp 退出码 ${res.code}`), { code: 'YTDLP_EXIT' });
  }

  if (!finalFile || !fs.existsSync(finalFile)) {
    const files = fs.readdirSync(tmpDir).filter((f) => !f.endsWith('.part') && !f.endsWith('.ytdl'));
    if (files.length) finalFile = path.join(tmpDir, files.sort().pop());
  }
  if (!finalFile || !fs.existsSync(finalFile)) throw new Error('下载完成但找不到输出文件');
  return { files: [finalFile], tmpDir };
}

function parseSpeed(v) {
  if (!v) return 0;
  const m = String(v).match(/([\d.]+)\s*([KMG]i?B)\/s/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const mul = unit.startsWith('G') ? 1024 ** 3 : unit.startsWith('M') ? 1024 ** 2 : unit.startsWith('K') ? 1024 : 1;
  return Math.round(n * mul);
}

function parseEta(v) {
  if (!v) return 0;
  const parts = String(v).trim().split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

function lastErrorLine(tail) {
  const lines = String(tail || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/ERROR|error|DRM|404|403|Unsupported/i.test(lines[i])) return lines[i].slice(0, 300);
  }
  return lines[lines.length - 1] || '';
}

module.exports = {
  name: 'ytdlp',
  priority: 20,
  probe: probeJson,
  download,
  available: () => ytdlpBin.available(),
};
