package api

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"

	"teideal/go-usage/internal/auth"
	billingperiod "teideal/go-usage/internal/period"
)

type resolvePeriodRequest struct {
	CustomerID string          `json:"customer_id"`
	Instant    json.RawMessage `json:"instant"`
}

type resolvePeriodResponse struct {
	PeriodStart             time.Time `json:"period_start"`
	PeriodEnd               time.Time `json:"period_end"`
	InNewPeriodAsOfBoundary bool      `json:"in_new_period_as_of_boundary"`
}

// PostResolvePeriod handles POST /period/resolve. Periods are [start, end):
// an event exactly at period_start is in the new period, while period_end is
// the exclusive boundary and belongs to the following period.
func (h *Handlers) PostResolvePeriod(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthenticated")
		return
	}

	var req resolvePeriodRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if _, err := uuid.Parse(req.CustomerID); err != nil {
		writeErr(w, http.StatusBadRequest, "customer_id must be a UUID")
		return
	}
	instant, err := parseOptionalExplicitTimestamp(req.Instant, "instant")
	if err != nil || instant == nil {
		writeErr(w, http.StatusBadRequest, "instant must be an RFC3339 timestamp with an explicit UTC offset or Z")
		return
	}

	config, exists, err := h.effectiveBillingConfig(r.Context(), principal.TenantID, req.CustomerID)
	if err != nil {
		log.Printf("PostResolvePeriod config: %v", err)
		writeErr(w, http.StatusInternalServerError, "failed to resolve billing config")
		return
	}
	if !exists {
		writeErr(w, http.StatusNotFound, "customer not found for this tenant")
		return
	}

	start, end, err := billingperiod.Boundaries(config.BillingTimezone, config.BillingAnchorDay, *instant)
	if err != nil {
		log.Printf("PostResolvePeriod boundaries: %v", err)
		writeErr(w, http.StatusInternalServerError, "failed to resolve billing period")
		return
	}

	writeJSON(w, http.StatusOK, resolvePeriodResponse{
		PeriodStart:             start,
		PeriodEnd:               end,
		InNewPeriodAsOfBoundary: true,
	})
}
