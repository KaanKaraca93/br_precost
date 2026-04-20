const { getPool } = require("./db");

const USE_DB = !!process.env.DATABASE_URL;
const STALE_HOURS = 24;

const mem = {
  attributes: [], // [{ role, source, sourceId, label, values: [{name, code, seq}] }]
  lastRefreshedAt: null,
};

function isStale(iso) {
  if (!iso) return true;
  const ageMs = Date.now() - new Date(iso).getTime();
  return ageMs > STALE_HOURS * 60 * 60 * 1000;
}

async function getAll() {
  if (!USE_DB) {
    return {
      attributes:      mem.attributes,
      lastRefreshedAt: mem.lastRefreshedAt,
      stale:           isStale(mem.lastRefreshedAt),
    };
  }

  const db = getPool();

  const attrs = await db.query(`
    SELECT id, role, source, source_id AS "sourceId", label, display_order
    FROM lookup_attributes
    ORDER BY role, display_order, label
  `);

  const vals = await db.query(`
    SELECT attribute_id AS "attributeId", name, code, seq
    FROM lookup_values
    ORDER BY seq, name
  `);

  const valMap = new Map();
  for (const v of vals.rows) {
    if (!valMap.has(v.attributeId)) valMap.set(v.attributeId, []);
    valMap.get(v.attributeId).push({ name: v.name, code: v.code, seq: v.seq });
  }

  const attributes = attrs.rows.map(a => ({
    role:     a.role,
    source:   a.source,
    sourceId: a.sourceId,
    label:    a.label,
    values:   valMap.get(a.id) || [],
  }));

  const meta = await db.query(`SELECT value FROM lookup_meta WHERE key = 'last_refreshed_at'`);
  const lastRefreshedAt = meta.rows[0] ? meta.rows[0].value : null;

  return { attributes, lastRefreshedAt, stale: isStale(lastRefreshedAt) };
}

// payload: { selectors: [{ key, sourceId, values: [...] }, ...],
//            costAttrs: [{ key, source, sourceId, values: [...] }] }
async function refresh(payload) {
  const nowIso = new Date().toISOString();

  const selectors = (payload.selectors || []).map((s, i) => ({
    role:         "selector",
    source:       "standard",
    sourceId:     String(s.sourceId),
    label:        s.key,
    displayOrder: i,
    values:       normaliseValues(s.values),
  }));

  const costAttrs = (payload.costAttrs || []).map((a, i) => ({
    role:         "cost-attr",
    source:       a.source || "standard",
    sourceId:     String(a.sourceId),
    label:        a.key,
    displayOrder: i,
    values:       normaliseValues(a.values),
  }));

  const all = [...selectors, ...costAttrs];

  if (!USE_DB) {
    mem.attributes      = all;
    mem.lastRefreshedAt = nowIso;
    return { ok: true, lastRefreshedAt: nowIso, count: all.length };
  }

  const db = getPool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE lookup_values, lookup_attributes RESTART IDENTITY CASCADE");

    for (const a of all) {
      const ins = await client.query(
        `INSERT INTO lookup_attributes (role, source, source_id, label, display_order)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [a.role, a.source, a.sourceId, a.label, a.displayOrder]
      );
      const attrId = ins.rows[0].id;

      for (const v of a.values) {
        await client.query(
          `INSERT INTO lookup_values (attribute_id, name, code, seq) VALUES ($1,$2,$3,$4)`,
          [attrId, v.name, v.code, v.seq]
        );
      }
    }

    await client.query(
      `INSERT INTO lookup_meta (key, value) VALUES ('last_refreshed_at', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [nowIso]
    );

    await client.query("COMMIT");
    return { ok: true, lastRefreshedAt: nowIso, count: all.length };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function normaliseValues(arr) {
  return (arr || [])
    .map(v => {
      if (typeof v === "string") return { name: v.trim(), code: null, seq: 0 };
      return {
        name: (v.name || "").trim(),
        code: v.code || null,
        seq:  Number(v.seq) || 0,
      };
    })
    .filter(v => v.name);
}

module.exports = { getAll, refresh };
