import { config } from './config.js';
import { getDriver } from './drivers/index.js';
import { buildRelations } from './relations.js';
import { Differ } from './differ.js';
import { columnSig, fileSafe, snapshotId } from './util.js';

/**
 * Snapshots are taken in three steps so the UI can show real progress:
 *   begin()   – read the schema, create the snapshot
 *   capture() – count / fingerprint / dump a batch of tables
 *   finish()  – totals + mark complete
 * Row data is only written when a table changed since the previous snapshot;
 * unchanged tables point at the older file (data_ref).
 */
export class Snapshotter {
  constructor(store) {
    this.store = store;
  }

  async begin(conn, label) {
    const started = Date.now();
    const db = await getDriver(conn);
    const schema = await db.schema();
    const id = snapshotId();
    const meta = {
      id,
      label: label || 'Snapshot',
      created_at: new Date().toISOString(),
      status: 'running',
      driver: db.kind,
      database: db.database,
      server_version: await db.version(),
      started,
      ...schema,
    };
    this.store.saveMeta(conn.id, meta);
    this.store.saveSummary(conn.id, { id, label: meta.label, created_at: meta.created_at, status: 'running' });
    this.store.touchConnection(conn.id);
    const list = Object.values(schema.tables)
      .filter((t) => t.type === 'table')
      .map((t) => ({ name: t.name, est_rows: t.est_rows, columns: t.columns.length }));
    return { id, driver: db.kind, database: db.database, server_version: meta.server_version, tables: list, views: Object.keys(schema.views).length, fks: schema.fks.length };
  }

  async capture(conn, snapId, names) {
    const meta = this.store.meta(conn.id, snapId);
    const prev = this.store.latestComplete(conn.id, snapId);
    const db = await getDriver(conn);
    const targets = names.map((n) => meta.tables[n]).filter((t) => t && t.type === 'table');
    const out = [];

    // exact counts first (fingerprint strategy may depend on size)
    for (const t of targets) {
      try { t.rows = await db.count(t); } catch (e) { t.error = e.message; t.rows = t.est_rows; }
    }
    let fps = {};
    try { fps = await db.fingerprints(targets.filter((t) => !t.error)); } catch { /* fingerprints are optional */ }

    for (const t of targets) {
      const t0 = Date.now();
      try {
        if (t.error) throw new Error(t.error);
        t.checksum = fps[t.name] ?? null;
        const p = prev?.tables?.[t.name];
        // Mongo field lists come from sampling, so rely on the content fingerprint there.
        const same = p && p.type === 'table' && (db.kind === 'mongodb' || p.schema_sig === t.schema_sig) && p.rows === t.rows
          && t.checksum !== null && p.checksum === t.checksum && p.data_ref;
        if (same) {
          Object.assign(t, { mode: p.mode, captured: p.captured || 0, data_ref: p.data_ref, data_file: p.data_file, reused: true });
          if (db.kind === 'mongodb' && p.columns) { t.columns = p.columns; t.schema_sig = p.schema_sig; }
        } else {
          const cols = t.columns.map((c) => c.name);
          const key = t.rowkey;
          let mode;
          let res;
          if (t.rows <= config.rowLimit) {
            mode = 'full';
            res = await db.fetchRows(t, cols);
          } else if (key.length) {
            mode = 'tail';
            res = await db.fetchRows(t, cols, { key, limit: config.tailRows, desc: true });
          } else {
            mode = 'none';
            res = { cols, rows: [] };
          }
          // Mongo: exact field list from all documents rather than the sample
          if (res.columns) {
            t.columns = res.columns;
            t.schema_sig = columnSig(res.columns);
          }
          Object.assign(t, { mode, captured: res.rows.length, data_ref: snapId, data_file: fileSafe(t.name), reused: false });
          this.store.writeJson(this.store.dataPath(conn.id, snapId, t.data_file),
            { table: t.name, cols: res.cols, key, mode, rows: res.rows }, true);
        }
        delete t.error;
      } catch (e) {
        t.error = e.message;
        t.mode = 'none';
      }
      out.push({ name: t.name, rows: t.rows, mode: t.mode, reused: !!t.reused, ms: Date.now() - t0, error: t.error || null });
    }
    this.store.saveMeta(conn.id, meta);
    return out;
  }

  async finish(conn, snapId) {
    const meta = this.store.meta(conn.id, snapId);
    let tables = 0, rows = 0, cols = 0, size = 0, errors = 0;
    for (const t of Object.values(meta.tables)) {
      if (t.type !== 'table') continue;
      tables++;
      rows += Number(t.rows ?? t.est_rows) || 0;
      cols += t.columns.length;
      size += (t.data_size || 0) + (t.index_size || 0);
      if (t.error) errors++;
    }
    const edges = buildRelations(meta);
    meta.status = 'complete';
    meta.duration_ms = Date.now() - (meta.started || Date.now());
    const summary = {
      id: snapId, label: meta.label, created_at: meta.created_at, status: 'complete',
      driver: meta.driver, database: meta.database, tables, views: Object.keys(meta.views).length, rows, columns: cols, size,
      fks: meta.fks.length, relations: edges.filter((e) => e.type !== 'morph').length, errors, duration_ms: meta.duration_ms,
    };
    meta.summary = summary;
    this.store.saveMeta(conn.id, meta);
    this.store.saveSummary(conn.id, summary);
    return summary;
  }

  /** Live watch: what changed since snapshot `baseId`, without taking a snapshot. */
  async watch(conn, baseId) {
    const base = this.store.meta(conn.id, baseId);
    const db = await getDriver(conn);
    const live = await db.liveState();
    const changes = [];
    const baseTables = Object.fromEntries(Object.entries(base.tables).filter(([, t]) => t.type === 'table'));
    const liveTables = Object.fromEntries(Object.entries(live).filter(([, t]) => t.type === 'table'));

    for (const name of Object.keys(liveTables)) {
      if (!baseTables[name]) changes.push({ table: name, kind: 'new', before: 0, after: await safeCount(db, { name, ref: refOf(name, base) }) });
    }
    for (const [name, t] of Object.entries(baseTables)) {
      if (!liveTables[name]) changes.push({ table: name, kind: 'dropped', before: t.rows || 0, after: 0 });
    }
    const check = [];
    for (const [name, t] of Object.entries(baseTables)) {
      if (!liveTables[name]) continue;
      const sig = liveTables[name].schema_sig;
      if (sig && sig !== t.schema_sig) {
        changes.push({ table: name, kind: 'schema', before: t.rows || 0, after: await safeCount(db, t) });
      } else if (t.checksum !== null && t.checksum !== undefined) {
        check.push(t);
      }
    }
    if (check.length) {
      const fps = await db.fingerprints(check);
      for (const t of check) {
        if (fps[t.name] !== undefined && fps[t.name] !== t.checksum) {
          changes.push({ table: t.name, kind: 'data', before: t.rows || 0, after: await safeCount(db, t), fp: fps[t.name] });
        }
      }
    }
    // fp lets the UI know when a table changed *again* (to refresh its "what changed" preview)
    for (const c of changes) c.fp ||= `${c.kind}:${c.after}:${liveTables[c.table]?.schema_sig || ''}`;
    changes.sort((a, b) => a.table.localeCompare(b.table));
    return { base: baseId, checked_at: new Date().toISOString(), changes };
  }

  /**
   * Live "what changed" for some tables: rows fetched right now compared with the
   * baseline snapshot — exact inserted / updated (old → new) / deleted rows,
   * without saving a snapshot.
   */
  async peek(conn, baseId, names) {
    const base = this.store.meta(conn.id, baseId);
    const db = await getDriver(conn);
    const live = await db.liveState();
    let schema = null;
    const out = {};
    for (const name of names) {
      try {
        const a = base.tables[name]?.type === 'table' ? base.tables[name] : null;
        const differ = new Differ(this.store, conn.id);
        if (!live[name]) {
          out[name] = a ? { ...differ.droppedTable(a), impact: null } : null;
          continue;
        }
        let b;
        const sig = live[name].schema_sig;
        if (!a || (sig && sig !== a.schema_sig)) {
          schema ||= await db.schema();
          b = structuredClone(schema.tables[name]);
        } else {
          b = { ...a };
        }
        if (!b) { out[name] = null; continue; }
        b.rows = await db.count(b);
        const cols = b.columns.map((c) => c.name);
        let res;
        if (b.rows <= config.rowLimit) {
          b.mode = 'full';
          res = await db.fetchRows(b, cols);
        } else if (b.rowkey.length) {
          b.mode = 'tail';
          res = await db.fetchRows(b, cols, { key: b.rowkey, limit: config.tailRows, desc: true });
        } else {
          b.mode = 'none';
          res = { cols, rows: [] };
        }
        if (res.columns) { b.columns = res.columns; b.schema_sig = columnSig(res.columns); }
        b.checksum = null;
        out[name] = differ.peek(base, a, b, { table: name, cols: res.cols, key: b.rowkey, mode: b.mode, rows: res.rows });
      } catch (e) {
        out[name] = { name, error: e.message };
      }
    }
    return out;
  }
}

async function safeCount(db, t) {
  try { return await db.count(t); } catch { return null; }
}

function refOf(name, meta) {
  const [schema, table] = name.includes('.') ? name.split('.') : [meta.driver === 'mssql' ? 'dbo' : 'public', name];
  return { schema, table };
}
