// Package security logs blocked cross-tenant attempts to security_events,
// synchronously and in the same request as the attempt -- so the "within
// 60 seconds" requirement (TEID-41-T6) holds by construction rather than by
// batching or polling.
package security

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

type BlockedAttempt struct {
	ActingTenantID string
	TargetTenantID *string // nil when the target tenant can't be determined (e.g. row simply not visible under RLS)
	Endpoint       string
	Method         string
	Detail         string
	ResolvedAction string
}

func LogBlocked(ctx context.Context, pool *pgxpool.Pool, a BlockedAttempt) error {
	_, err := pool.Exec(ctx, `
		INSERT INTO security_events (acting_tenant_id, target_tenant_id, endpoint, http_method, detail, resolved_action)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, a.ActingTenantID, a.TargetTenantID, a.Endpoint, a.Method, a.Detail, a.ResolvedAction)
	return err
}
