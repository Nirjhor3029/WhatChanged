import { norm } from '../util.js';

/*
 * Queue sources, framework-neutral:
 *  - database tables that hold jobs (Laravel jobs/failed_jobs, Rails delayed_jobs/good_job/solid_queue,
 *    Django-Q, Celery results, Oban, River, Que, Hangfire, Symfony Messenger, Agenda (Mongo), outbox tables…)
 *  - Redis keys used by BullMQ/Bull, Sidekiq, Laravel, RQ, Celery, Asynq and generic list/zset/stream queues
 *  - RabbitMQ through its management API
 */

const QUEUE_TABLE = /(^|[._])(jobs?|failed_jobs|job_batches|delayed_jobs|good_jobs?|que_jobs|oban_jobs|river_job|queue(_jobs)?|queues|tasks?|messenger_messages|outbox(_messages)?|celery_taskmeta|django_q_\w+|solid_queue_\w+|hangfire\.\w*job\w*|agendaJobs|bull\w*|webhook_calls|failed_webhooks)$/i;
const NAME_COLS = ['displayName', 'display_name', 'job_class', 'handler', 'task_name', 'name', 'class_name', 'queue_name', 'type', 'job', 'topic', 'event'];
const STATUS_COLS = ['status', 'state', 'result', 'finished_at', 'failed_at', 'completed_at'];

export function queueTables(meta) {
  return Object.values(meta?.tables || {}).filter((t) => t.type === 'table' && QUEUE_TABLE.test(t.name));
}

/** Guess the job name of a row (also digs into JSON payloads such as Laravel's). */
export function jobNameOf(row) {
  for (const c of NAME_COLS) if (row[c]) return String(row[c]).slice(0, 120);
  for (const v of Object.values(row)) {
    if (typeof v !== 'string') continue;
    const m = /"(?:displayName|job|class|task|name)"\s*:\s*"([^"]{2,160})"/.exec(v);
    if (m) return m[1].replace(/\\{2,}/g, '\\');
  }
  return '';
}

function statusOf(table, row) {
  if (/fail/i.test(table)) return 'failed';
  for (const c of STATUS_COLS) {
    if (row[c] === undefined || row[c] === null || row[c] === '') continue;
    if (/_at$/.test(c)) return c.startsWith('failed') ? 'failed' : 'done';
    return String(row[c]).toLowerCase();
  }
  if (row.reserved_at) return 'started';
  if (row.attempts && Number(row.attempts) > 0) return 'retry';
  return 'queued';
}

/** Counts + newest rows of the queue tables of the connected database. */
export async function probeDb(driver, tables) {
  const out = [];
  for (const t of tables.slice(0, 20)) {
    try {
      const total = await driver.count(t);
      const res = await driver.fetchRows(t, t.columns.map((c) => c.name), { key: t.rowkey, limit: 15, desc: true });
      const rows = res.rows.map((r) => Object.fromEntries(res.cols.map((c, i) => [c, r[i]])));
      const latest = rows.map((row) => ({
        key: t.rowkey.map((k) => row[k]).join(' · '),
        name: jobNameOf(row),
        status: statusOf(t.name, row),
        queue: row.queue ?? row.queue_name ?? '',
        error: String(row.exception ?? row.last_error ?? row.error ?? row.traceback ?? '').split('\n')[0].slice(0, 300),
        row: Object.fromEntries(Object.entries(row).map(([k, v]) => [k, norm(v)])),
      }));
      out.push({ source: 'db', id: `db:${t.name}`, name: t.name, group: t.name, counts: { total }, latest });
    } catch (e) {
      out.push({ source: 'db', id: `db:${t.name}`, name: t.name, group: t.name, counts: {}, error: e.message });
    }
  }
  return out;
}

/* ================================================================ Redis */

const REDIS_PATTERNS = [
  // [regex on key, queue name index, state]
  [/^bull:([^:]+):(wait|waiting|active|delayed|failed|completed|paused|prioritized)$/, 'BullMQ'],
  [/^queues:([^:]+)(?::(delayed|reserved|notify))?$/, 'Laravel'],
  [/^queue:(.+)$/, 'Sidekiq'],
  [/^(retry|dead|schedule)$/, 'Sidekiq'],
  [/^rq:queue:(.+)$/, 'RQ'],
  [/^rq:(wip|failed|finished|scheduled|deferred):(.+)$/, 'RQ'],
  [/^asynq:\{([^}]+)\}:(pending|active|scheduled|retry|archived|completed)$/, 'Asynq'],
  [/^(celery)$/, 'Celery'],
];

export class RedisQueues {
  constructor(url) { this.url = url; this.client = null; }

  async connect() {
    if (this.client) return this.client;
    const { default: Redis } = await import('ioredis');
    this.client = new Redis(this.url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 5000, enableOfflineQueue: false, retryStrategy: () => null });
    this.client.on('error', () => {});
    await this.client.connect();
    return this.client;
  }

  async close() { try { this.client?.disconnect(); } catch { /* ignore */ } this.client = null; }

  async probe() {
    const r = await this.connect();
    const keys = [];
    let cursor = '0';
    let rounds = 0;
    do {
      const [next, batch] = await r.scan(cursor, 'COUNT', 1000);
      cursor = next;
      for (const k of batch) if (keys.length < 3000) keys.push(k);
      rounds++;
    } while (cursor !== '0' && rounds < 30);

    const queues = new Map();
    const matched = [];
    for (const k of keys) {
      let hit = null;
      for (const [re, fw] of REDIS_PATTERNS) {
        const m = re.exec(k);
        if (m) {
          if (fw === 'Sidekiq' && m[1] && /^(retry|dead|schedule)$/.test(m[1])) hit = { fw, queue: '(sidekiq)', state: m[1] };
          else if (fw === 'RQ' && m.length === 3 && /^(wip|failed|finished|scheduled|deferred)$/.test(m[1])) hit = { fw, queue: m[2], state: m[1] };
          else hit = { fw, queue: m[1], state: m[2] || 'waiting' };
          break;
        }
      }
      if (!hit && /(queue|job|task|bull|celery|worker)/i.test(k) && !/lock|meta|id$|:\d+$|stalled-check|limiter|events$|repeat/i.test(k)) hit = { fw: 'Redis', queue: k, state: 'items' };
      if (hit) matched.push([k, hit]);
    }
    for (const [k, hit] of matched.slice(0, 300)) {
      const type = await r.type(k);
      let n = null;
      if (type === 'list') n = await r.llen(k);
      else if (type === 'zset') n = await r.zcard(k);
      else if (type === 'set') n = await r.scard(k);
      else if (type === 'stream') n = await r.xlen(k);
      if (n === null) continue;
      const id = `redis:${hit.fw}:${hit.queue}`;
      const q = queues.get(id) || { source: 'redis', id, name: hit.queue, group: hit.fw, counts: {}, keys: [] };
      q.counts[hit.state] = (q.counts[hit.state] || 0) + n;
      q.keys.push(k);
      queues.set(id, q);
    }
    return [...queues.values()];
  }
}

/* ================================================================ RabbitMQ */

export async function probeRabbit(url) {
  const u = new URL(url);
  const auth = u.username ? 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64') : undefined;
  const base = `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, '')}`;
  const res = await fetch(`${base}/api/queues?columns=name,vhost,messages_ready,messages_unacknowledged,consumers,message_stats`, {
    headers: auth ? { authorization: auth } : {}, signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`RabbitMQ management API answered ${res.status}`);
  const list = await res.json();
  return list.map((q) => ({
    source: 'rabbitmq', id: `rabbit:${q.vhost}:${q.name}`, name: q.name, group: `RabbitMQ ${q.vhost}`,
    counts: {
      ready: q.messages_ready || 0, unacked: q.messages_unacknowledged || 0, consumers: q.consumers || 0,
      published: q.message_stats?.publish || 0, delivered: q.message_stats?.deliver_get || 0,
    },
  }));
}
