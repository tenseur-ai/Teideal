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

	"teideal/go-usage/internal/auth"
)

type billingConfig struct {
	CustomerID       string `json:"customer_id"`
	BillingTimezone  string `json:"billing_timezone"`
	BillingAnchorDay int    `json:"billing_anchor_day"`
}

func (h *Handlers) effectiveBillingConfig(ctx context.Context, tenantID, customerID string) (billingConfig, bool, error) {
	config := billingConfig{
		CustomerID:       customerID,
		BillingTimezone:  "UTC",
		BillingAnchorDay: 1,
	}
	var customerExists bool
	err := h.Pool.WithTenant(ctx, tenantID, func(ctx context.Context, tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)`, customerID).Scan(&customerExists); err != nil {
			return err
		}
		if !customerExists {
			return nil
		}

		err := tx.QueryRow(ctx, `
			SELECT billing_timezone, billing_anchor_day
			FROM customer_billing_config
			WHERE customer_id = $1
		`, customerID).Scan(&config.BillingTimezone, &config.BillingAnchorDay)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	})
	return config, customerExists, err
}

// GetBillingConfig handles GET /customers/:id/billing-config and returns the
// stored configuration, or the effective UTC/anchor-day-1 defaults.
func (h *Handlers) GetBillingConfig(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthenticated")
		return
	}

	customerID := r.PathValue("id")
	if _, err := uuid.Parse(customerID); err != nil {
		writeErr(w, http.StatusBadRequest, "customer id must be a UUID")
		return
	}

	config, exists, err := h.effectiveBillingConfig(r.Context(), principal.TenantID, customerID)
	if err != nil {
		log.Printf("GetBillingConfig: %v", err)
		writeErr(w, http.StatusInternalServerError, "failed to get billing config")
		return
	}
	if !exists {
		writeErr(w, http.StatusNotFound, "customer not found for this tenant")
		return
	}

	writeJSON(w, http.StatusOK, config)
}

type putBillingConfigRequest struct {
	BillingTimezone  *string `json:"billing_timezone"`
	BillingAnchorDay *int    `json:"billing_anchor_day"`
}

// PutBillingConfig handles PUT /customers/:id/billing-config. Omitted fields
// retain stored values, or use UTC/anchor-day-1 defaults for a new row.
func (h *Handlers) PutBillingConfig(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthenticated")
		return
	}

	customerID := r.PathValue("id")
	if _, err := uuid.Parse(customerID); err != nil {
		writeErr(w, http.StatusBadRequest, "customer id must be a UUID")
		return
	}

	var req putBillingConfigRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.BillingTimezone != nil {
		if _, err := time.LoadLocation(*req.BillingTimezone); err != nil {
			writeErr(w, http.StatusBadRequest, "billing_timezone must be a valid IANA time zone name")
			return
		}
	}
	if req.BillingAnchorDay != nil && (*req.BillingAnchorDay < 1 || *req.BillingAnchorDay > 31) {
		writeErr(w, http.StatusBadRequest, "billing_anchor_day must be between 1 and 31")
		return
	}

	saved := billingConfig{CustomerID: customerID}
	var customerExists bool
	err := h.Pool.WithTenant(r.Context(), principal.TenantID, func(ctx context.Context, tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)`, customerID).Scan(&customerExists); err != nil {
			return err
		}
		if !customerExists {
			return nil
		}

		return tx.QueryRow(ctx, `
			INSERT INTO customer_billing_config (
				tenant_id, customer_id, billing_timezone, billing_anchor_day
			)
			VALUES ($1, $2, COALESCE($3::text, 'UTC'), COALESCE($4::int, 1))
			ON CONFLICT (customer_id)
			DO UPDATE SET
				billing_timezone = COALESCE($3::text, customer_billing_config.billing_timezone),
				billing_anchor_day = COALESCE($4::int, customer_billing_config.billing_anchor_day),
				updated_at = now()
			RETURNING billing_timezone, billing_anchor_day
		`, principal.TenantID, customerID, req.BillingTimezone, req.BillingAnchorDay).
			Scan(&saved.BillingTimezone, &saved.BillingAnchorDay)
	})
	if err != nil {
		log.Printf("PutBillingConfig: %v", err)
		writeErr(w, http.StatusInternalServerError, "failed to update billing config")
		return
	}
	if !customerExists {
		writeErr(w, http.StatusNotFound, "customer not found for this tenant")
		return
	}

	writeJSON(w, http.StatusOK, saved)
}
