package api

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"

	"github.com/jackc/pgx/v5"

	"teideal/go-usage/internal/auth"
	"teideal/go-usage/internal/money"
)

type roundingConfig struct {
	RoundingMethod        money.RoundingMethod `json:"rounding_method"`
	RoundingPoint         money.RoundingPoint  `json:"rounding_point"`
	ImportedBillingSystem *string              `json:"imported_billing_system"`
}

func (h *Handlers) effectiveRoundingConfig(ctx context.Context, tenantID string, importedBillingSystem *string) (roundingConfig, error) {
	config := roundingConfig{
		RoundingMethod:        money.RoundHalfUp,
		RoundingPoint:         money.PerLine,
		ImportedBillingSystem: importedBillingSystem,
	}

	err := h.Pool.WithTenant(ctx, tenantID, func(ctx context.Context, tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `
			SELECT rounding_method, rounding_point
			FROM rounding_configs
			WHERE tenant_id = $1
			  AND imported_billing_system IS NOT DISTINCT FROM $2::text
		`, tenantID, importedBillingSystem).Scan(&config.RoundingMethod, &config.RoundingPoint)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	})
	return config, err
}

// GetRoundingConfig handles GET /rounding-config and returns the stored or
// default-effective configuration for the authenticated tenant.
func (h *Handlers) GetRoundingConfig(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthenticated")
		return
	}

	var importedBillingSystem *string
	if values, present := r.URL.Query()["imported_billing_system"]; present && len(values) > 0 {
		importedBillingSystem = &values[0]
	}

	config, err := h.effectiveRoundingConfig(r.Context(), principal.TenantID, importedBillingSystem)
	if err != nil {
		log.Printf("GetRoundingConfig: %v", err)
		writeErr(w, http.StatusInternalServerError, "failed to get rounding config")
		return
	}

	writeJSON(w, http.StatusOK, config)
}

type putRoundingConfigRequest struct {
	ImportedBillingSystem *string               `json:"imported_billing_system"`
	RoundingMethod        *money.RoundingMethod `json:"rounding_method"`
	RoundingPoint         *money.RoundingPoint  `json:"rounding_point"`
}

// PutRoundingConfig handles PUT /rounding-config. Omitted rounding fields
// retain their current values, or use defaults when inserting a new row.
func (h *Handlers) PutRoundingConfig(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthenticated")
		return
	}

	var req putRoundingConfigRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.RoundingMethod != nil && !req.RoundingMethod.Valid() {
		writeErr(w, http.StatusBadRequest, "rounding_method must be round_half_up or round_half_to_even")
		return
	}
	if req.RoundingPoint != nil && !req.RoundingPoint.Valid() {
		writeErr(w, http.StatusBadRequest, "rounding_point must be per_line, per_invoice, or per_event")
		return
	}

	var methodParam *string
	if req.RoundingMethod != nil {
		value := string(*req.RoundingMethod)
		methodParam = &value
	}
	var pointParam *string
	if req.RoundingPoint != nil {
		value := string(*req.RoundingPoint)
		pointParam = &value
	}

	saved := roundingConfig{ImportedBillingSystem: req.ImportedBillingSystem}
	err := h.Pool.WithTenant(r.Context(), principal.TenantID, func(ctx context.Context, tx pgx.Tx) error {
		if req.ImportedBillingSystem == nil {
			return tx.QueryRow(ctx, `
				INSERT INTO rounding_configs (
					tenant_id, imported_billing_system, rounding_method, rounding_point
				)
				VALUES (
					$1, NULL, COALESCE($2::text, 'round_half_up'), COALESCE($3::text, 'per_line')
				)
				ON CONFLICT (tenant_id) WHERE imported_billing_system IS NULL
				DO UPDATE SET
					rounding_method = COALESCE($2::text, rounding_configs.rounding_method),
					rounding_point = COALESCE($3::text, rounding_configs.rounding_point),
					updated_at = now()
				RETURNING rounding_method, rounding_point
			`, principal.TenantID, methodParam, pointParam).
				Scan(&saved.RoundingMethod, &saved.RoundingPoint)
		}

		return tx.QueryRow(ctx, `
			INSERT INTO rounding_configs (
				tenant_id, imported_billing_system, rounding_method, rounding_point
			)
			VALUES (
				$1, $2, COALESCE($3::text, 'round_half_up'), COALESCE($4::text, 'per_line')
			)
			ON CONFLICT (tenant_id, imported_billing_system)
			DO UPDATE SET
				rounding_method = COALESCE($3::text, rounding_configs.rounding_method),
				rounding_point = COALESCE($4::text, rounding_configs.rounding_point),
				updated_at = now()
			RETURNING rounding_method, rounding_point
		`, principal.TenantID, *req.ImportedBillingSystem, methodParam, pointParam).
			Scan(&saved.RoundingMethod, &saved.RoundingPoint)
	})
	if err != nil {
		log.Printf("PutRoundingConfig: %v", err)
		writeErr(w, http.StatusInternalServerError, "failed to update rounding config")
		return
	}

	writeJSON(w, http.StatusOK, saved)
}
