// Package db wraps the Postgres pool and enforces the one rule every
// tenant-scoped query in this service must follow: no query touches a
// tenant-scoped table without first setting app.tenant_id for the current
// transaction. RLS policies in the database then do the actual filtering --
// this wrapper exists so it is structurally hard to forget the SET step,
// not so the application does the filtering itself.
package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Pool struct {
	*pgxpool.Pool
}

func Open(ctx context.Context, connString string) (*Pool, error) {
	pool, err := pgxpool.New(ctx, connString)
	if err != nil {
		return nil, fmt.Errorf("db: open pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		return nil, fmt.Errorf("db: ping: %w", err)
	}
	return &Pool{pool}, nil
}

// WithTenant runs fn inside a transaction scoped to tenantID. set_config with
// is_local=true is used instead of a literal SET LOCAL string so tenantID is
// always passed as a bind parameter, never interpolated into SQL text.
func (p *Pool) WithTenant(ctx context.Context, tenantID string, fn func(ctx context.Context, tx pgx.Tx) error) error {
	tx, err := p.Begin(ctx)
	if err != nil {
		return fmt.Errorf("db: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return fmt.Errorf("db: set tenant context: %w", err)
	}
	if err := fn(ctx, tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
