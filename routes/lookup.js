const express = require("express");
const router  = express.Router();
const lookup  = require("../lookup-storage");

// GET /api/lookup/all
//   { attributes: [...], lastRefreshedAt, stale }
router.get("/all", async (_req, res) => {
  try {
    const data = await lookup.getAll();
    res.json(data);
  } catch (err) {
    console.error("[lookup] getAll error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/lookup/refresh
//   body: { selectors: [...], costAttrs: [...] }
//   returns: { ok, lastRefreshedAt, count }
router.post("/refresh", async (req, res) => {
  try {
    const body = req.body || {};
    if (!Array.isArray(body.selectors) || !Array.isArray(body.costAttrs)) {
      return res.status(400).json({ error: "selectors[] and costAttrs[] are required" });
    }
    const out = await lookup.refresh(body);
    res.json(out);
  } catch (err) {
    console.error("[lookup] refresh error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
