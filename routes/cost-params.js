// Generic parametre yönetimi route'u.
// Aynı storage tablolarını kullanır, sadece cost_category değişkeni değişir.
// /api/cost-params/<costCategory>/...
//
// Mevcut /api/ana-kumash/... route'u dokunulmadı (geriye dönük uyumluluk).
// Yeni kategoriler bu router üstünden çalışır.

const express = require("express");
const router  = express.Router({ mergeParams: true });
const storage = require("../storage");

const ALLOWED_CATEGORIES = new Set([
  "ana-kumash",
  "astar-garni",
  "iscilik",
  "uretim-paket",
  "malzeme",
]);

function sortedKey(arr) { return [...arr].sort().join("|"); }

// İlk middleware: kategori whitelist kontrolü
router.use("/:costCategory", (req, _res, next) => {
  if (!ALLOWED_CATEGORIES.has(req.params.costCategory)) {
    const err = new Error("Unknown costCategory: " + req.params.costCategory);
    err.status = 400;
    return next(err);
  }
  req.costCategory = req.params.costCategory;
  next();
});

// GET /api/cost-params/:costCategory/list
router.get("/:costCategory/list", async (req, res) => {
  try {
    res.json(await storage.listConfigs(req.costCategory));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cost-params/:costCategory/lookup-bulk
router.post("/:costCategory/lookup-bulk", async (req, res) => {
  const { season, brands, categories } = req.body || {};
  if (!season || !Array.isArray(brands) || !Array.isArray(categories) ||
      brands.length === 0 || categories.length === 0) {
    return res.status(400).json({ error: "season, brands[], categories[] are required" });
  }
  try {
    res.json(await storage.lookupBulk(req.costCategory, season, brands, categories));
  } catch (err) {
    console.error("[cost-params][lookup-bulk]", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cost-params/:costCategory/config/:season/:brand/:styleCategory
router.get("/:costCategory/config/:season/:brand/:styleCategory", async (req, res) => {
  const { season, brand, styleCategory } = req.params;
  try {
    const config = await storage.getConfig(req.costCategory, season, brand, styleCategory);
    res.json(config || { selectedAttrs: [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cost-params/:costCategory/config/:season/:brand/:styleCategory
router.post("/:costCategory/config/:season/:brand/:styleCategory", async (req, res) => {
  const { season, brand, styleCategory } = req.params;
  const { selectedAttrs } = req.body || {};
  if (!Array.isArray(selectedAttrs)) {
    return res.status(400).json({ error: "selectedAttrs must be an array" });
  }
  try {
    const existing = await storage.getConfig(req.costCategory, season, brand, styleCategory);
    const attrsChanged = existing !== null &&
      sortedKey(existing.selectedAttrs) !== sortedKey(selectedAttrs);

    if (attrsChanged) {
      await storage.deleteAllValues(req.costCategory, season, brand, styleCategory);
    }
    await storage.saveConfig(req.costCategory, season, brand, styleCategory, selectedAttrs);
    res.json({ success: true, selectedAttrs, valuesReset: attrsChanged });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cost-params/:costCategory/values/:season/:brand/:styleCategory
router.get("/:costCategory/values/:season/:brand/:styleCategory", async (req, res) => {
  const { season, brand, styleCategory } = req.params;
  try {
    res.json(await storage.getValues(req.costCategory, season, brand, styleCategory));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cost-params/:costCategory/values/:season/:brand/:styleCategory
// Değişen / yeni değerleri upsert eder, dokunulmayanları korur.
router.post("/:costCategory/values/:season/:brand/:styleCategory", async (req, res) => {
  const { season, brand, styleCategory } = req.params;
  const { values } = req.body || {};
  if (!Array.isArray(values)) {
    return res.status(400).json({ error: "values must be an array" });
  }
  try {
    await storage.bulkSaveValues(req.costCategory, season, brand, styleCategory, values);
    res.json({ success: true, count: values.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
