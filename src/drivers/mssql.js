import sql from 'mssql';
import { finishTable, columnSig, md5, norm } from '../util.js';

const qi = (id) => '[' + String(id).replace(/]/g, ']]') + ']';
const RULE = (r) => String(r || '').replace(/_/g, ' ');

/** Microsoft SQL Server / Azure SQL. */
export class MssqlDriver {
  kind = 'mssql';

  static async connect(cfg) {
    let opts;
    if (cfg.url) {
      opts = cfg.url; // ADO style: "Server=...;Database=...;User Id=...;Password=...;Encrypt=true"
    } else {
      opts = {
        server: cfg.host || 'localhost',
        port: Number(cfg.port) || 1433,
        user: cfg.user,
        password: cfg.password,
        database: cfg.database || 'master',
        options: { encrypt: !!cfg.ssl, trustServerCertificate: true, appName: 'db-checker' },
        connectionTimeout: 15000,
        requestTimeout: 120000,
        pool: { max: 2, min: 0 },
      };
    }
    const d = new MssqlDriver();
    try {
      d.pool = await new sql.ConnectionPool(opts).connect();
    } catch (e) {
      throw new Error(friendly(e));
    }
    if (cfg.url && cfg.database) await d.pool.request().batch(`USE ${qi(cfg.database)}`);
    d.database = (await d.rows('SELECT DB_NAME() d'))[0].d;
    return d;
  }

  async close() { try { await this.pool.close(); } catch { /* ignore */ } }
  async ping() { await this.rows('SELECT 1 x'); }

  async rows(text, params = {}) {
    const r = this.pool.request();
    for (const [k, v] of Object.entries(params)) r.input(k, v);
    return (await r.query(text)).recordset;
  }

  async version() {
    const r = await this.rows(`SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(64)) v, CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) e`);
    return `SQL Server ${r[0].v}`;
  }

  async listDatabases() {
    return (await this.rows(`SELECT name FROM sys.databases WHERE database_id > 4 AND state = 0 ORDER BY name`)).map((r) => r.name);
  }

  static display(sch, rel) { return sch === 'dbo' ? rel : `${sch}.${rel}`; }
  qt(t) { return qi(t.ref.schema) + '.' + qi(t.ref.table); }

  async columnsByTable() {
    const out = {};
    const rows = await this.rows(`
      SELECT c.TABLE_SCHEMA sch, c.TABLE_NAME rel, c.COLUMN_NAME n,
             c.DATA_TYPE + CASE WHEN c.CHARACTER_MAXIMUM_LENGTH = -1 THEN '(max)'
                                WHEN c.CHARACTER_MAXIMUM_LENGTH IS NOT NULL THEN '(' + CAST(c.CHARACTER_MAXIMUM_LENGTH AS varchar(12)) + ')'
                                WHEN c.DATA_TYPE IN ('decimal','numeric') THEN '(' + CAST(c.NUMERIC_PRECISION AS varchar(4)) + ',' + CAST(c.NUMERIC_SCALE AS varchar(4)) + ')'
                                ELSE '' END ty,
             c.IS_NULLABLE nu, c.COLUMN_DEFAULT df,
             COLUMNPROPERTY(OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME)), c.COLUMN_NAME, 'IsIdentity') idn
        FROM INFORMATION_SCHEMA.COLUMNS c ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION`);
    for (const r of rows) {
      (out[MssqlDriver.display(r.sch, r.rel)] ||= []).push({
        name: r.n, type: r.ty, nullable: r.nu === 'YES', default: r.df, key: '', extra: r.idn === 1 ? 'identity' : '', comment: '',
      });
    }
    return out;
  }

  async schema() {
    const tables = {};
    const trows = await this.rows(`
      SELECT s.name sch, o.name rel, o.type k,
             (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = o.object_id AND p.index_id IN (0,1)) est,
             (SELECT SUM(a.total_pages) * 8192 FROM sys.partitions p JOIN sys.allocation_units a ON a.container_id = p.partition_id
               WHERE p.object_id = o.object_id) sz
        FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
       WHERE o.type IN ('U','V') AND o.is_ms_shipped = 0 ORDER BY s.name, o.name`);
    for (const r of trows) {
      const name = MssqlDriver.display(r.sch, r.rel);
      tables[name] = {
        name, type: r.k.trim() === 'U' ? 'table' : 'view', engine: '', est_rows: Number(r.est) || 0,
        data_size: Number(r.sz) || 0, index_size: 0, comment: '', columns: [], indexes: [], ref: { schema: r.sch, table: r.rel },
      };
    }
    for (const [t, c] of Object.entries(await this.columnsByTable())) if (tables[t]) tables[t].columns = c;

    const irows = await this.rows(`
      SELECT s.name sch, t.name rel, i.name n, i.is_unique u, i.is_primary_key p, c.name col
        FROM sys.indexes i
        JOIN sys.tables t ON t.object_id = i.object_id JOIN sys.schemas s ON s.schema_id = t.schema_id
        JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
        JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
       WHERE i.name IS NOT NULL ORDER BY s.name, t.name, i.name, ic.key_ordinal`);
    const idx = {};
    for (const r of irows) {
      const key = MssqlDriver.display(r.sch, r.rel);
      const ix = ((idx[key] ||= {})[r.n] ||= { name: r.n, unique: !!r.u, primary: !!r.p, columns: [] });
      ix.columns.push(r.col);
    }
    for (const t of Object.values(tables)) {
      t.indexes = Object.values(idx[t.name] || {});
      const pk = new Set(t.indexes.find((i) => i.primary)?.columns || []);
      for (const c of t.columns) if (pk.has(c.name)) c.key = 'PRI';
      finishTable(t);
    }

    const fks = (await this.rows(`
      SELECT fk.name n, sp.name sch, tp.name rel, cp.name c, sr.name rsch, tr.name rrel, cr.name rc,
             fk.update_referential_action_desc ur, fk.delete_referential_action_desc dr
        FROM sys.foreign_keys fk
        JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
        JOIN sys.tables tp ON tp.object_id = fkc.parent_object_id JOIN sys.schemas sp ON sp.schema_id = tp.schema_id
        JOIN sys.columns cp ON cp.object_id = fkc.parent_object_id AND cp.column_id = fkc.parent_column_id
        JOIN sys.tables tr ON tr.object_id = fkc.referenced_object_id JOIN sys.schemas sr ON sr.schema_id = tr.schema_id
        JOIN sys.columns cr ON cr.object_id = fkc.referenced_object_id AND cr.column_id = fkc.referenced_column_id`))
      .map((r) => ({
        name: r.n, table: MssqlDriver.display(r.sch, r.rel), column: r.c, ref_table: MssqlDriver.display(r.rsch, r.rrel),
        ref_column: r.rc, on_update: RULE(r.ur), on_delete: RULE(r.dr),
      }));

    const views = {};
    for (const r of await this.rows(`SELECT s.name sch, v.name n, OBJECT_DEFINITION(v.object_id) d FROM sys.views v JOIN sys.schemas s ON s.schema_id = v.schema_id`)) {
      const name = MssqlDriver.display(r.sch, r.n);
      views[name] = { name, definition: r.d || '', sig: md5(r.d || '') };
    }
    const triggers = (await this.rows(`
      SELECT tr.name n, s.name sch, t.name rel, OBJECT_DEFINITION(tr.object_id) st, tr.is_instead_of_trigger io,
             STUFF((SELECT ' OR ' + te.type_desc FROM sys.trigger_events te WHERE te.object_id = tr.object_id FOR XML PATH('')), 1, 4, '') ev
        FROM sys.triggers tr JOIN sys.tables t ON t.object_id = tr.parent_id JOIN sys.schemas s ON s.schema_id = t.schema_id`))
      .map((r) => ({ name: r.n, event: r.ev || '', table: MssqlDriver.display(r.sch, r.rel), timing: r.io ? 'INSTEAD OF' : 'AFTER', statement: r.st || '' }));

    return { tables, fks, views, triggers };
  }

  async count(t) {
    return Number((await this.rows(`SELECT COUNT_BIG(*) c FROM ${this.qt(t)}`))[0].c);
  }

  async fingerprints(tables) {
    const out = {};
    for (const t of tables) {
      try {
        const r = await this.rows(`SELECT COUNT_BIG(*) c, CHECKSUM_AGG(BINARY_CHECKSUM(*)) h FROM ${this.qt(t)} WITH (NOLOCK)`);
        out[t.name] = `${r[0].c}:${r[0].h}`;
      } catch {
        out[t.name] = null;
      }
    }
    return out;
  }

  async fetchRows(t, cols, { key = [], limit = null, desc = false } = {}) {
    let text = `SELECT ${limit !== null ? `TOP (${Number(limit)}) ` : ''}${cols.map(qi).join(', ')} FROM ${this.qt(t)}`;
    if (limit !== null && key.length) text += ' ORDER BY ' + key.map((k) => qi(k) + (desc ? ' DESC' : '')).join(', ');
    const req = this.pool.request();
    req.arrayRowMode = true;
    const res = await req.query(text);
    return { cols, rows: res.recordset.map((r) => r.map(norm)) };
  }

  async liveState() {
    const out = {};
    for (const r of await this.rows(`SELECT s.name sch, o.name rel, o.type k FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE o.type IN ('U','V') AND o.is_ms_shipped = 0`)) {
      out[MssqlDriver.display(r.sch, r.rel)] = { type: r.k.trim() === 'U' ? 'table' : 'view' };
    }
    for (const [t, c] of Object.entries(await this.columnsByTable())) if (out[t]) out[t].schema_sig = columnSig(c);
    return out;
  }
}

function friendly(e) {
  const m = String(e.message || e);
  if (/Login failed/i.test(m)) return 'Login failed — check the username and password.';
  if (/ECONNREFUSED|Failed to connect/i.test(m)) return 'Cannot reach SQL Server — is it running and is TCP/IP enabled on that port?';
  if (/self.signed|certificate/i.test(m)) return 'TLS certificate problem: ' + m;
  return m;
}
