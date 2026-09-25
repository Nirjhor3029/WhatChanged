/* DB Checker — single page UI (no framework). */
(() => {
  'use strict';

  /* ================================================================ helpers */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => (n === null || n === undefined || n === '' ? '–' : Number(n).toLocaleString());
  const plural = (n, one, many) => `${fmt(n)} ${Number(n) === 1 ? one : many}`;
  const TOKEN = $('meta[name="dbc-token"]').content;
  const bytes = (n) => {
    n = Number(n) || 0;
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(n < 10 ? 1 : 0) : n) + ' ' + u[i];
  };
  const ago = (iso) => {
    if (!iso) return '';
    const s = Math.round((Date.now() - new Date(iso)) / 1000);
    if (s < 10) return 'just now';
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  };
  const clock = (iso) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const between = (a, b) => {
    const s = Math.abs(Math.round((new Date(b) - new Date(a)) / 1000));
    if (s < 60) return s + ' sec';
    if (s < 3600) return Math.round(s / 60) + ' min';
    if (s < 86400) return (s / 3600).toFixed(1) + ' h';
    return Math.round(s / 86400) + ' days';
  };
  const ls = {
    get(k, d) { try { const v = localStorage.getItem('dbc:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('dbc:' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function api(action, body = {}) {
    let res;
    try {
      res = await fetch('/api/' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DBC-Token': TOKEN },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error('DB Checker server is not reachable — is `npm start` still running?');
    }
    let j;
    try { j = await res.json(); } catch { throw new Error(`Server returned an invalid response (${res.status})`); }
    if (!j.ok) throw new Error(j.error || 'Request failed');
    return j.data;
  }

  function toast(msg, type = 'ok', ms = 4200) {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.innerHTML = `<span class="ti">${type === 'err' ? '✕' : type === 'warn' ? '!' : '✓'}</span><div>${msg}</div>`;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .3s, transform .3s'; el.style.opacity = '0'; el.style.transform = 'translateY(6px)'; }, ms);
    setTimeout(() => el.remove(), ms + 350);
  }

  /* ================================================================ icons */
  const P = {
    db: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"/><path d="M3 21v-5h5"/>',
    camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    report: '<path d="M9 17V11M13 17V7M17 17v-4"/><rect x="3" y="3" width="18" height="18" rx="3"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    chev: '<path d="m6 9 6 6 6-6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    flag: '<path d="M4 22V4a1 1 0 0 1 1-1h13l-2 5 2 5H5"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
    alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10"/>',
    cols: '<path d="M4 4h4v16H4zM10 4h4v16h-4zM16 4h4v16h-4z"/>',
    rows: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    hdd: '<path d="M22 12H2"/><path d="M5.5 5h13l3.5 7v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6z"/><path d="M6 16h.01M10 16h.01"/>',
    share: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="m8.2 10.8 7.6-3.6M8.2 13.2l7.6 3.6"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    logout: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>',
  };
  const ic = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n]}</svg>`;
  const LOGO = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13h4l2.5-6 4 12 2.5-5H21"/></svg>';

  /* ================================================================ drivers */
  const DRV = {
    mysql: { label: 'MySQL / MariaDB', short: 'My', color: '#0ea5e9', port: 3306, user: 'root', url: 'mysql://user:password@host:3306/database' },
    postgres: { label: 'PostgreSQL', short: 'Pg', color: '#6366f1', port: 5432, user: 'postgres', url: 'postgresql://user:password@host:5432/database?sslmode=require' },
    mssql: { label: 'SQL Server', short: 'MS', color: '#ef4444', port: 1433, user: 'sa', url: 'Server=host,1433;Database=db;User Id=sa;Password=…;Encrypt=true;TrustServerCertificate=true' },
    sqlite: { label: 'SQLite', short: 'Lt', color: '#14b8a6', port: '', user: '', url: 'C:\\path\\to\\database.sqlite' },
    mongodb: { label: 'MongoDB', short: 'Mo', color: '#22c55e', port: 27017, user: '', url: 'mongodb+srv://user:password@cluster0.xxxxx.mongodb.net/database' },
  };
  const drvOf = (k) => DRV[k] || DRV.mysql;
  const vocab = (driver) => driver === 'mongodb'
    ? { table: 'collection', tables: 'collections', Table: 'Collection', Tables: 'Collections', row: 'document', rows: 'documents', Rows: 'Documents', col: 'field', Col: 'Field', cols: 'fields', Cols: 'Fields' }
    : { table: 'table', tables: 'tables', Table: 'Table', Tables: 'Tables', row: 'row', rows: 'rows', Rows: 'Rows', col: 'column', Col: 'Column', cols: 'columns', Cols: 'Columns' };
  const V = () => vocab(S.conn?.driver);
  const drvIcon = (k, size = 30) => { const d = drvOf(k); return `<i style="background:${d.color};width:${size}px;height:${size}px">${d.short}</i>`; };

  /* ================================================================ state */
  const S = {
    conns: [], conn: null, snaps: [], meta: null, baseline: null,
    watch: { on: false, timer: null, busy: false, changes: [], checked: null, error: null, known: new Set() },
    filter: '', sort: ls.get('sort', 'rows'), view: null, report: null,
  };

  /* ================================================================ router */
  window.addEventListener('hashchange', route);
  window.addEventListener('DOMContentLoaded', route);

  async function route() {
    closeDrawer();
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    try {
      if (parts[0] === 'c' && parts[1]) {
        const ok = await ensureConn(parts[1]);
        if (!ok) return;
        if (parts[2] === 'report' && parts[3] && parts[4]) return viewReport(parts[3], parts[4]);
        if (parts[2] === 'history') return viewHistory();
        return viewOverview();
      }
      stopWatch();
      S.conn = null;
      return viewHome();
    } catch (e) {
      shell(`<div class="nothing"><div class="big">⚠️</div><h2>Something went wrong</h2><p class="muted">${esc(e.message)}</p><a class="btn" href="#/">Back home</a></div>`);
    }
  }

  async function ensureConn(id) {
    if (S.conn?.id === id && S.meta) return true;
    stopWatch();
    shell(`<div class="loading-page"><span class="spinner"></span>Opening connection…</div>`);
    S.conns = await api('conn.list');
    S.conn = S.conns.find((c) => c.id === id);
    if (!S.conn) { toast('Connection not found', 'err'); location.hash = '#/'; return false; }
    S.snaps = await api('snap.list', { conn: id });
    if (!S.snaps.some((s) => s.status === 'complete')) {
      const sum = await runSnapshot('Baseline', { first: true });
      if (!sum) { location.hash = '#/'; return false; }
      S.snaps = await api('snap.list', { conn: id });
    }
    const complete = S.snaps.filter((s) => s.status === 'complete');
    const saved = ls.get('base:' + id, null);
    S.baseline = complete.some((s) => s.id === saved) ? saved : complete[0].id;
    S.meta = await api('snap.meta', { conn: id, snap: complete[0].id });
    S.watch.changes = [];
    if (ls.get('watch:' + id, true)) startWatch();
    return true;
  }

  function setBaseline(id) {
    S.baseline = id;
    ls.set('base:' + S.conn.id, id);
    S.watch.changes = [];
    S.watch.known = new Set();
    if (S.watch.on) tick();
  }

  const latestId = () => S.snaps.find((s) => s.status === 'complete')?.id;
  const snapById = (id) => S.snaps.find((s) => s.id === id);

  /* ================================================================ shell */
  function shell(content, active = '') {
    const c = S.conn;
    const theme = document.documentElement.dataset.theme;
    const changes = S.watch.changes.length;
    $('#app').innerHTML = `
      <header class="topbar">
        <a class="brand" href="#/"><span class="brand-mark">${LOGO}</span>DB Checker</a>
        ${c ? `
          <div class="conn-pill" title="${esc(c.name)}">
            <span class="ico" style="background:${esc(c.color)}22;color:${esc(c.color)}">${ic('db')}</span>
            <div style="min-width:0"><div class="t">${esc(c.name)}</div><div class="s">${esc(drvOf(c.driver).label)} · ${esc(c.database)}</div></div>
          </div>
          <nav class="tabs">
            <a class="tab ${active === 'overview' ? 'on' : ''}" href="#/c/${c.id}">${ic('grid')}Overview${changes ? `<span class="n" id="tabBadge">${changes}</span>` : '<span id="tabBadge"></span>'}</a>
            <a class="tab ${active === 'report' ? 'on' : ''}" href="${S.lastReport ? `#/c/${c.id}/report/${S.lastReport[0]}/${S.lastReport[1]}` : `#/c/${c.id}/history`}">${ic('report')}Report</a>
            <a class="tab ${active === 'history' ? 'on' : ''}" href="#/c/${c.id}/history">${ic('history')}History</a>
          </nav>` : ''}
        <span class="spacer"></span>
        ${c ? `<a class="btn ghost sm" href="#/" title="All connections">${ic('logout')}<span>Switch</span></a>` : ''}
        <button class="btn ghost icon" id="themeBtn" title="Toggle theme">${ic(theme === 'dark' ? 'sun' : 'moon')}</button>
      </header>
      <main class="page">${content}</main>`;
    $('#themeBtn').onclick = () => {
      const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = t;
      ls.set('theme', t);
      $('#themeBtn').innerHTML = ic(t === 'dark' ? 'sun' : 'moon');
    };
  }

  /* ================================================================ home */
  const COLORS = ['#8b5cf6', '#22d3ee', '#34d399', '#fbbf24', '#fb7185', '#60a5fa', '#f472b6', '#a3e635'];
  let F = null; // connection form state

  function newForm(driver = 'mysql') {
    const d = drvOf(driver);
    return { id: '', name: '', driver, mode: driver === 'mongodb' ? 'url' : 'fields', url: '', host: driver === 'sqlite' ? '' : '127.0.0.1', port: d.port, user: d.user, password: '', database: '', file: '', ssl: false, project_path: '', color: COLORS[Math.floor(Math.random() * COLORS.length)], dbs: [] };
  }

  async function viewHome() {
    S.view = 'home';
    F ||= newForm();
    shell(`
      <section class="hero">
        <div>
          <span class="eyebrow">Database change detective</span>
          <h1>See exactly what your code <span class="grad-text">does to the database.</span></h1>
          <p>Connect any database, take a snapshot, then click through your app. DB Checker shows every ${'row'} that was inserted, updated or deleted — table by table, column by column — plus which related tables and code files are involved.</p>
          <div class="steps">
            <span class="step"><b>1</b>Connect</span><span class="step"><b>2</b>Snapshot</span>
            <span class="step"><b>3</b>Use your app</span><span class="step"><b>4</b>See the diff</span>
          </div>
          <div class="engines">${Object.entries(DRV).map(([k, d]) => `<span class="engine-badge">${drvIcon(k, 18)}${esc(d.label)}</span>`).join('')}</div>
        </div>
        ${orbSvg()}
      </section>
      <section class="home-grid">
        <div class="card">
          <div class="card-h"><h3>Saved connections</h3><span class="spacer"></span><span class="chip" id="connCount">…</span></div>
          <div class="card-b"><div class="conn-list" id="connList"><div class="skeleton" style="height:70px"></div><div class="skeleton" style="height:70px"></div></div></div>
        </div>
        <form class="card" id="connForm" autocomplete="off"></form>
      </section>`);
    renderForm();
    try {
      S.conns = await api('conn.list');
    } catch (e) {
      $('#connList').innerHTML = `<div class="form-msg err">${esc(e.message)}</div>`;
      return;
    }
    renderConnList();
  }

  function orbSvg() {
    const dots = Array.from({ length: 10 }, (_, i) => {
      const a = (i / 10) * Math.PI * 2;
      return `<circle cx="${200 + Math.cos(a) * 150}" cy="${200 + Math.sin(a) * 150}" r="${i % 3 ? 3 : 5}" fill="${i % 2 ? '#22d3ee' : '#8b5cf6'}" class="blink" style="animation-delay:${i * 0.24}s"/>`;
    }).join('');
    const tables = ['users', 'orders', 'order_items', 'products', 'payments', 'sessions'];
    const labels = tables.map((t, i) => {
      const a = (i / tables.length) * Math.PI * 2 - Math.PI / 2;
      const x = 200 + Math.cos(a) * 108;
      const y = 200 + Math.sin(a) * 108;
      const c = i === 1 ? '#34d399' : i === 3 ? '#fbbf24' : 'var(--line-2)';
      return `<g><line x1="200" y1="200" x2="${x}" y2="${y}" stroke="${c}" stroke-width="1.2" stroke-dasharray="3 4" opacity=".7"/><rect x="${x - 38}" y="${y - 11}" width="76" height="22" rx="7" fill="var(--surface-solid)" stroke="${c}"/><text x="${x}" y="${y + 4}" text-anchor="middle" font-family="JetBrains Mono,monospace" font-size="10" fill="var(--text-2)">${t}</text></g>`;
    }).join('');
    return `<div class="orb" aria-hidden="true"><svg viewBox="0 0 400 400">
      <defs><linearGradient id="og" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#22d3ee"/></linearGradient>
      <radialGradient id="core"><stop offset="0" stop-color="#8b5cf6" stop-opacity=".55"/><stop offset="1" stop-color="#8b5cf6" stop-opacity="0"/></radialGradient></defs>
      <circle cx="200" cy="200" r="190" fill="url(#core)" class="pulse" opacity=".5"/>
      <g class="spin"><circle cx="200" cy="200" r="150" fill="none" stroke="url(#og)" stroke-width="1.5" stroke-dasharray="2 10"/>${dots}</g>
      <g class="spin rev"><circle cx="200" cy="200" r="175" fill="none" stroke="var(--line-2)" stroke-dasharray="40 14 4 14"/></g>
      ${labels}
      <g class="pulse"><circle cx="200" cy="200" r="46" fill="url(#og)"/></g>
      <g transform="translate(176 176) scale(2)" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></g>
    </svg></div>`;
  }

  function renderConnList() {
    const box = $('#connList');
    if (!box) return;
    $('#connCount').textContent = S.conns.length;
    if (!S.conns.length) {
      box.innerHTML = `<div class="empty">${ic('db')}<div><b>No connections yet</b></div><div>Add one on the right — it takes 10 seconds.</div></div>`;
      return;
    }
    box.innerHTML = S.conns.map((c) => `
      <div class="conn-card" data-open="${c.id}" tabindex="0" role="button">
        <span class="ico" style="background:${esc(drvOf(c.driver).color)}">${drvOf(c.driver).short}</span>
        <div class="grow">
          <div class="t"><span style="width:8px;height:8px;border-radius:50%;background:${esc(c.color)}"></span>${esc(c.name)}</div>
          <div class="s">${esc(drvOf(c.driver).label)} · <span class="mono">${esc(c.database || c.file)}</span>${c.mode === 'url' ? ' · URL' : c.host ? ' · ' + esc(c.host) : ''}</div>
          <div class="s">${c.snapshots ? `${plural(c.snapshots, 'snapshot', 'snapshots')} · last ${ago(c.last_snapshot?.created_at)}` : 'not scanned yet'}</div>
        </div>
        <div class="actions">
          <button class="btn sm icon ghost" data-edit="${c.id}" title="Edit">${ic('edit')}</button>
          <button class="btn sm icon ghost danger" data-del="${c.id}" title="Delete">${ic('trash')}</button>
        </div>
        ${ic('arrow', 'dim')}
      </div>`).join('');
    box.onclick = async (e) => {
      const ed = e.target.closest('[data-edit]');
      const del = e.target.closest('[data-del]');
      const open = e.target.closest('[data-open]');
      if (ed) {
        e.stopPropagation();
        const c = S.conns.find((x) => x.id === ed.dataset.edit);
        F = { ...newForm(c.driver), ...c, password: '', url: c.url_display || '', dbs: [] };
        renderForm();
        $('#connForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (del) {
        e.stopPropagation();
        const c = S.conns.find((x) => x.id === del.dataset.del);
        if (!(await confirmBox(`Delete “${esc(c.name)}”?`, 'The saved connection and all its snapshots will be removed from DB Checker. Your database is not touched.', 'Delete'))) return;
        await api('conn.delete', { conn: c.id });
        S.conns = S.conns.filter((x) => x.id !== c.id);
        renderConnList();
        toast('Connection deleted');
      } else if (open) {
        location.hash = '#/c/' + open.dataset.open;
      }
    };
    box.onkeydown = (e) => { if (e.key === 'Enter' && e.target.dataset.open) location.hash = '#/c/' + e.target.dataset.open; };
  }

  function renderForm(msg = null) {
    const f = F;
    const d = drvOf(f.driver);
    const isSqlite = f.driver === 'sqlite';
    const editing = !!f.id;
    const dbField = `
      <label class="field ${f.mode === 'url' ? 'c4' : 'c4'}"><span>Database ${f.mode === 'url' ? '<small>(optional — overrides the URL)</small>' : ''}</span>
        <input class="input mono" name="database" list="dbList" value="${esc(f.database)}" placeholder="${f.driver === 'mongodb' ? 'e.g. shop' : 'pick or type'}">
        <datalist id="dbList">${f.dbs.map((x) => `<option value="${esc(x)}">`).join('')}</datalist></label>
      <div class="field c2"><span>&nbsp;</span><button type="button" class="btn" data-act="dbs">${ic('refresh')}Load list</button></div>`;
    $('#connForm').innerHTML = `
      <div class="card-h"><h3>${editing ? 'Edit connection' : 'New connection'}</h3><span class="spacer"></span>
        ${editing ? `<button type="button" class="btn sm ghost" data-act="reset">${ic('plus')}New</button>` : ''}</div>
      <div class="card-b" style="display:flex;flex-direction:column;gap:14px">
        <div class="driver-grid" role="radiogroup" aria-label="Database type">
          ${Object.entries(DRV).map(([k, x]) => `<button type="button" class="driver-opt ${f.driver === k ? 'on' : ''}" data-driver="${k}" role="radio" aria-checked="${f.driver === k}">${drvIcon(k)}${esc(x.label.replace(' / MariaDB', ''))}</button>`).join('')}
        </div>
        ${isSqlite ? '' : `<div class="row"><div class="seg">
            <button type="button" class="${f.mode === 'fields' ? 'on' : ''}" data-mode="fields">Host & user</button>
            <button type="button" class="${f.mode === 'url' ? 'on' : ''}" data-mode="url">Connection URL</button></div>
            <span class="hint">${ic('info')}${f.driver === 'mongodb' ? 'Atlas: Connect → Drivers → copy the <code>mongodb+srv://</code> string.' : 'Cloud databases usually give you a URL.'}</span></div>`}
        <div class="form-grid">
          <label class="field c3"><span>Name</span><input class="input" name="name" value="${esc(f.name)}" placeholder="My shop (local)"></label>
          <div class="field c3"><span>Color</span><div class="swatches" style="height:40px;align-items:center">${COLORS.map((c) => `<button type="button" class="swatch ${f.color === c ? 'on' : ''}" style="background:${c}" data-color="${c}" aria-label="color ${c}"></button>`).join('')}</div></div>
          ${isSqlite ? `
            <label class="field c6"><span>SQLite file path</span><input class="input mono" name="file" value="${esc(f.file)}" placeholder="${esc(d.url)}"><small>Full path of the .sqlite / .db file (e.g. Laravel's database/database.sqlite). Opened read-only.</small></label>`
          : f.mode === 'url' ? `
            <label class="field c6"><span>Connection URL</span><input class="input mono" name="url" value="${esc(f.url)}" placeholder="${esc(d.url)}" spellcheck="false">
              ${editing ? '<small>Leave the masked value (•••) to keep the saved password.</small>' : ''}</label>
            ${dbField}`
          : `
            <label class="field c4"><span>Host</span><input class="input mono" name="host" value="${esc(f.host)}" placeholder="127.0.0.1"></label>
            <label class="field c2"><span>Port</span><input class="input mono" name="port" value="${esc(f.port)}" inputmode="numeric"></label>
            <label class="field c3"><span>Username</span><input class="input mono" name="user" value="${esc(f.user)}"></label>
            <label class="field c3"><span>Password</span><input class="input mono" type="password" name="password" value="${esc(f.password)}" placeholder="${editing ? 'unchanged' : ''}" autocomplete="new-password"></label>
            ${dbField}
            <label class="check c6"><input type="checkbox" name="ssl" ${f.ssl ? 'checked' : ''}> Use SSL/TLS (needed for most cloud servers)</label>`}
          <label class="field c6"><span>Project folder <small>(optional — enables “where in code?” hints)</small></span>
            <input class="input mono" name="project_path" value="${esc(f.project_path)}" placeholder="D:\\laragon\\www\\my-app"></label>
        </div>
        <div id="formMsg">${msg ? `<div class="form-msg ${msg.type}">${msg.text}</div>` : ''}</div>
        <div class="row">
          <button type="button" class="btn" data-act="test">${ic('zap')}Test</button>
          <span class="spacer"></span>
          <button type="submit" class="btn primary lg">${ic('camera')}${editing ? 'Save & open' : 'Connect & scan'}</button>
        </div>
      </div>`;

    const form = $('#connForm');
    form.oninput = (e) => {
      const el = e.target;
      if (!el.name) return;
      F[el.name] = el.type === 'checkbox' ? el.checked : el.value;
      if (el.name === 'url') {
        const guess = detect(el.value);
        if (guess && guess !== F.driver) { F.driver = guess; renderForm(); $('#connForm [name=url]').focus(); }
      }
    };
    form.onclick = async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.driver) {
        const keep = { name: F.name, color: F.color, project_path: F.project_path, id: F.id };
        F = { ...newForm(b.dataset.driver), ...keep };
        return renderForm();
      }
      if (b.dataset.mode) { F.mode = b.dataset.mode; return renderForm(); }
      if (b.dataset.color) { F.color = b.dataset.color; return renderForm(); }
      if (b.dataset.act === 'reset') { F = newForm(); return renderForm(); }
      if (b.dataset.act === 'dbs') return withBusy(b, async () => {
        const r = await api('conn.databases', payload());
        F.dbs = r.databases;
        if (!F.database && r.current) F.database = r.current;
        renderForm({ type: 'ok', text: `${ic('check')}<span>${esc(r.version)} — ${plural(r.databases.length, 'database', 'databases')} found. Pick one.</span>` });
        $('#connForm [name=database]').focus();
      });
      if (b.dataset.act === 'test') return withBusy(b, async () => {
        const r = await api('conn.test', payload());
        const v = vocab(F.driver);
        setMsg('ok', `${ic('check')}<span>Connected to <b>${esc(r.database)}</b> · ${esc(r.version)} · ${plural(r.tables, v.table, v.tables)}</span>`);
      });
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const b = form.querySelector('[type=submit]');
      await withBusy(b, async () => {
        const saved = await api('conn.save', payload());
        F = null;
        toast(`Saved “${esc(saved.name)}”`);
        location.hash = '#/c/' + saved.id;
      });
    };
  }

  function detect(u) {
    u = String(u).trim().toLowerCase();
    if (/^mongodb(\+srv)?:\/\//.test(u)) return 'mongodb';
    if (/^(mysql|mariadb):\/\//.test(u)) return 'mysql';
    if (/^postgres(ql)?:\/\//.test(u)) return 'postgres';
    if (/^(mssql|sqlserver):\/\/|^(server|data source)=/.test(u)) return 'mssql';
    return null;
  }
  const payload = () => ({ ...F, dbs: undefined });
  const setMsg = (type, text) => { const m = $('#formMsg'); if (m) m.innerHTML = `<div class="form-msg ${type}">${text}</div>`; };

  async function withBusy(btn, fn) {
    const html = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>${btn.textContent.trim()}`;
    try {
      await fn();
    } catch (e) {
      setMsg('err', `${ic('alert')}<span>${esc(e.message)}</span>`);
      if (!$('#formMsg')) toast(esc(e.message), 'err');
    } finally {
      if (btn.isConnected) { btn.disabled = false; btn.innerHTML = html; }
    }
  }

  /* ================================================================ scan overlay */
  async function runSnapshot(label, { first = false } = {}) {
    const c = S.conn;
    const v = vocab(c.driver);
    const ov = $('#overlay');
    const R = 88;
    const CIRC = 2 * Math.PI * R;
    ov.innerHTML = `
      <div class="scan" role="dialog" aria-label="Taking snapshot"><div class="scan-inner">
        <div class="scan-core">
          <svg viewBox="0 0 210 210">
            <defs><linearGradient id="sg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs>
            <circle cx="105" cy="105" r="${R}" fill="none" stroke="var(--line-2)" stroke-width="10"/>
            <circle class="ring-fg" cx="105" cy="105" r="${R}" fill="none" stroke="url(#sg)" stroke-width="10" stroke-linecap="round"
              stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC}" transform="rotate(-90 105 105)"/>
            <g class="orbit"><circle cx="105" cy="6" r="5" fill="#22d3ee"/></g>
            <g class="orbit o2"><circle cx="105" cy="204" r="3.5" fill="#8b5cf6"/></g>
          </svg>
          <div class="scan-pct"><div><span id="scPct">0</span>%<small id="scPhase">connecting</small></div></div>
        </div>
        <div class="scan-title">${first ? 'First look at' : 'Snapshotting'} <span class="grad-text">${esc(c.database || c.name)}</span></div>
        <div class="scan-step" id="scStep">Connecting to ${esc(drvOf(c.driver).label)}…</div>
        <div class="scan-stats">
          <div class="scan-stat"><b id="scT">0</b><span>${v.Tables}</span></div>
          <div class="scan-stat"><b id="scR">0</b><span>${v.Rows}</span></div>
          <div class="scan-stat"><b id="scC">0</b><span>${v.Cols}</span></div>
          <div class="scan-stat"><b id="scS">0</b><span>Unchanged</span></div>
        </div>
        <div class="scan-chips" id="scChips"></div>
      </div></div>`;
    const setPct = (p) => {
      p = Math.max(0, Math.min(100, p));
      $('.ring-fg', ov).style.strokeDashoffset = CIRC * (1 - p / 100);
      $('#scPct').textContent = Math.round(p);
    };
    const count = (el, to) => {
      const from = Number(el.dataset.v || 0);
      el.dataset.v = to;
      const t0 = performance.now();
      const step = (t) => {
        const k = Math.min(1, (t - t0) / 500);
        el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))).toLocaleString();
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };

    try {
      const begin = await api('snap.begin', { conn: c.id, label });
      $('#scPhase').textContent = 'reading';
      $('#scStep').textContent = `${begin.server_version} · ${plural(begin.tables.length, v.table, v.tables)} · ${plural(begin.fks, 'foreign key', 'foreign keys')}`;
      const chips = $('#scChips');
      const shown = begin.tables.slice(0, 160);
      chips.innerHTML = shown.map((t) => `<span class="scan-chip" data-t="${esc(t.name)}">${esc(t.name)}</span>`).join('') +
        (begin.tables.length > shown.length ? `<span class="scan-chip">+${begin.tables.length - shown.length} more</span>` : '');
      count($('#scC'), begin.tables.reduce((s, t) => s + t.columns, 0));
      setPct(4);

      // Batches: few big tables or many small ones per request.
      const batches = [];
      let cur = [];
      let weight = 0;
      for (const t of begin.tables) {
        const w = Math.max(1, t.est_rows);
        if (cur.length && (weight + w > 25000 || cur.length >= 8)) { batches.push(cur); cur = []; weight = 0; }
        cur.push(t.name);
        weight += w;
      }
      if (cur.length) batches.push(cur);

      let done = 0;
      let rows = 0;
      let same = 0;
      const chipOf = (n) => chips.querySelector(`[data-t="${CSS.escape(n)}"]`);
      for (const batch of batches) {
        batch.forEach((n) => chipOf(n)?.classList.add('busy'));
        $('#scStep').textContent = `Reading ${batch.length > 1 ? batch[0] + ` + ${batch.length - 1} more` : batch[0]}…`;
        $('#scPhase').textContent = 'capturing';
        const res = await api('snap.capture', { conn: c.id, snap: begin.id, tables: batch });
        for (const r of res) {
          const ch = chipOf(r.name);
          if (ch) { ch.classList.remove('busy'); ch.classList.add(r.error ? 'err' : r.reused ? 'same' : 'done'); if (r.error) ch.title = r.error; }
          rows += Number(r.rows) || 0;
          if (r.reused) same++;
        }
        done += batch.length;
        count($('#scT'), done);
        count($('#scR'), rows);
        count($('#scS'), same);
        setPct(4 + (done / Math.max(1, begin.tables.length)) * 92);
      }
      $('#scPhase').textContent = 'saving';
      const sum = await api('snap.finish', { conn: c.id, snap: begin.id });
      setPct(100);
      $('#scPhase').textContent = 'done';
      $('#scStep').innerHTML = `Saved in ${(sum.duration_ms / 1000).toFixed(1)}s${sum.errors ? ` · <span style="color:var(--del)">${sum.errors} ${v.tables} could not be read</span>` : ''}`;
      $('.scan-core', ov).insertAdjacentHTML('beforeend', `<div class="scan-done" style="position:absolute;right:-6px;bottom:6px"><svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="var(--ins)"/><path d="M19 33l9 9 17-19" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`);
      await sleep(first ? 1100 : 650);
      ov.innerHTML = '';
      return sum;
    } catch (e) {
      $('#scPhase').textContent = 'failed';
      $('#scStep').innerHTML = `<span style="color:var(--del)">${esc(e.message)}</span>`;
      $('.scan-inner', ov).insertAdjacentHTML('beforeend', `<div class="row" style="margin-top:18px"><button class="btn" id="scClose">Close</button></div>`);
      await new Promise((r) => { $('#scClose').onclick = r; });
      ov.innerHTML = '';
      return null;
    }
  }

  /* ================================================================ overview */
  function viewOverview() {
    S.view = 'overview';
    const v = V();
    const sum = S.meta.summary || {};
    const tables = Object.values(S.meta.tables).filter((t) => t.type === 'table');
    const cols = tables.reduce((s, t) => s + t.columns.length, 0);
    const edges = S.meta.edges || [];
    const fkN = edges.filter((e) => e.type === 'fk').length;
    const infN = edges.filter((e) => e.type === 'inferred').length;
    shell(`
      ${journeyHtml()}
      <section class="stats">
        ${statTile('table', v.Tables, fmt(tables.length), `${fmt(Object.keys(S.meta.views).length)} views`, 0)}
        ${statTile('rows', v.Rows, compact(sum.rows ?? tables.reduce((s, t) => s + (t.rows || 0), 0)), 'exact count', 1)}
        ${statTile('cols', v.Cols, fmt(cols), `avg ${tables.length ? Math.round(cols / tables.length) : 0} per ${v.table}`, 2)}
        ${statTile('hdd', 'Size', bytes(sum.size ?? 0), esc(S.meta.server_version || ''), 3)}
        ${statTile('share', 'Relations', fmt(fkN + infN), `${fkN} FK · ${infN} inferred`, 4)}
      </section>
      <div class="toolbar">
        <div class="search">${ic('search')}<input class="input" id="q" placeholder="Filter ${v.tables}…" value="${esc(S.filter)}"></div>
        <select class="select" id="sort" style="width:auto">
          ${[['rows', `Most ${v.rows}`], ['name', 'Name'], ['size', 'Size'], ['changed', 'Changed first'], ['cols', `Most ${v.cols}`]]
            .map(([k, l]) => `<option value="${k}" ${S.sort === k ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <span class="spacer"></span>
        <div class="legend"><span><i style="background:var(--upd)"></i>changed</span><span><i style="background:var(--ins)"></i>new</span><span><i style="background:var(--sch)"></i>structure</span><span><i style="background:var(--del)"></i>dropped</span></div>
        <span class="muted" style="font-size:12px">snapshot ${ago(S.meta.created_at)}</span>
      </div>
      <section class="tiles" id="tiles"></section>`, 'overview');
    renderTiles(true);
    bindJourney();
    $('#q').oninput = (e) => { S.filter = e.target.value; renderTiles(); };
    $('#sort').onchange = (e) => { S.sort = e.target.value; ls.set('sort', S.sort); renderTiles(); };
  }

  const compact = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'K' : fmt(n));
  const statTile = (icon, k, val, sub, i) => `<div class="stat card" style="animation-delay:${i * 60}ms"><div class="k">${ic(icon)}${k}</div><div class="v">${val}</div><div class="sub">${sub}</div></div>`;

  function renderTiles(animate = false) {
    const box = $('#tiles');
    if (!box) return;
    box.classList.toggle('static', !animate);
    const v = V();
    const changes = Object.fromEntries(S.watch.changes.map((c) => [c.table, c]));
    let list = Object.values(S.meta.tables).filter((t) => t.type === 'table');
    for (const ch of S.watch.changes) if (ch.kind === 'new' && !S.meta.tables[ch.table]) list.push({ name: ch.table, rows: ch.after, columns: [], data_size: 0, index_size: 0, ghost: true });
    const q = S.filter.trim().toLowerCase();
    if (q) list = list.filter((t) => t.name.toLowerCase().includes(q) || t.columns.some((c) => c.name.toLowerCase().includes(q)));
    const edges = S.meta.edges || [];
    const relCount = (n) => edges.filter((e) => e.from === n || e.to === n).length;
    const sorters = {
      rows: (a, b) => (b.rows || 0) - (a.rows || 0),
      name: (a, b) => a.name.localeCompare(b.name),
      size: (a, b) => (b.data_size + b.index_size) - (a.data_size + a.index_size),
      cols: (a, b) => b.columns.length - a.columns.length,
      changed: (a, b) => (changes[b.name] ? 1 : 0) - (changes[a.name] ? 1 : 0) || (b.rows || 0) - (a.rows || 0),
    };
    list.sort(sorters[S.sort] || sorters.rows);
    const maxRows = Math.max(1, ...list.map((t) => t.rows || 0));
    if (!list.length) {
      box.innerHTML = `<div class="empty" style="grid-column:1/-1">${ic('search')}<div>No ${v.tables} match “${esc(S.filter)}”.</div></div>`;
      return;
    }
    box.innerHTML = list.map((t, i) => {
      const ch = changes[t.name];
      const delta = ch && ch.after !== null ? ch.after - ch.before : 0;
      const badge = !ch ? '' : ch.kind === 'new' ? 'NEW' : ch.kind === 'dropped' ? 'DROPPED' : ch.kind === 'schema' ? 'STRUCTURE' : delta > 0 ? `+${fmt(delta)}` : delta < 0 ? `−${fmt(-delta)}` : 'EDITED';
      const pct = Math.max(2, (Math.log10((t.rows || 0) + 1) / Math.log10(maxRows + 1)) * 100);
      return `
        <button class="tile ${ch ? 'changed k-' + ch.kind : ''}" data-table="${esc(t.name)}" style="animation-delay:${Math.min(i, 30) * 18}ms" title="${esc(t.name)}${t.error ? ' — ' + esc(t.error) : ''}">
          <div class="tile-top"><span class="tile-name">${esc(t.name)}</span>${t.error ? '<span class="err-dot"></span>' : ''}${badge ? `<span class="badge">${badge}</span>` : ''}</div>
          <div class="tile-rows">${fmt(ch && ch.after !== null ? ch.after : t.rows)}<small>${v.rows}</small></div>
          <div class="tile-meta"><span>${t.columns.length} ${v.cols}</span><span>${bytes((t.data_size || 0) + (t.index_size || 0))}</span>${relCount(t.name) ? `<span>⇄ ${relCount(t.name)}</span>` : ''}</div>
          <div class="tile-bar"><i style="width:${pct}%"></i></div>
        </button>`;
    }).join('');
    box.onclick = (e) => {
      const t = e.target.closest('[data-table]');
      if (t) openTable(t.dataset.table);
    };
  }

  /* ================================================================ journey bar + watch */
  function journeyHtml() {
    const base = snapById(S.baseline);
    const n = S.snaps.filter((s) => s.status === 'complete').length;
    return `
      <section class="journey card">
        <div class="base-box">
          <span class="base-ico">${ic('flag')}</span>
          <div style="min-width:0"><div class="k">Comparing against</div>
            <div class="v" title="${esc(base?.label)}">${esc(base?.label || '—')} <span class="muted" style="font-weight:500">· ${ago(base?.created_at)}</span></div></div>
          <a class="btn sm ghost" href="#/c/${S.conn.id}/history" title="Pick another baseline">change</a>
        </div>
        <div class="watch-status" id="watchStatus">${watchStatusHtml()}</div>
        <div class="journey-actions">
          <label class="check" title="Check the database every few seconds"><span class="switch ${S.watch.on ? 'on' : ''}" id="watchSw" role="switch" aria-checked="${S.watch.on}" tabindex="0"></span>Live</label>
          <input class="input step-input" id="stepName" placeholder="What did you just do? (e.g. Place order)" maxlength="80">
          <button class="btn primary" id="captureBtn">${ic('camera')}Capture & compare</button>
        </div>
      </section>
      ${n <= 1 && !S.watch.changes.length ? `<div class="note" style="margin:-8px 0 20px">${ic('info')}<span><b>How to use:</b> go to your app and do one action (register, place an order, delete something…). Come back and press <b>Capture & compare</b> — you'll get a report of every ${V().row} that changed. With <b>Live</b> on, changed ${V().tables} light up here automatically.</span></div>` : ''}`;
  }

  function watchStatusHtml() {
    const w = S.watch;
    const v = V();
    if (w.error) return `<span class="live-dot alert"></span><div class="watch-text">Live watch paused<small>${esc(w.error)}</small></div>`;
    if (!w.on) return `<span class="live-dot"></span><div class="watch-text">Live watch is off<small>Turn it on to see changes as they happen</small></div>`;
    if (!w.changes.length) return `<span class="live-dot on"></span><div class="watch-text">Watching… no changes yet<small>${w.checked ? 'checked ' + ago(w.checked) : 'starting'}</small></div>`;
    const names = w.changes.slice(0, 3).map((c) => c.table).join(', ') + (w.changes.length > 3 ? ` +${w.changes.length - 3}` : '');
    return `<span class="live-dot on alert"></span><div class="watch-text">${plural(w.changes.length, v.table, v.tables)} changed<small class="mono">${esc(names)}</small></div>`;
  }

  function bindJourney() {
    const sw = $('#watchSw');
    if (!sw) return;
    const toggle = () => {
      if (S.watch.on) stopWatch(); else startWatch();
      ls.set('watch:' + S.conn.id, S.watch.on);
      sw.classList.toggle('on', S.watch.on);
      sw.setAttribute('aria-checked', S.watch.on);
      updateWatchUi();
    };
    sw.onclick = toggle;
    sw.onkeydown = (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); } };
    $('#captureBtn').onclick = captureAndCompare;
    $('#stepName').onkeydown = (e) => { if (e.key === 'Enter') captureAndCompare(); };
  }

  function startWatch() {
    S.watch.on = true;
    S.watch.error = null;
    clearInterval(S.watch.timer);
    S.watch.timer = setInterval(tick, 3000);
    tick();
  }
  function stopWatch() {
    S.watch.on = false;
    clearInterval(S.watch.timer);
    S.watch.timer = null;
  }

  async function tick() {
    const w = S.watch;
    if (!w.on || w.busy || !S.conn || document.hidden) return;
    w.busy = true;
    const connId = S.conn.id;
    try {
      const r = await api('watch', { conn: connId, base: S.baseline });
      if (!S.conn || S.conn.id !== connId || r.base !== S.baseline) return;
      w.error = null;
      const fresh = r.changes.filter((c) => !w.known.has(c.table + c.kind + c.after));
      w.changes = r.changes;
      w.checked = r.checked_at;
      w.known = new Set(r.changes.map((c) => c.table + c.kind + c.after));
      updateWatchUi(fresh.map((c) => c.table));
      if (fresh.length && S.view !== 'overview') toast(`${fresh.map((c) => `<code>${esc(c.table)}</code>`).join(', ')} changed`, 'warn', 3000);
    } catch (e) {
      w.error = e.message;
      updateWatchUi();
    } finally {
      w.busy = false;
    }
  }

  function updateWatchUi(flash = []) {
    const st = $('#watchStatus');
    if (st) st.innerHTML = watchStatusHtml();
    const badge = $('#tabBadge');
    if (badge) { badge.className = S.watch.changes.length ? 'n' : ''; badge.textContent = S.watch.changes.length || ''; }
    if (S.view === 'overview') {
      renderTiles();
      for (const n of flash) $(`.tile[data-table="${CSS.escape(n)}"]`)?.classList.add('flash');
    }
  }

  async function captureAndCompare() {
    const btn = $('#captureBtn');
    const n = S.snaps.filter((s) => s.status === 'complete').length;
    const label = ($('#stepName')?.value || '').trim() || `Step ${n}`;
    const from = S.baseline;
    if (btn) btn.disabled = true;
    const wasOn = S.watch.on;
    stopWatch();
    const sum = await runSnapshot(label);
    if (btn) btn.disabled = false;
    if (!sum) { if (wasOn) startWatch(); return; }
    S.snaps = await api('snap.list', { conn: S.conn.id });
    S.meta = await api('snap.meta', { conn: S.conn.id, snap: sum.id });
    setBaseline(sum.id); // next capture compares against this step
    if (wasOn) startWatch();
    location.hash = `#/c/${S.conn.id}/report/${from}/${sum.id}`;
  }

  /* ================================================================ table drawer */
  function closeDrawer() { $('#drawer').innerHTML = ''; document.removeEventListener('keydown', drawerKey); }
  function drawerKey(e) { if (e.key === 'Escape') closeDrawer(); }

  function openTable(name, tab = 'columns') {
    const v = V();
    const t = S.meta.tables[name];
    if (!t) return toast(`<code>${esc(name)}</code> is not in the latest snapshot yet — capture one first.`, 'warn');
    const edges = (S.meta.edges || []);
    const parents = edges.filter((e) => e.from === name);
    const children = edges.filter((e) => e.to === name && e.from !== name);
    const ch = S.watch.changes.find((c) => c.table === name);
    $('#drawer').innerHTML = `
      <div class="scrim" data-close></div>
      <aside class="panel" role="dialog" aria-label="${esc(name)}">
        <div class="panel-h">
          <span class="base-ico">${ic('table')}</span>
          <div style="min-width:0;flex:1"><h2>${esc(name)}</h2>
            <div class="muted" style="font-size:12.5px">${fmt(t.rows)} ${v.rows} · ${t.columns.length} ${v.cols} · ${bytes((t.data_size || 0) + (t.index_size || 0))}${t.engine ? ' · ' + esc(t.engine) : ''}</div></div>
          ${ch ? `<span class="chip upd"><span class="dot"></span>changed since baseline</span>` : ''}
          <button class="btn icon ghost" data-close aria-label="Close">${ic('x')}</button>
        </div>
        <div class="panel-b">
          <div class="subtabs">
            <button class="subtab ${tab === 'columns' ? 'on' : ''}" data-tab="columns">${v.Cols}</button>
            <button class="subtab ${tab === 'rel' ? 'on' : ''}" data-tab="rel">Relations (${parents.length + children.length})</button>
            <button class="subtab ${tab === 'data' ? 'on' : ''}" data-tab="data">Latest ${v.rows}</button>
          </div>
          <div id="drawerBody"></div>
        </div>
      </aside>`;
    document.addEventListener('keydown', drawerKey);
    $('#drawer').onclick = (e) => {
      if (e.target.closest('[data-close]')) return closeDrawer();
      const tb = e.target.closest('[data-tab]');
      if (tb) { $$('.subtab').forEach((x) => x.classList.toggle('on', x === tb)); body(tb.dataset.tab); }
      const go = e.target.closest('[data-goto]');
      if (go) openTable(go.dataset.goto, 'rel');
    };
    const body = (which) => {
      const box = $('#drawerBody');
      if (which === 'columns') {
        box.innerHTML = `
          <div class="dtable-wrap"><table class="dtable"><thead><tr><th>${v.Col}</th><th>Type</th><th>Null</th><th>Default</th><th>Key</th><th>Extra</th></tr></thead><tbody>
          ${t.columns.map((c) => `<tr><td class="${t.rowkey.includes(c.name) ? 'kcol' : ''}">${esc(c.name)}</td><td>${esc(c.type)}</td><td>${c.nullable ? 'yes' : '<b>no</b>'}</td>
            <td>${c.default === null || c.default === undefined ? '<span class="null">—</span>' : esc(c.default)}</td><td>${esc(c.key || '')}</td><td>${esc(c.extra || c.comment || '')}</td></tr>`).join('')}
          </tbody></table></div>
          ${t.indexes.length ? `<div class="sec"><div class="sec-h">Indexes<span class="line"></span></div><div class="schema-list">
            ${t.indexes.map((ix) => `<div class="schema-item"><code>${esc(ix.name)}</code>${ix.primary ? '<span class="chip acc">primary</span>' : ix.unique ? '<span class="chip">unique</span>' : ''}<span class="ty">(${ix.columns.map(esc).join(', ')})</span></div>`).join('')}
          </div></div>` : ''}
          <div class="sec"><div class="note">${ic('info')}<span>Row identity: ${t.rowkey.length ? `<code>${t.rowkey.map(esc).join(', ')}</code> (${esc(t.rowkey_type)})` : 'no primary/unique key — edits appear as delete + insert'}. Capture mode: <b>${esc(t.mode || '—')}</b>${t.mode === 'tail' ? ` (newest ${fmt(t.captured)} ${v.rows})` : ''}.</span></div></div>`;
      } else if (which === 'rel') {
        const relRow = (e, dir) => {
          const other = dir === 'out' ? e.to : e.from;
          return `<div class="rel">${dir === 'out' ? `<span class="via">${esc(e.col)}</span> → ` : ''}${other ? `<a href="javascript:void 0" data-goto="${esc(other)}"><code>${esc(other)}</code></a>` : `<code>${esc(e.morph)}_type</code>`}${dir === 'in' ? ` <span class="via">.${esc(e.col)}</span>` : ''}
            <span class="tag">${e.type === 'fk' ? 'foreign key' : e.type === 'morph' ? 'polymorphic' : 'inferred'}</span>${e.on_delete && e.on_delete !== 'NO ACTION' && e.on_delete !== 'RESTRICT' ? `<span class="tag">on delete ${esc(e.on_delete)}</span>` : ''}</div>`;
        };
        const views = Object.values(S.meta.views).filter((x) => x.definition.includes(name.split('.').pop())).map((x) => x.name);
        const trg = (S.meta.triggers || []).filter((x) => x.table === name);
        box.innerHTML = `
          <div class="impact">
            <div class="impact-col"><h4>Points to (parents)</h4>${parents.map((e) => relRow(e, 'out')).join('') || '<div class="dim">nothing</div>'}</div>
            <div class="impact-col"><h4>Referenced by (children)</h4>${children.map((e) => relRow(e, 'in')).join('') || '<div class="dim">nothing</div>'}</div>
          </div>
          ${views.length || trg.length ? `<div class="sec"><div class="sec-h">Views & triggers<span class="line"></span></div><div class="colfreq">
            ${views.map((x) => `<span class="chip sch">view ${esc(x)}</span>`).join('')}${trg.map((x) => `<span class="chip upd">${esc(x.timing)} ${esc(x.event)} · ${esc(x.name)}</span>`).join('')}</div></div>` : ''}
          <div class="sec"><div class="note">${ic('info')}<span>“Inferred” relations are guessed from names like <code>user_id</code> → <code>users</code>, because many apps don't declare foreign keys.</span></div></div>`;
      } else {
        box.innerHTML = `<div class="skeleton" style="height:240px"></div>`;
        api('rows', { conn: S.conn.id, table: name, snap: S.meta.id, limit: 40 }).then((r) => {
          if (!$('#drawerBody')) return;
          box.innerHTML = `<div class="muted" style="margin-bottom:8px;font-size:12.5px">Live from the database · newest ${r.rows.length} of ${fmt(r.total)} ${v.rows}</div>
            ${dataTable(r.columns, r.rows.map((row) => ({ row: Object.fromEntries(r.columns.map((c, i) => [c, row[i]])) })), '', r.key)}`;
        }).catch((e) => { box.innerHTML = `<div class="form-msg err">${esc(e.message)}</div>`; });
      }
    };
    body(tab);
  }

  function cellHtml(val) {
    if (val === null || val === undefined) return '<span class="null">NULL</span>';
    const s = String(val);
    return `<span class="v" title="${esc(s.length > 60 ? s.slice(0, 1000) : '')}">${esc(s.length > 80 ? s.slice(0, 80) + '…' : s)}</span>`;
  }

  function refHtml(refs) {
    if (!refs) return '';
    return refs.map((r) => r.missing
      ? `<span class="ref missing">→ ${esc(r.table)} #${esc(r.id)} not found!</span>`
      : `<span class="ref">→ ${esc(r.table)}${r.label ? ': ' + esc(r.label) : ` #${esc(r.id)}`}</span>`).join('');
  }

  /** items: [{row, changes?, refs?}] */
  function dataTable(cols, items, kind, key = []) {
    const cls = kind ? 'r-' + kind : '';
    return `<div class="dtable-wrap"><table class="dtable"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>
      ${items.map((it) => `<tr class="${cls}">${cols.map((c) => {
        const chg = it.changes?.[c];
        if (chg) return `<td class="cell-chg"><span class="cell-old">${cellHtml(chg[0])}</span><span class="cell-new">${cellHtml(chg[1])}</span>${refHtml(it.refs?.[c])}</td>`;
        return `<td class="${key.includes(c) ? 'kcol' : ''}">${cellHtml(it.row[c])}${refHtml(it.refs?.[c])}</td>`;
      }).join('')}</tr>`).join('')}
    </tbody></table></div>`;
  }

  /* ================================================================ report */
  async function viewReport(from, to, fresh = false) {
    S.view = 'report';
    S.lastReport = [from, to];
    shell(`<div class="loading-page"><span class="spinner"></span>Comparing snapshots…</div>`, 'report');
    let d;
    try {
      d = await api('diff', { conn: S.conn.id, from, to, fresh });
    } catch (e) {
      shell(`<div class="nothing"><div class="big">🧐</div><h2>Could not build the report</h2><p class="muted">${esc(e.message)}</p><a class="btn" href="#/c/${S.conn.id}/history">Pick snapshots</a></div>`, 'report');
      return;
    }
    S.report = d;
    const v = vocab(d.driver || S.conn.driver);
    const T = d.totals;
    const order = (e) => (e.status !== 'changed' ? 1e9 : 0) + (e.data?.inserted || 0) + (e.data?.updated || 0) + (e.data?.deleted || 0) + (e.schema?.count || 0) * 10;
    const tables = [...d.tables].sort((a, b) => order(b) - order(a));
    const other = d.views.added.length + d.views.removed.length + d.views.changed.length + d.triggers.added.length + d.triggers.removed.length + d.triggers.changed.length;

    const hero = `
      <section class="report-hero card">
        <div>
          <span class="eyebrow">Change report</span>
          <h1>${T.tables ? `${plural(T.tables, v.table, v.tables)} changed` : 'Nothing changed'}</h1>
          <div class="timeline-mini">
            <span class="pt">${ic('flag')}<b>${esc(d.from.label)}</b><span class="muted">${clock(d.from.created_at)}</span></span>
            ${ic('arrow', 'dim')}
            <span class="pt">${ic('camera')}<b>${esc(d.to.label)}</b><span class="muted">${clock(d.to.created_at)}</span></span>
            <span class="muted">· ${between(d.from.created_at, d.to.created_at)} apart</span>
          </div>
          <div class="row wrap" style="margin-top:16px">
            <button class="btn sm" id="copyMd">${ic('copy')}Copy summary</button>
            <button class="btn sm" id="dlJson">${ic('code')}Export JSON</button>
            <button class="btn sm ghost" id="refreshDiff">${ic('refresh')}Rebuild</button>
            <a class="btn sm ghost" href="#/c/${S.conn.id}">${ic('grid')}Back to overview</a>
          </div>
        </div>
        <div class="big-nums">
          ${bigNum('ins', T.inserted, 'inserted')}${bigNum('upd', T.updated, 'updated')}${bigNum('del', T.deleted, 'deleted')}${bigNum('sch', T.schema, 'structure')}
        </div>
      </section>`;

    if (!T.tables && !other) {
      shell(`${hero}<div class="card nothing"><div class="big">✨</div><h2>The database is exactly the same</h2>
        <p class="muted">No ${v.rows} were inserted, updated or deleted and no structure changed between these two snapshots.<br>
        Did the action really hit this database (<code>${esc(S.conn.database)}</code>)? Maybe it was queued, cached, or went to another connection.</p></div>`, 'report');
      bindReportButtons(d);
      return;
    }

    const story = buildStory(d, v);
    shell(`
      ${hero}
      <section class="report-grid">
        <div class="card"><div class="card-h"><h3>What happened</h3><span class="spacer"></span><span class="chip">${story.length} facts</span></div>
          <div class="card-b"><div class="story">${story.map((s, i) => `<button class="story-item" data-jump="${esc(s.table || '')}" style="animation-delay:${i * 40}ms"><span class="story-ico ${s.k}">${s.icon}</span><span class="story-text">${s.html}</span></button>`).join('')}</div></div></div>
        <div class="card"><div class="card-h"><h3>Impact map</h3><span class="spacer"></span><span class="muted" style="font-size:12px">changed ${v.tables} + their neighbours</span></div>
          <div class="card-b"><div class="graph-box" id="graph"></div></div></div>
      </section>
      ${other ? `<div class="note warn" style="margin-bottom:16px">${ic('alert')}<span>${[
        d.views.added.length && `views added: ${d.views.added.map(esc).join(', ')}`, d.views.removed.length && `views removed: ${d.views.removed.map(esc).join(', ')}`,
        d.views.changed.length && `views changed: ${d.views.changed.map(esc).join(', ')}`, d.triggers.added.length && `triggers added: ${d.triggers.added.map(esc).join(', ')}`,
        d.triggers.removed.length && `triggers removed: ${d.triggers.removed.map(esc).join(', ')}`, d.triggers.changed.length && `triggers changed: ${d.triggers.changed.map(esc).join(', ')}`,
      ].filter(Boolean).join(' · ')}</span></div>` : ''}
      <div class="sec-h" style="margin:8px 0 12px">${v.Tables} in detail<span class="line"></span><button class="btn sm ghost" id="toggleAll">Collapse all</button></div>
      <section id="cards">${tables.map((t, i) => tableCard(t, v, i)).join('')}</section>`, 'report');

    bindReportButtons(d);
    drawGraph(d, v);
    $('.story').onclick = (e) => { const b = e.target.closest('[data-jump]'); if (b?.dataset.jump) jumpTo(b.dataset.jump); };
    $('#cards').onclick = (e) => {
      const h = e.target.closest('.tcard-h');
      if (h && !e.target.closest('a,button')) h.parentElement.classList.toggle('collapsed');
      const go = e.target.closest('[data-jump]');
      if (go) { e.preventDefault(); jumpTo(go.dataset.jump); }
      const open = e.target.closest('[data-open-table]');
      if (open) openTable(open.dataset.openTable);
    };
    $('#toggleAll').onclick = (e) => {
      const cards = $$('.tcard');
      const collapse = cards.some((c) => !c.classList.contains('collapsed'));
      cards.forEach((c) => c.classList.toggle('collapsed', collapse));
      e.target.textContent = collapse ? 'Expand all' : 'Collapse all';
    };
    loadCodeHints(d);
  }

  const bigNum = (k, n, label) => `<div class="big-num ${k} ${n ? '' : 'zero'}"><b>${compact(n)}</b><span>${label}</span></div>`;

  function jumpTo(name) {
    const el = document.getElementById('t-' + cssId(name));
    if (!el) return;
    el.classList.remove('collapsed');
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.animate([{ boxShadow: '0 0 0 3px rgba(139,92,246,.7)' }, { boxShadow: '0 0 0 0 rgba(139,92,246,0)' }], { duration: 1400 });
  }
  const cssId = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');

  function bindReportButtons(d) {
    $('#refreshDiff').onclick = () => viewReport(d.from.id, d.to.id, true);
    $('#copyMd').onclick = async () => {
      const md = storyMarkdown(d);
      try { await navigator.clipboard.writeText(md); toast('Summary copied as Markdown'); } catch { toast('Clipboard not available', 'err'); }
    };
    $('#dlJson').onclick = () => {
      const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `db-changes_${d.database}_${d.from.id}_${d.to.id}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
  }

  function buildStory(d, v) {
    const out = [];
    const c = (n) => `<code>${esc(n)}</code>`;
    for (const t of d.tables) {
      const D = t.data || {};
      if (t.status === 'new') { out.push({ k: 'ins', icon: '★', table: t.name, html: `New ${v.table} ${c(t.name)} was created${t.rows_after ? ` with ${plural(t.rows_after, v.row, v.rows)}` : ''}` }); continue; }
      if (t.status === 'dropped') { out.push({ k: 'del', icon: '✕', table: t.name, html: `${v.Table} ${c(t.name)} was <b>dropped</b> (had ${plural(t.rows_before, v.row, v.rows)})` }); continue; }
      if (D.inserted) {
        const keys = (D.inserted_rows || []).slice(0, 3).map((r) => r.key).filter(Boolean);
        out.push({ k: 'ins', icon: '+', table: t.name, html: `${plural(D.inserted, 'new ' + v.row, 'new ' + v.rows)} in ${c(t.name)}${keys.length ? ` <span class="muted">(${esc(t.key.join(','))}: ${keys.map(esc).join(', ')}${D.inserted > keys.length ? '…' : ''})</span>` : ''}` });
      }
      if (D.updated) {
        const cols = Object.entries(D.changed_columns || {}).slice(0, 4).map(([k]) => c(k)).join(', ');
        out.push({ k: 'upd', icon: '~', table: t.name, html: `${plural(D.updated, v.row, v.rows)} updated in ${c(t.name)}${cols ? ` — changed ${cols}` : ''}` });
      }
      if (D.deleted) out.push({ k: 'del', icon: '−', table: t.name, html: `${plural(D.deleted, v.row, v.rows)} deleted from ${c(t.name)}` });
      if (t.schema) {
        const s = t.schema;
        const bits = [];
        if (s.columns_added.length) bits.push(`added ${s.columns_added.map((x) => c(x.name)).join(', ')}`);
        if (s.columns_removed.length) bits.push(`removed ${s.columns_removed.map((x) => c(x.name)).join(', ')}`);
        if (s.columns_changed.length) bits.push(`changed ${s.columns_changed.map((x) => c(x.name)).join(', ')}`);
        if (s.indexes_added.length || s.indexes_removed.length) bits.push('indexes changed');
        if (s.fks_added.length || s.fks_removed.length) bits.push('foreign keys changed');
        out.push({ k: 'sch', icon: '◆', table: t.name, html: `Structure of ${c(t.name)}: ${bits.join('; ')}` });
      }
      for (const o of t.impact?.orphans || []) {
        out.push({ k: 'warn', icon: '!', table: t.name, html: `${plural(o.count, v.row, v.rows)} in ${c(o.table)} still point (via ${c(o.via)}) to deleted ${c(t.name)} — possible orphans` });
      }
      const missing = ['inserted_rows', 'updated_rows'].flatMap((l) => (D[l] || []).flatMap((r) => Object.values(r.refs || {}).flat().filter((x) => x.missing)));
      if (missing.length) out.push({ k: 'warn', icon: '!', table: t.name, html: `${c(t.name)} references ${plural(missing.length, 'id', 'ids')} that do not exist in ${[...new Set(missing.map((m) => m.table))].map(c).join(', ')}` });
      if (!D.inserted && !D.updated && !D.deleted && !t.schema && D.note) out.push({ k: 'info', icon: 'i', table: t.name, html: `${c(t.name)} changed — ${esc(D.note)}` });
    }
    return out;
  }

  function storyMarkdown(d) {
    const v = vocab(d.driver);
    const lines = [`## DB changes: ${d.from.label} → ${d.to.label}`, '', `Database \`${d.database}\` · ${clock(d.from.created_at)} → ${clock(d.to.created_at)}`, '',
      `**${d.totals.tables} ${v.tables} changed** · +${d.totals.inserted} inserted · ~${d.totals.updated} updated · −${d.totals.deleted} deleted · ${d.totals.schema} structure changes`, ''];
    for (const s of buildStory(d, v)) {
      const tmp = document.createElement('div');
      tmp.innerHTML = s.html.replace(/<code>(.*?)<\/code>/g, '`$1`');
      lines.push(`- ${s.icon} ${tmp.textContent}`);
    }
    return lines.join('\n');
  }

  function tableCard(t, v, i) {
    const D = t.data || { inserted: 0, updated: 0, deleted: 0, inserted_rows: [], updated_rows: [], deleted_rows: [], changed_columns: {} };
    const stripe = t.status === 'new' ? 'var(--ins)' : t.status === 'dropped' ? 'var(--del)' : D.deleted && !D.inserted ? 'var(--del)' : D.updated ? 'var(--upd)' : D.inserted ? 'var(--ins)' : 'var(--sch)';
    const key = t.key || [];
    const delta = (t.rows_after ?? 0) - (t.rows_before ?? 0);

    let html = `<article class="tcard card ${i > 6 ? 'collapsed' : ''}" id="t-${cssId(t.name)}" style="animation-delay:${Math.min(i, 8) * 50}ms">
      <div class="tcard-h">
        <span class="tstripe" style="background:${stripe}"></span>
        ${ic('chev', 'chev')}
        <h3>${esc(t.name)}</h3>
        ${t.status === 'new' ? '<span class="chip ins">NEW</span>' : t.status === 'dropped' ? '<span class="chip del">DROPPED</span>' : ''}
        ${D.inserted ? `<span class="chip ins">+${fmt(D.inserted)}</span>` : ''}${D.updated ? `<span class="chip upd">~${fmt(D.updated)}</span>` : ''}${D.deleted ? `<span class="chip del">−${fmt(D.deleted)}</span>` : ''}
        ${t.schema && t.status !== 'new' ? `<span class="chip sch">◆ ${t.schema.count} structure</span>` : ''}
        <span class="spacer"></span>
        <span class="count">${fmt(t.rows_before)} → <b>${fmt(t.rows_after)}</b> ${v.rows} ${delta ? `<span style="color:${delta > 0 ? 'var(--ins)' : 'var(--del)'}">(${delta > 0 ? '+' : ''}${fmt(delta)})</span>` : ''}</span>
        ${S.meta?.tables?.[t.name] ? `<button class="btn sm ghost" data-open-table="${esc(t.name)}">${ic('eye')}Inspect</button>` : ''}
      </div><div class="tcard-b">`;

    if (D.note) html += `<div class="note">${ic('info')}<span>${esc(D.note)}</span></div>`;

    if (t.schema && t.status !== 'new') {
      const s = t.schema;
      const items = [
        ...s.columns_added.map((c) => `<div class="schema-item"><span class="chip ins">+ ${v.col}</span><code>${esc(c.name)}</code><span class="ty">${esc(c.type)}${c.nullable ? ' null' : ' not null'}</span>${c.maybe_renamed_from ? `<span class="chip">renamed from ${esc(c.maybe_renamed_from)}?</span>` : ''}</div>`),
        ...s.columns_removed.map((c) => `<div class="schema-item"><span class="chip del">− ${v.col}</span><code>${esc(c.name)}</code><span class="ty">${esc(c.type)}</span></div>`),
        ...s.columns_changed.map((c) => `<div class="schema-item"><span class="chip upd">~ ${v.col}</span><code>${esc(c.name)}</code>${c.what.map((w) => `<span class="ty">${w}: ${esc(fmtVal(c.from[w]))}</span><span class="arrow">→</span><span class="ty" style="color:var(--text)">${esc(fmtVal(c.to[w]))}</span>`).join(' ')}</div>`),
        ...s.indexes_added.map((x) => `<div class="schema-item"><span class="chip ins">+ index</span><code>${esc(x.name)}</code><span class="ty">(${x.columns.map(esc).join(', ')})${x.unique ? ' unique' : ''}</span></div>`),
        ...s.indexes_removed.map((x) => `<div class="schema-item"><span class="chip del">− index</span><code>${esc(x.name)}</code><span class="ty">(${x.columns.map(esc).join(', ')})</span></div>`),
        ...s.fks_added.map((x) => `<div class="schema-item"><span class="chip ins">+ FK</span><code>${esc(x.column)}</code><span class="arrow">→</span><code>${esc(x.ref_table)}.${esc(x.ref_column)}</code></div>`),
        ...s.fks_removed.map((x) => `<div class="schema-item"><span class="chip del">− FK</span><code>${esc(x.column)}</code><span class="arrow">→</span><code>${esc(x.ref_table)}.${esc(x.ref_column)}</code></div>`),
      ];
      html += `<div class="sec"><div class="sec-h">Structure<span class="line"></span></div><div class="schema-list">${items.join('')}</div></div>`;
    }

    const shown = (n, list) => (n > list.length ? `<span class="muted" style="text-transform:none;letter-spacing:0;font-weight:500">showing ${fmt(list.length)} of ${fmt(n)}</span>` : '');
    if (D.inserted_rows?.length) {
      const cols = t.columns.filter((c) => D.inserted_rows.some((r) => c in r.row));
      html += `<div class="sec"><div class="sec-h" style="color:var(--ins)">+ ${t.status === 'new' ? v.Rows : 'Inserted'} ${shown(D.inserted, D.inserted_rows)}<span class="line"></span></div>${dataTable(cols, D.inserted_rows, 'ins', key)}</div>`;
    }
    if (D.updated_rows?.length) {
      const changedCols = Object.keys(D.changed_columns || {});
      html += `<div class="sec"><div class="sec-h" style="color:var(--upd)">~ Updated ${shown(D.updated, D.updated_rows)}<span class="line"></span></div>
        <div class="colfreq" style="margin-bottom:8px">${Object.entries(D.changed_columns || {}).map(([c, n]) => `<span class="chip upd">${esc(c)} ×${fmt(n)}</span>`).join('')}</div>
        ${dataTable([...key.filter((k) => !changedCols.includes(k)), ...changedCols], D.updated_rows, 'upd', key)}</div>`;
    }
    if (D.deleted_rows?.length) {
      const cols = [...new Set(D.deleted_rows.flatMap((r) => Object.keys(r.row)))];
      html += `<div class="sec"><div class="sec-h" style="color:var(--del)">− Deleted ${shown(D.deleted, D.deleted_rows)}<span class="line"></span></div>${dataTable(cols, D.deleted_rows, 'del', key)}</div>`;
    }

    const im = t.impact || { parents: [], children: [], views: [], triggers: [], orphans: [] };
    if (im.parents.length || im.children.length || im.views.length || im.triggers.length) {
      const rel = (r, dir) => `<div class="rel ${r.changed ? 'hot' : ''}">${dir === 'out' ? `<span class="via">${esc(r.via)}</span> → ` : ''}
        ${r.table ? `<a href="#" data-jump="${esc(r.table)}"><code>${esc(r.table)}</code></a>` : `<code>${esc(r.morph)}_type</code>`}${dir === 'in' ? ` <span class="via">.${esc(r.via)}</span>` : ''}
        ${r.changed ? '<span class="chip upd" style="height:20px">also changed</span>' : ''}<span class="tag">${r.type === 'fk' ? 'FK' : r.type === 'morph' ? 'polymorphic' : 'inferred'}</span>
        ${r.on_delete && !['NO ACTION', 'RESTRICT'].includes(r.on_delete) ? `<span class="tag">on delete ${esc(r.on_delete)}</span>` : ''}</div>`;
      html += `<div class="sec"><div class="sec-h">Where this can ripple<span class="line"></span></div>
        ${im.orphans.map((o) => `<div class="note bad" style="margin-bottom:8px">${ic('alert')}<span>${plural(o.count, v.row, v.rows)} in <code>${esc(o.table)}</code> still reference deleted ${v.rows} via <code>${esc(o.via)}</code>.</span></div>`).join('')}
        <div class="impact">
          <div class="impact-col"><h4>Uses (parents)</h4>${im.parents.map((r) => rel(r, 'out')).join('') || '<div class="dim">—</div>'}</div>
          <div class="impact-col"><h4>Used by (children)</h4>${im.children.map((r) => rel(r, 'in')).join('') || '<div class="dim">—</div>'}</div>
        </div>
        ${im.views.length || im.triggers.length ? `<div class="colfreq" style="margin-top:10px">${im.views.map((x) => `<span class="chip sch">view: ${esc(x)}</span>`).join('')}${im.triggers.map((x) => `<span class="chip upd">trigger ${esc(x.timing)} ${esc(x.event)}: ${esc(x.name)}</span>`).join('')}</div>` : ''}
      </div>`;
    }
    html += `<div class="sec code-sec" data-code="${esc(t.name)}"></div>`;
    return html + '</div></article>';
  }

  const fmtVal = (x) => (x === null || x === undefined ? 'NULL' : typeof x === 'boolean' ? (x ? 'yes' : 'no') : String(x));

  async function loadCodeHints(d) {
    const secs = $$('.code-sec');
    if (!S.conn.project_path) {
      if (secs[0]) secs[0].innerHTML = `<div class="note">${ic('code')}<span>Tip: add your <b>project folder</b> to this connection (Switch → edit) and DB Checker will point to the models, controllers and services that touch each ${V().table}.</span></div>`;
      return;
    }
    secs.forEach((s) => { s.innerHTML = `<div class="sec-h">Where in code?<span class="line"></span></div><div class="skeleton" style="height:60px"></div>`; });
    let r;
    try {
      r = await api('code', { conn: S.conn.id, tables: d.tables.map((t) => t.name) });
    } catch (e) {
      secs.forEach((s) => { s.innerHTML = `<div class="note bad">${ic('alert')}<span>${esc(e.message)}</span></div>`; });
      return;
    }
    for (const s of secs) {
      const info = r?.tables?.[s.dataset.code];
      if (!info || !info.hits.length) { s.innerHTML = `<div class="sec-h">Where in code?<span class="line"></span></div><div class="dim" style="font-size:12.5px">No references found in ${fmt(r?.files_scanned)} files.</div>`; continue; }
      s.innerHTML = `<div class="sec-h">Where in code? <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:500">${fmt(info.total)} hits · likely writes first</span><span class="line"></span></div>
        <div class="code-hits">${info.hits.map((h) => `<div class="code-hit ${h.write ? 'write' : ''}">
          <span class="layer ${h.write ? 'w' : ''}">${h.write ? 'write · ' : ''}${esc(h.layer)}</span>
          <span class="file" title="${esc(h.file)}:${h.line}">${esc(h.file.replace(/[^/]+$/, ''))}<b>${esc(h.file.split('/').pop())}</b>:${h.line}</span>
          <pre>${esc(h.code)}</pre></div>`).join('')}</div>`;
    }
  }

  /* ================================================================ impact graph */
  function drawGraph(d, v) {
    const box = $('#graph');
    if (!box) return;
    const W = box.clientWidth || 560;
    const H = box.clientHeight || 360;
    const changed = new Map(d.tables.map((t) => [t.name, t]));
    const nodes = new Map();
    const add = (name, hot) => { if (!nodes.has(name)) nodes.set(name, { name, hot, x: W / 2 + (Math.random() - 0.5) * W * 0.6, y: H / 2 + (Math.random() - 0.5) * H * 0.6, vx: 0, vy: 0 }); };
    for (const n of changed.keys()) add(n, true);
    const edges = [];
    for (const e of d.edges) {
      if (!e.to || e.from === e.to) continue;
      if (!changed.has(e.from) && !changed.has(e.to)) continue;
      if (nodes.size > 40 && (!nodes.has(e.from) || !nodes.has(e.to))) continue;
      add(e.from, changed.has(e.from));
      add(e.to, changed.has(e.to));
      edges.push(e);
    }
    const list = [...nodes.values()];
    const color = (n) => {
      const t = changed.get(n.name);
      if (!t) return 'var(--dim)';
      const D = t.data || {};
      if (t.status === 'new') return 'var(--ins)';
      if (t.status === 'dropped') return 'var(--del)';
      if (D.updated >= (D.inserted || 0) && D.updated >= (D.deleted || 0) && D.updated) return 'var(--upd)';
      if (D.inserted >= (D.deleted || 0) && D.inserted) return 'var(--ins)';
      if (D.deleted) return 'var(--del)';
      return 'var(--sch)';
    };
    const mag = (n) => { const t = changed.get(n.name); if (!t) return 0; const D = t.data || {}; return (D.inserted || 0) + (D.updated || 0) + (D.deleted || 0) + (t.schema?.count || 0); };
    const radius = (n) => (n.hot ? 14 + Math.min(14, Math.log2(mag(n) + 1) * 3) : 8);

    // tiny force layout
    for (let it = 0; it < 260; it++) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i]; const b = list[j];
          let dx = a.x - b.x; let dy = a.y - b.y;
          const dist = Math.max(20, Math.hypot(dx, dy));
          const f = 5200 / (dist * dist);
          dx /= dist; dy /= dist;
          a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
        }
      }
      for (const e of edges) {
        const a = nodes.get(e.from); const b = nodes.get(e.to);
        const dx = b.x - a.x; const dy = b.y - a.y;
        const dist = Math.max(1, Math.hypot(dx, dy));
        const f = (dist - Math.min(170, W / 3.2)) * 0.01;
        a.vx += (dx / dist) * f; a.vy += (dy / dist) * f; b.vx -= (dx / dist) * f; b.vy -= (dy / dist) * f;
      }
      for (const n of list) {
        n.vx += (W / 2 - n.x) * 0.0015; n.vy += (H / 2 - n.y) * 0.003;
        n.x += n.vx * 0.5; n.y += n.vy * 0.5; n.vx *= 0.6; n.vy *= 0.6;
        n.x = Math.max(60, Math.min(W - 60, n.x)); n.y = Math.max(28, Math.min(H - 40, n.y));
      }
    }
    const t = (s, m) => (s.length > m ? s.slice(0, m - 1) + '…' : s);
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Relations between changed ${v.tables}">
      <defs><linearGradient id="edgeGrad"><stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#22d3ee"/></linearGradient>
        <marker id="arr" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="var(--line-2)"/></marker></defs>
      ${edges.map((e) => {
        const a = nodes.get(e.from); const b = nodes.get(e.to);
        const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const rb = radius(b) + 3;
        const x2 = b.x - ((b.x - a.x) / dist) * rb; const y2 = b.y - ((b.y - a.y) / dist) * rb;
        return `<path class="edge ${a.hot && b.hot ? 'hot' : ''} ${e.type === 'inferred' ? 'inferred' : ''}" d="M${a.x},${a.y} L${x2},${y2}" marker-end="url(#arr)"><title>${esc(e.from)}.${esc(e.col)} → ${esc(e.to)}.${esc(e.to_col)} (${e.type})</title></path>`;
      }).join('')}
      ${list.map((n) => {
        const r = radius(n); const c = color(n); const tt = changed.get(n.name); const D = tt?.data || {};
        const sub = tt ? [D.inserted && '+' + D.inserted, D.updated && '~' + D.updated, D.deleted && '−' + D.deleted, tt.schema && '◆'].filter(Boolean).join(' ') : '';
        return `<g class="node" data-jump="${esc(n.name)}" transform="translate(${n.x},${n.y})">
          ${n.hot ? `<circle r="${r + 6}" fill="${c}" opacity=".15"><animate attributeName="r" values="${r + 3};${r + 9};${r + 3}" dur="2.6s" repeatCount="indefinite"/></circle>` : ''}
          <circle r="${r}" fill="${n.hot ? c : 'var(--surface-3)'}" stroke="${n.hot ? 'none' : 'var(--line-2)'}" opacity="${n.hot ? 0.9 : 1}"/>
          <text y="${r + 14}" text-anchor="middle">${esc(t(n.name, 22))}</text>
          ${sub ? `<text class="sub" y="${r + 26}" text-anchor="middle">${esc(sub)}</text>` : ''}
          <title>${esc(n.name)}${n.hot ? '' : ' (related, unchanged)'}</title></g>`;
      }).join('')}
    </svg>
    <div class="graph-legend"><span>● changed</span><span style="color:var(--dim)">● related, unchanged</span><span>— FK</span><span>┄ inferred</span></div>`;
    box.onclick = (e) => { const g = e.target.closest('[data-jump]'); if (g) jumpTo(g.dataset.jump); };
    if (!edges.length && list.length) box.insertAdjacentHTML('beforeend', `<div class="graph-legend" style="top:8px;bottom:auto">No relations found between these ${v.tables}.</div>`);
  }

  /* ================================================================ history */
  let SEL = [];
  async function viewHistory() {
    S.view = 'history';
    S.snaps = await api('snap.list', { conn: S.conn.id });
    const v = V();
    const list = S.snaps;
    SEL = SEL.filter((id) => list.some((s) => s.id === id));
    shell(`
      <div class="row wrap" style="margin-bottom:18px">
        <div><h1 style="margin:0;font-size:26px;letter-spacing:-.02em">Snapshot history</h1>
          <div class="muted">Pick any two snapshots to compare, or choose which one live-watch compares against.</div></div>
        <span class="spacer"></span>
        <button class="btn primary" id="newSnap">${ic('camera')}New snapshot</button>
      </div>
      <div class="hist">
        ${list.map((s, i) => {
          const prev = list.slice(i + 1).find((x) => x.status === 'complete');
          const dRows = prev && s.status === 'complete' ? s.rows - prev.rows : 0;
          return `<div class="hist-item card ${s.id === S.baseline ? 'base' : ''} ${SEL.includes(s.id) ? 'sel' : ''}" style="animation-delay:${Math.min(i, 12) * 40}ms">
            <label class="check"><input type="checkbox" data-sel="${s.id}" ${SEL.includes(s.id) ? 'checked' : ''} ${s.status !== 'complete' ? 'disabled' : ''} aria-label="select"></label>
            <div style="min-width:0">
              <div class="t">${esc(s.label)}${s.id === S.baseline ? '<span class="chip acc"><span class="dot"></span>baseline</span>' : ''}${s.status !== 'complete' ? '<span class="chip del">incomplete</span>' : ''}
                ${prev && dRows ? `<span class="chip ${dRows > 0 ? 'ins' : 'del'}">${dRows > 0 ? '+' : ''}${fmt(dRows)} ${v.rows}</span>` : ''}</div>
              <div class="s">${clock(s.created_at)} · ${ago(s.created_at)}${s.status === 'complete' ? ` · ${fmt(s.tables)} ${v.tables} · ${fmt(s.rows)} ${v.rows} · ${bytes(s.size)}` : ''}</div>
            </div>
            <div class="hist-actions">
              ${prev ? `<a class="btn sm" href="#/c/${S.conn.id}/report/${prev.id}/${s.id}" title="Compare with the previous snapshot">${ic('report')}vs previous</a>` : ''}
              ${s.status === 'complete' && s.id !== S.baseline ? `<button class="btn sm ghost" data-base="${s.id}">${ic('flag')}Set baseline</button>` : ''}
              <button class="btn sm icon ghost" data-rename="${s.id}" title="Rename">${ic('edit')}</button>
              <button class="btn sm icon ghost danger" data-delete="${s.id}" title="Delete">${ic('trash')}</button>
            </div>
          </div>`;
        }).join('')}
      </div>
      <div id="cmpBar"></div>`, 'history');
    renderCompareBar();

    $('#newSnap').onclick = async () => {
      const label = await promptBox('Name this snapshot', 'e.g. Before checkout', `Snapshot ${list.length + 1}`);
      if (label === null) return;
      stopWatch();
      const sum = await runSnapshot(label);
      if (sum) {
        S.meta = await api('snap.meta', { conn: S.conn.id, snap: sum.id });
        toast('Snapshot saved');
      }
      if (ls.get('watch:' + S.conn.id, true)) startWatch();
      viewHistory();
    };
    $('.hist').onclick = async (e) => {
      const b = e.target.closest('[data-base],[data-rename],[data-delete]');
      const cb = e.target.closest('[data-sel]');
      if (cb) {
        const id = cb.dataset.sel;
        SEL = cb.checked ? [...SEL.filter((x) => x !== id), id].slice(-2) : SEL.filter((x) => x !== id);
        $$('[data-sel]').forEach((x) => { x.checked = SEL.includes(x.dataset.sel); x.closest('.hist-item').classList.toggle('sel', x.checked); });
        renderCompareBar();
        return;
      }
      if (!b) return;
      if (b.dataset.base) { setBaseline(b.dataset.base); toast('Baseline changed — live watch now compares against it'); viewHistory(); }
      if (b.dataset.rename) {
        const s = snapById(b.dataset.rename);
        const label = await promptBox('Rename snapshot', '', s.label);
        if (label === null) return;
        await api('snap.rename', { conn: S.conn.id, snap: s.id, label });
        viewHistory();
      }
      if (b.dataset.delete) {
        const s = snapById(b.dataset.delete);
        const complete = S.snaps.filter((x) => x.status === 'complete');
        if (complete.length === 1 && s.status === 'complete') return toast('Keep at least one snapshot.', 'warn');
        if (!(await confirmBox(`Delete “${esc(s.label)}”?`, 'This snapshot and its cached reports are removed. Other snapshots stay intact.', 'Delete'))) return;
        await api('snap.delete', { conn: S.conn.id, snap: s.id });
        S.snaps = await api('snap.list', { conn: S.conn.id });
        const latest = latestId();
        if (S.baseline === s.id) setBaseline(latest);
        if (S.meta.id === s.id) S.meta = await api('snap.meta', { conn: S.conn.id, snap: latest });
        if (S.lastReport?.includes(s.id)) S.lastReport = null;
        toast('Snapshot deleted');
        viewHistory();
      }
    };
  }

  function renderCompareBar() {
    const bar = $('#cmpBar');
    if (!bar) return;
    if (SEL.length !== 2) { bar.innerHTML = SEL.length === 1 ? `<div class="compare-bar"><span class="muted">Select one more snapshot to compare</span></div>` : ''; return; }
    const [a, b] = [...SEL].sort();
    bar.innerHTML = `<div class="compare-bar"><span><b>${esc(snapById(a).label)}</b> <span class="muted">→</span> <b>${esc(snapById(b).label)}</b></span>
      <a class="btn primary" href="#/c/${S.conn.id}/report/${a}/${b}">${ic('report')}Compare</a></div>`;
  }

  /* ================================================================ modals */
  function modal(html) {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<div class="modal card" role="dialog">${html}</div>`;
    document.body.appendChild(wrap);
    return wrap;
  }
  function confirmBox(title, text, ok = 'OK') {
    return new Promise((resolve) => {
      const m = modal(`<h3>${title}</h3><p>${text}</p><div class="row"><span class="spacer"></span><button class="btn ghost" data-r="0">Cancel</button><button class="btn primary" data-r="1">${esc(ok)}</button></div>`);
      const done = (v) => { m.remove(); document.removeEventListener('keydown', key); resolve(v); };
      const key = (e) => { if (e.key === 'Escape') done(false); };
      document.addEventListener('keydown', key);
      m.onclick = (e) => { const b = e.target.closest('[data-r]'); if (b) done(b.dataset.r === '1'); else if (e.target === m) done(false); };
      m.querySelector('[data-r="1"]').focus();
    });
  }
  function promptBox(title, placeholder, value = '') {
    return new Promise((resolve) => {
      const m = modal(`<h3>${esc(title)}</h3><form><input class="input" maxlength="80" placeholder="${esc(placeholder)}" value="${esc(value)}"><div class="row" style="margin-top:16px"><span class="spacer"></span><button type="button" class="btn ghost" data-r="0">Cancel</button><button class="btn primary">OK</button></div></form>`);
      const input = m.querySelector('input');
      const done = (v) => { m.remove(); resolve(v); };
      m.querySelector('form').onsubmit = (e) => { e.preventDefault(); done(input.value.trim() || value); };
      m.onclick = (e) => { if (e.target.closest('[data-r]') || e.target === m) done(null); };
      m.onkeydown = (e) => { if (e.key === 'Escape') done(null); };
      input.focus();
      input.select();
    });
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.watch.on) tick(); });
  setInterval(() => { if (S.view === 'overview' && S.watch.on) { const st = $('#watchStatus'); if (st && !S.watch.changes.length) st.innerHTML = watchStatusHtml(); } }, 5000);
})();
