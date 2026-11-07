'use strict';
// 子进程执行层。
// 正常情况下用 pipe 实时读输出；如果运行环境禁止 pipe（沙箱会报 spawn EPERM），
// 自动降级为「输出写临时文件 + 轮询读取」。两种模式对调用方的接口一致。

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function run(exe, args, opts = {}) {
  const { cwd, timeout = 0, onLine, env } = opts;

  const spawnOpts = { cwd, windowsHide: true };
  if (env) spawnOpts.env = { ...process.env, ...env };

  let child = null;
  let mode = 'pipe';
  let killed = false;
  let settled = false;
  let timer = null;
  let pollTimer = null;
  let logPath = '';
  let readPos = 0;
  let buf = '';
  let errText = '';
  let exitCode = null;

  const emit = (text) => {
    buf += text;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) {
      if (line && onLine) {
        try { onLine(line); } catch { /* 回调异常不影响进程 */ }
      }
    }
  };

  const cleanup = () => {
    clearTimeout(timer);
    clearInterval(pollTimer);
    if (logPath) {
      try { fs.unlinkSync(logPath); } catch { /* ignore */ }
      logPath = '';
    }
  };

  const finish = (err) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (buf.trim().length && onLine) { try { onLine(buf.trim()); } catch {} buf = ''; }
    if (err) return reject_(err);
    resolve_({ code: killed ? -1 : (exitCode === null ? 0 : exitCode), err: errText, killed });
  };

  let resolve_;
  let reject_;

  const promise = new Promise((res, rej) => { resolve_ = res; reject_ = rej; });

  const armTimeout = () => {
    if (timeout > 0) {
      timer = setTimeout(() => {
        killed = true;
        try { child && child.kill(); } catch { /* ignore */ }
      }, timeout);
    }
  };

  const onClose = (code) => {
    exitCode = code;
    if (mode === 'file') drain();
    finish(null);
  };

  const drain = () => {
    if (!logPath) return;
    try {
      const size = fs.statSync(logPath).size;
      if (size <= readPos) return;
      const len = size - readPos;
      const fd = fs.openSync(logPath, 'r');
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, readPos);
      fs.closeSync(fd);
      readPos = size;
      emit(b.toString('utf8'));
    } catch { /* 文件可能还没建好 */ }
  };

  const isEperm = (e) => !!(e && (e.code === 'EPERM' || /EPERM/.test(String(e.message || ''))));

  const startPipe = () => {
    try {
      child = spawn(exe, args, { ...spawnOpts, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      if (isEperm(e)) { mode = 'file'; return startFile(); }
      return finish(e);
    }
    child.stdout.on('data', (d) => emit(d.toString('utf8')));
    child.stderr.on('data', (d) => {
      const t = d.toString('utf8');
      errText = (errText + t).slice(-4000);
      emit(t);
    });
    child.on('error', (e) => {
      if (isEperm(e)) {
        mode = 'file';
        try { child.kill(); } catch { /* ignore */ }
        startFile();
        return;
      }
      finish(e);
    });
    child.on('close', (code) => { if (mode === 'pipe') onClose(code); });
    armTimeout();
  };

  const startFile = () => {
    logPath = path.join(os.tmpdir(), `collector-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.log`);
    let fd;
    try {
      fd = fs.openSync(logPath, 'a');
      child = spawn(exe, args, { ...spawnOpts, stdio: ['ignore', fd, fd] });
    } catch (e) {
      return finish(e);
    } finally {
      try { if (fd !== undefined) fs.closeSync(fd); } catch { /* ignore */ }
    }
    child.on('error', (e) => finish(e));
    child.on('close', (code) => { if (mode === 'file') onClose(code); });
    pollTimer = setInterval(drain, 150);
    armTimeout();
  };

  startPipe();

  return {
    promise,
    get mode() { return mode; },
    kill() {
      killed = true;
      try { child && child.kill(); } catch { /* ignore */ }
    },
  };
}

module.exports = { run };
