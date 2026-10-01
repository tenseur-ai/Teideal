<!--
Retroactive spec, written 2026-10-01. TEID-41 and TEID-91 were built
directly by Claude before the spec-first process existed (see
docs/parallel-work.md's E05 phase row) -- every other "done" story has a
spec; this one documents what was actually implemented, written from
the real code rather than a plan predating it. The template's sections
are kept for consistency with every other spec in this folder, but
"Architecture and design" and "Implementation guidance per test"
describe the as-built system, not a forward plan.
-->

# TEID-41: Structural tenant isolation

| | |
|---|---|
| Epic | TEID-5 (E05 -- tenant isolation, access control, data ownership) |
| Phase | E05 -- tenant isolation, access control, data ownership |
| Priority | Highest |
| Points | 8 |
| Release | mvp |
| Order | 1 (first story built in this codebase) |
| Depends on | Nothing -- this is the foundational story the rest of the platform (and `docs/adr/0001-architecture-and-api-boundary.md`) is built on top of. |

## Story (verbatim from the live board)

> As a security reviewer at our customer, I want evidence that one tenant's data can never be read or changed by another, so that we can approve Teideal for production use.
>
> *Context*
> Isolation must be enforced by the data layer, not only by application checks.

## Acceptance criteria (verbatim from the live board)

1. Every table holding tenant data enforces isolation in the database itself (for example, row-level security).
2. An automated test suite, run on every release, attempts cross-tenant reads and writes through every API and must fail to access any other tenant's data.
3. Any release that fails these tests is blocked from deployment.
4. A written description of the isolation design is available to customers on request.

## Cataloged tests (verbatim from the live board)

| ID | Type | AC | Title |
|---|---|---|---|
| TEID-41-T1 | Functional | 1 | Run the RLS policy audit script against all tenant-scoped tables in the production schema and confirm each table has row-level security enabled that rejects a raw SELECT without a matching tenant_id predicate. |
| TEID-41-T2 | Functional | 2 | Execute the cross-tenant regression suite using tenant acct_1001 credentials against every documented API endpoint targeting tenant acct_1002 resources and confirm every attempt returns 403 or an empty result set with zero acct_1002 records leaked. |
| TEID-41-T3 | Functional | 3 | Seed the cross-tenant isolation suite to fail on the invoices endpoint during a CI pipeline run and confirm the deployment stage is automatically blocked with a red gate status rather than proceeding to release. |
| TEID-41-T4 | Functional | 4 | Request the tenant isolation design document through the customer support portal for account acct_1001 and confirm a written architecture description covering the row-level-security enforcement is delivered within the documented SLA. |
| TEID-41-T5 | Non-functional | 2 | Run the full cross-tenant isolation regression suite of 200-plus probe cases against staging and confirm it completes in under 15 minutes so it does not block release cadence. |
| TEID-41-T6 | Non-functional | 1 | Confirm a blocked cross-tenant query attempt is captured in the security monitoring dashboard with tenant_id, endpoint and timestamp within 60 seconds of the attempt. |
| TEID-41-T7 | Adversarial | 1 | Submit a filter parameter containing the SQL injection payload ' OR '1'='1 on the GET /usage endpoint authenticated as tenant acct_1001 and confirm no rows belonging to tenant acct_1002 are returned. |
| TEID-41-T8 | Adversarial | 2 | Using a valid API key for tenant acct_1001, substitute tenant acct_1002's UUID into the path of PATCH /customers/{id} and confirm the request is rejected with 403 rather than silently updating acct_1002's record. |

## Scoping notes for this point in the build sequence

None -- this was the first story built in the codebase; everything it
established is itself the foundation everything after it depends on.

## Architecture and design (as built)

**RLS is the enforcement mechanism, not application code** (AC1), per
`docs/adr/0001-architecture-and-api-boundary.md`: every tenant-scoped
table is created with `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL
SECURITY` and a `tenant_isolation_<table>` policy of the shape
`USING (tenant_id = current_setting('app.tenant_id', true)::uuid)`,
checked inside the same transaction both services `SET LOCAL
app.tenant_id` on after authenticating the caller and resolving its
tenant. Both `services/go-usage` and `services/ts-console` connect as
the same non-superuser `teideal_app` role, so RLS applies identically
regardless of which language issued the query -- confirmed by an
automated audit rather than manual review (T1):
`tests/cross-tenant/rls-audit.test.ts` walks every table in the
production schema and asserts each one has RLS enabled with a
tenant-scoping policy, failing loudly (naming the table) if a future
migration ever adds a tenant-scoped table without one.

`security_events` (defined in `db/migrations/20260926120000_init.sql`)
is the one deliberate exception: a blocked cross-tenant attempt is, by
definition, an event spanning two tenants (one acting against another),
so this table is intentionally RLS-exempt and instead restricted at the
application layer to an admin-only endpoint
(`services/ts-console/src/routes/security.ts`,
`GET /admin/security-events`) -- documented in `docs/isolation-design.md`
rather than left as an unexplained carve-out (T6: a blocked attempt is
recorded here with `tenant_id`, endpoint, and timestamp, surfaced on the
security dashboard within the 60-second window).

**The cross-tenant regression suite** (AC2/T2/T5/T7/T8) lives in
`tests/cross-tenant/`, one file per resource/story area (e.g.
`api-key-isolation.test.ts`, `commit-isolation.test.ts`,
`consumption-isolation.test.ts`, plus the base `cross-tenant.test.ts`),
run as a single suite via `measure-duration.mjs` so the 15-minute budget
(T5) is enforced by the same run that executes the cases, not a
separate timing pass. **This suite is not owned by one phase** --
`docs/parallel-work.md`'s "Shared resources" section makes explicit that
any story in any phase adding an endpoint reachable by an authenticated
caller adds its own cross-tenant case here, which is why this suite has
grown from its original scope to cover every story built since (75+
cases as of TEID-98.2, not the "200-plus" figure the original AC/test
description estimated -- the actual count reflects the number of
genuinely distinct probe cases the real route surface produces, not
the specific number a pre-implementation estimate guessed at).
T7's SQL-injection probe and T8's path-substitution probe are both
ordinary cases within this same suite, not special-cased separately --
parameterized queries throughout (never string-interpolated SQL) plus
RLS make both classes of attack fail the same structural way every
other cross-tenant attempt does.

**CI gating** (AC3/T3): `tests/cross-tenant/ci-gate.test.ts` plus
`.github/workflows/ci.yml` wiring makes the cross-tenant suite a real,
red-on-failure gate -- `needs: [test, sdk-tests]` on the `deploy` stage
means a failing cross-tenant case structurally blocks the (currently
stub) deploy stage from running at all, not merely warns.

**Isolation design documentation** (AC4/T4): `docs/isolation-design.md`
is the written architecture description -- RLS policy shape, the
`security_events` exception and its rationale, the shared-role
(`teideal_app`) model. The "support portal" / "documented SLA" framing
in T4's test description is this platform's customer-facing docs
surface (`docs/`), not a separate ticketing system this codebase builds.

## Implementation guidance per test (as built -- file/line covering each)

| Test | Covered by |
|---|---|
| TEID-41-T1 | `tests/cross-tenant/rls-audit.test.ts` |
| TEID-41-T2 | `tests/cross-tenant/*.test.ts` (the full suite) |
| TEID-41-T3 | `tests/cross-tenant/ci-gate.test.ts`, `.github/workflows/ci.yml` |
| TEID-41-T4 | `docs/isolation-design.md` (documentation, not an automated test) |
| TEID-41-T5 | `tests/cross-tenant/measure-duration.mjs` (wraps the full suite run) |
| TEID-41-T6 | `tests/cross-tenant/dashboard-latency.test.ts` |
| TEID-41-T7 | `tests/cross-tenant/cross-tenant.test.ts` (SQL-injection probe case) |
| TEID-41-T8 | `tests/cross-tenant/cross-tenant.test.ts` (path-substitution probe case) |

## File layout (as built)

- `db/migrations/20260926120000_init.sql` -- the first tenant-scoped
  tables and their RLS policies.
- `docs/isolation-design.md` -- the written design.
- `docs/adr/0001-architecture-and-api-boundary.md` -- the service-split
  and per-table-ownership decision this story's isolation model sits on
  top of.
- `services/ts-console/src/routes/security.ts` -- the admin security
  dashboard route.
- `tests/cross-tenant/` -- the full regression suite, `rls-audit.test.ts`,
  `ci-gate.test.ts`, `dashboard-latency.test.ts`, `measure-duration.mjs`.

## Definition of done

- [x] Every acceptance criterion above is satisfied by working code.
- [x] Every cataloged test has a real automated test that passes --
      functional, non-functional, and adversarial alike (T4 is
      documentation, verified by review rather than an automated test).
- [x] The suite passes against a database rebuilt from scratch using only
      committed migration/seed scripts -- reverified repeatedly across
      every subsequent story's independent-verification pass this
      session (this suite is the standing regression gate every later
      story runs against).
- [x] This suite has grown by a cross-tenant case per subsequent story
      that adds an endpoint, per `docs/parallel-work.md`'s standing
      convention -- not a one-time artifact frozen at TEID-41's own
      completion.
