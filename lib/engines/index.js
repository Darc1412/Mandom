'use strict';
// 引擎注册表。加站点 = 加一个文件 + 这里加一行。

const engines = [
  require('./twitter'),
  require('./direct'),
  require('./ytdlp'),
];

// 按 priority 从小到大试（direct 便宜，先试；ytdlp 更贵但更强）
engines.sort((a, b) => (a.priority || 50) - (b.priority || 50));

async function probe(url, ctx) {
  const failures = [];
  let authError = null;
  for (const e of engines) {
    if (!e.available) continue;
    if (!e.available()) { failures.push(`${e.name}: 工具缺失`); continue; }
    try {
      const item = await e.probe(url, ctx);
      if (item) {
        item.engine = e.name;
        return { item, failures };
      }
      failures.push(`${e.name}: 不认识`);
    } catch (err) {
      failures.push(`${e.name}: ${err.message}`);
      if (err.kind === 'auth') authError = err;
      if (err.kind === 'drm') throw err;
    }
  }
  // 全部失败时，优先把「需要登录」这个原因带出去
  if (authError) throw authError;
  return { item: null, failures };
}

function byName(name) {
  return engines.find((e) => e.name === name) || null;
}

module.exports = { engines, probe, byName };
