import { md5 } from '../util.js';

/*
 * Watched queries: the user saves a few queries, WhatChanged re-runs them and shows
 * how their output changes. User-written SQL is only ever run read-only:
 *   1. checkReadOnly() rejects anything that isn't a single read statement,
 *   2. drivers run it in a READ ONLY transaction (or SQLite's read-only handle),
 *   3. and roll that transaction back afterwards.
 */

export const QUERY_ROW_LIMIT = 1000;
export const QUERY_TIMEOUT_MS = 10000;

const READ_START = /^(select|with|show|describe|desc|explain|values|table|pragma)\b/i;
// The statement must already start with a read keyword; these catch writes hidden inside
// one (WITH x AS (DELETE …), SELECT … INTO, EXPLAIN ANALYZE UPDATE …). Kept short so
// ordinary column names (comment, handler, type…) are never blocked.
const WRITE_WORDS = /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|exec|execute|into)\b/i;

/** Remove comments and quoted text so keywords inside them don't count. */
function stripSql(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(--|#)[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.|"")*"/g, '""')
    .replace(/`(?:[^`]|``)*`/g, '``')
    .replace(/\[[^\]]*\]/g, '[]');
}

/** Throws a friendly error unless the SQL is one read-only statement. */
export function checkReadOnly(sql) {
  const text = String(sql || '').trim();
  if (!text) throw new Error('Write a query first.');
  const bare = stripSql(text).trim().replace(/;\s*$/, '');
  if (bare.includes(';')) throw new Error('Only one statement per query — remove the extra “;”.');
  if (!READ_START.test(bare)) throw new Error('Only read queries can be watched (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN…). WhatChanged never writes to your database.');
  const m = WRITE_WORDS.exec(bare);
  if (m) throw new Error(`“${m[1].toUpperCase()}” is not allowed in a watched query — they are read-only.`);
  if (/\bfor\s+(update|share)\b|\block\s+in\s+share\s+mode\b/i.test(bare)) throw new Error('Locking reads (FOR UPDATE / FOR SHARE) are not allowed.');
  return text.replace(/;\s*$/, '');
}

/**
 * MongoDB queries are JSON (Extended JSON, so {"$oid": "..."} and {"$date": "..."} work):
 *   {"collection": "orders", "filter": {"status": "paid"}, "sort": {"_id": -1}, "limit": 20}
 *   {"collection": "orders", "pipeline": [{"$group": {"_id": "$status", "n": {"$sum": 1}}}]}
 */
export function parseMongoQuery(text, EJSON) {
  let q;
  try { q = EJSON.parse(String(text || '').trim(), { relaxed: true }); } catch (e) {
    throw new Error('MongoDB queries are JSON, e.g. {"collection": "orders", "filter": {"status": "paid"}, "limit": 20} — ' + e.message);
  }
  if (!q || typeof q !== 'object' || !q.collection) throw new Error('Add "collection": "<name>" to the query.');
  if (q.pipeline) {
    if (!Array.isArray(q.pipeline)) throw new Error('"pipeline" must be an array of stages.');
    if (JSON.stringify(q.pipeline).match(/"\$(out|merge)"/)) throw new Error('$out / $merge write data and are not allowed in a watched query.');
  }
  return q;
}

/** Give duplicate column names (e.g. two "id" from a JOIN) a suffix so rows can be keyed by name. */
export function uniqueCols(cols) {
  const seen = {};
  return cols.map((c) => {
    const name = String(c || '?column?');
    seen[name] = (seen[name] || 0) + 1;
    return seen[name] === 1 ? name : `${name} (${seen[name]})`;
  });
}

export const resultSig = (r) => md5(JSON.stringify([r.cols, r.rows]));

/**
 * Compare two results. Rows are matched by a key column (given, or guessed:
 * id / _id / uuid / code / first unique column), a single-row result is compared
 * cell by cell, otherwise by position when both have the same size, otherwise by content.
 */
export function diffResults(a, b, keyCol = '') {
  const out = { added: [], removed: [], changed: [], key: null, mode: '', colsAdded: [], colsRemoved: [] };
  if (!a || !b) return out;
  out.colsAdded = b.cols.filter((c) => !a.cols.includes(c));
  out.colsRemoved = a.cols.filter((c) => !b.cols.includes(c));
  const common = b.cols.filter((c) => a.cols.includes(c));
  const ia = Object.fromEntries(a.cols.map((c, i) => [c, i]));
  const ib = Object.fromEntries(b.cols.map((c, i) => [c, i]));
  const uniqueIn = (r, col) => new Set(r.rows.map((x) => x[r.cols.indexOf(col)])).size === r.rows.length;

  let key = keyCol && common.includes(keyCol) ? keyCol : '';
  if (!key) {
    const guess = ['id', '_id', 'uuid', 'ID', 'Id', 'key', 'code', 'slug', 'email'].find((c) => common.includes(c));
    if (guess && uniqueIn(a, guess) && uniqueIn(b, guess)) key = guess;
  }
  if (!key && common.length > 1 && uniqueIn(a, common[0]) && uniqueIn(b, common[0]) && a.rows.length && b.rows.length) key = common[0];

  let keysA;
  let keysB;
  if (key) {
    out.mode = 'key';
    keysA = a.rows.map((r) => String(r[ia[key]]));
    keysB = b.rows.map((r) => String(r[ib[key]]));
  } else if (a.rows.length === b.rows.length) {
    out.mode = a.rows.length === 1 ? 'single' : 'position';
    keysA = a.rows.map((_, i) => '#' + (i + 1));
    keysB = b.rows.map((_, i) => '#' + (i + 1));
  } else {
    out.mode = 'content';
    const count = (rows, idx) => { const seen = {}; return rows.map((r) => { const h = md5(JSON.stringify(common.map((c) => r[idx[c]]))); seen[h] = (seen[h] || 0) + 1; return `${h}#${seen[h]}`; }); };
    keysA = count(a.rows, ia);
    keysB = count(b.rows, ib);
  }
  out.key = key || null;
  out.keysB = keysB; // key of every row of the new result, in order (lets the UI mark rows)

  const mapA = new Map(keysA.map((k, i) => [k, a.rows[i]]));
  const mapB = new Map(keysB.map((k, i) => [k, b.rows[i]]));
  for (const [k, rb] of mapB) {
    const ra = mapA.get(k);
    if (!ra) { out.added.push({ key: k, row: rb }); continue; }
    const changes = {};
    for (const c of common) if (ra[ia[c]] !== rb[ib[c]]) changes[c] = [ra[ia[c]], rb[ib[c]]];
    if (Object.keys(changes).length) out.changed.push({ key: k, changes });
  }
  for (const [k, ra] of mapA) if (!mapB.has(k)) out.removed.push({ key: k, row: ra });
  return out;
}

export function summarize(d) {
  if (!d) return '';
  const cells = d.changed.reduce((n, c) => n + Object.keys(c.changes).length, 0);
  const parts = [];
  if (d.added.length) parts.push(`+${d.added.length} row${d.added.length > 1 ? 's' : ''}`);
  if (d.removed.length) parts.push(`−${d.removed.length} row${d.removed.length > 1 ? 's' : ''}`);
  if (cells) parts.push(`${cells} cell${cells > 1 ? 's' : ''} changed`);
  if (d.colsAdded.length || d.colsRemoved.length) parts.push('columns changed');
  return parts.join(' · ');
}

export const isEmptyDiff = (d) => !d || (!d.added.length && !d.removed.length && !d.changed.length && !d.colsAdded.length && !d.colsRemoved.length);
