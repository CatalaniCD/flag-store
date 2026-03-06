/**
 * Express.js — JSON Store Worker
 *
 * POST /store        – save a JSON payload (protected by WEBHOOK_SECRET)
 * GET  /store        – retrieve the last saved JSON payload
 * GET  /health       – health check
 *
 * ─── Environment Variables (.env) ────────────────────────────────────────────
 *   WEBHOOK_SECRET   – shared secret required on POST requests
 *   PORT             – port to listen on (default: 3000)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import express from "express";
import dotenv  from "dotenv";

dotenv.config();

const app       = express();
const PORT      = process.env.PORT || 3000;
const WH_SECRET = process.env.WEBHOOK_SECRET;

app.use(express.json());

// ─── In-memory store ──────────────────────────────────────────────────────────

let store = {
  data:      null,
  savedAt:   null,
};

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get("/health", (req, res) => {
  res.json({
    status:  "ok",
    hasData: store.data !== null,
    savedAt: store.savedAt,
    time:    new Date().toISOString(),
  });
});

// POST /store — save JSON payload
app.post("/store", (req, res) => {
  // Validate shared secret (from header or body)
  const secret = req.headers["x-secret"] || req.body?.secret;
  if (WH_SECRET && secret !== WH_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const payload = req.body;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return res.status(400).json({ error: "Body must be a JSON object" });
  }

  // Strip secret field from stored data if it was in the body
  const { secret: _omit, ...data } = payload;

  store.data    = data;
  store.savedAt = new Date().toISOString();

  console.log(`[STORE] Saved at ${store.savedAt}:`, data);

  return res.status(201).json({
    success: true,
    savedAt: store.savedAt,
    data,
  });
});

// GET /store — retrieve last saved payload
app.get("/store", (req, res) => {
  if (store.data === null) {
    return res.status(404).json({ error: "No data stored yet" });
  }

  return res.json({
    success: true,
    savedAt: store.savedAt,
    data:    store.data,
  });
});

// ─── Start server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`
  ┌─────────────────────────────────────────┐
  │   JSON Store Worker                     │
  │   Listening on http://localhost:${PORT}   │
  │                                         │
  │   POST /store  →  save JSON payload     │
  │   GET  /store  →  retrieve payload      │
  │   GET  /health →  health check          │
  └─────────────────────────────────────────┘
  `);
});

export default app;
