import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

/*
 * Two tiny proxies that record HTTP traffic, whatever language the app is written in.
 *
 *  Inbound  – reverse proxy: open your app through http://localhost:<port> and every
 *             request/response (pages, API calls, webhooks you point here) is recorded.
 *  Outbound – forward proxy: start your app with HTTP_PROXY / HTTPS_PROXY pointing here and
 *             every call it makes to other services is recorded. HTTPS stays encrypted
 *             (no certificate tricks), so only host, timing and size are visible there.
 */

const CAPTURE = 64 * 1024; // bytes of each body kept for display
const REWRITE_MAX = 15 * 1024 * 1024;
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const ASSET = /\.(css|js|mjs|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|otf|mp4|webm|mp3|wav|pdf|zip)(\?|$)/i;

const rid = () => crypto.randomBytes(6).toString('hex');

class Capture {
  constructor() { this.chunks = []; this.size = 0; this.total = 0; }
  push(c) {
    this.total += c.length;
    if (this.size < CAPTURE) { const part = c.subarray(0, CAPTURE - this.size); this.chunks.push(part); this.size += part.length; }
  }
  text(contentType = '', encoding = '') {
    if (!this.size) return '';
    let buf = Buffer.concat(this.chunks);
    try {
      if (/gzip/.test(encoding)) buf = zlib.gunzipSync(buf);
      else if (/br/.test(encoding)) buf = zlib.brotliDecompressSync(buf);
      else if (/deflate/.test(encoding)) buf = zlib.inflateSync(buf);
    } catch { return this.total > CAPTURE ? '⟨compressed body, cut⟩' : '⟨compressed body⟩'; }
    if (!/json|text|xml|javascript|x-www-form-urlencoded|graphql|html|csv/i.test(contentType) && buf.includes(0)) return `⟨binary ${this.total} bytes⟩`;
    return buf.toString('utf8') + (this.total > CAPTURE ? `\n… ⟨cut, ${this.total} bytes total⟩` : '');
  }
}

function headersOf(raw) {
  const o = {};
  for (let i = 0; i < raw.length; i += 2) {
    const k = raw[i].toLowerCase();
    o[k] = o[k] ? `${o[k]}\n${raw[i + 1]}` : raw[i + 1];
  }
  return o;
}

/** What kind of inbound request is this — page, api, asset, webhook, form? */
export function kindOfRequest(method, url, headers) {
  const accept = headers.accept || '';
  const ct = headers['content-type'] || '';
  const ua = headers['user-agent'] || '';
  if (ASSET.test(url) || /^(image|font|audio|video)\//.test(accept) || headers['sec-fetch-dest'] === 'script' || headers['sec-fetch-dest'] === 'style' || headers['sec-fetch-dest'] === 'image') return 'asset';
  if (!/Mozilla|Chrome|Safari|Firefox|Edg\//.test(ua) && method !== 'GET') return 'webhook';
  if (headers['x-requested-with'] || /json/.test(accept) || /json/.test(ct) || headers['sec-fetch-mode'] === 'cors' || /\/api\/|graphql/.test(url)) return 'api';
  if (method !== 'GET' && /form/.test(ct)) return 'form';
  if (/text\/html/.test(accept) || headers['sec-fetch-dest'] === 'document') return 'page';
  return 'other';
}

/* ================================================================ inbound */

export class InboundProxy {
  /** @param {(ev: object) => void} emit */
  constructor(emit) {
    this.emit = emit;
    this.server = null;
    this.status = { running: false, port: 0, target: '', error: null };
  }

  async start({ target, port }) {
    await this.stop();
    let t;
    try { t = new URL(/^https?:\/\//i.test(target) ? target : 'http://' + target); } catch { throw new Error('Target must be a URL like http://myapp.test or http://localhost:3000'); }
    this.target = t;
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    const actual = await listen(this.server, port);
    this.port = actual;
    this.origin = `http://localhost:${actual}`;
    this.status = { running: true, port: actual, target: t.origin, error: null };
    return this.status;
  }

  async stop() {
    if (this.server) await new Promise((r) => { this.server.close(() => r()); this.server.closeAllConnections?.(); });
    this.server = null;
    this.status = { ...this.status, running: false };
  }

  handle(req, res) {
    const t = this.target;
    const started = Date.now();
    const id = rid();
    const reqCap = new Capture();
    const reqHeaders = headersOf(req.rawHeaders);
    const ev = {
      id, dir: 'in', source: 'proxy', ts: new Date(started).toISOString(), method: req.method, url: req.url,
      host: t.host, kind: kindOfRequest(req.method, req.url, reqHeaders), status: 0, pending: true, ip: req.socket.remoteAddress,
      reqHeaders, contentType: reqHeaders['content-type'] || '',
    };
    this.emit({ ...ev });

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
    headers.host = t.host;
    headers['accept-encoding'] = 'identity'; // lets us rewrite links and read bodies
    for (const h of ['origin', 'referer']) if (headers[h]) headers[h] = headers[h].split(this.origin).join(t.origin);
    headers['x-forwarded-for'] = req.socket.remoteAddress;
    headers['x-forwarded-host'] = req.headers.host;

    const mod = t.protocol === 'https:' ? https : http;
    const up = mod.request({
      protocol: t.protocol, hostname: t.hostname, port: t.port || (t.protocol === 'https:' ? 443 : 80),
      method: req.method, path: req.url, headers, rejectUnauthorized: false,
    }, (ur) => {
      const resHeaders = headersOf(ur.rawHeaders);
      const out = { ...ur.headers };
      for (const k of Object.keys(out)) if (HOP.has(k)) delete out[k];
      if (out.location) out.location = this.rewrite(out.location);
      if (out['set-cookie']) {
        out['set-cookie'] = [].concat(out['set-cookie']).map((c) => c.replace(/;\s*domain=[^;]*/i, '').replace(/;\s*secure/i, '').replace(/samesite=none/i, 'SameSite=Lax'));
      }
      const ct = ur.headers['content-type'] || '';
      const enc = ur.headers['content-encoding'] || '';
      const canRewrite = /text\/html|javascript|text\/css|json|xml/.test(ct) && !enc && Number(ur.headers['content-length'] || 0) <= REWRITE_MAX;
      const resCap = new Capture();
      const finish = (extra = {}) => {
        this.emit({
          ...ev, pending: false, status: ur.statusCode, ms: Date.now() - started, resHeaders, resContentType: ct,
          size: resCap.total, reqBody: reqCap.text(ev.contentType), resBody: resCap.text(ct, enc), ...extra,
        });
      };
      if (canRewrite) {
        const parts = [];
        let total = 0;
        ur.on('data', (c) => { parts.push(c); total += c.length; });
        ur.on('end', () => {
          let body = Buffer.concat(parts, total);
          const text = this.rewrite(body.toString('utf8'));
          body = Buffer.from(text, 'utf8');
          resCap.push(body);
          delete out['content-length'];
          out['content-length'] = body.length;
          res.writeHead(ur.statusCode, ur.statusMessage, out);
          res.end(body);
          finish();
        });
      } else {
        res.writeHead(ur.statusCode, ur.statusMessage, out);
        ur.on('data', (c) => resCap.push(c));
        ur.pipe(res);
        ur.on('end', () => finish());
      }
      ur.on('error', (e) => finish({ error: e.message }));
    });
    up.on('error', (e) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`WhatChanged proxy could not reach ${t.origin}\n\n${e.message}\n\nIs your app running? Check the target URL on the Requests page.`);
      } else res.destroy();
      this.emit({ ...ev, pending: false, status: 502, ms: Date.now() - started, error: `Cannot reach ${t.origin}: ${e.message}`, reqBody: reqCap.text(ev.contentType) });
    });
    req.on('data', (c) => reqCap.push(c));
    req.pipe(up);
  }

  /** Point absolute links to the target back at the proxy so you stay inside it. */
  rewrite(text) {
    const t = this.target;
    const variants = [t.origin, t.origin.replace(/^https?:/, t.protocol === 'https:' ? 'http:' : 'https:')];
    let out = text;
    for (const o of variants) {
      out = out.split(o).join(this.origin).split(o.replace(/\//g, '\\/')).join(this.origin.replace(/\//g, '\\/'));
    }
    return out.split(`//${t.host}`).join(`//localhost:${this.port}`);
  }

  /** WebSockets (hot reload, Socket.IO…) are passed straight through. */
  upgrade(req, socket, head) {
    const t = this.target;
    const port = Number(t.port) || (t.protocol === 'https:' ? 443 : 80);
    const up = t.protocol === 'https:' ? tls.connect({ host: t.hostname, port, servername: t.hostname, rejectUnauthorized: false }) : net.connect(port, t.hostname);
    up.on('connect', () => {});
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${/^host$/i.test(req.rawHeaders[i]) ? t.host : req.rawHeaders[i + 1]}`);
    }
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
    const close = () => { up.destroy(); socket.destroy(); };
    up.on('error', close);
    socket.on('error', close);
    this.emit({ id: rid(), dir: 'in', source: 'proxy', ts: new Date().toISOString(), method: 'WS', url: req.url, host: t.host, kind: 'websocket', status: 101, pending: false, ms: 0 });
  }
}

/* ================================================================ outbound */

export class OutboundProxy {
  constructor(emit) {
    this.emit = emit;
    this.server = null;
    this.status = { running: false, port: 0, error: null };
  }

  async start({ port }) {
    await this.stop();
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on('connect', (req, socket, head) => this.tunnel(req, socket, head));
    const actual = await listen(this.server, port);
    this.status = { running: true, port: actual, error: null };
    return this.status;
  }

  async stop() {
    if (this.server) await new Promise((r) => { this.server.close(() => r()); this.server.closeAllConnections?.(); });
    this.server = null;
    this.status = { ...this.status, running: false };
  }

  /** Plain HTTP through the proxy: fully visible. */
  handle(req, res) {
    let u;
    try { u = new URL(req.url); } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      return res.end('This is WhatChanged\'s outbound proxy. Set it as HTTP_PROXY for your app; do not open it in a browser.');
    }
    const started = Date.now();
    const reqHeaders = headersOf(req.rawHeaders);
    const ev = {
      id: rid(), dir: 'out', source: 'proxy', ts: new Date(started).toISOString(), method: req.method, url: u.pathname + u.search,
      host: u.host, scheme: u.protocol.replace(':', ''), kind: 'api', status: 0, pending: true, reqHeaders, contentType: reqHeaders['content-type'] || '',
    };
    this.emit({ ...ev });
    const reqCap = new Capture();
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
    const up = (u.protocol === 'https:' ? https : http).request(u, { method: req.method, headers, rejectUnauthorized: false }, (ur) => {
      const resCap = new Capture();
      const out = { ...ur.headers };
      for (const k of Object.keys(out)) if (HOP.has(k)) delete out[k];
      res.writeHead(ur.statusCode, ur.statusMessage, out);
      ur.on('data', (c) => resCap.push(c));
      ur.pipe(res);
      ur.on('end', () => this.emit({
        ...ev, pending: false, status: ur.statusCode, ms: Date.now() - started, resHeaders: headersOf(ur.rawHeaders),
        resContentType: ur.headers['content-type'] || '', size: resCap.total, reqBody: reqCap.text(ev.contentType),
        resBody: resCap.text(ur.headers['content-type'] || '', ur.headers['content-encoding'] || ''),
      }));
    });
    up.on('error', (e) => {
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain' }); res.end(e.message); }
      this.emit({ ...ev, pending: false, status: 0, ms: Date.now() - started, error: e.message, reqBody: reqCap.text(ev.contentType) });
    });
    req.on('data', (c) => reqCap.push(c));
    req.pipe(up);
  }

  /** HTTPS through the proxy (CONNECT): encrypted, so host + timing + bytes only. */
  tunnel(req, socket, head) {
    const [host, portStr] = req.url.split(':');
    const port = Number(portStr) || 443;
    const started = Date.now();
    const ev = {
      id: rid(), dir: 'out', source: 'proxy', ts: new Date(started).toISOString(), method: 'CONNECT', url: '', host: req.url,
      scheme: 'https', kind: 'api', status: 0, pending: true, tunnel: true,
    };
    this.emit({ ...ev });
    let up = 0;
    let down = 0;
    let done = false;
    const upstream = net.connect(port, host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\nProxy-agent: whatchanged\r\n\r\n');
      if (head?.length) { upstream.write(head); up += head.length; }
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    socket.on('data', (c) => { up += c.length; });
    upstream.on('data', (c) => { down += c.length; });
    const finish = (error) => {
      if (done) return;
      done = true;
      this.emit({ ...ev, pending: false, status: error ? 0 : 200, ms: Date.now() - started, bytesUp: up, bytesDown: down, size: down, error: error || undefined });
      upstream.destroy();
      socket.destroy();
    };
    upstream.on('error', (e) => { if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); finish(e.message); });
    socket.on('error', () => finish());
    upstream.on('close', () => finish());
    socket.on('close', () => finish());
  }
}

/** Listen on `port`, or the next free one (up to +20). Resolves with the port used. */
function listen(server, port) {
  const want = Number(port) || 0;
  return new Promise((resolve, reject) => {
    let tryPort = want;
    const attempt = () => {
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && want && tryPort < want + 20) { tryPort++; attempt(); } else reject(new Error(e.code === 'EADDRINUSE' ? `Port ${want} is busy` : e.message));
      });
      server.listen(tryPort, '127.0.0.1', () => resolve(server.address().port));
    };
    attempt();
  });
}
