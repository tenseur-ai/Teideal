# ADR 0001: Service split, database, and API boundary

Status: Accepted
Applies from: TEID-41 (build order 1) onward

## Decision

**Two runtimes, one database, a stated contract between them.**

1. **Go** owns anything on the customer's usage/entitlement hot path: usage
   ingestion, the exactly-once ledger, and (from TEID-2 onward) real-time
   entitlement checks. This is where p99 latency and sustained concurrent
   throughput are hard requirements.
2. **TypeScript** (Node.js, Fastify) owns everything customer- or
   operator-facing that isn't in that hot path: the console, admin tooling,
   billing/usage views, the Stripe connector, and general CRUD APIs. Ordinary
   web-app latency is fine here; developer velocity matters more.
3. **PostgreSQL** is the single system of record for both. Row-level
   security (RLS) is the tenant-isolation mechanism, enforced in the
   database itself, not in either service's application code. See
   `docs/isolation-design.md` for the full design.
4. **Data ownership is per-table, not per-database.** Each table is owned
   by exactly one service. The other service never queries it directly —
   it goes through that owner's API. For TEID-41: Go owns `usage_events`;
   TypeScript owns `customers`. Both connect to the same Postgres instance
   under the same non-owner, non-superuser role (`teideal_app`), so RLS
   applies identically regardless of which language issued the query.
5. **API contract:**
   - **External/edge APIs** (browser console, customer-facing API,
     Stripe webhooks) are **REST over HTTPS with JSON**. Browsers and
     third-party integrators expect this; it is not the latency-critical
     path.
   - **Internal service-to-service calls** (e.g. the console asking Go for
     a ledger balance, or the ingestion path asking Go's own entitlement
     check) are **gRPC with protobuf schemas** checked into `/proto`,
     code-generated for Go (`protoc-gen-go`) and TypeScript (`ts-proto`).
     Rationale: a typed cross-language contract and binary framing cost
     less latency than REST/JSON, and gRPC's streaming support is a good
     fit for future usage-streaming needs. This keeps the boundary honest
     even where TEID-41 itself has no cross-service call yet — the two
     endpoints it introduces (`GET/POST/PATCH /customers`, `GET/POST
     /usage`) are each served entirely within their owning service, so no
     `/proto` contract is needed until a story requires one (expected at
     TEID-2, real-time entitlement checks).

## Why not one language

A single Node.js service is simpler to run but risks the p99 < 20ms
entitlement-check budget under GC pressure and doesn't give a clean seam
to swap in Go/Rust later without a rewrite. A single Go service is fine
for the hot path but slows down the console/CRUD/Stripe-integration
surface, which is where iteration speed matters most. Splitting along the
latency boundary, with the database (and RLS) as the actual enforcement
point rather than either language, gets both.

## Consequences

- Every tenant-scoped table needs RLS regardless of which service owns it
  — this is not optional per-service, it is a database-wide invariant
  checked by an automated audit (TEID-41-T1).
- Both services must implement the same per-request pattern: authenticate
  the caller, resolve its `tenant_id`, and `SET LOCAL app.tenant_id`
  inside the transaction before touching any tenant-scoped table. This is
  duplicated logic across two languages by design — the alternative
  (routing everything through one language) reopens the latency problem
  this split exists to avoid.
- Authentication in this story is a deliberately minimal API-key-to-tenant
  lookup (`api_keys` table), just enough to identify the calling tenant for
  the isolation tests. It is superseded, not duplicated, by TEID-92 (API
  key lifecycle: scoping, rotation, revocation) and TEID-43 (RBAC) when
  those stories are built.
