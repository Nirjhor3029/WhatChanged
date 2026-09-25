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

## Storage

Everything is saved as JSON under `storage/`:

| Path | Contents |
|---|---|
| `connections.json` | saved connections (passwords and URLs encrypted with a local key in `storage/.secret`) |
| `snapshots/<conn>/<snap>/meta.json` | schema, counts and fingerprints |
| `snapshots/<conn>/<snap>/rows/*.json.gz` | captured rows (gzip). A table that did not change reuses the previous file instead of saving a copy |
| `snapshots/<conn>/diffs/*.json` | cached reports |

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
