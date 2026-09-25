<div align="center">

<img src="public/favicon.svg" width="84" alt="WhatChanged logo">

# WhatChanged

### Click something in your app. See everything it changed

Database rows, log lines, API calls and background jobs — for **any language, any framework, any database** — in one live dashboard that runs on your machine.

[![Node.js](https://img.shields.io/badge/node-%E2%89%A5%2022.13-43853d?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-8b5cf6)](LICENSE)
![Databases](https://img.shields.io/badge/databases-MySQL%20·%20MariaDB%20·%20PostgreSQL%20·%20SQL%20Server%20·%20SQLite%20·%20MongoDB-22d3ee)
![Local only](https://img.shields.io/badge/runs-100%25%20locally-34d399)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-fbbf24)](#-contributing)

[Quick start](#-quick-start) · [Features](#-features) · [Screenshots](#-see-it-in-action) · [How it works](#%EF%B8%8F-how-it-works) · [FAQ](#-faq)

<br>

<img src="images/overview-live.png" alt="WhatChanged live overview: changed tables glow and show the exact change" width="100%">


<!-- <table>
    <tr>
        <td width="50%" valign="top">
            <img src="images/hero.png" alt="WhatChanged start screen: pick a database and connect" width="100%">
        </td>
        <td width="50%" valign="top">
            <img src="images/overview-live.png" alt="WhatChanged live overview: changed tables glow and show the exact change" width="100%">
        </td>
    </tr>
</table> -->

<sub>You place an order in your app — WhatChanged lights up every table that changed and tells you exactly what changed in it.</sub>

</div>

<br>

## 🤔 Why WhatChanged?

You press **“Place order”** in an app. What actually happened?

To find out, you normally read the route, then the controller, then a service, a repository, two helpers, an event, three listeners and a queued job — and you still miss the trigger that updates the stock, or the observer that writes the audit log.

**WhatChanged skips the guesswork.** It watches the *result* instead of reading the code:

- 🗄️ **Database** — which tables changed, which rows were inserted, updated or deleted, and the **exact cells**: `products #42 · stock 62 → 61`
- 📜 **Logs** — the errors and warnings your action produced, live, with stack traces
- 🌐 **Requests** — every request that came in, every API call your app made (payment, SMS, mail, AI…), with bodies
- ⏳ **Queues** — jobs pushed, picked up, finished or failed
- 🧭 **Code** — the models, controllers, services and listeners that touch those tables
- 🔎 **Your own queries** — the SQL you keep re-running, now re-run for you, with every change highlighted

One click in your app → one clear answer. No SDK, no code changes, no agents to install in your project.

<br>

## ✨ Features

<table>
<tr>
<td width="50%" valign="top">

### 🔴 Live database watch

Changed tables glow on the dashboard seconds after your action, each with a one-line preview like `#7 balance: 375.00 → 60.00`. **One click** shows every changed row and cell.

</td>
<td width="50%" valign="top">

### 📋 Change reports

Snapshot → act → capture. A plain-English list of what happened, an **impact map** of related tables, old → new values, foreign keys resolved to names (`user_id 7 → Arif Chowdhury`), orphan and missing-reference warnings.

</td>
</tr>
<tr>
<td valign="top">

### 🧭 “Where in code?”

Points at the lines that write to each changed table — models, controllers, services, repositories, jobs — across **several project folders** (backend, frontend, microservices).

</td>
<td valign="top">

### 📜 Live logs, up to 5 side by side

Finds your log files for you (project, PM2, Apache, Nginx, PHP, MySQL…). Level colours, grouped stack traces, text or `/regex/` filter, pause, select lines, copy.

</td>
</tr>
<tr>
<td valign="top">

### 🌐 Incoming & outgoing requests

A mirror proxy records pages, API calls, forms and webhooks. An outbound proxy records the calls your app makes. Includes headers, pretty JSON bodies and **Copy as cURL**.

</td>
<td valign="top">

### ⏳ Queues & listeners

Job tables (Laravel, Rails, Django, Symfony, Oban…), Redis (BullMQ, Sidekiq, RQ, Celery, Asynq) and RabbitMQ, plus worker log lines, all in one activity feed.

</td>
</tr>
<tr>
<td valign="top">

### 🧱 Structure changes too

New, dropped or changed columns, indexes and foreign keys; possible renames; new or dropped tables, views and triggers.

</td>
<td valign="top">

### 🚀 Built for real data sizes

Lakhs of rows? Unchanged tables are skipped by checksum and every list is paged, so large databases stay smooth.

</td>
</tr>
<tr>
<td colspan="2" valign="top">

### 🔎 Watched queries
Save the 3–4 queries you keep re-running in a SQL client while debugging. WhatChanged re-runs them every few seconds and highlights new rows, removed rows and each changed cell (`balance 500 → 380`), with a history of every change. SQL and MongoDB are supported, and every query runs read-only.

</td>
</tr>
</table>

<br>

## 📸 See it in action

### 1 · Do something in your app — see exactly what changed

Click a glowing table and the **What changed** tab lists every changed row with its old and new values. You don't need a snapshot first.

<img src="images/what-changed.png" alt="Exact cell changes of the products table" width="100%">

### 2 · Capture a report of the whole action

Everything one checkout did, across 10 tables: a plain-English summary, the counts, and an impact map of how the tables relate.

<img src="images/report.png" alt="Change report with summary and impact map" width="100%">

Every table in the report shows its new, updated and deleted rows, which tables it affects, and the lines of code that write to it:

<img src="images/report-orders.png" alt="Report card of the orders table with relations and code hints" width="100%">

### 3 · Keep your own queries running

Save the queries you keep checking, press **Compare from now**, then act in your app. New rows turn green and changed cells show old → new, the moment they happen.

<img src="images/queries.png" alt="Watched queries showing a new row and changed cells live" width="100%">

### 4 · Watch the logs while you click

Errors and their stack traces stay together. Tail up to five files at once, from any framework.

<img src="images/logs.png" alt="Two log files tailed side by side" width="100%">

### 5 · See every request — in and out

<img src="images/requests.png" alt="Incoming requests and outgoing API calls" width="100%">

<table>
<tr>
<td width="50%"><img src="images/request-detail.png" alt="Request detail with response body"><br><sub>The payment provider's 402 answer, pretty-printed.</sub></td>
<td width="50%"><img src="images/requests-setup.png" alt="Request watcher setup"><br><sub>Two switches, and setup snippets for every language.</sub></td>
</tr>
</table>

### 6 · Follow the background jobs

<img src="images/queues.png" alt="Queues from database tables and Redis, with job activity" width="100%">

<br>

## 🚀 Quick start

**Requirements:** [Node.js](https://nodejs.org) **22.13 or newer**. Nothing else — no Docker and no changes to your project.

**Run it instantly** (no install):

```bash
npx whatchanged
```

**Or install it once** and run it from anywhere:

```bash
npm install -g whatchanged
whatchanged
```

**Or run it from source:**

```bash
git clone https://github.com/Nirjhor3029/WhatChanged.git
cd WhatChanged
npm install
npm start
```

Your browser opens **<http://localhost:4477>**. On Windows you can also double-click **`start.bat`** in the source folder, which installs the dependencies the first time.

<details>
<summary><b>Command-line options</b></summary>

```text
whatchanged [options]

  -p, --port <number>   dashboard port (default 4477)
      --host <address>  address to listen on (default 127.0.0.1)
      --data <folder>   where connections and snapshots are saved (default ~/.whatchanged)
      --no-open         don't open the browser
  -v, --version         print the version
  -h, --help            show this help
```
</details>

<img src="images/hero.png" alt="WhatChanged start screen: pick a database and connect" width="100%">

### Your first five minutes

1. **Connect.** Pick your database, enter host / user / password or paste a connection URL (`mysql://…`, `postgresql://…`, `mongodb+srv://…`), then add your **project folders**.
2. **Baseline.** WhatChanged takes a first snapshot of every table, with an animated scan.
3. **Use your app.** Register a user, place an order, delete something. With **Live** on, the tables that changed start glowing.
4. **Capture & compare.** Type what you did (“Place order”) and press the button. You get the full report, and the next step of your journey is compared against this one.
5. Open **Logs**, **Requests** and **Queues** to see the rest of the story.

<br>

## 🧩 Works with your stack

| | Supported |
| --- | --- |
| **Databases** | MySQL · MariaDB · PostgreSQL · SQL Server · SQLite · MongoDB — local or cloud (Atlas, Supabase, Neon, PlanetScale, RDS, Azure SQL…) |
| **Log formats** | Laravel/Monolog, Symfony, Rails, Django/Python logging, winston, pino / JSON logs, Log4j/Spring, Go, PHP errors, Apache/Nginx access and error logs, morgan |
| **Queues** | Job tables of Laravel, Rails (Delayed Job, GoodJob, Solid Queue), Oban, River, Que, Django-Q, Celery, Symfony Messenger, Agenda · Redis: BullMQ/Bull, Sidekiq, Laravel, RQ, Celery, Asynq · RabbitMQ |
| **Code map** | PHP, JavaScript/TypeScript, Python, Ruby, Go, Java/Kotlin, C#, Vue, Svelte |
| **Outbound HTTP** | Anything that respects `HTTP_PROXY`/`HTTPS_PROXY`, with copy-paste setup for PHP/Laravel, Node.js, Python, Java, Go, .NET and Ruby |

<details>
<summary><b>Connection URL examples</b></summary>

```text
mysql://root:secret@127.0.0.1:3306/shop
postgresql://postgres:secret@db.xxxx.supabase.co:5432/postgres?sslmode=require
mongodb+srv://user:secret@cluster0.xxxxx.mongodb.net/shop
Server=localhost,1433;Database=shop;User Id=sa;Password=secret;Encrypt=true;TrustServerCertificate=true
C:\projects\app\database\database.sqlite
```

</details>

<br>

## ⚙️ How it works

```mermaid
flowchart LR
    A([🖱️ You click in your app]) --> DB[(Database)]
    A --> L[Log files]
    A --> H[HTTP in / out]
    A --> Q[Queues]
    DB -- snapshots + checksums --> W{{WhatChanged}}
    L -- live tail --> W
    H -- local proxies --> W
    Q -- tables · Redis · RabbitMQ --> W
    C[Project folders] -- code map --> W
    W --> R[📋 One answer: rows, cells, logs, calls, jobs + the code that did it]
```

- **Snapshots.** Schema, exact row counts and a checksum for every table. Rows are stored only for tables that changed, as gzipped JSON, and each row is matched by its primary or unique key, so an edited row shows up as an update with the exact cells.
- **Live watch.** Every few seconds it compares checksums with your baseline. For a changed table it fetches the current rows and diffs them in memory, without saving a snapshot.
- **Relations.** Real foreign keys, plus relations guessed from names such as `user_id → users`, `parent_id`, `created_by`, polymorphic `*_type`, and Mongo `ObjectId` fields, because most app databases don't declare foreign keys.
- **Requests.** A reverse proxy in front of your app records incoming requests, and a forward proxy records outgoing calls. HTTPS is tunnelled untouched, never intercepted.
- **Everything else.** It tails log files, polls queues, runs a pattern-based code map, and streams all of it to the browser over Server-Sent Events.

<br>

## 👥 Who is it for?

- **Developers joining an existing codebase:** learn what “Checkout” really does in 30 seconds instead of an afternoon.
- **Debugging “it saved the wrong thing”:** see the exact cell that changed and the line of code that probably wrote it.
- **QA and testers:** check that an action touched exactly the tables it should, and nothing else.
- **Code reviewers:** run a branch and see its real database, log, API and queue side effects.
- **Integrations:** check what you actually send to Stripe, SSLCommerz, bKash, Twilio or OpenAI, and what webhooks come back.
- **Documentation:** copy a report as Markdown to show how a feature changes data.
- **Learners:** watch what a framework does under the hood when you click a button.

<br>

## 🔧 Configuration

Set these as environment variables before starting. All of them are optional, and the command-line options above override them.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `4477` | Port of the dashboard |
| `DBC_ROW_LIMIT` | `50000` | Tables up to this size are compared row by row |
| `DBC_TAIL_ROWS` | `2000` | Larger tables compare only their newest N rows (counts stay exact) |
| `DBC_STORAGE` | `~/.whatchanged` | Where connections, snapshots and settings are saved |
| `DBC_HOST` | `127.0.0.1` | Address the dashboard listens on |

Your data lives in your home folder (`~/.whatchanged`, e.g. `C:\Users\you\.whatchanged` on Windows), so it survives updates and reinstalls. A source checkout that already has a `storage/` folder with saved connections keeps using that folder.

The inbound and outbound proxies use ports **4480** and **4481** by default. You can change them on the Requests page.

<br>

## 🔒 Privacy & safety

- **100% local.** No accounts, no telemetry, and your data never leaves your machine.
- **Read-only.** WhatChanged runs only `SELECT`, `COUNT`, `CHECKSUM` and metadata queries, and never writes to your database.
- **Watched queries can't write.** Each one must be a single read statement (`SELECT`, `WITH`, `SHOW`, `EXPLAIN`…). It runs on its own connection inside a read-only transaction that is always rolled back, with a 10-second timeout and a 1,000-row cap.
- **Credentials are encrypted** (AES-256-GCM) in your data folder, with a key generated on your machine.
- The dashboard and proxies listen on `127.0.0.1` only. Every API call needs a per-session token, and requests from other hostnames are refused, which blocks DNS rebinding.
- HTTPS traffic is never decrypted, only timed and measured.

<br>

## ❓ FAQ

<details>
<summary><b>Do I need to change my code or install a package in my project?</b></summary>

No. WhatChanged reads your database, your log files and your traffic from the outside. Outgoing-call recording is the only feature that needs a change: an environment variable (or, for PHP under Apache/FPM, one line of config), and it is optional.
</details>

<details>
<summary><b>Will it slow down or change my database?</b></summary>

It never writes. A snapshot reads each table once. Unchanged tables are skipped by checksum and their data is not copied again. Live watch runs light checksum queries every 3 seconds, and you can switch it off.
</details>

<details>
<summary><b>My tables have millions of rows.</b></summary>

Counts and checksums stay exact. Tables above 50,000 rows compare their newest 2,000 rows row by row, which catches inserts and recent edits. Both limits can be changed.
</details>

<details>
<summary><b>How does a watched query know which row is which?</b></summary>

Rows are matched by a key column: `id`, `_id`, `uuid`, `code` or `email` if present, otherwise the first column when its values are unique. You can also pick the column in the query editor. Single-value queries such as `SELECT COUNT(*)` are compared directly. For MongoDB, write the query as JSON, e.g. `{"collection": "orders", "filter": {"status": "paid"}, "sort": {"_id": -1}, "limit": 10}`, or give a `pipeline` to run an aggregation.
</details>

<details>
<summary><b>What about tables without a primary key?</b></summary>

They are still compared, but by row content. An edited row then shows up as one deleted row plus one inserted row.
</details>

<details>
<summary><b>Can I use it with production?</b></summary>

It's built for local, staging and QA databases. It is read-only, but watching a busy production database is noisy and adds load. Use a replica or a copy.
</details>

<details>
<summary><b>How mature is each database driver?</b></summary>

MySQL/MariaDB and SQLite are the most battle-tested. PostgreSQL, SQL Server and MongoDB are fully implemented and newer. Bug reports with a small reproduction are very welcome.
</details>

<br>

## 📁 Project structure

```text
server.js              HTTP server, API and live stream
src/drivers/           MySQL · PostgreSQL · SQL Server · SQLite · MongoDB
src/snapshotter.js     snapshots, live watch, live "what changed"
src/differ.js          row / cell / schema diff, impact, paging
src/relations.js       real + inferred relationships
src/codescanner.js     "where in code?" hints
src/monitor/           log discovery & tail, proxies, queues, code map, live hub
public/                the dashboard (plain JS + CSS, no build step)
```

<br>

## 🤝 Contributing

Issues and pull requests are welcome, especially:

- log formats, queue backends or frameworks that aren't recognised yet
- driver fixes for your database version
- UI ideas and screenshots of real-world use

```bash
npm install
npm run serve        # start without opening a browser
```

The code has no build step: edit, reload, done.

<br>

## ⭐ Support

If WhatChanged saved you an hour of digging through controllers and services, **give it a star** — it helps other developers find it.

<br>

## 📄 License

[MIT](LICENSE) © 2026 Nirjhor3029
