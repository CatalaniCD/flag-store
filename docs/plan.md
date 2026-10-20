# Plan: signal-store hardening and verification

Status: proposed
Last updated: 2026-10-20
Related: [intent.md](intent.md), [design.md](design.md), [test.md](test.md)

## Purpose

The current Worker implements the core behavior, but the design assessment in
[design.md](design.md) identifies correctness, security, and verification gaps.
This plan closes those gaps in small, independently verifiable steps.

The plan does not introduce new runtime components. If a step changes the trust
boundary or the public API, return to `design.md` and record the decision before
changing code.

## Ground rules

- Keep each step independently reviewable and reversible.
- Preserve existing endpoint names unless a decision in Phase 2 changes them.
- Add a failing test before changing behavior.
- Never commit secrets or real KV identifiers to tests.
- Update `design.md` when behavior, contracts, or diagrams change.
- Run `npm test` before reporting a step complete.

## Phase 0: Documentation baseline

- [x] Add `docs/intent.md`.
- [x] Add `docs/design.md` with system context, write path, read paths, state
  lifecycle, data model, and architecture assessment.
- [x] Add `docs/plan.md`.
- [x] Add `docs/test.md`.
- [x] Add root `README.md`.

Verification: all five files exist, links resolve, and Mermaid blocks render in
the Markdown preview or diagram CI.

## Phase 1: Verification harness

Goal: make the current behavior testable without changing production code.

1. [ ] Add `test/worker.test.js` using the built-in `node:test` and
   `node:assert/strict` modules.
2. [ ] Add a fake `SIGNAL_STORE` binding that implements `getWithMetadata` and
   `put` against an in-memory `Map`.
3. [ ] Import the default router from `src/index.js` and invoke
   `router.fetch(new Request(...), env)` in tests.
4. [ ] Add `"test": "node --test"` to `package.json`.
5. [ ] Add characterization tests for current behavior:
   - `GET /health` with no data.
   - `GET /health` with data.
   - `GET /store` with no data.
   - `GET /store` with data.
   - `POST /store` with a valid body and a matching header secret.
   - `POST /store` with a matching body secret.
   - `POST /store` with a missing or wrong secret when `WEBHOOK_SECRET` is set.
   - `POST /store` with invalid JSON.
   - Unknown route returns the catch-all 404.

Verification: `npm test` passes, and the test output lists each case by name.
No production behavior changes in this phase.

## Phase 2: Resolve auth and access policy

Goal: make the security contract explicit before changing code. This is a human
decision gate, not an agent-only change.

1. [ ] Decide whether `GET /store` requires a secret.
2. [ ] Decide whether the Worker fails closed when `WEBHOOK_SECRET` is missing or
   empty.
3. [ ] Decide whether the body-field secret remains supported or the header is
   the only accepted location.
4. [ ] Decide whether reads need a separate secret or the same one.
5. [ ] Record the decisions in the ADR-lite section of `design.md`.
6. [ ] Update `intent.md` constraints and open questions.
7. [ ] Update the diagrams if a new auth edge is added.

Verification: the decisions are written down, the affected tests have agreed
expected results, and no code is merged before this phase is complete.

## Phase 3: Fix payload validation

Goal: accept only top-level JSON objects and reject every other JSON value with a
stable `400` response.

1. [ ] Add failing tests for `null`, arrays, strings, numbers, and booleans.
2. [ ] Validate `request.data` before destructuring or spreading it.
3. [ ] Accept only non-null, non-array objects.
4. [ ] Remove the top-level `secret` field only after validation succeeds.
5. [ ] Return `400 {"error":"Body must be a JSON object"}` for every rejected
   payload.

Verification: `npm test` passes; manual `curl` checks for `null`, `[]`, `"text"`,
`42`, and `true` all return 400 and do not modify KV.

## Phase 4: Harden write authentication

Goal: enforce the policy chosen in Phase 2.

1. [ ] Add tests for missing secret, empty secret, wrong secret, and correct
   secret when `WEBHOOK_SECRET` is set.
2. [ ] Add tests for the `WEBHOOK_SECRET`-unset case with the chosen fail-open or
   fail-closed behavior.
3. [ ] If fail-closed is chosen, reject writes with `500` or `503` when the
   secret is not configured. Do not silently accept them.
4. [ ] If header-only is chosen, stop reading `body.secret` and update the API
   contract.
5. [ ] If constant-time comparison is required, use a Workers-compatible
   constant-time comparison helper and test it.

Verification: `npm test` passes; a deployment without `WEBHOOK_SECRET` behaves as
documented; a wrong secret returns 401 and does not write.

## Phase 5: Define the KV failure contract

Goal: return a stable JSON response when KV is unavailable.

1. [ ] Add tests with a fake KV binding whose `getWithMetadata` or `put` throws.
2. [ ] Wrap KV calls in the store and health handlers.
3. [ ] Return a documented error, for example
   `503 {"error":"Storage unavailable"}`.
4. [ ] Ensure `GET /health` reports a failure status when KV fails rather than
   `status: "ok"`.
5. [ ] Update `design.md` API contracts, failure modes, and diagrams if a new
   error path is added.

Verification: `npm test` passes; the failure response shape is identical across
`GET /store`, `POST /store`, and `GET /health`.

## Phase 6: Read access control (conditional)

Execute only if Phase 2 chose to protect `GET /store`.

1. [ ] Return to `design.md` and add the read-auth edge to the context diagram.
2. [ ] Refactor the auth logic so body parsing is not required for GET requests.
3. [ ] Add a read guard that reads the `x-secret` header and compares it to
   `WEBHOOK_SECRET`.
4. [ ] Add tests for 401 without a secret and 200 with a valid secret.
5. [ ] Update `README.md` and `test.md` examples.

Verification: `GET /store` without a secret returns 401; with the correct secret
it returns the stored document; `GET /health` behavior is unchanged.

## Phase 7: Observability

1. [ ] Log one structured record per write outcome and per auth failure.
2. [ ] Log KV errors with the route, status, and a request identifier such as
   the Cloudflare `cf-ray` header.
3. [ ] Never log the shared secret or the stored payload.
4. [ ] Verify with `npx wrangler tail` during a local or staging run.

Verification: logs are valid JSON, contain no secret or payload, and include
enough context to correlate a failure with a request.

## Phase 8: CI and static checks

1. [ ] Add a `check` script that runs `node --check src/index.js` and
   `npm test`.
2. [ ] Add a GitHub Actions workflow that runs `npm ci`, `npm run check`, and
   `npx wrangler deploy --dry-run --outdir=dist`.
3. [ ] Ensure the workflow does not require a real KV namespace or production
   secret.
4. [ ] Require the workflow to pass before merging.

Verification: the workflow passes on a pull request and on the default branch.

## Phase 9: Release and smoke test

1. [ ] Set `WEBHOOK_SECRET` with `wrangler secret put` before deploying a
   fail-closed build.
2. [ ] Deploy to a staging Worker or preview environment.
3. [ ] Run the smoke checklist in [test.md](test.md).
4. [ ] Deploy to production with `npm run deploy`.
5. [ ] Re-run the health and read smoke checks.
6. [ ] Tag the release and keep the previous version available for rollback.

Verification: the smoke checklist passes, and `GET /health` reports the expected
data state.

## Traceability

| Plan phase | Design reference | Primary verification |
| --- | --- | --- |
| 1 | `design.md` 2.1-2.5, 3.1-3.4 | `npm test` characterization suite |
| 2 | `design.md` 6.4, 6.5, 7 (D-002) | Written ADR decision and agreed tests |
| 3 | `design.md` 3.1, 5, 8 (gap 3) | Non-object payload tests and curl checks |
| 4 | `design.md` 2.2, 5, 8 (gaps 1, 11) | Auth matrix tests |
| 5 | `design.md` 3.1-3.3, 5, 8 (gap 4) | Throwing-KV tests |
| 6 | `design.md` 2.1, 6.4, 8 (gap 2) | Read-auth tests if approved |
| 7 | `design.md` 6.4, 8 (gap 10) | `wrangler tail` inspection |
| 8 | `design.md` 6.6, test.md | CI green |
| 9 | `test.md` smoke checklist | Staging and production checks |

## Rollback and compatibility notes

- Fail-closed auth can break existing deployments that never set
  `WEBHOOK_SECRET`. Set the secret before deploying, or roll out the change with
  a documented migration.
- Adding read auth can break existing readers. Announce the change and provide
  the secret to all clients first.
- Changing KV failure responses can break clients that assume a generic 500.
  Update the contract and clients together.
- Use `wrangler rollback` or redeploy the previous Worker version if a release
  fails. KV data is not versioned by the Worker, so a code rollback does not
  restore an overwritten document.

## Definition of done

- [ ] Phases 1-5 are complete; Phase 6 is complete or explicitly rejected.
- [ ] All automated tests pass.
- [ ] The auth and access decisions are recorded in `design.md`.
- [ ] `README.md`, `design.md`, and `test.md` match the shipped behavior.
- [ ] CI is green.
- [ ] The smoke checklist passes in staging and production.
- [ ] No secret or real payload appears in logs, tests, or documentation.
