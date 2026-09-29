package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"teideal/go-usage/internal/auth"
)

type postReservationRequest struct {
	CustomerID   string  `json:"customer_id"`
	UsageEventID *string `json:"usage_event_id,omitempty"`
}

type reservation struct {
	ID           string    `json:"id"`
	TenantID     string    `json:"tenant_id"`
	CustomerID   string    `json:"customer_id"`
	UsageEventID *string   `json:"usage_event_id"`
	CreatedAt    time.Time `json:"created_at"`
}

// PostReservation creates the identity-only reservation placeholder required
// for ledger traceability. It intentionally performs no hold, expiry, balance,
// or entitlement behavior.
func (h *Handlers) PostReservation(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthenticated")
		return
	}

	var req postReservationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if _, err := uuid.Parse(req.CustomerID); err != nil {
		writeErr(w, http.StatusBadRequest, "customer_id must be a UUID")
		return
	}
	if req.UsageEventID != nil {
		if _, err := uuid.Parse(*req.UsageEventID); err != nil {
			writeErr(w, http.StatusBadRequest, "usage_event_id must be a UUID")
			return
		}
	}

	created := reservation{}
	var missing string
	err := h.Pool.WithTenant(r.Context(), principal.TenantID, func(ctx context.Context, tx pgx.Tx) error {
		var customerExists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)`, req.CustomerID).Scan(&customerExists); err != nil {
			return err
		}
		if !customerExists {
			missing = "customer"
			return nil
		}
		if req.UsageEventID != nil {
			var eventMatches bool
			if err := tx.QueryRow(ctx, `
				SELECT EXISTS(
					SELECT 1 FROM usage_events WHERE id = $1 AND customer_id = $2
				)
			`, *req.UsageEventID, req.CustomerID).Scan(&eventMatches); err != nil {
				return err
			}
			if !eventMatches {
				missing = "usage event"
				return nil
			}
		}
		return tx.QueryRow(ctx, `
			INSERT INTO reservations (tenant_id, customer_id, usage_event_id)
			VALUES ($1, $2, $3)
			RETURNING id, tenant_id, customer_id, usage_event_id, created_at
		`, principal.TenantID, req.CustomerID, req.UsageEventID).
			Scan(&created.ID, &created.TenantID, &created.CustomerID, &created.UsageEventID, &created.CreatedAt)
	})
	if err != nil {
		log.Printf("PostReservation: %v", err)
		writeErr(w, http.StatusInternalServerError, "failed to create reservation")
		return
	}
	if missing != "" {
		writeErr(w, http.StatusForbidden, missing+" not found for this tenant")
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

// ListCustomerReservations handles GET /customers/{id}/reservations.
func (h *Handlers) ListCustomerReservations(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthenticated")
		return
	}
	customerID := r.PathValue("id")
	if _, err := uuid.Parse(customerID); err != nil {
		writeErr(w, http.StatusBadRequest, "id must be a UUID")
		return
	}
	if scopedToOtherCustomer(principal, customerID) {
		denyCustomerNotVisible(w, r, h, principal, "/customers/{id}/reservations", "customer_id not visible to caller's tenant")
		return
	}
	since, until, err := parseSinceUntil(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	limit, err := parseLimit(r.URL.Query().Get("limit"), defaultListLimit, maxListLimit)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cursorTime, cursorID, err := decodeTimeIDCursor(r.URL.Query().Get("cursor"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var cursorTimeArg *time.Time
	var cursorIDArg *string
	if cursorID != "" {
		cursorTimeArg = &cursorTime
		cursorIDArg = &cursorID
	}

	items := []reservation{}
	var missing bool
	err = h.Pool.WithTenant(r.Context(), principal.TenantID, func(ctx context.Context, tx pgx.Tx) error {
		visible, visErr := customerVisible(ctx, tx, customerID)
		if visErr != nil {
			return visErr
		}
		if !visible {
			missing = true
			return nil
		}
		rows, qerr := tx.Query(ctx, `
			SELECT id, tenant_id, customer_id, usage_event_id, created_at
			FROM reservations
			WHERE customer_id = $1
			  AND ($2::timestamptz IS NULL OR created_at >= $2)
			  AND ($3::timestamptz IS NULL OR created_at < $3)
			  AND ($4::timestamptz IS NULL OR (created_at, id) < ($4, $5::uuid))
			ORDER BY created_at DESC, id DESC
			LIMIT $6
		`, customerID, since, until, cursorTimeArg, cursorIDArg, limit+1)
		if qerr != nil {
			return qerr
		}
		defer rows.Close()
		for rows.Next() {
			var item reservation
			if err := rows.Scan(&item.ID, &item.TenantID, &item.CustomerID, &item.UsageEventID, &item.CreatedAt); err != nil {
				return err
			}
			items = append(items, item)
		}
		return rows.Err()
	})
	if err != nil {
		log.Printf("ListCustomerReservations: %v", err)
		writeErr(w, http.StatusInternalServerError, "failed to list reservations")
		return
	}
	if missing {
		denyCustomerNotVisible(w, r, h, principal, "/customers/{id}/reservations", "customer_id not visible to caller's tenant")
		return
	}
	var next *string
	if len(items) > limit {
		items = items[:limit]
		c := encodeTimeIDCursor(items[len(items)-1].CreatedAt, items[len(items)-1].ID)
		next = &c
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": items, "cursor": next})
}
