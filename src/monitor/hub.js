import crypto from 'node:crypto';
import path from 'node:path';
import { getDriver } from '../drivers/index.js';
import { Tail, kindOf } from './logs.js';
import { InboundProxy, OutboundProxy } from './proxy.js';
import { RedisQueues, probeDb, probeRabbit, queueTables } from './queues.js';
import { parseJobLine, parseOutboundLine, parseRequestLine } from './parse.js';

const LOG_KEEP = 3000; // lines kept per log file
const REQ_KEEP = 400; // requests kept (bodies included)
const JOB_KEEP = 1000;

const rid = () => crypto.randomBytes(6).toString('hex');
export const logId = (p) => crypto.createHash('md5').update(path.resolve(p).toLowerCase()).digest('hex').slice(0, 10);

/**
 * One hub per project (saved connection). It tails the chosen log files, runs the
 * request proxies and polls queues, keeps recent events in memory and streams
 * them to every open browser tab (Server-Sent Events).
 */
class Hub {
  constructor(store, id) {
    this.store = store;
    this.id = id;
    this.clients = new Set();
    this.tails = new Map(); // logId -> { cfg, tail, lines, error }
    this.requests = [];
    this.jobs = [];
    this.queues = null;
    this.queueErrors = {};
    this.inbound = new InboundProxy((ev) => this.onRequest(ev));
    this.outbound = new OutboundProxy((ev) => this.onRequest(ev));
    this.redis = null;
    this.prevQueues = new Map();
  }

  ws() { return this.store.workspace(this.id); }

  async boot() {
    this.syncLogs();
    await this.applyProxies();
  }

  async shutdown() {
    for (const t of this.tails.values()) t.tail.stop();
    this.tails.clear();
    await this.inbound.stop();
    await this.outbound.stop();
    clearInterval(this.qTimer);
    await this.redis?.close();
    for (const c of this.clients) c.end();
  }

  /* ------------------------------------------------------------ clients */

  subscribe(res) {
    this.clients.add(res);
    res.write(`retry: 3000\n\n`);
    this.push(res, {
      type: 'hello',
      logs: [...this.tails.values()].map((t) => ({ ...this.logInfo(t), lines: t.lines.slice(-800) })),
      requests: this.requests.slice(-REQ_KEEP),
      jobs: this.jobs.slice(-300),
      queues: this.queues,
      status: this.status(),
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    res.on('close', () => {
      clearInterval(ping);
      this.clients.delete(res);
      if (!this.clients.size) { clearInterval(this.qTimer); this.qTimer = null; }
    });
    if (!this.qTimer) {
      this.qTimer = setInterval(() => this.pollQueues(), 3000);
      this.pollQueues();
    }
  }

  push(res, ev) { res.write(`data: ${JSON.stringify(ev)}\n\n`); }
  send(ev) { const data = `data: ${JSON.stringify(ev)}\n\n`; for (const c of this.clients) c.write(data); }

  status() {
    return { inbound: this.inbound.status, outbound: this.outbound.status, queueErrors: this.queueErrors };
  }

  /* --------------------------------------------------------------- logs */

  logInfo(t) {
    return { id: t.cfg.id, path: t.cfg.path, label: t.cfg.label, kind: kindOf(t.cfg.path), error: t.error || null };
  }

  /** Start/stop tails so they match the saved list of log files. */
  syncLogs() {
    const wanted = new Map(this.ws().logs.map((l) => [l.id, l]));
    for (const [id, t] of this.tails) {
      if (!wanted.has(id)) { t.tail.stop(); this.tails.delete(id); this.send({ type: 'log-removed', id }); }
    }
    for (const [id, cfg] of wanted) {
      if (this.tails.has(id)) continue;
      const entry = { cfg, lines: [], error: null };
      entry.tail = new Tail(cfg.path, (lines, meta) => this.onLines(entry, lines, meta));
      this.tails.set(id, entry);
      entry.tail.start();
      this.send({ type: 'log-added', log: { ...this.logInfo(entry), lines: entry.lines.slice(-800) } });
    }
  }

  onLines(entry, lines, meta = {}) {
    if ('error' in meta) entry.error = meta.error;
    if (meta.reset) entry.lines = [];
    entry.lines.push(...lines);
    if (entry.lines.length > LOG_KEEP) entry.lines.splice(0, entry.lines.length - LOG_KEEP);
    this.send({ type: 'log', id: entry.cfg.id, lines, reset: !!meta.reset, error: entry.error, initial: !!meta.initial });
    if (meta.initial) return; // don't turn old history into "new" requests / jobs
    for (const l of lines) {
      const req = parseRequestLine(l.t);
      if (req) this.onRequest({ id: rid(), dir: 'in', source: 'log', log: entry.cfg.label, ts: req.ts || new Date().toISOString(), host: '', kind: 'log', pending: false, raw: l.t, ...req });
      const out = !req && parseOutboundLine(l.t);
      if (out) {
        let host = '';
        try { host = new URL(out.url).host; } catch { host = out.url; }
        this.onRequest({ id: rid(), dir: 'out', source: 'log', log: entry.cfg.label, ts: new Date().toISOString(), host, kind: 'api', pending: false, raw: l.t, ...out, url: out.url.replace(/^https?:\/\/[^/]+/, '') || '/' });
      }
      const job = parseJobLine(l.t);
      if (job) this.onJob({ source: 'log', log: entry.cfg.label, raw: l.t, ...job });
    }
  }

  /* ----------------------------------------------------------- requests */

  onRequest(ev) {
    const i = this.requests.findIndex((r) => r.id === ev.id);
    if (i >= 0) this.requests[i] = ev; else this.requests.push(ev);
    if (this.requests.length > REQ_KEEP) this.requests.splice(0, this.requests.length - REQ_KEEP);
    this.send({ type: 'request', req: ev });
  }

  clearRequests() { this.requests = []; this.send({ type: 'requests-cleared' }); }

  async applyProxies() {
    const ws = this.ws();
    const run = async (proxy, cfg, key) => {
      try {
        if (cfg.enabled && (key === 'outbound' || cfg.target)) {
          const cur = proxy.status;
          const same = cur.running && cur.port === Number(cfg.port) && (key === 'outbound' || cur.target === new URL(/^https?:/.test(cfg.target) ? cfg.target : 'http://' + cfg.target).origin);
          if (!same) {
            const st = await proxy.start(cfg);
            if (st.port !== Number(cfg.port)) { cfg.port = st.port; this.saveProxyPort(key, st.port); }
          }
        } else {
          await proxy.stop();
        }
        proxy.status.error = null;
      } catch (e) {
        proxy.status = { ...proxy.status, running: false, error: e.message };
      }
    };
    await run(this.inbound, ws.inbound, 'inbound');
    await run(this.outbound, ws.outbound, 'outbound');
    this.send({ type: 'status', status: this.status() });
    return this.status();
  }

  saveProxyPort(key, port) {
    const ws = this.ws();
    ws[key].port = port;
    this.store.saveWorkspace(this.id, ws);
  }

  /* --------------------------------------------------------------- jobs */

  onJob(job) {
    const j = { id: rid(), ts: new Date().toISOString(), ...job };
    this.jobs.push(j);
    if (this.jobs.length > JOB_KEEP) this.jobs.splice(0, this.jobs.length - JOB_KEEP);
    this.send({ type: 'job', job: j });
  }

  resetQueues() {
    this.redis?.close();
    this.redis = null;
    this.prevQueues = new Map();
    this.polledOnce = false;
    this.queues = null;
  }

  async pollQueues() {
    if (this.polling) return;
    this.polling = true;
    const ws = this.ws();
    const list = [];
    const errors = {};
    try {
      // 1. job tables in the connected database
      const meta = this.store.latestComplete(this.id);
      const tables = queueTables(meta);
      if (tables.length) {
        try {
          const driver = await getDriver(this.store.connection(this.id));
          list.push(...(await probeDb(driver, tables)));
        } catch (e) { errors.db = e.message; }
      }
      // 2. Redis
      if (ws.queues.redis_url) {
        try {
          this.redis ||= new RedisQueues(ws.queues.redis_url);
          list.push(...(await this.redis.probe()));
        } catch (e) { errors.redis = e.message; await this.redis?.close(); this.redis = null; }
      }
      // 3. RabbitMQ
      if (ws.queues.rabbit_url) {
        try { list.push(...(await probeRabbit(ws.queues.rabbit_url))); } catch (e) { errors.rabbit = e.message; }
      }
      this.detectJobChanges(list);
      const snapshot = { at: new Date().toISOString(), queues: list, tables: tables.map((t) => t.name) };
      const changed = JSON.stringify(snapshot.queues) !== JSON.stringify(this.queues?.queues) || JSON.stringify(errors) !== JSON.stringify(this.queueErrors);
      this.queues = snapshot;
      this.queueErrors = errors;
      if (changed) this.send({ type: 'queues', data: snapshot, errors });
    } finally {
      this.polling = false;
    }
  }

  /** Turn "new row in jobs table" / "failed count went up" into job events. */
  detectJobChanges(list) {
    const first = !this.polledOnce;
    this.polledOnce = true;
    for (const q of list) {
      // A queue that appears after the first check starts from zero.
      const prev = this.prevQueues.get(q.id) || (first ? null : { counts: {}, latest: [] });
      if (prev && q.source === 'db' && q.latest) {
        const seen = new Set(prev.latest?.map((x) => x.key));
        for (const r of q.latest.slice().reverse()) {
          if (!seen.has(r.key)) this.onJob({ source: 'db', table: q.name, name: r.name || q.name, status: r.status, key: r.key, error: r.error, row: r.row });
        }
        const drop = (prev.counts.total || 0) - (q.counts.total || 0);
        if (drop > 0 && !/fail/i.test(q.name)) this.onJob({ source: 'db', table: q.name, name: q.name, status: 'done', note: `${drop} left the table (picked up / deleted)` });
      } else if (prev && q.source !== 'db') {
        for (const [state, n] of Object.entries(q.counts)) {
          const d = n - (prev.counts[state] || 0);
          if (d > 0 && /(fail|dead|retry)/.test(state)) this.onJob({ source: q.source, name: q.name, status: 'failed', note: `${state} +${d}` });
          else if (d > 0 && /(wait|ready|pending|items|delayed|scheduled)/.test(state)) this.onJob({ source: q.source, name: q.name, status: 'queued', note: `${state} +${d}` });
          else if (d > 0 && /(completed|finished|delivered|published)/.test(state)) this.onJob({ source: q.source, name: q.name, status: 'done', note: `${state} +${d}` });
        }
      }
      this.prevQueues.set(q.id, q);
    }
  }
}

const hubs = new Map();

export function hubFor(store, id) {
  let h = hubs.get(id);
  if (!h) {
    h = new Hub(store, id);
    hubs.set(id, h);
    h.boot().catch(() => {});
  }
  return h;
}

export async function dropHub(id) {
  const h = hubs.get(id);
  if (h) { hubs.delete(id); await h.shutdown(); }
}

/** Start monitors of every saved project that has something configured. */
export function bootHubs(store) {
  for (const c of store.connections()) {
    const ws = store.workspace(c.id);
    if (ws.logs.length || ws.inbound.enabled || ws.outbound.enabled) hubFor(store, c.id);
  }
}
