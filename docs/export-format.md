# Teideal full-export format

Each export contains all currently available tenant-owned usage and
configuration data. Usage events are the ledger source at this build stage.

Date ranges use a half-open interval: the start is inclusive and the end is
exclusive. Usage events filter on `occurred_at`; every other category filters
on `created_at`, except tenant settings, which filters on `updated_at`.

## File formats

- CSV is UTF-8. Each category starts with a `# <category>` line, followed by
  the exact header listed below, its records, and a blank separator line.
- JSON is newline-delimited JSON (JSON Lines), not a JSON array. Each line is
  an object with `category` and `record`; `record` contains exactly the
  category columns listed below.
- Parquet is a streaming columnar file with UTF-8 `category` and
  `record_json` columns. `record_json` contains exactly the category columns
  listed below.

## usage_events

| Column |
|---|
| `id` |
| `customer_id` |
| `event_type` |
| `quantity` |
| `idempotency_key` |
| `occurred_at` |
| `created_at` |

## customers

| Column |
|---|
| `id` |
| `name` |
| `email` |
| `created_at` |
| `updated_at` |

## tenant_settings

| Column |
|---|
| `require_mfa_all_roles` |
| `idle_timeout_minutes` |
| `sso_enabled` |
| `updated_at` |

## users

| Column |
|---|
| `id` |
| `email` |
| `role` |
| `mfa_enrolled` |
| `created_at` |

## api_keys

| Column |
|---|
| `id` |
| `display_hint` |
| `scope` |
| `environment` |
| `label` |
| `creator_user_id` |
| `created_at` |
| `last_used_at` |
| `status` |

## grants

Grants are not yet available. No grants table exists at this build stage, so
there are no grant records or columns to export.

## Performance validation

The automated CI load test uses 50,000 usage events with a 120-second budget
by default. Before a release that changes the export path, a dedicated
performance/staging run sets `EXPORT_LOAD_TEST_EVENTS=50000000` and validates
the full-history export against the production target of completion within 24
hours.
