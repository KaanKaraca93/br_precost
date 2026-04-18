const { Pool } = require("pg");

let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
    });
  }
  return pool;
}

async function init() {
  const db = getPool();

  await db.query(`
    CREATE TABLE IF NOT EXISTS attribute_configs (
      id             SERIAL PRIMARY KEY,
      cost_category  VARCHAR(50)  NOT NULL,
      season         VARCHAR(20)  NOT NULL,
      brand          VARCHAR(100) NOT NULL,
      style_category VARCHAR(100) NOT NULL,
      selected_attrs TEXT[]       NOT NULL DEFAULT '{}',
      updated_at     TIMESTAMP    DEFAULT NOW(),
      UNIQUE (cost_category, season, brand, style_category)
    );

    CREATE TABLE IF NOT EXISTS consumption_values (
      id             SERIAL PRIMARY KEY,
      cost_category  VARCHAR(50)  NOT NULL,
      season         VARCHAR(20)  NOT NULL,
      brand          VARCHAR(100) NOT NULL,
      style_category VARCHAR(100) NOT NULL,
      attr_combo     JSONB        NOT NULL,
      consumption    NUMERIC(10,3),
      unit           VARCHAR(10)  NOT NULL DEFAULT 'm',
      updated_at     TIMESTAMP    DEFAULT NOW(),
      UNIQUE (cost_category, season, brand, style_category, attr_combo)
    );
  `);

  console.log("[db] Tables ready");
}

module.exports = { getPool, init };
