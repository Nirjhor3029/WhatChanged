import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isContinuation, levelOf } from './parse.js';

/* ================================================================ discovery */

// Skipped while searching for logs (unlike the code scanner, storage/ and var/ are searched).
const SKIP = new Set(['node_modules', 'vendor', '.git', '.svn', '.hg', '.idea', '.vscode', 'bower_components', '__pycache__',
  '.venv', 'venv', '.next', '.nuxt', '.cache', 'coverage', '.gradle', '.m2', 'obj', 'packages']);
const LOG_DIR = /^(logs?|storage|var|tmp|temp|output|out|runtime|writable|\.pm2)$/i;
const LOG_NAME = /(\.log$|\.log[._-]\d|[._-]log[._-]?\d{4}|\.logs$|^nohup\.out$|[._-](error|err|out|access|debug|output)\.(txt|out)$|\.err$|^(npm-debug|yarn-error|lerna-debug|pnpm-debug)\.log)/i;
const TEXTISH = /\.(txt|out|err|jsonl|ndjson)$|^[^.]+$/i;
const LOGLIKE = /^\s*(\[?\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}|\[\w{3} \w{3} \d{1,2} \d{2}:\d{2}|\d{1,3}(\.\d{1,3}){3} - |\{"(time|timestamp|level|msg|@timestamp)"|(ERROR|WARN|INFO|DEBUG)\b)/;

/**
 * Find log files in the project folders (by name and folder), optionally by
 * sniffing file contents ("deep"), plus well-known system places.
 */
export function discoverLogs(folders, { deep = false, system = true } = {}) {
  const found = new Map();
  const add = (file, source, reason, base = null) => {
    const key = path.resolve(file).toLowerCase();
    if (found.has(key)) return;
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) return;
      const rel = base ? path.relative(base, file).replace(/\\/g, '/') : path.resolve(file);
      found.set(key, { path: path.resolve(file), rel, source, reason, size: st.size, mtime: st.mtime.toISOString() });
    } catch { /* unreadable */ }
  };

  for (const f of folders) {
    let visited = 0;
    const walk = (dir, depth, inLogDir) => {
      if (depth > 9 || visited > 80000) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        visited++;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP.has(e.name)) walk(full, depth + 1, inLogDir || LOG_DIR.test(e.name));
        } else if (LOG_NAME.test(e.name)) {
          add(full, f.label, 'log file name', f.path);
        } else if (inLogDir && TEXTISH.test(e.name)) {
          add(full, f.label, 'inside a log folder', f.path);
        } else if (deep && TEXTISH.test(e.name) && looksLikeLog(full)) {
          add(full, f.label, 'content looks like a log', f.path);
        }
      }
    };
    if (fs.existsSync(f.path)) walk(path.resolve(f.path), 0, false);
  }

  if (system) {
    for (const [dir, label] of systemLogDirs()) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries.slice(0, 300)) {
        const full = path.join(dir, e.name);
        if (e.isFile() && (LOG_NAME.test(e.name) || /\.(err|txt)$/.test(e.name))) add(full, label, 'system log');
        else if (e.isDirectory() && /log/i.test(e.name)) {
          try {
            for (const x of fs.readdirSync(full, { withFileTypes: true }).slice(0, 100)) {
              if (x.isFile() && LOG_NAME.test(x.name)) add(path.join(full, x.name), label, 'system log');
            }
          } catch { /* ignore */ }
        }
      }
    }
  }

  const list = [...found.values()]
    .map((c) => ({ ...c, kind: kindOf(c.path), preview: lastLine(c.path) }))
    .sort((a, b) => b.mtime.localeCompare(a.mtime))
    .slice(0, 400);
  return list;
}

function looksLikeLog(file) {
  try {
    const st = fs.statSync(file);
    if (st.size < 40 || st.size > 200 * 1024 * 1024) return false;
    const buf = Buffer.alloc(Math.min(4096, st.size));
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    if (buf.includes(0)) return false; // binary
    return buf.toString('utf8').split(/\r?\n/).filter((l) => LOGLIKE.test(l)).length >= 3;
  } catch {
    return false;
  }
}

/** Places where servers and process managers keep their logs, for this OS. */
function systemLogDirs() {
  const dirs = [];
  const home = os.homedir();
  const push = (d, label) => { if (d && fs.existsSync(d)) dirs.push([d, label]); };
  push(path.join(home, '.pm2', 'logs'), 'PM2');
  push(path.join(home, '.npm', '_logs'), 'npm');
  // Laragon / XAMPP / WAMP style bundles: look upwards from here for a bin/ folder with servers.
  const roots = new Set();
  let cur = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(cur, 'bin', 'apache')) || fs.existsSync(path.join(cur, 'bin', 'nginx')) || fs.existsSync(path.join(cur, 'apache', 'logs'))) roots.add(cur);
    cur = path.dirname(cur);
  }
  if (process.platform === 'win32') for (const r of ['C:\\xampp', 'C:\\laragon', 'C:\\wamp64', 'C:\\wamp']) if (fs.existsSync(r)) roots.add(r);
  for (const r of roots) {
    const name = path.basename(r);
    for (const srv of ['apache', 'nginx', 'php', 'mysql', 'redis', 'mariadb']) {
      const base = path.join(r, 'bin', srv);
      try { for (const v of fs.readdirSync(base)) { push(path.join(base, v, 'logs'), `${name} ${srv}`); push(path.join(base, v, 'data'), `${name} ${srv}`); } } catch { /* ignore */ }
    }
    push(path.join(r, 'apache', 'logs'), `${name} apache`);
    push(path.join(r, 'php', 'logs'), `${name} php`);
    push(path.join(r, 'mysql', 'data'), `${name} mysql`);
    push(path.join(r, 'tmp'), `${name} tmp`);
    push(path.join(r, 'logs'), name);
    try { for (const d of fs.readdirSync(path.join(r, 'data'))) push(path.join(r, 'data', d), `${name} ${d}`); } catch { /* ignore */ }
  }
  if (process.platform !== 'win32') {
    for (const d of ['/var/log/nginx', '/var/log/apache2', '/var/log/httpd', '/var/log/php', '/var/log/mysql', '/var/log/redis',
      '/var/log/supervisor', '/usr/local/var/log', '/opt/homebrew/var/log', '/usr/local/var/log/nginx', '/opt/homebrew/var/log/nginx']) push(d, 'system');
    try { for (const d of fs.readdirSync('/var/log')) if (/^php/.test(d)) push(path.join('/var/log', d), 'system php'); } catch { /* ignore */ }
  }
  return dirs;
}

export function kindOf(p) {
  const s = p.replace(/\\/g, '/').toLowerCase();
  const rules = [
    [/storage\/logs\/laravel/, 'Laravel'], [/storage\/logs\//, 'Laravel / PHP app'], [/var\/log\/(dev|prod|test)\.log/, 'Symfony'],
    [/\/log\/(development|production|test|staging)\.log/, 'Rails'], [/\.pm2\/logs/, 'PM2 (Node)'], [/npm-debug|yarn-error|pnpm-debug|\.npm\/_logs/, 'npm / yarn'],
    [/access[._-]?log|access\.log|_access/, 'HTTP access log'], [/apache|httpd/, 'Apache'], [/nginx/, 'Nginx'],
    [/php_?errors?|php.*\.log/, 'PHP errors'], [/mysql|mariadb|\.err$/, 'MySQL'], [/redis/, 'Redis'], [/celery/, 'Celery'],
    [/sidekiq/, 'Sidekiq'], [/django/, 'Django'], [/spring|catalina|tomcat/, 'Java'], [/supervisor/, 'Supervisor'], [/runtime\/logs|writable\/logs/, 'PHP framework'],
  ];
  for (const [re, k] of rules) if (re.test(s)) return k;
  return 'log';
}

function lastLine(file) {
  try {
    const st = fs.statSync(file);
    const len = Math.min(2048, st.size);
    if (!len) return '';
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim());
    return (lines.pop() || '').slice(0, 200);
  } catch {
    return '';
  }
}

/* ================================================================ tail -f */

const MAX_LINE = 8000;

/**
 * Follows one file like `tail -f`: sends the last lines first, then every
 * appended line. Handles truncation / rotation (file got smaller or replaced).
 */
export class Tail {
  constructor(file, onLines, { initial = 300, interval = 700 } = {}) {
    this.file = file;
    this.onLines = onLines;
    this.initial = initial;
    this.interval = interval;
    this.pos = 0;
    this.partial = '';
    this.seq = 0;
    this.ino = null;
  }

  start() {
    try {
      const st = fs.statSync(this.file);
      this.ino = st.ino;
      const from = Math.max(0, st.size - 256 * 1024);
      const text = this.read(from, st.size);
      let lines = text.split(/\r?\n/);
      if (from > 0) lines.shift(); // first line is probably cut
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      lines = lines.slice(-this.initial);
      this.pos = st.size;
      this.emit(lines, { initial: true });
      this.error = null;
    } catch (e) {
      this.error = e.message;
      this.onLines([], { error: e.message });
    }
    this.timer = setInterval(() => this.poll(), this.interval);
  }

  stop() { clearInterval(this.timer); }

  read(from, to) {
    const len = to - from;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(this.file, 'r');
    try { fs.readSync(fd, buf, 0, len, from); } finally { fs.closeSync(fd); }
    return buf.toString('utf8');
  }

  poll() {
    let st;
    try {
      st = fs.statSync(this.file);
    } catch (e) {
      if (!this.error) { this.error = 'File not found (deleted or rotated?) — waiting for it to come back'; this.onLines([], { error: this.error }); }
      return;
    }
    if (this.error) { this.error = null; this.pos = 0; this.onLines([], { error: null }); }
    if (st.size < this.pos || (this.ino && st.ino && st.ino !== this.ino)) {
      // truncated or rotated: start again from the top
      this.pos = 0;
      this.partial = '';
      this.ino = st.ino;
      this.onLines([], { reset: true });
    }
    if (st.size === this.pos) return;
    const to = Math.min(st.size, this.pos + 2 * 1024 * 1024);
    let text;
    try { text = this.partial + this.read(this.pos, to); } catch { return; }
    this.pos = to;
    const lines = text.split(/\r?\n/);
    this.partial = lines.pop();
    if (this.partial.length > MAX_LINE) { lines.push(this.partial); this.partial = ''; }
    if (lines.length) this.emit(lines, {});
  }

  emit(lines, meta) {
    const out = lines.filter((l) => l !== '').map((t) => {
      const text = t.length > MAX_LINE ? t.slice(0, MAX_LINE) + ' …[cut]' : t;
      return { n: ++this.seq, t: text, l: levelOf(text), c: isContinuation(text) };
    });
    this.onLines(out, meta);
  }
}
