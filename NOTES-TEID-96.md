# TEID-96 implementation notes

## Specification inconsistencies

1. The `internal/period` architecture says an anchor day is clamped before
   constructing local midnight, explicitly giving an anchor-31 February
   boundary as local midnight on February 28 (or February 29 in a leap year).
   It also says the end is constructed the same way one calendar month later.
   TEID-96-T4's implementation guidance instead says February's exclusive
   `period_end` is March 1 00:00 local and April's is May 1 00:00 local. Under
   the required `[start, end)` model these are not equivalent: a February 28
   00:00 end excludes February 28, while a March 1 00:00 end includes it.
   The implementation follows the more precise architecture algorithm: every
   boundary is the clamped anchor day at local midnight, independently for
   each month.

2. TEID-96-T2 says a New York monthly boundary on the November 2026 DST
   fall-back date is 05:00 UTC. New York falls back at 02:00 local on
   2026-11-01, so midnight that date still uses EDT (UTC-4) and is 04:00 UTC.
   Midnight after the transition, including the next monthly boundary on
   2026-12-01, uses EST (UTC-5) and is 05:00 UTC. The implementation delegates
   offsets to Go's IANA time-zone rules as required; the acceptance test checks
   both the November period start (`04:00Z`) and its December end (`05:00Z`).

3. TEID-96-T5 discusses Go resolving a nonexistent spring-forward `02:30`
   local time in `Boundaries`, but the specified monthly boundary function
   constructs only local midnight from `(year, month, anchorDay)`. A request
   probe instant always has an explicit offset and is therefore unambiguous.
   The regression test uses the explicit-offset instant corresponding to the
   spring-forward gap and verifies correct assignment without error.

## Local verification environment

- The requested `CI=true PGPASSWORD=postgres
  TEIDEAL_PG_CONTAINER=teideal-postgres-codex96 bash db/setup-local.sh`
  invocation could not run because the supplied `psql` shim attempted to open
  Docker's Windows named pipe, which this sandbox rejects. The database was
  already migrated and seeded as stated in the task. The new idempotent
  migration was applied directly to the supplied superuser TCP URL with pgx
  and the resulting `customer_billing_config` table was verified before the
  service and all test suites ran.
- The process-local npm cache was empty and network access is restricted. The
  new suite uses the same dependency graph as `tests/currency-rounding`; its
  lockfile was copied from that suite with only the package name changed, and
  all required suites installed successfully with `npm ci --offline` from the
  machine's populated read-only npm cache.
