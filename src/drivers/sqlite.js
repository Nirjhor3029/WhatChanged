import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { finishTable, columnSig, md5, norm, sha1 } from '../util.js';
import { QUERY_ROW_LIMIT, uniqueCols } from '../monitor/queries.js';

const qi = (id) => '"' + String(id).replace(/"/g, '""') + '"';

/** SQLite database file (uses Node's built-in node:sqlite, opened read-only). */
export class SqliteDriver {
  kind = 'sqlite';

  static async connect(cfg) {
    let file = String(cfg.file || cfg.url || '').trim().replace(/^sqlite:(\/\/)?/i, '').replace(/^file:(\/\/)?/i, '');
    if (!file) throw new Error('Choose the SQLite database file (full path).');
    file = path.resolve(file);
    if (!fs.existsSync(file)) throw new Error('SQLite file not found: ' + file);
    let DatabaseSync;
    try {
      ({ DatabaseSync } = await import('node:sqlite'));
    } catch {
      throw new Error('SQLite needs Node.js 22.13 or newer (built-in node:sqlite).');
    }
    const d = new SqliteDriver();
    d.file = file;
    d.db = new DatabaseSync(file, { readOnly: true });
    d.database = path.basename(file);
    return d;
  }

  async close() { try { this.db.close(); } catch { /* ignore */ } }

  /** Run a user's watched query. The database handle is opened read-only, so writes fail anyway. */
  async runQuery(text) {
    const st = this.db.prepare(text);
    st.setReadBigInts?.(true);
    const arrays = typeof st.setReturnArrays === 'function';
    if (arrays) st.setReturnArrays(true);
    let cols = typeof st.columns === 'function' ? st.columns().map((c) => c.name) : null;
    if (cols && !cols.length) throw new Error('This statement does not return rows.');
    const rows = [];
    for (const r of st.iterate()) {
      if (!cols) cols = Object.keys(r);
      rows.push(arrays ? r : cols.map((c) => r[c]));
      if (rows.length > QUERY_ROW_LIMIT) break;
    }
    return { cols: uniqueCols(cols || []), rows: rows.slice(0, QUERY_ROW_LIMIT).map((r) => r.map(norm)), truncated: rows.length > QUERY_ROW_LIMIT };
  }
  async ping() { this.db.prepare('SELECT 1').get(); }

  all(sqlText, ...params) {
    const st = this.db.prepare(sqlText);
    st.setReadBigInts?.(true);
    return st.all(...params);
  }

  async version() { return 'SQLite ' + this.all('SELECT sqlite_version() v')[0].v; }
  async listDatabases() { return [this.database]; }

  async schema() {
    const tables = {};
    const objs = this.all(`SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name`);
    const size = fs.statSync(this.file).size;
    for (const o of objs.filter((x) => x.type === 'table' || x.type === 'view')) {
      const t = {
        name: o.name, type: o.type, engine: /WITHOUT\s+ROWID/i.test(o.sql || '') ? 'without rowid' : '',
        est_rows: 0, data_size: 0, index_size: 0, comment: '', columns: [], indexes: [],
      };
      const info = this.all(`PRAGMA table_xinfo(${qi(o.name)})`);
      const pkCols = info.filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((c) => c.name);
      t.columns = info.filter((c) => Number(c.hidden) === 0 || Number(c.hidden) >= 2).map((c) => ({
        name: c.name, type: c.type || 'ANY', nullable: Number(c.notnull) === 0 && Number(c.pk) === 0,
        default: c.dflt_value, key: Number(c.pk) > 0 ? 'PRI' : '', extra: Number(c.hidden) >= 2 ? 'generated' : '', comment: '',
      }));
      if (o.type === 'table') {
        for (const ix of this.all(`PRAGMA index_list(${qi(o.name)})`)) {
          const cols = this.all(`PRAGMA index_info(${qi(ix.name)})`).sort((a, b) => Number(a.seqno) - Number(b.seqno)).map((c) => c.name);
          t.indexes.push({ name: ix.name, unique: Number(ix.unique) === 1, primary: ix.origin === 'pk', columns: cols });
        }
        if (pkCols.length && !t.indexes.some((i) => i.primary)) t.indexes.unshift({ name: 'PRIMARY', unique: true, primary: true, columns: pkCols });
        try { t.est_rows = Number(this.all(`SELECT COUNT(*) c FROM ${qi(o.name)}`)[0].c); } catch { /* ignore */ }
      }
      tables[o.name] = finishTable(t);
    }
    // Rough size split so the tiles have something to show.
    const totalRows = Object.values(tables).reduce((s, t) => s + t.est_rows, 0) || 1;
    for (const t of Object.values(tables)) t.data_size = Math.round(size * (t.est_rows / totalRows));

    const fks = [];
    for (const t of Object.values(tables).filter((x) => x.type === 'table')) {
      for (const f of this.all(`PRAGMA foreign_key_list(${qi(t.name)})`)) {
        const refPk = tables[f.table]?.pk?.[0] || 'id';
        fks.push({ name: `fk_${t.name}_${f.id}`, table: t.name, column: f.from, ref_table: f.table, ref_column: f.to || refPk, on_update: f.on_update, on_delete: f.on_delete });
      }
    }
    const views = {};
    for (const o of objs.filter((x) => x.type === 'view')) views[o.name] = { name: o.name, definition: o.sql || '', sig: md5(o.sql || '') };
    const triggers = objs.filter((x) => x.type === 'trigger').map((o) => {
      const m = /\b(BEFORE|AFTER|INSTEAD\s+OF)?\s*(INSERT|UPDATE|DELETE)\b/i.exec(o.sql || '') || [];
      return { name: o.name, event: (m[2] || '').toUpperCase(), table: o.tbl_name, timing: (m[1] || 'BEFORE').toUpperCase(), statement: o.sql || '' };
    });
    return { tables, fks, views, triggers };
  }

  async count(t) { return Number(this.all(`SELECT COUNT(*) c FROM ${qi(t.name)}`)[0].c); }

  async fingerprints(tables) {
    const out = {};
    for (const t of tables) {
      try {
        const size = t.rows ?? t.est_rows ?? 0;
        if (size <= config.rowLimit * 4) {
          const st = this.db.prepare(`SELECT * FROM ${qi(t.name)}`);
          st.setReadBigInts?.(true);
          const h = [];
          for (const r of st.iterate()) h.push(JSON.stringify(Object.values(r).map(norm)));
          out[t.name] = sha1(h.join('\n'));
        } else {
          const r = this.all(`SELECT COUNT(*) c, MAX(rowid) m FROM ${qi(t.name)}`)[0];
          out[t.name] = `n:${r.c}:${r.m}`;
        }
      } catch {
        out[t.name] = null;
      }
    }
    return out;
  }

  async fetchRows(t, cols, { key = [], limit = null, desc = false, offset = 0 } = {}) {
    let s = `SELECT ${cols.map(qi).join(', ')} FROM ${qi(t.name)}`;
    if (limit !== null && key.length) s += ' ORDER BY ' + key.map((k) => qi(k) + (desc ? ' DESC' : '')).join(', ');
    if (limit !== null) s += ' LIMIT ' + Number(limit) + (offset ? ' OFFSET ' + Number(offset) : '');
    const rows = this.all(s).map((r) => cols.map((c) => norm(r[c])));
    return { cols, rows };
  }

  async liveState() {
    const out = {};
    for (const o of this.all(`SELECT type, name FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'`)) {
      const info = this.all(`PRAGMA table_xinfo(${qi(o.name)})`);
      const cols = info.filter((c) => Number(c.hidden) === 0 || Number(c.hidden) >= 2).map((c) => ({
        name: c.name, type: c.type || 'ANY', nullable: Number(c.notnull) === 0 && Number(c.pk) === 0,
        default: c.dflt_value, extra: Number(c.hidden) >= 2 ? 'generated' : '',
      }));
      out[o.name] = { type: o.type, schema_sig: columnSig(cols) };
    }
    return out;
  }
}
