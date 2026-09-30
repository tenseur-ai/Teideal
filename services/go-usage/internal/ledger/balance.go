package ledger

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"

	"teideal/go-usage/internal/db"
)

const receivableAccount = "receivable"

// GetCustomerBalance calculates a customer's account balance directly from
// the append-only ledger. It never reads customer_balance_cache.
func GetCustomerBalance(ctx context.Context, tx pgx.Tx, customerID, accountCode string) (decimal.Decimal, error) {
	var balance decimal.Decimal
	err := tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(
			CASE WHEN ll.direction = 'debit' THEN ll.amount ELSE -ll.amount END
		), 0)
		FROM ledger_lines ll
		JOIN ledger_transactions lt ON lt.id = ll.transaction_id
		WHERE lt.customer_id = $1 AND ll.account_code = $2
	`, customerID, accountCode).Scan(&balance)
	return balance, err
}

func validateBalanceTarget(customerID, accountCode string) error {
	if _, err := uuid.Parse(customerID); err != nil {
		return &ValidationError{Message: "customer_id must be a UUID"}
	}
	if accountCode != receivableAccount {
		return &ValidationError{Message: "account_code must be receivable"}
	}
	return nil
}

// RecalculateCustomerBalance serializes recalculations for one cached account,
// derives the value from the ledger, and atomically refreshes the cache row.
func RecalculateCustomerBalance(
	ctx context.Context,
	pool *db.Pool,
	tenantID, customerID, accountCode string,
	now time.Time,
) (decimal.Decimal, time.Time, error) {
	if err := validateBalanceTarget(customerID, accountCode); err != nil {
		return decimal.Zero, time.Time{}, err
	}

	balance := decimal.Zero
	err := pool.WithTenant(ctx, tenantID, func(ctx context.Context, tx pgx.Tx) error {
		var visible bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)`, customerID).Scan(&visible); err != nil {
			return err
		}
		if !visible {
			return &NotFoundError{Message: "customer not found for this tenant"}
		}

		// Creating the row first gives every caller the same row-level lock even
		// when concurrent recalculations start with an empty cache.
		if _, err := tx.Exec(ctx, `
			INSERT INTO customer_balance_cache (
				tenant_id, customer_id, account_code, cached_balance, last_recalculated_at
			) VALUES ($1, $2, $3, 0, $4)
			ON CONFLICT (tenant_id, customer_id, account_code) DO NOTHING
		`, tenantID, customerID, accountCode, now); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `
			SELECT cached_balance
			FROM customer_balance_cache
			WHERE tenant_id = $1 AND customer_id = $2 AND account_code = $3
			FOR UPDATE
		`, tenantID, customerID, accountCode).Scan(new(decimal.Decimal)); err != nil {
			return err
		}

		var err error
		balance, err = GetCustomerBalance(ctx, tx, customerID, accountCode)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `
			UPDATE customer_balance_cache
			SET cached_balance = $1, last_recalculated_at = $2
			WHERE tenant_id = $3 AND customer_id = $4 AND account_code = $5
		`, balance.String(), now, tenantID, customerID, accountCode)
		return err
	})
	if err != nil {
		return decimal.Zero, time.Time{}, err
	}
	return balance, now, nil
}

type balanceMismatch struct {
	ID                  string
	TenantID            string
	CustomerID          string
	AccountCode         string
	CachedBalance       decimal.Decimal
	RecalculatedBalance decimal.Decimal
	Discrepancy         decimal.Decimal
	DetectedAt          time.Time
}

type balanceAlertPayload struct {
	TenantID            string    `json:"tenant_id"`
	CustomerID          string    `json:"customer_id"`
	AccountCode         string    `json:"account_code"`
	CachedBalance       string    `json:"cached_balance"`
	RecalculatedBalance string    `json:"recalculated_balance"`
	Discrepancy         string    `json:"discrepancy"`
	DetectedAt          time.Time `json:"detected_at"`
}

// ReconcileCustomerBalances compares cached balances to one batched ledger
// aggregation per tenant. Findings commit before any webhook is attempted.
func ReconcileCustomerBalances(ctx context.Context, pool *db.Pool, now time.Time) error {
	rows, err := pool.Query(ctx, `SELECT id FROM tenants ORDER BY id`)
	if err != nil {
		return fmt.Errorf("list tenants: %w", err)
	}
	var tenantIDs []string
	for rows.Next() {
		var tenantID string
		if err := rows.Scan(&tenantID); err != nil {
			rows.Close()
			return fmt.Errorf("scan tenant: %w", err)
		}
		tenantIDs = append(tenantIDs, tenantID)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return fmt.Errorf("iterate tenants: %w", err)
	}

	for _, tenantID := range tenantIDs {
		mismatches := []balanceMismatch{}
		err := pool.WithTenant(ctx, tenantID, func(ctx context.Context, tx pgx.Tx) error {
			rows, err := tx.Query(ctx, `
				WITH ledger_balances AS (
					SELECT lt.customer_id, ll.account_code,
					       SUM(CASE WHEN ll.direction = 'debit' THEN ll.amount ELSE -ll.amount END) AS recalculated_balance
					FROM ledger_lines ll
					JOIN ledger_transactions lt ON lt.id = ll.transaction_id
					WHERE ll.account_code = 'receivable'
					GROUP BY lt.customer_id, ll.account_code
				), comparisons AS (
					SELECT COALESCE(c.customer_id, l.customer_id) AS customer_id,
					       COALESCE(c.account_code, l.account_code) AS account_code,
					       COALESCE(c.cached_balance, 0) AS cached_balance,
					       COALESCE(l.recalculated_balance, 0) AS recalculated_balance
					FROM customer_balance_cache c
					FULL OUTER JOIN ledger_balances l
					  ON l.customer_id = c.customer_id AND l.account_code = c.account_code
				)
				INSERT INTO balance_integrity_checks (
					tenant_id, customer_id, account_code, cached_balance,
					recalculated_balance, discrepancy, detected_at
				)
				SELECT $1, customer_id, account_code, cached_balance,
				       recalculated_balance, cached_balance - recalculated_balance, $2
				FROM comparisons
				WHERE cached_balance != recalculated_balance
				RETURNING id, tenant_id, customer_id, account_code, cached_balance,
				          recalculated_balance, discrepancy, detected_at
			`, tenantID, now)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var mismatch balanceMismatch
				if err := rows.Scan(
					&mismatch.ID, &mismatch.TenantID, &mismatch.CustomerID,
					&mismatch.AccountCode, &mismatch.CachedBalance,
					&mismatch.RecalculatedBalance, &mismatch.Discrepancy,
					&mismatch.DetectedAt,
				); err != nil {
					return err
				}
				mismatches = append(mismatches, mismatch)
			}
			return rows.Err()
		})
		if err != nil {
			return fmt.Errorf("reconcile tenant %s: %w", tenantID, err)
		}

		// The transaction above has committed. Alert delivery can no longer
		// erase or roll back the dashboard finding.
		for _, mismatch := range mismatches {
			payload := balanceAlertPayload{
				TenantID: tenantID, CustomerID: mismatch.CustomerID,
				AccountCode:         mismatch.AccountCode,
				CachedBalance:       mismatch.CachedBalance.String(),
				RecalculatedBalance: mismatch.RecalculatedBalance.String(),
				Discrepancy:         mismatch.Discrepancy.String(),
				DetectedAt:          mismatch.DetectedAt,
			}
			alertErr := postAlert(ctx, payload)
			dedupKey := fmt.Sprintf(
				"mismatch:%s:%s:%s",
				mismatch.CustomerID,
				mismatch.AccountCode,
				mismatch.DetectedAt.Format(time.RFC3339),
			)
			// Tenant webhook delivery is auxiliary: its failure is logged but
			// cannot change the existing on-call alert/alert_sent flow.
			if err := postWebhookEvent(ctx, tenantID, "reconciliation.mismatch", dedupKey, payload); err != nil {
				log.Printf("balance reconciliation: tenant webhook tenant %s customer %s: %v", tenantID, mismatch.CustomerID, err)
			}
			if alertErr != nil {
				log.Printf("balance reconciliation: alert tenant %s customer %s: %v", tenantID, mismatch.CustomerID, alertErr)
				continue
			}
			if err := pool.WithTenant(ctx, tenantID, func(ctx context.Context, tx pgx.Tx) error {
				_, err := tx.Exec(ctx, `
					UPDATE balance_integrity_checks SET alert_sent = true WHERE id = $1
				`, mismatch.ID)
				return err
			}); err != nil {
				return fmt.Errorf("mark balance alert %s sent: %w", mismatch.ID, err)
			}
		}
	}
	return nil
}
