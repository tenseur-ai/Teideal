package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"

	"teideal/go-usage/internal/auth"
	"teideal/go-usage/internal/db"
	"teideal/go-usage/internal/money"
	"teideal/go-usage/internal/security"
)

type Handlers struct {
	Pool *db.Pool
}

type usageEvent struct {
	ID             string          `json:"id"`
	CustomerID     string          `json:"customer_id"`
	EventType      string          `json:"event_type"`
	Quantity       decimal.Decimal `json:"quantity"`
	IdempotencyKey string          `json:"idempotency_key"`
	OccurredAt     time.Time       `json:"occurred_at"`
}

var eventTypeRegex = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)
var oneTrillion = decimal.New(1, 12)

func init() {
	// decimal defaults to quoted JSON strings. Usage quantities have always
	// been JSON number tokens, so opt into the library's exact raw-token mode.
	decimal.MarshalJSONWithoutQuotes = true
}

func validateEventType(et string) error {
	if !eventTypeRegex.MatchString(et) {
		return errors.New("event_type must match ^[A-Za-z0-9_.:-]{1,128}$")
	}
	return nil
}

func validateQuantity(q decimal.Decimal) error {
	if q.IsNegative() {
		return errors.New("quantity must be a non-negative number")
	}
	if q.GreaterThan(oneTrillion) {
		return errors.New("quantity must not exceed 1000000000000 (one trillion)")
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// GetUsage handles GET /usage?customer_id=<uuid>. The filter is validated as
// a UUID *before* it ever reaches a query -- an adversarial string (e.g. a
// SQL-injection payload) is rejected outright rather than being compared
// against a column, and the query that does run is fully parameterized
// regardless. RLS then confines the result set to the caller's own tenant.
func (h *Handlers) GetUsage(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthenticated")
		return
	}

	var customerFilter *string
	if raw := r.URL.Query().Get("customer_id"); raw != "" {
		if _, err := uuid.Parse(raw); err != nil {
			writeErr(w, http.StatusBadRequest, "customer_id must be a UUID")
			return
		}
		customerFilter = &raw
	}

	events := []usageEvent{}
	err := h.Pool.WithTenant(r.Context(), principal.TenantID, func(ctx context.Context, tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT id, customer_id, event_type, quantity, idempotency_key, occurred_at
			FROM usage_events
			WHERE ($1::uuid IS NULL OR customer_id = $1)
			ORDER BY occurred_at DESC
			LIMIT 200
		`, customerFilter)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var e usageEvent
			var quantity pgtype.Numeric
			if err := rows.Scan(&e.ID, &e.CustomerID, &e.EventType, &quantity, &e.IdempotencyKey, &e.OccurredAt); err != nil {
				return err
			}
			e.Quantity, err = money.FromPGNumeric(quantity)
			if err != nil {
				return err
			}
			events = append(events, e)
		}
		return rows.Err()
	})
	if err != nil {
		log.Printf("GetUsage: %v", err)
		writeErr(w, http.StatusInternalServerError, "failed to list usage events")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"data": events})
}

type postUsageRequest struct {
	CustomerID     string          `json:"customer_id"`
	EventType      string          `json:"event_type"`
	Quantity       decimal.Decimal `json:"quantity"`
	IdempotencyKey string          `json:"idempotency_key"`
	OccurredAt     *time.Time      `json:"occurred_at,omitempty"`
}

type rawBatchItem struct {
	CustomerID     *string         `json:"customer_id"`
	EventType      *string         `json:"event_type"`
	Quantity       json.RawMessage `json:"quantity"`
	IdempotencyKey *string         `json:"idempotency_key"`
	OccurredAt     json.RawMessage `json:"occurred_at"`
}

type batchResultItem struct {
	Status         string           `json:"status"`
	ID             string           `json:"id,omitempty"`
	CustomerID     string           `json:"customer_id,omitempty"`
	EventType      string           `json:"event_type,omitempty"`
	Quantity       *decimal.Decimal `json:"quantity,omitempty"`
	IdempotencyKey string           `json:"idempotency_key,omitempty"`
	OccurredAt     *time.Time       `json:"occurred_at,omitempty"`
	Reason         string           `json:"reason,omitempty"`
}

// PostUsage handles POST /usage. tenant_id is always taken from the
// authenticated principal, never from the request body, so a client cannot
// simply set tenant_id in the payload to write into another tenant's
// ledger. customer_id is additionally verified to resolve under the
// caller's own RLS context before the event is written, which is what
// stops a caller from attaching a usage event to another tenant's customer.
func (h *Handlers) PostUsage(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthenticated")
		return
	}

	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	trimmed := bytes.TrimSpace(bodyBytes)
	if len(trimmed) == 0 {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	if trimmed[0] == '[' {
		h.postUsageBatch(w, r, principal, trimmed)
		return
	} else if trimmed[0] == '{' {
		h.postUsageSingle(w, r, principal, trimmed)
		return
	}

	writeErr(w, http.StatusBadRequest, "invalid JSON body")
}

func (h *Handlers) postUsageSingle(w http.ResponseWriter, r *http.Request, principal auth.Principal, bodyBytes []byte) {
	var raw struct {
		CustomerID     string          `json:"customer_id"`
		EventType      string          `json:"event_type"`
		Quantity       decimal.Decimal `json:"quantity"`
		IdempotencyKey string          `json:"idempotency_key"`
		OccurredAt     json.RawMessage `json:"occurred_at"`
	}
	if err := json.Unmarshal(bodyBytes, &raw); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	occurredAt, err := parseOptionalExplicitTimestamp(raw.OccurredAt, "occurred_at")
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	req := postUsageRequest{
		CustomerID:     raw.CustomerID,
		EventType:      raw.EventType,
		Quantity:       raw.Quantity,
		IdempotencyKey: raw.IdempotencyKey,
		OccurredAt:     occurredAt,
	}
	if _, err := uuid.Parse(req.CustomerID); err != nil {
		writeErr(w, http.StatusBadRequest, "customer_id must be a UUID")
		return
	}
	if req.EventType == "" || req.IdempotencyKey == "" {
		writeErr(w, http.StatusBadRequest, "event_type and idempotency_key are required")
		return
	}
	if err := validateEventType(req.EventType); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateQuantity(req.Quantity); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	quantity, err := money.ToPGNumeric(req.Quantity)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "quantity must be a non-negative number")
		return
	}

	var created usageEvent
	var createdQuantity pgtype.Numeric
	var customerNotVisible bool
	err = h.Pool.WithTenant(r.Context(), principal.TenantID, func(ctx context.Context, tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)`, req.CustomerID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			customerNotVisible = true
			return nil
		}
		return insertUsageEvent(
			ctx, tx, principal.TenantID, req.CustomerID, req.EventType, quantity,
			req.IdempotencyKey, req.OccurredAt, &created, &createdQuantity,
		)
	})

	if customerNotVisible {
		_ = security.LogBlocked(r.Context(), h.Pool.Pool, security.BlockedAttempt{
			ActingTenantID: principal.TenantID,
			Endpoint:       "/usage",
			Method:         http.MethodPost,
			Detail:         "customer_id not visible to caller's tenant",
			ResolvedAction: "blocked_customer_not_visible",
		})
		writeErr(w, http.StatusForbidden, "customer not found for this tenant")
		return
	}
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			writeErr(w, http.StatusConflict, "idempotency_key already used for this tenant")
			return
		}
		log.Printf("PostUsage: %v", err)
		writeErr(w, http.StatusInternalServerError, "failed to record usage event")
		return
	}
	created.Quantity, err = money.FromPGNumeric(createdQuantity)
	if err != nil {
		log.Printf("PostUsage quantity conversion: %v", err)
		writeErr(w, http.StatusInternalServerError, "failed to record usage event")
		return
	}

	writeJSON(w, http.StatusCreated, created)
}

func (h *Handlers) postUsageBatch(w http.ResponseWriter, r *http.Request, principal auth.Principal, bodyBytes []byte) {
	var rawItems []json.RawMessage
	if err := json.Unmarshal(bodyBytes, &rawItems); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	if len(rawItems) == 0 {
		writeErr(w, http.StatusBadRequest, "batch must contain at least 1 event")
		return
	}
	if len(rawItems) > 1000 {
		writeErr(w, http.StatusBadRequest, "batch exceeds 1000 events")
		return
	}

	results := make([]batchResultItem, len(rawItems))
	for i, raw := range rawItems {
		var item rawBatchItem
		if err := json.Unmarshal(raw, &item); err != nil {
			results[i] = batchResultItem{
				Status: "error",
				Reason: "invalid event payload",
			}
			continue
		}

		if item.CustomerID == nil {
			results[i] = batchResultItem{Status: "error", Reason: "customer_id must be a UUID"}
			continue
		}
		if _, err := uuid.Parse(*item.CustomerID); err != nil {
			results[i] = batchResultItem{Status: "error", Reason: "customer_id must be a UUID"}
			continue
		}

		if item.EventType == nil {
			results[i] = batchResultItem{Status: "error", Reason: "event_type must match ^[A-Za-z0-9_.:-]{1,128}$"}
			continue
		}
		if err := validateEventType(*item.EventType); err != nil {
			results[i] = batchResultItem{Status: "error", Reason: err.Error()}
			continue
		}

		if len(item.Quantity) == 0 || string(item.Quantity) == "null" {
			results[i] = batchResultItem{Status: "error", Reason: "quantity must be a non-negative number"}
			continue
		}
		var qty decimal.Decimal
		if err := json.Unmarshal(item.Quantity, &qty); err != nil {
			results[i] = batchResultItem{Status: "error", Reason: "quantity must be a non-negative number"}
			continue
		}
		if err := validateQuantity(qty); err != nil {
			results[i] = batchResultItem{Status: "error", Reason: err.Error()}
			continue
		}
		quantity, err := money.ToPGNumeric(qty)
		if err != nil {
			results[i] = batchResultItem{Status: "error", Reason: "quantity must be a non-negative number"}
			continue
		}

		if item.IdempotencyKey == nil || *item.IdempotencyKey == "" {
			results[i] = batchResultItem{Status: "error", Reason: "idempotency_key is required"}
			continue
		}
		occurredAt, err := parseOptionalExplicitTimestamp(item.OccurredAt, "occurred_at")
		if err != nil {
			results[i] = batchResultItem{Status: "error", Reason: err.Error()}
			continue
		}

		var created usageEvent
		var createdQuantity pgtype.Numeric
		var customerNotVisible bool
		err = h.Pool.WithTenant(r.Context(), principal.TenantID, func(ctx context.Context, tx pgx.Tx) error {
			var exists bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)`, *item.CustomerID).Scan(&exists); err != nil {
				return err
			}
			if !exists {
				customerNotVisible = true
				return nil
			}
			return insertUsageEvent(
				ctx, tx, principal.TenantID, *item.CustomerID, *item.EventType, quantity,
				*item.IdempotencyKey, occurredAt, &created, &createdQuantity,
			)
		})

		if customerNotVisible {
			_ = security.LogBlocked(r.Context(), h.Pool.Pool, security.BlockedAttempt{
				ActingTenantID: principal.TenantID,
				Endpoint:       "/usage",
				Method:         http.MethodPost,
				Detail:         "customer_id not visible to caller's tenant",
				ResolvedAction: "blocked_customer_not_visible",
			})
			results[i] = batchResultItem{Status: "error", Reason: "customer not found for this tenant"}
			continue
		}

		if err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				var existingID string
				lookupErr := h.Pool.WithTenant(r.Context(), principal.TenantID, func(ctx context.Context, tx pgx.Tx) error {
					return tx.QueryRow(ctx, `SELECT id FROM usage_events WHERE idempotency_key = $1`, *item.IdempotencyKey).Scan(&existingID)
				})
				if lookupErr == nil {
					results[i] = batchResultItem{
						Status: "duplicate",
						ID:     existingID,
					}
					continue
				}
			}
			log.Printf("PostUsage batch item %d: %v", i, err)
			results[i] = batchResultItem{Status: "error", Reason: "failed to record usage event"}
			continue
		}
		created.Quantity, err = money.FromPGNumeric(createdQuantity)
		if err != nil {
			log.Printf("PostUsage batch item %d quantity conversion: %v", i, err)
			results[i] = batchResultItem{Status: "error", Reason: "failed to record usage event"}
			continue
		}

		results[i] = batchResultItem{
			Status:         "created",
			ID:             created.ID,
			CustomerID:     created.CustomerID,
			EventType:      created.EventType,
			Quantity:       &created.Quantity,
			IdempotencyKey: created.IdempotencyKey,
			OccurredAt:     &created.OccurredAt,
		}
	}

	writeJSON(w, http.StatusMultiStatus, map[string]any{"results": results})
}

func parseOptionalExplicitTimestamp(raw json.RawMessage, field string) (*time.Time, error) {
	if len(raw) == 0 {
		return nil, nil
	}

	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, fmt.Errorf("%s must be an RFC3339 timestamp with an explicit UTC offset or Z", field)
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return nil, fmt.Errorf("%s must be an RFC3339 timestamp with an explicit UTC offset or Z", field)
	}
	return &parsed, nil
}

func insertUsageEvent(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	customerID string,
	eventType string,
	quantity pgtype.Numeric,
	idempotencyKey string,
	occurredAt *time.Time,
	created *usageEvent,
	createdQuantity *pgtype.Numeric,
) error {
	if occurredAt == nil {
		return tx.QueryRow(ctx, `
			INSERT INTO usage_events (tenant_id, customer_id, event_type, quantity, idempotency_key)
			VALUES ($1, $2, $3, $4, $5)
			RETURNING id, customer_id, event_type, quantity, idempotency_key, occurred_at
		`, tenantID, customerID, eventType, quantity, idempotencyKey).
			Scan(&created.ID, &created.CustomerID, &created.EventType, createdQuantity, &created.IdempotencyKey, &created.OccurredAt)
	}

	return tx.QueryRow(ctx, `
		INSERT INTO usage_events (tenant_id, customer_id, event_type, quantity, idempotency_key, occurred_at)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, customer_id, event_type, quantity, idempotency_key, occurred_at
	`, tenantID, customerID, eventType, quantity, idempotencyKey, occurredAt).
		Scan(&created.ID, &created.CustomerID, &created.EventType, createdQuantity, &created.IdempotencyKey, &created.OccurredAt)
}

type usageSummaryResponse struct {
	EventCount    int64  `json:"event_count"`
	TotalQuantity string `json:"total_quantity"`
}

// GetUsageSummary handles GET /usage/summary?customer_id=<uuid>. PostgreSQL
// performs the NUMERIC aggregation exactly and RLS confines it to the caller's
// tenant.
func (h *Handlers) GetUsageSummary(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthenticated")
		return
	}

	var customerFilter *string
	if raw := r.URL.Query().Get("customer_id"); raw != "" {
		if _, err := uuid.Parse(raw); err != nil {
			writeErr(w, http.StatusBadRequest, "customer_id must be a UUID")
			return
		}
		customerFilter = &raw
	}

	var response usageSummaryResponse
	var total pgtype.Numeric
	err := h.Pool.WithTenant(r.Context(), principal.TenantID, func(ctx context.Context, tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT COUNT(*), COALESCE(SUM(quantity), 0)
			FROM usage_events
			WHERE ($1::uuid IS NULL OR customer_id = $1)
		`, customerFilter).Scan(&response.EventCount, &total)
	})
	if err != nil {
		log.Printf("GetUsageSummary: %v", err)
		writeErr(w, http.StatusInternalServerError, "failed to summarize usage events")
		return
	}
	totalQuantity, err := money.FromPGNumeric(total)
	if err != nil {
		log.Printf("GetUsageSummary quantity conversion: %v", err)
		writeErr(w, http.StatusInternalServerError, "failed to summarize usage events")
		return
	}
	response.TotalQuantity = totalQuantity.String()

	writeJSON(w, http.StatusOK, response)
}
