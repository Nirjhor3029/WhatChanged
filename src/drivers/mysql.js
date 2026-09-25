import mysql from 'mysql2/promise';
import { finishTable, columnSig, md5, norm } from '../util.js';

const q = (id) => '`' + String(id).replace(/`/g, '``') + '`';

/** MySQL / MariaDB (also PlanetScale, Aiven, RDS… anything speaking the MySQL protocol). */
export class MysqlDriver {
  kind = 'mysql';

  static async connect(cfg) {
    const opts = {
      host: cfg.host || '127.0.0.1',
      port: Number(cfg.port) || 3306,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database || undefined,
      connectTimeout: 10000,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      multipleStatements: false,
    };
    if (cfg.ssl) opts.ssl = { rejectUnauthorized: false };
    const d = new MysqlDriver();
    try {
      d.conn = await mysql.createConnection(opts);
    } catch (e) {
      throw new Error(friendly(e));
    }
    d.database = cfg.database || '';
    for (const sql of ['SET SESSION information_schema_stats_expiry = 0', 'SET SESSION group_concat_max_len = 1048576']) {
      try { await d.conn.query(sql); } catch { /* MariaDB / old MySQL */ }
    }
    return d;
  }

  async close() { try { await this.conn.end(); } catch { /* ignore */ } }
  async ping() { await this.conn.query('SELECT 1'); }

  async rows(sql, params = []) {
    const [r] = await this.conn.query(sql, params);
    return r;
  }

  async version() {
    const [r] = await this.rows('SELECT VERSION() v');
    return (/mariadb/i.test(r.v) ? 'MariaDB ' : 'MySQL ') + r.v.replace(/-.*$/, '');
  }

  async listDatabases() {
    const skip = new Set(['information_schema', 'performance_schema', 'mysql', 'sys']);
    return (await this.rows('SHOW DATABASES')).map((r) => r.Database).filter((d) => !skip.has(d));
  }

  async columnsByTable() {
    const out = {};
    const rows = await this.rows(
      `SELECT TABLE_NAME t, COLUMN_NAME n, COLUMN_TYPE ty, IS_NULLABLE nu, COLUMN_DEFAULT df, COLUMN_KEY k, EXTRA x, COLUMN_COMMENT c
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`, [this.database]);
    for (const r of rows) {
      (out[r.t] ||= []).push({ name: r.n, type: r.ty, nullable: r.nu === 'YES', default: r.df, key: r.k, extra: r.x, comment: r.c });
    }
    return out;
  }

  async schema() {
    const tables = {};
    const trows = await this.rows(
      `SELECT TABLE_NAME n, TABLE_TYPE t, ENGINE e, TABLE_ROWS r, DATA_LENGTH d, INDEX_LENGTH i, UPDATE_TIME ut, TABLE_COMMENT c
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, [this.database]);
    for (const r of trows) {
      tables[r.n] = {
        name: r.n, type: r.t === 'VIEW' ? 'view' : 'table', engine: r.e,
        est_rows: Number(r.r) || 0, data_size: Number(r.d) || 0, index_size: Number(r.i) || 0,
        update_time: r.ut, comment: r.c, columns: [], indexes: [],
      };
    }
    const cols = await this.columnsByTable();
    for (const [t, c] of Object.entries(cols)) if (tables[t]) tables[t].columns = c;

    const idx = {};
    const irows = await this.rows(
      `SELECT TABLE_NAME t, INDEX_NAME n, NON_UNIQUE nu, COLUMN_NAME c
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`, [this.database]);
    for (const r of irows) {
      const ix = ((idx[r.t] ||= {})[r.n] ||= { name: r.n, unique: String(r.nu) === '0', primary: r.n === 'PRIMARY', columns: [] });
      if (r.c) ix.columns.push(r.c);
    }
    for (const t of Object.values(tables)) {
      t.indexes = Object.values(idx[t.name] || {});
      finishTable(t);
    }

    const fks = (await this.rows(
      `SELECT k.TABLE_NAME t, k.COLUMN_NAME c, k.CONSTRAINT_NAME n, k.REFERENCED_TABLE_NAME rt, k.REFERENCED_COLUMN_NAME rc,
              r.UPDATE_RULE ur, r.DELETE_RULE dr
         FROM information_schema.KEY_COLUMN_USAGE k
         LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS r
                ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
        WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
          AND (k.REFERENCED_TABLE_SCHEMA IS NULL OR k.REFERENCED_TABLE_SCHEMA = k.TABLE_SCHEMA)
        ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`, [this.database]))
      .map((r) => ({ name: r.n, table: r.t, column: r.c, ref_table: r.rt, ref_column: r.rc, on_update: r.ur, on_delete: r.dr }));

    const views = {};
    for (const r of await this.rows('SELECT TABLE_NAME n, VIEW_DEFINITION d FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?', [this.database])) {
      views[r.n] = { name: r.n, definition: String(r.d || ''), sig: md5(String(r.d || '')) };
    }
    const triggers = (await this.rows(
      `SELECT TRIGGER_NAME n, EVENT_MANIPULATION ev, EVENT_OBJECT_TABLE t, ACTION_TIMING tm, ACTION_STATEMENT st
         FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?`, [this.database]))
      .map((r) => ({ name: r.n, event: r.ev, table: r.t, timing: r.tm, statement: r.st }));

    return { tables, fks, views, triggers };
  }

  async count(t) {
    const [r] = await this.rows(`SELECT COUNT(*) c FROM ${q(t.name)}`);
    return Number(r.c);
  }

  /** CHECKSUM TABLE for many tables at once. */
  async fingerprints(tables) {
    const out = {};
    const names = tables.map((t) => t.name);
    for (let i = 0; i < names.length; i += 40) {
      const chunk = names.slice(i, i + 40);
      const rows = await this.rows('CHECKSUM TABLE ' + chunk.map(q).join(', '));
      rows.forEach((r, j) => { out[chunk[j]] = r.Checksum === null ? null : String(r.Checksum); });
    }
    return out;
  }

  async fetchRows(t, cols, { key = [], limit = null, desc = false } = {}) {
    let sql = `SELECT ${cols.map(q).join(', ')} FROM ${q(t.name)}`;
    if (limit !== null && key.length) sql += ' ORDER BY ' + key.map((k) => q(k) + (desc ? ' DESC' : '')).join(', ');
    if (limit !== null) sql += ' LIMIT ' + Number(limit);
    const [rows] = await this.conn.query({ sql, rowsAsArray: true });
    return { cols, rows: rows.map((r) => r.map(norm)) };
  }

  async liveState() {
    const out = {};
    const rows = await this.rows(
      'SELECT TABLE_NAME n, TABLE_TYPE t, TABLE_ROWS r, UPDATE_TIME ut FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [this.database]);
    for (const r of rows) out[r.n] = { type: r.t === 'VIEW' ? 'view' : 'table', est_rows: Number(r.r) || 0, update_time: r.ut };
    for (const [t, c] of Object.entries(await this.columnsByTable())) if (out[t]) out[t].schema_sig = columnSig(c);
    return out;
  }
}

function friendly(e) {
  const m = String(e.message || e);
  if (e.code === 'ER_ACCESS_DENIED_ERROR') return 'Access denied — check the username and password.';
  if (e.code === 'ER_BAD_DB_ERROR') return 'That database does not exist on this server.';
  if (e.code === 'ECONNREFUSED') return 'Cannot reach the MySQL server — is it running on that host/port?';
  if (e.code === 'ENOTFOUND') return 'Host not found — check the hostname.';
  if (e.code === 'ETIMEDOUT') return 'Connection timed out — firewall, wrong port, or the server needs SSL?';
  if (/secure transport|SSL/i.test(m)) return 'This server requires SSL — tick "Use SSL/TLS".';
  return m;
}

