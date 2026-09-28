package api

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

const IdempotencyKeyRetentionDays = 372 // 365 + 7, see specs/TEID-31.md

const idempotencyConflictMessage = "idempotency_key already used with different content"

type idempotencyOutcome int

const (
	outcomeInserted  idempotencyOutcome = iota // no conflict, or conflict was expired and cleared
	outcomeDuplicate                           // in-window conflict, content matches -> ack
	outcomeConflict                            // in-window conflict, content differs -> reject + flag
)

type existingEvent struct {
	ID         string
	CustomerID string
	EventType  string
	Quantity   decimal.Decimal
	CreatedAt  time.Time
}

// resolveIdempotencyConflict is called from inside the same transaction as
// the insert attempt, immediately after a 23505 on (tenant_id,
// idempotency_key). It does not itself decide insert vs. reject -- it loads
// the conflicting row and classifies it (expired / duplicate / real
// conflict) so the caller (postUsageSingle/postUsageBatch) can act.
func resolveIdempotencyConflict(
	ctx context.Context, tx pgx.Tx, idempotencyKey string,
	attemptedCustomerID, attemptedEventType string, attemptedQuantity decimal.Decimal,
	now time.Time,
) (idempotencyOutcome, existingEvent, error) {
	var existing existingEvent
	err := tx.QueryRow(ctx, `
		SELECT id, customer_id, event_type, quantity, created_at
		FROM usage_events WHERE idempotency_key = $1
	`, idempotencyKey).Scan(&existing.ID, &existing.CustomerID, &existing.EventType, &existing.Quantity, &existing.CreatedAt)
	if err != nil {
		return outcomeConflict, existingEvent{}, err
	}

	if now.Sub(existing.CreatedAt) >= IdempotencyKeyRetentionDays*24*time.Hour {
		if _, err := tx.Exec(ctx, `DELETE FROM usage_events WHERE id = $1`, existing.ID); err != nil {
			return outcomeConflict, existingEvent{}, err
		}
		return outcomeInserted, existingEvent{}, nil // caller retries the original INSERT
	}

	if existing.CustomerID == attemptedCustomerID &&
		existing.EventType == attemptedEventType &&
		existing.Quantity.Equal(attemptedQuantity) {
		return outcomeDuplicate, existing, nil
	}
	return outcomeConflict, existing, nil
}

func recordConflict(
	ctx context.Context, tx pgx.Tx, tenantID, idempotencyKey, existingID string,
	attemptedCustomerID, attemptedEventType string, attemptedQuantity decimal.Decimal,
) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO idempotency_conflicts (
			tenant_id, idempotency_key, existing_usage_event_id,
			attempted_customer_id, attempted_event_type, attempted_quantity
		) VALUES ($1, $2, $3, $4, $5, $6)
	`, tenantID, idempotencyKey, existingID, attemptedCustomerID, attemptedEventType, attemptedQuantity)
	return err
}
