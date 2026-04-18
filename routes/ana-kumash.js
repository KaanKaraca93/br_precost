const express = require("express");
const router  = express.Router();
const storage = require("../storage");

function sortedKey(arr) {
  return [...arr].sort().join("|");
}
const { getCostAttributes } = require("../attributes");

const COST_CATEGORY = "ana-kumash";

// GET /api/ana-kumash/attributes
// Maliyet parametresi olarak kullanılabilecek attribute adları ve değerlerini döner
router.get("/attributes", (req, res) => {
  res.json(getCostAttributes());
});

// GET /api/ana-kumash/list
// Kayıtlı tüm sezon/marka/kategori kombinasyonlarını listeler
router.get("/list", async (req, res) => {
  try {
    const list = await storage.listConfigs(COST_CATEGORY);
    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ana-kumash/config/:season/:brand/:styleCategory
// Bir kombinasyon için seçili attribute'ları döner
router.get("/config/:season/:brand/:styleCategory", async (req, res) => {
  const { season, brand, styleCategory } = req.params;
  try {
    const config = await storage.getConfig(COST_CATEGORY, season, brand, styleCategory);
    res.json(config || { selectedAttrs: [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ana-kumash/config/:season/:brand/:styleCategory
// Seçili attribute'ları kaydeder.
// Attribute listesi değiştiyse o kombinasyonun tüm sarf değerleri silinir.
router.post("/config/:season/:brand/:styleCategory", async (req, res) => {
  const { season, brand, styleCategory } = req.params;
  const { selectedAttrs } = req.body;

  if (!Array.isArray(selectedAttrs)) {
    return res.status(400).json({ error: "selectedAttrs must be an array" });
  }

  const ATTRIBUTES = getCostAttributes();
  const invalid = selectedAttrs.filter(a => !ATTRIBUTES[a]);
  if (invalid.length > 0) {
    return res.status(400).json({ error: `Unknown attributes: ${invalid.join(", ")}` });
  }

  try {
    const existing = await storage.getConfig(COST_CATEGORY, season, brand, styleCategory);

    // Attribute listesi değiştiyse tüm sarf değerlerini temizle
    const attrsChanged =
      existing !== null &&
      sortedKey(existing.selectedAttrs) !== sortedKey(selectedAttrs);

    if (attrsChanged) {
      await storage.deleteAllValues(COST_CATEGORY, season, brand, styleCategory);
    }

    await storage.saveConfig(COST_CATEGORY, season, brand, styleCategory, selectedAttrs);
    res.json({ success: true, selectedAttrs, valuesReset: attrsChanged });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ana-kumash/values/:season/:brand/:styleCategory
// Bir kombinasyon için tüm sarf değerlerini döner
router.get("/values/:season/:brand/:styleCategory", async (req, res) => {
  const { season, brand, styleCategory } = req.params;
  try {
    const values = await storage.getValues(COST_CATEGORY, season, brand, styleCategory);
    res.json(values);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ana-kumash/values/:season/:brand/:styleCategory
// Tüm sarf değerlerini toplu kaydeder (upsert)
// Body: { values: [{ attrCombo: {}, consumption: 2.1, unit: "m" }] }
router.post("/values/:season/:brand/:styleCategory", async (req, res) => {
  const { season, brand, styleCategory } = req.params;
  const { values } = req.body;

  if (!Array.isArray(values)) {
    return res.status(400).json({ error: "values must be an array" });
  }

  try {
    await storage.bulkSaveValues(COST_CATEGORY, season, brand, styleCategory, values);
    res.json({ success: true, saved: values.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
