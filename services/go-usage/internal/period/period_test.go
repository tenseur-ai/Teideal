package period

import (
	"testing"
	"time"
	_ "time/tzdata"
)

func TestBoundariesIncludesExactBoundaryInNewPeriod(t *testing.T) {
	instant := time.Date(2026, time.April, 1, 4, 0, 0, 0, time.UTC)
	start, end, err := Boundaries("America/New_York", 1, instant)
	if err != nil {
		t.Fatalf("Boundaries returned error: %v", err)
	}

	wantStart := time.Date(2026, time.April, 1, 4, 0, 0, 0, time.UTC)
	wantEnd := time.Date(2026, time.May, 1, 4, 0, 0, 0, time.UTC)
	if !start.Equal(wantStart) || !end.Equal(wantEnd) {
		t.Fatalf("got [%s, %s), want [%s, %s)", start, end, wantStart, wantEnd)
	}
}

func TestBoundariesClampsEachMonthIndependently(t *testing.T) {
	instant := time.Date(2024, time.February, 15, 12, 0, 0, 0, time.UTC)
	start, end, err := Boundaries("UTC", 31, instant)
	if err != nil {
		t.Fatalf("Boundaries returned error: %v", err)
	}

	wantStart := time.Date(2024, time.January, 31, 0, 0, 0, 0, time.UTC)
	wantEnd := time.Date(2024, time.February, 29, 0, 0, 0, 0, time.UTC)
	if !start.Equal(wantStart) || !end.Equal(wantEnd) {
		t.Fatalf("got [%s, %s), want [%s, %s)", start, end, wantStart, wantEnd)
	}
}

func TestBoundariesUsesOffsetAtEachLocalBoundary(t *testing.T) {
	instant := time.Date(2026, time.November, 15, 12, 0, 0, 0, time.UTC)
	start, end, err := Boundaries("America/New_York", 1, instant)
	if err != nil {
		t.Fatalf("Boundaries returned error: %v", err)
	}

	wantStart := time.Date(2026, time.November, 1, 4, 0, 0, 0, time.UTC)
	wantEnd := time.Date(2026, time.December, 1, 5, 0, 0, 0, time.UTC)
	if !start.Equal(wantStart) || !end.Equal(wantEnd) {
		t.Fatalf("got [%s, %s), want [%s, %s)", start, end, wantStart, wantEnd)
	}
}

func TestGo125FallBackTieBreakUsesFirstNewYorkOccurrence(t *testing.T) {
	location, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatalf("LoadLocation returned error: %v", err)
	}

	// In the Go version pinned by this repository, time.Date resolves the
	// repeated 2026-11-01 01:30 wall time to the first occurrence (EDT,
	// UTC-04:00), which is 05:30Z. This documents the runtime tie-break used
	// whenever a zone makes a constructed local time ambiguous.
	resolved := time.Date(2026, time.November, 1, 1, 30, 0, 0, location)
	want := time.Date(2026, time.November, 1, 5, 30, 0, 0, time.UTC)
	if !resolved.Equal(want) {
		t.Fatalf("Go time.Date tie-break resolved to %s, want first occurrence %s", resolved.UTC(), want)
	}
}

func TestBoundariesRejectsInvalidInput(t *testing.T) {
	if _, _, err := Boundaries("UTC", 0, time.Now()); err == nil {
		t.Fatal("expected anchor-day error")
	}
	if _, _, err := Boundaries("Not/A_Real_Zone", 1, time.Now()); err == nil {
		t.Fatal("expected time-zone error")
	}
}
