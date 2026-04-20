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
    SELECT attribute_id AS "attributeId", value_id AS "id", name, code, seq
    FROM lookup_values
    ORDER BY seq, name
  `);

  const valMap = new Map();
  for (const v of vals.rows) {
    if (!valMap.has(v.attributeId)) valMap.set(v.attributeId, []);
    valMap.get(v.attributeId).push({ id: v.id, name: v.name, code: v.code, seq: v.seq });
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

  // Schema/data-eksiği kontrolü: cost-attr veya selector altındaki herhangi
  // bir değerde value_id NULL ise eski schema'dan kalmıştır → stale say,
  // widget bir sonraki açılışta arka planda yeni şemayla yenilesin.
  const idMissing = await db.query(`
    SELECT 1
    FROM lookup_values v
    JOIN lookup_attributes a ON a.id = v.attribute_id
    WHERE v.value_id IS NULL
      AND a.role IN ('selector','cost-attr','reference')
    LIMIT 1
  `);
  const schemaStale = idMissing.rows.length > 0;

  return {
    attributes,
    lastRefreshedAt,
    stale: schemaStale || isStale(lastRefreshedAt),
    schemaStale,
  };
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

  const references = (payload.references || []).map((a, i) => ({
    role:         "reference",
    source:       a.source || "standard",
    sourceId:     String(a.sourceId),
    label:        a.key,
    displayOrder: i,
    values:       normaliseValues(a.values),
  }));

  const all = [...selectors, ...costAttrs, ...references];

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

    if (all.length > 0) {
      const aParams = [];
      const aTuples = [];
      let p = 1;
      for (const a of all) {
        aTuples.push(`($${p++},$${p++},$${p++},$${p++},$${p++})`);
        aParams.push(a.role, a.source, a.sourceId, a.label, a.displayOrder);
      }
      const ins = await client.query(
        `INSERT INTO lookup_attributes (role, source, source_id, label, display_order)
         VALUES ${aTuples.join(",")} RETURNING id`,
        aParams
      );
      const ids = ins.rows.map(r => r.id);

      const flatRows = [];
      for (let i = 0; i < all.length; i++) {
        const attrId = ids[i];
        for (const v of all[i].values) {
          flatRows.push([attrId, v.id, v.name, v.code, v.seq]);
        }
      }

      // pg parametre limiti 65535. 1000 satır × 5 param = 5000.
      const ROWS_PER_BATCH = 1000;
      for (let off = 0; off < flatRows.length; off += ROWS_PER_BATCH) {
        const slice = flatRows.slice(off, off + ROWS_PER_BATCH);
        const sliceParams = [];
        const sliceTuples = [];
        let np = 1;
        for (const row of slice) {
          sliceTuples.push(`($${np++},$${np++},$${np++},$${np++},$${np++})`);
          sliceParams.push(row[0], row[1], row[2], row[3], row[4]);
        }
        await client.query(
          `INSERT INTO lookup_values (attribute_id, value_id, name, code, seq) VALUES ${sliceTuples.join(",")}`,
          sliceParams
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
      if (typeof v === "string") return { id: null, name: v.trim(), code: null, seq: 0 };
      return {
        id:   v.id !== undefined && v.id !== null ? String(v.id) : null,
        name: (v.name || "").trim(),
        code: v.code || null,
        seq:  Number(v.seq) || 0,
      };
    })
    .filter(v => v.name);
}

module.exports = { getAll, refresh };
