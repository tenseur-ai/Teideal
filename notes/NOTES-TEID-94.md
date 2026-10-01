# TEID-94 implementation notes

## Specification inconsistency: per-invoice display and AC5

AC5 says that displayed invoice lines must add exactly to the displayed invoice total, with any rounding difference represented separately. The more specific `POST /money/preview` computation rules say that `per_invoice` lines remain at full precision while only the total is rounded. For the three-line example (`33.335` three times), those displayed lines sum to `100.005` while the displayed total is `100.01`; they only reconcile when the separate `0.005` rounding adjustment is taken into account.

The implementation follows the detailed endpoint rules and the TEID-94-T5 guidance: it preserves full-precision lines for `per_invoice`, returns the currency-formatted rounded total, and exposes the absolute remainder as `rounding_adjustment`.

## Local migration runner limitation

The requested `CI=true PGPASSWORD=postgres TEIDEAL_PG_CONTAINER=teideal-postgres-gemini bash db/setup-local.sh` command reaches the provided `psql` shim, but the shim attempts to access the Windows Docker named pipe and is denied by this workspace sandbox. The database's supplied TCP endpoint remains available, so local verification applies the same ordered migration SQL files directly over `postgres://postgres:postgres@127.0.0.1:5433/teideal` using pgx. CI still uses the repository's unchanged `db/setup-local.sh` path.

The direct all-files fallback also showed that existing migration `20260927065436_audit_log_extend.sql` is not idempotent on this already-migrated database (`column "object_type" ... already exists`), contrary to the setup instruction's idempotency note. Since the database was already migrated and seeded, local verification applies the new TEID-94 migration alone; clean-database CI/from-scratch verification continues to apply every migration in order.

## Git commit limitation

The first incremental commit attempt (`git commit -m "TEID-94: add exact decimal money primitives"`) failed because Git could not create `C:/Users/kiran/Teideal/.git/worktrees/codex-teid-94-currency-rounding/index.lock` (`Permission denied`). No commit was created. Implementation and verification continue in the working tree, but the sandbox cannot currently write this worktree's shared Git metadata.

## Local binary output path

The requested Windows `go build -o /tmp/go-usage-codex ./cmd/server` invocation failed when Go copied the executable to `/tmp` (`Access is denied`). Local end-to-end verification therefore builds the same server package to the repository-ignored `.tmp-run/go-usage-codex.exe` and runs that binary with the specified port and database URL.

## Local npm installation limitation

PowerShell blocks the `npm.ps1` wrapper, so local installation uses `npm.cmd`. The prepared worktree npm cache was initially empty and registry requests spent a long time retrying under the sandbox; after the delayed installer populated the worktree cache, `npm.cmd ci --cache ../../.npm-cache --offline` succeeded. The new suite's dependency graph exactly matches `tests/usage-ingestion`, so its committed lockfile is derived from that existing lockfile with only the package name changed. The final real `npm.cmd test` run used the installed Vitest 5.0.2 package and passed all 9 tests.
