/**
 * A change report as one self-contained HTML file (no scripts, no external files):
 * every changed table with its inserted / updated / deleted rows, all columns shown,
 * changed cells marked old → new, plus a plain-language explanation per table.
 */

const ROW_CAP = 2000; // rows per list (inserted / updated / deleted) written into the file
const LISTS = ['inserted_rows', 'updated_rows', 'deleted_rows'];

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;
const anchor = (name, prefix = '') => (prefix ? prefix + '-' : '') + 't-' + String(name).replace(/[^A-Za-z0-9_-]/g, '_');

const vocab = (driver) => driver === 'mongodb'
  ? { table: 'collection', tables: 'collections', row: 'document', rows: 'documents', col: 'field', cols: 'fields' }
  : { table: 'table', tables: 'tables', row: 'row', rows: 'rows', col: 'column', cols: 'columns' };

const filePart = (s) => String(s || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** Report filename: database, step names and time, safe for any OS. */
export function reportFilename(report) {
  return ['whatchanged', filePart(report.database), filePart(report.from.label), 'to', filePart(report.to.label), report.to.id].filter(Boolean).join('_') + '.html';
}

/** Filename for a report that combines several captures. */
export function reportFilenameMulti(items) {
  if (!items.length) return 'whatchanged-report.html';
  const first = items[0].report;
  const last = items[items.length - 1].report;
  return ['whatchanged', filePart(first.database), filePart(first.from.label), 'to', filePart(last.to.label), `${items.length}-captures`, last.to.id].filter(Boolean).join('_') + '.html';
}

/**
 * @param report  result of Differ.diff()
 * @param full    (table name) => { inserted_rows, updated_rows, deleted_rows } | null — complete lists of paged tables
 */
export function reportHtml(report, full = () => null) {
  const v = vocab(report.driver);
  const T = report.totals;
  const order = (e) => (e.status !== 'changed' ? 1e9 : 0) + (e.data?.inserted || 0) + (e.data?.updated || 0) + (e.data?.deleted || 0) + (e.schema?.count || 0) * 10;
  const tables = [...report.tables].sort((a, b) => order(b) - order(a));
  const title = T.tables ? `${plural(T.tables, v.table, v.tables)} changed` : 'Nothing changed';

  const toc = tables.map((e) => {
    const D = e.data || {};
    const tags = [
      e.status === 'new' && '<span class="tag ins">new</span>',
      e.status === 'dropped' && '<span class="tag del">dropped</span>',
      D.inserted && e.status !== 'new' ? `<span class="tag ins">+${fmt(D.inserted)}</span>` : '',
      D.updated ? `<span class="tag upd">~${fmt(D.updated)}</span>` : '',
      D.deleted && e.status !== 'dropped' ? `<span class="tag del">−${fmt(D.deleted)}</span>` : '',
      e.schema?.count && e.status === 'changed' ? '<span class="tag sch">structure</span>' : '',
    ].filter(Boolean).join('');
    return `<li><a href="#${anchor(e.name)}"><code>${esc(e.name)}</code></a>${tags}</li>`;
  }).join('');

  const body = tables.map((e) => tableSection(e, full(e.name), v)).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(report.database)} · WhatChanged</title>
<meta name="wc-report" content="${esc(`${report.database}|${report.from.id}|${report.to.id}`)}">
<meta name="wc-file" content="${esc(reportFilename(report))}">
<meta name="wc-saved" content="">
<script type="application/json" id="wc-view">{}</script>
<style>${CSS}</style>
</head>
<body>
<div class="bar">
  <span class="brand">WhatChanged</span>
  <span class="status" id="wcStatus"></span>
  <button type="button" id="wcTheme" title="Switch theme">◐ Auto</button>
  <button type="button" id="wcSave" title="Save this file with your notes (Ctrl+S)">💾 Save file</button>
  <button type="button" id="wcPrint" title="Print, or choose “Save as PDF”">🖨 Print / PDF</button>
</div>
<header class="top">
  <h1 class="capture-title">${esc(report.to.label || 'Snapshot')}</h1>
  ${noteBox('general', 'Notes', 'Write what you did, what you expected, what looks wrong… (you can paste text and screenshots)', true)}
  <div class="eyebrow">WhatChanged · change report</div>
  <h1>${esc(title)}</h1>
  <p class="sub">Database <code>${esc(report.database)}</code> (${esc(report.driver)}) · from <b>${esc(report.from.label)}</b> <span class="dim">${esc(when(report.from.created_at))}</span>
    → to <b>${esc(report.to.label)}</b> <span class="dim">${esc(when(report.to.created_at))}</span></p>
  <div class="nums">
    <div class="num ins"><b>${fmt(T.inserted)}</b><span>inserted</span></div>
    <div class="num upd"><b>${fmt(T.updated)}</b><span>updated</span></div>
    <div class="num del"><b>${fmt(T.deleted)}</b><span>deleted</span></div>
    <div class="num sch"><b>${fmt(T.schema)}</b><span>structure changes</span></div>
  </div>
  ${T.tables ? `<nav class="toc"><h2>Changed ${esc(v.tables)}</h2><ul>${toc}</ul></nav>` : `<p class="note">No ${v.rows} were inserted, updated or deleted and no structure changed between these two snapshots.</p>`}
  ${otherChanges(report)}
  <div class="legend">
    <span><i class="sw ins"></i>inserted ${esc(v.row)}</span><span><i class="sw upd"></i>changed cell (old → new)</span><span><i class="sw del"></i>deleted ${esc(v.row)}</span>
    <span class="view-acts">
      <button type="button" id="wcCollapseAll" title="Fold every ${esc(v.table)} down to its title">▸ Collapse all</button>
      <button type="button" id="wcExpandAll" title="Open every ${esc(v.table)}">▾ Expand all</button>
      <button type="button" id="wcOcAll" class="oc-label" title="Switch “Only changed ${esc(v.cols)}” on or off for every ${esc(v.table)}">Only changed ${esc(v.cols)} in all ${esc(v.tables)}</button>
      <button type="button" id="wcResetView" title="Show every ${esc(v.table)} and ${esc(v.col)} again">↺ Reset view</button>
    </span>
  </div>
</header>
<main>${body}</main>
<footer>Generated by WhatChanged · ${esc(when(report.generated_at || new Date().toISOString()))}</footer>
<script>${SCRIPT}</script>
</body>
</html>`;
}

/**
 * One self-contained HTML file with several captures, oldest first.
 * Each item is { report, full } where full(table) returns the complete lists of a paged table.
 * @param items   array of { report: Differ.diff() result, full?: (table) => object|null }
 * @param opts    { title?: string }
 */
export function reportHtmlMulti(items, opts = {}) {
  if (!items.length) throw new Error('No captures to include');
  const first = items[0].report;
  const last = items[items.length - 1].report;
  const v = vocab(first.driver);
  const heading = String(opts.title || '').trim().slice(0, 80) || 'All captures';

  const sum = { inserted: 0, updated: 0, deleted: 0, schema: 0 };
  const touched = new Set();
  for (const { report } of items) {
    const T = report.totals || {};
    sum.inserted += T.inserted || 0;
    sum.updated += T.updated || 0;
    sum.deleted += T.deleted || 0;
    sum.schema += T.schema || 0;
    for (const e of report.tables) touched.add(e.name);
  }

  const order = (e) => (e.status !== 'changed' ? 1e9 : 0) + (e.data?.inserted || 0) + (e.data?.updated || 0) + (e.data?.deleted || 0) + (e.schema?.count || 0) * 10;

  const overview = items.map(({ report }, i) => {
    const T = report.totals || {};
    const counts = [
      T.inserted ? `+${fmt(T.inserted)}` : '',
      T.updated ? `~${fmt(T.updated)}` : '',
      T.deleted ? `−${fmt(T.deleted)}` : '',
      T.schema ? `${fmt(T.schema)} structure` : '',
    ].filter(Boolean).join(' · ') || 'No changes';
    return `<li>
      <a href="#cap-${esc(report.to.id)}">
        <span class="cap-n">${i + 1}</span>
        <span class="cap-main"><b>${esc(report.to.label || 'Snapshot')}</b><span class="cap-when">${esc(when(report.to.created_at))} · from ${esc(report.from.label)}</span></span>
        <span class="cap-counts">${counts}</span>
      </a>
    </li>`;
  }).join('');

  const captures = items.map(({ report, full }, i) => {
    const T = report.totals || {};
    const scope = report.to.id;
    const tables = [...report.tables].sort((a, b) => order(b) - order(a));
    const title = T.tables ? `${plural(T.tables, v.table, v.tables)} changed` : 'Nothing changed';
    const toc = tables.map((e) => {
      const D = e.data || {};
      const tags = [
        e.status === 'new' && '<span class="tag ins">new</span>',
        e.status === 'dropped' && '<span class="tag del">dropped</span>',
        D.inserted && e.status !== 'new' ? `<span class="tag ins">+${fmt(D.inserted)}</span>` : '',
        D.updated ? `<span class="tag upd">~${fmt(D.updated)}</span>` : '',
        D.deleted && e.status !== 'dropped' ? `<span class="tag del">−${fmt(D.deleted)}</span>` : '',
        e.schema?.count && e.status === 'changed' ? '<span class="tag sch">structure</span>' : '',
      ].filter(Boolean).join('');
      return `<li><a href="#${anchor(e.name, `cap-${scope}`)}"><code>${esc(e.name)}</code></a>${tags}</li>`;
    }).join('');
    const body = tables.map((e) => tableSection(e, full ? full(e.name) : null, v, scope)).join('');
    return `${i ? '<hr class="cap-rule" aria-hidden="true">' : ''}
    <section class="capture" id="cap-${esc(scope)}">
      <header class="cap-head">
        <div class="cap-kicker"><span class="cap-step">${i + 1}</span> Capture ${i + 1} of ${items.length}</div>
        <h2 class="cap-title">${esc(report.to.label || 'Snapshot')}</h2>
        <p class="cap-change">${esc(title)}</p>
        <p class="sub">from <b>${esc(report.from.label)}</b> <span class="dim">${esc(when(report.from.created_at))}</span>
          → to <b>${esc(report.to.label)}</b> <span class="dim">${esc(when(report.to.created_at))}</span></p>
        ${noteBox(`${scope}:general`, 'Notes for this capture', 'What did you do in this step? What did you expect?', false)}
        <div class="nums">
          <div class="num ins"><b>${fmt(T.inserted || 0)}</b><span>inserted</span></div>
          <div class="num upd"><b>${fmt(T.updated || 0)}</b><span>updated</span></div>
          <div class="num del"><b>${fmt(T.deleted || 0)}</b><span>deleted</span></div>
          <div class="num sch"><b>${fmt(T.schema || 0)}</b><span>structure changes</span></div>
        </div>
        ${T.tables ? `<nav class="toc"><h2>Changed ${esc(v.tables)}</h2><ul>${toc}</ul></nav>` : `<p class="note">No ${v.rows} were inserted, updated or deleted and no structure changed in this capture.</p>`}
        ${otherChanges(report)}
      </header>
      <div class="cap-body">${body}</div>
    </section>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(heading)} · ${esc(first.database)} · WhatChanged</title>
<meta name="wc-report" content="${esc(`${first.database}|combined|${items.map((x) => x.report.to.id).join(',')}`)}">
<meta name="wc-file" content="${esc(reportFilenameMulti(items))}">
<meta name="wc-saved" content="">
<script type="application/json" id="wc-view">{}</script>
<style>${CSS}</style>
</head>
<body>
<div class="bar">
  <span class="brand">WhatChanged</span>
  <span class="status" id="wcStatus"></span>
  <button type="button" id="wcTheme" title="Switch theme">◐ Auto</button>
  <button type="button" id="wcSave" title="Save this file with your notes (Ctrl+S)">💾 Save file</button>
  <button type="button" id="wcDownload" title="Download a copy of this HTML file">⬇ Download</button>
  <button type="button" id="wcPrint" title="Print, or choose “Save as PDF”">🖨 Print / PDF</button>
</div>
<header class="top">
  <h1 class="capture-title">${esc(heading)}</h1>
  <div class="eyebrow">WhatChanged · combined change report</div>
  <p class="sub">Database <code>${esc(first.database)}</code> (${esc(first.driver)}) · ${items.length} ${items.length === 1 ? 'capture' : 'captures'} · from <b>${esc(first.from.label)}</b> <span class="dim">${esc(when(first.from.created_at))}</span>
    → to <b>${esc(last.to.label)}</b> <span class="dim">${esc(when(last.to.created_at))}</span></p>
  <div class="nums">
    <div class="num ins"><b>${fmt(sum.inserted)}</b><span>inserted</span></div>
    <div class="num upd"><b>${fmt(sum.updated)}</b><span>updated</span></div>
    <div class="num del"><b>${fmt(sum.deleted)}</b><span>deleted</span></div>
    <div class="num sch"><b>${fmt(sum.schema)}</b><span>structure changes</span></div>
  </div>
  <p class="multi-summary">Across ${items.length} ${items.length === 1 ? 'capture' : 'captures'}: ${fmt(touched.size)} different ${esc(v.tables)} touched.</p>
  ${noteBox('combined:general', 'Notes for the whole report', 'Write what this whole sequence of actions was meant to test…', true)}
  <nav class="cap-list"><h2>Captures in this report</h2><ol>${overview}</ol></nav>
  <div class="legend">
    <span><i class="sw ins"></i>inserted ${esc(v.row)}</span><span><i class="sw upd"></i>changed cell (old → new)</span><span><i class="sw del"></i>deleted ${esc(v.row)}</span>
    <span class="view-acts">
      <button type="button" id="wcCollapseAll" title="Fold every ${esc(v.table)} down to its title">▸ Collapse all</button>
      <button type="button" id="wcExpandAll" title="Open every ${esc(v.table)}">▾ Expand all</button>
      <button type="button" id="wcOcAll" class="oc-label" title="Switch “Only changed ${esc(v.cols)}” on or off for every ${esc(v.table)}">Only changed ${esc(v.cols)} in all ${esc(v.tables)}</button>
      <button type="button" id="wcResetView" title="Show every ${esc(v.table)} and ${esc(v.col)} again">↺ Reset view</button>
    </span>
  </div>
</header>
<main class="captures">${captures}</main>
<footer>Generated by WhatChanged · ${esc(when(new Date().toISOString()))} · ${items.length} ${items.length === 1 ? 'capture' : 'captures'}</footer>
<script>${SCRIPT}</script>
</body>
</html>`;
}

/* ------------------------------------------------------------------ table */

function tableSection(e, fullLists, v, scope = '') {
  const D = e.data || {};
  const dom = scope ? `cap-${scope}` : '';
  const noteId = (id) => (scope ? `${scope}:${id}` : id);
  const lists = {};
  for (const k of LISTS) lists[k] = (D.paged && fullLists?.[k]) || D[k] || [];
  const changedCols = Object.keys(D.changed_columns || {});

  // Every column: the table's current columns, then any that only exist in deleted rows (column dropped).
  const cols = [...(e.columns || [])];
  for (const k of LISTS) for (const item of lists[k].slice(0, ROW_CAP)) for (const c of Object.keys(item.row || {})) if (!cols.includes(c)) cols.push(c);
  const key = e.key || [];

  const status = e.status === 'new' ? `<span class="tag ins">new ${esc(v.table)}</span>` : e.status === 'dropped' ? `<span class="tag del">dropped</span>` : '';
  // "Only changed columns" switch for this table: only when its updated rows have columns that did not change.
  const set = new Set(changedCols);
  const toggle = lists.updated_rows.length > 0 && cols.some((c) => !set.has(c) && !key.includes(c));
  const ocId = 'oc-' + anchor(e.name, dom);
  const hasRows = LISTS.some((k) => lists[k].length);
  let html = `<section class="tbl" id="${anchor(e.name, dom)}" data-table="${esc(e.name)}"${scope ? ` data-key="${esc(scope + '|' + e.name)}"` : ''} data-changed="${esc(JSON.stringify(changedCols))}">${toggle ? `<input type="checkbox" class="oc-input" id="${ocId}">` : ''}
    <h2><button type="button" class="col-tg" title="Collapse / expand this ${esc(v.table)}" aria-expanded="true">▾</button><code>${esc(e.name)}</code>${status}<span class="rows">${fmt(e.rows_before)} → ${fmt(e.rows_after)} ${esc(v.rows)}</span><button type="button" class="add-note" data-for="${esc(noteId('t:' + e.name))}">✎ Add note</button>${hasRows ? `<button type="button" class="colbtn" title="Choose which ${esc(v.cols)} to show">${v.cols === 'fields' ? 'Fields' : 'Columns'} ▾</button>` : ''}${toggle ?`<label for="${ocId}" class="oc-label" title="Hide the ${esc(v.cols)} that kept their value in the updated ${esc(v.rows)} of this ${esc(v.table)}">Only changed ${esc(v.cols)}</label>` : ''}<a class="up" href="#">↑ top</a></h2>
    <div class="explain">${explain(e, D, changedCols, v, dom).map((p) => `<p>${p}</p>`).join('')}</div>
    ${noteBox(noteId('t:' + e.name), `Note on ${e.name}`, `Why did ${e.name} change? Is it expected?`, false)}`;

  html += schemaBlock(e.schema, e.status, v);

  const titles = { inserted_rows: ['ins', `Inserted ${v.rows}`], updated_rows: ['upd', `Updated ${v.rows}`], deleted_rows: ['del', `Deleted ${v.rows}`] };
  for (const k of LISTS) {
    const list = lists[k];
    if (!list.length) continue;
    const [cls, label] = titles[k];
    const shown = list.slice(0, ROW_CAP);
    html += `<h3 class="${cls}">${esc(label)} <span class="dim">${fmt(list.length)}</span></h3>`;
    if (list.length > shown.length) html += `<p class="note">Only the first ${fmt(ROW_CAP)} of ${fmt(list.length)} ${esc(v.rows)} are written into this file. Open the report in WhatChanged to page through all of them.</p>`;
    if (k === 'updated_rows') html += whatChanged(shown, key, v);
    html += rowsTable(k, shown, cols, key, changedCols);
  }
  if (!LISTS.some((k) => lists[k].length) && (D.inserted || D.deleted) && e.status === 'changed') {
    html += `<p class="note">The ${esc(v.row)} count changed, but this ${esc(v.table)} has no key (or was too large) to tell exactly which ${esc(v.rows)}.</p>`;
  }
  return html + '</section>';
}

/** Above the updated rows: which columns changed in which row, so the table itself stays a plain grid. */
function whatChanged(list, key, v) {
  const names = (item) => Object.keys(item.changes || {});
  const sig = (item) => JSON.stringify(names(item));
  const cols = (item) => names(item).map((n) => `<code>${esc(n)}</code>`).join(', ');
  if (list.every((item) => sig(item) === sig(list[0]))) {
    return `<p class="what">What changed: ${cols(list[0])}${list.length > 1 ? ` <span class="dim">(same ${esc(v.cols)} in all ${fmt(list.length)} ${esc(v.rows)})</span>` : ''}</p>`;
  }
  const MAX = 30;
  const label = (item, i) => (key.length && item.key ? `${key.map(esc).join(', ')} = ${esc(item.key)}` : `${esc(v.row)} ${i + 1}`);
  const items = list.slice(0, MAX).map((item, i) => `<li><b>${label(item, i)}</b>: ${cols(item)}</li>`).join('');
  return `<div class="what">What changed:<ul>${items}${list.length > MAX ? `<li class="dim">… and ${fmt(list.length - MAX)} more ${esc(v.rows)}</li>` : ''}</ul></div>`;
}

function rowsTable(kind, list, cols, key, changedCols) {
  const updated = kind === 'updated_rows';
  const changed = new Set(changedCols);
  // In updated lists, columns no row touched get class "nc" so the header checkbox can hide them.
  const cc = (c) => [key.includes(c) ? 'key' : '', updated && !changed.has(c) && !key.includes(c) ? 'nc' : ''].filter(Boolean).join(' ');
  // data-c (column position) lets the "Columns" menu hide a column in every list of the table.
  const head = `<tr>${cols.map((c, i) => `<th class="${cc(c)}" data-c="${i}" data-name="${esc(c)}">${esc(c)}${key.includes(c) ? ' <span class="k">key</span>' : ''}</th>`).join('')}</tr>`;
  const rows = list.map((item) => {
    const ch = item.changes || {};
    const cells = cols.map((c, i) => {
      const refs = item.refs?.[c];
      const ref = refs?.length ? `<div class="ref">${refs.map((r) => (r.missing ? `<span class="miss">→ ${esc(r.table)} #${esc(r.id)} not found</span>` : r.label ? `→ ${esc(r.label)}` : '')).filter(Boolean).join('<br>')}</div>` : '';
      if (c in ch) return `<td class="chg ${cc(c)}" data-c="${i}"><del>${val(ch[c][0])}</del><span class="arr">→</span><ins>${val(ch[c][1])}</ins>${ref}</td>`;
      return `<td class="${cc(c)}" data-c="${i}">${c in (item.row || {}) ? val(item.row[c]) : '<span class="na">—</span>'}${ref}</td>`;
    }).join('');
    return `<tr class="${kind.split('_')[0]}">${cells}</tr>`;
  }).join('');
  return `<div class="wrap"><table><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
}

/** A small rich-text note editor; the script below wires the toolbar. Hidden until used, unless `open`. */
function noteBox(id, label, placeholder, open) {
  const btn = (cmd, text, tip) => `<button type="button" data-cmd="${cmd}" title="${tip}">${text}</button>`;
  const sep = '<span class="sep"></span>';
  const bar = [
    btn('undo', '↶', 'Undo (Ctrl+Z)') + btn('redo', '↷', 'Redo (Ctrl+Y)'),
    `<select data-cmd="block" title="Text style"><option value="p">Normal</option><option value="h1">Heading 1</option><option value="h2">Heading 2</option><option value="h3">Heading 3</option><option value="blockquote">Quote</option><option value="pre">Code block</option></select>`,
    btn('bold', '<b>B</b>', 'Bold (Ctrl+B)') + btn('italic', '<i>I</i>', 'Italic (Ctrl+I)') + btn('underline', '<u>U</u>', 'Underline (Ctrl+U)')
      + btn('strikeThrough', '<s>S</s>', 'Strikethrough') + btn('code', '<span class="mono">{ }</span>', 'Inline code'),
    `<label class="clr" title="Text color"><span>A</span><input type="color" data-cmd="foreColor" value="#dc2626"></label>` + btn('mark', '<span class="hl">A</span>', 'Highlight'),
    btn('insertUnorderedList', '• List', 'Bullet list') + btn('insertOrderedList', '1. List', 'Numbered list') + btn('checklist', '☑', 'Checklist (click a box to tick it)')
      + btn('outdent', '⇤', 'Outdent') + btn('indent', '⇥', 'Indent'),
    btn('link', '🔗', 'Link (Ctrl+K)') + btn('unlink', '⛓̸', 'Remove link') + btn('table', '▦', 'Insert table') + btn('insertHorizontalRule', '―', 'Divider line'),
    btn('removeFormat', '⨯', 'Clear formatting') + btn('source', '&lt;/&gt;', 'Edit as HTML code / back to preview'),
  ].join(sep);
  return `<div class="notes${open ? ' open' : ''}" data-note="${esc(id)}">
    <div class="nt-head"><span>${esc(label)}</span><div class="nt-bar">${bar}</div></div>
    <div class="nt-body" contenteditable="true" spellcheck="true" data-placeholder="${esc(placeholder)}"></div>
    <textarea class="nt-src" spellcheck="false" aria-label="HTML code of the note"></textarea>
    <div class="nt-foot">Paste keeps headings, lists, links, tables and images (screenshots too) · Ctrl+Shift+V pastes plain text</div>
  </div>`;
}

function val(x) {
  if (x === null || x === undefined) return '<span class="null">NULL</span>';
  if (x === '') return '<span class="empty">""</span>';
  return esc(x);
}

/* ------------------------------------------------------------ explanation */

function explain(e, D, changedCols, v, dom = '') {
  const out = [];
  const keyText = e.key?.length ? `<code>${e.key.map(esc).join(', ')}</code>` : '';
  if (e.status === 'new') {
    out.push(`This ${v.table} did not exist in the first snapshot and was created with ${plural(e.rows_after, v.row, v.rows)}${e.schema?.columns_added?.length ? ` and ${plural(e.schema.columns_added.length, v.col, v.cols)}` : ''}.`);
  } else if (e.status === 'dropped') {
    out.push(`This ${v.table} was <b>dropped</b>. It had ${plural(e.rows_before, v.row, v.rows)}; their content was not kept, only the count.`);
  } else {
    const parts = [];
    if (D.inserted) parts.push(`<b class="ins">${plural(D.inserted, v.row, v.rows)} inserted</b>`);
    if (D.updated) parts.push(`<b class="upd">${plural(D.updated, v.row, v.rows)} updated</b>`);
    if (D.deleted) parts.push(`<b class="del">${plural(D.deleted, v.row, v.rows)} deleted</b>`);
    if (parts.length) out.push(`${parts.join(', ')}. The ${v.row} count went from ${fmt(e.rows_before)} to ${fmt(e.rows_after)} (${signed((e.rows_after || 0) - (e.rows_before || 0))}).`);
    if (changedCols.length) {
      out.push(`${changedCols.length === 1 ? 'One ' + v.col : fmt(changedCols.length) + ' ' + v.cols} changed in the updated ${v.rows}: ${changedCols.map((c) => `<code>${esc(c)}</code> (${plural(D.changed_columns[c], v.row, v.rows)})`).join(', ')}. Every other ${v.col} of those ${v.rows} kept its value — all ${v.cols} are shown below so you can check.`);
    }
    if (D.mode === 'full' && keyText) out.push(`Every ${v.row} was compared by its key ${keyText}, so these lists are exact.`);
    else if (D.mode === 'hash') out.push(`This ${v.table} has no primary/unique key, so ${v.rows} were matched by their whole content: an edited ${v.row} shows up as one deleted + one inserted ${v.row}.`);
    else if (D.note) out.push(esc(D.note));
    if (e.schema && !D.inserted && !D.updated && !D.deleted) out.push(`Only the structure changed; no ${v.row} data changed.`);
  }

  const imp = e.impact;
  if (imp) {
    for (const o of imp.orphans || []) {
      out.push(`<span class="warn">⚠ ${plural(o.count, v.row, v.rows)} in <a href="#${anchor(o.table, dom)}"><code>${esc(o.table)}</code></a> still ${o.count === 1 ? 'points' : 'point'} to deleted ${v.rows} here (through <code>${esc(o.via)}</code>) — possible orphans.</span>`);
    }
    const linked = [...(imp.parents || []), ...(imp.children || [])].filter((x) => x.changed && x.table && x.table !== e.name);
    const uniq = [...new Map(linked.map((x) => [x.table, x])).values()];
    if (uniq.length) out.push(`Related ${v.tables} that also changed: ${uniq.map((x) => `<a href="#${anchor(x.table, dom)}"><code>${esc(x.table)}</code></a> (via <code>${esc(x.via)}</code>)`).join(', ')}.`);
    if (imp.triggers?.length) out.push(`Triggers on this ${v.table} may have made some of these changes: ${imp.triggers.map((t) => `<code>${esc(t.name)}</code> (${esc(t.timing)} ${esc(t.event)})`).join(', ')}.`);
  }
  return out;
}

function schemaBlock(s, status, v) {
  if (!s || status !== 'changed') return '';
  const li = [];
  for (const c of s.columns_added) li.push(`<li class="ins">${esc(v.col)} added: <code>${esc(c.name)}</code> ${esc(c.type)}${c.maybe_renamed_from ? ` <span class="dim">(maybe renamed from ${esc(c.maybe_renamed_from)})</span>` : ''}</li>`);
  for (const c of s.columns_removed) li.push(`<li class="del">${esc(v.col)} removed: <code>${esc(c.name)}</code> ${esc(c.type)}</li>`);
  for (const c of s.columns_changed) li.push(`<li class="upd">${esc(v.col)} changed: <code>${esc(c.name)}</code> — ${c.what.map((w) => `${esc(w)} <del>${esc(c.from[w] ?? 'none')}</del> → <ins>${esc(c.to[w] ?? 'none')}</ins>`).join(', ')}</li>`);
  for (const i of s.indexes_added) li.push(`<li class="ins">index added: <code>${esc(i.name)}</code> (${i.columns.map(esc).join(', ')})${i.unique ? ' unique' : ''}</li>`);
  for (const i of s.indexes_removed) li.push(`<li class="del">index removed: <code>${esc(i.name)}</code> (${i.columns.map(esc).join(', ')})</li>`);
  for (const f of s.fks_added) li.push(`<li class="ins">foreign key added: <code>${esc(f.column)}</code> → ${esc(f.ref_table)}.${esc(f.ref_column)}</li>`);
  for (const f of s.fks_removed) li.push(`<li class="del">foreign key removed: <code>${esc(f.column)}</code> → ${esc(f.ref_table)}.${esc(f.ref_column)}</li>`);
  return li.length ? `<h3 class="sch">Structure changes</h3><ul class="schema">${li.join('')}</ul>` : '';
}

function otherChanges(r) {
  const parts = [];
  const list = (label, names) => names.length && parts.push(`${label}: ${names.map((n) => `<code>${esc(n)}</code>`).join(', ')}`);
  list('Views added', r.views.added); list('Views removed', r.views.removed); list('Views changed', r.views.changed);
  list('Triggers added', r.triggers.added); list('Triggers removed', r.triggers.removed); list('Triggers changed', r.triggers.changed);
  return parts.length ? `<p class="note">${parts.join(' · ')}</p>` : '';
}

const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '±') + fmt(Math.abs(n));

function when(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const LIGHT = `--bg:#f7f7fb;--card:#fff;--text:#1d1b2e;--dim:#6b6880;--line:#e3e1ee;--ins:#15803d;--ins-bg:#e8f7ee;--upd:#b45309;--upd-bg:#fff4e0;
--del:#b91c1c;--del-bg:#fde8e8;--sch:#6d28d9;--accent:#7c3aed;--code:#f1effa;--mark:#fde68a;color-scheme:light`;
const DARK = `--bg:#0f0e17;--card:#17161f;--text:#ecebf5;--dim:#9a97ad;--line:#2a2838;--ins:#4ade80;--ins-bg:#12301f;
--upd:#fbbf24;--upd-bg:#33260d;--del:#f87171;--del-bg:#3a1515;--sch:#a78bfa;--accent:#a78bfa;--code:#24222f;--mark:#6b5a12;color-scheme:dark`;

const CSS = `
:root{${LIGHT}}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK}}}
:root[data-theme="dark"]{${DARK}}
*{box-sizing:border-box}
.bar{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:8px;padding:8px 20px;background:var(--card);border-bottom:1px solid var(--line)}
.bar .brand{font-weight:700;color:var(--accent);margin-right:auto}
.bar .status{color:var(--dim);font-size:12px}
.bar button,.add-note,.nt-bar button{font:inherit;font-size:13px;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:4px 10px;cursor:pointer}
.bar button:hover,.add-note:hover,.nt-bar button:hover{border-color:var(--accent)}
.add-note{font-size:12px;font-weight:500;padding:2px 8px;font-family:system-ui,sans-serif}
.notes{display:none;background:var(--card);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:8px;margin:10px 0 14px}
.notes.open,.notes.filled{display:block}
.nt-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:6px 10px;border-bottom:1px solid var(--line);font-size:12px;font-weight:600;color:var(--dim)}
.nt-bar{display:flex;gap:4px;flex-wrap:wrap;margin-left:auto}
.nt-bar button{font-size:12px;padding:2px 8px;min-width:28px}
.nt-bar .hl{background:var(--mark);padding:0 3px;border-radius:2px}
.nt-body{min-height:70px;padding:10px 12px;outline:none;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.nt-body:focus{box-shadow:inset 0 0 0 2px var(--accent);border-radius:0 0 8px 0}
.nt-body:empty::before{content:attr(data-placeholder);color:var(--dim)}
.nt-bar{align-items:center}
.nt-bar .sep{width:1px;height:18px;background:var(--line);margin:0 3px}
.nt-bar select{font:inherit;font-size:12px;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:2px 4px;cursor:pointer}
.nt-bar .mono{font-family:ui-monospace,Consolas,monospace}
.nt-bar .clr{position:relative;display:inline-flex;align-items:center;justify-content:center;min-width:28px;height:24px;border:1px solid var(--line);border-radius:6px;background:var(--bg);cursor:pointer;font-weight:700;font-size:12px}
.nt-bar .clr span{border-bottom:3px solid #dc2626;line-height:1.1}
.nt-bar .clr input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%}
.notes.src .nt-bar button:not([data-cmd="source"]),.notes.src .nt-bar select,.notes.src .nt-bar .clr{opacity:.35;pointer-events:none}
.notes.src [data-cmd="source"]{border-color:var(--accent);color:var(--accent)}
.nt-src{display:none;width:100%;min-height:160px;resize:vertical;border:0;outline:none;padding:10px 12px;background:var(--code);color:var(--text);font:12.5px/1.5 ui-monospace,Consolas,monospace;tab-size:2}
.notes.src .nt-src{display:block}
.notes.src .nt-body{display:none}
.nt-foot{padding:4px 12px 6px;font-size:11px;color:var(--dim);border-top:1px dashed var(--line)}
.nt-body h1{font-size:1.6em;margin:10px 0 6px}.nt-body h2{font-size:1.35em;margin:10px 0 6px}.nt-body h3{font-size:1.15em;margin:8px 0 4px}
.nt-body p,.nt-body ul,.nt-body ol,.nt-body h4,.nt-body div{margin:4px 0}
.nt-body blockquote{margin:6px 0;padding:4px 12px;border-left:3px solid var(--accent);color:var(--dim)}
.nt-body pre{margin:6px 0;padding:8px 10px;background:var(--code);border-radius:6px;white-space:pre-wrap;font:12.5px/1.5 ui-monospace,Consolas,monospace}
.nt-body table{border-collapse:collapse;margin:6px 0;width:auto;min-width:0;font-family:inherit;font-size:13px}
.nt-body th,.nt-body td{border:1px solid var(--line);padding:4px 8px;min-width:60px;font-family:inherit;position:static}
.nt-body th{background:var(--code)}
.nt-body img{max-width:100%;height:auto;border:1px solid var(--line);border-radius:6px;margin:4px 0}
.nt-body hr{border:0;border-top:1px solid var(--line);margin:10px 0}
.nt-body a{color:var(--accent)}
.nt-body ul.checklist{list-style:none;padding-left:4px}
.nt-body ul.checklist li{position:relative;padding-left:26px}
.nt-body ul.checklist li::before{content:"";position:absolute;left:2px;top:.25em;width:14px;height:14px;border:1.5px solid var(--dim);border-radius:3px;cursor:pointer}
.nt-body ul.checklist li[data-checked="true"]{color:var(--dim);text-decoration:line-through}
.nt-body ul.checklist li[data-checked="true"]::before{content:"✓";background:var(--accent);border-color:var(--accent);color:#fff;font-size:11px;line-height:14px;text-align:center}
.nt-body mark,.nt-body [style*="background"]{color:inherit}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
code,td,th{font-family:ui-monospace,"JetBrains Mono",Consolas,monospace}
code{background:var(--code);padding:1px 5px;border-radius:4px;font-size:.92em}
a{color:var(--accent)}
.top,main,footer{max-width:1400px;margin:0 auto;padding:0 20px}
.top{padding-top:28px}
.capture-title{margin:0 0 20px;font-size:30px;line-height:1.25;text-align:center}
.eyebrow{text-transform:uppercase;letter-spacing:.08em;font-size:11px;color:var(--dim);font-weight:600}
h1{margin:4px 0 6px;font-size:28px}
.sub{margin:0 0 18px;color:var(--text)}
.dim{color:var(--dim);font-weight:400}
.nums{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px}
.num{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 16px;min-width:120px}
.num b{display:block;font-size:24px}.num span{color:var(--dim);font-size:12px}
.num.ins b{color:var(--ins)}.num.upd b{color:var(--upd)}.num.del b{color:var(--del)}.num.sch b{color:var(--sch)}
.toc{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin-bottom:14px}
.toc h2{font-size:13px;margin:0 0 8px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em}
.toc ul{list-style:none;margin:0;padding:0;columns:3 260px}
.toc li{padding:2px 0;break-inside:avoid}
.tag{display:inline-block;font-size:11px;font-weight:600;padding:0 6px;border-radius:999px;margin-left:6px;font-family:system-ui,sans-serif}
.tag.ins{background:var(--ins-bg);color:var(--ins)}.tag.upd{background:var(--upd-bg);color:var(--upd)}.tag.del{background:var(--del-bg);color:var(--del)}.tag.sch{background:var(--code);color:var(--sch)}
.legend{display:flex;gap:18px;flex-wrap:wrap;align-items:center;color:var(--dim);font-size:12.5px;margin:6px 0 20px}
.sw{display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:-1px;margin-right:6px}
.sw.ins{background:var(--ins-bg);border:1px solid var(--ins)}.sw.upd{background:var(--upd-bg);border:1px solid var(--upd)}.sw.del{background:var(--del-bg);border:1px solid var(--del)}
.oc-input{position:absolute;opacity:0;pointer-events:none}
.oc-label{font:inherit;font-size:12.5px;cursor:pointer;margin-left:auto;padding:4px 10px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--text)}
.oc-label::before{content:"☐ "}
.oc-label.on,.oc-input:checked + h2 .oc-label{border-color:var(--accent)}
.oc-label.on::before,.oc-input:checked + h2 .oc-label::before{content:"☑ "}
.oc-input:checked ~ .wrap .nc{display:none}
.tbl h2 .oc-label{font-size:12px;font-weight:500;font-family:system-ui,sans-serif;padding:2px 8px}
.tbl h2 .oc-label + .up{margin-left:8px}
.no-oc #wcOcAll{display:none}
.note{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:6px;padding:8px 12px;color:var(--text)}
.tbl{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:22px;scroll-margin-top:12px}
.tbl h2{margin:0 0 8px;font-size:18px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;position:relative}
.tbl{scroll-margin-top:60px}
.tbl.collapsed{padding-bottom:10px}
.tbl.collapsed > :not(h2){display:none!important}
.tbl.collapsed h2{margin:0}
.col-tg{font:inherit;font-size:14px;width:26px;height:26px;line-height:1;padding:0;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text);cursor:pointer}
.col-tg:hover,.colbtn:hover,.view-acts button:hover{border-color:var(--accent)}
.colbtn,.view-acts button:not(.oc-label){font:inherit;font-size:12px;font-weight:500;font-family:system-ui,sans-serif;padding:2px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text);cursor:pointer}
.colbtn.on{border-color:var(--accent);color:var(--accent)}
.tbl h2 .colbtn{margin-left:auto}
.tbl h2 .colbtn + .oc-label{margin-left:0}
.tbl h2 .colbtn + .up{margin-left:8px}
.view-acts{display:flex;gap:8px;flex-wrap:wrap;margin-left:auto}
.view-acts .oc-label{margin-left:0}
.view-acts button:not(.oc-label){font-size:12.5px;padding:4px 10px;background:var(--card)}
.colpop{position:absolute;right:0;top:100%;z-index:6;margin-top:6px;width:300px;max-width:90vw;background:var(--card);border:1px solid var(--line);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.25);padding:10px;font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--text)}
.colpop input[type=search]{width:100%;font:inherit;padding:5px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text);outline:none}
.colpop input[type=search]:focus{border-color:var(--accent)}
.cp-acts{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
.cp-acts button{font:inherit;font-size:12px;padding:3px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text);cursor:pointer}
.cp-acts button:hover{border-color:var(--accent)}
.cp-list{max-height:280px;overflow:auto;border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:4px 0}
.cp-list label{display:flex;align-items:center;gap:6px;padding:3px 4px;border-radius:4px;cursor:pointer;font-family:ui-monospace,Consolas,monospace;font-size:12.5px;overflow-wrap:anywhere}
.cp-list label:hover{background:var(--code)}
.cp-list input{accent-color:var(--accent);flex:none}
.cp-list .tag{margin-left:auto}
.tag.key{background:var(--code);color:var(--accent)}
.cp-n{color:var(--dim);font-size:12px;margin-top:6px}
.tbl h2 code{font-size:17px}
.tbl h2 .rows{color:var(--dim);font-size:13px;font-weight:500}
.tbl h2 .up{margin-left:auto;font-size:12px;font-weight:500;text-decoration:none}
.explain p{margin:4px 0}
.explain b.ins{color:var(--ins)}.explain b.upd{color:var(--upd)}.explain b.del{color:var(--del)}
.warn{color:var(--del)}
h3{font-size:14px;margin:18px 0 8px}
h3.ins{color:var(--ins)}h3.upd{color:var(--upd)}h3.del{color:var(--del)}h3.sch{color:var(--sch)}
ul.schema{margin:0;padding-left:18px}ul.schema li.ins{color:var(--ins)}ul.schema li.del{color:var(--del)}ul.schema li.upd{color:var(--upd)}
.wrap{overflow:auto;max-height:70vh;border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;font-size:12.5px;width:max-content;min-width:100%}
th,td{border-bottom:1px solid var(--line);border-right:1px solid var(--line);padding:5px 9px;text-align:left;vertical-align:top;max-width:420px;overflow-wrap:anywhere}
th{position:sticky;top:0;background:var(--code);font-weight:600;z-index:1}
th .k{font-size:10px;color:var(--accent);font-family:system-ui,sans-serif}
th.key,td.key{font-weight:600}
tr.inserted td{background:var(--ins-bg)}
tr.deleted td{background:var(--del-bg)}
td.chg{background:var(--upd-bg)}
.what{margin:0 0 8px;color:var(--text)}
.what ul{margin:4px 0 0;padding-left:18px;columns:2 320px}
.what li{break-inside:avoid}
.what b{color:var(--upd);font-family:ui-monospace,Consolas,monospace;font-weight:600}
del{color:var(--del);text-decoration:line-through;opacity:.85}
ins{color:var(--ins);text-decoration:none;font-weight:600}
.arr{color:var(--dim);margin:0 5px}
.null{color:var(--dim);font-style:italic;font-size:.9em}
.empty,.na{color:var(--dim)}
.ref{font-size:11px;color:var(--accent);font-family:system-ui,sans-serif}
.ref .miss{color:var(--del)}
footer{color:var(--dim);font-size:12px;padding-bottom:30px}
.multi-summary{color:var(--dim);font-size:12.5px;margin:-8px 0 14px}
.cap-list{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin:0 0 14px}
.cap-list h2{font-size:13px;margin:0 0 8px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em}
.cap-list ol{list-style:none;margin:0;padding:0}
.cap-list li+li{border-top:1px solid var(--line)}
.cap-list a{display:flex;align-items:center;gap:10px;padding:8px 4px;color:var(--text);text-decoration:none}
.cap-list a:hover{color:var(--accent)}
.cap-n{display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:var(--code);color:var(--accent);font-size:11px;font-weight:700;flex:none}
.cap-main{min-width:0;display:flex;flex-direction:column;gap:1px}
.cap-main b{font-size:13.5px}
.cap-when{color:var(--dim);font-size:11.5px}
.cap-counts{margin-left:auto;color:var(--dim);font-size:11.5px;white-space:nowrap}
.cap-rule{border:0;border-top:2px solid var(--line);margin:38px 0 30px}
.capture{scroll-margin-top:12px}
.cap-kicker{display:flex;align-items:center;gap:8px;color:var(--dim);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px}
.cap-step{display:grid;place-items:center;width:26px;height:26px;border-radius:50%;background:var(--accent);color:#fff;font-size:12px;letter-spacing:0}
.cap-title{margin:0 0 2px;font-size:24px}
.cap-change{margin:0 0 8px;color:var(--accent);font-weight:600}
.cap-head{margin-bottom:14px}
.cap-body{padding-left:14px;border-left:3px solid var(--line)}
@media (max-width:700px){.cap-counts{display:none}.cap-body{padding-left:0;border-left:0}}
@page{size:A4 landscape;margin:10mm}
@media print{
:root,:root[data-theme="dark"]{${LIGHT}}
body{background:#fff;font-size:11px}
.bar,.oc-label,.up,.add-note,.nt-bar,.nt-src,.nt-foot,.notes:not(.filled),.col-tg,.colbtn,.colpop,.view-acts{display:none!important}
.tbl.collapsed h2::after{content:"(details hidden)";font-size:11px;font-weight:400;color:var(--dim)}
.notes.src .nt-body{display:block}
.notes.filled{display:block;break-inside:avoid}
.cap-rule{display:none!important}
.captures > .capture{break-before:page;page-break-before:always}
.captures > .capture:first-child{break-before:auto;page-break-before:auto}
.cap-list,.cap-head{break-inside:avoid}
.cap-head{break-after:avoid}
.cap-body{padding-left:0;border-left:0}
.cap-title{font-size:20px}
.nt-body:empty::before{content:none}
.top,main,footer{max-width:none;padding:0}
.wrap{max-height:none;overflow:visible;border:0}
table{width:100%;min-width:0;font-size:9px}
th{position:static}
th,td{max-width:none;padding:3px 5px}
.tbl{border:0;padding:0;margin-bottom:14px}
tr{break-inside:avoid}
*{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}
`;

/* Runs inside the exported file: theme switch, note editors (autosaved in the browser),
 * saving the file with its notes, printing. No backticks or template placeholders in here. */
const SCRIPT = `
(function () {
  var root = document.documentElement;
  var $ = function (s, el) { return (el || document).querySelector(s); };
  var $$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };
  var meta = function (n) { var m = $('meta[name="' + n + '"]'); return m ? m.getAttribute('content') : ''; };
  var store = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  };
  var KEY = 'whatchanged-notes:' + meta('wc-report');
  var status = function (t) { $('#wcStatus').textContent = t; };

  /* ---- theme: auto -> light -> dark */
  var themes = ['auto', 'light', 'dark'];
  var labels = { auto: '\\u25D0 Auto', light: '\\u2600 Light', dark: '\\u263E Dark' };
  function applyTheme(t) {
    if (t === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t);
    $('#wcTheme').textContent = labels[t];
  }
  var theme = store.get('whatchanged-theme') || 'auto';
  applyTheme(theme);
  $('#wcTheme').onclick = function () {
    theme = themes[(themes.indexOf(theme) + 1) % themes.length];
    applyTheme(theme);
    store.set('whatchanged-theme', theme);
  };

  /* ---- notes: HTML clean-up for paste and for the code view */
  var KEEP = { H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, P: 1, DIV: 1, BR: 1, B: 1, STRONG: 1, I: 1, EM: 1, U: 1, S: 1, STRIKE: 1, DEL: 1, INS: 1,
    SUB: 1, SUP: 1, UL: 1, OL: 1, LI: 1, A: 1, BLOCKQUOTE: 1, PRE: 1, CODE: 1, TABLE: 1, THEAD: 1, TBODY: 1, TFOOT: 1, TR: 1, TH: 1, TD: 1,
    HR: 1, MARK: 1, SPAN: 1, FONT: 1, IMG: 1 };
  var DROP = { SCRIPT: 1, STYLE: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, NOSCRIPT: 1, TEMPLATE: 1, META: 1, LINK: 1, TITLE: 1, HEAD: 1,
    SVG: 1, MATH: 1, FORM: 1, INPUT: 1, BUTTON: 1, TEXTAREA: 1, SELECT: 1, VIDEO: 1, AUDIO: 1, CANVAS: 1 };
  var SAFE_COLOR = /^(#[0-9a-f]{3,8}|rgba?\\([\\d\\s.,%]+\\)|[a-z]+)$/i;
  function cleanStyle(st) {
    var out = [];
    String(st || '').split(';').forEach(function (d) {
      var i = d.indexOf(':');
      if (i < 0) return;
      var p = d.slice(0, i).trim().toLowerCase();
      var v = d.slice(i + 1).trim();
      if ((p === 'color' || p === 'background-color') && SAFE_COLOR.test(v) && !/^(transparent|inherit|initial|black|windowtext)$/i.test(v)) out.push(p + ':' + v);
      if (p === 'text-align' && /^(left|right|center|justify)$/i.test(v)) out.push(p + ':' + v);
    });
    return out.join(';');
  }
  function cleanNodes(from, to) {
    Array.prototype.forEach.call(from.childNodes, function (n) {
      if (n.nodeType === 3) { to.appendChild(document.createTextNode(n.nodeValue)); return; }
      if (n.nodeType !== 1) return;
      var tag = n.tagName.toUpperCase();
      if (DROP[tag]) return;
      // Google Docs wraps everything in <b style="font-weight:normal">: not really bold.
      var fakeBold = (tag === 'B' || tag === 'STRONG') && /font-weight\\s*:\\s*(normal|400)/i.test(n.getAttribute('style') || '');
      if (!KEEP[tag] || fakeBold) { cleanNodes(n, to); return; }
      if (tag === 'IMG') {
        var src = n.getAttribute('src') || '';
        if (/^data:image\\/(png|jpe?g|gif|webp|bmp);base64,/i.test(src)) { var img = document.createElement('img'); img.src = src; to.appendChild(img); }
        return;
      }
      var el = document.createElement(tag);
      if (tag === 'A') {
        var href = (n.getAttribute('href') || '').trim();
        if (/^(https?:|mailto:|#)/i.test(href)) el.setAttribute('href', href);
      }
      if ((tag === 'TD' || tag === 'TH')) ['colspan', 'rowspan'].forEach(function (a) { var x = n.getAttribute(a); if (/^\\d{1,2}$/.test(x || '')) el.setAttribute(a, x); });
      if (tag === 'FONT' && SAFE_COLOR.test(n.getAttribute('color') || '')) el.setAttribute('color', n.getAttribute('color'));
      if (tag === 'UL' && n.classList.contains('checklist')) el.className = 'checklist';
      if (tag === 'LI' && n.hasAttribute('data-checked')) el.setAttribute('data-checked', n.getAttribute('data-checked') === 'true' ? 'true' : 'false');
      var st = cleanStyle(n.getAttribute('style'));
      if (st) el.setAttribute('style', st);
      cleanNodes(n, el);
      to.appendChild(el);
    });
    return to;
  }
  function sanitize(html) {
    var doc = new DOMParser().parseFromString('<body>' + html + '</body>', 'text/html');
    var box = document.createElement('div');
    cleanNodes(doc.body, box);
    return box.innerHTML;
  }
  // Readable HTML for the code view: one block per line.
  function pretty(html) {
    return html.replace(/(<\\/(p|div|h[1-6]|li|ul|ol|blockquote|pre|table|tr|thead|tbody)>|<br>|<hr>)/gi, '$1\\n').replace(/(<(ul|ol|table|tbody|thead|tr)[^>]*>)/gi, '$1\\n').trim();
  }

  /* ---- notes */
  var boxes = $$('.notes');
  function isEmpty(body) { return !body.textContent.trim() && !body.querySelector('img,li,hr,table'); }
  function mark(box) {
    var body = $('.nt-body', box);
    if (isEmpty(body)) { body.innerHTML = ''; box.classList.remove('filled'); } else box.classList.add('filled');
  }
  function collect() {
    var out = {};
    boxes.forEach(function (b) { var body = $('.nt-body', b); if (!isEmpty(body)) out[b.getAttribute('data-note')] = body.innerHTML; });
    return out;
  }
  // Notes and view choices made after the file was last saved live in this browser: bring them back.
  var saved = store.get(KEY);
  var fileAt = meta('wc-saved');
  var fileView = {};
  try { fileView = JSON.parse($('#wc-view').textContent || '{}'); } catch (e) { fileView = {}; }
  var startView = fileView;
  if (saved && saved.notes && (!fileAt || saved.at > fileAt)) {
    boxes.forEach(function (b) {
      var html = saved.notes[b.getAttribute('data-note')];
      if (html !== undefined) $('.nt-body', b).innerHTML = html;
    });
    if (saved.view) startView = saved.view;
    if (Object.keys(saved.notes).length || saved.view) status('Notes and view restored from this browser');
  }
  boxes.forEach(mark);

  var timer = null;
  var dirty = false; // only when the browser could not keep the notes either
  function autosave() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      var ok = store.set(KEY, { at: new Date().toISOString(), notes: collect(), view: viewState() });
      dirty = !ok;
      status(ok ? 'Saved in this browser \\u2014 use \\u201CSave file\\u201D to keep it in the file' : 'Could not autosave \\u2014 use \\u201CSave file\\u201D');
    }, 400);
  }

  $$('.add-note').forEach(function (btn) {
    btn.onclick = function () {
      var box = $('.notes[data-note="' + CSS.escape(btn.getAttribute('data-for')) + '"]');
      box.classList.add('open');
      $('.nt-body', box).focus();
    };
  });

  var plainNext = false;
  document.addEventListener('keydown', function (e) { if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'v') plainNext = true; }, true);
  function escHtml(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function insertImage(file, box) {
    if (file.size > 8 * 1024 * 1024) { status('Image is larger than 8 MB \\u2014 not added'); return; }
    var r = new FileReader();
    r.onload = function () { document.execCommand('insertHTML', false, '<img src="' + r.result + '">'); mark(box); autosave(); };
    r.readAsDataURL(file);
  }
  function blockOf(node, body) {
    while (node && node !== body) { if (node.nodeType === 1 && /^(P|DIV|H[1-6]|BLOCKQUOTE|PRE|LI)$/.test(node.tagName)) return node; node = node.parentNode; }
    return null;
  }
  function closest(node, tag, body) {
    while (node && node !== body) { if (node.nodeType === 1 && node.tagName === tag) return node; node = node.parentNode; }
    return null;
  }

  boxes.forEach(function (box) {
    var body = $('.nt-body', box);
    var src = $('.nt-src', box);
    var block = $('select[data-cmd="block"]', box);
    var changed = function () { mark(box); autosave(); };
    body.addEventListener('input', changed);
    body.addEventListener('blur', function () { if (isEmpty(body) && !box.classList.contains('keep') && !box.classList.contains('src')) box.classList.remove('open'); });

    // Paste keeps structure (headings, lists, links, tables, images) but no foreign styles or scripts.
    body.addEventListener('paste', function (e) {
      var cd = e.clipboardData || window.clipboardData;
      if (!cd) return;
      e.preventDefault();
      var files = Array.prototype.filter.call(cd.files || [], function (f) { return /^image\\//.test(f.type); });
      var html = cd.getData('text/html');
      if (plainNext || (!html && !files.length)) {
        plainNext = false;
        document.execCommand('insertText', false, cd.getData('text/plain'));
      } else if (files.length && !html) {
        files.forEach(function (f) { insertImage(f, box); });
      } else {
        document.execCommand('insertHTML', false, sanitize(html.replace(/^[\\s\\S]*<!--StartFragment-->|<!--EndFragment-->[\\s\\S]*$/g, '')));
      }
      changed();
    });
    body.addEventListener('drop', function (e) {
      var files = Array.prototype.filter.call((e.dataTransfer && e.dataTransfer.files) || [], function (f) { return /^image\\//.test(f.type); });
      if (!files.length) return;
      e.preventDefault();
      files.forEach(function (f) { insertImage(f, box); });
    });

    // Checklist: click the box in front of an item to tick it.
    body.addEventListener('click', function (e) {
      var li = e.target.closest && e.target.closest('ul.checklist > li');
      if (!li || !body.contains(li) || e.clientX - li.getBoundingClientRect().left > 24) return;
      li.setAttribute('data-checked', li.getAttribute('data-checked') === 'true' ? 'false' : 'true');
      changed();
    });

    body.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); run('link'); }
    });

    // Show the style of the paragraph the cursor is in.
    document.addEventListener('selectionchange', function () {
      var sel = window.getSelection();
      if (!sel.rangeCount || !body.contains(sel.anchorNode)) return;
      var b = blockOf(sel.anchorNode, body);
      var t = b ? b.tagName.toLowerCase() : 'p';
      block.value = /^(h1|h2|h3|blockquote|pre)$/.test(t) ? t : 'p';
    });

    function run(cmd, value) {
      if (box.classList.contains('src') && cmd !== 'source') return;
      if (cmd !== 'source') body.focus();
      if (cmd === 'block') document.execCommand('formatBlock', false, '<' + value + '>');
      else if (cmd === 'mark') document.execCommand('hiliteColor', false, getComputedStyle(root).getPropertyValue('--mark').trim() || '#fde68a');
      else if (cmd === 'foreColor') document.execCommand('foreColor', false, value);
      else if (cmd === 'code') {
        var text = window.getSelection().toString();
        document.execCommand('insertHTML', false, '<code>' + escHtml(text || 'code') + '</code>&#8203;');
      } else if (cmd === 'link') {
        var url = window.prompt('Link address (https://\\u2026)');
        if (url && /^(https?:|mailto:)/i.test(url.trim())) document.execCommand('createLink', false, url.trim());
      } else if (cmd === 'table') {
        var row = function (c) { return '<tr>' + [1, 2, 3].map(function () { return '<' + c + '><br></' + c + '>'; }).join('') + '</tr>'; };
        document.execCommand('insertHTML', false, '<table><thead>' + row('th') + '</thead><tbody>' + row('td') + row('td') + '</tbody></table><p><br></p>');
      } else if (cmd === 'checklist') {
        var sel = window.getSelection();
        var ul = sel.rangeCount && closest(sel.anchorNode, 'UL', body);
        if (ul && ul.classList.contains('checklist')) { ul.classList.remove('checklist'); ul.removeAttribute('class'); }
        else {
          if (!ul) { document.execCommand('insertUnorderedList'); ul = closest(window.getSelection().anchorNode, 'UL', body); }
          if (ul) { ul.className = 'checklist'; Array.prototype.forEach.call(ul.children, function (li) { if (!li.hasAttribute('data-checked')) li.setAttribute('data-checked', 'false'); }); }
        }
      } else if (cmd === 'source') {
        if (box.classList.toggle('src')) {
          src.value = pretty(body.innerHTML);
          src.style.height = Math.max(160, Math.min(500, src.scrollHeight + 4)) + 'px';
          src.focus();
        } else {
          body.innerHTML = sanitize(src.value);
          body.focus();
        }
      } else document.execCommand(cmd, false, null);
      changed();
    }
    // Code view: every edit updates the note (cleaned), so saving works from either view.
    src.addEventListener('input', function () { body.innerHTML = sanitize(src.value); changed(); });

    $$('.nt-bar button', box).forEach(function (b) {
      b.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep the selection in the note
      b.addEventListener('click', function () { run(b.getAttribute('data-cmd')); });
    });
    var sel0 = null;
    var keepSel = function () { var s = window.getSelection(); if (s.rangeCount && body.contains(s.anchorNode)) sel0 = s.getRangeAt(0).cloneRange(); };
    var restoreSel = function () { body.focus(); if (sel0) { var s = window.getSelection(); s.removeAllRanges(); s.addRange(sel0); } };
    block.addEventListener('mousedown', keepSel);
    block.addEventListener('change', function () { restoreSel(); run('block', block.value); });
    var color = $('input[data-cmd="foreColor"]', box);
    color.addEventListener('mousedown', keepSel);
    color.addEventListener('change', function () { color.previousElementSibling.style.borderBottomColor = color.value; restoreSel(); run('foreColor', color.value); });
  });
  $$('.notes.open').forEach(function (b) { b.classList.add('keep'); });

  /* ---- save the file itself, notes included */
  var handle = null;
  function pageHtml() {
    var at = new Date().toISOString();
    var clone = root.cloneNode(true);
    clone.removeAttribute('data-theme');
    clone.querySelector('meta[name="wc-saved"]').setAttribute('content', at);
    clone.querySelector('#wcStatus').textContent = '';
    Array.prototype.forEach.call(clone.querySelectorAll('.notes'), function (b) { if (!b.classList.contains('keep')) b.classList.remove('open'); b.classList.remove('keep'); b.classList.remove('src'); });
    Array.prototype.forEach.call(clone.querySelectorAll('.colpop'), function (p) { p.remove(); });
    // The view (collapsed tables, hidden columns…) travels inside the file; "<" escaped so it can't end the script tag.
    clone.querySelector('#wc-view').textContent = JSON.stringify(viewState()).replace(/</g, '\\\\u003c');
    return { at: at, html: '<!doctype html>\\n' + clone.outerHTML };
  }
  var downloadButton = $('#wcDownload');
  function markSaved(page, message) {
    $('meta[name="wc-saved"]').setAttribute('content', page.at);
    store.set(KEY, { at: page.at, notes: collect(), view: viewState() });
    dirty = false;
    status(message);
  }
  function downloadHtml(html, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  function downloadFile() {
    var page = pageHtml();
    var name = meta('wc-file') || 'whatchanged-report.html';
    try {
      downloadHtml(page.html, name);
      markSaved(page, 'Downloaded ' + name);
    } catch (e) {
      status('Download failed: ' + (e && e.message ? e.message : e));
    }
  }
  async function saveFile() {
    var page = pageHtml();
    var name = meta('wc-file') || 'whatchanged-report.html';
    try {
      if (window.showSaveFilePicker) {
        handle = handle || await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'HTML file', accept: { 'text/html': ['.html'] } }] });
        var w = await handle.createWritable();
        await w.write(page.html);
        await w.close();
        markSaved(page, 'Saved ' + handle.name + (downloadButton ? ' \\u2014 use Download for a copy' : ''));
      } else {
        downloadHtml(page.html, name);
        markSaved(page, 'Downloaded ' + name);
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      status('Save failed: ' + (e && e.message ? e.message : e));
    }
  }
  $('#wcSave').onclick = saveFile;
  if (downloadButton) downloadButton.onclick = downloadFile;
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (e.shiftKey && downloadButton) downloadFile(); else saveFile();
    }
  });
  window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  /* ---- "only changed columns": one switch per table, plus one for all of them */
  var ocs = $$('.tbl > .oc-input');
  var ocAll = $('#wcOcAll');
  function syncAll() { ocAll.classList.toggle('on', ocs.length > 0 && ocs.every(function (x) { return x.checked; })); }
  if (!ocs.length) root.classList.add('no-oc');
  ocs.forEach(function (x) { x.addEventListener('change', function () { syncAll(); autosave(); }); });
  ocAll.onclick = function () {
    var on = !ocs.every(function (x) { return x.checked; });
    ocs.forEach(function (x) { x.checked = on; });
    syncAll();
    autosave();
  };

  /* ---- view: collapsed tables and hidden columns, remembered with the notes */
  var sections = $$('section.tbl');
  var colStyle = $('#wcColStyle');
  if (!colStyle) { colStyle = document.createElement('style'); colStyle.id = 'wcColStyle'; document.head.appendChild(colStyle); }
  var hidden = {}; // table name -> { column name: true }
  function tableOf(s) { return s.getAttribute('data-key') || s.getAttribute('data-table'); }
  function colsOf(s) {
    return $$('.wrap table thead th[data-c]', s).filter(function (th, i, all) {
      return all.findIndex(function (x) { return x.getAttribute('data-c') === th.getAttribute('data-c'); }) === i;
    }).map(function (th) { return { i: th.getAttribute('data-c'), name: th.getAttribute('data-name'), key: th.classList.contains('key') }; });
  }
  function changedOf(s) { try { return JSON.parse(s.getAttribute('data-changed') || '[]'); } catch (e) { return []; } }

  function viewState() {
    var v = { collapsed: [], hidden: {}, only: [] };
    sections.forEach(function (s) {
      var t = tableOf(s);
      if (s.classList.contains('collapsed')) v.collapsed.push(t);
      var oc = $('.oc-input', s);
      if (oc && oc.checked) v.only.push(t);
      var h = Object.keys(hidden[t] || {});
      if (h.length) v.hidden[t] = h;
    });
    return v;
  }
  function renderColumns() {
    var css = [];
    sections.forEach(function (s) {
      var h = hidden[tableOf(s)] || {};
      var cols = colsOf(s);
      var shown = 0;
      cols.forEach(function (c) {
        if (h[c.name]) css.push('#' + CSS.escape(s.id) + ' [data-c="' + c.i + '"]{display:none}');
        else shown++;
      });
      var btn = $('.colbtn', s);
      if (btn) {
        btn.textContent = btn.textContent.split(' ')[0] + ' ' + (shown < cols.length ? shown + '/' + cols.length + ' ' : '') + '\\u25BE';
        btn.classList.toggle('on', shown < cols.length);
      }
    });
    colStyle.textContent = css.join('\\n');
  }
  function setCollapsed(s, on) {
    s.classList.toggle('collapsed', on);
    $('.col-tg', s).textContent = on ? '\\u25B8' : '\\u25BE';
    $('.col-tg', s).setAttribute('aria-expanded', on ? 'false' : 'true');
  }
  function applyView(v) {
    v = v || {};
    hidden = {};
    Object.keys(v.hidden || {}).forEach(function (t) { hidden[t] = {}; (v.hidden[t] || []).forEach(function (c) { hidden[t][c] = true; }); });
    sections.forEach(function (s) {
      var t = tableOf(s);
      setCollapsed(s, (v.collapsed || []).indexOf(t) >= 0);
      var oc = $('.oc-input', s);
      if (oc) oc.checked = (v.only || []).indexOf(t) >= 0;
    });
    syncAll();
    renderColumns();
  }

  sections.forEach(function (s) {
    $('.col-tg', s).onclick = function () { setCollapsed(s, !s.classList.contains('collapsed')); autosave(); };
    var btn = $('.colbtn', s);
    if (btn) btn.onclick = function (e) { e.stopPropagation(); openColumns(s, btn); };
  });
  $('#wcCollapseAll').onclick = function () { sections.forEach(function (s) { setCollapsed(s, true); }); autosave(); };
  $('#wcExpandAll').onclick = function () { sections.forEach(function (s) { setCollapsed(s, false); }); autosave(); };
  $('#wcResetView').onclick = function () { closeColumns(); applyView({}); autosave(); };
  // Jumping to a table from the list at the top opens it.
  $$('a[href^="#"]').forEach(function (a) {
    a.addEventListener('click', function () {
      var id = a.getAttribute('href').slice(1);
      if (!id) return;
      var s = document.getElementById(id);
      if (s && s.classList.contains('tbl') && s.classList.contains('collapsed')) { setCollapsed(s, false); autosave(); }
    });
  });

  /* columns menu */
  var pop = null;
  function closeColumns() { if (pop) { pop.remove(); pop = null; } }
  document.addEventListener('click', function (e) { if (pop && !pop.contains(e.target)) closeColumns(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeColumns(); });
  function openColumns(s, btn) {
    var again = pop && pop.parentNode === btn.parentNode;
    closeColumns();
    if (again) return;
    var t = tableOf(s);
    var cols = colsOf(s);
    var changed = changedOf(s);
    hidden[t] = hidden[t] || {};
    pop = document.createElement('div');
    pop.className = 'colpop';
    pop.innerHTML = '<input type="search" placeholder="Find a column\\u2026">'
      + '<div class="cp-acts"><button type="button" data-a="all">Show all</button><button type="button" data-a="key">Only key</button>'
      + (changed.length ? '<button type="button" data-a="changed">Key + changed</button>' : '') + '</div><div class="cp-list"></div><div class="cp-n"></div>';
    var list = $('.cp-list', pop);
    cols.forEach(function (c) {
      var row = document.createElement('label');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !hidden[t][c.name];
      cb.addEventListener('change', function () { if (cb.checked) delete hidden[t][c.name]; else hidden[t][c.name] = true; update(); });
      row.appendChild(cb);
      row.appendChild(document.createTextNode(' ' + c.name));
      if (c.key) { var k = document.createElement('span'); k.className = 'tag key'; k.textContent = 'key'; row.appendChild(k); }
      if (changed.indexOf(c.name) >= 0) { var g = document.createElement('span'); g.className = 'tag upd'; g.textContent = 'changed'; row.appendChild(g); }
      row.setAttribute('data-name', c.name.toLowerCase());
      list.appendChild(row);
    });
    function count() {
      var n = cols.filter(function (c) { return !hidden[t][c.name]; }).length;
      $('.cp-n', pop).textContent = n + ' of ' + cols.length + ' shown';
    }
    function update() { count(); renderColumns(); autosave(); }
    function setAll(keep) {
      hidden[t] = {};
      cols.forEach(function (c) { if (!keep(c)) hidden[t][c.name] = true; });
      $$('.cp-list input', pop).forEach(function (cb, i) { cb.checked = !hidden[t][cols[i].name]; });
      update();
    }
    $('.cp-acts', pop).onclick = function (e) {
      var a = e.target.getAttribute('data-a');
      if (a === 'all') setAll(function () { return true; });
      if (a === 'key') setAll(function (c) { return c.key; });
      if (a === 'changed') setAll(function (c) { return c.key || changed.indexOf(c.name) >= 0; });
    };
    var find = $('input[type=search]', pop);
    find.oninput = function () {
      var q = find.value.trim().toLowerCase();
      $$('.cp-list label', pop).forEach(function (l) { l.style.display = !q || l.getAttribute('data-name').indexOf(q) >= 0 ? '' : 'none'; });
    };
    pop.addEventListener('click', function (e) { e.stopPropagation(); });
    btn.parentNode.appendChild(pop);
    count();
    find.focus();
  }

  applyView(startView);

  /* ---- print / PDF */
  $('#wcPrint').onclick = function () { window.print(); };
})();
`;
