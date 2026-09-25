import crypto from 'node:crypto';

export const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
export const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

export function snapshotId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
}

export function safeId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid id');
  return id;
}

export function fileSafe(name) {
  return String(name).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60) + '-' + md5(String(name)).slice(0, 6);
}

export function bytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let f = Number(n) || 0;
  while (f >= 1024 && i < u.length - 1) { f /= 1024; i++; }
  return (i === 0 ? String(f) : f.toFixed(1)) + ' ' + u[i];
}

export function cut(s, len) {
  s = String(s);
  return s.length <= len ? s : s.slice(0, len) + '…';
}

const isObjectId = (v) => v && typeof v === 'object' && (v._bsontype === 'ObjectId' || v._bsontype === 'ObjectID');

/** Make nested values (BSON, Dates, Buffers…) JSON friendly with stable, readable output. */
export function plain(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v !== 'object') return v;
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString();
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return `⟨binary ${bytes(v.length)} · ${sha1(Buffer.from(v)).slice(0, 10)}⟩`;
  if (isObjectId(v)) return v.toHexString();
  if (v._bsontype) {
    if (v._bsontype === 'Binary') return `⟨binary ${bytes(v.length())} · ${sha1(Buffer.from(v.buffer)).slice(0, 10)}⟩`;
    return v.toString();
  }
  if (Array.isArray(v)) return v.map(plain);
  const o = {};
  for (const k of Object.keys(v)) o[k] = plain(v[k]);
  return o;
}

/**
 * Normalise any DB value to string|null so snapshots stay small and comparisons
 * are cheap. Binary and very long values become a short marker that still carries
 * a hash, so changes are detected.
 */
export function norm(v) {
  if (v === null || v === undefined) return null;
  let s;
  if (typeof v === 'string') s = v;
  else if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') s = String(v);
  else {
    const p = plain(v);
    s = typeof p === 'string' ? p : JSON.stringify(p);
  }
  if (s.length > 1500) return s.slice(0, 240) + `… ⟨${bytes(Buffer.byteLength(s))} · ${sha1(s).slice(0, 10)}⟩`;
  return s;
}

/** A readable type name for any JS/BSON value (used for MongoDB field inference). */
export function typeOf(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  if (v instanceof Date) return 'date';
  if (isObjectId(v)) return 'objectId';
  if (Buffer.isBuffer(v)) return 'binary';
  if (typeof v === 'object') {
    if (v._bsontype) return v._bsontype.toLowerCase();
    return 'object';
  }
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double';
  return typeof v;
}

export function keyBy(list, field) {
  const o = {};
  for (const r of list) o[r[field]] = r;
  return o;
}

export function columnSig(columns) {
  return md5(columns.map((c) => `${c.name} ${c.type} ${c.nullable ? 'NULL' : 'NOT NULL'} ${c.default ?? '∅'} ${c.extra || ''}`).join('\n'));
}

/** Pick a row key: primary key, else first unique index whose columns are NOT NULL. */
export function finishTable(t) {
  const nullable = Object.fromEntries(t.columns.map((c) => [c.name, c.nullable]));
  let pk = [];
  let unique = null;
  for (const ix of t.indexes) {
    if (ix.primary) pk = ix.columns;
    else if (!unique && ix.unique && ix.columns.length && ix.columns.every((c) => nullable[c] === false)) unique = ix.columns;
  }
  t.pk = pk;
  t.rowkey = pk.length ? pk : unique || [];
  t.rowkey_type = pk.length ? 'primary' : unique ? 'unique' : 'none';
  t.schema_sig = columnSig(t.columns);
  return t;
}
