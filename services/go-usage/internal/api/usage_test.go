package api

import (
	"testing"
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
	validQuantities := []float64{0, 1, 10.5, 999999}
	for _, q := range validQuantities {
		if err := validateQuantity(q); err != nil {
			t.Errorf("expected valid quantity %f, got error: %v", q, err)
		}
	}

	invalidQuantities := []float64{-1, -0.001, -500}
	for _, q := range invalidQuantities {
		if err := validateQuantity(q); err == nil {
			t.Errorf("expected invalid quantity %f to return error, got nil", q)
		}
	}
}
