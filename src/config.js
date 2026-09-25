import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Tweak via environment variables if you work with very large databases.
 */
export const config = {
  host: process.env.DBC_HOST || '127.0.0.1',
  port: Number(process.env.PORT || process.env.DBC_PORT || 4477),
  storage: process.env.DBC_STORAGE || path.join(ROOT, 'storage'),

  // Tables/collections up to this size are captured completely → every inserted /
  // updated / deleted row shows up in the report.
  rowLimit: Number(process.env.DBC_ROW_LIMIT || 50000),

  // Bigger tables: only the newest N rows (by primary key / _id) are captured.
  tailRows: Number(process.env.DBC_TAIL_ROWS || 2000),

  // Max rows listed per change type (inserted/updated/deleted) per table in a report.
  maxList: 250,

  // Documents sampled to infer the fields of a MongoDB collection.
  mongoSample: 300,

  // Idle database connections are closed after this many ms.
  idleCloseMs: 5 * 60 * 1000,

  codeSkipDirs: ['vendor', 'node_modules', 'storage', '.git', 'bootstrap/cache', 'public/build', 'public/vendor',
    'dist', 'build', '.next', '.nuxt', 'coverage', '.idea', '.vscode', '__pycache__', '.venv', 'venv', 'target', 'bin', 'obj'],
  codeExtensions: ['php', 'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'java', 'kt', 'cs', 'vue', 'svelte'],
  codeMaxFiles: 15000,
};
