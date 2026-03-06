/**
 * Cloudflare Worker — Stateful JSON Store (KV-backed)
 * Router: itty-router (Express-style)
 *
 * POST /store   – save a JSON payload to KV (protected by WEBHOOK_SECRET)
 * GET  /store   – retrieve the last saved JSON payload from KV
 * GET  /health  – health check
 *
 * ─── Environment Variables (Cloudflare Dashboard → Settings → Variables) ────
 *   WEBHOOK_SECRET   – shared secret, send as header "x-secret" or body field
 *
 * ─── KV Binding (wrangler.toml) ──────────────────────────────────────────────
 *   Binding name: SIGNAL_STORE
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { AutoRouter, json, error } from "itty-router";

const KV_KEY = "latest_signal";

// ─── Router ───────────────────────────────────────────────────────────────────

const router = AutoRouter();

// ─── Middleware — auth ────────────────────────────────────────────────────────

async function requireSecret(request, env) {
  // Parse and cache body so handlers can reuse it
  try {
    request.data = await request.json();
  } catch {
    return error(400, { error: "Invalid JSON body" });
  }

  const secret = request.headers.get("x-secret") || request.data?.secret;
  if (env.WEBHOOK_SECRET && secret !== env.WEBHOOK_SECRET) {
    return error(401, { error: "Unauthorized" });
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /health
router.get("/health", async (request, env) => {
  const entry = await env.SIGNAL_STORE.getWithMetadata(KV_KEY);

  return json({
    status:  "ok",
    hasData: entry.value !== null,
    savedAt: entry.metadata?.savedAt ?? null,
    time:    new Date().toISOString(),
  });
});

// POST /store — save payload to KV
router.post("/store", requireSecret, async (request, env) => {
  const { secret: _omit, ...data } = request.data;

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return error(400, { error: "Body must be a JSON object" });
  }

  const savedAt = new Date().toISOString();

  await env.SIGNAL_STORE.put(KV_KEY, JSON.stringify(data), {
    metadata: { savedAt },
  });

  return json({ success: true, savedAt, data }, { status: 201 });
});

//router.get("/store", requireSecret, async (request, env) => {
// const { secret: _omit, ...data } = request.data;

// GET /store — retrieve latest payload from KV
router.get("/store", async (request, env) => {

  const entry = await env.SIGNAL_STORE.getWithMetadata(KV_KEY, { type: "json" });

  if (entry.value === null) {
    return error(404, { error: "No data stored yet" });
  }

  return json({
    success: true,
    savedAt: entry.metadata?.savedAt ?? null,
    data:    entry.value,
  });
});

// ─── Catch-all 404 ────────────────────────────────────────────────────────────

router.all("*", () => error(404, { error: "Not found" }));

// ─── Export ───────────────────────────────────────────────────────────────────

export default router;
