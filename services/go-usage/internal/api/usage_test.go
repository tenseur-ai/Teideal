package api

import (
	"testing"

	"github.com/shopspring/decimal"
)

func TestValidateEventType(t *testing.T) {
	validTypes := []string{
		"api_call",
		"click",
		"http.request",
		"service:count_123",
		"a-b_c.d:1",
	}

	for _, vt := range validTypes {
		if err := validateEventType(vt); err != nil {
			t.Errorf("expected valid event_type %q, got error: %v", vt, err)
		}
	}

	invalidTypes := []string{
		"",
		"click'; DROP TABLE usage_events;--",
		"spaces in name",
		"bad@character",
	}

	for _, it := range invalidTypes {
		if err := validateEventType(it); err == nil {
			t.Errorf("expected invalid event_type %q to return error, got nil", it)
		}
	}
}

func TestValidateQuantity(t *testing.T) {
	validQuantities := []string{"0", "1", "10.5", "999999", "1000000000000"}
	for _, q := range validQuantities {
		if err := validateQuantity(decimal.RequireFromString(q)); err != nil {
			t.Errorf("expected valid quantity %s, got error: %v", q, err)
		}
	}

	invalidQuantities := []string{"-1", "-0.001", "-500", "1000000000001"}
	for _, q := range invalidQuantities {
		if err := validateQuantity(decimal.RequireFromString(q)); err == nil {
			t.Errorf("expected invalid quantity %s to return error, got nil", q)
		}
	}

	capError := validateQuantity(decimal.RequireFromString("1000000000001"))
	if capError == nil || capError.Error() != "quantity must not exceed 1000000000000 (one trillion)" {
		t.Fatalf("expected explicit one-trillion cap error, got %v", capError)
	}
}
