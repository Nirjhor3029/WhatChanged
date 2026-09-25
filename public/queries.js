/* WhatChanged — Watched queries: save a few queries, see their results change live. */
(() => {
  'use strict';

  const D = window.DBC;
  const { S, $, $$, esc, fmt, plural, ago, ls, api, toast, ic } = D;

  const Q = { list: [], unseen: 0, limits: new Map(), open: new Set() };
  const ROWS_STEP = 25;

  /* ================================================================ live events */
  D.hooks.monitorEvent = (ev) => {
    if (ev.type === 'hello') { Q.list = ev.queries || []; Q.unseen = 0; if (S.view === 'queries') render(); }
    else if (ev.type === 'queries') { Q.list = ev.queries; if (S.view === 'queries') render(); }
    else if (ev.type === 'query') {
      const i = Q.list.findIndex((q) => q.id === ev.q.id);
      if (i >= 0) Q.list[i] = ev.q; else Q.list.push(ev.q);
      if (ev.changed && S.view !== 'queries') { Q.unseen++; toast(`Query “${esc(ev.q.name)}” changed — ${esc(ev.q.changes[0]?.summary || '')}`, 'warn', 3500); }
      if (S.view === 'queries') renderCard(ev.q.id);
    } else if (ev.type === 'query-tick') {
      const q = Q.list.find((x) => x.id === ev.id);
      if (q) { q.ranAt = ev.ranAt; q.ms = ev.ms; if (S.view === 'queries') tickCard(q); }
    }
    badge();
  };
  const prevShell = D.hooks.shellRendered;
  D.hooks.shellRendered = () => { prevShell?.(); badge(); };

  function badge() {
    const el = $('#badge-queries');
    if (el) { el.className = Q.unseen ? 'n' : ''; el.textContent = Q.unseen || ''; }
  }

  /* ================================================================ helpers */
  const time = (iso) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour12: false }) : '');
  const cell = (v) => (v === null || v === undefined ? '<span class="null">NULL</span>' : `<span title="${esc(String(v).slice(0, 600))}">${esc(String(v).length > 70 ? String(v).slice(0, 70) + '…' : v)}</span>`);
  const isMongo = () => S.conn?.driver === 'mongodb';
  const intervalLabel = (q) => (q.paused ? 'paused' : !q.interval ? 'manual' : `every ${q.interval}s`);

  function quoteTable(name) {
    const d = S.conn.driver;
    const parts = name.split('.');
    const q = (p) => (d === 'mysql' ? `\`${p}\`` : d === 'mssql' ? `[${p}]` : `"${p}"`);
    return parts.map(q).join('.');
  }

  /** Starter queries built from the connected database. */
  function templates(table) {
    const t = S.meta?.tables?.[table];
    if (!t) return [];
    const pk = t.pk?.[0] || t.columns.find((c) => /^(id|_id)$/.test(c.name))?.name || t.columns[0]?.name;
    const status = t.columns.find((c) => /^(status|state|type|role)$/i.test(c.name))?.name;
    if (isMongo()) {
      return [
        ['Newest 10', JSON.stringify({ collection: table, sort: { _id: -1 }, limit: 10 }, null, 2)],
        ['Count', JSON.stringify({ collection: table, pipeline: [{ $count: 'total' }] }, null, 2)],
        ...(status ? [[`Count per ${status}`, JSON.stringify({ collection: table, pipeline: [{ $group: { _id: `$${status}`, n: { $sum: 1 } } }, { $sort: { _id: 1 } }] }, null, 2)]] : []),
      ];
    }
    const qt = quoteTable(table);
    const col = (c) => quoteTable(c);
    const top = S.conn.driver === 'mssql' ? `SELECT TOP 10 * FROM ${qt} ORDER BY ${col(pk)} DESC` : `SELECT * FROM ${qt} ORDER BY ${col(pk)} DESC LIMIT 10`;
    return [
      ['Newest 10 rows', top],
      ['Row count', `SELECT COUNT(*) AS total FROM ${qt}`],
      ...(status ? [[`Count per ${status}`, `SELECT ${col(status)}, COUNT(*) AS n FROM ${qt} GROUP BY ${col(status)} ORDER BY ${col(status)}`]] : []),
      ['One row by id', `SELECT * FROM ${qt} WHERE ${col(pk)} = 1`],
    ];
  }

  /* ================================================================ page */
  function render() {
    Q.unseen = 0;
    D.shell(`
      <div class="mon-head">
        <div><h1>Watched queries</h1><div class="muted">Save the queries you keep re-running while debugging. Do something in your app and watch their results change — live.</div></div>
        <span class="spacer"></span>
        ${Q.list.length ? `<button class="btn ghost" data-all-base title="Make every current result the new starting point">${ic('flag')}Compare all from now</button>
          <button class="btn" data-run-all>${ic('refresh')}Run all now</button>` : ''}
        <button class="btn primary" data-new>${ic('plus')}New query</button>
      </div>
      ${Q.list.length ? `<div class="note" style="margin-bottom:16px">${ic('info')}<span>Changes are shown against each query's <b>starting point</b> — press <b>Compare from now</b> right before the action you want to test. Queries only read (SELECT, WITH, SHOW…) and run in a read-only transaction.</span></div>` : ''}
      <section class="qw-list" id="qwList">${Q.list.length ? Q.list.map(cardHtml).join('') : emptyHtml()}</section>`, 'queries');
    badge();
    $('.page').onclick = onClick;
  }

  function emptyHtml() {
    const tables = Object.values(S.meta?.tables || {}).filter((t) => t.type === 'table').sort((a, b) => (b.rows || 0) - (a.rows || 0)).slice(0, 4);
    return `<div class="card empty-state">
      <div class="big">🔎</div><h2>No watched queries yet</h2>
      <p class="muted">Add the 3–4 queries you normally keep open in a SQL client — e.g. the newest orders, a user's balance, a count per status.<br>
      WhatChanged re-runs them every few seconds and highlights exactly what changed.</p>
      <div class="row" style="justify-content:center;margin-bottom:18px"><button class="btn primary lg" data-new>${ic('plus')}Write a query</button></div>
      ${tables.length ? `<div class="muted" style="font-size:12.5px;margin-bottom:8px">or start from one of your ${isMongo() ? 'collections' : 'tables'}:</div>
        <div class="qw-starters">${tables.map((t) => `<button class="btn sm" data-new-from="${esc(t.name)}">${ic('table')}${esc(t.name)}</button>`).join('')}</div>` : ''}
    </div>`;
  }

  /** Map every current row to how it differs from the starting point. */
  function rowView(q) {
    const r = q.result;
    const d = q.vsBase;
    const added = new Set((d?.added || []).map((x) => x.key));
    const changed = new Map((d?.changed || []).map((x) => [x.key, x.changes]));
    const recent = new Map();
    const fresh = q.changedAt && Date.now() - new Date(q.changedAt) < 8000;
    if (fresh) for (const c of q.changes?.[0]?.cells || []) recent.set(c.key, c.changes);
    const rows = r.rows.map((row, i) => {
      const k = d?.keysB?.[i];
      return { row, key: k, added: added.has(k), changes: changed.get(k), flash: recent.get(k) };
    });
    // Removed rows come from the starting point (same columns unless the query was edited).
    const removed = (d?.removed || []).map((x) => ({ row: x.row || [], removed: true, key: x.key }));
    return { rows, removed };
  }

  function tableHtml(q) {
    const r = q.result;
    if (!r) return q.error ? '' : `<div class="lp-empty"><span class="spinner"></span> running…</div>`;
    if (!r.rows.length && !(q.vsBase?.removed?.length)) return `<div class="lp-empty">The query returns no rows.</div>`;
    const { rows, removed } = rowView(q);
    const limit = Q.limits.get(q.id) || ROWS_STEP;
    // Changed / new rows first so they are never hidden behind "show more"
    const important = rows.filter((x) => x.added || x.changes);
    const rest = rows.filter((x) => !x.added && !x.changes);
    const ordered = [...important, ...rest];
    const shown = ordered.slice(0, limit);
    const cols = r.cols;
    const tr = (x) => `<tr class="${x.added ? 'r-ins' : x.removed ? 'r-del' : x.changes ? 'r-upd' : ''}">
      ${cols.map((c, i) => {
        const ch = x.changes?.[c];
        const fl = x.flash?.[c] ? ' flash-cell' : '';
        if (ch) return `<td class="cell-chg${fl}"><span class="cell-old">${cell(ch[0])}</span><span class="cell-new">${cell(ch[1])}</span></td>`;
        return `<td class="${x.added && q.changedAt && Date.now() - new Date(q.changedAt) < 8000 ? 'flash-cell' : ''}">${cell(x.row[i])}</td>`;
      }).join('')}</tr>`;
    return `<div class="dtable-wrap qw-table"><table class="dtable"><thead><tr>${cols.map((c) => `<th>${esc(c)}${q.vsBase?.key === c ? ' <span class="qw-key" title="Rows are matched by this column">key</span>' : ''}</th>`).join('')}</tr></thead>
      <tbody>${shown.map(tr).join('')}${removed.map(tr).join('')}</tbody></table></div>
      ${ordered.length > shown.length ? `<div class="list-more"><button class="btn sm" data-more="${q.id}">${ic('plus')}Show ${fmt(Math.min(ROWS_STEP, ordered.length - shown.length))} more</button><span class="muted">${fmt(shown.length)} of ${fmt(ordered.length)} rows</span></div>` : ''}
      ${r.truncated ? `<div class="hint" style="padding:6px 2px">${ic('info')}<span>Only the first 1,000 rows are kept — add a WHERE / LIMIT to watch a smaller set.</span></div>` : ''}`;
  }

  function summaryHtml(q) {
    const d = q.vsBase;
    if (!d || !q.result) return '';
    const cells = d.changed.reduce((n, c) => n + Object.keys(c.changes).length, 0);
    const chips = [
      d.added.length && `<span class="chip ins">+${fmt(d.added.length)} new row${d.added.length > 1 ? 's' : ''}</span>`,
      d.changed.length && `<span class="chip upd">~${fmt(d.changed.length)} row${d.changed.length > 1 ? 's' : ''} · ${fmt(cells)} cell${cells > 1 ? 's' : ''}</span>`,
      d.removed.length && `<span class="chip del">−${fmt(d.removed.length)} row${d.removed.length > 1 ? 's' : ''} gone</span>`,
      (d.colsAdded.length || d.colsRemoved.length) && '<span class="chip sch">columns changed</span>',
    ].filter(Boolean);
    return `<div class="qw-summary">
      <span class="muted">Since <b>${time(q.baseAt)}</b>:</span>
      ${chips.length ? chips.join('') : '<span class="dim">no changes yet</span>'}
      <span class="spacer"></span>
      <span class="muted qw-meta" data-meta>${metaText(q)}</span>
    </div>`;
  }
  const metaText = (q) => `${fmt(q.result?.rows.length ?? 0)} rows · ${q.ms ?? 0} ms · checked ${q.ranAt ? ago(q.ranAt) : '—'}`;

  function timelineHtml(q) {
    if (!q.changes?.length) return '';
    return `<details class="qw-timeline"><summary>${ic('history')}Change history <span class="muted">${q.changes.length}</span></summary>
      ${q.changes.slice(0, 12).map((c) => `<div class="qw-tl"><span class="mono muted">${time(c.at)}</span><span>${esc(c.summary)}</span>
        ${c.cells.slice(0, 3).map((x) => Object.entries(x.changes).slice(0, 2).map(([col, [o, n]]) => `<span class="cl-chg"><b>${esc(col)}</b><span class="cl-old">${cell(o)}</span><span class="arrow">→</span><span class="cl-new">${cell(n)}</span></span>`).join('')).join('')}</div>`).join('')}
    </details>`;
  }

  function cardHtml(q) {
    const fresh = q.changedAt && Date.now() - new Date(q.changedAt) < 8000;
    const state = q.error ? 'alert' : q.paused || !q.interval ? '' : 'on';
    return `<article class="card qw-card ${fresh ? 'pulse' : ''}" data-q="${q.id}">
      <header class="qw-h">
        <span class="live-dot ${state}"></span>
        <div class="qw-title"><b>${esc(q.name)}</b><span class="chip">${intervalLabel(q)}</span>
          ${q.changedAt ? `<span class="chip ${fresh ? 'upd' : ''}" data-changed>changed ${ago(q.changedAt)}</span>` : ''}</div>
        <span class="spacer"></span>
        <button class="btn sm" data-base="${q.id}" title="Use the current result as the starting point">${ic('flag')}Compare from now</button>
        <button class="btn sm icon ghost" data-run="${q.id}" title="Run now">${ic('refresh')}</button>
        <button class="btn sm icon ghost" data-pause="${q.id}" title="${q.paused ? 'Resume' : 'Pause'}">${ic(q.paused ? 'play' : 'pause')}</button>
        <button class="btn sm icon ghost" data-edit="${q.id}" title="Edit">${ic('edit')}</button>
        <button class="btn sm icon ghost" data-copy="${q.id}" title="Copy query">${ic('copy')}</button>
        <button class="btn sm icon ghost danger" data-del="${q.id}" title="Delete">${ic('trash')}</button>
      </header>
      <pre class="qw-sql ${Q.open.has(q.id) ? 'open' : ''}" data-sql="${q.id}" title="Click to expand">${esc(q.text)}</pre>
      ${q.error ? `<div class="form-msg err">${ic('alert')}<span>${esc(q.error)}</span></div>` : ''}
      ${summaryHtml(q)}
      <div class="qw-body">${tableHtml(q)}</div>
      ${timelineHtml(q)}
    </article>`;
  }

  function renderCard(id) {
    const q = Q.list.find((x) => x.id === id);
    const el = $(`[data-q="${id}"]`);
    if (!q) return el?.remove();
    if (!el) return render();
    el.outerHTML = cardHtml(q); // a changed card pulses; no scrolling, so the page never jumps while you read
  }

  function tickCard(q) {
    const el = $(`[data-q="${q.id}"] [data-meta]`);
    if (el) el.textContent = metaText(q);
    const ch = $(`[data-q="${q.id}"] [data-changed]`);
    if (ch && q.changedAt) ch.textContent = 'changed ' + ago(q.changedAt);
  }

  async function onClick(e) {
    const b = e.target.closest('button, [data-sql]');
    if (!b) return;
    const q = (id) => Q.list.find((x) => x.id === id);
    const act = async (fn) => { try { await fn(); } catch (err) { toast(esc(err.message), 'err'); } };
    if (b.dataset.new !== undefined) return editor();
    if (b.dataset.newFrom) return editor(null, b.dataset.newFrom);
    if (b.dataset.sql) { Q.open.has(b.dataset.sql) ? Q.open.delete(b.dataset.sql) : Q.open.add(b.dataset.sql); b.classList.toggle('open'); return; }
    if (b.dataset.more) { Q.limits.set(b.dataset.more, (Q.limits.get(b.dataset.more) || ROWS_STEP) + ROWS_STEP); return renderCard(b.dataset.more); }
    if (b.dataset.edit) return editor(q(b.dataset.edit));
    if (b.dataset.copy) { try { await navigator.clipboard.writeText(q(b.dataset.copy).text); toast('Query copied'); } catch { toast('Clipboard not available', 'err'); } return; }
    if (b.dataset.run) return act(async () => { b.disabled = true; await api('queries.run', { conn: S.conn.id, id: b.dataset.run }); });
    if (b.dataset.base) return act(async () => { await api('queries.baseline', { conn: S.conn.id, id: b.dataset.base }); toast('Changes are now compared with the current result'); });
    if (b.dataset.pause) return act(async () => { const cur = q(b.dataset.pause); await api('queries.pause', { conn: S.conn.id, id: cur.id, paused: !cur.paused }); });
    if (b.dataset.runAll !== undefined) return act(async () => { for (const x of Q.list) await api('queries.run', { conn: S.conn.id, id: x.id }); toast('All queries ran'); });
    if (b.dataset.allBase !== undefined) return act(async () => { for (const x of Q.list) await api('queries.baseline', { conn: S.conn.id, id: x.id }); toast('Every query now compares from this moment'); });
    if (b.dataset.del) {
      const cur = q(b.dataset.del);
      if (!(await D.confirmBox(`Delete “${esc(cur.name)}”?`, 'The saved query is removed. Your database is not touched.', 'Delete'))) return;
      return act(async () => { await api('queries.delete', { conn: S.conn.id, id: cur.id }); Q.list = Q.list.filter((x) => x.id !== cur.id); render(); });
    }
  }

  /* ================================================================ editor */
  function editor(existing = null, fromTable = '') {
    const tables = Object.values(S.meta?.tables || {}).filter((t) => t.type === 'table').map((t) => t.name).sort();
    const mongo = isMongo();
    const f = existing ? { ...existing } : { name: '', text: '', interval: 3, key: '' };
    if (fromTable) { const t = templates(fromTable)[0]; f.text = t[1]; f.name = `${fromTable} · ${t[0].toLowerCase()}`; }
    const m = D.modal(`<form id="qwForm">
      <div class="row"><h3 style="margin:0">${ic('code')} ${existing ? 'Edit query' : 'New watched query'}</h3><span class="spacer"></span><button type="button" class="btn sm icon ghost" data-x>${ic('x')}</button></div>
      <div class="form-grid" style="grid-template-columns: 2fr 1fr 1fr; margin-top:14px">
        <label class="field"><span>Name</span><input class="input" name="name" value="${esc(f.name)}" placeholder="e.g. Newest orders" maxlength="80"></label>
        <label class="field"><span>Run</span><select class="select" name="interval">${[[2, 'every 2 s'], [3, 'every 3 s'], [5, 'every 5 s'], [10, 'every 10 s'], [30, 'every 30 s'], [60, 'every minute'], [0, 'only when I press run']].map(([v, t]) => `<option value="${v}" ${Number(f.interval) === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label class="field"><span>Match rows by</span><select class="select" name="key" id="qwKey"><option value="">auto (id…)</option>${f.key ? `<option value="${esc(f.key)}" selected>${esc(f.key)}</option>` : ''}</select></label>
      </div>
      ${tables.length ? `<div class="qw-tpl"><span class="muted">Start from</span>
        <select class="select sm-select" id="qwTable">${tables.map((t) => `<option ${t === fromTable ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
        <span id="qwTplBtns"></span></div>` : ''}
      <label class="field" style="margin-top:10px"><span>${mongo ? 'Query (JSON)' : 'SQL'}</span>
        <textarea class="input qw-editor" name="text" rows="8" spellcheck="false" placeholder="${mongo ? '{&quot;collection&quot;: &quot;orders&quot;, &quot;filter&quot;: {&quot;status&quot;: &quot;paid&quot;}, &quot;sort&quot;: {&quot;_id&quot;: -1}, &quot;limit&quot;: 10}' : 'SELECT id, status, total FROM orders ORDER BY id DESC LIMIT 10'}">${esc(f.text)}</textarea></label>
      <div class="hint" style="margin-top:6px">${ic('info')}<span>${mongo ? 'find: <code>collection</code>, <code>filter</code>, <code>projection</code>, <code>sort</code>, <code>limit</code> · or aggregate: <code>collection</code> + <code>pipeline</code>. Extended JSON works (<code>{"$oid": "…"}</code>).' : 'Read-only: one SELECT / WITH / SHOW / EXPLAIN statement. Tip: <code>ORDER BY … DESC LIMIT 10</code> keeps the newest rows in view.'} Press <b>Ctrl+Enter</b> to test.</span></div>
      <div id="qwPreview" class="qw-preview"></div>
      <div class="row" style="margin-top:14px"><button type="button" class="btn" data-test>${ic('zap')}Test</button><span class="spacer"></span>
        <button type="button" class="btn ghost" data-x>Cancel</button><button class="btn primary">${ic('eye')}${existing ? 'Save' : 'Save & watch'}</button></div>
    </form>`);
    m.querySelector('.modal').classList.add('wide');
    const form = $('#qwForm', m);
    const ta = form.querySelector('[name=text]');
    const drawTpl = () => {
      const box = $('#qwTplBtns', m);
      if (!box) return;
      box.innerHTML = templates($('#qwTable', m).value).map(([label], i) => `<button type="button" class="btn sm" data-tpl="${i}">${esc(label)}</button>`).join('');
    };
    drawTpl();
    const setKeys = (cols) => {
      const sel = $('#qwKey', m);
      const cur = sel.value;
      sel.innerHTML = `<option value="">auto (id…)</option>${cols.map((c) => `<option ${c === cur ? 'selected' : ''}>${esc(c)}</option>`).join('')}`;
    };
    const test = async () => {
      const box = $('#qwPreview', m);
      box.innerHTML = `<div class="lp-empty"><span class="spinner"></span> running…</div>`;
      try {
        const r = await api('queries.test', { conn: S.conn.id, text: ta.value });
        setKeys(r.cols);
        box.innerHTML = `<div class="muted" style="font-size:12px;margin:8px 0 6px">${plural(r.total, 'row', 'rows')}${r.truncated ? ' (first 1,000)' : ''} · ${r.ms} ms${r.total > r.rows.length ? ' · preview of the first ' + r.rows.length : ''}</div>
          <div class="dtable-wrap" style="max-height:240px"><table class="dtable"><thead><tr>${r.cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${r.rows.map((row) => `<tr>${row.map((v) => `<td>${cell(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      } catch (err) {
        box.innerHTML = `<div class="form-msg err" style="margin-top:10px">${ic('alert')}<span>${esc(err.message)}</span></div>`;
      }
    };
    m.onclick = async (e) => {
      if (e.target === m || e.target.closest('[data-x]')) return m.remove();
      const t = e.target.closest('[data-tpl]');
      if (t) {
        const [label, text] = templates($('#qwTable', m).value)[+t.dataset.tpl];
        ta.value = text;
        const name = form.querySelector('[name=name]');
        if (!name.value || name.dataset.auto) { name.value = `${$('#qwTable', m).value} · ${label.toLowerCase()}`; name.dataset.auto = '1'; }
        return test();
      }
      if (e.target.closest('[data-test]')) return test();
    };
    m.onchange = (e) => { if (e.target.id === 'qwTable') drawTpl(); };
    ta.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); test(); } };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = form.querySelector('.btn.primary');
      btn.disabled = true;
      try {
        const el = (n) => form.elements.namedItem(n).value; // form.name would be the form's own name attribute
        const saved = await api('queries.save', { conn: S.conn.id, query: { id: existing?.id, name: el('name'), text: ta.value, interval: el('interval'), key: el('key') } });
        const i = Q.list.findIndex((x) => x.id === saved.id);
        if (i >= 0) Q.list[i] = saved; else Q.list.push(saved);
        m.remove();
        toast(existing ? 'Query saved' : `Watching “${esc(saved.name)}”`);
        render();
      } catch (err) {
        $('#qwPreview', m).innerHTML = `<div class="form-msg err" style="margin-top:10px">${ic('alert')}<span>${esc(err.message)}</span></div>`;
      } finally {
        btn.disabled = false;
      }
    };
    setTimeout(() => (f.text ? test() : ta.focus()), 50);
  }

  D.views.queries = render;
  setInterval(() => { if (S.view === 'queries') for (const q of Q.list) tickCard(q); }, 5000);
})();
