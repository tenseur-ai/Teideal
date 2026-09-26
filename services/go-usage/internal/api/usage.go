package api

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"teideal/go-usage/internal/auth"
	"teideal/go-usage/internal/db"
	"teideal/go-usage/internal/security"
)

type Handlers struct {
	Pool *db.Pool
}

type usageEvent struct {
	ID             string    `json:"id"`
	CustomerID     string    `json:"customer_id"`
	EventType      string    `json:"event_type"`
	Quantity       float64   `json:"quantity"`
	IdempotencyKey string    `json:"idempotency_key"`
	OccurredAt     time.Time `json:"occurred_at"`
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// GetUsage handles GET /usage?customer_id=<uuid>. The filter is validated as
// a UUID *before* it ever reaches a query -- an adversarial string (e.g. a
// SQL-injection payload) is rejected outright rather than being compared
// against a column, and the query that does run is fully parameterized
// regardless. RLS then confines the result set to the caller's own tenant.
func (h *Handlers) GetUsage(w http.ResponseWriter, r *http.Request) {
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

	events := []usageEvent{}
	err := h.Pool.WithTenant(r.Context(), principal.TenantID, func(ctx context.Context, tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT id, customer_id, event_type, quantity, idempotency_key, occurred_at
			FROM usage_events
			WHERE ($1::uuid IS NULL OR customer_id = $1)
			ORDER BY occurred_at DESC
			LIMIT 200
		`, customerFilter)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var e usageEvent
			if err := rows.Scan(&e.ID, &e.CustomerID, &e.EventType, &e.Quantity, &e.IdempotencyKey, &e.OccurredAt); err != nil {
				return err
			}
			events = append(events, e)
		}
		return rows.Err()
	})
	if err != nil {
		log.Printf("GetUsage: %v", err)
		writeErr(w, http.StatusInternalServerError, "failed to list usage events")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"data": events})
}

type postUsageRequest struct {
	CustomerID     string  `json:"customer_id"`
	EventType      string  `json:"event_type"`
	Quantity       float64 `json:"quantity"`
	IdempotencyKey string  `json:"idempotency_key"`
}

// PostUsage handles POST /usage. tenant_id is always taken from the
// authenticated principal, never from the request body, so a client cannot
// simply set tenant_id in the payload to write into another tenant's
// ledger. customer_id is additionally verified to resolve under the
// caller's own RLS context before the event is written, which is what
// stops a caller from attaching a usage event to another tenant's customer.
func (h *Handlers) PostUsage(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthenticated")
		return
	}

	var req postUsageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if _, err := uuid.Parse(req.CustomerID); err != nil {
		writeErr(w, http.StatusBadRequest, "customer_id must be a UUID")
		return
	}
	if req.EventType == "" || req.IdempotencyKey == "" {
		writeErr(w, http.StatusBadRequest, "event_type and idempotency_key are required")
		return
	}

	var created usageEvent
	var customerNotVisible bool
	err := h.Pool.WithTenant(r.Context(), principal.TenantID, func(ctx context.Context, tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)`, req.CustomerID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			customerNotVisible = true
			return nil
		}
		return tx.QueryRow(ctx, `
			INSERT INTO usage_events (tenant_id, customer_id, event_type, quantity, idempotency_key)
			VALUES ($1, $2, $3, $4, $5)
			RETURNING id, customer_id, event_type, quantity, idempotency_key, occurred_at
		`, principal.TenantID, req.CustomerID, req.EventType, req.Quantity, req.IdempotencyKey).
			Scan(&created.ID, &created.CustomerID, &created.EventType, &created.Quantity, &created.IdempotencyKey, &created.OccurredAt)
	})

	if customerNotVisible {
		_ = security.LogBlocked(r.Context(), h.Pool.Pool, security.BlockedAttempt{
			ActingTenantID: principal.TenantID,
			Endpoint:       "/usage",
			Method:         http.MethodPost,
			Detail:         "customer_id not visible to caller's tenant",
			ResolvedAction: "blocked_customer_not_visible",
		})
		writeErr(w, http.StatusForbidden, "customer not found for this tenant")
		return
	}
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			writeErr(w, http.StatusConflict, "idempotency_key already used for this tenant")
			return
		}
		log.Printf("PostUsage: %v", err)
		writeErr(w, http.StatusInternalServerError, "failed to record usage event")
		return
	}

	writeJSON(w, http.StatusCreated, created)
}
