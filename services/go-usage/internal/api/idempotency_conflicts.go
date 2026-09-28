package api

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"

	"teideal/go-usage/internal/auth"
	"teideal/go-usage/internal/money"
)

type idempotencyConflict struct {
	ID             string `json:"id"`
	IdempotencyKey string `json:"idempotency_key"`
	// Nullable: SET NULL once the flagged row is deleted by a later,
	// legitimate expired-key reuse (see the migration's ON DELETE SET NULL
	// comment) -- the review record itself is never removed.
	ExistingUsageEventID *string          `json:"existing_usage_event_id"`
	AttemptedCustomerID  *string          `json:"attempted_customer_id"`
	AttemptedEventType   *string          `json:"attempted_event_type"`
	AttemptedQuantity    *decimal.Decimal `json:"attempted_quantity"`
	DetectedAt           time.Time        `json:"detected_at"`
}

// GetIdempotencyConflicts handles GET /idempotency-conflicts. RLS confines
// the operator's review queue to the authenticated tenant.
func (h *Handlers) GetIdempotencyConflicts(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthenticated")
		return
	}

	var customerFilter *string
	if raw := r.URL.Query().Get("customer_id"); raw != "" {
		if _, err := uuid.Parse(raw); err != nil {
			writeErr(w, http.StatusBadRequest, "customer_id must be a UUID")
			return
		}
		customerFilter = &raw
	}

	var keyFilter *string
	if raw := r.URL.Query().Get("idempotency_key"); raw != "" {
		keyFilter = &raw
	}

	conflicts := []idempotencyConflict{}
	err := h.Pool.WithTenant(r.Context(), principal.TenantID, func(ctx context.Context, tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT id, idempotency_key, existing_usage_event_id,
			       attempted_customer_id, attempted_event_type,
			       attempted_quantity, detected_at
			FROM idempotency_conflicts
			WHERE ($1::uuid IS NULL OR attempted_customer_id = $1)
			  AND ($2::text IS NULL OR idempotency_key = $2)
			ORDER BY detected_at DESC
		`, customerFilter, keyFilter)
		if err != nil {
			return err
		}
		defer rows.Close()

		for rows.Next() {
			var conflict idempotencyConflict
			var existingEventID pgtype.UUID
			var customerID pgtype.UUID
			var eventType pgtype.Text
			var quantity pgtype.Numeric
			if err := rows.Scan(
				&conflict.ID, &conflict.IdempotencyKey, &existingEventID,
				&customerID, &eventType, &quantity, &conflict.DetectedAt,
			); err != nil {
				return err
			}
			if existingEventID.Valid {
				value := uuid.UUID(existingEventID.Bytes).String()
				conflict.ExistingUsageEventID = &value
			}
			if customerID.Valid {
				value := uuid.UUID(customerID.Bytes).String()
				conflict.AttemptedCustomerID = &value
			}
			if eventType.Valid {
				value := eventType.String
				conflict.AttemptedEventType = &value
			}
			if quantity.Valid {
				value, err := money.FromPGNumeric(quantity)
				if err != nil {
					return err
				}
				conflict.AttemptedQuantity = &value
			}
			conflicts = append(conflicts, conflict)
		}
		return rows.Err()
	})
	if err != nil {
		log.Printf("GetIdempotencyConflicts: %v", err)
		writeErr(w, http.StatusInternalServerError, "failed to list idempotency conflicts")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"data": conflicts})
}
