# DB Checker

See exactly what your code does to the database. Snapshot a database, use your app (register, checkout, delete something…), then get a clear report of **every row inserted, updated or deleted**, **every column/index that changed**, **which related tables are affected**, and **where in your code** those tables are used.

Works with **MySQL / MariaDB, PostgreSQL, SQL Server, SQLite and MongoDB** — local servers or cloud URLs (MongoDB Atlas `mongodb+srv://`, Supabase, Neon, PlanetScale, RDS, Azure SQL…). It does not depend on Laragon/XAMPP; it only needs Node.js.

## Run

```bash
npm install
npm start
```

On Windows you can also double-click `start.bat`. The app opens at http://localhost:4477.

Requirements: Node.js 22.13 or newer (SQLite support uses the built-in `node:sqlite`).

## How to use

1. **Connect**: pick the database type, then fill host/user/password or paste a connection URL. Optionally add your **project folder** to get "where in code?" hints.
2. The first scan takes a **baseline snapshot** of every table: schema, exact row counts, and the rows themselves.
3. Keep **Live** on: tables your app changes light up on the dashboard within a few seconds.
4. Type what you did (e.g. "Place order") and press **Capture & compare**. The report shows:
   - a short list of what happened (e.g. "2 new rows in `order_items`", "`products.stock` changed")
   - an **impact map** of the changed tables and their related tables
   - each table's inserted, updated (old → new value per cell) and deleted rows
   - foreign key values shown as labels (`user_id 4 → users: Nabila`), plus warnings for missing references and orphaned rows
   - structure changes (columns, indexes, foreign keys), triggers and views
   - model, controller, service and repository lines that use the table, with likely writes listed first
5. After each capture, the new snapshot becomes the baseline, so you can check a multi-step journey one step at a time. In **History** you can compare any two snapshots.

## Project folders

A project can have several folders — e.g. a MERN app's `backend` and `frontend`, or one folder per
microservice. Add them when you create the connection or later with the **Project** button. They are
used for code hints in reports, log discovery and the API / queue code maps. Any language works.

## Logs

- **Find log files** searches your project folders (`*.log`, `logs/`, `storage/logs`, `var/log`,
  `nohup.out`, …) and common system places (PM2, Apache, Nginx, PHP, MySQL, Laragon/XAMPP). With
  *look inside files* it also recognises logs with unusual names by their content. You tick which
  files to watch, or pick any file yourself.
- Up to 5 files live side by side. Levels are detected for most formats (Monolog/Laravel,
  Symfony, Rails, Django/Python, winston/pino JSON, Log4j/Spring, Go, Apache/Nginx, PHP errors).
  Stack traces stay attached to their error line.
- Per pane: filter by text or `/regex/`, level toggles (Alt+click shows one level only), wrap, pause,
  click / Shift+click lines to select, copy one entry, the selection, or everything that matches.

## Requests

- **Incoming:** turn it on, enter where your app runs (`http://myapp.test`, `http://localhost:3000`)
  and open the app through `http://localhost:4480`. Every page, API call, form post and webhook is
  recorded with headers and bodies. Links, redirects and cookies are rewritten so you stay on the proxy.
- **Outgoing:** turn it on and start your app or worker with `HTTP_PROXY` / `HTTPS_PROXY` set to
  `http://127.0.0.1:4481`. The page has ready-to-copy setup for PHP/Laravel, Node, Python, Java, Go,
  .NET and Ruby. Plain HTTP calls are recorded in full. HTTPS calls show the host, timing and size,
  because their content stays encrypted.
- Requests from watched access logs (Apache, Nginx, morgan, Django, Rails) appear here too, as do
  HTTP errors written to logs (Guzzle, cURL, axios/Node, Python requests).
- The code map lists where the code calls APIs and where it receives webhooks.

## Queues & listeners

- Database job tables are detected automatically: Laravel `jobs`/`failed_jobs`, Rails
  `delayed_jobs`/GoodJob/Solid Queue, Oban, River, Que, Django-Q, Celery results, Symfony
  Messenger, Agenda (MongoDB), outbox tables.
- **Redis** (optional URL): BullMQ/Bull, Sidekiq, Laravel, RQ, Celery, Asynq and generic list, set
  and stream queues.
- **RabbitMQ** (optional management URL): ready, unacked and consumer counts for each queue.
- **Job activity** merges new job rows, count changes and worker log lines (Laravel `queue:work`,
  ActiveJob, Celery, Sidekiq, RQ) into one feed.
- The code map lists producers (dispatch, publish, enqueue, emit) and workers or listeners.

All monitors run inside the DB Checker process and keep recent events in memory only: 3,000 lines per
log, 400 requests and 1,000 job events. Proxies and log watchers start again on their own when
DB Checker restarts.

## Storage

Everything is saved as JSON under `storage/`:

| Path | Contents |
|---|---|
| `connections.json` | saved connections (passwords and URLs encrypted with a local key in `storage/.secret`) |
| `snapshots/<conn>/<snap>/meta.json` | schema, counts and fingerprints |
| `snapshots/<conn>/<snap>/rows/*.json.gz` | captured rows (gzip). A table that did not change reuses the previous file instead of saving a copy |
| `snapshots/<conn>/diffs/*.json` | cached reports |
| `workspaces/<conn>.json` | watched log files, proxy settings, queue sources (Redis/RabbitMQ URLs encrypted) |

## Limits and tuning

Set these as environment variables before `npm start`:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 4477 | web port |
| `DBC_ROW_LIMIT` | 50000 | tables up to this size are captured completely (full row-level diff) |
| `DBC_TAIL_ROWS` | 2000 | bigger tables: only the newest N rows by primary key are compared (row counts stay exact) |
| `DBC_STORAGE` | `./storage` | data folder |

- Tables without a primary or unique key show an edited row as one deleted row plus one inserted row.
- MongoDB: collections are treated as tables and top-level fields as columns. Nested objects are compared as JSON.
- Database access is **read-only**: DB Checker only runs `SELECT`, `COUNT`, `CHECKSUM` and metadata queries.
- The server listens on `127.0.0.1` only. Every API call needs a per-session token.
