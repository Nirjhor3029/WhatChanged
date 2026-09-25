import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Tiny read-only file browser so folders / log files can be picked in the UI
 * (a browser page cannot see real paths on its own).
 */
export function listDir(dir) {
  if (!dir) {
    // Windows: drive letters; elsewhere the root
    if (process.platform === 'win32') {
      const drives = [];
      for (let c = 65; c <= 90; c++) {
        const d = String.fromCharCode(c) + ':\\';
        try { fs.accessSync(d); drives.push({ name: d, path: d, dir: true }); } catch { /* not mounted */ }
      }
      return { path: '', parent: null, entries: drives, places: places() };
    }
    dir = '/';
  }
  const abs = path.resolve(dir);
  const st = fs.statSync(abs);
  if (!st.isDirectory()) throw new Error('Not a folder: ' + abs);
  const entries = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entries.length >= 3000) break;
    const full = path.join(abs, e.name);
    let size = 0;
    let mtime = null;
    let isDir = e.isDirectory();
    try {
      const s = fs.statSync(full);
      isDir = s.isDirectory();
      size = s.size;
      mtime = s.mtime.toISOString();
    } catch { /* permission / broken link */ }
    entries.push({ name: e.name, path: full, dir: isDir, size: isDir ? 0 : size, mtime });
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  const parent = path.dirname(abs);
  return { path: abs, parent: parent === abs ? '' : parent, entries, places: places() };
}

function places() {
  const home = os.homedir();
  const list = [{ name: 'Home', path: home }];
  for (const p of ['Desktop', 'Documents', 'Projects', 'projects', 'code', 'Code', 'www']) {
    const full = path.join(home, p);
    if (fs.existsSync(full)) list.push({ name: p, path: full });
  }
  // The folder DB Checker runs from usually sits next to other projects (e.g. laragon/www).
  const sibling = path.resolve(process.cwd(), '..');
  if (fs.existsSync(sibling)) list.push({ name: path.basename(sibling) + ' (projects)', path: sibling });
  return list;
}
