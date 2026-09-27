package money

import (
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
)

func TestPGNumericRoundTrip(t *testing.T) {
	values := []string{
		"0",
		"0.000000000001",
		"1000000000000",
		"499999999999500.123456789012",
	}

	for _, value := range values {
		original := decimal.RequireFromString(value)
		numeric, err := ToPGNumeric(original)
		if err != nil {
			t.Fatalf("ToPGNumeric(%s): %v", value, err)
		}
		roundTripped, err := FromPGNumeric(numeric)
		if err != nil {
			t.Fatalf("FromPGNumeric(%s): %v", value, err)
		}
		if !roundTripped.Equal(original) {
			t.Fatalf("round trip changed %s to %s", value, roundTripped)
		}
	}
}

func TestFromPGNumericRejectsNull(t *testing.T) {
	if _, err := FromPGNumeric(pgtype.Numeric{}); err == nil {
		t.Fatal("expected NULL NUMERIC to return an error")
	}
}
