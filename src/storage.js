import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { config } from './config.js';
import { fileSafe, safeId } from './util.js';

/**
 * File based storage (JSON). Layout:
 *   storage/connections.json                       saved connections (secrets encrypted)
 *   storage/snapshots/{conn}/{snap}/meta.json      full schema + per-table stats
 *   storage/snapshots/{conn}/{snap}/summary.json   small summary for the history list
 *   storage/snapshots/{conn}/{snap}/rows/*.json.gz captured rows (only when a table changed)
 *   storage/snapshots/{conn}/diffs/{a}__{b}.json   cached comparison reports
 */
export class Storage {
  constructor(root = config.storage) {
    this.root = root;
    fs.mkdirSync(path.join(root, 'snapshots'), { recursive: true });
    // In case the folder sits inside a web root (XAMPP/Laragon www): keep Apache out.
    const ht = path.join(root, '.htaccess');
    if (!fs.existsSync(ht)) fs.writeFileSync(ht, 'Require all denied\n');
    this.key = this.loadKey();
  }

  loadKey() {
    const f = path.join(this.root, '.secret');
    if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
  }

  encrypt(obj) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }

  decrypt(enc) {
    try {
      const raw = Buffer.from(enc || '', 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
    } catch {
      return {};
    }
  }

  readJson(file, fallback = null) {
    if (!fs.existsSync(file)) return fallback;
    let raw = fs.readFileSync(file);
    if (file.endsWith('.gz')) raw = zlib.gunzipSync(raw);
    try { return JSON.parse(raw.toString('utf8')); } catch { return fallback; }
  }

  writeJson(file, data, gzip = false) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let out = JSON.stringify(data, null, gzip ? 0 : 2);
    if (gzip) out = zlib.gzipSync(out, { level: 6 });
    const tmp = `${file}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, file);
  }

  /* ---------------------------------------------------------- connections */

  connFile() { return path.join(this.root, 'connections.json'); }
  connections() { return this.readJson(this.connFile(), []); }

  publicConnections() {
    return this.connections()
      .map((c) => {
        const { secret_enc, ...pub } = c;
        const sums = this.summaries(c.id);
        return { ...pub, folders: normalizeFolders(c.folders, c.project_path), snapshots: sums.length, last_snapshot: sums[0] || null };
      })
      .sort((a, b) => String(b.last_used || '').localeCompare(String(a.last_used || '')));
  }

  /** Connection including decrypted secrets (password / url). */
  connection(id) {
    const c = this.connections().find((x) => x.id === id);
    if (!c) throw new Error('Connection not found');
    const { secret_enc, ...rest } = c;
    return { ...rest, folders: normalizeFolders(c.folders, c.project_path), ...this.decrypt(secret_enc) };
  }

  /** Replace only the project folders of a saved connection. */
  saveFolders(id, folders) {
    const all = this.connections();
    const c = all.find((x) => x.id === id);
    if (!c) throw new Error('Connection not found');
    c.folders = normalizeFolders(folders);
    c.project_path = c.folders[0]?.path || '';
    this.writeJson(this.connFile(), all);
    return c.folders;
  }

  /* ----------------------------------------------------------- workspace */
  // Monitor settings (log files, proxies, queue sources) live next to, not inside,
  // the connection so the database part stays untouched.

  workspaceFile(id) { return path.join(this.root, 'workspaces', `${safeId(id)}.json`); }

  workspace(id) {
    const w = this.readJson(this.workspaceFile(id), {});
    const secrets = this.decrypt(w.secret_enc);
    return {
      logs: w.logs || [],
      inbound: { enabled: false, target: '', port: 0, ...(w.inbound || {}) },
      outbound: { enabled: false, port: 0, ...(w.outbound || {}) },
      queues: { redis_url: secrets.redis_url || '', rabbit_url: secrets.rabbit_url || '' },
    };
  }

  saveWorkspace(id, ws) {
    const { queues, ...rest } = ws;
    this.writeJson(this.workspaceFile(id), { ...rest, secret_enc: this.encrypt({ redis_url: queues?.redis_url || '', rabbit_url: queues?.rabbit_url || '' }) });
  }

  deleteWorkspace(id) { fs.rmSync(this.workspaceFile(id), { force: true }); }

  saveConnection(input) {
    const all = this.connections();
    const now = new Date().toISOString();
    const idx = all.findIndex((c) => c.id === input.id);
    const id = idx >= 0 ? input.id : 'c' + crypto.randomBytes(4).toString('hex');
    const record = {
      id,
      name: String(input.name || '').trim() || input.database || 'database',
      driver: input.driver,
      mode: input.mode,
      host: input.host || '',
      port: input.port || '',
      user: input.user || '',
      database: input.database || '',
      file: input.file || '',
      ssl: !!input.ssl,
      url_display: input.url ? maskUrl(input.url) : '',
      folders: normalizeFolders(input.folders, input.project_path),
      project_path: normalizeFolders(input.folders, input.project_path)[0]?.path || '',
      color: /^#[0-9a-f]{6}$/i.test(input.color || '') ? input.color : '#8b5cf6',
      created_at: idx >= 0 ? all[idx].created_at : now,
      last_used: now,
      secret_enc: this.encrypt({ password: input.password || '', url: input.url || '' }),
    };
    if (idx >= 0) all[idx] = record; else all.push(record);
    this.writeJson(this.connFile(), all);
    const { secret_enc, ...pub } = record;
    return pub;
  }

  touchConnection(id) {
    const all = this.connections();
    const c = all.find((x) => x.id === id);
    if (c) { c.last_used = new Date().toISOString(); this.writeJson(this.connFile(), all); }
  }

  deleteConnection(id) {
    safeId(id);
    this.writeJson(this.connFile(), this.connections().filter((c) => c.id !== id));
    fs.rmSync(this.connDir(id), { recursive: true, force: true });
    this.deleteWorkspace(id);
  }

  /* ------------------------------------------------------------ snapshots */

  connDir(conn) { return path.join(this.root, 'snapshots', safeId(conn)); }
  snapDir(conn, snap) { return path.join(this.connDir(conn), safeId(snap)); }

  meta(conn, snap) {
    const m = this.readJson(path.join(this.snapDir(conn, snap), 'meta.json'));
    if (!m) throw new Error(`Snapshot ${snap} not found`);
    return m;
  }
  saveMeta(conn, meta) { this.writeJson(path.join(this.snapDir(conn, meta.id), 'meta.json'), meta); }
  saveSummary(conn, s) { this.writeJson(path.join(this.snapDir(conn, s.id), 'summary.json'), s); }

  summaries(conn) {
    const dir = this.connDir(conn);
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const d of fs.readdirSync(dir)) {
      const s = this.readJson(path.join(dir, d, 'summary.json'));
      if (s) out.push(s);
    }
    return out.sort((a, b) => b.id.localeCompare(a.id));
  }

  updateSummary(conn, snap, patch) {
    const file = path.join(this.snapDir(conn, snap), 'summary.json');
    const s = this.readJson(file);
    if (!s) throw new Error('Snapshot not found');
    Object.assign(s, patch);
    this.writeJson(file, s);
    const meta = this.meta(conn, snap);
    Object.assign(meta, patch);
    if (meta.summary) Object.assign(meta.summary, patch);
    this.saveMeta(conn, meta);
    return s;
  }

  latestComplete(conn, exclude = null) {
    const s = this.summaries(conn).find((x) => x.status === 'complete' && x.id !== exclude);
    return s ? this.meta(conn, s.id) : null;
  }

  dataPath(conn, ref, file) { return path.join(this.snapDir(conn, ref), 'rows', `${file}.json.gz`); }

  loadRows(conn, table) {
    if (!table?.data_ref || !table?.data_file) return null;
    return this.readJson(this.dataPath(conn, table.data_ref, table.data_file));
  }

  diffPath(conn, from, to) { return path.join(this.connDir(conn), 'diffs', `${safeId(from)}__${safeId(to)}.json`); }
  diffRowsPath(conn, from, to, table) { return path.join(this.connDir(conn), 'diffs', `${safeId(from)}__${safeId(to)}`, `${fileSafe(table)}.json.gz`); }

  /**
   * Later snapshots may share row files with this one (unchanged tables are not
   * copied), so hand those files over before deleting.
   */
  deleteSnapshot(conn, snap) {
    const target = this.meta(conn, snap);
    const others = this.summaries(conn)
      .filter((s) => s.id !== snap && fs.existsSync(path.join(this.snapDir(conn, s.id), 'meta.json')))
      .map((s) => this.meta(conn, s.id))
      .sort((a, b) => a.id.localeCompare(b.id));
    const dirty = new Set();
    for (const [name, t] of Object.entries(target.tables)) {
      if (t.data_ref !== snap) continue;
      let heir = null;
      for (const m of others) {
        const mt = m.tables[name];
        if (mt && mt.data_ref === snap && mt.data_file === t.data_file) {
          if (!heir) {
            heir = m.id;
            const src = this.dataPath(conn, snap, t.data_file);
            const dst = this.dataPath(conn, heir, t.data_file);
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            if (fs.existsSync(src)) fs.renameSync(src, dst);
          }
          mt.data_ref = heir;
          dirty.add(m);
        }
      }
    }
    for (const m of dirty) this.saveMeta(conn, m);
    fs.rmSync(this.snapDir(conn, snap), { recursive: true, force: true });
    const diffs = path.join(this.connDir(conn), 'diffs');
    if (fs.existsSync(diffs)) {
      for (const f of fs.readdirSync(diffs)) if (f.includes(snap)) fs.rmSync(path.join(diffs, f), { recursive: true, force: true });
    }
  }
}

/** [{path, label}] from new-style folders or the old single project_path. */
export function normalizeFolders(folders, legacyPath = '') {
  let list = Array.isArray(folders) ? folders : [];
  if (!list.length && legacyPath) list = [{ path: legacyPath }];
  const seen = new Set();
  return list
    .map((f) => ({ path: String(f?.path || '').trim(), label: String(f?.label || '').trim() }))
    .filter((f) => f.path && !seen.has(f.path.toLowerCase()) && seen.add(f.path.toLowerCase()))
    .map((f) => ({ path: f.path, label: f.label || path.basename(f.path) || f.path }))
    .slice(0, 20);
}

export function maskUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '•••';
    return u.toString();
  } catch {
    return String(url).replace(/(\/\/[^:/@]+:)[^@]+@/, '$1•••@');
  }
}
