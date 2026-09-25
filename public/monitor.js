/* WhatChanged — Logs, Requests and Queues pages (live, via Server-Sent Events). */
(() => {
  'use strict';

  const D = window.DBC;
  const { S, $, $$, esc, fmt, plural, bytes, ago, ls, api, toast, ic } = D;

  /* ================================================================ live state */
  const MAX_PANES = 5;
  const MAX_DOM = 1500; // log lines rendered per pane
  const M = {
    es: null, connId: null, connected: false,
    logs: new Map(), // id -> { info, lines, errors, warns, lastLvl }
    requests: [], jobs: [], queues: null, qErrors: {}, status: null, ws: null,
    unseen: { logs: 0, requests: 0, jobs: 0 },
    panes: new Map(), // per-pane UI state
    qFirst: new Map(), // queue id -> counts when the page opened (for deltas)
    reqLimit: 100, jobLimit: 60, reqFilter: { dir: 'all', kinds: new Set(['page', 'api', 'form', 'webhook', 'websocket', 'other', 'log']), errors: false, q: '' },
  };

  D.hooks.connOpened = (conn) => startStream(conn.id);
  D.hooks.connClosed = () => stopStream();
  D.hooks.shellRendered = () => { updateBadges(); };
  D.openProject = openProject;

  function startStream(id) {
    stopStream();
    Object.assign(M, { connId: id, logs: new Map(), requests: [], jobs: [], queues: null, qErrors: {}, status: null, ws: null, unseen: { logs: 0, requests: 0, jobs: 0 }, panes: new Map(), qFirst: new Map() });
    const es = new EventSource(`/api/stream?conn=${encodeURIComponent(id)}&token=${encodeURIComponent(D.TOKEN)}`);
    es.onmessage = (e) => {
      let ev;
      try { ev = JSON.parse(e.data); } catch { return; }
      handle(ev);
    };
    es.onopen = () => { M.connected = true; updateLive(); };
    es.onerror = () => { M.connected = false; updateLive(); };
    M.es = es;
  }
  function stopStream() { M.es?.close(); M.es = null; M.connected = false; }

  function handle(ev) {
    D.hooks.monitorEvent?.(ev); // watched queries (queries.js) listen here too
    switch (ev.type) {
      case 'hello':
        M.logs = new Map();
        for (const l of ev.logs) addLog(l);
        M.requests = ev.requests || [];
        M.jobs = ev.jobs || [];
        M.queues = ev.queues;
        M.status = ev.status;
        M.qErrors = ev.status?.queueErrors || {};
        rerender();
        break;
      case 'log': {
        const e = M.logs.get(ev.id);
        if (!e) return;
        if (ev.reset) { e.lines = []; e.errors = 0; e.warns = 0; }
        if ('error' in ev) e.info.error = ev.error;
        const added = addLines(e, ev.lines);
        if (S.view === 'logs') paneAppend(ev.id, added, ev.reset);
        else if (!ev.initial) M.unseen.logs += added.filter((l) => l.g === 'error' || l.g === 'fatal').length;
        updateBadges();
        break;
      }
      case 'log-added': addLog(ev.log); if (S.view === 'logs') viewLogs(); break;
      case 'log-removed': M.logs.delete(ev.id); if (S.view === 'logs') viewLogs(); break;
      case 'request': {
        const i = M.requests.findIndex((r) => r.id === ev.req.id);
        if (i >= 0) M.requests[i] = ev.req;
        else {
          M.requests.push(ev.req);
          if (M.requests.length > 400) M.requests.shift();
          if (S.view !== 'requests' && ev.req.kind !== 'asset') M.unseen.requests++;
        }
        if (S.view === 'requests') later('req', renderReqList);
        updateBadges();
        break;
      }
      case 'requests-cleared': M.requests = []; if (S.view === 'requests') renderReqList(); break;
      case 'job':
        M.jobs.push(ev.job);
        if (M.jobs.length > 1000) M.jobs.shift();
        if (S.view === 'queues') later('jobs', renderJobs);
        else if (ev.job.status === 'failed') M.unseen.jobs++;
        updateBadges();
        break;
      case 'queues':
        M.queues = ev.data;
        M.qErrors = ev.errors || {};
        if (S.view === 'queues') renderQueueCards();
        break;
      case 'status':
        M.status = ev.status;
        if (S.view === 'requests') renderProxyStatus();
        break;
      default:
    }
  }

  const timers = {};
  function later(key, fn, ms = 200) {
    if (timers[key]) return;
    timers[key] = setTimeout(() => { timers[key] = null; fn(); }, ms);
  }

  function rerender() {
    if (S.view === 'logs') viewLogs();
    else if (S.view === 'requests') { renderReqList(); renderProxyStatus(); }
    else if (S.view === 'queues') { renderQueueCards(); renderJobs(); }
    updateBadges();
  }

  function updateBadges() {
    const set = (id, n, cls) => { const el = $('#badge-' + id); if (el) { el.className = n ? 'n ' + cls : ''; el.textContent = n ? (n > 99 ? '99+' : n) : ''; } };
    set('logs', M.unseen.logs, 'err');
    set('requests', M.unseen.requests, '');
    set('queues', M.unseen.jobs, 'err');
  }

  function updateLive() {
    const el = $('#monLive');
    if (el) el.innerHTML = liveHtml();
  }
  const liveHtml = () => (M.connected ? `<span class="live-dot on"></span>Live` : `<span class="live-dot alert"></span>Reconnecting…`);

  function head(title, sub, actions = '') {
    return `<div class="mon-head">
      <div><h1>${title}</h1><div class="muted">${sub}</div></div>
      <span class="spacer"></span><span class="mon-live" id="monLive">${liveHtml()}</span>${actions}
    </div>`;
  }

  async function loadWs() {
    M.ws = await api('ws.get', { conn: S.conn.id });
    S.conn.folders = M.ws.folders;
    return M.ws;
  }

  const copy = async (text, what = 'Copied') => {
    try { await navigator.clipboard.writeText(text); toast(what); } catch { toast('Clipboard is not available here', 'err'); }
  };
  const time = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString(undefined, { hour12: false }); };

  /* ================================================================ project settings */

  async function openProject() {
    const folders = (S.conn.folders || []).map((f) => ({ ...f }));
    const m = D.modal(`<div class="row"><h3 style="margin:0">${ic('folder')} Project folders</h3><span class="spacer"></span><button class="btn sm icon ghost" data-close>${ic('x')}</button></div>
      <p class="muted" style="margin:6px 0 14px">All folders of this project — backend, frontend, workers, microservices. Any language. Used for code hints, finding log files and the API / queue code maps.</p>
      <form id="projForm"><div id="projRows"></div>
      <div class="row" style="margin-top:16px"><span class="spacer"></span><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">${ic('check')}Save</button></div></form>`);
    m.querySelector('.modal').classList.add('wide');
    const draw = () => { $('#projRows', m).innerHTML = D.folderRows(folders); };
    draw();
    m.oninput = (e) => D.folderInput(folders, e.target);
    m.onclick = async (e) => {
      if (e.target === m || e.target.closest('[data-close]')) return m.remove();
      const b = e.target.closest('button');
      if (b && (await D.folderClick(folders, b))) draw();
    };
    $('#projForm', m).onsubmit = async (e) => {
      e.preventDefault();
      try {
        S.conn.folders = await api('ws.folders', { conn: S.conn.id, folders });
        m.remove();
        toast(`Saved ${plural(S.conn.folders.length, 'folder', 'folders')}`);
        if (M.ws) M.ws.folders = S.conn.folders;
      } catch (err) { toast(esc(err.message), 'err'); }
    };
  }

  function needFolders(what) {
    return `<div class="note">${ic('folder')}<span>Add your project folders first (<a href="javascript:void 0" data-project>Project</a>) — then WhatChanged can ${what}.</span></div>`;
  }
  document.addEventListener('click', (e) => { if (e.target.closest('[data-project]')) { e.preventDefault(); openProject(); } });

  /* ================================================================ LOGS */

  function addLog(l) {
    const e = { info: { id: l.id, path: l.path, label: l.label, kind: l.kind, error: l.error }, lines: [], errors: 0, warns: 0, lastLvl: '' };
    M.logs.set(l.id, e);
    addLines(e, l.lines || []);
  }

  /** Continuation lines (stack traces) inherit the level of the line they belong to. */
  function addLines(e, lines) {
    for (const l of lines) {
      if (l.c && !l.l) l.g = e.lastLvl;
      else { l.g = l.l || ''; e.lastLvl = l.g; }
      if (!l.c) { if (l.g === 'error' || l.g === 'fatal') e.errors++; else if (l.g === 'warn') e.warns++; }
    }
    e.lines.push(...lines);
    if (e.lines.length > 3000) e.lines.splice(0, e.lines.length - 3000);
    return lines;
  }

  const openKey = () => 'logs-open:' + S.conn.id;
  function openIds() {
    const all = [...M.logs.keys()];
    let ids = ls.get(openKey(), null);
    ids = (ids || all.slice(0, 3)).filter((id) => M.logs.has(id));
    return ids.slice(0, MAX_PANES);
  }
  const setOpen = (ids) => ls.set(openKey(), ids);

  function pstate(id) {
    if (!M.panes.has(id)) M.panes.set(id, { q: '', re: null, levels: new Set(['error', 'warn', 'info', 'debug', 'plain']), wrap: ls.get('logs-wrap', false), paused: false, sel: new Set(), last: null, fresh: 0 });
    return M.panes.get(id);
  }
  const lvlClass = (g) => (g === 'fatal' || g === 'error' ? 'error' : g === 'warn' ? 'warn' : g === 'info' ? 'info' : g === 'debug' || g === 'trace' ? 'debug' : 'plain');

  function matches(l, st) {
    if (!st.levels.has(lvlClass(l.g))) return false;
    if (!st.q) return true;
    return st.re ? st.re.test(l.t) : l.t.toLowerCase().includes(st.q.toLowerCase());
  }

  function hl(text, st) {
    const t = esc(text);
    if (!st.q) return t;
    try {
      const re = st.re ? new RegExp(st.re.source, 'gi') : new RegExp(st.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      return t.replace(re, (x) => `<mark>${x}</mark>`);
    } catch { return t; }
  }

  const lineHtml = (l, st) => `<div class="ll lv-${lvlClass(l.g)}${l.c ? ' cont' : ''}${st.sel.has(l.n) ? ' sel' : ''}" data-n="${l.n}"><span class="lt">${hl(l.t, st)}</span><button class="ll-copy" title="Copy this entry">${ic('copy')}</button></div>`;

  async function viewLogs() {
    const v = S.view;
    if (v !== 'logs') return;
    M.unseen.logs = 0;
    const ids = openIds();
    const cols = ls.get('logs-cols', 'auto');
    const logs = [...M.logs.values()];
    D.shell(`
      ${head('Logs', 'Live tail of any log file — any language, any framework. Up to 5 side by side.', `
        <select class="select sm-select" id="logCols" title="Layout">${['auto', '1', '2', '3'].map((c) => `<option value="${c}" ${String(cols) === c ? 'selected' : ''}>${c === 'auto' ? 'Auto layout' : c + ' column' + (c === '1' ? '' : 's')}</option>`).join('')}</select>
        <button class="btn" id="addLogFile">${ic('plus')}Add file</button>
        <button class="btn primary" id="findLogs">${ic('search')}Find log files</button>`)}
      ${logs.length ? `<div class="log-chips">${logs.map((e) => `
        <span class="log-chip ${ids.includes(e.info.id) ? 'on' : ''}" data-toggle="${e.info.id}" title="${esc(e.info.path)}">
          <span class="dot ${e.info.error ? 'bad' : ''}"></span>${esc(e.info.label)}
          ${e.errors ? `<b class="c-err">${fmt(e.errors)}</b>` : ''}
          <button class="x" data-unwatch="${e.info.id}" title="Stop watching">${ic('x')}</button>
        </span>`).join('')}<span class="muted" style="font-size:12px">click to show / hide · max ${MAX_PANES} open</span></div>` : ''}
      ${!logs.length ? `<div class="card empty-state">
          <div class="big">📜</div><h2>No log files yet</h2>
          <p class="muted">Let WhatChanged look through your project folders (and common places like PM2, Apache, Nginx, PHP, MySQL) for log files,<br>or pick a file yourself.</p>
          <div class="row" style="justify-content:center"><button class="btn primary lg" data-find>${ic('search')}Find log files</button><button class="btn lg" data-addfile>${ic('plus')}Pick a file</button></div>
          ${(S.conn.folders || []).length ? '' : needFolders('search your code folders for logs')}
        </div>` : !ids.length ? `<div class="note">${ic('info')}<span>Click a file above to open it.</span></div>` : ''}
      <section class="log-grid cols-${cols === 'auto' ? Math.min(ids.length, 3) || 1 : cols}" id="logGrid">${ids.map(paneHtml).join('')}</section>`, 'logs');
    updateBadges();

    $('#findLogs').onclick = () => discoverModal();
    $('#addLogFile').onclick = addFileManually;
    $('#logCols').onchange = (e) => { ls.set('logs-cols', e.target.value); viewLogs(); };
    const main = $('.page');
    main.onclick = onLogsClick;
    main.oninput = onLogsInput;
    for (const id of ids) { const b = paneBodyEl(id); if (b) { b.scrollTop = b.scrollHeight; b.onscroll = () => onPaneScroll(id); } }
  }

  function paneHtml(id) {
    const e = M.logs.get(id);
    const st = pstate(id);
    const lv = [['error', 'Errors'], ['warn', 'Warn'], ['info', 'Info'], ['debug', 'Debug'], ['plain', 'Other']];
    return `<section class="lpane card ${st.wrap ? 'wrap' : ''}" data-pane="${id}">
      <header class="lp-h">
        <span class="live-dot ${e.info.error ? 'alert' : st.paused ? '' : 'on'}"></span>
        <div class="lp-title"><b title="${esc(e.info.path)}">${esc(e.info.label)}</b><span class="muted">${esc(e.info.kind)}</span></div>
        <span class="lp-count err" data-count="err">${e.errors ? '● ' + fmt(e.errors) : ''}</span>
        <span class="lp-count warn" data-count="warn">${e.warns ? '● ' + fmt(e.warns) : ''}</span>
        <span class="spacer"></span>
        <button class="btn sm icon ghost" data-act="copy" title="Copy selected lines, or everything that matches the filter">${ic('copy')}</button>
        <button class="btn sm icon ghost ${st.wrap ? 'on' : ''}" data-act="wrap" title="Wrap long lines">${ic('wrap')}</button>
        <button class="btn sm icon ghost" data-act="pause" title="${st.paused ? 'Resume' : 'Pause auto-scroll'}">${ic(st.paused ? 'play' : 'pause')}</button>
        <button class="btn sm icon ghost" data-act="clear" title="Clear this view (the file is not touched)">${ic('eraser')}</button>
        <button class="btn sm icon ghost" data-act="close" title="Close pane">${ic('x')}</button>
      </header>
      <div class="lp-tools">
        <div class="search">${ic('search')}<input class="input" data-q placeholder="Filter… text or /regex/" value="${esc(st.q)}"></div>
        <div class="lv-toggles">${lv.map(([k, t]) => `<button class="lv-t lv-${k} ${st.levels.has(k) ? 'on' : ''}" data-lv="${k}">${t}</button>`).join('')}</div>
      </div>
      ${e.info.error ? `<div class="lp-err">${ic('alert')}${esc(e.info.error)}</div>` : ''}
      <div class="lp-body" data-body="${id}">${paneBodyHtml(id)}</div>
      <footer class="lp-f"><span class="mono" title="${esc(e.info.path)}">${esc(e.info.path)}</span><span class="spacer"></span>
        <span data-sel>${st.sel.size ? `${st.sel.size} selected · <a href="javascript:void 0" data-act="unselect">clear</a>` : 'click lines to select · shift+click for a range'}</span>
        <button class="btn sm new-lines ${st.fresh ? '' : 'hidden'}" data-act="bottom">${ic('down')}<span>${fmt(st.fresh)}</span> new</button></footer>
    </section>`;
  }

  function paneBodyHtml(id) {
    const e = M.logs.get(id);
    const st = pstate(id);
    const list = e.lines.filter((l) => matches(l, st));
    const shown = list.slice(-MAX_DOM);
    if (!list.length) return `<div class="lp-empty">${e.lines.length ? 'Nothing matches the filter.' : 'Waiting for new lines…'}</div>`;
    return (list.length > shown.length ? `<div class="lp-more">showing the newest ${fmt(shown.length)} of ${fmt(list.length)} matching lines · use Copy to get all</div>` : '') + shown.map((l) => lineHtml(l, st)).join('');
  }

  const paneEl = (id) => $(`[data-pane="${id}"]`);
  const paneBodyEl = (id) => $(`[data-body="${id}"]`);

  function refreshPane(id, keepScroll = false) {
    const b = paneBodyEl(id);
    if (!b) return;
    const top = b.scrollTop;
    b.innerHTML = paneBodyHtml(id);
    b.scrollTop = keepScroll ? top : b.scrollHeight;
    updatePaneMeta(id);
  }

  function updatePaneMeta(id) {
    const p = paneEl(id);
    if (!p) return;
    const e = M.logs.get(id);
    const st = pstate(id);
    p.querySelector('[data-count="err"]').textContent = e.errors ? '● ' + fmt(e.errors) : '';
    p.querySelector('[data-count="warn"]').textContent = e.warns ? '● ' + fmt(e.warns) : '';
    p.querySelector('[data-sel]').innerHTML = st.sel.size ? `${st.sel.size} selected · <a href="javascript:void 0" data-act="unselect">clear</a>` : 'click lines to select · shift+click for a range';
    const nl = p.querySelector('.new-lines');
    nl.classList.toggle('hidden', !st.fresh);
    nl.querySelector('span').textContent = fmt(st.fresh);
  }

  function paneAppend(id, lines, reset) {
    const b = paneBodyEl(id);
    if (!b) return;
    if (reset) return refreshPane(id);
    const st = pstate(id);
    const add = lines.filter((l) => matches(l, st));
    if (!add.length) return updatePaneMeta(id);
    const atBottom = b.scrollHeight - b.scrollTop - b.clientHeight < 60;
    b.querySelector('.lp-empty')?.remove();
    b.insertAdjacentHTML('beforeend', add.map((l) => lineHtml(l, st)).join(''));
    let extra = b.querySelectorAll('.ll').length - MAX_DOM;
    while (extra-- > 0) b.querySelector('.ll')?.remove();
    for (const el of b.querySelectorAll('.ll:not(.flash-in)')) if (add.some((l) => String(l.n) === el.dataset.n)) el.classList.add('flash-in');
    if (!st.paused && atBottom) b.scrollTop = b.scrollHeight;
    else st.fresh += add.length;
    updatePaneMeta(id);
  }

  function onPaneScroll(id) {
    const b = paneBodyEl(id);
    const st = pstate(id);
    if (st.fresh && b.scrollHeight - b.scrollTop - b.clientHeight < 60) { st.fresh = 0; updatePaneMeta(id); }
  }

  function entryText(e, n) {
    const i = e.lines.findIndex((l) => l.n === n);
    if (i < 0) return '';
    let start = i;
    while (start > 0 && e.lines[start].c) start--;
    let end = i + 1;
    while (end < e.lines.length && e.lines[end].c) end++;
    return e.lines.slice(start, end).map((l) => l.t).join('\n');
  }

  async function onLogsClick(ev) {
    const t = ev.target;
    if (t.closest('[data-find]')) return discoverModal();
    if (t.closest('[data-addfile]')) return addFileManually();
    const un = t.closest('[data-unwatch]');
    if (un) {
      ev.stopPropagation();
      const e = M.logs.get(un.dataset.unwatch);
      if (!(await D.confirmBox(`Stop watching “${esc(e.info.label)}”?`, 'The file itself is not touched.', 'Stop watching'))) return;
      await api('logs.remove', { conn: S.conn.id, id: un.dataset.unwatch });
      M.logs.delete(un.dataset.unwatch);
      setOpen(openIds().filter((x) => x !== un.dataset.unwatch));
      return viewLogs();
    }
    const tg = t.closest('[data-toggle]');
    if (tg) {
      const id = tg.dataset.toggle;
      let ids = openIds();
      if (ids.includes(id)) ids = ids.filter((x) => x !== id);
      else if (ids.length >= MAX_PANES) return toast(`Up to ${MAX_PANES} panes at once — close one first.`, 'warn');
      else ids.push(id);
      setOpen(ids);
      return viewLogs();
    }
    const pane = t.closest('[data-pane]');
    if (!pane) return;
    const id = pane.dataset.pane;
    const st = pstate(id);
    const e = M.logs.get(id);
    const lvb = t.closest('[data-lv]');
    if (lvb) {
      const k = lvb.dataset.lv;
      if (ev.altKey || ev.metaKey || ev.ctrlKey) st.levels = new Set([k]); // only this level
      else if (st.levels.has(k)) st.levels.delete(k); else st.levels.add(k);
      pane.querySelectorAll('[data-lv]').forEach((x) => x.classList.toggle('on', st.levels.has(x.dataset.lv)));
      return refreshPane(id);
    }
    const cp = t.closest('.ll-copy');
    if (cp) return copy(entryText(e, +cp.closest('.ll').dataset.n), 'Entry copied');
    const act = t.closest('[data-act]')?.dataset.act;
    if (act === 'copy') {
      const lines = st.sel.size ? e.lines.filter((l) => st.sel.has(l.n)) : e.lines.filter((l) => matches(l, st));
      return copy(lines.map((l) => l.t).join('\n'), `Copied ${plural(lines.length, 'line', 'lines')}`);
    }
    if (act === 'wrap') { st.wrap = !st.wrap; ls.set('logs-wrap', st.wrap); pane.classList.toggle('wrap', st.wrap); t.closest('button').classList.toggle('on', st.wrap); return; }
    if (act === 'pause') {
      st.paused = !st.paused;
      const b = t.closest('button');
      b.innerHTML = ic(st.paused ? 'play' : 'pause');
      b.title = st.paused ? 'Resume' : 'Pause auto-scroll';
      pane.querySelector('.lp-h .live-dot').className = `live-dot ${st.paused ? '' : 'on'}`;
      if (!st.paused) { st.fresh = 0; const body = paneBodyEl(id); body.scrollTop = body.scrollHeight; updatePaneMeta(id); }
      return;
    }
    if (act === 'clear') { e.lines = []; e.errors = 0; e.warns = 0; st.sel.clear(); st.fresh = 0; return refreshPane(id); }
    if (act === 'close') { setOpen(openIds().filter((x) => x !== id)); return viewLogs(); }
    if (act === 'bottom') { st.fresh = 0; const body = paneBodyEl(id); body.scrollTop = body.scrollHeight; return updatePaneMeta(id); }
    if (act === 'unselect') { st.sel.clear(); pane.querySelectorAll('.ll.sel').forEach((x) => x.classList.remove('sel')); return updatePaneMeta(id); }
    const line = t.closest('.ll');
    if (line && !window.getSelection()?.toString()) {
      const n = +line.dataset.n;
      if (ev.shiftKey && st.last !== null) {
        const vis = [...pane.querySelectorAll('.ll')].map((x) => +x.dataset.n);
        const [a, b] = [vis.indexOf(st.last), vis.indexOf(n)].sort((x, y) => x - y);
        for (const k of vis.slice(a, b + 1)) st.sel.add(k);
      } else if (st.sel.has(n)) st.sel.delete(n);
      else st.sel.add(n);
      st.last = n;
      pane.querySelectorAll('.ll').forEach((x) => x.classList.toggle('sel', st.sel.has(+x.dataset.n)));
      updatePaneMeta(id);
    }
  }

  function onLogsInput(ev) {
    const inp = ev.target.closest('[data-q]');
    if (!inp) return;
    const id = inp.closest('[data-pane]').dataset.pane;
    const st = pstate(id);
    st.q = inp.value;
    st.re = null;
    const m = /^\/(.+)\/([a-z]*)$/.exec(st.q);
    if (m) { try { st.re = new RegExp(m[1], m[2].includes('i') ? m[2] : m[2] + 'i'); } catch { st.re = null; } }
    later('q' + id, () => refreshPane(id), 150);
  }

  async function addFileManually() {
    const start = (S.conn.folders || [])[0]?.path || '';
    const p = await D.pickPath({ mode: 'file', start, title: 'Pick a log file' });
    if (!p) return;
    await watchFiles([{ path: p }]);
  }

  async function watchFiles(files) {
    try {
      await api('logs.add', { conn: S.conn.id, files });
      const ids = openIds();
      toast(`Watching ${plural(files.length, 'file', 'files')}`);
      setTimeout(() => {
        const all = [...M.logs.keys()];
        const add = all.filter((id) => !ids.includes(id)).slice(0, Math.max(0, MAX_PANES - ids.length));
        setOpen([...ids, ...add]);
        if (S.view === 'logs') viewLogs();
      }, 400);
    } catch (e) { toast(esc(e.message), 'err'); }
  }

  /** Search the project (and system places) for log files; the user confirms which to watch. */
  function discoverModal() {
    const m = D.modal(`<div class="row"><h3 style="margin:0">${ic('search')} Find log files</h3><span class="spacer"></span><button class="btn sm icon ghost" data-close>${ic('x')}</button></div>
      <p class="muted" style="margin:6px 0 12px">Looks for log files by name and folder (<code>*.log</code>, <code>logs/</code>, <code>storage/logs</code>, <code>var/log</code>, <code>nohup.out</code>…) in your project folders, plus common places (PM2, Apache, Nginx, PHP, MySQL). Nothing is watched until you tick it.</p>
      <div class="row wrap" style="margin-bottom:12px">
        <label class="check"><input type="checkbox" id="dDeep"> Also look inside files (finds logs with unusual names — slower)</label>
        <label class="check"><input type="checkbox" id="dSys" checked> System places</label>
        <span class="spacer"></span><button class="btn" id="dRun">${ic('refresh')}Search again</button>
      </div>
      <div id="dList" class="disc-list"></div>
      <div class="row wrap" style="margin-top:14px">
        <input class="input mono grow" id="dPath" placeholder="…or paste a full path, e.g. C:\\app\\logs\\worker.log" spellcheck="false">
        <button class="btn" id="dBrowse">${ic('folder')}Browse</button><button class="btn" id="dAddPath">${ic('plus')}Add</button>
      </div>
      <div class="row" style="margin-top:14px"><span class="muted" id="dCount"></span><span class="spacer"></span><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="dWatch" disabled>${ic('eye')}Watch selected</button></div>`);
    m.querySelector('.modal').classList.add('wide');
    let found = [];
    const sel = new Set();
    const counter = () => {
      $('#dCount', m).textContent = found.length ? `${plural(found.length, 'file', 'files')} found · ${sel.size} selected` : '';
      $('#dWatch', m).disabled = !sel.size;
      $('#dWatch', m).innerHTML = `${ic('eye')}Watch ${sel.size ? plural(sel.size, 'file', 'files') : 'selected'}`;
    };
    const run = async () => {
      $('#dList', m).innerHTML = `<div class="loading-page" style="min-height:180px"><span class="spinner"></span>Searching ${(S.conn.folders || []).length ? plural(S.conn.folders.length, 'folder', 'folders') : 'common places'}…</div>`;
      try {
        found = await api('logs.discover', { conn: S.conn.id, deep: $('#dDeep', m).checked, system: $('#dSys', m).checked });
      } catch (e) { $('#dList', m).innerHTML = `<div class="form-msg err">${esc(e.message)}</div>`; return; }
      sel.clear();
      // Pre-tick the obvious ones: recently written files from the project folders
      for (const f of found) if (!f.watched && f.source !== 'system' && Date.now() - new Date(f.mtime) < 7 * 864e5 && sel.size < 4 && !/system log/.test(f.reason)) sel.add(f.path);
      const groups = {};
      for (const f of found) (groups[f.source] ||= []).push(f);
      $('#dList', m).innerHTML = found.length ? Object.entries(groups).map(([g, list]) => `
        <div class="disc-group"><div class="sec-h">${esc(g)} <span class="muted n">${list.length}</span><span class="line"></span></div>
        ${list.map((f) => `<label class="disc-item ${f.watched ? 'watched' : ''}">
          <input type="checkbox" data-p="${esc(f.path)}" ${f.watched ? 'checked disabled' : sel.has(f.path) ? 'checked' : ''}>
          <div class="grow" style="min-width:0">
            <div class="row" style="gap:8px"><span class="mono disc-path" title="${esc(f.path)}">${esc(f.rel || f.path)}</span></div>
            <div class="disc-meta"><span class="chip">${esc(f.kind)}</span><span>${bytes(f.size)}</span><span>changed ${ago(f.mtime)}</span><span class="dim">${esc(f.reason)}</span>${f.watched ? '<span class="chip ins">watching</span>' : ''}</div>
            ${f.preview ? `<div class="disc-prev mono">${esc(f.preview)}</div>` : ''}
          </div></label>`).join('')}</div>`).join('')
        : `<div class="empty">${ic('search')}<div><b>No log files found.</b></div><div>Try “Also look inside files”, or pick the file yourself below.</div>${(S.conn.folders || []).length ? '' : needFolders('search your code folders')}</div>`;
      counter();
    };
    m.onchange = (e) => {
      const cb = e.target.closest('[data-p]');
      if (cb) { if (cb.checked) sel.add(cb.dataset.p); else sel.delete(cb.dataset.p); counter(); }
      if (e.target.id === 'dDeep' || e.target.id === 'dSys') run();
    };
    m.onclick = async (e) => {
      if (e.target === m || e.target.closest('[data-close]')) return m.remove();
      if (e.target.closest('#dRun')) return run();
      if (e.target.closest('#dBrowse')) {
        const p = await D.pickPath({ mode: 'file', start: (S.conn.folders || [])[0]?.path || '', title: 'Pick a log file' });
        if (p) $('#dPath', m).value = p;
      }
      if (e.target.closest('#dAddPath')) {
        const p = $('#dPath', m).value.trim();
        if (!p) return;
        m.remove();
        return watchFiles([{ path: p }]);
      }
      if (e.target.closest('#dWatch')) {
        m.remove();
        return watchFiles([...sel].map((p) => ({ path: p })));
      }
    };
    run();
  }

  D.views.logs = viewLogs;

  /* ================================================================ REQUESTS */

  const SNIPPETS = (port) => {
    const u = `http://127.0.0.1:${port}`;
    return {
      'Any app (env)': `# Set before starting your app / worker, then restart it\nHTTP_PROXY=${u}\nHTTPS_PROXY=${u}\nNO_PROXY=localhost,127.0.0.1\n\n# Windows PowerShell\n$env:HTTP_PROXY="${u}"; $env:HTTPS_PROXY="${u}"`,
      'PHP / Laravel': `// Laravel (10+): app/Providers/AppServiceProvider.php → boot()\nif (env('DEBUG_PROXY')) {\n    \\Illuminate\\Support\\Facades\\Http::globalOptions(['proxy' => env('DEBUG_PROXY')]);\n}\n// .env\nDEBUG_PROXY=${u}\n\n// Guzzle\n$client = new \\GuzzleHttp\\Client(['proxy' => '${u}']);\n\n// cURL\ncurl_setopt($ch, CURLOPT_PROXY, '${u}');\n\n// Note: PHP under Apache/PHP-FPM ignores the HTTP_PROXY env var (httpoxy protection),\n// so set the proxy in code as above. CLI / queue workers respect HTTPS_PROXY.`,
      'Node.js': `# Node 24+: built-in fetch & http follow the env vars when enabled\nNODE_USE_ENV_PROXY=1 HTTP_PROXY=${u} HTTPS_PROXY=${u} node server.js\n\n# axios follows HTTP_PROXY / HTTPS_PROXY by default.\n# Older Node: npm i global-agent, then\nGLOBAL_AGENT_HTTP_PROXY=${u} node -r global-agent/bootstrap server.js`,
      Python: `# requests, httpx, urllib follow the env vars\nexport HTTP_PROXY=${u} HTTPS_PROXY=${u}\npython manage.py runserver   # or celery worker, flask run…`,
      Java: `java -Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=${port} \\\n     -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=${port} -jar app.jar`,
      Go: `# net/http's default client follows the env vars\nHTTP_PROXY=${u} HTTPS_PROXY=${u} go run .`,
      '.NET': `# HttpClient (.NET Core 3+) follows the env vars\n$env:HTTP_PROXY="${u}"; $env:HTTPS_PROXY="${u}"; dotnet run`,
      Ruby: `# Net::HTTP, Faraday and HTTParty follow the env vars\nHTTP_PROXY=${u} HTTPS_PROXY=${u} bin/rails server`,
    };
  };

  async function viewRequests() {
    M.unseen.requests = 0;
    D.shell(`${head('Requests', 'Every HTTP request going into your app and every call it makes to other services.', `<button class="btn ghost" id="reqClear">${ic('eraser')}Clear</button>`)}
      <section class="req-setup" id="reqSetup"><div class="skeleton" style="height:150px"></div><div class="skeleton" style="height:150px"></div></section>
      <div class="req-toolbar">
        <div class="seg" id="reqDir">${[['all', 'All'], ['in', 'Incoming'], ['out', 'Outgoing']].map(([k, t]) => `<button class="${M.reqFilter.dir === k ? 'on' : ''}" data-dir="${k}">${t}</button>`).join('')}</div>
        <div class="kind-chips">${['page', 'api', 'form', 'webhook', 'websocket', 'asset', 'log', 'other'].map((k) => `<button class="kchip ${M.reqFilter.kinds.has(k) ? 'on' : ''}" data-kind="${k}">${k === 'log' ? 'from logs' : k}</button>`).join('')}</div>
        <label class="check"><input type="checkbox" id="reqErr" ${M.reqFilter.errors ? 'checked' : ''}> errors only</label>
        <div class="search">${ic('search')}<input class="input" id="reqQ" placeholder="Filter by URL, host, method, status…" value="${esc(M.reqFilter.q)}"></div>
      </div>
      <section class="card req-list" id="reqList"></section>
      <details class="card codemap" id="reqCode"><summary>${ic('code')}<b>Where does the code call APIs or receive webhooks?</b><span class="muted">static scan of your project folders</span></summary><div class="codemap-b" id="reqCodeBody"></div></details>`, 'requests');
    updateBadges();
    renderReqList();
    bindReqToolbar();
    $('#reqClear').onclick = async () => { await api('req.clear', { conn: S.conn.id }); M.requests = []; renderReqList(); };
    $('#reqCode').ontoggle = (e) => { if (e.target.open && !$('#reqCodeBody').dataset.done) loadCodeMap('reqCodeBody', ['http', 'webhook']); };
    try { await loadWs(); } catch (e) { $('#reqSetup').innerHTML = `<div class="form-msg err">${esc(e.message)}</div>`; return; }
    renderSetup();
  }

  function renderSetup() {
    const box = $('#reqSetup');
    if (!box || !M.ws) return;
    const ib = M.ws.inbound;
    const ob = M.ws.outbound;
    const snippets = SNIPPETS(M.status?.outbound?.port || ob.port || 4481);
    const tab = ls.get('snip-tab', 'Any app (env)');
    box.innerHTML = `
      <div class="card setup-card">
        <div class="setup-h"><span class="setup-ico in">${ic('in')}</span><div><b>Incoming requests</b><div class="muted">pages, API calls, form posts, webhooks</div></div><span class="spacer"></span>
          <span class="switch ${ib.enabled ? 'on' : ''}" data-sw="inbound" role="switch" tabindex="0" aria-checked="${ib.enabled}"></span></div>
        <div class="form-grid" style="grid-template-columns: 1fr 110px auto">
          <label class="field"><span>Your app runs at</span><input class="input mono" id="ibTarget" value="${esc(ib.target)}" placeholder="http://myapp.test or http://localhost:3000"></label>
          <label class="field"><span>Watch port</span><input class="input mono" id="ibPort" value="${esc(ib.port || 4480)}" inputmode="numeric"></label>
          <div class="field"><span>&nbsp;</span><button class="btn" id="ibSave">${ic('check')}Save</button></div>
        </div>
        <div class="setup-status" id="ibStatus"></div>
      </div>
      <div class="card setup-card">
        <div class="setup-h"><span class="setup-ico out">${ic('out')}</span><div><b>Outgoing calls</b><div class="muted">payment, SMS, mail, AI, other services</div></div><span class="spacer"></span>
          <span class="switch ${ob.enabled ? 'on' : ''}" data-sw="outbound" role="switch" tabindex="0" aria-checked="${ob.enabled}"></span></div>
        <div class="form-grid" style="grid-template-columns: 110px auto 1fr">
          <label class="field"><span>Proxy port</span><input class="input mono" id="obPort" value="${esc(ob.port || 4481)}" inputmode="numeric"></label>
          <div class="field"><span>&nbsp;</span><button class="btn" id="obSave">${ic('check')}Save</button></div>
        </div>
        <div class="setup-status" id="obStatus"></div>
        <details class="snip" ${ob.enabled ? 'open' : ''}><summary>How to point your app at it</summary>
          <div class="snip-tabs">${Object.keys(snippets).map((k) => `<button class="${k === tab ? 'on' : ''}" data-snip="${esc(k)}">${esc(k)}</button>`).join('')}</div>
          <div class="snip-code"><pre id="snipCode">${esc(snippets[tab] || snippets['Any app (env)'])}</pre><button class="btn sm" id="snipCopy">${ic('copy')}Copy</button></div>
        </details>
      </div>`;
    renderProxyStatus();
    const save = async (which, enabled) => {
      const body = { conn: S.conn.id };
      if (which === 'inbound') body.inbound = { enabled: enabled ?? M.ws.inbound.enabled, target: $('#ibTarget').value.trim(), port: $('#ibPort').value };
      else body.outbound = { enabled: enabled ?? M.ws.outbound.enabled, port: $('#obPort').value };
      try {
        M.status = await api('req.config', body);
        await loadWs();
        renderSetup();
        const st = M.status[which];
        if (st.error) toast(esc(st.error), 'err');
        else toast(st.running ? `${which === 'inbound' ? 'Incoming' : 'Outgoing'} watcher is on (port ${st.port})` : 'Stopped');
      } catch (e) { toast(esc(e.message), 'err'); }
    };
    box.onclick = (e) => {
      const sw = e.target.closest('[data-sw]');
      if (sw) return save(sw.dataset.sw, !sw.classList.contains('on'));
      if (e.target.closest('#ibSave')) return save('inbound');
      if (e.target.closest('#obSave')) return save('outbound');
      const sn = e.target.closest('[data-snip]');
      if (sn) { ls.set('snip-tab', sn.dataset.snip); $$('[data-snip]').forEach((x) => x.classList.toggle('on', x === sn)); $('#snipCode').textContent = snippets[sn.dataset.snip]; }
      if (e.target.closest('#snipCopy')) copy($('#snipCode').textContent);
      const c = e.target.closest('[data-copy]');
      if (c) copy(c.dataset.copy);
    };
    box.onkeydown = (e) => { const sw = e.target.closest('[data-sw]'); if (sw && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); sw.click(); } };
  }

  function renderProxyStatus() {
    const st = M.status || {};
    const ib = $('#ibStatus');
    const ob = $('#obStatus');
    if (ib) {
      const s = st.inbound || {};
      ib.innerHTML = s.error ? `<div class="form-msg err">${ic('alert')}<span>${esc(s.error)}</span></div>`
        : s.running ? `<div class="form-msg ok">${ic('check')}<span>Open your app at <a href="http://localhost:${s.port}" target="_blank" rel="noopener"><b>http://localhost:${s.port}</b></a> instead of ${esc(s.target)} — everything you do there is recorded. For webhooks, point the provider (or an ngrok tunnel) at this port.</span>
            <button class="btn sm" data-copy="http://localhost:${s.port}">${ic('copy')}</button></div>`
          : `<div class="hint">${ic('info')}<span>Off. WhatChanged sits in front of your app like a mirror: open the app through it and every request is recorded. Nothing in your app changes.</span></div>`;
    }
    if (ob) {
      const s = st.outbound || {};
      ob.innerHTML = s.error ? `<div class="form-msg err">${ic('alert')}<span>${esc(s.error)}</span></div>`
        : s.running ? `<div class="form-msg ok">${ic('check')}<span>Proxy running at <b class="mono">http://127.0.0.1:${s.port}</b>. HTTP calls are recorded in full; HTTPS calls show host, time and size (their content stays encrypted).</span><button class="btn sm" data-copy="http://127.0.0.1:${s.port}">${ic('copy')}</button></div>`
          : `<div class="hint">${ic('info')}<span>Off. Turn it on, then start your app (or queue worker) with the proxy settings below.</span></div>`;
    }
  }

  function bindReqToolbar() {
    const f = M.reqFilter;
    $('#reqDir').onclick = (e) => { const b = e.target.closest('[data-dir]'); if (!b) return; f.dir = b.dataset.dir; $$('#reqDir button').forEach((x) => x.classList.toggle('on', x === b)); M.reqLimit = 100; renderReqList(); };
    $('.kind-chips').onclick = (e) => { const b = e.target.closest('[data-kind]'); if (!b) return; if (f.kinds.has(b.dataset.kind)) f.kinds.delete(b.dataset.kind); else f.kinds.add(b.dataset.kind); b.classList.toggle('on'); renderReqList(); };
    $('#reqErr').onchange = (e) => { f.errors = e.target.checked; renderReqList(); };
    $('#reqQ').oninput = (e) => { f.q = e.target.value; later('rq', renderReqList, 150); };
  }

  const isErr = (r) => !!r.error || r.status >= 400 || (r.status === 0 && !r.pending && !r.tunnel);
  function reqMatches(r) {
    const f = M.reqFilter;
    if (f.dir !== 'all' && r.dir !== f.dir) return false;
    const kind = r.source === 'log' ? 'log' : r.kind;
    if (!f.kinds.has(kind) && !(r.dir === 'out' && r.source !== 'log')) return false;
    if (f.errors && !isErr(r)) return false;
    if (f.q) {
      const q = f.q.toLowerCase();
      if (!`${r.method} ${r.host}${r.url} ${r.status} ${r.kind} ${r.error || ''}`.toLowerCase().includes(q)) return false;
    }
    return true;
  }

  function statusClass(r) {
    if (r.pending) return 'pending';
    if (r.error || r.status === 0) return r.tunnel && !r.error ? 's2' : 's5';
    return 's' + String(r.status)[0];
  }

  function renderReqList() {
    const box = $('#reqList');
    if (!box) return;
    const list = M.requests.filter(reqMatches).reverse();
    const total = M.requests.length;
    if (!list.length) {
      box.innerHTML = `<div class="empty-state small"><div class="big">📡</div><h3>${total ? 'Nothing matches the filters' : 'No requests yet'}</h3>
        <p class="muted">${total ? 'Try another filter.' : 'Turn on a watcher above and use your app. Requests found in watched access logs (Apache, Nginx, morgan, Django…) and HTTP errors in logs show up here too.'}</p></div>`;
      return;
    }
    const shown = list.slice(0, M.reqLimit);
    box.innerHTML = `<div class="rq-head"><span>Time</span><span></span><span>Method</span><span>Status</span><span>URL</span><span>Kind</span><span>Time taken</span><span>Size</span></div>
      ${shown.map((r) => `<button class="rq-row ${statusClass(r)}" data-req="${r.id}">
        <span class="rq-time mono">${time(r.ts)}</span>
        <span class="rq-dir ${r.dir}" title="${r.dir === 'in' ? 'into your app' : 'from your app to another service'}">${ic(r.dir === 'in' ? 'in' : 'out')}${r.dir === 'in' ? 'IN' : 'OUT'}</span>
        <span class="rq-m m-${esc(r.method)}">${esc(r.method || '—')}</span>
        <span class="rq-st">${r.pending ? '<span class="spinner"></span>' : r.tunnel && !r.error ? 'TLS' : r.status || 'ERR'}</span>
        <span class="rq-url mono" title="${esc((r.host || '') + (r.url || ''))}">${r.dir === 'out' || r.source === 'log' ? `<b>${esc(r.host || '')}</b>` : ''}${esc(r.url || '')}${r.error ? ` <span class="rq-errtxt">${esc(r.error)}</span>` : ''}</span>
        <span class="rq-kind">${r.source === 'log' ? `<span class="chip">log: ${esc(r.log || '')}</span>` : esc(r.kind || '')}</span>
        <span class="rq-ms mono">${r.ms !== undefined ? fmtMs(r.ms) : ''}</span>
        <span class="rq-size mono">${r.size ? bytes(r.size) : r.bytes ? bytes(r.bytes) : ''}</span>
      </button>`).join('')}
      ${list.length > shown.length ? `<div class="list-more"><button class="btn" data-more-req>${ic('plus')}Show ${fmt(Math.min(100, list.length - shown.length))} more</button><span class="muted">${fmt(shown.length)} of ${fmt(list.length)}</span></div>` : `<div class="list-more muted">${plural(list.length, 'request', 'requests')} · newest first · the last 400 are kept</div>`}`;
    box.onclick = (e) => {
      if (e.target.closest('[data-more-req]')) { M.reqLimit += 100; return renderReqList(); }
      const row = e.target.closest('[data-req]');
      if (row) openRequest(row.dataset.req);
    };
  }

  const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(2) + ' s' : Math.round(ms) + ' ms');

  function prettyBody(body, ct = '') {
    if (!body) return '<div class="dim">— empty —</div>';
    let text = body;
    try { if (/json/.test(ct) || /^\s*[[{]/.test(body)) text = JSON.stringify(JSON.parse(body), null, 2); } catch { /* not JSON */ }
    if (/x-www-form-urlencoded/.test(ct)) {
      try { return `<table class="kvt">${[...new URLSearchParams(body)].map(([k, v]) => `<tr><td>${esc(k)}</td><td class="mono">${esc(v)}</td></tr>`).join('')}</table>`; } catch { /* raw */ }
    }
    return `<pre class="body-pre">${esc(text)}</pre>`;
  }
  const headersTable = (h) => (h && Object.keys(h).length
    ? `<table class="kvt">${Object.entries(h).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="mono">${esc(v)}</td></tr>`).join('')}</table>`
    : '<div class="dim">—</div>');

  function curlOf(r) {
    const scheme = r.scheme || (M.status?.inbound?.target || 'http://').split(':')[0];
    const host = r.host || '';
    const parts = [`curl -X ${r.method} '${scheme}://${host}${r.url}'`];
    for (const [k, v] of Object.entries(r.reqHeaders || {})) {
      if (/^(host|content-length|connection|accept-encoding)$/i.test(k)) continue;
      parts.push(`  -H '${k}: ${String(v).replace(/'/g, "'\\''")}'`);
    }
    if (r.reqBody && !/^⟨/.test(r.reqBody)) parts.push(`  --data-raw '${r.reqBody.replace(/'/g, "'\\''")}'`);
    return parts.join(' \\\n');
  }

  function openRequest(id) {
    const r = M.requests.find((x) => x.id === id);
    if (!r) return;
    const full = `${r.scheme ? r.scheme + '://' : ''}${r.host || ''}${r.url || ''}`;
    const tabs = [['ov', 'Overview'], ...(r.source === 'log' ? [['raw', 'Log line']] : [['req', 'Request'], ['res', 'Response'], ['curl', 'cURL']])];
    $('#drawer').innerHTML = `<div class="scrim" data-close></div>
      <aside class="panel" role="dialog">
        <div class="panel-h"><span class="rq-m m-${esc(r.method)}">${esc(r.method || '—')}</span>
          <div style="min-width:0;flex:1"><h2 title="${esc(full)}">${esc(r.url || r.host)}</h2><div class="muted" style="font-size:12.5px">${r.dir === 'in' ? 'Incoming' : 'Outgoing'} · ${esc(r.host || '')} · ${new Date(r.ts).toLocaleString()}</div></div>
          <span class="rq-st big ${statusClass(r)}">${r.pending ? 'pending' : r.tunnel && !r.error ? 'TLS' : r.status || 'ERR'}</span>
          <button class="btn icon ghost" data-close>${ic('x')}</button></div>
        <div class="panel-b"><div class="subtabs">${tabs.map(([k, t], i) => `<button class="subtab ${i ? '' : 'on'}" data-t="${k}">${t}</button>`).join('')}</div><div id="rqBody"></div></div>
      </aside>`;
    const body = (t) => {
      const b = $('#rqBody');
      if (t === 'ov') {
        const rows = [['Direction', r.dir === 'in' ? 'Into your app' : 'From your app to another service'], ['URL', full], ['Status', r.pending ? 'still running…' : r.status || '—'],
          ['Time taken', r.ms !== undefined ? fmtMs(r.ms) : '—'], ['Kind', r.kind], ['Recorded by', r.source === 'log' ? `log file “${r.log}”` : 'proxy'],
          ['Response type', r.resContentType || ''], ['Response size', r.size ? bytes(r.size) : ''], ['Client', [r.ip, r.ua].filter(Boolean).join(' · ')],
          ...(r.tunnel ? [['Sent / received', `${bytes(r.bytesUp || 0)} / ${bytes(r.bytesDown || 0)}`]] : [])].filter(([, v]) => v !== '' && v !== undefined);
        b.innerHTML = `${r.error ? `<div class="form-msg err" style="margin-bottom:12px">${ic('alert')}<span>${esc(r.error)}</span></div>` : ''}
          ${r.tunnel ? `<div class="note" style="margin-bottom:12px">${ic('info')}<span>HTTPS call through the proxy: the content is encrypted end-to-end, so only the host, timing and size are visible. Calls over plain HTTP are shown in full.</span></div>` : ''}
          <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
      } else if (t === 'req') {
        b.innerHTML = `<div class="sec-h">Headers<span class="line"></span></div>${headersTable(r.reqHeaders)}<div class="sec-h" style="margin-top:14px">Body<span class="line"></span><button class="btn sm ghost" data-cp="req">${ic('copy')}Copy</button></div>${prettyBody(r.reqBody, r.contentType)}`;
      } else if (t === 'res') {
        b.innerHTML = `<div class="sec-h">Headers<span class="line"></span></div>${headersTable(r.resHeaders)}<div class="sec-h" style="margin-top:14px">Body<span class="line"></span><button class="btn sm ghost" data-cp="res">${ic('copy')}Copy</button></div>${prettyBody(r.resBody, r.resContentType)}`;
      } else if (t === 'curl') {
        b.innerHTML = `<pre class="body-pre">${esc(curlOf(r))}</pre><button class="btn sm" data-cp="curl">${ic('copy')}Copy cURL</button>`;
      } else {
        b.innerHTML = `<pre class="body-pre">${esc(r.raw || '')}</pre><button class="btn sm" data-cp="raw">${ic('copy')}Copy</button>`;
      }
    };
    $('#drawer').onclick = (e) => {
      if (e.target.closest('[data-close]')) return D.closeDrawer();
      const tb = e.target.closest('[data-t]');
      if (tb) { $$('.subtab').forEach((x) => x.classList.toggle('on', x === tb)); body(tb.dataset.t); }
      const cp = e.target.closest('[data-cp]');
      if (cp) copy({ req: r.reqBody, res: r.resBody, curl: curlOf(r), raw: r.raw }[cp.dataset.cp] || '');
    };
    body('ov');
  }

  D.views.requests = viewRequests;

  /* ================================================================ CODE MAP */

  const CM_TITLES = {
    http: ['Outgoing API calls', 'HTTP clients and SDKs your code uses'],
    webhook: ['Webhook endpoints', 'routes / handlers that receive calls from outside'],
    produce: ['Producers', 'dispatch / publish / enqueue / emit'],
    consume: ['Workers & listeners', 'jobs, consumers, event listeners, schedulers'],
  };

  async function loadCodeMap(boxId, kinds) {
    const box = $('#' + boxId);
    if (!(S.conn.folders || []).length) { box.innerHTML = needFolders('map the code'); return; }
    box.innerHTML = `<div class="loading-page" style="min-height:120px"><span class="spinner"></span>Scanning ${plural(S.conn.folders.length, 'folder', 'folders')}…</div>`;
    let r;
    try { r = await api('code.map', { conn: S.conn.id, kinds }); } catch (e) { box.innerHTML = `<div class="form-msg err">${esc(e.message)}</div>`; return; }
    box.dataset.done = '1';
    box.innerHTML = `<div class="muted" style="font-size:12.5px;margin-bottom:10px">${fmt(r.files_scanned)} files scanned in ${esc(S.conn.folders.map((f) => f.label).join(', '))} · pattern based, so use it as a map, not a proof</div>
      <div class="codemap-cols">${kinds.map((k) => {
        const items = r[k] || [];
        const render = (list) => list.map((h) => `<div class="code-hit">
            <span class="layer">${esc(h.label)}</span><span class="file" title="${esc(h.file)}:${h.line}">${esc(h.file.replace(/[^/]+$/, ''))}<b>${esc(h.file.split('/').pop())}</b>:${h.line}</span>
            <pre>${esc(h.code)}</pre>${h.url ? `<span class="ref">${esc(h.url)}</span>` : ''}</div>`).join('');
        return `<div><div class="sec-h">${CM_TITLES[k][0]} <span class="muted n">${fmt(items.length)}</span><span class="line"></span></div>
          <div class="muted" style="font-size:12px;margin:-4px 0 8px">${CM_TITLES[k][1]}</div>
          ${items.length ? D.pagedBox(items.length, 12, `<div class="code-hits">${render(items.slice(0, 12))}</div>`, async (p) => `<div class="code-hits">${render(items.slice(p * 12, p * 12 + 12))}</div>`) : '<div class="dim">nothing found</div>'}</div>`;
      }).join('')}</div>`;
  }

  /* ================================================================ QUEUES */

  async function viewQueues() {
    M.unseen.jobs = 0;
    D.shell(`${head('Queues & listeners', 'Background jobs, message queues and event listeners — from database tables, Redis, RabbitMQ and worker logs.')}
      <section class="card setup-card" id="qSetup"><div class="skeleton" style="height:120px"></div></section>
      <div class="sec-h" style="margin:22px 0 12px">Queues <span class="muted n" id="qAt"></span><span class="line"></span></div>
      <section class="q-grid" id="qCards"></section>
      <div class="sec-h" style="margin:22px 0 12px">Job activity <span class="muted n">newest first</span><span class="line"></span></div>
      <section class="card req-list" id="qJobs"></section>
      <details class="card codemap" id="qCode"><summary>${ic('code')}<b>Where are jobs / events sent and handled in the code?</b><span class="muted">static scan of your project folders</span></summary><div class="codemap-b" id="qCodeBody"></div></details>`, 'queues');
    updateBadges();
    renderQueueCards();
    renderJobs();
    $('#qCode').ontoggle = (e) => { if (e.target.open && !$('#qCodeBody').dataset.done) loadCodeMap('qCodeBody', ['produce', 'consume']); };
    try { await loadWs(); } catch (e) { $('#qSetup').innerHTML = `<div class="form-msg err">${esc(e.message)}</div>`; return; }
    renderQueueSetup();
  }

  function renderQueueSetup() {
    const box = $('#qSetup');
    if (!box || !M.ws) return;
    const w = M.ws;
    const err = M.qErrors || {};
    box.innerHTML = `
      <div class="setup-h"><span class="setup-ico q">${ic('layers')}</span><div><b>Where your jobs live</b><div class="muted">set what applies — everything else is detected automatically</div></div></div>
      <div class="q-sources">
        <div class="q-src"><div class="q-src-h">${ic('db')}<b>Database</b><span class="chip">${esc(S.conn.database)}</span></div>
          ${w.queue_tables.length ? `<div class="colfreq">${w.queue_tables.map((t) => `<span class="chip acc">${esc(t)}</span>`).join('')}</div><div class="muted" style="font-size:12px">watched automatically</div>`
            : '<div class="muted" style="font-size:12.5px">No job tables found (looked for jobs, failed_jobs, delayed_jobs, good_jobs, oban_jobs, messenger_messages, celery_taskmeta, agendaJobs…).</div>'}
          ${err.db ? `<div class="form-msg err">${esc(err.db)}</div>` : ''}</div>
        <div class="q-src"><div class="q-src-h">${ic('zap')}<b>Redis</b><span class="muted">BullMQ, Sidekiq, Laravel, RQ, Celery, Asynq</span></div>
          <input class="input mono" id="qRedis" value="${esc(w.queues.redis_url)}" placeholder="redis://127.0.0.1:6379/0 (optional)" spellcheck="false">
          ${err.redis ? `<div class="form-msg err">${esc(err.redis)}</div>` : ''}</div>
        <div class="q-src"><div class="q-src-h">${ic('share')}<b>RabbitMQ</b><span class="muted">management API</span></div>
          <input class="input mono" id="qRabbit" value="${esc(w.queues.rabbit_url)}" placeholder="http://guest:guest@127.0.0.1:15672 (optional)" spellcheck="false">
          ${err.rabbit ? `<div class="form-msg err">${esc(err.rabbit)}</div>` : ''}</div>
      </div>
      <div class="row wrap">
        <span class="hint grow">${ic('info')}<span>Worker logs (Laravel <code>queue:work</code>, Rails ActiveJob, Celery, Sidekiq, RQ…) show up in <b>Job activity</b> once their log file is watched on the <a href="#/c/${S.conn.id}/logs">Logs</a> page.</span></span>
        <button class="btn primary" id="qSave">${ic('check')}Save & check</button>
      </div>`;
    $('#qSave').onclick = async (e) => {
      await D.withBusy(e.target.closest('button'), async () => {
        const r = await api('queues.config', { conn: S.conn.id, redis_url: $('#qRedis').value, rabbit_url: $('#qRabbit').value });
        M.queues = r.queues;
        M.qErrors = r.errors || {};
        await loadWs();
        renderQueueSetup();
        renderQueueCards();
        const bad = Object.values(M.qErrors).filter(Boolean);
        toast(bad.length ? esc(bad.join(' · ')) : `Found ${plural(M.queues?.queues?.length || 0, 'queue', 'queues')}`, bad.length ? 'err' : 'ok');
      });
    };
  }

  const STATE_CLS = (s) => (/(fail|dead|error)/i.test(s) ? 'del' : /(active|reserved|unacked|wip|started|running)/i.test(s) ? 'upd' : /(complete|finished|done|delivered|consumers)/i.test(s) ? 'ins' : '');
  const prevCounts = new Map();

  function renderQueueCards() {
    const box = $('#qCards');
    if (!box) return;
    const at = $('#qAt');
    const qs = M.queues?.queues || [];
    if (at) at.textContent = M.queues ? `checked ${ago(M.queues.at)} · every 3 s` : 'checking…';
    if (!qs.length) {
      box.innerHTML = `<div class="empty-state small" style="grid-column:1/-1"><div class="big">📭</div><h3>${M.queues ? 'No queues found yet' : 'Looking for queues…'}</h3>
        <p class="muted">Job tables in your database are picked up automatically. For Redis or RabbitMQ, add the address above.</p></div>`;
      return;
    }
    box.innerHTML = qs.map((q) => {
      if (!M.qFirst.has(q.id)) M.qFirst.set(q.id, { ...q.counts });
      const first = M.qFirst.get(q.id);
      const prev = prevCounts.get(q.id);
      const changed = prev && JSON.stringify(prev) !== JSON.stringify(q.counts);
      prevCounts.set(q.id, { ...q.counts });
      const counts = Object.entries(q.counts).map(([k, n]) => {
        const d = n - (first[k] ?? n);
        return `<span class="qc ${STATE_CLS(k)}"><b>${fmt(n)}</b><span>${esc(k)}</span>${d ? `<i class="${d > 0 ? 'up' : 'dn'}">${d > 0 ? '+' : ''}${fmt(d)}</i>` : ''}</span>`;
      }).join('');
      return `<article class="qcard card ${changed ? 'pulse' : ''}">
        <div class="qcard-h"><span class="chip ${q.source === 'db' ? 'acc' : q.source === 'redis' ? 'del' : 'upd'}">${esc(q.source === 'db' ? 'DB' : q.group)}</span><b class="mono" title="${esc(q.name)}">${esc(q.name)}</b></div>
        ${q.error ? `<div class="form-msg err">${esc(q.error)}</div>` : `<div class="qcounts">${counts}</div>`}
        ${q.latest?.length ? `<div class="qlatest">${q.latest.slice(0, 4).map((j) => `<div class="qjob"><span class="jst ${jobCls(j.status)}">${esc(j.status)}</span><span class="mono nm" title="${esc(j.name)}">${esc(j.name || '#' + j.key)}</span>${j.error ? `<span class="qerr" title="${esc(j.error)}">${esc(j.error)}</span>` : ''}</div>`).join('')}</div>` : ''}
      </article>`;
    }).join('');
    if (S.view === 'queues' && M.ws) {
      const err = M.qErrors || {};
      for (const [id, key] of [['qRedis', 'redis'], ['qRabbit', 'rabbit']]) {
        const inp = $('#' + id);
        if (!inp) continue;
        let msg = inp.parentElement.querySelector('.form-msg');
        if (err[key] && !msg) inp.insertAdjacentHTML('afterend', `<div class="form-msg err">${esc(err[key])}</div>`);
        else if (!err[key] && msg) msg.remove();
      }
    }
  }

  const jobCls = (s) => (/(fail|error|dead)/.test(s) ? 'del' : /(start|running|processing|retry|reserved)/.test(s) ? 'upd' : /(done|complete|success|processed|finished)/.test(s) ? 'ins' : 'q');

  function renderJobs() {
    const box = $('#qJobs');
    if (!box) return;
    const list = M.jobs.slice().reverse();
    if (!list.length) {
      box.innerHTML = `<div class="empty-state small"><div class="big">⏳</div><h3>No job activity yet</h3><p class="muted">New rows in job tables, count changes in Redis / RabbitMQ and job lines in watched logs appear here.</p></div>`;
      return;
    }
    const shown = list.slice(0, M.jobLimit);
    box.innerHTML = shown.map((j) => `<div class="job-row" data-job="${j.id}">
        <span class="rq-time mono">${time(j.ts)}</span>
        <span class="jst ${jobCls(j.status)}">${esc(j.status)}</span>
        <span class="mono nm" title="${esc(j.name)}">${esc(j.name)}</span>
        <span class="chip">${esc(j.source === 'log' ? 'log: ' + (j.log || '') : j.source === 'db' ? 'table ' + (j.table || '') : j.source)}</span>
        <span class="muted jnote">${esc(j.error || j.note || (j.ms !== undefined ? fmtMs(j.ms) : '') || (j.key ? '#' + j.key : ''))}</span>
        <button class="btn sm icon ghost" data-cpjob="${j.id}" title="Copy details">${ic('copy')}</button>
      </div>`).join('') + (list.length > shown.length ? `<div class="list-more"><button class="btn" data-more-jobs>${ic('plus')}Show ${fmt(Math.min(60, list.length - shown.length))} more</button><span class="muted">${fmt(shown.length)} of ${fmt(list.length)}</span></div>` : '');
    box.onclick = (e) => {
      if (e.target.closest('[data-more-jobs]')) { M.jobLimit += 60; return renderJobs(); }
      const cp = e.target.closest('[data-cpjob]');
      if (cp) {
        const j = M.jobs.find((x) => x.id === cp.dataset.cpjob);
        copy(j.raw || JSON.stringify(j.row || j, null, 2));
      }
    };
  }

  D.views.queues = viewQueues;
})();
