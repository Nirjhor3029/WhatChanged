import { MongoClient } from 'mongodb';
import { config } from '../config.js';
import { finishTable, md5, norm, plain, sha1, typeOf } from '../util.js';

/**
 * MongoDB (local, replica sets, MongoDB Atlas `mongodb+srv://` URLs, DocumentDB, Cosmos Mongo API).
 * Collections are treated as tables, documents as rows and top-level fields as columns
 * (nested objects/arrays are compared as JSON).
 */
export class MongoDriver {
  kind = 'mongodb';

  static async connect(cfg) {
    let uri = cfg.url;
    if (!uri) {
      const auth = cfg.user ? `${encodeURIComponent(cfg.user)}:${encodeURIComponent(cfg.password || '')}@` : '';
      uri = `mongodb://${auth}${cfg.host || '127.0.0.1'}:${Number(cfg.port) || 27017}/?authSource=admin${cfg.ssl ? '&tls=true' : ''}`;
    }
    const d = new MongoDriver();
    d.client = new MongoClient(uri, { serverSelectionTimeoutMS: 12000, connectTimeoutMS: 12000, appName: 'db-checker' });
    try {
      await d.client.connect();
    } catch (e) {
      throw new Error(friendly(e));
    }
    d.database = cfg.database || d.client.options?.dbName || '';
    if (d.database === 'test' && !/\/test(\?|$)/.test(uri) && !cfg.database) d.database = '';
    d.db = d.database ? d.client.db(d.database) : null;
    return d;
  }

  requireDb() {
    if (!this.db) throw new Error('Pick a database (or put it in the URL: …mongodb.net/<database>).');
    return this.db;
  }

  async close() { try { await this.client.close(); } catch { /* ignore */ } }
  async ping() { await this.client.db('admin').command({ ping: 1 }); }

  async version() {
    try {
      const info = await this.client.db('admin').command({ buildInfo: 1 });
      return 'MongoDB ' + info.version;
    } catch {
      return 'MongoDB';
    }
  }

  async listDatabases() {
    try {
      const r = await this.client.db('admin').admin().listDatabases({ nameOnly: true, authorizedDatabases: true });
      return r.databases.map((d) => d.name).filter((n) => !['admin', 'local', 'config'].includes(n));
    } catch {
      return this.database ? [this.database] : [];
    }
  }

  static inferColumns(docs, indexes = []) {
    const fields = new Map();
    for (const d of docs) {
      for (const [k, v] of Object.entries(d)) {
        let f = fields.get(k);
        if (!f) fields.set(k, (f = { types: new Set(), seen: 0 }));
        f.types.add(typeOf(v));
        f.seen++;
      }
    }
    const uniq = new Set(indexes.filter((i) => i.unique && i.columns.length === 1).map((i) => i.columns[0]));
    const names = [...fields.keys()].sort((a, b) => (a === '_id' ? -1 : b === '_id' ? 1 : 0));
    return names.map((name) => {
      const f = fields.get(name);
      const types = [...f.types].filter((t) => t !== 'null');
      return {
        name,
        type: (types.sort().join('|') || 'null'),
        nullable: f.seen < docs.length || f.types.has('null'),
        default: null,
        key: name === '_id' ? 'PRI' : uniq.has(name) ? 'UNI' : '',
        extra: '',
        comment: docs.length ? `in ${Math.round((f.seen / docs.length) * 100)}% of docs` : '',
      };
    });
  }

  async schema() {
    const db = this.requireDb();
    const colls = (await db.listCollections({}, { nameOnly: false }).toArray()).filter((c) => !c.name.startsWith('system.'));
    const tables = {};
    const views = {};
    for (const c of colls) {
      if (c.type === 'view') {
        const def = JSON.stringify(plain({ viewOn: c.options?.viewOn, pipeline: c.options?.pipeline }), null, 1);
        views[c.name] = { name: c.name, definition: def, sig: md5(def) };
        tables[c.name] = { name: c.name, type: 'view', engine: 'view', est_rows: 0, data_size: 0, index_size: 0, comment: '', columns: [], indexes: [], pk: [], rowkey: [], rowkey_type: 'none', schema_sig: md5(def) };
        continue;
      }
      const coll = db.collection(c.name);
      const t = { name: c.name, type: 'table', engine: c.type === 'timeseries' ? 'timeseries' : '', est_rows: 0, data_size: 0, index_size: 0, comment: '', columns: [], indexes: [] };
      try { t.est_rows = await coll.estimatedDocumentCount(); } catch { /* ignore */ }
      try {
        t.indexes = (await coll.indexes()).map((ix) => ({ name: ix.name, unique: !!ix.unique || ix.name === '_id_', primary: ix.name === '_id_', columns: Object.keys(ix.key) }));
      } catch { /* ignore */ }
      if (colls.length <= 200) {
        try {
          const [s] = await coll.aggregate([{ $collStats: { storageStats: {} } }]).toArray();
          t.data_size = Number(s?.storageStats?.size) || 0;
          t.index_size = Number(s?.storageStats?.totalIndexSize) || 0;
        } catch { /* not allowed on some tiers */ }
      }
      const sample = await coll.find({}, { sort: { _id: -1 }, limit: config.mongoSample }).toArray();
      t.columns = MongoDriver.inferColumns(sample, t.indexes);
      if (!t.indexes.some((i) => i.primary)) t.indexes.unshift({ name: '_id_', unique: true, primary: true, columns: ['_id'] });
      tables[c.name] = finishTable(t);
    }
    return { tables, fks: [], views, triggers: [] };
  }

  async count(t) { return this.requireDb().collection(t.name).countDocuments({}); }

  async fingerprints(tables) {
    const db = this.requireDb();
    const out = {};
    const names = tables.map((t) => t.name);
    if (this.dbHash !== false && names.length) {
      try {
        const r = await db.command({ dbHash: 1, collections: names });
        for (const n of names) out[n] = r.collections?.[n] ?? null;
        this.dbHash = true;
        return out;
      } catch {
        this.dbHash = false; // Atlas shared tiers / limited roles: fall back to hashing documents
      }
    }
    for (const t of tables) {
      try {
        const coll = db.collection(t.name);
        const size = t.rows ?? t.est_rows ?? 0;
        if (size <= config.rowLimit * 2) {
          const h = [];
          for await (const d of coll.find({})) h.push(JSON.stringify(plain(d)));
          out[t.name] = sha1(h.sort().join('\n'));
        } else {
          const n = await coll.estimatedDocumentCount();
          const [last] = await coll.find({}, { sort: { _id: -1 }, limit: 1 }).toArray();
          out[t.name] = `n:${n}:${last ? sha1(JSON.stringify(plain(last))) : ''}`;
        }
      } catch {
        out[t.name] = null;
      }
    }
    return out;
  }

  async fetchRows(t, cols, { limit = null, desc = false } = {}) {
    const opts = {};
    if (limit !== null) Object.assign(opts, { sort: { _id: desc ? -1 : 1 }, limit: Number(limit) });
    const docs = await this.requireDb().collection(t.name).find({}, opts).toArray();
    const columns = MongoDriver.inferColumns(docs, t.indexes || []);
    const all = [...cols.filter((c) => columns.some((x) => x.name === c)), ...columns.map((c) => c.name).filter((c) => !cols.includes(c))];
    const rows = docs.map((d) => all.map((c) => (c in d ? norm(d[c]) : null)));
    return { cols: all, rows, columns: limit === null ? columns : null };
  }

  async liveState() {
    const out = {};
    for (const c of await this.requireDb().listCollections({}, { nameOnly: false }).toArray()) {
      if (!c.name.startsWith('system.')) out[c.name] = { type: c.type === 'view' ? 'view' : 'table', schema_sig: null };
    }
    return out;
  }
}

function friendly(e) {
  const m = String(e.message || e);
  if (/bad auth|Authentication failed/i.test(m)) return 'Authentication failed — check the username/password in the URL.';
  if (/querySrv|ENOTFOUND/i.test(m)) return 'Cluster host not found — check the mongodb+srv:// URL.';
  if (/ECONNREFUSED/i.test(m)) return 'Cannot reach MongoDB — is it running on that host/port?';
  if (/Server selection timed out|timed out/i.test(m)) return 'Timed out reaching MongoDB. On Atlas, add your IP in Network Access (IP allowlist).';
  return m;
}
