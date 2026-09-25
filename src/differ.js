import { config } from './config.js';
import { around, buildRelations } from './relations.js';
import { cut, keyBy, md5 } from './util.js';

const LABEL_COLS = ['name', 'title', 'full_name', 'fullName', 'username', 'email', 'label', 'slug', 'code', 'sku',
  'first_name', 'firstName', 'invoice_no', 'order_no', 'orderNumber', 'number', 'subject', 'phone'];

/** Compares two snapshots and produces a human-friendly change report. */
export class Differ {
  constructor(store, conn) {
    this.store = store;
    this.conn = conn;
    this.labelCache = new Map();
    this.rowCache = new Map();
  }

  loadRows(t) {
    if (!t?.data_ref) return null;
    const k = t.data_ref + '/' + t.data_file;
    if (!this.rowCache.has(k)) this.rowCache.set(k, this.store.loadRows(this.conn, t));
    return this.rowCache.get(k);
  }

  diff(from, to, fresh = false) {
    const cacheFile = this.store.diffPath(this.conn, from, to);
    if (!fresh) {
      const cached = this.store.readJson(cacheFile);
      if (cached) return cached;
    }
    const A = (this.A = this.store.meta(this.conn, from));
    const B = (this.B = this.store.meta(this.conn, to));
    const edgesA = buildRelations(A);
    const edgesB = buildRelations(B);
    const tablesA = Object.fromEntries(Object.entries(A.tables).filter(([, t]) => t.type === 'table'));
    const tablesB = Object.fromEntries(Object.entries(B.tables).filter(([, t]) => t.type === 'table'));
    const names = [...new Set([...Object.keys(tablesA), ...Object.keys(tablesB)])].sort();

    const report = {};
    for (const name of names) {
      const a = tablesA[name];
      const b = tablesB[name];
      const entry = a && b ? this.compareTable(a, b) : b ? this.newTable(b) : this.droppedTable(a);
      if (entry) report[name] = entry;
    }

    const changed = Object.keys(report);
    for (const [name, entry] of Object.entries(report)) {
      const dropped = entry.status === 'dropped';
      entry.impact = this.impact(name, entry, dropped ? edgesA : edgesB, changed, dropped ? A : B);
    }

    const totals = { tables: changed.length, inserted: 0, updated: 0, deleted: 0, schema: 0, new_tables: 0, dropped_tables: 0 };
    for (const e of Object.values(report)) {
      totals.inserted += e.data?.inserted || 0;
      totals.updated += e.data?.updated || 0;
      totals.deleted += e.data?.deleted || 0;
      totals.schema += e.schema?.count || 0;
      if (e.status === 'new') totals.new_tables++;
      if (e.status === 'dropped') totals.dropped_tables++;
    }

    const result = {
      driver: B.driver,
      database: B.database,
      from: { id: A.id, label: A.label, created_at: A.created_at },
      to: { id: B.id, label: B.label, created_at: B.created_at },
      generated_at: new Date().toISOString(),
      totals,
      tables: Object.values(report),
      views: this.viewChanges(A, B),
      triggers: this.triggerChanges(A, B),
      edges: edgesB.filter((e) => e.type !== 'morph' && (changed.includes(e.from) || changed.includes(e.to))),
    };
    this.store.writeJson(cacheFile, result);
    return result;
  }

  /* -------------------------------------------------------------- tables */

  compareTable(a, b) {
    const mongo = this.B.driver === 'mongodb';
    const schema = this.schemaDiff(a, b);
    const sameData = a.rows === b.rows && a.checksum != null && a.checksum === b.checksum && (mongo || a.schema_sig === b.schema_sig);
    const sameFile = a.data_ref && a.data_ref === b.data_ref && a.data_file === b.data_file;
    if ((sameData || sameFile) && !schema) return null;

    const data = sameData || sameFile ? null : this.rowDiff(a, b);
    if (data && !schema && data.inserted + data.updated + data.deleted === 0 && a.rows === b.rows) {
      if (data.mode === 'full') return null; // identical content, fingerprint noise
      data.note = 'Data changed outside the captured window of this large table.';
    }
    return {
      name: b.name, status: 'changed', rows_before: a.rows ?? null, rows_after: b.rows ?? null,
      columns: b.columns.map((c) => c.name), key: b.rowkey, schema, data,
    };
  }

  newTable(b) {
    const rowsB = this.loadRows(b);
    const list = [];
    if (rowsB) {
      const ki = idx(rowsB.cols, b.rowkey);
      for (const r of rowsB.rows.slice(0, config.maxList)) list.push({ key: keyString(r, ki), row: zip(rowsB.cols, r) });
    }
    return {
      name: b.name, status: 'new', rows_before: 0, rows_after: b.rows ?? 0, columns: b.columns.map((c) => c.name), key: b.rowkey,
      schema: { count: b.columns.length, columns_added: b.columns, columns_removed: [], columns_changed: [], indexes_added: b.indexes, indexes_removed: [], fks_added: [], fks_removed: [] },
      data: { mode: b.mode || 'none', inserted: b.rows ?? 0, updated: 0, deleted: 0, inserted_rows: list, updated_rows: [], deleted_rows: [], changed_columns: {} },
    };
  }

  droppedTable(a) {
    return {
      name: a.name, status: 'dropped', rows_before: a.rows ?? 0, rows_after: 0, columns: a.columns.map((c) => c.name), key: a.rowkey,
      schema: null,
      data: { mode: 'count', inserted: 0, updated: 0, deleted: a.rows ?? 0, inserted_rows: [], updated_rows: [], deleted_rows: [], changed_columns: {} },
    };
  }

  schemaDiff(a, b) {
    const ac = keyBy(a.columns, 'name');
    const bc = keyBy(b.columns, 'name');
    const added = b.columns.filter((c) => !ac[c.name]).map((c) => ({ ...c }));
    const removed = a.columns.filter((c) => !bc[c.name]);
    const changed = [];
    const fields = this.B.driver === 'mongodb' ? ['type'] : ['type', 'nullable', 'default', 'extra', 'key'];
    for (const col of b.columns) {
      const old = ac[col.name];
      if (!old) continue;
      const what = fields.filter((f) => (old[f] ?? null) !== (col[f] ?? null));
      if (what.length) changed.push({ name: col.name, what, from: old, to: col });
    }
    if (removed.length === added.length) {
      for (const r of removed) {
        const ad = added.find((x) => !x.maybe_renamed_from && x.type === r.type);
        if (ad) ad.maybe_renamed_from = r.name;
      }
    }
    const ai = keyBy(a.indexes, 'name');
    const bi = keyBy(b.indexes, 'name');
    const sameIx = (x, y) => x && y && x.unique === y.unique && JSON.stringify(x.columns) === JSON.stringify(y.columns);
    const idxAdded = b.indexes.filter((ix) => !sameIx(ai[ix.name], ix));
    const idxRemoved = a.indexes.filter((ix) => !sameIx(bi[ix.name], ix));

    const sig = (f) => `${f.column}->${f.ref_table}.${f.ref_column} ${f.on_delete}`;
    const fa = keyBy((this.A.fks || []).filter((f) => f.table === a.name).map((f) => ({ ...f, s: sig(f) })), 's');
    const fb = keyBy((this.B.fks || []).filter((f) => f.table === b.name).map((f) => ({ ...f, s: sig(f) })), 's');
    const fkAdded = Object.values(fb).filter((f) => !fa[f.s]);
    const fkRemoved = Object.values(fa).filter((f) => !fb[f.s]);

    const count = added.length + removed.length + changed.length + idxAdded.length + idxRemoved.length + fkAdded.length + fkRemoved.length;
    if (!count) return null;
    return { count, columns_added: added, columns_removed: removed, columns_changed: changed, indexes_added: idxAdded, indexes_removed: idxRemoved, fks_added: fkAdded, fks_removed: fkRemoved };
  }

  rowDiff(a, b) {
    const res = { mode: 'count', inserted: 0, updated: 0, deleted: 0, inserted_rows: [], updated_rows: [], deleted_rows: [], changed_columns: {} };
    const da = this.loadRows(a);
    const db = this.loadRows(b);
    const delta = (b.rows || 0) - (a.rows || 0);
    if (!da || !db || da.mode === 'none' || db.mode === 'none') {
      res.inserted = Math.max(0, delta);
      res.deleted = Math.max(0, -delta);
      res.note = 'Only row counts are known for this table (no usable key, or data not captured).';
      return res;
    }

    const common = db.cols.filter((c) => da.cols.includes(c));
    const ia = Object.fromEntries(da.cols.map((c, i) => [c, i]));
    const ib = Object.fromEntries(db.cols.map((c, i) => [c, i]));
    const pairs = common.map((c) => [c, ia[c], ib[c]]);
    const key = b.rowkey || [];
    const useKey = key.length > 0 && JSON.stringify(key) === JSON.stringify(a.rowkey) && key.every((k) => common.includes(k));
    const kiA = useKey ? idx(da.cols, key) : [];
    const kiB = useKey ? idx(db.cols, key) : [];
    const mapA = indexRows(da.rows, useKey, kiA, pairs, 1);
    const mapB = indexRows(db.rows, useKey, kiB, pairs, 2);

    const partial = da.mode === 'tail' || db.mode === 'tail';
    res.mode = useKey ? (partial ? 'window' : 'full') : 'hash';
    let minA = null;
    let minB = null;
    if (partial) {
      if (!useKey || key.length !== 1) res.mode = 'count';
      if (da.mode === 'tail') minA = minKey(mapA.keys());
      if (db.mode === 'tail') minB = minKey(mapB.keys());
    }

    const max = config.maxList;
    const changedCols = {};
    for (const [k, rb] of mapB) {
      const ra = mapA.get(k);
      if (ra) {
        if (!useKey) continue;
        const changes = {};
        let n = 0;
        for (const [c, x, y] of pairs) {
          if (ra[x] !== rb[y]) { changes[c] = [ra[x], rb[y]]; n++; }
        }
        if (n) {
          res.updated++;
          for (const c of Object.keys(changes)) changedCols[c] = (changedCols[c] || 0) + 1;
          if (res.updated_rows.length < max) res.updated_rows.push({ key: keyString(rb, kiB), row: zip(db.cols, rb), changes });
        }
        continue;
      }
      if (res.mode === 'count') continue;
      if (minA !== null && cmp(k, minA) < 0) continue; // below A's captured window → unknown
      res.inserted++;
      if (res.inserted_rows.length < max) res.inserted_rows.push({ key: useKey ? keyString(rb, kiB) : '', row: zip(db.cols, rb) });
    }
    if (res.mode !== 'count') {
      for (const [k, ra] of mapA) {
        if (mapB.has(k)) continue;
        if (minB !== null && cmp(k, minB) < 0) continue;
        res.deleted++;
        if (res.deleted_rows.length < max) res.deleted_rows.push({ key: useKey ? keyString(ra, kiA) : '', row: zip(da.cols, ra) });
      }
    } else {
      res.inserted = Math.max(0, delta);
      res.deleted = Math.max(0, -delta);
    }

    if (res.mode === 'hash') res.note = 'This table has no primary/unique key, so an edited row shows up as one deleted + one inserted row.';
    else if (res.mode === 'window') res.note = `Large table: only the newest ${config.tailRows.toLocaleString()} rows are compared row-by-row; counts are exact.`;
    else if (res.mode === 'count' && partial) res.note = 'Large table without a simple key: counts are exact, row details are limited.';
    res.changed_columns = Object.fromEntries(Object.entries(changedCols).sort((x, y) => y[1] - x[1]));
    return res;
  }

  /* -------------------------------------------------------------- impact */

  impact(name, entry, edges, changed, meta) {
    const ar = around(edges, name);
    const parents = ar.parents.map((e) => ({
      table: e.to, via: e.col, to_col: e.to_col, type: e.type, morph: e.morph || null, changed: !!e.to && changed.includes(e.to),
    }));
    const children = ar.children.map((e) => ({
      table: e.from, via: e.col, to_col: e.to_col, type: e.type, on_delete: e.on_delete || null, changed: changed.includes(e.from),
    }));
    const short = name.split('.').pop();
    const views = Object.values(meta.views || {})
      .filter((v) => new RegExp(`(^|[^\\w])["'\`\\[]?${escapeRe(short)}["'\`\\]]?([^\\w]|$)`, 'i').test(v.definition))
      .map((v) => v.name);
    const triggers = (meta.triggers || []).filter((t) => t.table === name).map((t) => ({ name: t.name, timing: t.timing, event: t.event }));

    // Resolve reference values in listed rows to a readable label of the parent row.
    const refEdges = ar.parents.filter((e) => e.to);
    if (refEdges.length && entry.data) {
      for (const list of ['inserted_rows', 'updated_rows', 'deleted_rows']) {
        for (const item of entry.data[list]) {
          for (const e of refEdges) {
            const val = item.row[e.col];
            if (val === null || val === undefined || val === '' || val === '0') continue;
            const vals = val.startsWith('[') ? safeJson(val) : [val];
            if (!Array.isArray(vals)) continue;
            for (const v of vals.slice(0, 5)) {
              const label = this.lookupLabel(e.to, e.to_col, String(v), list === 'deleted_rows');
              (item.refs ||= {})[e.col] ||= [];
              item.refs[e.col].push({ table: e.to, id: String(v), label: label || null, missing: label === false });
            }
          }
        }
      }
    }

    // Deleted rows still referenced elsewhere → possible orphans.
    const orphans = [];
    const pk = meta.tables[name]?.pk || [];
    if (entry.data?.deleted_rows?.length && pk.length === 1) {
      const deleted = new Set(entry.data.deleted_rows.map((d) => String(d.row[pk[0]] ?? '')));
      for (const e of ar.children) {
        const child = this.B.tables[e.from];
        if (!child || child.mode !== 'full') continue;
        const data = this.loadRows(child);
        const ci = data?.cols.indexOf(e.col) ?? -1;
        if (ci < 0) continue;
        let n = 0;
        for (const r of data.rows) if (r[ci] !== null && deleted.has(String(r[ci]))) n++;
        if (n) orphans.push({ table: e.from, via: e.col, count: n, type: e.type });
      }
    }
    return { parents, children, views, triggers, orphans };
  }

  /** @returns label string, null (no label column / unknown) or false (referenced row does not exist) */
  lookupLabel(table, col, val, preferOld) {
    const ck = `${table}.${col}.${preferOld ? 'A' : 'B'}`;
    if (!this.labelCache.has(ck)) {
      let map = null;
      const t = (preferOld ? this.A : this.B).tables[table];
      if (t && t.mode === 'full') {
        const data = this.loadRows(t);
        const ci = data ? data.cols.indexOf(col) : -1;
        if (ci >= 0) {
          const li = LABEL_COLS.map((c) => data.cols.indexOf(c)).find((i) => i >= 0);
          map = new Map();
          for (const r of data.rows) map.set(String(r[ci]), li !== undefined ? r[li] : '');
        }
      }
      this.labelCache.set(ck, map);
    }
    const map = this.labelCache.get(ck);
    if (!map) return null;
    if (!map.has(val)) return false;
    const label = map.get(val);
    return label ? cut(label, 60) : null;
  }

  viewChanges(A, B) {
    const va = A.views || {};
    const vb = B.views || {};
    return {
      added: Object.keys(vb).filter((n) => !va[n]),
      removed: Object.keys(va).filter((n) => !vb[n]),
      changed: Object.keys(vb).filter((n) => va[n] && va[n].sig !== vb[n].sig),
    };
  }

  triggerChanges(A, B) {
    const sig = (t) => `${t.timing} ${t.event} ${t.table} ${md5(t.statement || '')}`;
    const ta = Object.fromEntries((A.triggers || []).map((t) => [t.name, sig(t)]));
    const tb = Object.fromEntries((B.triggers || []).map((t) => [t.name, sig(t)]));
    return {
      added: Object.keys(tb).filter((n) => !(n in ta)),
      removed: Object.keys(ta).filter((n) => !(n in tb)),
      changed: Object.keys(tb).filter((n) => n in ta && ta[n] !== tb[n]),
    };
  }
}

function idx(cols, names) {
  const out = [];
  for (const n of names || []) {
    const i = cols.indexOf(n);
    if (i < 0) return [];
    out.push(i);
  }
  return out;
}
const keyString = (row, ki) => ki.map((i) => row[i] ?? '∅').join(' · ');
const zip = (cols, row) => Object.fromEntries(cols.map((c, i) => [c, row[i] ?? null]));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const safeJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

function indexRows(rows, useKey, ki, pairs, side) {
  const map = new Map();
  if (useKey) {
    for (const r of rows) map.set(ki.map((i) => String(r[i])).join('\u001f'), r);
    return map;
  }
  // No key: hash of common columns; duplicates get an occurrence counter.
  const seen = new Map();
  for (const r of rows) {
    const h = md5(JSON.stringify(pairs.map((p) => r[p[side]])));
    const n = (seen.get(h) || 0) + 1;
    seen.set(h, n);
    map.set(h + '#' + n, r);
  }
  return map;
}

function cmp(x, y) {
  const nx = Number(x);
  const ny = Number(y);
  if (x !== '' && y !== '' && !Number.isNaN(nx) && !Number.isNaN(ny)) return nx - ny;
  return x < y ? -1 : x > y ? 1 : 0;
}

function minKey(keys) {
  let min = null;
  for (const k of keys) if (min === null || cmp(k, min) < 0) min = k;
  return min;
}
