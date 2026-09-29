package api

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"
)

const (
	defaultListLimit  = 100
	maxListLimit      = 500
	defaultUsageLimit = 200
)

type timeIDCursor struct {
	T  time.Time `json:"t"`
	ID string    `json:"id"`
}

func encodeTimeIDCursor(t time.Time, id string) string {
	payload, err := json.Marshal(timeIDCursor{T: t.UTC(), ID: id})
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(payload)
}

func decodeTimeIDCursor(raw string) (time.Time, string, error) {
	if raw == "" {
		return time.Time{}, "", nil
	}
	payload, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return time.Time{}, "", errors.New("cursor is invalid")
	}
	var cursor timeIDCursor
	if err := json.Unmarshal(payload, &cursor); err != nil || cursor.ID == "" || cursor.T.IsZero() {
		return time.Time{}, "", errors.New("cursor is invalid")
	}
	return cursor.T.UTC(), cursor.ID, nil
}

func parseLimit(raw string, defaultLimit, maxLimit int) (int, error) {
	if raw == "" {
		return defaultLimit, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return 0, errors.New("limit must be a positive integer")
	}
	if n > maxLimit {
		return maxLimit, nil
	}
	return n, nil
}

func parseOptionalTime(raw, name string) (*time.Time, error) {
	if raw == "" {
		return nil, nil
	}
	if t, err := time.Parse(time.RFC3339Nano, raw); err == nil {
		utc := t.UTC()
		return &utc, nil
	}
	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		utc := t.UTC()
		return &utc, nil
	}
	if t, err := time.Parse("2006-01-02", raw); err == nil {
		utc := t.UTC()
		return &utc, nil
	}
	return nil, errors.New(name + " must be an RFC3339 timestamp")
}

func parseSinceUntil(r *http.Request) (*time.Time, *time.Time, error) {
	since, err := parseOptionalTime(r.URL.Query().Get("since"), "since")
	if err != nil {
		return nil, nil, err
	}
	until, err := parseOptionalTime(r.URL.Query().Get("until"), "until")
	if err != nil {
		return nil, nil, err
	}
	if since != nil && until != nil && since.After(*until) {
		return nil, nil, errors.New("since must not be later than until")
	}
	return since, until, nil
}
