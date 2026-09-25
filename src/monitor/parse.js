/**
 * Line classifiers shared by the log, request and queue monitors.
 * They only recognise common, framework-neutral shapes; anything else is
 * still shown as a plain log line.
 */

const PINO = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
const WORD = {
  emergency: 'fatal', alert: 'fatal', critical: 'fatal', crit: 'fatal', fatal: 'fatal', panic: 'fatal',
  error: 'error', err: 'error', severe: 'error', exception: 'error',
  warning: 'warn', warn: 'warn', notice: 'info', info: 'info', information: 'info',
  debug: 'debug', dbg: 'debug', trace: 'trace', verbose: 'trace', silly: 'trace',
};

/** Level of a log line: fatal | error | warn | info | debug | trace | '' */
export function levelOf(line) {
  let m;
  // JSON logs: {"level":"error"} / {"level":50} / {"severity":"ERROR"}
  if (line.startsWith('{') && (m = /"(?:level|severity|lvl|log\.level)"\s*:\s*"?([A-Za-z]+|\d{2})"?/.exec(line))) {
    return PINO[m[1]] || WORD[m[1].toLowerCase()] || '';
  }
  // Monolog / Laravel / Symfony: "local.ERROR:", "app.WARNING:"
  if ((m = /\.\s?(EMERGENCY|ALERT|CRITICAL|ERROR|WARNING|NOTICE|INFO|DEBUG):/.exec(line))) return WORD[m[1].toLowerCase()];
  // PHP: "PHP Fatal error:", "PHP Warning:"
  if ((m = /PHP (Fatal error|Parse error|Warning|Notice|Deprecated)/i.exec(line))) return /error/i.test(m[1]) ? 'error' : m[1] === 'Deprecated' ? 'info' : 'warn';
  // [error] [WARN] <error> level=error level:warn
  if ((m = /[[<(]\s*(emerg|emergency|alert|crit|critical|fatal|error|err|warn|warning|notice|info|debug|trace)\s*[\]>):]/i.exec(line))) return WORD[m[1].toLowerCase()] || 'fatal';
  if ((m = /\blevel[=:]\s*"?(\w+)/i.exec(line))) return WORD[m[1].toLowerCase()] || '';
  // winston / python logging: "info: started", "ERROR:root:boom"
  if ((m = /^(error|warn|warning|info|debug|verbose|silly|critical)(:|\s-\s)/i.exec(line))) return WORD[m[1].toLowerCase()];
  // Upper-case tokens near the start: "ERROR 2026-..", "2026-.. WARN [main]"
  if ((m = /^.{0,60}?\b(FATAL|CRITICAL|SEVERE|ERROR|WARN|WARNING|NOTICE|INFO|DEBUG|TRACE|VERBOSE)\b/.exec(line))) return WORD[m[1].toLowerCase()];
  // Worker output ending in a status word: "App\Jobs\X ...... 15ms FAIL"
  if ((m = /\s(FAIL|FAILED|DONE|RUNNING)\s*$/.exec(line))) return m[1].startsWith('FAIL') ? 'error' : 'info';
  // Tracebacks / uncaught errors
  if (/^(Traceback \(most recent call last\)|Uncaught |Unhandled |\w*(Error|Exception)(: |$))/.test(line)) return 'error';
  // Access logs: 5xx / 4xx
  const req = parseRequestLine(line);
  if (req) return req.status >= 500 ? 'error' : req.status >= 400 ? 'warn' : 'info';
  return '';
}

/** Stack-trace style continuation lines belong to the previous entry. */
export function isContinuation(line) {
  return /^(\s+\S|\s*at\s|#\d+\s|Stack trace:|Caused by:|\s*File ".+", line \d+|\s*\.\.\. \d+ more|\s*\^+\s*$|\})/.test(line) && !/^\s*\[?\d{4}-\d{2}-\d{2}/.test(line);
}

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/**
 * HTTP request lines in logs: Apache/Nginx common & combined format, morgan
 * ("GET /x 200 12.3 ms"), Django/Werkzeug ("GET /x HTTP/1.1" 200), Go/Rails-ish.
 */
export function parseRequestLine(line) {
  let m;
  if ((m = /^(\S+) \S+ \S+ \[([^\]]+)\] "([A-Z]+) (\S+)[^"]*" (\d{3}) (\d+|-)(?: "([^"]*)" "([^"]*)")?(?: (\d+(?:\.\d+)?))?/.exec(line))) {
    const ts = /(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})/.exec(m[2]);
    return {
      ip: m[1], ts: ts ? new Date(Date.UTC(+ts[3], MONTHS[ts[2]] ?? 0, +ts[1], +ts[4], +ts[5], +ts[6])).toISOString() : null,
      method: m[3], url: m[4], status: +m[5], bytes: m[6] === '-' ? 0 : +m[6], referer: m[7] || '', ua: m[8] || '', format: 'access-log',
    };
  }
  if ((m = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\/\S*) (\d{3}) (?:-\s+)?(\d+(?:\.\d+)?)\s?ms\b/.exec(line))) {
    return { method: m[1], url: m[2], status: +m[3], ms: +m[4], format: 'dev-server' };
  }
  if ((m = /"(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\S+) HTTP\/[\d.]+" (\d{3})(?: (\d+|-))?/.exec(line))) {
    return { method: m[1], url: m[2], status: +m[3], bytes: m[4] && m[4] !== '-' ? +m[4] : 0, format: 'access-log' };
  }
  if ((m = /Completed (\d{3}) [\w ]+ in (\d+)ms/.exec(line))) return { method: '', url: '', status: +m[1], ms: +m[2], format: 'rails' };
  return null;
}

/** Outbound HTTP calls that show up in logs (mostly as errors) — Guzzle, cURL, axios/node, requests. */
export function parseOutboundLine(line) {
  let m;
  if ((m = /(Client|Server) error: `(\w+) (\S+)` resulted in a `(\d{3})/.exec(line))) return { method: m[2], url: m[3], status: +m[4] };
  if ((m = /cURL error (\d+):([^(]*?)(?:\(see [^)]*\))?\s*for (https?:\/\/\S+)/.exec(line))) return { method: '', url: m[3], status: 0, error: `cURL ${m[1]}:${m[2].trim()}` };
  if ((m = /(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN)\s+(\S+)/.exec(line))) return { method: '', url: m[2], status: 0, error: m[1] };
  if ((m = /(\d{3}) (?:Client|Server) Error: .*? for url: (https?:\/\/\S+)/.exec(line))) return { method: '', url: m[2], status: +m[1] };
  if ((m = /Max retries exceeded with url: (\S+).*?host='([^']+)'/.exec(line))) return { method: '', url: `https://${m[2]}${m[1]}`, status: 0, error: 'connection failed' };
  if ((m = /\bHTTP (?:request|call) (?:to )?(GET|POST|PUT|PATCH|DELETE) (https?:\/\/\S+)(?:.*?\b(\d{3})\b)?/i.exec(line))) return { method: m[1].toUpperCase(), url: m[2], status: m[3] ? +m[3] : 0 };
  return null;
}

/** Queue / job / worker lines: Laravel, Rails ActiveJob, Celery, Sidekiq, RQ, BullMQ-ish, generic. */
export function parseJobLine(line) {
  let m;
  const clean = (s) => s.replace(/\\{2,}/g, '\\');
  // Laravel ≥ 9: "2026-09-25 10:00:01 App\Jobs\SendMail .......... 12.40ms DONE"
  if ((m = /([A-Z][\w\\]+(?:\\[\w]+)+)\s+\.{2,}.*?\b(RUNNING|DONE|FAIL|FAILED)\b/.exec(line))) {
    return { name: clean(m[1]), status: { RUNNING: 'started', DONE: 'done', FAIL: 'failed', FAILED: 'failed' }[m[2]] };
  }
  // Laravel < 9: "Processing: App\Jobs\X" / "Processed:" / "Failed:"
  if ((m = /\b(Processing|Processed|Failed):\s+([\w\\]+)/.exec(line))) return { name: clean(m[2]), status: { Processing: 'started', Processed: 'done', Failed: 'failed' }[m[1]] };
  // Rails ActiveJob
  if ((m = /\b(Enqueued|Performing|Performed|Error performing) (\w[\w:]*) \(Job ID: ([\w-]+)\)(?:.*? in ([\d.]+)ms)?/.exec(line))) {
    return { name: m[2], id: m[3], ms: m[4] ? +m[4] : undefined, status: { Enqueued: 'queued', Performing: 'started', Performed: 'done', 'Error performing': 'failed' }[m[1]] };
  }
  // Celery
  if ((m = /Task ([\w.]+)\[([\w-]+)\] (received|succeeded in ([\d.]+)s|raised|retry)/.exec(line))) {
    const s = m[3].startsWith('succeeded') ? 'done' : m[3] === 'received' ? 'queued' : m[3] === 'retry' ? 'retry' : 'failed';
    return { name: m[1], id: m[2], status: s, ms: m[4] ? Math.round(+m[4] * 1000) : undefined };
  }
  // Sidekiq
  if ((m = /class=(\S+) jid=(\w+).*?\b(start|done|fail)\b(?:: ([\d.]+) sec)?/.exec(line))) {
    return { name: m[1], id: m[2], status: m[3] === 'start' ? 'started' : m[3] === 'done' ? 'done' : 'failed', ms: m[4] ? Math.round(+m[4] * 1000) : undefined };
  }
  // RQ
  if ((m = /\b(\w+): ([\w.]+)\(.*?\) \(([\w-]+)\)/.exec(line)) && /^(default|high|low|\w+queue)$/.test(m[1])) return { name: m[2], id: m[3], status: 'started' };
  if ((m = /Job OK \(([\w-]+)\)/.exec(line))) return { name: 'job', id: m[1], status: 'done' };
  // Generic: "... job SendEmail failed", "queue: order.created dispatched", "worker completed task X"
  if ((m = /\b(job|queue|task|worker|listener|consumer|event|message)\b[^\n]{0,80}?\b(dispatched|queued|enqueued|pushed|published|received|started|processing|processed|completed|succeeded|done|failed|retrying|consumed|handled)\b/i.exec(line))) {
    const name = (/([A-Z][\w\\.:-]*(?:Job|Task|Listener|Event|Worker|Consumer|Handler|Message))\b/.exec(line) || /['"`]([\w.:-]{3,})['"`]/.exec(line) || [])[1] || m[1];
    const w = m[2].toLowerCase();
    const status = /fail/.test(w) ? 'failed' : /retry/.test(w) ? 'retry' : /(dispatch|queue|push|publish|receiv)/.test(w) ? 'queued' : /(start|processing)/.test(w) ? 'started' : 'done';
    return { name: clean(name), status, generic: true };
  }
  return null;
}
