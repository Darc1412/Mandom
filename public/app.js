'use strict';

const $ = (sel) => document.querySelector(sel);

const state = {
  tasks: new Map(),
  order: [],
  stats: {},
  settings: {},
  tools: {},
  filter: 'all',
  paused: false,
  pending: [],
};

const nodes = new Map();
const listEl = $('#list');
const emptyHint = $('#emptyHint');

const SITE_LABEL = {
  twitter: 'X', bilibili: 'B站', youtube: 'YouTube', pixiv: 'pixiv',
  konachan: 'Konachan', weibo: '微博', douyin: '抖音',
};

const STATE_LABEL = {
  queued: '排队', downloading: '下载中', done: '完成',
  failed: '失败', canceled: '已取消',
};

/* ---------- 工具函数 ---------- */

function fmtBytes(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

function fmtSpeed(n) {
  return n ? fmtBytes(n) + '/s' : '';
}

function fmtTime(sec) {
  if (!sec || !Number.isFinite(sec)) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function siteLabel(t) {
  return SITE_LABEL[t.site] || t.site || '';
}

function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

/* ---------- 渲染 ---------- */

function createNode(task) {
  const el = document.createElement('div');
  el.className = 'task';
  el.dataset.id = task.id;
  el.innerHTML = `
    <div class="thumb"></div>
    <div class="info">
      <div class="title"></div>
      <div class="meta"></div>
      <div class="bar"><i></i></div>
    </div>
    <div class="state"></div>
    <div class="ops"></div>
  `;
  const thumb = el.querySelector('.thumb');
  thumb.addEventListener('click', () => {
    const t = state.tasks.get(el.dataset.id);
    if (t && t.state === 'done' && t.file) openPreview(t);
  });
  return el;
}

function updateNode(el, task) {
  el.className = `task ${task.state}`;
  el.dataset.id = task.id;

  const thumb = el.querySelector('.thumb');
  const title = el.querySelector('.title');
  const meta = el.querySelector('.meta');
  const bar = el.querySelector('.bar i');
  const stateEl = el.querySelector('.state');
  const ops = el.querySelector('.ops');

  title.textContent = task.title || task.url;
  title.title = task.title || '';

  const parts = [siteLabel(task), task.author, task.date].filter(Boolean);
  meta.textContent = parts.join(' · ') + (task.engine ? ` · ${task.engine}` : '');

  if (task.thumb && thumb.dataset.loaded !== task.thumb) {
    thumb.dataset.loaded = task.thumb;
    thumb.textContent = '';
    const img = document.createElement('img');
    img.src = task.thumb;
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => { img.remove(); thumb.textContent = siteLabel(task) || '视频'; };
    thumb.appendChild(img);
  } else if (!task.thumb && !thumb.textContent) {
    thumb.textContent = siteLabel(task) || '视频';
  }
  thumb.classList.toggle('playable', task.state === 'done' && !!task.file);

  const p = task.progress || {};
  let pct = 0;
  if (task.state === 'done') pct = 100;
  else if (task.state === 'downloading') pct = Math.max(0, Math.min(100, p.percent || 0));
  bar.style.width = pct + '%';

  if (task.state === 'downloading') {
    stateEl.innerHTML = `<div class="pct">${pct.toFixed(1)}%</div>
      <div class="speed">${fmtSpeed(p.speed) || fmtBytes(p.bytes)}${p.eta ? ' · ' + fmtTime(p.eta) : ''}</div>`;
  } else if (task.state === 'failed') {
    const short = String(task.error || '失败').replace(/^Error:\s*/, '').slice(0, 26);
    stateEl.innerHTML = `<div class="err" title="${escapeHtml(task.error)}">${escapeHtml(short)}</div>`;
  } else {
    stateEl.innerHTML = `<div>${STATE_LABEL[task.state] || task.state}</div>`;
  }

  ops.innerHTML = '';
  if (task.state === 'downloading' || task.state === 'queued') {
    ops.appendChild(opBtn('取消', 'cancel'));
  } else if (task.state === 'failed' || task.state === 'canceled') {
    ops.appendChild(opBtn('重试', 'retry'));
  } else if (task.state === 'done') {
    ops.appendChild(opBtn('文件夹', 'reveal'));
  }
  if (task.state !== 'downloading') {
    ops.appendChild(opBtn('移除', 'remove'));
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function opBtn(label, action) {
  const b = document.createElement('button');
  b.className = 'btn ghost small';
  b.textContent = label;
  b.onclick = (e) => {
    e.stopPropagation();
    const id = b.closest('.task').dataset.id;
    doAction(id, action);
  };
  return b;
}

function upsert(task) {
  const isNew = !state.tasks.has(task.id);
  state.tasks.set(task.id, task);
  if (isNew) state.order.push(task.id);

  let el = nodes.get(task.id);
  if (!el) {
    el = createNode(task);
    nodes.set(task.id, el);
    listEl.appendChild(el);
  }
  updateNode(el, task);
  applyFilter();
  refreshStats();
}

function removeNode(id) {
  const el = nodes.get(id);
  if (el) el.remove();
  nodes.delete(id);
  state.tasks.delete(id);
  state.order = state.order.filter((x) => x !== id);
  applyFilter();
  refreshStats();
}

function applyFilter() {
  const f = state.filter;
  let shown = 0;
  for (const [id, el] of nodes) {
    const t = state.tasks.get(id);
    if (!t) { el.style.display = 'none'; continue; }
    let show = true;
    if (f === 'active') show = t.state === 'queued' || t.state === 'downloading';
    else if (f === 'done') show = t.state === 'done';
    else if (f === 'failed') show = t.state === 'failed' || t.state === 'canceled';
    el.style.display = show ? '' : 'none';
    if (show) shown++;
  }
  emptyHint.style.display = shown ? 'none' : '';
}

function refreshStats() {
  let q = 0, d = 0, done = 0, failed = 0;
  for (const t of state.tasks.values()) {
    if (t.state === 'queued') q++;
    else if (t.state === 'downloading') d++;
    else if (t.state === 'done') done++;
    else if (t.state === 'failed' || t.state === 'canceled') failed++;
  }
  const total = state.tasks.size;
  $('#stats').textContent = `共 ${total} 条 · 完成 ${done} · 进行中 ${d + q} · 失败 ${failed}`;
}

/* ---------- 操作 ---------- */

async function doAction(id, action) {
  if (action === 'reveal') {
    const t = state.tasks.get(id);
    if (!t || !t.file) return toast('文件还没下载完');
    const r = await postJson('/api/reveal', { path: t.file });
    if (!r.ok) toast('打不开：' + (r.error || '未知错误'));
    return;
  }
  const r = await postJson(`/api/tasks/${id}/${action}`, {});
  if (!r.ok) toast('操作失败');
}

async function postJson(url, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/* ---------- 提交 ---------- */

function readUrls() {
  return $('#urls').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

async function submit() {
  const urls = readUrls();
  if (!urls.length) return toast('先粘贴链接');

  const btn = $('#btnSubmit');
  btn.disabled = true;
  btn.textContent = '处理中…';
  $('#feedback').className = 'feedback';
  $('#feedback').textContent = '';

  try {
    if ($('#autoStart').checked) {
      const r = await postJson('/api/tasks', { urls });
      if (r.error) throw new Error(r.error);
      const okInputs = new Set((r.accepted || []).map((a) => a.input));
      const failed = r.failed || [];
      const remain = urls.filter((u) => !okInputs.has(u));
      $('#urls').value = remain.join('\n');
      updateLineCount();

      const okCount = (r.accepted || []).length;
      let msg = `已加入 ${okCount} 条`;
      if (failed.length) msg += `，${failed.length} 条失败`;
      const fb = $('#feedback');
      fb.className = 'feedback ' + (failed.length ? 'warn' : 'ok');
      fb.innerHTML = escapeHtml(msg) +
        failed.slice(0, 6).map((f) => `<div class="dim">· ${escapeHtml(f.input.slice(0, 50))} — ${escapeHtml(f.reason)}</div>`).join('') +
        (failed.length > 6 ? `<div class="dim">… 还有 ${failed.length - 6} 条</div>` : '');
    } else {
      const r = await postJson('/api/resolve', { urls });
      if (r.error) throw new Error(r.error);
      const results = r.results || [];
      const ok = results.filter((x) => x.ok).map((x) => x.item);
      const bad = results.filter((x) => !x.ok);
      state.pending = ok;
      const keep = results.filter((x) => !x.ok).map((x) => x.input);
      $('#urls').value = keep.join('\n');
      updateLineCount();
      renderPending();
      const fb = $('#feedback');
      fb.className = 'feedback ' + (bad.length ? 'warn' : 'ok');
      fb.textContent = `识别到 ${ok.length} 条` + (bad.length ? `，${bad.length} 条无法识别（已留在框里）` : '');
    }
  } catch (e) {
    const fb = $('#feedback');
    fb.className = 'feedback err';
    fb.textContent = String(e.message || e);
  } finally {
    btn.disabled = false;
    btn.textContent = '收集';
  }
}

function renderPending() {
  const box = $('#pending');
  if (!state.pending.length) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  box.classList.remove('hidden');
  box.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <span class="dim">待确认 ${state.pending.length} 条</span>
      <button class="btn primary small" id="btnConfirm">全部添加</button>
    </div>` +
    state.pending.map((it) => `<div class="pending-item"><span class="t">${escapeHtml(it.title || it.url)}</span><span class="dim">${escapeHtml(siteLabel(it))}</span></div>`).join('');
  $('#btnConfirm').onclick = async () => {
    const urls = state.pending.map((x) => x.url);
    const r = await postJson('/api/tasks', { urls });
    state.pending = [];
    renderPending();
    const fb = $('#feedback');
    fb.className = 'feedback ok';
    fb.textContent = `已加入 ${(r.accepted || []).length} 条`;
  };
}

/* ---------- 预览 ---------- */

let previewTask = null;

function openPreview(task) {
  previewTask = task;
  const modal = $('#preview');
  const video = $('#player');
  const fallback = $('#previewFallback');
  $('#previewTitle').textContent = task.title || '预览';
  $('#previewMeta').textContent = task.file || '';
  fallback.classList.add('hidden');
  video.classList.remove('hidden');
  video.src = `/api/media?path=${encodeURIComponent(task.file)}`;
  video.play().catch(() => {});
  modal.classList.remove('hidden');
}

function closePreview() {
  const video = $('#player');
  video.pause();
  video.removeAttribute('src');
  video.load();
  $('#preview').classList.add('hidden');
  previewTask = null;
}

/* ---------- 设置 ---------- */

async function loadState() {
  const r = await fetch('/api/state').then((x) => x.json());
  state.settings = r.settings || {};
  state.tools = r.tools || {};
  state.cookies = r.cookies || {};
  state.tasks.clear();
  state.order = [];
  nodes.clear();
  listEl.querySelectorAll('.task').forEach((n) => n.remove());
  for (const t of r.tasks || []) upsert(t);
  refreshSettingsUI();
  refreshCookieDot();
  applyFilter();
  refreshStats();
}

function refreshCookieDot() {
  const ck = state.cookies || {};
  const dot = $('#cookieDot');
  let cls = 'dot';
  if (ck.exists && ck.hasAuth) cls += ' ok';
  if (state.cookieTest && state.cookieTest.valid === false) cls = 'dot bad';
  dot.className = cls;
}

function updateCookieStatusLine() {
  const ck = state.cookies || {};
  const line = $('#cookieStatusLine');
  if (!ck.exists) {
    line.className = 'cookie-status';
    line.textContent = '未配置 cookie';
    return;
  }
  const when = ck.mtime ? new Date(ck.mtime).toLocaleString() : '';
  line.className = 'cookie-status ' + (ck.hasAuth ? 'ok' : 'bad');
  let text = `${ck.count} 条 · ${ck.hasAuth ? '含登录态' : '缺 auth_token'}${when ? ' · 更新于 ' + when : ''}`;
  if (state.cookieTest) {
    text += state.cookieTest.valid
      ? ' · 检测有效'
      : ` · 检测无效：${state.cookieTest.reason || '未知'}`;
  }
  line.textContent = text;
}

async function openCookieModal() {
  $('#cookieModal').classList.remove('hidden');
  $('#cookieMsg').textContent = '';
  $('#cookieMsg').className = 'feedback';
  $('#cookieInput').value = '';
  updateCookieStatusLine();
}

async function saveCookie() {
  const raw = $('#cookieInput').value;
  if (!raw.trim()) return toast('先粘贴 cookie 内容');
  const r = await postJson('/api/cookies', { raw });
  const msg = $('#cookieMsg');
  if (r.ok) {
    state.cookies = r.status;
    state.cookieTest = null;
    $('#cookieInput').value = '';
    msg.className = 'feedback ok';
    msg.textContent = `已保存 ${r.count} 条 cookie`;
    updateCookieStatusLine();
    refreshCookieDot();
    toast('cookie 已更新');
  } else {
    msg.className = 'feedback err';
    msg.textContent = r.error || '保存失败';
  }
}

async function testCookie() {
  const msg = $('#cookieMsg');
  msg.className = 'feedback';
  msg.textContent = '检测中…';
  const r = await postJson('/api/cookies/test', {});
  state.cookieTest = r;
  msg.className = 'feedback ' + (r.valid ? 'ok' : 'err');
  msg.textContent = r.valid
    ? `cookie 有效${r.userId ? '（用户 ID ' + r.userId + '）' : ''}`
    : (r.reason || '无效');
  updateCookieStatusLine();
  refreshCookieDot();
}

async function clearCookie() {
  const r = await fetch('/api/cookies', { method: 'DELETE' }).then((x) => x.json());
  if (r.ok) {
    state.cookies = r.status;
    state.cookieTest = null;
    updateCookieStatusLine();
    refreshCookieDot();
    $('#cookieMsg').className = 'feedback ok';
    $('#cookieMsg').textContent = '已清空';
  }
}


/* ---------- 磁力搜索 ---------- */

function fmtSize(n) {
  if (!n) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

function fmtDate(ts) {
  if (!ts) return '';
  try { return new Date(ts * 1000).toLocaleDateString(); } catch { return ''; }
}

let lastTorrentQuery = '';
let torrentOrder = 'desc';
let torrentMode = 'precise';

const TORRENT_SOURCES = [
  { id: 'apibay', label: 'TPB' },
  { id: 'nyaa', label: 'Nyaa' },
  { id: 'rutor', label: 'Rutor' },
  { id: 'limetorrents', label: 'Lime' },
  { id: 'bitsearch', label: 'BitSearch' },
];
let torrentSources = ['apibay', 'nyaa', 'rutor'];

function renderSourceChips() {
  const box = $('#tsources');
  if (!box) return;
  box.innerHTML = '';
  for (const s of TORRENT_SOURCES) {
    const b = document.createElement('button');
    b.className = 'chip' + (torrentSources.includes(s.id) ? ' on' : '');
    b.textContent = s.label;
    b.onclick = () => {
      if (torrentSources.includes(s.id)) {
        if (torrentSources.length === 1) return toast('至少留一个源');
        torrentSources = torrentSources.filter((x) => x !== s.id);
      } else {
        torrentSources = [...torrentSources, s.id];
      }
      renderSourceChips();
      if ($('#tq').value.trim()) torrentSearch(true);
    };
    box.appendChild(b);
  }
}

async function torrentSearch(force) {
  const q = $('#tq').value.trim();
  if (!q) return;
  const isRepeat = q === lastTorrentQuery;
  lastTorrentQuery = q;
  const btn = $('#tbtn');
  btn.disabled = true;
  btn.textContent = '搜索中…';
  $('#tstats').textContent = torrentMode === 'fast' ? '快速模式查询中…' : '并发查询多个源…';
  try {
    const expand = $('#texpand').checked ? '1' : '0';
    const sort = $('#tsort').value;
    const useForce = force || isRepeat ? '1' : '0';
    const srcParam = encodeURIComponent(torrentSources.join(','));
    const r = await fetch(`/api/torrent/search?q=${encodeURIComponent(q)}&mode=${torrentMode}&sources=${srcParam}&sort=${sort}&order=${torrentOrder}&expand=${expand}&force=${useForce}`)
      .then((x) => x.json());
    if (r.error) throw new Error(r.error);
    renderTorrentResults(r);
  } catch (e) {
    $('#tstats').textContent = '搜索失败：' + (e.message || e);
    $('#tlist').innerHTML = '';
  } finally {
    btn.disabled = false;
    btn.textContent = '搜索';
  }
}

const TORRENT_PAGE_SIZE = 40;
let torrentPageData = [];
let torrentPage = 1;

function renderTorrentResults(r) {
  const st = r.stats || {};
  const srcText = (st.sources || []).map((s) => `${s.label}${s.ok ? ' ' + s.count : ' ✕'}`).join(' · ');
  let text = `${r.results.length} 条 · ${srcText} · ${((st.elapsed || 0) / 1000).toFixed(1)}s`;
  if (st.aliases && st.aliases.length) text += ` · 别名：${st.aliases.join(' / ')}`;
  if (st.filtered) text += ` · 过滤垃圾 ${st.filtered}`;
  if (st.irrelevant) text += ` · 排除不相关 ${st.irrelevant}`;
  $('#tstats').textContent = text;

  torrentPageData = r.results;
  torrentPage = 1;
  renderTorrentPage();
}

function renderTorrentPage() {
  const list = $('#tlist');
  const pager = $('#tPager');
  list.innerHTML = '';

  const total = torrentPageData.length;
  if (!total) {
    pager.classList.add('hidden');
    list.innerHTML = '<div class="empty"><p>没有结果</p><p class="dim">换个关键词，或者关掉别名扩展试试</p></div>';
    return;
  }

  const pages = Math.max(1, Math.ceil(total / TORRENT_PAGE_SIZE));
  if (torrentPage > pages) torrentPage = pages;
  if (torrentPage < 1) torrentPage = 1;
  const start = (torrentPage - 1) * TORRENT_PAGE_SIZE;
  const items = torrentPageData.slice(start, start + TORRENT_PAGE_SIZE);

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 't-row';
    const srcs = (item.sources || []).join('+');
    row.innerHTML = `
      <div>
        <div class="t-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
        <div class="t-meta">${escapeHtml(srcs)} · ${fmtSize(item.size)} · ${fmtDate(item.added)}${item.files ? ' · ' + item.files + ' 个文件' : ''}</div>
      </div>
      <div class="t-seed"><span class="s">▲ ${item.seeders}</span><span class="l">▼ ${item.leechers}</span></div>
      <div class="t-ops">
        <button class="btn ghost small" data-act="copy">复制磁力</button>
        <button class="btn ghost small" data-act="detail">详情</button>
      </div>
    `;
    row.querySelector('[data-act="copy"]').onclick = () => copyMagnet(item);
    row.querySelector('[data-act="detail"]').onclick = () => showTorrentDetail(item);
    list.appendChild(row);
  }

  // 分页
  if (pages <= 1) {
    pager.classList.add('hidden');
    pager.innerHTML = '';
    return;
  }
  pager.classList.remove('hidden');
  pager.innerHTML = `
    <button class="btn ghost small" data-pg="first" ${torrentPage === 1 ? 'disabled' : ''}>«</button>
    <button class="btn ghost small" data-pg="prev" ${torrentPage === 1 ? 'disabled' : ''}>上一页</button>
    <span class="pager-info">${torrentPage} / ${pages} 页 · 共 ${total} 条</span>
    <button class="btn ghost small" data-pg="next" ${torrentPage === pages ? 'disabled' : ''}>下一页</button>
    <button class="btn ghost small" data-pg="last" ${torrentPage === pages ? 'disabled' : ''}>»</button>
  `;
  pager.querySelectorAll('[data-pg]').forEach((b) => {
    b.onclick = () => {
      const act = b.dataset.pg;
      if (act === 'first') torrentPage = 1;
      else if (act === 'last') torrentPage = pages;
      else if (act === 'prev') torrentPage = Math.max(1, torrentPage - 1);
      else if (act === 'next') torrentPage = Math.min(pages, torrentPage + 1);
      renderTorrentPage();
      $('#tlist').scrollTop = 0;
    };
  });
}

async function copyMagnet(item) {
  try {
    await navigator.clipboard.writeText(item.magnet);
    toast('已复制磁力链接');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = item.magnet;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('已复制磁力链接');
  }
}

async function showTorrentDetail(item) {
  $('#torrentDetail').classList.remove('hidden');
  $('#tdTitle').textContent = item.title;
  $('#tdMeta').textContent = `${fmtSize(item.size)} · 做种 ${item.seeders} · ${(item.sources || []).join('+')}`;
  $('#tdFiles').innerHTML = '<div class="f"><span>加载中…</span></div>';
  try {
    if (!item.torrentUrl) throw new Error('这个源不提供 .torrent 文件');
    const d = await fetch(`/api/torrent/detail?url=${encodeURIComponent(item.torrentUrl)}`).then((x) => x.json());
    if (!d.ok) throw new Error(d.error || '取不到种子信息');
    $('#tdFiles').innerHTML = d.files
      .map((f) => `<div class="f"><span>${escapeHtml(f.path)}</span><span>${fmtSize(f.size)}</span></div>`)
      .join('');
    $('#tdMeta').textContent = `${d.files.length} 个文件 · 共 ${fmtSize(d.totalSize)}`;
  } catch (e) {
    $('#tdFiles').innerHTML = `<div class="f"><span>${escapeHtml(e.message || String(e))}</span></div>`;
  }
}

function switchView(name) {
  document.querySelectorAll('.view-tab').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $('#viewCollector').classList.toggle('hidden', name !== 'collector');
  $('#viewTorrent').classList.toggle('hidden', name !== 'torrent');
}


function refreshSettingsUI() {
  $('#outDirText').textContent = state.settings.outDir || '—';
  $('#outDirText').title = state.settings.outDir || '';
  $('#autoStart').checked = state.settings.autoStart !== false;
  const missing = [];
  if (!state.tools.ytdlp) missing.push('yt-dlp');
  if (!state.tools.ffmpeg) missing.push('ffmpeg');
  const ck = state.cookies || {};
  const ckText = ck.exists
    ? `X cookie 已加载 ${ck.count} 条${ck.hasAuth ? '（含登录态）' : '（缺 auth_token，可能没登录）'}`
    : 'X cookie 未配置，敏感内容下不了';
  $('#toolHint').textContent =
    (missing.length ? `缺少工具：${missing.join('、')}。视频站可能无法下载。` : '工具就绪：yt-dlp + ffmpeg') +
    ' · ' + ckText;
}

async function changeOutDir() {
  const cur = state.settings.outDir || '';
  const v = prompt('输出目录（绝对路径）', cur);
  if (!v || v === cur) return;
  const r = await postJson('/api/settings', { outDir: v.trim() });
  if (r.ok) {
    state.settings = r.settings;
    refreshSettingsUI();
    toast('输出目录已更新');
  } else {
    toast('设置失败');
  }
}

/* ---------- SSE ---------- */

function connectSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('task:add', (e) => upsert(JSON.parse(e.data)));
  es.addEventListener('task:update', (e) => upsert(JSON.parse(e.data)));
  es.addEventListener('task:progress', (e) => {
    const t = JSON.parse(e.data);
    state.tasks.set(t.id, t);
    const el = nodes.get(t.id);
    if (el) updateNode(el, t);
    refreshStats();
  });
  es.addEventListener('task:remove', (e) => removeNode(JSON.parse(e.data).id));
  es.addEventListener('queue:pause', (e) => {
    state.paused = JSON.parse(e.data).paused;
    $('#btnPause').textContent = state.paused ? '继续' : '暂停';
  });
  es.onerror = () => {
    setTimeout(() => {
      es.close();
      connectSSE();
    }, 3000);
  };
}

/* ---------- 事件绑定 ---------- */

function updateLineCount() {
  const n = readUrls().length;
  $('#lineCount').textContent = `${n} 行`;
}

/* ---------- tooltip ---------- */

let tipTimer = null;
let tipEl = null;

function ensureTip() {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'tip';
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

function showTip(target) {
  const text = target.getAttribute('data-tip');
  if (!text) return;
  const el = ensureTip();
  el.textContent = text;
  el.classList.remove('show');
  el.style.left = '-9999px';
  el.style.top = '0px';
  const r = target.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  let top = r.bottom + 8;
  if (top + h > window.innerHeight - 8) top = r.top - h - 8;
  el.style.left = left + 'px';
  el.style.top = Math.max(8, top) + 'px';
  requestAnimationFrame(() => el.classList.add('show'));
}

function hideTip() {
  if (tipEl) tipEl.classList.remove('show');
}

function initTooltips() {
  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (!t) return;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => showTip(t), 1500);
  });
  document.addEventListener('mouseout', (e) => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (!t) return;
    clearTimeout(tipTimer);
    hideTip();
  });
}

function init() {
  $('#btnSubmit').onclick = submit;
  $('#urls').addEventListener('input', updateLineCount);
  $('#urls').addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); submit(); }
  });
  $('#autoStart').onchange = async (e) => {
    const r = await postJson('/api/settings', { autoStart: e.target.checked });
    if (r.ok) state.settings = r.settings;
  };
  $('#btnChangeOut').onclick = changeOutDir;
  $('#btnOpenOut').onclick = () => postJson('/api/open', { path: state.settings.outDir || '' });
  $('#btnPause').onclick = async () => {
    await postJson('/api/queue', { action: state.paused ? 'resume' : 'pause' });
  };
  $('#btnClearDone').onclick = async () => {
    for (const t of [...state.tasks.values()]) {
      if (t.state === 'done') await doAction(t.id, 'remove');
    }
  };
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (!b) return;
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
    state.filter = b.dataset.filter;
    applyFilter();
  });
  $('#btnClosePreview').onclick = closePreview;
  $('#btnCookie').onclick = openCookieModal;
  $('#btnCloseCookie').onclick = () => $('#cookieModal').classList.add('hidden');
  $('#cookieModal').addEventListener('click', (e) => {
    if (e.target.id === 'cookieModal') $('#cookieModal').classList.add('hidden');
  });
  $('#btnSaveCookie').onclick = saveCookie;
  $('#btnTestCookie').onclick = testCookie;
  $('#btnClearCookie').onclick = clearCookie;
  document.querySelectorAll('.view-tab').forEach((b) => {
    b.onclick = () => switchView(b.dataset.view);
  });
  $('#tbtn').onclick = torrentSearch;
  renderSourceChips();
  document.querySelectorAll('.mode-btn').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.mode-btn').forEach((x) => x.classList.toggle('active', x === b));
      torrentMode = b.dataset.mode;
      if ($('#tq').value.trim()) torrentSearch(true);
    };
  });
  initTooltips();
  $('#tsort').onchange = () => torrentSearch(false);
  $('#torder').onclick = () => {
    torrentOrder = torrentOrder === 'desc' ? 'asc' : 'desc';
    $('#torder').textContent = torrentOrder === 'desc' ? '↓ 降序' : '↑ 升序';
    torrentSearch(false);
  };
  $('#tq').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); torrentSearch(); }
  });
  $('#tdClose').onclick = () => $('#torrentDetail').classList.add('hidden');
  $('#torrentDetail').addEventListener('click', (e) => {
    if (e.target.id === 'torrentDetail') $('#torrentDetail').classList.add('hidden');
  });
  $('#preview').addEventListener('click', (e) => {
    if (e.target.id === 'preview') closePreview();
  });
  $('#player').addEventListener('error', () => {
    $('#player').classList.add('hidden');
    $('#previewFallback').classList.remove('hidden');
  });
  $('#btnOpenFile').onclick = () => {
    if (previewTask) postJson('/api/open', { path: previewTask.file });
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePreview();
  });

  loadState();
  connectSSE();
  updateLineCount();
}

init();
