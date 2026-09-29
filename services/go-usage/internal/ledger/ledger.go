// Package ledger implements the append-only, double-entry usage ledger.
package ledger

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"

	"teideal/go-usage/internal/db"
)

type Direction string

const (
	Debit  Direction = "debit"
	Credit Direction = "credit"
)

var allowedAccounts = map[string]struct{}{
	"revenue": {}, "receivable": {}, "payable": {},
	"cash": {}, "discount": {}, "overage": {},
}

// ValidationError identifies an input error that API callers can correct.
type ValidationError struct{ Message string }

func (e *ValidationError) Error() string { return e.Message }

// NotFoundError identifies a tenant-scoped resource that was not visible.
type NotFoundError struct{ Message string }

func (e *NotFoundError) Error() string { return e.Message }

type LineInput struct {
	AccountCode string          `json:"account_code"`
	Direction   Direction       `json:"direction"`
	Amount      decimal.Decimal `json:"amount"`
}

type PostTransactionInput struct {
	CustomerID    string      `json:"customer_id"`
	UsageEventID  *string     `json:"usage_event_id,omitempty"`
	GrantID       *string     `json:"grant_id,omitempty"`
	ReservationID *string     `json:"reservation_id,omitempty"`
	PricingRuleID *string     `json:"pricing_rule_id,omitempty"`
	PlanVersion   *int        `json:"plan_version,omitempty"`
	Description   *string     `json:"description,omitempty"`
	Lines         []LineInput `json:"lines"`
}

type Line struct {
	ID            string          `json:"id"`
	TransactionID string          `json:"transaction_id"`
	AccountCode   string          `json:"account_code"`
	Direction     Direction       `json:"direction"`
	Amount        decimal.Decimal `json:"amount"`
	CreatedAt     time.Time       `json:"created_at"`
}

type Transaction struct {
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
	Lines                 []Line    `json:"lines"`
}

func validateInput(input PostTransactionInput) error {
	if _, err := uuid.Parse(input.CustomerID); err != nil {
		return &ValidationError{Message: "customer_id must be a UUID"}
	}
	for field, value := range map[string]*string{
		"usage_event_id": input.UsageEventID, "grant_id": input.GrantID,
		"reservation_id": input.ReservationID, "pricing_rule_id": input.PricingRuleID,
	} {
		if value != nil {
			if _, err := uuid.Parse(*value); err != nil {
				return &ValidationError{Message: field + " must be a UUID"}
			}
		}
	}
	if len(input.Lines) < 2 {
		return &ValidationError{Message: "lines must contain at least two entries"}
	}

	debits := decimal.Zero
	credits := decimal.Zero
	for i, line := range input.Lines {
		if _, ok := allowedAccounts[line.AccountCode]; !ok {
			return &ValidationError{Message: fmt.Sprintf("lines[%d].account_code is not allowed", i)}
		}
		if line.Direction != Debit && line.Direction != Credit {
			return &ValidationError{Message: fmt.Sprintf("lines[%d].direction must be debit or credit", i)}
		}
		if !line.Amount.IsPositive() {
			return &ValidationError{Message: fmt.Sprintf("lines[%d].amount must be greater than zero", i)}
		}
		if line.Direction == Debit {
			debits = debits.Add(line.Amount)
		} else {
			credits = credits.Add(line.Amount)
		}
	}
	if !debits.Equal(credits) {
		return &ValidationError{Message: fmt.Sprintf("ledger transaction does not balance (net %s)", debits.Sub(credits).String())}
	}
	return nil
}

func validateOwnedReferences(ctx context.Context, tx pgx.Tx, input PostTransactionInput) error {
	var visible bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)`, input.CustomerID).Scan(&visible)
	if err != nil {
		return err
	}
	if !visible {
		return &NotFoundError{Message: "customer not found for this tenant"}
	}
	if input.UsageEventID != nil {
		err = tx.QueryRow(ctx, `
			SELECT EXISTS(
				SELECT 1 FROM usage_events WHERE id = $1 AND customer_id = $2
			)
		`, *input.UsageEventID, input.CustomerID).Scan(&visible)
		if err != nil {
			return err
		}
		if !visible {
			return &NotFoundError{Message: "usage event not found for this tenant"}
		}
	}
	if input.ReservationID != nil {
		err = tx.QueryRow(ctx, `
			SELECT EXISTS(
				SELECT 1 FROM reservations WHERE id = $1 AND customer_id = $2
			)
		`, *input.ReservationID, input.CustomerID).Scan(&visible)
		if err != nil {
			return err
		}
		if !visible {
			return &NotFoundError{Message: "reservation not found for this tenant"}
		}
	}
	return nil
}

// PostTransaction validates and inserts a complete transaction in the caller's
// tenant-scoped database transaction. The deferred database trigger checks the
// same balance invariant again when that transaction commits.
func PostTransaction(ctx context.Context, tx pgx.Tx, tenantID string, input PostTransactionInput) (Transaction, error) {
	if err := validateInput(input); err != nil {
		return Transaction{}, err
	}
	if err := validateOwnedReferences(ctx, tx, input); err != nil {
		return Transaction{}, err
	}

	created := Transaction{Lines: []Line{}}
	err := tx.QueryRow(ctx, `
		INSERT INTO ledger_transactions (
			tenant_id, customer_id, usage_event_id, grant_id, reservation_id,
			pricing_rule_id, plan_version, description
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id, customer_id, usage_event_id, grant_id, reservation_id,
		          pricing_rule_id, plan_version, reverses_transaction_id,
		          description, created_at
	`, tenantID, input.CustomerID, input.UsageEventID, input.GrantID,
		input.ReservationID, input.PricingRuleID, input.PlanVersion, input.Description).
		Scan(&created.ID, &created.CustomerID, &created.UsageEventID, &created.GrantID,
			&created.ReservationID, &created.PricingRuleID, &created.PlanVersion,
			&created.ReversesTransactionID, &created.Description, &created.CreatedAt)
	if err != nil {
		return Transaction{}, err
	}

	for _, inputLine := range input.Lines {
		line := Line{TransactionID: created.ID}
		err = tx.QueryRow(ctx, `
			INSERT INTO ledger_lines (tenant_id, transaction_id, account_code, direction, amount)
			VALUES ($1, $2, $3, $4, $5)
			RETURNING id, account_code, direction, amount, created_at
		`, tenantID, created.ID, inputLine.AccountCode, inputLine.Direction, inputLine.Amount.String()).
			Scan(&line.ID, &line.AccountCode, &line.Direction, &line.Amount, &line.CreatedAt)
		if err != nil {
			return Transaction{}, err
		}
		created.Lines = append(created.Lines, line)
	}
	return created, nil
}

// GetTransaction reads one transaction and its lines under the caller's RLS
// context.
func GetTransaction(ctx context.Context, tx pgx.Tx, id string) (Transaction, error) {
	result := Transaction{Lines: []Line{}}
	err := tx.QueryRow(ctx, `
		SELECT id, customer_id, usage_event_id, grant_id, reservation_id,
		       pricing_rule_id, plan_version, reverses_transaction_id,
		       description, created_at
		FROM ledger_transactions WHERE id = $1
	`, id).Scan(&result.ID, &result.CustomerID, &result.UsageEventID, &result.GrantID,
		&result.ReservationID, &result.PricingRuleID, &result.PlanVersion,
		&result.ReversesTransactionID, &result.Description, &result.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Transaction{}, &NotFoundError{Message: "ledger transaction not found"}
	}
	if err != nil {
		return Transaction{}, err
	}

	rows, err := tx.Query(ctx, `
		SELECT id, transaction_id, account_code, direction, amount, created_at
		FROM ledger_lines WHERE transaction_id = $1 ORDER BY created_at, id
	`, id)
	if err != nil {
		return Transaction{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var line Line
		if err := rows.Scan(&line.ID, &line.TransactionID, &line.AccountCode,
			&line.Direction, &line.Amount, &line.CreatedAt); err != nil {
			return Transaction{}, err
		}
		result.Lines = append(result.Lines, line)
	}
	return result, rows.Err()
}

// ReverseTransaction appends a linked transaction whose debit and credit
// directions exactly mirror the original. The original is never mutated.
func ReverseTransaction(ctx context.Context, tx pgx.Tx, tenantID, originalTransactionID, reason string) (Transaction, error) {
	original, err := GetTransaction(ctx, tx, originalTransactionID)
	if err != nil {
		return Transaction{}, err
	}
	lines := make([]LineInput, 0, len(original.Lines))
	for _, line := range original.Lines {
		direction := Debit
		if line.Direction == Debit {
			direction = Credit
		}
		lines = append(lines, LineInput{AccountCode: line.AccountCode, Direction: direction, Amount: line.Amount})
	}

	result := Transaction{Lines: []Line{}}
	err = tx.QueryRow(ctx, `
		INSERT INTO ledger_transactions (
			tenant_id, customer_id, usage_event_id, grant_id, reservation_id,
			pricing_rule_id, plan_version, reverses_transaction_id, description
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id, customer_id, usage_event_id, grant_id, reservation_id,
		          pricing_rule_id, plan_version, reverses_transaction_id,
		          description, created_at
	`, tenantID, original.CustomerID, original.UsageEventID, original.GrantID,
		original.ReservationID, original.PricingRuleID, original.PlanVersion,
		originalTransactionID, reason).
		Scan(&result.ID, &result.CustomerID, &result.UsageEventID, &result.GrantID,
			&result.ReservationID, &result.PricingRuleID, &result.PlanVersion,
			&result.ReversesTransactionID, &result.Description, &result.CreatedAt)
	if err != nil {
		return Transaction{}, err
	}
	for _, inputLine := range lines {
		line := Line{TransactionID: result.ID}
		err = tx.QueryRow(ctx, `
			INSERT INTO ledger_lines (tenant_id, transaction_id, account_code, direction, amount)
			VALUES ($1, $2, $3, $4, $5)
			RETURNING id, account_code, direction, amount, created_at
		`, tenantID, result.ID, inputLine.AccountCode, inputLine.Direction, inputLine.Amount.String()).
			Scan(&line.ID, &line.AccountCode, &line.Direction, &line.Amount, &line.CreatedAt)
		if err != nil {
			return Transaction{}, err
		}
		result.Lines = append(result.Lines, line)
	}
	return result, nil
}

type alertPayload struct {
	TenantID                 string    `json:"tenant_id"`
	UnbalancedTransactionIDs []string  `json:"unbalanced_transaction_ids"`
	CheckedAt                time.Time `json:"checked_at"`
}

// CheckAllTransactionsBalanced performs the daily defense-in-depth scan and
// sends one webhook alert for each tenant with an imbalance.
func CheckAllTransactionsBalanced(ctx context.Context, pool *db.Pool, now time.Time) error {
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
		var ids []string
		err := pool.WithTenant(ctx, tenantID, func(ctx context.Context, tx pgx.Tx) error {
			rows, err := tx.Query(ctx, `
				SELECT transaction_id
				FROM ledger_lines
				GROUP BY transaction_id
				HAVING SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END) != 0
				ORDER BY transaction_id
			`)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var id string
				if err := rows.Scan(&id); err != nil {
					return err
				}
				ids = append(ids, id)
			}
			return rows.Err()
		})
		if err != nil {
			return fmt.Errorf("check tenant %s: %w", tenantID, err)
		}
		if len(ids) == 0 {
			continue
		}
		if err := postAlert(ctx, alertPayload{TenantID: tenantID, UnbalancedTransactionIDs: ids, CheckedAt: now}); err != nil {
			return fmt.Errorf("alert tenant %s: %w", tenantID, err)
		}
	}
	return nil
}

func postAlert(ctx context.Context, payload any) error {
	url := os.Getenv("ONCALL_ALERT_WEBHOOK_URL")
	if url == "" {
		return errors.New("ONCALL_ALERT_WEBHOOK_URL is not configured")
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("webhook returned HTTP %d", resp.StatusCode)
	}
	return nil
}
