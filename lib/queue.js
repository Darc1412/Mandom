'use strict';
// 任务队列：唯一的状态所有者。并发、重试、取消。通过事件对外广播。

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const engines = require('./engines');
const store = require('./store');
const { createTask } = require('./models');

const MAX_KEEP = 300;

class Queue extends EventEmitter {
  constructor() {
    super();
    this.tasks = new Map();
    this.order = [];
    this.running = new Set();
    this.children = new Map();
    this.paused = false;
    this.emitTimer = null;
    this.dirty = false;
  }

  add(items) {
    const added = [];
    for (const item of items) {
      const existing = this.tasks.get(item.id);
      if (existing) {
        if (existing.state === 'failed' || existing.state === 'canceled') {
          existing.state = 'queued';
          existing.error = '';
          existing.progress = { percent: 0, bytes: 0, total: 0, speed: 0, eta: 0 };
          this.emitUpdate(existing);
        }
        continue;
      }
      const t = createTask(item);
      this.tasks.set(t.id, t);
      this.order.push(t.id);
      added.push(t);
      this.emit('task:add', this.public(t));
    }
    this.trim();
    this.pump();
    return added;
  }

  trim() {
    while (this.order.length > MAX_KEEP) {
      const id = this.order.shift();
      const t = this.tasks.get(id);
      if (t && (t.state === 'done' || t.state === 'failed' || t.state === 'canceled')) {
        this.tasks.delete(id);
      } else if (id) {
        this.order.push(id);
        break;
      }
    }
  }

  pump() {
    if (this.paused) return;
    const limit = Math.max(1, Number(config.get().concurrency) || 2);
    for (const id of this.order) {
      if (this.running.size >= limit) break;
      const t = this.tasks.get(id);
      if (!t || t.state !== 'queued' || this.running.has(id)) continue;
      this.run(t);
    }
  }

  async run(task) {
    const engine = engines.byName(task.item.engine);
    if (!engine) {
      task.state = 'failed';
      task.error = `没有找到引擎：${task.item.engine}`;
      this.emitUpdate(task);
      return;
    }
    this.running.add(task.id);
    task.state = 'downloading';
    task.startedAt = Date.now();
    task.progress = { percent: 0, bytes: 0, total: 0, speed: 0, eta: 0 };
    this.emitUpdate(task);

    const ctx = {
      registerChild: (child) => {
        if (!this.children.has(task.id)) this.children.set(task.id, new Set());
        this.children.get(task.id).add(child);
      },
      unregisterChild: (child) => {
        const set = this.children.get(task.id);
        if (set) set.delete(child);
      },
    };

    let lastEmit = 0;
    const onProgress = (p) => {
      task.progress = Object.assign({}, task.progress, p);
      const now = Date.now();
      if (now - lastEmit > 180) {
        lastEmit = now;
        this.emit('task:progress', this.public(task));
      }
    };

    try {
      const res = await engine.download(task, ctx, onProgress);
      const files = store.commit(task, res.files);
      task.state = 'done';
      task.file = files[0] || '';
      task.progress.percent = 100;
      task.finishedAt = Date.now();
      this.dirty = true;
    } catch (err) {
      task.state = 'failed';
      task.error = String(err && err.message || err).slice(0, 400);
      task.finishedAt = Date.now();
      task.log.push(task.error);
      this.dirty = true;
    } finally {
      const set = this.children.get(task.id);
      if (set) { for (const c of set) { try { c.kill(); } catch {} } }
      this.children.delete(task.id);
      this.running.delete(task.id);
      this.emitUpdate(task);
      this.scheduleSave();
      this.pump();
    }
  }

  retry(id) {
    const t = this.tasks.get(id);
    if (!t || t.state === 'downloading' || t.state === 'queued') return false;
    t.state = 'queued';
    t.error = '';
    t.progress = { percent: 0, bytes: 0, total: 0, speed: 0, eta: 0 };
    this.emitUpdate(t);
    this.pump();
    return true;
  }

  cancel(id) {
    const t = this.tasks.get(id);
    if (!t) return false;
    if (t.state === 'queued') {
      t.state = 'canceled';
      this.emitUpdate(t);
      return true;
    }
    if (t.state === 'downloading') {
      const set = this.children.get(id);
      if (set) for (const c of set) { try { c.kill(); } catch {} }
      t.state = 'canceled';
      this.finishedAt = Date.now();
      this.emitUpdate(t);
      return true;
    }
    return false;
  }

  remove(id) {
    const t = this.tasks.get(id);
    if (!t || t.state === 'downloading') return false;
    this.tasks.delete(id);
    const i = this.order.indexOf(id);
    if (i >= 0) this.order.splice(i, 1);
    this.emit('task:remove', id);
    this.dirty = true;
    this.scheduleSave();
    return true;
  }

  setPaused(v) {
    this.paused = !!v;
    if (!this.paused) this.pump();
    this.emit('queue:pause', this.paused);
  }

  emitUpdate(task) {
    this.emit('task:update', this.public(task));
    this.dirty = true;
  }

  public(task) {
    const it = task.item;
    return {
      id: task.id,
      url: it.url,
      site: it.site,
      kind: it.kind,
      title: it.title,
      author: it.author,
      date: it.date,
      thumb: it.thumb,
      duration: it.duration,
      engine: it.engine,
      state: task.state,
      progress: task.progress,
      file: task.file,
      error: task.error,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
    };
  }

  list() {
    return this.order.map((id) => this.tasks.get(id)).filter(Boolean).map((t) => this.public(t));
  }

  stats() {
    const counts = { queued: 0, downloading: 0, done: 0, failed: 0, canceled: 0 };
    for (const t of this.tasks.values()) counts[t.state] = (counts[t.state] || 0) + 1;
    return { total: this.tasks.size, ...counts, paused: this.paused, concurrency: Number(config.get().concurrency) || 2 };
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 800);
  }

  save() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      const keep = this.list().slice(-MAX_KEEP);
      fs.mkdirSync(config.DATA, { recursive: true });
      fs.writeFileSync(
        path.join(config.DATA, 'tasks.json'),
        JSON.stringify(keep, null, 2),
        'utf8',
      );
    } catch (e) {
      console.error('[queue] 保存失败', e.message);
    }
  }

  // 重启后恢复历史（只恢复状态，不恢复下载）
  loadHistory() {
    try {
      const raw = fs.readFileSync(path.join(config.DATA, 'tasks.json'), 'utf8');
      const arr = JSON.parse(raw);
      for (const t of arr) {
        if (this.tasks.has(t.id)) continue;
        const task = {
          id: t.id,
          item: {
            id: t.id, url: t.url, site: t.site, kind: t.kind, title: t.title,
            author: t.author, date: t.date, thumb: t.thumb, duration: t.duration,
            engine: t.engine, assets: [], meta: {}, status: 'resolved', error: '',
          },
          state: t.state === 'downloading' || t.state === 'queued' ? 'canceled' : t.state,
          progress: t.progress || { percent: 0, bytes: 0, total: 0, speed: 0, eta: 0 },
          file: t.file || '',
          error: t.error || '',
          log: [],
          startedAt: t.startedAt || 0,
          finishedAt: t.finishedAt || 0,
        };
        this.tasks.set(task.id, task);
        this.order.push(task.id);
      }
    } catch { /* 没有历史 */ }
  }
}

module.exports = new Queue();
