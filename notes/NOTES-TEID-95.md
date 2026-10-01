# TEID-95 implementation notes

## Required export precision audit

Checked `services/ts-console/src/lib/exportSources.ts` and
`services/ts-console/src/lib/exportFormats.ts` for `Number(` and
`parseFloat(` calls. Neither file contains either coercion. The
`usage_events.quantity` value is selected directly from `pg`, carried as an
`unknown` record value, and written with `String(value)` for CSV or
`JSON.stringify` for JSON/Parquet. Because `pg` returns PostgreSQL `NUMERIC`
as a string by default, the existing export path preserves the exact quantity.

## Spec discrepancy: decimal JSON default

The spec says `decimal.Decimal.MarshalJSON` writes an unquoted raw JSON number
token by default. In the repository's `github.com/shopspring/decimal` v1.4.0,
`decimal.MarshalJSONWithoutQuotes` defaults to `false`, so the library default
actually writes a quoted string. That would change the existing `/usage`
response wire format and fail the unchanged TEID-30 assertion that a quantity
of `1` is returned as a JSON number.

To preserve the wire format required by the spec, `internal/api/usage.go`
enables the library's documented `decimal.MarshalJSONWithoutQuotes` option at
package initialization. Request decoding remains exact because
`decimal.Decimal.UnmarshalJSON` parses the original JSON token text directly.

## Local tool cache workarounds

The requested shared Go build cache at
`C:/Users/kiran/teideal-agents/.gocache` returned access-denied errors. The
single retry used the worktree-local `.gocache-teid95` directory and succeeded.
The npm PowerShell wrapper was blocked by the machine execution policy, so npm
commands use `npm.cmd`. A retry with the prescribed worktree-local npm cache
reached the registry but was denied network access with `EACCES`; the temporary
machine-specific `.npmrc` was removed so it cannot affect Linux CI.

The prescribed `bash db/setup-local.sh` invocation reached the `psql` shim,
but the shim's internal `docker exec` was denied access to the Docker named
pipe by the sandbox. The TEID-95 migration was therefore applied directly to
the supplied superuser connection with a temporary repository-local `pgx`
runner, without attempting to manage Docker.
