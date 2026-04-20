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

    CREATE TABLE IF NOT EXISTS lookup_attributes (
      id           SERIAL PRIMARY KEY,
      role         VARCHAR(20)  NOT NULL,           -- 'selector' | 'cost-attr'
      source       VARCHAR(20)  NOT NULL,           -- 'standard' | 'extended'
      source_id    VARCHAR(100) NOT NULL,           -- GlrefId or ExtFldId
      label        VARCHAR(200) NOT NULL,
      display_order INT         DEFAULT 0,
      UNIQUE (source, source_id)
    );

    CREATE TABLE IF NOT EXISTS lookup_values (
      id           SERIAL PRIMARY KEY,
      attribute_id INT          NOT NULL REFERENCES lookup_attributes(id) ON DELETE CASCADE,
      value_id     VARCHAR(100),                -- PLM GlValId (standart) / ExtFldDropDownId (extended)
      name         VARCHAR(255) NOT NULL,
      code         VARCHAR(100),
      seq          INT          DEFAULT 0
    );

    -- Mevcut tabloda value_id yoksa ekle. Index DAHA SONRA oluşturulmalı,
    -- aksi halde eski schema üstünde "column does not exist" hatası verir.
    ALTER TABLE lookup_values ADD COLUMN IF NOT EXISTS value_id VARCHAR(100);

    CREATE INDEX IF NOT EXISTS idx_lookup_values_attr     ON lookup_values(attribute_id);
    CREATE INDEX IF NOT EXISTS idx_lookup_values_value_id ON lookup_values(value_id);

    CREATE TABLE IF NOT EXISTS lookup_meta (
      key   VARCHAR(50) PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  console.log("[db] Tables ready");
}

module.exports = { getPool, init };
