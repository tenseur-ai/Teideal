# TEID-42 audit-log acceptance suite

The 1.2-million-row CSV test commits its fixture data so the separately
running console service can read it. Cleanup therefore uses
`SUPERUSER_DATABASE_URL`, which defaults to CI's
`postgres://postgres:postgres@127.0.0.1:5432/teideal`.

Local PostgreSQL commonly authenticates the `postgres` role through a Unix
socket without a password. Before running this suite locally for the first
time, enable the matching TCP password with:

```sh
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'postgres';"
```

The elevated pool is used only for bulk fixture setup and cleanup. All API
assertions and direct database assertions use the ordinary `teideal_app`
connection so RLS and append-only permissions remain under test.
