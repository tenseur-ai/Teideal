# Teideal tenant isolation design

This document is available to customers on request (self-serve, via
`GET /support/isolation-design-doc`, or through our human support channel)
and is the answer we give a security reviewer asking how one tenant's data
is kept from another's.

## Summary

Isolation is enforced by the database, not by application code. Every
tenant-scoped table has PostgreSQL row-level security (RLS) enabled, and
every request -- regardless of which internal service handles it, or which
language that service is written in -- must establish a tenant context
before it can touch a tenant-scoped table. If that context is missing,
queries return zero rows and writes are rejected; there is no code path
that defaults to open.

## How it works

1. **Every tenant-scoped table** carries a `tenant_id` column, has
   `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` set, and has
   a policy of the shape:

   ```sql
   CREATE POLICY tenant_isolation_<table> ON <table>
     USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
     WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
   ```

   `USING` filters what a query can read (and what an `UPDATE`/`DELETE` can
   even see to act on); `WITH CHECK` additionally blocks a write from
   *creating or retargeting* a row into another tenant. Both clauses matter:
   without `WITH CHECK`, a crafted `INSERT ... tenant_id = <someone else>`
   would be allowed by `USING` alone.

2. **The application role is not the table owner and cannot bypass RLS.**
   Migrations run as a separate owning role; the services connect as
   `teideal_app`, which is `NOSUPERUSER` and `NOBYPASSRLS`. Postgres never
   exempts a non-owner, non-bypass role from its table's policies, so this
   holds regardless of what the application code does.

3. **The tenant context is set once per request, inside a transaction,**
   via `SELECT set_config('app.tenant_id', $1, true)`, where `$1` is always
   a bind parameter carrying the tenant ID resolved from the caller's
   authenticated identity -- never a value taken from the request body or
   URL. The `true` argument makes the setting transaction-local: it cannot
   leak into another request that happens to reuse the same pooled
   connection.

4. **Fail closed.** `current_setting('app.tenant_id', true)` returns `NULL`
   when unset, and `tenant_id = NULL` is never true in SQL. A request that
   somehow reached a query without setting its tenant context would see
   zero rows and write zero rows -- not another tenant's data, and not an
   error that might get caught and ignored.

5. **The same rule applies across both of our services.** Teideal's usage
   and ledger service is written in Go; its console, customer-facing and
   admin surface is written in TypeScript. Both connect to the same
   PostgreSQL instance under the same `teideal_app` role, and both
   implement the identical per-request pattern (resolve tenant -> open
   transaction -> set tenant context -> query). The isolation guarantee
   comes from the database and the role, not from either language's
   application code, so it does not weaken at the boundary between them.

## What is deliberately not tenant-scoped, and why

Three tables are exempt from per-tenant RLS. Each is a system table, not
tenant business data, and each is documented here rather than left
unexplained:

- **`tenants`** is the tenancy directory itself -- every row *is* a
  distinct tenant, so "restrict to the caller's tenant" does not apply the
  way it does to a tenant's own records.
- **`api_keys`** is looked up by key hash, one row at a time, before a
  tenant context exists to set. It is never listed or joined across
  tenants by application code.
- **`security_events`** (the security monitoring dashboard's data) records
  blocked cross-tenant *attempts* -- by nature, a row here can reference
  two different tenants (the one attempting access, and the one targeted).
  Access to this table is instead restricted at the application layer to
  an internal admin credential, a placeholder for the role-based access
  control TEID-43 introduces.

## Verification

- **T1 (RLS policy audit):** an automated script introspects
  `pg_class.relrowsecurity`, `pg_class.relforcerowsecurity` and
  `pg_policies` for every table with a `tenant_id` column and fails if any
  is missing RLS, forced RLS, or a policy.
- **T2/T7/T8 (cross-tenant regression, injection, ID substitution):** an
  automated suite authenticates as one tenant and attempts reads and writes
  against every documented endpoint, targeting the other tenant's records,
  including a SQL-injection payload in a filter parameter and a
  substituted ID on a `PATCH`. It asserts zero leaked rows and that writes
  are rejected.
- **T3 (CI gate):** the suite above runs in CI on every push; the release
  stage is declared with a dependency on that test job, so a failure
  structurally blocks release.
- **T6 (detection):** every blocked attempt is written to `security_events`
  synchronously, in the same request, so it is visible on the security
  dashboard immediately -- well inside the 60-second requirement.

This design, and the suite that verifies it, are re-run on every release,
not only when this document is written.
