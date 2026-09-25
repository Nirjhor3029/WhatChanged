import { config } from '../config.js';
import { md5 } from '../util.js';

export const DRIVERS = {
  mysql: { label: 'MySQL / MariaDB', port: 3306, user: 'root', load: async () => (await import('./mysql.js')).MysqlDriver },
  postgres: { label: 'PostgreSQL', port: 5432, user: 'postgres', load: async () => (await import('./postgres.js')).PostgresDriver },
  mssql: { label: 'SQL Server', port: 1433, user: 'sa', load: async () => (await import('./mssql.js')).MssqlDriver },
  sqlite: { label: 'SQLite', port: '', user: '', load: async () => (await import('./sqlite.js')).SqliteDriver },
  mongodb: { label: 'MongoDB', port: 27017, user: '', load: async () => (await import('./mongodb.js')).MongoDriver },
};

/** Guess the driver from a connection URL / file path. */
export function detectDriver(url) {
  const u = String(url || '').trim().toLowerCase();
  if (u.startsWith('mongodb://') || u.startsWith('mongodb+srv://')) return 'mongodb';
  if (u.startsWith('mysql://') || u.startsWith('mariadb://') || u.startsWith('mysqlx://')) return 'mysql';
  if (u.startsWith('postgres://') || u.startsWith('postgresql://')) return 'postgres';
  if (u.startsWith('mssql://') || u.startsWith('sqlserver://') || /^(server|data source)=/i.test(u)) return 'mssql';
  if (u.startsWith('sqlite:') || u.startsWith('file:') || /\.(db|sqlite3?|db3)$/.test(u)) return 'sqlite';
  return null;
}

/**
 * Normalise a saved/entered connection into what the driver needs.
 * SQL URLs (mysql://, mssql://) are split into fields; Postgres & Mongo keep the URL.
 */
export function resolveConfig(c) {
  const driver = c.driver || detectDriver(c.url) || 'mysql';
  if (!DRIVERS[driver]) throw new Error('Unknown database type: ' + driver);
  const out = { driver, host: c.host, port: c.port, user: c.user, password: c.password, database: c.database, ssl: !!c.ssl, file: c.file, url: '' };
  const url = c.mode === 'url' ? String(c.url || '').trim() : '';
  if (!url) return out;

  if (driver === 'sqlite') return { ...out, file: url };
  if (driver === 'mongodb' || driver === 'postgres') return { ...out, url };
  if (driver === 'mssql' && !/^(mssql|sqlserver):\/\//i.test(url)) return { ...out, url };

  let u;
  try { u = new URL(url.replace(/^mariadb:|^mysqlx:/i, 'mysql:').replace(/^sqlserver:/i, 'mssql:')); } catch { throw new Error('That connection URL could not be parsed.'); }
  const params = u.searchParams;
  return {
    ...out,
    host: u.hostname,
    port: u.port || DRIVERS[driver].port,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: c.database || decodeURIComponent(u.pathname.replace(/^\//, '')),
    ssl: out.ssl || /^(true|1|required?|verify.*)$/i.test(params.get('ssl') || params.get('sslmode') || params.get('ssl-mode') || params.get('encrypt') || ''),
  };
}

export async function openDriver(conn, database) {
  const cfg = resolveConfig(conn);
  if (database !== undefined) cfg.database = database;
  const Driver = await DRIVERS[cfg.driver].load();
  return Driver.connect(cfg);
}

/* ---- connection cache: keep one live connection per saved connection ---- */

const cache = new Map();

export async function getDriver(conn) {
  const sig = md5(JSON.stringify(resolveConfig(conn)));
  const hit = cache.get(conn.id);
  if (hit && hit.sig === sig && !hit.driver.broken) {
    hit.last = Date.now();
    try {
      await hit.driver.ping();
      return hit.driver;
    } catch {
      cache.delete(conn.id);
      hit.driver.close();
    }
  } else if (hit) {
    cache.delete(conn.id);
    hit.driver.close();
  }
  const driver = await openDriver(conn);
  cache.set(conn.id, { driver, sig, last: Date.now() });
  return driver;
}

export function dropDriver(id) {
  const hit = cache.get(id);
  if (hit) { cache.delete(id); hit.driver.close(); }
}

setInterval(() => {
  for (const [id, hit] of cache) if (Date.now() - hit.last > config.idleCloseMs) dropDriver(id);
}, 60000).unref();
