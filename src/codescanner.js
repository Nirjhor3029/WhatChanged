import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { cut } from './util.js';

/**
 * "Where in code?" — scans a project folder for places that probably touch a table:
 * model classes (Laravel/Eloquent, Mongoose, Sequelize, Prisma, Django, Rails…),
 * query builders (DB::table('x'), knex('x'), db.collection('x')), raw SQL and
 * Model.create()/->save() calls. Lines that look like writes are flagged.
 */
const WRITE_RE = /(::|->|\.)\s*(create|createMany|insert|insertOne|insertMany|insertGetId|insertOrIgnore|update|updateOne|updateMany|updateOrCreate|updateOrInsert|findOneAndUpdate|findByIdAndUpdate|findOneAndDelete|findByIdAndDelete|firstOrCreate|upsert|save|saveMany|delete|deleteOne|deleteMany|destroy|forceDelete|remove|increment|decrement|attach|detach|sync|syncWithoutDetaching|toggle|restore|push|truncate|bulkWrite|bulkCreate|replaceOne)\s*\(|\b(INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM)\b/i;

export function scanCode(root, tables, perTable = 14) {
  root = path.resolve(String(root || ''));
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('Project folder not found: ' + root);
  const files = listFiles(root);

  const targets = tables.map((t) => {
    const bare = t.split('.').pop();
    const model = studly(singular(bare));
    const rel = lcfirst(studly(bare));
    return {
      table: t,
      model,
      needles: [...new Set([bare, model])],
      reTable: new RegExp(`['"\`]${esc(bare)}['"\`.]|\\b(from|into|update|join|table)\\s+[\`"\\[]?${esc(bare)}\\b`, 'i'),
      reClass: new RegExp(`\\bclass\\s+${esc(model)}\\b|\\bmodel\\s*\\(\\s*['"\`]${esc(model)}['"\`]|\\bmodel\\s+${esc(model)}\\s*\\{`),
      reUse: new RegExp(`\\b${esc(model)}(::|\\.(?!php)\\w+\\s*\\(|\\s*\\(|::class)|new\\s+${esc(model)}\\b|prisma\\.${esc(lcfirst(model))}\\.`),
      reRel: new RegExp(`(->|\\.)\\s*${esc(rel)}\\s*\\(`),
    };
  });

  const hits = Object.fromEntries(tables.map((t) => [t, []]));
  for (const file of files) {
    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const relPath = path.relative(root, file).replace(/\\/g, '/');
    const layer = layerOf(relPath);
    let lines = null;
    for (const tg of targets) {
      if (!tg.needles.some((n) => src.includes(n))) continue;
      lines ||= src.split(/\r?\n/);
      lines.forEach((line, i) => {
        if (line.length > 600) return;
        let kind = null;
        if (tg.reClass.test(line)) kind = 'model';
        else if (tg.reTable.test(line)) kind = 'table';
        else if (tg.reUse.test(line)) kind = 'usage';
        else if (tg.reRel.test(line)) kind = 'relation';
        if (!kind) return;
        const write = WRITE_RE.test(line);
        hits[tg.table].push({ file: relPath, line: i + 1, code: cut(line.trim(), 180), kind, layer, write, score: score(kind, layer, write) });
      });
    }
  }

  const out = {};
  for (const tg of targets) {
    const list = hits[tg.table].sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);
    out[tg.table] = { model: tg.model, total: list.length, hits: list.slice(0, perTable) };
  }
  return { root, files_scanned: files.length, tables: out };
}

function listFiles(root) {
  const skip = new Set(config.codeSkipDirs.map((d) => d.toLowerCase()));
  const exts = new Set(config.codeExtensions);
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= config.codeMaxFiles) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const rel = path.relative(root, full).replace(/\\/g, '/').toLowerCase();
        if (!skip.has(e.name.toLowerCase()) && !skip.has(rel)) walk(full);
      } else if (exts.has(path.extname(e.name).slice(1).toLowerCase()) && !/\.min\.js$/.test(e.name)) {
        try { if (fs.statSync(full).size < 1_500_000) out.push(full); } catch { /* ignore */ }
      }
    }
  };
  walk(root);
  return out;
}

function layerOf(rel) {
  const r = rel.toLowerCase();
  const map = [
    ['migration', /migrations?\//], ['seeder', /seed(er)?s?\//], ['factory', /factor(y|ies)\//], ['test', /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.\w+$/],
    ['controller', /controllers?\/|\.controller\.\w+$/], ['service', /services?\/|\.service\.\w+$/], ['repository', /repositor(y|ies)\/|\.repository\.\w+$/],
    ['action', /actions?\//], ['job', /jobs?\/|queues?\//], ['listener', /(listeners?|observers?|events?|subscribers?|hooks?)\//],
    ['model', /(models?|entities|schemas?)\/|\.model\.\w+$|\.entity\.\w+$/], ['route', /(^|\/)routes?\/|router/], ['helper', /(helpers?|utils?)\b/],
    ['command', /(console|commands?)\//], ['livewire', /livewire\//], ['view', /(views?|components?|pages?)\//],
  ];
  for (const [name, re] of map) if (re.test(r)) return name;
  return 'other';
}

function score(kind, layer, write) {
  const k = { model: 60, table: 30, usage: 25, relation: 20 }[kind] || 0;
  const l = {
    controller: 18, service: 20, repository: 20, action: 20, job: 15, listener: 15, model: 10, helper: 12, livewire: 15,
    command: 8, route: 6, other: 5, migration: -15, seeder: -20, factory: -25, test: -25, view: -5,
  }[layer] || 0;
  return k + l + (write ? 35 : 0);
}

export function singular(w) {
  const parts = String(w).split('_');
  let last = parts.pop();
  if (/ies$/.test(last)) last = last.slice(0, -3) + 'y';
  else if (/(ss|x|z|ch|sh)es$/.test(last)) last = last.slice(0, -2);
  else if (/[^s]s$/.test(last)) last = last.slice(0, -1);
  else if (last === 'people') last = 'person';
  parts.push(last);
  return parts.join('_');
}
const studly = (w) => String(w).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').split(' ').filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1)).join('');
const lcfirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
