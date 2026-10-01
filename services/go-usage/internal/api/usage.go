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
	billingperiod "teideal/go-usage/internal/period"
	"teideal/go-usage/internal/security"
)

type Handlers struct {
	Pool *db.Pool
}

type usageEvent struct {
	ID                      string           `json:"id"`
	CustomerID              string           `json:"customer_id"`
	EventType               string           `json:"event_type"`
	Quantity                decimal.Decimal  `json:"quantity"`
	IdempotencyKey          string           `json:"idempotency_key"`
	OccurredAt              time.Time        `json:"occurred_at"`
	IsPriorPeriodAdjustment bool             `json:"is_prior_period_adjustment"`
	Model                   *string          `json:"model,omitempty"`
	ActualCost              *decimal.Decimal `json:"actual_cost,omitempty"`
}

var eventTypeRegex = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)
var oneTrillion = decimal.New(1, 12)
var maxActualCost = decimal.New(1, 6) // 1,000,000

func validateActualCost(ac *decimal.Decimal) error {
	if ac == nil {
		return nil
	}
	if ac.IsNegative() {
		return errors.New("actual_cost must be a non-negative number")
	}
	if ac.GreaterThanOrEqual(maxActualCost) {
		return errors.New("actual_cost must be less than 1000000")
	}
	return nil
}

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

func metricFilter(r *http.Request) *string {
	raw := r.URL.Query().Get("metric")
	if raw == "" {
		raw = r.URL.Query().Get("event_type")
	}
	if raw == "" {
		return nil
	}
	return &raw
}

type usageBucket struct {
	Hour          time.Time       `json:"hour"`
	EventType     string          `json:"event_type"`
	Count         int64           `json:"count"`
	TotalQuantity decimal.Decimal `json:"total_quantity"`
}

// GetUsage handles GET /usage?customer_id=<uuid>. The filter is validated as
// a UUID *before* it ever reaches a query -- an adversarial string (e.g. a
// SQL-injection payload) is rejected outright rather than being compared
// against a column, and the query that does run is fully parameterized
// regardless. RLS then confines the result set to the caller's own tenant.
//
// group_by=hour pushes hourly aggregation to Postgres (TEID-45 AC4/T4).
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
		if scopedToOtherCustomer(principal, raw) {
			denyCustomerNotVisible(w, r, h, principal, "/usage", "customer_id not visible to caller's tenant")
			return
		}
		customerFilter = &raw
	} else if principal.CustomerID != nil {
		customerFilter = principal.CustomerID
	}
	var priorPeriodAdjustmentFilter *bool
	if raw, present := r.URL.Query()["prior_period_adjustments"]; present {
		if len(raw) != 1 || (raw[0] != "true" && raw[0] != "false") {
			writeErr(w, http.StatusBadRequest, "prior_period_adjustments must be true or false")
			return
		}
		value := raw[0] == "true"
		priorPeriodAdjustmentFilter = &value
	}
	since, until, err := parseSinceUntil(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	groupBy := r.URL.Query().Get("group_by")
	if groupBy != "" && groupBy != "hour" {
		writeErr(w, http.StatusBadRequest, "group_by must be hour")
		return
	}
	if groupBy == "hour" {
		h.getUsageBuckets(w, r, principal, customerFilter, since, until)
		return
	}

	limit, err := parseLimit(r.URL.Query().Get("limit"), defaultUsageLimit, maxListLimit)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cursorTime, cursorID, err := decodeTimeIDCursor(r.URL.Query().Get("cursor"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var cursorTimeArg *time.Time
	var cursorIDArg *string
	if cursorID != "" {
		cursorTimeArg = &cursorTime
		cursorIDArg = &cursorID
	}
	metric := metricFilter(r)

	events := []usageEvent{}
	err = h.Pool.WithTenant(r.Context(), principal.TenantID, func(ctx context.Context, tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT id, customer_id, event_type, quantity, idempotency_key, occurred_at,
			       is_prior_period_adjustment, model, actual_cost
			FROM usage_events
			WHERE ($1::uuid IS NULL OR customer_id = $1)
			  AND ($2::boolean IS NULL OR is_prior_period_adjustment = $2)
			  AND ($3::timestamptz IS NULL OR occurred_at >= $3)
			  AND ($4::timestamptz IS NULL OR occurred_at < $4)
			  AND ($5::text IS NULL OR event_type = $5 OR event_type LIKE $5 || '.%')
			  AND ($6::timestamptz IS NULL OR (occurred_at, id) < ($6, $7::uuid))
			ORDER BY occurred_at DESC, id DESC
			LIMIT $8
		`, customerFilter, priorPeriodAdjustmentFilter, since, until, metric, cursorTimeArg, cursorIDArg, limit+1)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var e usageEvent
			var quantity pgtype.Numeric
			var actualCost pgtype.Numeric
			if err := rows.Scan(
				&e.ID, &e.CustomerID, &e.EventType, &quantity, &e.IdempotencyKey,
				&e.OccurredAt, &e.IsPriorPeriodAdjustment, &e.Model, &actualCost,
			); err != nil {
				return err
			}
			e.Quantity, err = money.FromPGNumeric(quantity)
			if err != nil {
				return err
			}
			if actualCost.Valid {
				ac, err := money.FromPGNumeric(actualCost)
				if err != nil {
					return err
				}
				e.ActualCost = &ac
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

	var next *string
	if len(events) > limit {
		events = events[:limit]
		c := encodeTimeIDCursor(events[len(events)-1].OccurredAt, events[len(events)-1].ID)
		next = &c
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": events, "cursor": next})
}

func (h *Handlers) getUsageBuckets(
	w http.ResponseWriter,
	r *http.Request,
	principal auth.Principal,
	customerFilter *string,
	since, until *time.Time,
) {
	limit, err := parseLimit(r.URL.Query().Get("limit"), 10_000, 100_000)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	metric := metricFilter(r)
	cursorTime, cursorID, err := decodeTimeIDCursor(r.URL.Query().Get("cursor"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var cursorTimeArg *time.Time
	var cursorTypeArg *string
	if cursorID != "" {
		cursorTimeArg = &cursorTime
		cursorTypeArg = &cursorID
	}

	buckets := []usageBucket{}
	err = h.Pool.WithTenant(r.Context(), principal.TenantID, func(ctx context.Context, tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT hour, event_type, event_count, total_quantity
			FROM (
				SELECT date_trunc('hour', occurred_at) AS hour, event_type,
				       COUNT(*) AS event_count, COALESCE(SUM(quantity), 0) AS total_quantity
				FROM usage_events
				WHERE ($1::uuid IS NULL OR customer_id = $1)
				  AND ($2::timestamptz IS NULL OR occurred_at >= $2)
				  AND ($3::timestamptz IS NULL OR occurred_at < $3)
				  AND ($4::text IS NULL OR event_type = $4 OR event_type LIKE $4 || '.%')
				GROUP BY 1, 2
			) buckets
			WHERE ($5::timestamptz IS NULL OR (hour, event_type) < ($5, $6::text))
			ORDER BY hour DESC, event_type DESC
			LIMIT $7
		`, customerFilter, since, until, metric, cursorTimeArg, cursorTypeArg, limit+1)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var b usageBucket
			var total pgtype.Numeric
			if err := rows.Scan(&b.Hour, &b.EventType, &b.Count, &total); err != nil {
				return err
			}
			b.TotalQuantity, err = money.FromPGNumeric(total)
			if err != nil {
				return err
			}
			buckets = append(buckets, b)
		}
		return rows.Err()
	})
	if err != nil {
		log.Printf("GetUsage buckets: %v", err)
		writeErr(w, http.StatusInternalServerError, "failed to bucket usage events")
		return
	}
	var next *string
	if len(buckets) > limit {
		buckets = buckets[:limit]
		c := encodeTimeIDCursor(buckets[len(buckets)-1].Hour, buckets[len(buckets)-1].EventType)
		next = &c
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": buckets, "cursor": next})
}

type postUsageRequest struct {
	CustomerID     string           `json:"customer_id"`
	EventType      string           `json:"event_type"`
	Quantity       decimal.Decimal  `json:"quantity"`
	IdempotencyKey string           `json:"idempotency_key"`
	OccurredAt     *time.Time       `json:"occurred_at,omitempty"`
	Model          *string          `json:"model,omitempty"`
	ActualCost     *decimal.Decimal `json:"actual_cost,omitempty"`
}

type rawBatchItem struct {
	CustomerID     *string         `json:"customer_id"`
	EventType      *string         `json:"event_type"`
	Quantity       json.RawMessage `json:"quantity"`
	IdempotencyKey *string         `json:"idempotency_key"`
	OccurredAt     json.RawMessage `json:"occurred_at"`
	Model          *string         `json:"model,omitempty"`
	ActualCost     json.RawMessage `json:"actual_cost,omitempty"`
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
	AdjustmentID   string           `json:"adjustment_id,omitempty"`
	Model          *string          `json:"model,omitempty"`
	ActualCost     *decimal.Decimal `json:"actual_cost,omitempty"`
}

type usageWriteResult struct {
	closed       bool
	queued       bool
	adjustmentID string
}

func writeUsage(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	request postUsageRequest,
	quantity pgtype.Numeric,
	now time.Time,
	created *usageEvent,
	createdQuantity *pgtype.Numeric,
) (usageWriteResult, error) {
	timezone := "UTC"
	anchorDay := 1
	var threshold pgtype.Numeric
	err := tx.QueryRow(ctx, `
		SELECT billing_timezone, billing_anchor_day, auto_approve_adjustment_threshold
		FROM customer_billing_config
		WHERE customer_id = $1
	`, request.CustomerID).Scan(&timezone, &anchorDay, &threshold)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return usageWriteResult{}, err
	}

	occurredAt := now
	if request.OccurredAt != nil {
		occurredAt = *request.OccurredAt
	}
	periodStart, periodEnd, err := billingperiod.Boundaries(timezone, anchorDay, occurredAt)
	if err != nil {
		return usageWriteResult{}, err
	}
	if now.Before(periodEnd) {
		return usageWriteResult{}, insertUsageEvent(
			ctx, tx, tenantID, request.CustomerID, request.EventType, quantity,
			request.IdempotencyKey, request.OccurredAt, request.Model, request.ActualCost, created, createdQuantity,
		)
	}

	result := usageWriteResult{closed: true}
	autoApprove := false
	if threshold.Valid {
		thresholdValue, err := money.FromPGNumeric(threshold)
		if err != nil {
			return result, err
		}
		autoApprove = request.Quantity.LessThanOrEqual(thresholdValue)
	}
	status := "pending"
	if autoApprove {
		status = "approved"
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO usage_adjustments (
			tenant_id, customer_id, event_type, quantity, idempotency_key,
			occurred_at, period_start, period_end, status, auto_approved
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		RETURNING id
	`, tenantID, request.CustomerID, request.EventType, quantity, request.IdempotencyKey,
		occurredAt, periodStart, periodEnd, status, autoApprove).Scan(&result.adjustmentID)
	if err != nil {
		return result, err
	}
	if !autoApprove {
		result.queued = true
		return result, nil
	}

	if err := insertPriorPeriodUsageEvent(
		ctx, tx, tenantID, request.CustomerID, request.EventType, quantity,
		request.IdempotencyKey, occurredAt, request.Model, request.ActualCost, created, createdQuantity,
	); err != nil {
		return result, err
	}
	_, err = tx.Exec(ctx, `
		UPDATE usage_adjustments
		SET resulting_usage_event_id = $1
		WHERE id = $2
	`, created.ID, result.adjustmentID)
	return result, err
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
		Model          *string         `json:"model"`
		ActualCost     json.RawMessage `json:"actual_cost"`
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
	var actualCost *decimal.Decimal
	if len(raw.ActualCost) > 0 && string(raw.ActualCost) != "null" {
		var ac decimal.Decimal
		if err := json.Unmarshal(raw.ActualCost, &ac); err != nil {
			writeErr(w, http.StatusBadRequest, "actual_cost must be a non-negative number less than 1000000")
			return
		}
		if err := validateActualCost(&ac); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		actualCost = &ac
	}
	req := postUsageRequest{
		CustomerID:     raw.CustomerID,
		EventType:      raw.EventType,
		Quantity:       raw.Quantity,
		IdempotencyKey: raw.IdempotencyKey,
		OccurredAt:     occurredAt,
		Model:          raw.Model,
		ActualCost:     actualCost,
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
	var writeResult usageWriteResult
	now := time.Now().UTC()
	err = h.Pool.WithTenant(r.Context(), principal.TenantID, func(ctx context.Context, tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)`, req.CustomerID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			customerNotVisible = true
			return nil
		}
		var writeErr error
		writeResult, writeErr = writeUsage(
			ctx, tx, principal.TenantID, req, quantity, now, &created, &createdQuantity,
		)
		return writeErr
	})

	// A 23505 aborts the transaction above, so classification/retry/conflict-
	// recording happens in a second, separate transaction -- exactly the
	// same shape the batch path already used before this story, and the only
	// path that ever pays this extra round trip. Every ordinary (non-
	// duplicate) insert costs exactly one transaction, same as before this
	// story -- no savepoint, no added overhead on the hot path.
	resultOutcome := outcomeInserted
	var existing existingEvent
	if !customerNotVisible && err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			if writeResult.closed {
				var adjustment existingAdjustment
				err = h.Pool.WithTenant(r.Context(), principal.TenantID, func(ctx context.Context, tx pgx.Tx) error {
					var rerr error
					resultOutcome, adjustment, rerr = resolveAdjustmentConflict(
						ctx, tx, req.IdempotencyKey, req.CustomerID, req.EventType, req.Quantity,
					)
					return rerr
				})
				if err == nil {
					writeResult.adjustmentID = adjustment.ID
					writeResult.queued = adjustment.Status == "pending"
					if adjustment.ResultingUsageEventID != nil {
						existing.ID = *adjustment.ResultingUsageEventID
					} else {
						existing.ID = adjustment.ID
					}
					existing.CustomerID = adjustment.CustomerID
					existing.EventType = adjustment.EventType
					existing.Quantity = adjustment.Quantity
				}
			} else {
				err = h.Pool.WithTenant(r.Context(), principal.TenantID, func(ctx context.Context, tx pgx.Tx) error {
					outcome, ex, rerr := resolveIdempotencyConflict(
						ctx, tx, req.IdempotencyKey, req.CustomerID, req.EventType, req.Quantity, time.Now(),
					)
					if rerr != nil {
						return rerr
					}
					resultOutcome = outcome
					existing = ex
					switch outcome {
					case outcomeInserted:
						return insertUsageEvent(
							ctx, tx, principal.TenantID, req.CustomerID, req.EventType, quantity,
							req.IdempotencyKey, req.OccurredAt, req.Model, req.ActualCost, &created, &createdQuantity,
						)
					case outcomeConflict:
						return recordConflict(
							ctx, tx, principal.TenantID, req.IdempotencyKey, ex.ID,
							req.CustomerID, req.EventType, req.Quantity,
						)
					default: // outcomeDuplicate
						return nil
					}
				})
			}
		}
	}

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
		log.Printf("PostUsage: %v", err)
		writeErr(w, http.StatusInternalServerError, "failed to record usage event")
		return
	}
	if resultOutcome == outcomeDuplicate {
		writeJSON(w, http.StatusOK, map[string]any{
			"status":          "duplicate",
			"id":              existing.ID,
			"customer_id":     existing.CustomerID,
			"event_type":      existing.EventType,
			"quantity":        existing.Quantity,
			"idempotency_key": req.IdempotencyKey,
		})
		return
	}
	if resultOutcome == outcomeConflict {
		writeJSON(w, http.StatusConflict, map[string]string{
			"error":       idempotencyConflictMessage,
			"existing_id": existing.ID,
		})
		return
	}
	if writeResult.queued {
		writeJSON(w, http.StatusAccepted, map[string]string{
			"status":        "queued_for_review",
			"adjustment_id": writeResult.adjustmentID,
		})
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

		var itemActualCost *decimal.Decimal
		if len(item.ActualCost) > 0 && string(item.ActualCost) != "null" {
			var ac decimal.Decimal
			if err := json.Unmarshal(item.ActualCost, &ac); err != nil {
				results[i] = batchResultItem{Status: "error", Reason: "actual_cost must be a non-negative number less than 1000000"}
				continue
			}
			if err := validateActualCost(&ac); err != nil {
				results[i] = batchResultItem{Status: "error", Reason: err.Error()}
				continue
			}
			itemActualCost = &ac
		}

		itemRequest := postUsageRequest{
			CustomerID:     *item.CustomerID,
			EventType:      *item.EventType,
			Quantity:       qty,
			IdempotencyKey: *item.IdempotencyKey,
			OccurredAt:     occurredAt,
			Model:          item.Model,
			ActualCost:     itemActualCost,
		}
		now := time.Now().UTC()

		var created usageEvent
		var createdQuantity pgtype.Numeric
		var customerNotVisible bool
		var writeResult usageWriteResult
		err = h.Pool.WithTenant(r.Context(), principal.TenantID, func(ctx context.Context, tx pgx.Tx) error {
			var exists bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)`, *item.CustomerID).Scan(&exists); err != nil {
				return err
			}
			if !exists {
				customerNotVisible = true
				return nil
			}
			var writeErr error
			writeResult, writeErr = writeUsage(
				ctx, tx, principal.TenantID, itemRequest, quantity, now, &created, &createdQuantity,
			)
			return writeErr
		})

		// Same second-transaction shape as postUsageSingle above -- see its
		// comment. Only a 23505 ever pays this extra round trip. A closed
		// period's conflict is resolved against usage_adjustments, an open
		// period's against usage_events -- the same branch postUsageSingle
		// already makes.
		resultOutcome := outcomeInserted
		var existing existingEvent
		var existingAdj existingAdjustment
		if !customerNotVisible && err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				if writeResult.closed {
					err = h.Pool.WithTenant(r.Context(), principal.TenantID, func(ctx context.Context, tx pgx.Tx) error {
						var rerr error
						resultOutcome, existingAdj, rerr = resolveAdjustmentConflict(
							ctx, tx, *item.IdempotencyKey, *item.CustomerID, *item.EventType, qty,
						)
						return rerr
					})
				} else {
					err = h.Pool.WithTenant(r.Context(), principal.TenantID, func(ctx context.Context, tx pgx.Tx) error {
						outcome, ex, rerr := resolveIdempotencyConflict(
							ctx, tx, *item.IdempotencyKey, *item.CustomerID, *item.EventType, qty, time.Now(),
						)
						if rerr != nil {
							return rerr
						}
						resultOutcome = outcome
						existing = ex
						switch outcome {
						case outcomeInserted:
							return insertUsageEvent(
								ctx, tx, principal.TenantID, *item.CustomerID, *item.EventType, quantity,
								*item.IdempotencyKey, occurredAt, item.Model, itemActualCost, &created, &createdQuantity,
							)
						case outcomeConflict:
							return recordConflict(
								ctx, tx, principal.TenantID, *item.IdempotencyKey, ex.ID,
								*item.CustomerID, *item.EventType, qty,
							)
						default: // outcomeDuplicate
							return nil
						}
					})
				}
			}
		}

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
			log.Printf("PostUsage batch item %d: %v", i, err)
			results[i] = batchResultItem{Status: "error", Reason: "failed to record usage event"}
			continue
		}
		if resultOutcome == outcomeDuplicate {
			if existingAdj.ID != "" {
				id := existingAdj.ID
				if existingAdj.ResultingUsageEventID != nil {
					id = *existingAdj.ResultingUsageEventID
				}
				results[i] = batchResultItem{Status: "duplicate", ID: id}
			} else {
				results[i] = batchResultItem{Status: "duplicate", ID: existing.ID}
			}
			continue
		}
		if resultOutcome == outcomeConflict {
			results[i] = batchResultItem{
				Status: "conflict",
				ID:     existing.ID,
				Reason: idempotencyConflictMessage,
			}
			continue
		}
		if writeResult.queued {
			results[i] = batchResultItem{Status: "queued_for_review", AdjustmentID: writeResult.adjustmentID}
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
			Model:          created.Model,
			ActualCost:     created.ActualCost,
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

type existingAdjustment struct {
	ID                    string
	CustomerID            string
	EventType             string
	Quantity              decimal.Decimal
	Status                string
	ResultingUsageEventID *string
}

func resolveAdjustmentConflict(
	ctx context.Context,
	tx pgx.Tx,
	idempotencyKey string,
	attemptedCustomerID string,
	attemptedEventType string,
	attemptedQuantity decimal.Decimal,
) (idempotencyOutcome, existingAdjustment, error) {
	var existing existingAdjustment
	err := tx.QueryRow(ctx, `
		SELECT id, customer_id, event_type, quantity, status, resulting_usage_event_id
		FROM usage_adjustments
		WHERE idempotency_key = $1
	`, idempotencyKey).Scan(
		&existing.ID, &existing.CustomerID, &existing.EventType, &existing.Quantity,
		&existing.Status, &existing.ResultingUsageEventID,
	)
	if err != nil {
		return outcomeConflict, existingAdjustment{}, err
	}
	if existing.CustomerID == attemptedCustomerID &&
		existing.EventType == attemptedEventType &&
		existing.Quantity.Equal(attemptedQuantity) {
		return outcomeDuplicate, existing, nil
	}
	return outcomeConflict, existing, nil
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
	model *string,
	actualCost *decimal.Decimal,
	created *usageEvent,
	createdQuantity *pgtype.Numeric,
) error {
	var acNumeric pgtype.Numeric
	if actualCost != nil {
		var err error
		acNumeric, err = money.ToPGNumeric(*actualCost)
		if err != nil {
			return err
		}
	}

	var retActualCost pgtype.Numeric
	var err error
	if occurredAt == nil {
		err = tx.QueryRow(ctx, `
			INSERT INTO usage_events (tenant_id, customer_id, event_type, quantity, idempotency_key, model, actual_cost)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			RETURNING id, customer_id, event_type, quantity, idempotency_key, occurred_at, model, actual_cost
		`, tenantID, customerID, eventType, quantity, idempotencyKey, model, acNumeric).
			Scan(&created.ID, &created.CustomerID, &created.EventType, createdQuantity, &created.IdempotencyKey, &created.OccurredAt, &created.Model, &retActualCost)
	} else {
		err = tx.QueryRow(ctx, `
			INSERT INTO usage_events (tenant_id, customer_id, event_type, quantity, idempotency_key, occurred_at, model, actual_cost)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			RETURNING id, customer_id, event_type, quantity, idempotency_key, occurred_at, model, actual_cost
		`, tenantID, customerID, eventType, quantity, idempotencyKey, occurredAt, model, acNumeric).
			Scan(&created.ID, &created.CustomerID, &created.EventType, createdQuantity, &created.IdempotencyKey, &created.OccurredAt, &created.Model, &retActualCost)
	}
	if err != nil {
		return err
	}
	if retActualCost.Valid {
		ac, err := money.FromPGNumeric(retActualCost)
		if err != nil {
			return err
		}
		created.ActualCost = &ac
	}
	return nil
}

func insertPriorPeriodUsageEvent(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	customerID string,
	eventType string,
	quantity pgtype.Numeric,
	idempotencyKey string,
	occurredAt time.Time,
	model *string,
	actualCost *decimal.Decimal,
	created *usageEvent,
	createdQuantity *pgtype.Numeric,
) error {
	var acNumeric pgtype.Numeric
	if actualCost != nil {
		var err error
		acNumeric, err = money.ToPGNumeric(*actualCost)
		if err != nil {
			return err
		}
	}

	var retActualCost pgtype.Numeric
	err := tx.QueryRow(ctx, `
		INSERT INTO usage_events (
			tenant_id, customer_id, event_type, quantity, idempotency_key,
			occurred_at, is_prior_period_adjustment, model, actual_cost
		)
		VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8)
		RETURNING id, customer_id, event_type, quantity, idempotency_key, occurred_at,
		          is_prior_period_adjustment, model, actual_cost
	`, tenantID, customerID, eventType, quantity, idempotencyKey, occurredAt, model, acNumeric).
		Scan(
			&created.ID, &created.CustomerID, &created.EventType, createdQuantity,
			&created.IdempotencyKey, &created.OccurredAt, &created.IsPriorPeriodAdjustment,
			&created.Model, &retActualCost,
		)
	if err != nil {
		return err
	}
	if retActualCost.Valid {
		ac, err := money.FromPGNumeric(retActualCost)
		if err != nil {
			return err
		}
		created.ActualCost = &ac
	}
	return nil
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
