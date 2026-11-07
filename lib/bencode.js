'use strict';
// 极简 bencode 解码，只为解析 .torrent 的文件列表。

function decode(buf) {
  let pos = 0;

  function read() {
    if (pos >= buf.length) throw new Error('bencode 越界');
    const c = buf[pos];
    if (c === 0x69) { // 'i'
      const end = buf.indexOf(0x65, pos);
      if (end < 0) throw new Error('bencode int 未闭合');
      const n = Number(buf.slice(pos + 1, end).toString());
      pos = end + 1;
      return n;
    }
    if (c === 0x6c) { // 'l'
      pos++;
      const arr = [];
      while (buf[pos] !== 0x65) arr.push(read());
      pos++;
      return arr;
    }
    if (c === 0x64) { // 'd'
      pos++;
      const obj = {};
      while (buf[pos] !== 0x65) {
        const k = String(read());
        obj[k] = read();
      }
      pos++;
      return obj;
    }
    if (c >= 0x30 && c <= 0x39) {
      const colon = buf.indexOf(0x3a, pos);
      if (colon < 0) throw new Error('bencode string 未闭合');
      const len = Number(buf.slice(pos, colon).toString());
      if (!Number.isFinite(len) || len < 0) throw new Error('bencode 长度异常');
      const s = buf.slice(colon + 1, colon + 1 + len);
      pos = colon + 1 + len;
      return s;
    }
    throw new Error('bencode 未知类型 0x' + c.toString(16));
  }

  return read();
}

function torrentFiles(t) {
  const info = (t && t.info) || {};
  const name = String(info['name.utf-8'] || info.name || '');
  if (Array.isArray(info.files)) {
    return info.files.map((f) => {
      const parts = f['path.utf-8'] || f.path || [];
      return {
        path: parts.map((p) => Buffer.isBuffer(p) ? p.toString('utf8') : String(p)).join('/'),
        size: Number(f.length) || 0,
      };
    });
  }
  return [{ path: name, size: Number(info.length) || 0 }];
}

module.exports = { decode, torrentFiles };
