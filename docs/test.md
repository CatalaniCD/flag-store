# Test: signal-store

Status: baseline, no automated tests configured
Last updated: 2026-10-20
Related: [intent.md](intent.md), [design.md](design.md), [plan.md](plan.md)

## 1. Current state

- There is no test directory, test script, or CI workflow.
- `package.json` exposes only `dev` and `deploy`.
- Verification is currently manual through `wrangler dev` and `curl`.
- The behavior implemented in `src/index.js` is small enough for fast unit
  tests, but several edge cases are currently broken or undefined.

This document defines the intended test strategy and the cases that must exist
before the hardening plan is considered complete.

## 2. Test strategy

Use three layers, cheapest first:

1. **Unit and characterization tests** with Node's built-in `node:test` runner.
   Import the default router, construct `Request` objects, and pass a fake
   `env` with an in-memory KV binding. No new dependency and no network.
2. **Worker runtime integration tests** (optional follow-up) with Miniflare or
   `@cloudflare/vitest-pool-workers` to validate real Workers APIs, KV binding
   behavior, and response serialization.
3. **Deployment smoke tests** against a staging Worker, using the checklist in
   section 7.

The unit layer is the required gate. The integration layer is recommended once
the auth and error contracts stabilize.

## 3. Test harness contract

The Worker exports the router as its default export, so tests can call:

```js
const response = await router.fetch(request, env);
```

The fake environment must provide:

```js
{
  WEBHOOK_SECRET: "test-secret",
  SIGNAL_STORE: {
    async getWithMetadata(key, options) {},
    async put(key, value, options) {},
  },
}
```

Fake KV requirements:

- `put` stores the serialized value and the supplied metadata in memory.
- `getWithMetadata(key)` returns `{ value, metadata }`, where `value` is the
  stored string or `null`.
- `getWithMetadata(key, { type: "json" })` returns the parsed JSON value or
  `null`.
- The fake can be configured to throw from `getWithMetadata` or `put` for
  failure tests.
- The fake must not use the real `SIGNAL_STORE` namespace or any production
  secret.

A minimal test named `GET /health reports empty state` should assert:

- status `200`;
- `status === "ok"`;
- `hasData === false`;
- `savedAt === null`;
- `time` is a valid ISO-8601 string.

## 4. Test matrix

Legend: **Pass** means the current implementation is expected to satisfy the
case. **Fail** means the case documents a known gap. **Policy** means the
expected result depends on the Phase 2 decision.

### 4.1 Health

| ID | Case | Setup and request | Expected | Current |
| --- | --- | --- | --- | --- |
| H-1 | Empty store | `GET /health`, KV key absent | 200, `hasData:false`, `savedAt:null`, `status:"ok"` | Pass |
| H-2 | Populated store | Seed `latest_signal` with metadata; `GET /health` | 200, `hasData:true`, `savedAt` matches metadata | Pass |
| H-3 | Missing metadata | Seed value without metadata; `GET /health` | 200, `hasData:true`, `savedAt:null` | Pass |
| H-4 | KV read failure | Fake KV throws on `getWithMetadata`; `GET /health` | 503 JSON error, not `status:"ok"` | Fail |
| H-5 | Response shape | Any successful health request | JSON with `status`, `hasData`, `savedAt`, `time` | Pass |

### 4.2 Read document

| ID | Case | Setup and request | Expected | Current |
| --- | --- | --- | --- | --- |
| R-1 | Empty store | `GET /store`, KV key absent | 404 `{"error":"No data stored yet"}` | Pass |
| R-2 | Populated store | Seed object; `GET /store` | 200, `success:true`, `data` matches, `savedAt` matches | Pass |
| R-3 | Missing metadata | Seed value without metadata; `GET /store` | 200, `savedAt:null` | Pass |
| R-4 | JSON payload type | Seed serialized object; `GET /store` | Parsed object, not a JSON string | Pass |
| R-5 | KV read failure | Fake KV throws; `GET /store` | 503 JSON error | Fail |
| R-6 | Read auth | No secret; `GET /store` | Policy: 200 today, possibly 401 if read auth is adopted | Policy |

### 4.3 Write authentication

All cases use a valid object body unless stated.

| ID | Case | Setup and request | Expected | Current |
| --- | --- | --- | --- | --- |
| A-1 | Header secret | `WEBHOOK_SECRET="s"`, `x-secret: s` | 201 and document stored | Pass |
| A-2 | Body secret | `WEBHOOK_SECRET="s"`, body contains `"secret":"s"` | 201; stored document has no top-level `secret` | Pass |
| A-3 | Wrong secret | `WEBHOOK_SECRET="s"`, `x-secret: wrong` | 401, no write | Pass |
| A-4 | Missing secret | `WEBHOOK_SECRET="s"`, no header or body secret | 401, no write | Pass |
| A-5 | Secret unset | `WEBHOOK_SECRET` absent, no secret | Policy: currently 201 (fail-open) | Policy |
| A-6 | Secret empty | `WEBHOOK_SECRET=""`, no secret | Policy: currently 201 (fail-open) | Policy |
| A-7 | Header precedence | Header wrong, body correct | 401; header takes precedence | Pass |
| A-8 | Header correct, body secret present | Header correct, body secret different | 201; body `secret` stripped | Pass |
| A-9 | Secret not persisted | Any successful authenticated write | Stored payload has no top-level `secret` key | Pass |
| A-10 | Nested secret preserved | Body has `{"meta":{"secret":"keep"}}` | Nested field is preserved; only top-level is stripped | Pass |

### 4.4 Write payload validation

Use header auth to reach the handler, or unset `WEBHOOK_SECRET`.

| ID | Case | Request body | Expected | Current |
| --- | --- | --- | --- | --- |
| V-1 | Valid object | `{"a":1}` | 201; stored `{"a":1}` | Pass |
| V-2 | Empty object | `{}` | 201; stored `{}` | Pass |
| V-3 | Invalid JSON | `{not json` | 400 `{"error":"Invalid JSON body"}` | Pass |
| V-4 | Null | `null` | 400 `{"error":"Body must be a JSON object"}` | Fail (500 or 401 depending on auth) |
| V-5 | Array | `[1,2]` | 400, no write | Fail (currently coerced to `{"0":1,"1":2}`) |
| V-6 | String | `"hello"` | 400, no write | Fail (currently coerced to a character-index object) |
| V-7 | Number | `42` | 400, no write | Fail (currently coerced to `{}`) |
| V-8 | Boolean | `true` | 400, no write | Fail (currently coerced to `{}`) |
| V-9 | Top-level secret stripped | `{"secret":"s","a":1}` | 201; stored `{"a":1}` | Pass |
| V-10 | Unknown content type | `Content-Type: text/plain`, valid JSON | Policy: currently 201; decide whether to require JSON | Policy |
| V-11 | Duplicate keys | `{"a":1,"a":2}` | Parsed JSON behavior: last key wins | Pass |

The V-4 through V-8 failures are caused by spreading the parsed body before
checking that it is an object (`src/index.js:57-61`). Fix these in Phase 3 of the
plan.

### 4.5 Routing and method handling

| ID | Case | Request | Expected | Current |
| --- | --- | --- | --- | --- |
| RT-1 | Unknown path | `GET /missing` | 404 `{"error":"Not found"}` | Pass |
| RT-2 | Unsupported method on known path | `PUT /store` | 404 `{"error":"Not found"}` | Pass |
| RT-3 | Trailing slash | `GET /store/` | Policy: likely 404; document the chosen behavior | Policy |
| RT-4 | Case sensitivity | `GET /Store` | 404 | Pass |
| RT-5 | Health method | `POST /health` | 404 | Pass |

### 4.6 KV and dependency failures

| ID | Case | Setup | Expected | Current |
| --- | --- | --- | --- | --- |
| K-1 | Write failure | Fake `put` throws | 503 JSON error, no success payload | Fail |
| K-2 | Read failure on store | Fake `getWithMetadata` throws on `GET /store` | 503 JSON error | Fail |
| K-3 | Read failure on health | Fake `getWithMetadata` throws on `GET /health` | 503 JSON error | Fail |
| K-4 | Malformed stored JSON | Seed invalid JSON, request `GET /store` with JSON type | 503 JSON error, not an unhandled 500 | Fail |
| K-5 | Health after write failure | Write fails, then `GET /health` | `hasData` reflects actual state; no false success | Policy |

### 4.7 Data semantics

| ID | Case | Setup and request | Expected | Current |
| --- | --- | --- | --- | --- |
| D-1 | Overwrite | Two valid writes | Second write replaces the first | Pass |
| D-2 | Saved timestamp | Valid write | `savedAt` is ISO-8601 and matches KV metadata | Pass |
| D-3 | Single key | Any write | Only `latest_signal` is touched | Pass |
| D-4 | No history | Two writes | Only the latest document is readable; no history endpoint | Pass |
| D-5 | Eventual consistency | Read immediately after write across locations | Stale reads are possible; not asserted in unit tests | Not testable locally |

## 5. Commands

Planned commands after Phase 1:

```bash
npm test
node --test test/worker.test.js
npm run check
```

Manual local verification:

```bash
npm run dev
```

Examples, assuming a local URL of `http://localhost:8787`:

```bash
curl -s http://localhost:8787/health

curl -s -X POST http://localhost:8787/store \
  -H 'content-type: application/json' \
  -H 'x-secret: test-secret' \
  -d '{"message":"hello","value":1}'

curl -s http://localhost:8787/store

curl -s -X POST http://localhost:8787/store \
  -H 'content-type: application/json' \
  -d '{"message":"no secret"}'

curl -s -X POST http://localhost:8787/store \
  -H 'content-type: application/json' \
  -H 'x-secret: test-secret' \
  -d 'null'
```

Deployment validation:

```bash
npx wrangler deploy --dry-run --outdir=dist
npx wrangler tail
```

## 6. CI requirements

Add a workflow that runs on pull requests and on the default branch:

1. `npm ci`
2. `npm run check` (syntax check plus `npm test`)
3. `npx wrangler deploy --dry-run --outdir=dist`

The workflow must not require a real KV namespace, production secret, or network
access to Cloudflare. Keep deployment credentials out of pull-request runs.

Recommended later additions:

- A Miniflare or Workerd integration job.
- A check that every Mermaid block in `docs/` parses.
- Dependency audit and secret scanning.

## 7. Staging and production smoke checklist

Run after every deploy that changes routing, auth, storage, or response shapes.

- [ ] `GET /health` returns 200 and a valid ISO `time`.
- [ ] `GET /health` reports the correct `hasData` before and after a write.
- [ ] `POST /store` with the configured secret returns 201.
- [ ] `GET /store` returns the written object.
- [ ] The returned object does not contain the top-level `secret` field.
- [ ] `POST /store` without a secret returns 401 (if fail-closed is adopted).
- [ ] `POST /store` with invalid JSON returns 400.
- [ ] `POST /store` with `null`, an array, a string, a number, and a boolean
  returns 400 (after Phase 3).
- [ ] An unknown route returns 404 with `{"error":"Not found"}`.
- [ ] `savedAt` in `GET /store` and `GET /health` matches the last write.
- [ ] No secret or payload appears in `wrangler tail` logs.

## 8. Coverage gaps and risks

- **No tests exist yet.** Everything in section 4 is a target, not current
  coverage.
- **Fake KV is not Cloudflare KV.** It can model `getWithMetadata` and `put`, but
  not eventual consistency, quotas, or network timeouts. Use Miniflare or
  Workerd tests for runtime fidelity.
- **Auth timing is not covered.** A unit test cannot meaningfully prove
  constant-time comparison.
- **Concurrency is not covered.** Last-write-wins is documented behavior; there
  is no conflict-resolution test.
- **CORS and browser behavior are not covered.** There are no CORS headers to
  test yet.
- **Performance and load are not covered.** KV latency and Worker CPU limits are
  platform concerns.
- **No schema tests.** The payload is intentionally opaque, so only the
  top-level object rule is tested.
- **No secret rotation test.** Rotation is an operator procedure, not Worker
  behavior.

## 9. Exit criteria for this test plan

- `npm test` exists and passes.
- Every **Pass** and **Fail** row in section 4 has an automated test.
- Every **Policy** row is either resolved with a test or explicitly marked as
  deferred with a design decision.
- The smoke checklist passes in staging.
- CI runs the tests and the Wrangler dry-run deploy on every pull request.
