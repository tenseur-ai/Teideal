// Package period computes customer-local monthly billing boundaries.
package period

import (
	"fmt"
	"time"
)

// Boundaries returns the [start, end) UTC instants of the billing period
// containing instant, for a customer billing in tz with a monthly anchor on
// anchorDay. End is exclusive, so an event timestamped exactly at end belongs
// to the next period.
//
// Local boundary construction uses time.Date's deterministic zone resolution.
// In particular, if an IANA zone ever makes local midnight ambiguous or
// nonexistent, repeated calls with the same inputs resolve to the same instant.
func Boundaries(tz string, anchorDay int, instant time.Time) (start, end time.Time, err error) {
	if anchorDay < 1 || anchorDay > 31 {
		return time.Time{}, time.Time{}, fmt.Errorf("billing anchor day must be between 1 and 31")
	}

	location, err := time.LoadLocation(tz)
	if err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("load billing timezone %q: %w", tz, err)
	}

	localInstant := instant.In(location)
	year, month, _ := localInstant.Date()
	currentBoundary := localBoundary(location, year, month, anchorDay)

	startYear, startMonth := year, month
	if localInstant.Before(currentBoundary) {
		previousMonth := time.Date(year, month-1, 1, 0, 0, 0, 0, location)
		startYear, startMonth, _ = previousMonth.Date()
	}

	localStart := localBoundary(location, startYear, startMonth, anchorDay)
	nextMonth := time.Date(startYear, startMonth+1, 1, 0, 0, 0, 0, location)
	endYear, endMonth, _ := nextMonth.Date()
	localEnd := localBoundary(location, endYear, endMonth, anchorDay)

	return localStart.In(time.UTC), localEnd.In(time.UTC), nil
}

func localBoundary(location *time.Location, year int, month time.Month, anchorDay int) time.Time {
	lastDay := time.Date(year, month+1, 0, 0, 0, 0, 0, location).Day()
	day := anchorDay
	if day > lastDay {
		day = lastDay
	}
	return time.Date(year, month, day, 0, 0, 0, 0, location)
}
