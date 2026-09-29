package api

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"teideal/go-usage/internal/auth"
	ledgerpkg "teideal/go-usage/internal/ledger"
	"teideal/go-usage/internal/money"
)

func writeLedgerError(w http.ResponseWriter, operation string, err error) {
	var validationErr *ledgerpkg.ValidationError
	if errors.As(err, &validationErr) {
		writeErr(w, http.StatusBadRequest, validationErr.Error())
		return
	}
	var notFoundErr *ledgerpkg.NotFoundError
	if errors.As(err, &notFoundErr) {
		writeErr(w, http.StatusNotFound, notFoundErr.Error())
		return
	}
	log.Printf("%s: %v", operation, err)
	writeErr(w, http.StatusInternalServerError, "ledger operation failed")
}

// PostLedgerTransaction handles POST /ledger/transactions.
func (h *Handlers) PostLedgerTransaction(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthenticated")
		return
	}
	var input ledgerpkg.PostTransactionInput
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	var created ledgerpkg.Transaction
	err := h.Pool.WithTenant(r.Context(), principal.TenantID, func(ctx context.Context, tx pgx.Tx) error {
		var err error
		created, err = ledgerpkg.PostTransaction(ctx, tx, principal.TenantID, input)
		return err
	})
	if err != nil {
		writeLedgerError(w, "PostLedgerTransaction", err)
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

type reverseLedgerTransactionRequest struct {
	Reason string `json:"reason"`
}

// ReverseLedgerTransaction handles POST /ledger/transactions/:id/reverse.
func (h *Handlers) ReverseLedgerTransaction(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthenticated")
		return
	}
	id := r.PathValue("id")
	if _, err := uuid.Parse(id); err != nil {
		writeErr(w, http.StatusBadRequest, "ledger transaction id must be a UUID")
		return
	}
	var req reverseLedgerTransactionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if strings.TrimSpace(req.Reason) == "" {
		writeErr(w, http.StatusBadRequest, "reason is required")
		return
	}

	var created ledgerpkg.Transaction
	err := h.Pool.WithTenant(r.Context(), principal.TenantID, func(ctx context.Context, tx pgx.Tx) error {
		var err error
		created, err = ledgerpkg.ReverseTransaction(ctx, tx, principal.TenantID, id, req.Reason)
		return err
	})
	if err != nil {
		writeLedgerError(w, "ReverseLedgerTransaction", err)
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

// GetLedgerTransaction handles GET /ledger/transactions/:id.
func (h *Handlers) GetLedgerTransaction(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthenticated")
		return
	}
	id := r.PathValue("id")
	if _, err := uuid.Parse(id); err != nil {
		writeErr(w, http.StatusBadRequest, "ledger transaction id must be a UUID")
		return
	}

	var result ledgerpkg.Transaction
	err := h.Pool.WithTenant(r.Context(), principal.TenantID, func(ctx context.Context, tx pgx.Tx) error {
		var err error
		result, err = ledgerpkg.GetTransaction(ctx, tx, id)
		return err
	})
	if err != nil {
		writeLedgerError(w, "GetLedgerTransaction", err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

type ledgerTransactionListItem struct {
	ID                    string    `json:"id"`
	CustomerID            string    `json:"customer_id"`
	UsageEventID          *string   `json:"usage_event_id"`
	GrantID               *string   `json:"grant_id"`
	ReservationID         *string   `json:"reservation_id"`
	PricingRuleID         *string   `json:"pricing_rule_id"`
	PlanVersion           *int      `json:"plan_version"`
	ReversesTransactionID *string   `json:"reverses_transaction_id"`
	Description           *string   `json:"description"`
	CreatedAt             time.Time `json:"created_at"`
}

// ListCustomerLedgerTransactions handles GET /customers/{id}/ledger-transactions.
func (h *Handlers) ListCustomerLedgerTransactions(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthenticated")
		return
	}
	customerID := r.PathValue("id")
	if _, err := uuid.Parse(customerID); err != nil {
		writeErr(w, http.StatusBadRequest, "id must be a UUID")
		return
	}
	if scopedToOtherCustomer(principal, customerID) {
		denyCustomerNotVisible(w, r, h, principal, "/customers/{id}/ledger-transactions", "customer_id not visible to caller's tenant")
		return
	}
	since, until, err := parseSinceUntil(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	limit, err := parseLimit(r.URL.Query().Get("limit"), defaultListLimit, maxListLimit)
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

	items := []ledgerTransactionListItem{}
	var missing bool
	err = h.Pool.WithTenant(r.Context(), principal.TenantID, func(ctx context.Context, tx pgx.Tx) error {
		visible, visErr := customerVisible(ctx, tx, customerID)
		if visErr != nil {
			return visErr
		}
		if !visible {
			missing = true
			return nil
		}
		rows, qerr := tx.Query(ctx, `
			SELECT id, customer_id, usage_event_id, grant_id, reservation_id,
			       pricing_rule_id, plan_version, reverses_transaction_id,
			       description, created_at
			FROM ledger_transactions
			WHERE customer_id = $1
			  AND ($2::timestamptz IS NULL OR created_at >= $2)
			  AND ($3::timestamptz IS NULL OR created_at < $3)
			  AND ($4::timestamptz IS NULL OR (created_at, id) < ($4, $5::uuid))
			ORDER BY created_at DESC, id DESC
			LIMIT $6
		`, customerID, since, until, cursorTimeArg, cursorIDArg, limit+1)
		if qerr != nil {
			return qerr
		}
		defer rows.Close()
		for rows.Next() {
			var item ledgerTransactionListItem
			if err := rows.Scan(
				&item.ID, &item.CustomerID, &item.UsageEventID, &item.GrantID,
				&item.ReservationID, &item.PricingRuleID, &item.PlanVersion,
				&item.ReversesTransactionID, &item.Description, &item.CreatedAt,
			); err != nil {
				return err
			}
			items = append(items, item)
		}
		return rows.Err()
	})
	if err != nil {
		log.Printf("ListCustomerLedgerTransactions: %v", err)
		writeErr(w, http.StatusInternalServerError, "failed to list ledger transactions")
		return
	}
	if missing {
		denyCustomerNotVisible(w, r, h, principal, "/customers/{id}/ledger-transactions", "customer_id not visible to caller's tenant")
		return
	}
	var next *string
	if len(items) > limit {
		items = items[:limit]
		c := encodeTimeIDCursor(items[len(items)-1].CreatedAt, items[len(items)-1].ID)
		next = &c
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": items, "cursor": next})
}

type ledgerTransactionDetail struct {
	ledgerpkg.Transaction
	UsageEvent *usageEvent `json:"usage_event"`
}

// GetLedgerTransactionDetail handles GET /ledger/transactions/{id}/detail.
// The customer-visibility re-check is intentional and not redundant with RLS:
// tenant RLS cannot express api_keys.customer_id scoping (TEID-45-T8).
func (h *Handlers) GetLedgerTransactionDetail(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthenticated")
		return
	}
	id := r.PathValue("id")
	if _, err := uuid.Parse(id); err != nil {
		writeErr(w, http.StatusBadRequest, "ledger transaction id must be a UUID")
		return
	}

	var result ledgerTransactionDetail
	var notVisible bool
	err := h.Pool.WithTenant(r.Context(), principal.TenantID, func(ctx context.Context, tx pgx.Tx) error {
		txn, err := ledgerpkg.GetTransaction(ctx, tx, id)
		if err != nil {
			return err
		}
		visible, visErr := customerVisible(ctx, tx, txn.CustomerID)
		if visErr != nil {
			return visErr
		}
		if !visible || scopedToOtherCustomer(principal, txn.CustomerID) {
			notVisible = true
			return nil
		}
		result.Transaction = txn
		if txn.UsageEventID == nil {
			return nil
		}
		var event usageEvent
		var quantity pgtype.Numeric
		scanErr := tx.QueryRow(ctx, `
			SELECT id, customer_id, event_type, quantity, idempotency_key, occurred_at,
			       is_prior_period_adjustment
			FROM usage_events WHERE id = $1
		`, *txn.UsageEventID).Scan(
			&event.ID, &event.CustomerID, &event.EventType, &quantity,
			&event.IdempotencyKey, &event.OccurredAt, &event.IsPriorPeriodAdjustment,
		)
		if scanErr != nil {
			if errors.Is(scanErr, pgx.ErrNoRows) {
				return nil
			}
			return scanErr
		}
		event.Quantity, err = money.FromPGNumeric(quantity)
		if err != nil {
			return err
		}
		result.UsageEvent = &event
		return nil
	})
	if notVisible {
		denyCustomerNotVisible(w, r, h, principal, "/ledger/transactions/{id}/detail", "customer_id not visible to caller's tenant")
		return
	}
	if err != nil {
		writeLedgerError(w, "GetLedgerTransactionDetail", err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
