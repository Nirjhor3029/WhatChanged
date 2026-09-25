import pg from 'pg';
import { config } from '../config.js';
import { finishTable, columnSig, md5, norm } from '../util.js';
import { QUERY_ROW_LIMIT, QUERY_TIMEOUT_MS, uniqueCols } from '../monitor/queries.js';

// Keep date/time values exactly as Postgres prints them (no timezone surprises).
for (const oid of [1082, 1083, 1114, 1184, 1266]) pg.types.setTypeParser(oid, (v) => v);

const qi = (id) => '"' + String(id).replace(/"/g, '""') + '"';
const SYS = `('pg_catalog','information_schema')`;
const RULES = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };

/** PostgreSQL (also Supabase, Neon, RDS, CockroachDB-ish, Timescale…). */
export class PostgresDriver {
  kind = 'postgres';

  static async connect(cfg) {
    const opts = cfg.url
      ? { connectionString: cfg.url }
      : { host: cfg.host || '127.0.0.1', port: Number(cfg.port) || 5432, user: cfg.user, password: cfg.password, database: cfg.database || 'postgres' };
    if (cfg.url && cfg.database) opts.database = cfg.database;
    if (cfg.ssl || /sslmode=(require|verify)/i.test(cfg.url || '')) {
      opts.ssl = { rejectUnauthorized: false };
      if (opts.connectionString) opts.connectionString = opts.connectionString.replace(/([?&])sslmode=[^&]*&?/i, '$1').replace(/[?&]$/, '');
    }
    opts.connectionTimeoutMillis = 10000;
    opts.application_name = 'whatchanged';
    const d = new PostgresDriver();
    d.opts = opts;
    d.client = new pg.Client(opts);
    try {
      await d.client.connect();
    } catch (e) {
      throw new Error(friendly(e));
    }
    d.client.on('error', () => { d.broken = true; });
    d.database = (await d.rows('SELECT current_database() d'))[0].d;
    return d;
  }

  async close() {
    try { await this.client.end(); } catch { /* ignore */ }
    try { await this.qclient?.end(); } catch { /* ignore */ }
  }

  /** Run a user's watched query: own connection, READ ONLY transaction, cursor-limited rows, timeout. */
  async runQuery(text) {
    if (!this.qclient) {
      const c = new pg.Client({ ...this.opts, application_name: 'whatchanged-queries' });
      c.on('error', () => { this.qclient = null; });
      await c.connect();
      this.qclient = c;
    }
    const c = this.qclient;
    await c.query('BEGIN READ ONLY');
    try {
      await c.query(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`);
      let res;
      if (/^\s*(select|with|values|table)\b/i.test(text)) {
        // A cursor limits the rows without rewriting the user's SQL.
        await c.query(`DECLARE whatchanged_q NO SCROLL CURSOR FOR ${text}`);
        res = await c.query({ text: `FETCH ${QUERY_ROW_LIMIT + 1} FROM whatchanged_q`, rowMode: 'array' });
      } else {
        res = await c.query({ text, rowMode: 'array' });
      }
      if (!res.fields?.length) throw new Error('This statement does not return rows.');
      return { cols: uniqueCols(res.fields.map((f) => f.name)), rows: res.rows.slice(0, QUERY_ROW_LIMIT).map((r) => r.map(norm)), truncated: res.rows.length > QUERY_ROW_LIMIT };
    } finally {
      try { await c.query('ROLLBACK'); } catch { this.qclient = null; }
    }
  }
  async ping() { await this.client.query('SELECT 1'); }

  async rows(sql, params = []) { return (await this.client.query(sql, params)).rows; }

  async version() {
    const v = (await this.rows('SHOW server_version'))[0].server_version;
    return 'PostgreSQL ' + v.split(' ')[0];
  }

  async listDatabases() {
    return (await this.rows('SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname')).map((r) => r.datname);
  }

  static display(sch, rel) { return sch === 'public' ? rel : `${sch}.${rel}`; }
  qt(t) { return qi(t.ref.schema) + '.' + qi(t.ref.table); }

  async columnsByTable() {
    const out = {};
    const rows = await this.rows(`
      SELECT n.nspname sch, c.relname rel, a.attname n, format_type(a.atttypid, a.atttypmod) ty, NOT a.attnotnull nu,
             pg_get_expr(d.adbin, d.adrelid) df, a.attidentity idn, a.attgenerated gen, col_description(c.oid, a.attnum) cm
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r','p','v','m')
         AND n.nspname NOT IN ${SYS} AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
       ORDER BY n.nspname, c.relname, a.attnum`);
    for (const r of rows) {
      const extra = r.idn ? 'identity' : r.gen ? 'generated' : (r.df || '').startsWith('nextval(') ? 'serial' : '';
      (out[PostgresDriver.display(r.sch, r.rel)] ||= []).push({ name: r.n, type: r.ty, nullable: r.nu, default: r.df, key: '', extra, comment: r.cm || '' });
    }
    return out;
  }

  async schema() {
    const tables = {};
    const trows = await this.rows(`
      SELECT n.nspname sch, c.relname rel, c.relkind k, c.reltuples::bigint est,
             pg_total_relation_size(c.oid) sz, pg_indexes_size(c.oid) isz, obj_description(c.oid) cm
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r','p','v','m') AND NOT c.relispartition
         AND n.nspname NOT IN ${SYS} AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
       ORDER BY 1, 2`);
    for (const r of trows) {
      const name = PostgresDriver.display(r.sch, r.rel);
      const isTable = r.k === 'r' || r.k === 'p';
      tables[name] = {
        name, type: isTable ? 'table' : 'view', engine: r.k === 'm' ? 'materialized view' : r.k === 'p' ? 'partitioned' : '',
        est_rows: Math.max(0, Number(r.est) || 0), data_size: Number(r.sz) - Number(r.isz), index_size: Number(r.isz),
        comment: r.cm || '', columns: [], indexes: [], ref: { schema: r.sch, table: r.rel },
      };
    }
    for (const [t, c] of Object.entries(await this.columnsByTable())) if (tables[t]) tables[t].columns = c;

    const irows = await this.rows(`
      SELECT n.nspname sch, t.relname rel, i.relname n, ix.indisunique u, ix.indisprimary p,
             array(SELECT a.attname::text FROM unnest(ix.indkey) WITH ORDINALITY k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum ORDER BY k.ord)::text[] cols
        FROM pg_index ix
        JOIN pg_class t ON t.oid = ix.indrelid
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname NOT IN ${SYS} AND n.nspname NOT LIKE 'pg_toast%'
       ORDER BY 1, 2, 3`);
    for (const r of irows) {
      const t = tables[PostgresDriver.display(r.sch, r.rel)];
      if (t) t.indexes.push({ name: r.n, unique: r.u, primary: r.p, columns: r.cols || [] });
    }
    for (const t of Object.values(tables)) {
      const pk = new Set(t.indexes.find((i) => i.primary)?.columns || []);
      const uni = new Set(t.indexes.filter((i) => i.unique && !i.primary).flatMap((i) => i.columns));
      for (const c of t.columns) c.key = pk.has(c.name) ? 'PRI' : uni.has(c.name) ? 'UNI' : '';
      finishTable(t);
    }

    const fks = (await this.rows(`
      SELECT n.nspname sch, cl.relname rel, con.conname n, a.attname c, nr.nspname rsch, cr.relname rrel, ar.attname rc,
             con.confupdtype ur, con.confdeltype dr
        FROM pg_constraint con
        JOIN pg_class cl ON cl.oid = con.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
        JOIN pg_class cr ON cr.oid = con.confrelid JOIN pg_namespace nr ON nr.oid = cr.relnamespace
        CROSS JOIN LATERAL unnest(con.conkey, con.confkey) AS k(c, rc)
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.c
        JOIN pg_attribute ar ON ar.attrelid = con.confrelid AND ar.attnum = k.rc
       WHERE con.contype = 'f' AND n.nspname NOT IN ${SYS}`))
      .map((r) => ({
        name: r.n, table: PostgresDriver.display(r.sch, r.rel), column: r.c,
        ref_table: PostgresDriver.display(r.rsch, r.rrel), ref_column: r.rc, on_update: RULES[r.ur] || r.ur, on_delete: RULES[r.dr] || r.dr,
      }));

    const views = {};
    const vrows = await this.rows(`
      SELECT schemaname sch, viewname n, definition d FROM pg_views WHERE schemaname NOT IN ${SYS}
      UNION ALL SELECT schemaname, matviewname, definition FROM pg_matviews WHERE schemaname NOT IN ${SYS}`);
    for (const r of vrows) {
      const name = PostgresDriver.display(r.sch, r.n);
      views[name] = { name, definition: r.d || '', sig: md5(r.d || '') };
    }
    const triggers = (await this.rows(`
      SELECT trigger_name n, string_agg(event_manipulation, ' OR ') ev, event_object_schema sch, event_object_table t,
             action_timing tm, action_statement st
        FROM information_schema.triggers WHERE trigger_schema NOT IN ${SYS}
       GROUP BY 1, 3, 4, 5, 6`))
      .map((r) => ({ name: r.n, event: r.ev, table: PostgresDriver.display(r.sch, r.t), timing: r.tm, statement: r.st }));

    return { tables, fks, views, triggers };
  }

  async count(t) {
    return Number((await this.rows(`SELECT count(*) c FROM ${this.qt(t)}`))[0].c);
  }

  /**
   * Exact content hash for normal-size tables; activity counters for huge ones.
   */
  async fingerprints(tables) {
    const out = {};
    for (const t of tables) {
      const size = t.rows ?? t.est_rows ?? 0;
      try {
        if (size <= config.rowLimit * 4) {
          const r = await this.rows(`SELECT md5(coalesce(string_agg(h, '' ORDER BY h), '')) f FROM (SELECT md5(x::text) h FROM ${this.qt(t)} x) s`);
          out[t.name] = r[0].f;
        } else {
          const r = await this.rows(
            `SELECT concat_ws(':', n_tup_ins, n_tup_upd, n_tup_del, n_live_tup) f FROM pg_stat_user_tables WHERE relid = $1::regclass`,
            [this.qt(t)]);
          out[t.name] = r[0] ? 'stat:' + r[0].f : null;
        }
      } catch {
        out[t.name] = null;
      }
    }
    return out;
  }

  async fetchRows(t, cols, { key = [], limit = null, desc = false, offset = 0 } = {}) {
    let sql = `SELECT ${cols.map(qi).join(', ')} FROM ${this.qt(t)}`;
    if (limit !== null && key.length) sql += ' ORDER BY ' + key.map((k) => qi(k) + (desc ? ' DESC' : '')).join(', ');
    if (limit !== null) sql += ' LIMIT ' + Number(limit) + (offset ? ' OFFSET ' + Number(offset) : '');
    const res = await this.client.query({ text: sql, rowMode: 'array' });
    return { cols, rows: res.rows.map((r) => r.map(norm)) };
  }

  async liveState() {
    const out = {};
    const rows = await this.rows(`
      SELECT n.nspname sch, c.relname rel, c.relkind k, c.reltuples::bigint est
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r','p','v','m') AND NOT c.relispartition
         AND n.nspname NOT IN ${SYS} AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'`);
    for (const r of rows) {
      out[PostgresDriver.display(r.sch, r.rel)] = { type: r.k === 'r' || r.k === 'p' ? 'table' : 'view', est_rows: Math.max(0, Number(r.est) || 0) };
    }
    for (const [t, c] of Object.entries(await this.columnsByTable())) if (out[t]) out[t].schema_sig = columnSig(c);
    return out;
  }
}

function friendly(e) {
  const m = String(e.message || e);
  if (e.code === '28P01' || e.code === '28000') return /no pg_hba\.conf entry.*no encryption|SSL off/i.test(m) ? 'Server requires SSL — tick "Use SSL/TLS".' : 'Access denied — check the username and password.';
  if (e.code === '3D000') return 'That database does not exist on this server.';
  if (e.code === 'ECONNREFUSED') return 'Cannot reach the PostgreSQL server — is it running on that host/port?';
  if (e.code === 'ENOTFOUND') return 'Host not found — check the hostname.';
  if (/SSL|encryption/i.test(m)) return 'SSL problem: ' + m + ' — try toggling "Use SSL/TLS".';
  return m;
}
