package api

import (
	"encoding/json"
	"net/http"

	"github.com/shopspring/decimal"

	"teideal/go-usage/internal/auth"
	"teideal/go-usage/internal/money"
)

type moneyPriceRequest struct {
	Currency       string                `json:"currency"`
	Quantity       string                `json:"quantity"`
	UnitPrice      string                `json:"unit_price"`
	RoundingMethod *money.RoundingMethod `json:"rounding_method"`
}

type moneyPriceResponse struct {
	LineAmount    string `json:"line_amount"`
	InvoiceAmount string `json:"invoice_amount"`
}

// PostMoneyPrice handles POST /money/price with exact decimal-string inputs.
func (h *Handlers) PostMoneyPrice(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.FromContext(r.Context()); !ok {
		writeErr(w, http.StatusUnauthorized, "unauthenticated")
		return
	}

	var req moneyPriceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	unitPrice, err := decimal.NewFromString(req.UnitPrice)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "unit_price must be a decimal string")
		return
	}
	if unitPrice.Exponent() < -12 {
		writeErr(w, http.StatusBadRequest, "unit_price supports at most 12 decimal places")
		return
	}

	quantity, err := decimal.NewFromString(req.Quantity)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "quantity must be a decimal string")
		return
	}
	if err := validateQuantity(quantity); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	method := money.RoundHalfUp
	if req.RoundingMethod != nil {
		method = *req.RoundingMethod
	}
	lineAmount := quantity.Mul(unitPrice)
	invoiceAmount, err := money.Round(lineAmount, req.Currency, method)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	minorUnits, err := money.MinorUnits(req.Currency)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, moneyPriceResponse{
		LineAmount:    lineAmount.String(),
		InvoiceAmount: invoiceAmount.StringFixed(minorUnits),
	})
}
