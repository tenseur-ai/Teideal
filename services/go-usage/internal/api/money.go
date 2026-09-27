package api

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"

	"github.com/shopspring/decimal"

	"teideal/go-usage/internal/auth"
	"teideal/go-usage/internal/money"
)

type moneyPreviewLineRequest struct {
	Amount string `json:"amount"`
}

type moneyPreviewRequest struct {
	Currency              string                    `json:"currency"`
	Lines                 []moneyPreviewLineRequest `json:"lines"`
	ImportedBillingSystem *string                   `json:"imported_billing_system"`
	RoundingPoint         *money.RoundingPoint      `json:"rounding_point"`
	RoundingMethod        *money.RoundingMethod     `json:"rounding_method"`
}

type moneyPreviewLineResponse struct {
	Amount string `json:"amount"`
}

type moneyPreviewResponse struct {
	Lines              []moneyPreviewLineResponse `json:"lines"`
	Total              string                     `json:"total"`
	RoundingAdjustment string                     `json:"rounding_adjustment"`
}

// PostMoneyPreview handles POST /money/preview using decimal strings from
// request parsing through response rendering.
func (h *Handlers) PostMoneyPreview(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthenticated")
		return
	}

	var req moneyPreviewRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	minorUnits, err := money.MinorUnits(req.Currency)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
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

	values := make([]decimal.Decimal, len(req.Lines))
	for i, line := range req.Lines {
		value, err := decimal.NewFromString(line.Amount)
		if err != nil {
			writeErr(w, http.StatusBadRequest, fmt.Sprintf("lines[%d].amount must be a decimal string", i))
			return
		}
		values[i] = value
	}

	config, err := h.effectiveRoundingConfig(r.Context(), principal.TenantID, req.ImportedBillingSystem)
	if err != nil {
		log.Printf("PostMoneyPreview config: %v", err)
		writeErr(w, http.StatusInternalServerError, "failed to get rounding config")
		return
	}
	if req.RoundingMethod != nil {
		config.RoundingMethod = *req.RoundingMethod
	}
	if req.RoundingPoint != nil {
		config.RoundingPoint = *req.RoundingPoint
	}

	calculation, err := money.Calculate(values, req.Currency, config.RoundingPoint, config.RoundingMethod)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	response := moneyPreviewResponse{
		Lines:              make([]moneyPreviewLineResponse, len(calculation.Lines)),
		Total:              calculation.Total.Value.StringFixed(minorUnits),
		RoundingAdjustment: calculation.RoundingAdjustment.String(),
	}
	for i, line := range calculation.Lines {
		amount := line.Value.StringFixed(minorUnits)
		if config.RoundingPoint == money.PerInvoice {
			amount = line.Value.String()
		}
		response.Lines[i] = moneyPreviewLineResponse{Amount: amount}
	}

	writeJSON(w, http.StatusOK, response)
}
