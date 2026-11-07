'use strict';
// 入口：HTTP 路由 + 启动。业务逻辑都在 lib/ 里。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./lib/config');
const queue = require('./lib/queue');
const sse = require('./lib/sse');
const resolver = require('./lib/resolver');
const twitterEngine = require('./lib/engines/twitter');
const torrents = require('./lib/torrents');
const { normalizeUrl } = require('./lib/models');

const PORT = Number(process.env.PORT || config.get().port || 8792);
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

function safeJoin(root, target) {
  const rootAbs = path.resolve(root);
  const targetAbs = path.resolve(rootAbs, target);
  if (!targetAbs.startsWith(rootAbs + path.sep) && targetAbs !== rootAbs) return null;
  return targetAbs;
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = safeJoin(PUBLIC, rel);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

function serveMedia(req, res, filepath) {
  const outDir = path.resolve(config.get().outDir);
  const abs = path.resolve(filepath);
  if (!abs.startsWith(outDir + path.sep) && abs !== outDir) {
    return sendJson(res, 403, { error: '只能访问输出目录内的文件' });
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return sendJson(res, 404, { error: '文件不存在' });
  }
  const stat = fs.statSync(abs);
  const ext = path.extname(abs).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (!Number.isFinite(end) || end >= stat.size) end = stat.size - 1;
    if (start > end) { res.writeHead(416); return res.end(); }
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(abs, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
  });
  fs.createReadStream(abs).pipe(res);
}

async function handleResolve(req, res) {
  const body = await readBody(req);
  const urls = normalizeList(body.urls || body.url || []);
  if (!urls.length) return sendJson(res, 400, { error: '没有链接' });
  const results = await resolver.resolveBatch(urls, 3, {});
  sendJson(res, 200, {
    results: results.map((r, i) => ({ input: urls[i], ok: r.ok, item: r.item, reason: r.reason, hint: r.hint, cached: r.cached })),
  });
}

async function handleTasks(req, res) {
  const body = await readBody(req);
  const urls = normalizeList(body.urls || body.url || []);
  if (!urls.length) return sendJson(res, 400, { error: '没有链接' });

  try {
    fs.accessSync(config.ensureOutDir(), fs.constants.W_OK);
  } catch {
    return sendJson(res, 400, {
      error: `输出目录不可写：${config.get().outDir}。请点「更改」换一个目录，或用 start.cmd 自己启动程序。`,
    });
  }

  const accepted = [];
  const failed = [];
  const targets = [];
  const seen = new Set();

  for (const raw of urls) {
    const norm = normalizeUrl(raw);
    if (!norm) { failed.push({ input: raw, reason: '空链接' }); continue; }
    if (seen.has(norm)) { failed.push({ input: raw, reason: '重复链接' }); continue; }
    seen.add(norm);
    targets.push({ input: raw, norm });
  }

  const results = await resolver.resolveBatch(targets.map((t) => t.norm), 3, {});
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const r = results[i] || { ok: false, reason: '解析失败' };
    if (r.ok) {
      const added = queue.add([r.item]);
      accepted.push({
        input: t.input,
        item: added.length ? queue.public(added[0]) : null,
        existed: added.length === 0,
      });
    } else {
      failed.push({ input: t.input, reason: r.reason || '无法解析', hint: r.hint || '' });
    }
  }
  sendJson(res, 200, { accepted, failed });
}

function normalizeList(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/\r?\n/);
  const out = [];
  for (const s of arr) {
    const line = String(s || '').trim();
    if (!line) continue;
    // 一行里夹着说明文字时，只取 URL
    const found = line.match(/https?:\/\/[^\s"'<>]+/gi);
    if (found) out.push(...found);
    else out.push(line);
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const p = url.pathname;

  try {
    if (p === '/api/events' && req.method === 'GET') return sse.attach(req, res);

    if (p === '/api/state' && req.method === 'GET') {
      return sendJson(res, 200, {
        tasks: queue.list(),
        stats: queue.stats(),
        settings: config.get(),
        tools: {
          ytdlp: config.toolExists('ytdlp'),
          ffmpeg: config.toolExists('ffmpeg'),
          gallerydl: config.toolExists('gallerydl'),
        },
        cookies: twitterEngine.cookieStatus(),
      });
    }

    if (p === '/api/cookies') {
      if (req.method === 'POST') {
        const body = await readBody(req);
        const r = twitterEngine.saveCookies(body.raw);
        return sendJson(res, r.ok ? 200 : 400, r);
      }
      if (req.method === 'DELETE') {
        return sendJson(res, 200, twitterEngine.clearCookies());
      }
    }

    if (p === '/api/cookies/test' && req.method === 'POST') {
      return sendJson(res, 200, await twitterEngine.testCookies());
    }

    if (p === '/api/torrent/search' && req.method === 'GET') {
      const q = url.searchParams.get('q') || '';
      if (!q.trim()) return sendJson(res, 400, { error: '缺少关键词' });
      const r = await torrents.search(q, {
        mode: url.searchParams.get('mode') || 'precise',
        sources: (url.searchParams.get('sources') || '').split(',').map((s) => s.trim()).filter(Boolean),
        sort: url.searchParams.get('sort') || 'relevance',
        order: url.searchParams.get('order') || 'desc',
        page: Number(url.searchParams.get('page') || 1),
        expand: url.searchParams.get('expand') !== '0',
        force: url.searchParams.get('force') === '1',
      });
      return sendJson(res, 200, r);
    }

    if (p === '/api/torrent/detail' && req.method === 'GET') {
      const u = url.searchParams.get('url') || '';
      try {
        const d = await torrents.detail(u);
        return sendJson(res, 200, { ok: true, ...d });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message || '取不到种子信息' });
      }
    }

    if (p === '/api/torrent/sources' && req.method === 'GET') {
      return sendJson(res, 200, { sources: torrents.sourceStatus });
    }

    if (p === '/api/resolve' && req.method === 'POST') return handleResolve(req, res);
    if (p === '/api/tasks' && req.method === 'POST') return handleTasks(req, res);

    if (p === '/api/settings') {
      if (req.method === 'GET') return sendJson(res, 200, config.get());
      if (req.method === 'POST') {
        const patch = await readBody(req);
        const allowed = ['outDir', 'concurrency', 'cookiesMode', 'cookiesBrowser',
          'cookiesFile', 'namingTemplate', 'autoStart', 'referer', 'userAgent'];
        const clean = {};
        for (const k of allowed) if (k in patch) clean[k] = patch[k];
        config.set(clean);
        config.saveNow();
        return sendJson(res, 200, { ok: true, settings: config.get() });
      }
    }

    if (p === '/api/queue' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.action === 'pause') queue.setPaused(true);
      if (body.action === 'resume') queue.setPaused(false);
      return sendJson(res, 200, { ok: true, stats: queue.stats() });
    }

    const m = p.match(/^\/api\/tasks\/([a-f0-9]+)\/(cancel|retry|remove)$/);
    if (m && req.method === 'POST') {
      const [, id, action] = m;
      const ok = action === 'cancel' ? queue.cancel(id)
        : action === 'retry' ? queue.retry(id)
        : queue.remove(id);
      return sendJson(res, 200, { ok, stats: queue.stats() });
    }

    if (p === '/api/media' && req.method === 'GET') {
      return serveMedia(req, res, url.searchParams.get('path') || '');
    }

    if (p === '/api/reveal' && req.method === 'POST') {
      const body = await readBody(req);
      const file = String(body.path || '');
      const abs = path.resolve(file);
      if (!fs.existsSync(abs)) return sendJson(res, 404, { error: '不存在' });
      spawn('explorer.exe', ['/select,', abs], { detached: true, stdio: 'ignore' }).unref();
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/open' && req.method === 'POST') {
      const body = await readBody(req);
      const file = String(body.path || '');
      const abs = path.resolve(file);
      if (!fs.existsSync(abs)) return sendJson(res, 404, { error: '不存在' });
      spawn('cmd.exe', ['/c', 'start', '', abs], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/detect-type' && req.method === 'POST') {
      const body = await readBody(req);
      const u = normalizeUrl(body.url || '');
      const r = await resolver.resolve(u, {});
      return sendJson(res, 200, r);
    }

    if (p.startsWith('/api/')) return sendJson(res, 404, { error: '未知接口' });

    return serveStatic(req, res, p);
  } catch (err) {
    console.error('[server]', err);
    try { sendJson(res, 500, { error: String(err.message || err) }); } catch { /* ignore */ }
  }
});

queue.on('task:add', (t) => sse.broadcast('task:add', t));
queue.on('task:update', (t) => sse.broadcast('task:update', t));
queue.on('task:progress', (t) => sse.broadcast('task:progress', t));
queue.on('task:remove', (id) => sse.broadcast('task:remove', { id }));
queue.on('queue:pause', (paused) => sse.broadcast('queue:pause', { paused }));

config.load();
config.ensureOutDir();
queue.loadHistory();

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  MANDOM');
  console.log(`  http://127.0.0.1:${PORT}/`);
  console.log(`  输出目录 ${config.get().outDir}`);
  console.log(`  工具 yt-dlp=${config.toolExists('ytdlp')} ffmpeg=${config.toolExists('ffmpeg')}`);
  console.log('');
});
