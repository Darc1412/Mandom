'use strict';
// 存储层：把引擎下的临时文件按模板移入输出目录，写 sidecar。

const fs = require('fs');
const path = require('path');
const config = require('./config');

function safeName(s, max = 90) {
  return String(s || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, max);
}

function renderTemplate(task) {
  const t = config.get().namingTemplate || '{author}_{date}_{id}_{title}';
  const item = task.item;
  const ext = path.extname(task.file || '') || (item.assets[0] && ('.' + item.assets[0].ext)) || '.mp4';
  // 标题本身可能带 .mp4 这类后缀，先剥掉，避免 xxx.mp4.mp4
  const title = safeName(item.title || '', 80).replace(/\.(mp4|m4v|webm|mkv|mov|flv|ts|m3u8)$/i, '');
  const base = t
    .replace(/\{author\}/g, safeName(item.author || 'unknown', 40))
    .replace(/\{date\}/g, item.date || '')
    .replace(/\{id\}/g, item.id.slice(0, 8))
    .replace(/\{site\}/g, item.site || '')
    .replace(/\{title\}/g, title)
    .split(path.sep).join('_');
  return safeName(base || item.id, 160) + ext;
}

function uniquePath(dir, filename) {
  let p = path.join(dir, filename);
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  for (let i = 2; i < 1000; i++) {
    p = path.join(dir, `${stem}_${i}${ext}`);
    if (!fs.existsSync(p)) return p;
  }
  return path.join(dir, `${stem}_${Date.now()}${ext}`);
}

// 任务完成：move 临时文件到输出目录，删临时目录，写 sidecar
function commit(task, files) {
  const outDir = config.ensureOutDir();
  try {
    fs.accessSync(outDir, fs.constants.W_OK);
  } catch {
    throw new Error(`输出目录不可写：${outDir}（换一个目录，或用 start.cmd 自己启动程序）`);
  }

  const moved = [];
  for (const f of files || []) {
    if (!fs.existsSync(f)) continue;
    const name = renderTemplate(Object.assign({}, task, { file: f }));
    const target = uniquePath(outDir, name);
    try {
      fs.renameSync(f, target);
    } catch (e) {
      // 跨盘或权限受限时 rename 会失败，退回复制
      if (e.code === 'EXDEV' || e.code === 'EPERM' || e.code === 'EACCES') {
        try {
          fs.copyFileSync(f, target);
          fs.unlinkSync(f);
        } catch (e2) {
          throw new Error(`无法写入输出目录 ${outDir}：${e2.code || e2.message}`);
        }
      } else {
        throw e;
      }
    }
    moved.push(target);
  }
  const tmp = path.join(config.DATA, 'tmp', task.id);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  return moved;
}

// 去重键：站点 + 资源 id（X 的推文 id、B 站 BV 号等）
function dedupeKey(item) {
  return item.site + ':' + item.id;
}

module.exports = { commit, dedupeKey, safeName, renderTemplate };
