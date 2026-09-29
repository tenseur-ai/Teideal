package api

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"

	"teideal/go-usage/internal/auth"
	ledgerpkg "teideal/go-usage/internal/ledger"
)

// PostRecalculateCustomerBalance handles POST /customers/{id}/recalculate-balance.
func (h *Handlers) PostRecalculateCustomerBalance(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthenticated")
		return
	}
	customerID := r.PathValue("id")
	if _, err := uuid.Parse(customerID); err != nil {
		writeErr(w, http.StatusBadRequest, "customer_id must be a UUID")
		return
	}
	accountCode := r.URL.Query().Get("account_code")
	if accountCode == "" {
		accountCode = "receivable"
	}
	now := time.Now().UTC()
	balance, recalculatedAt, err := ledgerpkg.RecalculateCustomerBalance(
		r.Context(), h.Pool, principal.TenantID, customerID, accountCode, now,
	)
	if err != nil {
		writeLedgerError(w, "PostRecalculateCustomerBalance", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"customer_id": customerID, "account_code": accountCode,
		"balance": balance, "recalculated_at": recalculatedAt,
	})
}

type balanceIntegrityCheck struct {
	ID                  string          `json:"id"`
	TenantID            string          `json:"tenant_id"`
	CustomerID          string          `json:"customer_id"`
	AccountCode         string          `json:"account_code"`
	CachedBalance       decimal.Decimal `json:"cached_balance"`
	RecalculatedBalance decimal.Decimal `json:"recalculated_balance"`
	Discrepancy         decimal.Decimal `json:"discrepancy"`
	AlertSent           bool            `json:"alert_sent"`
	DetectedAt          time.Time       `json:"detected_at"`
}

// GetBalanceIntegrityChecks handles GET /balance-integrity/checks.
func (h *Handlers) GetBalanceIntegrityChecks(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthenticated")
		return
	}
	checks := []balanceIntegrityCheck{}
	err := h.Pool.WithTenant(r.Context(), principal.TenantID, func(ctx context.Context, tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT id, tenant_id, customer_id, account_code, cached_balance,
			       recalculated_balance, discrepancy, alert_sent, detected_at
			FROM balance_integrity_checks
			ORDER BY detected_at DESC
			LIMIT 500
		`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var check balanceIntegrityCheck
			if err := rows.Scan(
				&check.ID, &check.TenantID, &check.CustomerID, &check.AccountCode,
				&check.CachedBalance, &check.RecalculatedBalance,
				&check.Discrepancy, &check.AlertSent, &check.DetectedAt,
			); err != nil {
				return err
			}
			checks = append(checks, check)
		}
		return rows.Err()
	})
	if err != nil {
		log.Printf("GetBalanceIntegrityChecks: %v", err)
		writeErr(w, http.StatusInternalServerError, "failed to list balance integrity checks")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": checks})
}
