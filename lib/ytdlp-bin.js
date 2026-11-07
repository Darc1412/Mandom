'use strict';
// yt-dlp 启动方式解析：优先用 tools/yt-dlp.exe；
// 如果 exe 在当前环境跑不起来（比如 PyInstaller 被限制），退回项目内 vendor/ 的 Python 模块。

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const config = require('./config');

let cached;
const PY_CANDIDATES = [
  process.env.COLLECTOR_PYTHON,
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'),
  'python',
  'python3',
];

function findPython() {
  for (const c of PY_CANDIDATES) {
    if (!c) continue;
    if (c.includes(path.sep) || c.includes('/')) {
      if (fs.existsSync(c)) return c;
      continue;
    }
    return c; // 交给 PATH
  }
  return 'python';
}

function tryRun(exe, args, env) {
  try {
    const r = spawnSync(exe, args, {
      timeout: 25000,
      windowsHide: true,
      stdio: 'ignore',
      env: env ? { ...process.env, ...env } : process.env,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

function resolveBin() {
  if (cached !== undefined) return cached;

  const exe = config.tool('ytdlp');
  if (fs.existsSync(exe) && tryRun(exe, ['--version'])) {
    cached = { kind: 'exe', exe, prefix: [], env: null, python: '' };
    return cached;
  }

  const vendor = path.join(config.ROOT, 'vendor');
  const py = findPython();
  if (fs.existsSync(path.join(vendor, 'yt_dlp')) && tryRun(py, ['-m', 'yt_dlp', '--version'], { PYTHONPATH: vendor })) {
    cached = { kind: 'python', exe: py, prefix: ['-m', 'yt_dlp'], env: { PYTHONPATH: vendor }, python: py };
    return cached;
  }

  cached = null;
  return cached;
}

function build(args) {
  const b = resolveBin();
  if (!b) return null;
  return {
    exe: b.exe,
    args: [...b.prefix, ...args],
    env: b.env,
    kind: b.kind,
  };
}

function available() {
  return !!resolveBin();
}

function kind() {
  const b = resolveBin();
  return b ? b.kind : '';
}

function reset() { cached = undefined; }

module.exports = { build, available, kind, reset, findPython };
