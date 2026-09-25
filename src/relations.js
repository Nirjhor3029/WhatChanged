/**
 * Relationship graph of a snapshot: real foreign keys plus relations inferred from
 * naming conventions, because many app databases (Laravel, Rails, Mongo…) declare none:
 *   user_id / userId / user (objectId)  -> users
 *   parent_id                            -> same table
 *   created_by / updatedBy               -> users
 *   commentable_id + commentable_type    -> polymorphic
 */
export function buildRelations(meta) {
  const tables = {};
  const lower = {};
  for (const [name, t] of Object.entries(meta.tables)) {
    if (t.type !== 'table') continue;
    tables[name] = t;
    lower[name.toLowerCase()] = name;
    // "public.users" style names can also be matched by their last part
    const last = name.split('.').pop().toLowerCase();
    if (!(last in lower)) lower[last] = name;
  }

  const edges = [];
  const covered = new Set();
  for (const fk of meta.fks || []) {
    if (!tables[fk.table]) continue;
    edges.push({ from: fk.table, col: fk.column, to: fk.ref_table, to_col: fk.ref_column, type: 'fk', on_delete: fk.on_delete, on_update: fk.on_update });
    covered.add(fk.table + '\u0000' + fk.column);
  }

  for (const [name, t] of Object.entries(tables)) {
    const colNames = new Set(t.columns.map((c) => c.name.toLowerCase()));
    for (const c of t.columns) {
      const col = c.name;
      if (covered.has(name + '\u0000' + col) || col === '_id') continue;
      const snake = toSnake(col);
      let target = null;
      let m;
      if ((m = /^(.+)_id$/.exec(snake))) {
        if (colNames.has(m[1] + '_type') || colNames.has(toCamel(m[1]) .toLowerCase() + 'type')) {
          edges.push({ from: name, col, to: null, to_col: null, type: 'morph', morph: m[1] });
          continue;
        }
        target = guess(m[1], lower, name);
      } else if (/^(created|updated|deleted|approved|assigned|owner|author|modified)_by(_id)?$/.test(snake)) {
        target = lower.users || lower.user || lower.admins || null;
      } else if (/objectId/.test(c.type) && !/\|/.test(c.type)) {
        target = guess(snake, lower, name); // Mongo: { author: ObjectId } -> authors / users
      } else if (/^array/.test(c.type) && /_ids$/.test(snake)) {
        target = guess(snake.replace(/_ids$/, ''), lower, name);
      }
      if (!target || (target === name && snake === 'id')) continue;
      const tt = tables[target];
      const toCol = tt.columns.some((x) => x.name === 'id') ? 'id' : tt.columns.some((x) => x.name === '_id') ? '_id' : tt.pk?.[0];
      if (!toCol) continue;
      edges.push({ from: name, col, to: target, to_col: toCol, type: 'inferred' });
    }
  }
  return edges;
}

function toSnake(s) {
  return String(s).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toLowerCase();
}
function toCamel(s) {
  return String(s).replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function guess(base, lower, self) {
  if (base === 'parent') return self;
  const parts = base.split('_');
  // billing_address -> billing_addresses, then addresses
  for (let i = 0; i < parts.length; i++) {
    const b = parts.slice(i).join('_');
    for (const cand of plurals(b)) {
      if (cand in lower) return lower[cand];
      const joined = cand.replace(/_/g, ''); // mongoose: orderitems
      if (joined in lower) return lower[joined];
    }
  }
  if (base === 'author' || base === 'owner' || base === 'creator') return lower.users || null;
  return null;
}

function plurals(b) {
  const c = [b + 's', b, b + 'es'];
  if (/[^aeiou]y$/.test(b)) c.push(b.slice(0, -1) + 'ies');
  if (/(s|x|z|ch|sh)$/.test(b)) c.unshift(b + 'es');
  if (b.endsWith('f')) c.push(b.slice(0, -1) + 'ves');
  if (b === 'person') c.push('people');
  if (b === 'child') c.push('children');
  return c;
}

export function around(edges, table) {
  return {
    parents: edges.filter((e) => e.from === table),
    children: edges.filter((e) => e.to === table && e.from !== table),
  };
}
