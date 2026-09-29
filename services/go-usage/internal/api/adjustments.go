package api

import (
	"context"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"

	"teideal/go-usage/internal/auth"
	"teideal/go-usage/internal/money"
)

type usageAdjustment struct {
	ID                     string          `json:"id"`
	CustomerID             string          `json:"customer_id"`
	EventType              string          `json:"event_type"`
	Quantity               decimal.Decimal `json:"quantity"`
	IdempotencyKey         string          `json:"idempotency_key"`
	OccurredAt             time.Time       `json:"occurred_at"`
	PeriodStart            time.Time       `json:"period_start"`
	PeriodEnd              time.Time       `json:"period_end"`
	Status                 string          `json:"status"`
	AutoApproved           bool            `json:"auto_approved"`
	ReviewedByUserID       *string         `json:"reviewed_by_user_id,omitempty"`
	ReviewedAt             *time.Time      `json:"reviewed_at,omitempty"`
	ResultingUsageEventID  *string         `json:"resulting_usage_event_id,omitempty"`
	CreatedAt              time.Time       `json:"created_at"`
}

func scanUsageAdjustment(row pgx.Row) (usageAdjustment, error) {
	var a usageAdjustment
	var quantity pgtype.Numeric
	err := row.Scan(
		&a.ID, &a.CustomerID, &a.EventType, &quantity, &a.IdempotencyKey,
		&a.OccurredAt, &a.PeriodStart, &a.PeriodEnd, &a.Status, &a.AutoApproved,
		&a.ReviewedByUserID, &a.ReviewedAt, &a.ResultingUsageEventID, &a.CreatedAt,
	)
	if err != nil {
		return usageAdjustment{}, err
	}
	a.Quantity, err = money.FromPGNumeric(quantity)
	return a, err
}

const usageAdjustmentColumns = `
	id, customer_id, event_type, quantity, idempotency_key,
	occurred_at, period_start, period_end, status, auto_approved,
	reviewed_by_user_id, reviewed_at, resulting_usage_event_id, created_at
`

// GetAdjustments handles GET /adjustments?status=. The review-queue stand-in
// -- no console UI exists anywhere in this repo, matching every prior
// story's established pattern (TEID-31's idempotency_conflicts, TEID-33's
// balance_integrity_checks).
func (h *Handlers) GetAdjustments(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthenticated")
		return
	}
	status := r.URL.Query().Get("status")
	if status != "" && status != "pending" && status != "approved" && status != "rejected" {
		writeErr(w, http.StatusBadRequest, "status must be pending, approved, or rejected")
		return
	}

	adjustments := []usageAdjustment{}
	err := h.Pool.WithTenant(r.Context(), principal.TenantID, func(ctx context.Context, tx pgx.Tx) error {
		var statusFilter *string
		if status != "" {
			statusFilter = &status
		}
		rows, err := tx.Query(ctx, `
			SELECT `+usageAdjustmentColumns+`
			FROM usage_adjustments
			WHERE ($1::text IS NULL OR status = $1)
			ORDER BY created_at
			LIMIT 500
		`, statusFilter)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			a, err := scanUsageAdjustment(rows)
			if err != nil {
				return err
			}
			adjustments = append(adjustments, a)
		}
		return rows.Err()
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "list adjustments failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": adjustments})
}

func reviewAdjustment(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	adjustmentID string,
	principal auth.Principal,
	approve bool,
) (usageAdjustment, error) {
	row := tx.QueryRow(ctx, `
		SELECT `+usageAdjustmentColumns+`
		FROM usage_adjustments
		WHERE id = $1
		FOR UPDATE
	`, adjustmentID)
	existing, err := scanUsageAdjustment(row)
	if err != nil {
		return usageAdjustment{}, err
	}
	if existing.Status != "pending" {
		return usageAdjustment{}, errAdjustmentNotPending
	}

	now := time.Now().UTC()
	if !approve {
		row := tx.QueryRow(ctx, `
			UPDATE usage_adjustments
			SET status = 'rejected', reviewed_by_user_id = $2, reviewed_at = $3
			WHERE id = $1
			RETURNING `+usageAdjustmentColumns, adjustmentID, principal.UserID, now)
		return scanUsageAdjustment(row)
	}

	quantity, err := money.ToPGNumeric(existing.Quantity)
	if err != nil {
		return usageAdjustment{}, err
	}
	// The original idempotency_key was never inserted into usage_events while
	// pending (only into usage_adjustments), so reusing it here unmodified is
	// safe and preserves real idempotency semantics: a resubmission of the
	// same event after approval correctly resolves against usage_events'
	// own unique constraint, not a synthetic derived key.
	var created usageEvent
	var createdQuantity pgtype.Numeric
	if err := insertPriorPeriodUsageEvent(
		ctx, tx, tenantID, existing.CustomerID, existing.EventType, quantity,
		existing.IdempotencyKey, existing.OccurredAt, &created, &createdQuantity,
	); err != nil {
		return usageAdjustment{}, err
	}
	row = tx.QueryRow(ctx, `
		UPDATE usage_adjustments
		SET status = 'approved', reviewed_by_user_id = $2, reviewed_at = $3, resulting_usage_event_id = $4
		WHERE id = $1
		RETURNING `+usageAdjustmentColumns, adjustmentID, principal.UserID, now, created.ID)
	return scanUsageAdjustment(row)
}

type adjustmentStatusError struct{ message string }

func (e *adjustmentStatusError) Error() string { return e.message }

var errAdjustmentNotPending = &adjustmentStatusError{message: "adjustment is not pending"}

// PostApproveAdjustment handles POST /adjustments/{id}/approve.
func (h *Handlers) PostApproveAdjustment(w http.ResponseWriter, r *http.Request) {
	h.reviewAdjustmentHandler(w, r, true)
}

// PostRejectAdjustment handles POST /adjustments/{id}/reject.
func (h *Handlers) PostRejectAdjustment(w http.ResponseWriter, r *http.Request) {
	h.reviewAdjustmentHandler(w, r, false)
}

func (h *Handlers) reviewAdjustmentHandler(w http.ResponseWriter, r *http.Request, approve bool) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthenticated")
		return
	}
	id := r.PathValue("id")
	if _, err := uuid.Parse(id); err != nil {
		writeErr(w, http.StatusBadRequest, "id must be a UUID")
		return
	}

	var result usageAdjustment
	err := h.Pool.WithTenant(r.Context(), principal.TenantID, func(ctx context.Context, tx pgx.Tx) error {
		var err error
		result, err = reviewAdjustment(ctx, tx, principal.TenantID, id, principal, approve)
		return err
	})
	if err != nil {
		if err == pgx.ErrNoRows {
			writeErr(w, http.StatusNotFound, "adjustment not found for this tenant")
			return
		}
		if _, ok := err.(*adjustmentStatusError); ok {
			writeErr(w, http.StatusConflict, err.Error())
			return
		}
		writeErr(w, http.StatusInternalServerError, "review adjustment failed")
		return
	}
	writeJSON(w, http.StatusOK, result)
}
