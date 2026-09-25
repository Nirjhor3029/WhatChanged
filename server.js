#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { config, ROOT } from './src/config.js';
import { Storage } from './src/storage.js';
import { Snapshotter } from './src/snapshotter.js';
import { Differ, PAGE, pageOut } from './src/differ.js';
import { buildRelations } from './src/relations.js';
import { scanCode } from './src/codescanner.js';
import { DRIVERS, detectDriver, dropDriver, getDriver, openDriver } from './src/drivers/index.js';
import { cut, safeId } from './src/util.js';

const store = new Storage();
const snapper = new Snapshotter(store);
const TOKEN = crypto.randomBytes(24).toString('hex');
// Full change lists of live peeks, so the UI can page through them (kept 10 minutes).
const peekCache = new Map();
setInterval(() => { for (const [k, v] of peekCache) if (Date.now() - v.at > 600000) peekCache.delete(k); }, 60000).unref();
const PUBLIC = path.join(ROOT, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

/** Connection settings from the form; reuse stored secrets when editing and the field was left empty. */
function connFromInput(b) {
  const c = {
    id: String(b.id || ''),
    name: String(b.name || ''),
    driver: String(b.driver || ''),
    mode: b.mode === 'url' ? 'url' : 'fields',
    url: String(b.url || '').trim(),
    host: String(b.host || '').trim(),
    port: String(b.port || '').trim(),
    user: String(b.user || ''),
    password: String(b.password ?? ''),
    database: String(b.database || '').trim(),
    file: String(b.file || '').trim(),
    ssl: !!b.ssl,
    project_path: String(b.project_path || '').trim(),
    color: String(b.color || ''),
  };
  if (c.mode === 'url' && !c.driver) c.driver = detectDriver(c.url) || '';
  if (!DRIVERS[c.driver]) throw new Error('Choose a database type.');
  if (c.id) {
    let old = null;
    try { old = store.connection(safeId(c.id)); } catch { /* new */ }
    if (old) {
      if (!c.password && !b.clear_password) c.password = old.password || '';
      if (c.mode === 'url' && (!c.url || c.url.includes('•••'))) c.url = old.url || '';
    }
  }
  return c;
}

const actions = {
  'meta': async () => ({ drivers: Object.fromEntries(Object.entries(DRIVERS).map(([k, d]) => [k, { label: d.label, port: d.port, user: d.user }])), version: '1.0.0' }),
  'conn.list': async () => store.publicConnections(),

  'conn.databases': async (b) => {
    const c = connFromInput(b);
    const d = await openDriver(c, c.driver === 'sqlite' ? undefined : c.driver === 'mongodb' ? c.database : '');
    try {
      return { databases: await d.listDatabases(), version: await d.version(), current: d.database || '' };
    } finally { await d.close(); }
  },

  'conn.test': async (b) => {
    const c = connFromInput(b);
    const d = await openDriver(c);
    try {
      const schema = await d.schema();
      return { version: await d.version(), database: d.database, tables: Object.values(schema.tables).filter((t) => t.type === 'table').length };
    } finally { await d.close(); }
  },

  'conn.save': async (b) => {
    const c = connFromInput(b);
    const d = await openDriver(c);
    try {
      if (!d.database) throw new Error('Pick a database.');
      if (c.driver !== 'sqlite' && !c.database) c.database = d.database;
      if (c.driver === 'sqlite' && c.mode === 'fields') c.database = d.database;
    } finally { await d.close(); }
    if (c.project_path && !fs.existsSync(c.project_path)) throw new Error('Project folder not found: ' + c.project_path);
    if (c.id) dropDriver(c.id);
    return store.saveConnection(c);
  },

  'conn.delete': async (b) => { dropDriver(b.conn); store.deleteConnection(safeId(b.conn)); return null; },

  'snap.begin': async (b, conn) => snapper.begin(conn(), cut(String(b.label || '').trim(), 80)),
  'snap.capture': async (b, conn) => snapper.capture(conn(), safeId(b.snap), (b.tables || []).filter((x) => typeof x === 'string')),
  'snap.finish': async (b, conn) => snapper.finish(conn(), safeId(b.snap)),
  'snap.list': async (b, conn) => store.summaries(conn().id),
  'snap.meta': async (b, conn) => {
    const meta = store.meta(conn().id, safeId(b.snap));
    meta.edges = buildRelations(meta);
    for (const v of Object.values(meta.views)) v.definition = cut(v.definition, 3000);
    return meta;
  },
  'snap.rename': async (b, conn) => store.updateSummary(conn().id, safeId(b.snap), { label: cut(String(b.label || '').trim(), 80) || 'Snapshot' }),
  'snap.delete': async (b, conn) => { store.deleteSnapshot(conn().id, safeId(b.snap)); return null; },

  'watch': async (b, conn) => snapper.watch(conn(), safeId(b.base)),
  'diff': async (b, conn) => new Differ(store, conn().id).diff(safeId(b.from), safeId(b.to), !!b.fresh),

  'rows': async (b, conn) => {
    const c = conn();
    const d = await getDriver(c);
    const meta = b.snap ? store.meta(c.id, safeId(b.snap)) : null;
    let t = meta?.tables?.[b.table];
    if (!t) t = (await d.schema()).tables[b.table];
    if (!t) throw new Error('Table not found');
    const limit = Math.max(1, Math.min(200, Number(b.limit) || 30));
    const offset = Math.max(0, Number(b.offset) || 0);
    const res = await d.fetchRows(t, t.columns.map((x) => x.name), { key: t.rowkey, limit, offset, desc: true });
    // Counting a huge table on every page is slow: only count when asked (first page).
    return { columns: res.cols, key: t.rowkey, rows: res.rows, total: b.count === false ? null : await d.count(t) };
  },

  'diff.rows': async (b, conn) => {
    const size = Math.max(1, Math.min(500, Number(b.size) || PAGE));
    return new Differ(store, conn().id).rowsPage(safeId(b.from), safeId(b.to), String(b.table), String(b.kind), Math.max(0, Number(b.page) || 0), size);
  },

  'peek': async (b, conn) => {
    const c = conn();
    const names = (b.tables || []).filter((x) => typeof x === 'string').slice(0, 20);
    const res = await snapper.peek(c, safeId(b.base), names);
    for (const [name, entry] of Object.entries(res)) {
      peekCache.delete(`${c.id}|${b.base}|${name}`);
      if (!entry || entry.error) continue;
      pageOut(entry, (full) => peekCache.set(`${c.id}|${b.base}|${name}`, { full, at: Date.now() }));
    }
    return res;
  },

  'peek.rows': async (b, conn) => {
    const c = conn();
    const key = `${c.id}|${b.base}|${b.table}`;
    let hit = peekCache.get(key);
    if (!hit) {
      // cache expired: compute again
      const res = await snapper.peek(c, safeId(b.base), [String(b.table)]);
      pageOut(res[b.table] || { data: null }, (full) => peekCache.set(key, (hit = { full, at: Date.now() })));
    }
    const list = hit?.full?.[b.kind] || [];
    const size = Math.max(1, Math.min(500, Number(b.size) || PAGE));
    const page = Math.max(0, Number(b.page) || 0);
    return { total: list.length, items: list.slice(page * size, page * size + size) };
  },

  'code': async (b, conn) => {
    const c = conn();
    if (!c.project_path) return null;
    return scanCode(c.project_path, (b.tables || []).filter((x) => typeof x === 'string').slice(0, 60));
  },
};

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...extra,
  });
  res.end(body);
}

function hostAllowed(req) {
  // Blocks DNS-rebinding: only answer to localhost-style Host headers.
  const h = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return ['localhost', '127.0.0.1', '::1'].includes(h) || h.endsWith('.localhost') || process.env.DBC_ALLOW_HOST === h;
}

const server = http.createServer(async (req, res) => {
  if (!hostAllowed(req)) return send(res, 403, 'Forbidden host', 'text/plain');
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/')) {
    if (req.method !== 'POST') return send(res, 405, JSON.stringify({ ok: false, error: 'POST only' }));
    if (req.headers['x-dbc-token'] !== TOKEN) return send(res, 403, JSON.stringify({ ok: false, error: 'Session expired — reload the page.' }));
    const action = decodeURIComponent(url.pathname.slice(5));
    const fn = actions[action];
    if (!fn) return send(res, 404, JSON.stringify({ ok: false, error: 'Unknown action' }));
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 5_000_000) return send(res, 413, JSON.stringify({ ok: false, error: 'Too large' }));
    }
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, JSON.stringify({ ok: false, error: 'Bad JSON' })); }
    const conn = () => store.connection(safeId(String(body.conn || '')));
    try {
      const data = await fn(body, conn);
      return send(res, 200, JSON.stringify({ ok: true, data }));
    } catch (e) {
      if (process.env.DBC_DEBUG) console.error(e);
      return send(res, 400, JSON.stringify({ ok: false, error: e.message || String(e) }));
    }
  }

  // static files
  let file = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  file = path.normalize(path.join(PUBLIC, file));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
  let body = fs.readFileSync(file);
  if (file.endsWith('index.html')) body = body.toString('utf8').replace('__DBC_TOKEN__', TOKEN);
  send(res, 200, body, TYPES[path.extname(file)] || 'application/octet-stream', {
    ...(file.endsWith('.html') ? { 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; img-src 'self' data:; script-src 'self'; connect-src 'self'; frame-ancestors 'none'" } : {}),
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  Port ${config.port} is busy. Start on another port:  set PORT=4488 && npm start\n`);
    process.exit(1);
  }
  throw e;
});

server.listen(config.port, config.host, () => {
  const link = `http://localhost:${config.port}`;
  console.log(`\n  ◆ DB Checker is running → ${link}\n    data folder: ${config.storage}\n    press Ctrl+C to stop\n`);
  if (process.argv.includes('--open')) {
    const cmd = process.platform === 'win32' ? `start "" "${link}"` : process.platform === 'darwin' ? `open "${link}"` : `xdg-open "${link}"`;
    exec(cmd, () => {});
  }
});
