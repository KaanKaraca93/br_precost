const express = require("express");
const cors    = require("cors");
const path    = require("path");

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use("/api/ana-kumash",   require("./routes/ana-kumash"));
app.use("/api/lookup",       require("./routes/lookup"));
app.use("/api/cost-params",  require("./routes/cost-params"));

app.get("/api/health", (_req, res) =>
  res.json({ status: "ok", timestamp: new Date().toISOString() })
);

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function start() {
  if (process.env.DATABASE_URL) {
    const { init } = require("./db");
    await init();
  } else {
    console.log("[db] DATABASE_URL not set — using in-memory store");
  }
  app.listen(PORT, () => console.log(`PreCost backend on port ${PORT}`));
}

start().catch(err => {
  console.error("Startup failed:", err);
  process.exit(1);
});
