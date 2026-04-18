/**
 * Storage abstraction layer.
 * - DATABASE_URL set  → PostgreSQL (Heroku production)
 * - DATABASE_URL unset → in-memory (local dev / demo; data lost on restart)
 */

const { getPool } = require("./db");

const USE_DB = !!process.env.DATABASE_URL;

// ─── In-memory store (local dev fallback) ────────────────────────────────────

const mem = {
  configs: {},  // "costCat::season::brand::styleCat" → { selectedAttrs: [] }
  values:  {},  // "costCat::season::brand::styleCat" → [{ attrCombo:{}, consumption }]
};

function memKey(costCategory, season, brand, styleCategory) {
  return [costCategory, season, brand, styleCategory].join("::");
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function getConfig(costCategory, season, brand, styleCategory) {
  if (!USE_DB) {
    return mem.configs[memKey(costCategory, season, brand, styleCategory)] || null;
  }
  const db = getPool();
  const { rows } = await db.query(
    `SELECT selected_attrs FROM attribute_configs
     WHERE cost_category=$1 AND season=$2 AND brand=$3 AND style_category=$4`,
    [costCategory, season, brand, styleCategory]
  );
  return rows[0] ? { selectedAttrs: rows[0].selected_attrs } : null;
}

async function saveConfig(costCategory, season, brand, styleCategory, selectedAttrs) {
  if (!USE_DB) {
    mem.configs[memKey(costCategory, season, brand, styleCategory)] = { selectedAttrs };
    return;
  }
  const db = getPool();
  await db.query(
    `INSERT INTO attribute_configs (cost_category, season, brand, style_category, selected_attrs, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (cost_category, season, brand, style_category)
     DO UPDATE SET selected_attrs=$5, updated_at=NOW()`,
    [costCategory, season, brand, styleCategory, selectedAttrs]
  );
}

async function getValues(costCategory, season, brand, styleCategory) {
  if (!USE_DB) {
    return mem.values[memKey(costCategory, season, brand, styleCategory)] || [];
  }
  const db = getPool();
  const { rows } = await db.query(
    `SELECT attr_combo, consumption, unit FROM consumption_values
     WHERE cost_category=$1 AND season=$2 AND brand=$3 AND style_category=$4
     ORDER BY id`,
    [costCategory, season, brand, styleCategory]
  );
  return rows.map(r => ({
    attrCombo:   r.attr_combo,
    consumption: r.consumption !== null ? parseFloat(r.consumption) : null,
    unit:        r.unit,
  }));
}

async function bulkSaveValues(costCategory, season, brand, styleCategory, values) {
  if (!USE_DB) {
    mem.values[memKey(costCategory, season, brand, styleCategory)] = values;
    return;
  }
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const v of values) {
      await client.query(
        `INSERT INTO consumption_values
           (cost_category, season, brand, style_category, attr_combo, consumption, unit, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (cost_category, season, brand, style_category, attr_combo)
         DO UPDATE SET consumption=$6, unit=$7, updated_at=NOW()`,
        [
          costCategory, season, brand, styleCategory,
          JSON.stringify(v.attrCombo),
          v.consumption ?? null,
          v.unit || "m",
        ]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function listConfigs(costCategory) {
  if (!USE_DB) {
    return Object.keys(mem.configs)
      .filter(k => k.startsWith(costCategory + "::"))
      .map(k => {
        const [, season, brand, styleCategory] = k.split("::");
        return { season, brand, styleCategory };
      });
  }
  const db = getPool();
  const { rows } = await db.query(
    `SELECT season, brand, style_category AS "styleCategory"
     FROM attribute_configs WHERE cost_category=$1 ORDER BY season, brand, style_category`,
    [costCategory]
  );
  return rows;
}

module.exports = { getConfig, saveConfig, getValues, bulkSaveValues, listConfigs };
