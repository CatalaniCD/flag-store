# Intent: signal-store

Author: unassigned
Status: baseline, reverse-documented from the current implementation
Last updated: 2026-10-20

## Problem

Small scripts and automations need a tiny shared place to publish one JSON
document ("the latest signal") and read it back from anywhere, without
operating a database or a full application server. A general-purpose database,
object store, or feature-flag service is heavier than the requirement, which is
simply to replace and retrieve a single mutable document.

The operator also needs a cheap way to check whether the Worker is reachable and
whether a document has been saved.

## Proposed outcome

One Cloudflare Worker, `signal-store`, exposes three endpoints:

- `POST /store` replaces the latest JSON document. The write is protected by a
  shared secret when `WEBHOOK_SECRET` is configured.
- `GET /store` returns the latest document.
- `GET /health` reports whether a document exists and when it was last saved.

The Worker persists one document in the `SIGNAL_STORE` KV namespace under the
fixed key `latest_signal`. There is no server to manage and no build step:
Wrangler deploys the ESM source directly.

## Affected users and systems

- **API clients and scripts** that publish the latest signal.
- **Readers and monitoring probes** that retrieve the signal or call the health
  endpoint.
- **Cloudflare Workers runtime**, which executes `src/index.js`.
- **Cloudflare KV namespace `SIGNAL_STORE`**, which owns the persisted data.
- **Worker secret `WEBHOOK_SECRET`**, which gates writes when present.
- **Operators**, who deploy with Wrangler and own the KV namespace and secrets.

## Constraints

- Runtime: Cloudflare Workers, compatibility date `2024-01-01`.
- Storage: one KV namespace and one key (`latest_signal`); no relational queries,
  secondary indexes, or multi-document transactions.
- Auth: a shared secret supplied as the `x-secret` header or the top-level
  `secret` body field. Auth currently applies to writes only.
- Payload: any top-level JSON object. The top-level `secret` field is removed
  before the payload is stored.
- Framework: plain ESM with `itty-router` v5; no compilation or bundling step.
- Deployment: `wrangler dev` locally, `wrangler deploy` to Cloudflare.
- Public reads: `GET /store` and `GET /health` are currently unauthenticated.

## Explicitly out of scope

- Multiple documents, namespaces, tenants, or keys.
- Version history, audit trail, diffing, or rollback.
- User accounts, roles, OAuth, or per-client credentials.
- Schema validation beyond "the payload must be a JSON object".
- Notifications, webhooks out, analytics, or dashboards.
- Guaranteed read-after-write consistency across Cloudflare locations.

## Open questions

- Should `GET /store` require the same shared secret as `POST /store`?
- Should the Worker reject writes when `WEBHOOK_SECRET` is not configured, rather
  than allowing them through?
- Is Cloudflare KV's eventual consistency acceptable for readers, or is
  read-after-write required?
- What are the expected maximum payload size and write rate?
- Is the body-field secret required for compatibility, or should the header be
  the only accepted location?
- Who owns secret rotation, and how will readers learn about a rotation?
- What should the API return when KV is unavailable or times out?
