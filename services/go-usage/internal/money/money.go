// Package money provides exact-decimal currency rounding primitives.
package money

import (
	"errors"
	"fmt"

	"github.com/shopspring/decimal"
)

// Amount is an exact monetary value denominated in an ISO 4217 currency.
type Amount struct {
	Value    decimal.Decimal
	Currency string
}

// CurrencyMinorUnits contains the official decimal precision for the
// currencies currently supported by the usage service.
var CurrencyMinorUnits = map[string]int32{
	"USD": 2,
	"EUR": 2,
	"GBP": 2,
	"INR": 2,
	"CAD": 2,
	"AUD": 2,
	"JPY": 0,
	"KRW": 0,
	"KWD": 3,
	"BHD": 3,
	"OMR": 3,
}

// RoundingMethod selects how midpoint values are rounded.
type RoundingMethod string

const (
	RoundHalfUp     RoundingMethod = "round_half_up"
	RoundHalfToEven RoundingMethod = "round_half_to_even"
)

// RoundingPoint selects when rounding is applied.
type RoundingPoint string

const (
	PerLine    RoundingPoint = "per_line"
	PerInvoice RoundingPoint = "per_invoice"
	PerEvent   RoundingPoint = "per_event"
)

// Calculation is the exact-decimal result consumed by /money/preview and by
// future ledger code. RoundingAdjustment is the absolute invoice-level
// remainder; it is zero for per-line and per-event calculations.
type Calculation struct {
	Lines              []Amount
	Total              Amount
	RoundingAdjustment decimal.Decimal
}

// MinorUnits returns the official number of decimal places for currency.
func MinorUnits(currency string) (int32, error) {
	units, ok := CurrencyMinorUnits[currency]
	if !ok {
		return 0, fmt.Errorf("unsupported currency %q", currency)
	}
	return units, nil
}

// Valid reports whether m is a supported rounding method.
func (m RoundingMethod) Valid() bool {
	return m == RoundHalfUp || m == RoundHalfToEven
}

// Valid reports whether p is a supported rounding point.
func (p RoundingPoint) Valid() bool {
	return p == PerLine || p == PerInvoice || p == PerEvent
}

// Round rounds v to the currency's minor-unit scale using method.
func Round(v decimal.Decimal, currency string, method RoundingMethod) (decimal.Decimal, error) {
	places, err := MinorUnits(currency)
	if err != nil {
		return decimal.Decimal{}, err
	}

	switch method {
	case RoundHalfUp:
		return v.Round(places), nil
	case RoundHalfToEven:
		return v.RoundBank(places), nil
	default:
		return decimal.Decimal{}, errors.New("rounding_method must be round_half_up or round_half_to_even")
	}
}

// Calculate applies the configured rounding point to a set of exact-decimal
// line values. Per-event currently has the same behavior as per-line because
// each supplied preview line represents one caller-supplied event amount.
func Calculate(values []decimal.Decimal, currency string, point RoundingPoint, method RoundingMethod) (Calculation, error) {
	if _, err := MinorUnits(currency); err != nil {
		return Calculation{}, err
	}
	if !method.Valid() {
		return Calculation{}, errors.New("rounding_method must be round_half_up or round_half_to_even")
	}
	if !point.Valid() {
		return Calculation{}, errors.New("rounding_point must be per_line, per_invoice, or per_event")
	}

	result := Calculation{
		Lines: make([]Amount, 0, len(values)),
		Total: Amount{Value: decimal.Zero, Currency: currency},
	}

	switch point {
	case PerLine, PerEvent:
		for _, value := range values {
			rounded, err := Round(value, currency, method)
			if err != nil {
				return Calculation{}, err
			}
			result.Lines = append(result.Lines, Amount{Value: rounded, Currency: currency})
			result.Total.Value = result.Total.Value.Add(rounded)
		}
	case PerInvoice:
		unroundedTotal := decimal.Zero
		for _, value := range values {
			result.Lines = append(result.Lines, Amount{Value: value, Currency: currency})
			unroundedTotal = unroundedTotal.Add(value)
		}
		roundedTotal, err := Round(unroundedTotal, currency, method)
		if err != nil {
			return Calculation{}, err
		}
		result.Total.Value = roundedTotal
		result.RoundingAdjustment = unroundedTotal.Sub(roundedTotal).Abs()
	}

	return result, nil
}
