package api

import (
	"context"
	"log"
	"net/http"
	"sort"
	"strconv"

	"github.com/jackc/pgx/v5"

	"teideal/go-usage/internal/auth"
)

type periodCloseLedgerRow struct {
	CustomerID      string   `json:"customer_id"`
	UsageBilled     string   `json:"usage_billed"`
	Adjustments     string   `json:"adjustments"`
	LedgerLineIDs   []string `json:"ledger_line_ids"`
	UsageEventIDs   []string `json:"usage_event_ids"`
	UsageEventCount string   `json:"usage_event_count"`
	UsageQuantity   string   `json:"usage_quantity"`
}

type periodCloseUsageEvidence struct {
	IDs      []string
	Count    string
	Quantity string
}

// GetPeriodCloseLedgerSummary handles GET /period-close/ledger-summary.
// All aggregates stay in Postgres so this endpoint remains a fixed number of
// set-based queries regardless of the number of customers in the tenant.
func (h *Handlers) GetPeriodCloseLedgerSummary(w http.ResponseWriter, r *http.Request) {
	principal, ok := auth.FromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthenticated")
		return
	}
	since, until, err := parseSinceUntil(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if since == nil || until == nil {
		writeErr(w, http.StatusBadRequest, "since and until are required")
		return
	}
	if !since.Before(*until) {
		writeErr(w, http.StatusBadRequest, "since must be earlier than until")
		return
	}

	usage := make(map[string]string)
	ledgerLineIDs := make(map[string][]string)
	adjustments := make(map[string]string)
	usageEvidence := make(map[string]periodCloseUsageEvidence)
	err = h.Pool.WithTenant(r.Context(), principal.TenantID, func(ctx context.Context, tx pgx.Tx) error {
		rows, queryErr := tx.Query(ctx, `
			SELECT t.customer_id, SUM(l.amount)::text AS usage_billed,
			       array_agg(l.id::text ORDER BY l.id) AS ledger_line_ids
			FROM ledger_transactions t
			JOIN ledger_lines l ON l.transaction_id = t.id
			WHERE l.account_code = 'revenue'
			  AND l.direction = 'credit'
			  AND t.created_at >= $1
			  AND t.created_at < $2
			GROUP BY t.customer_id
		`, *since, *until)
		if queryErr != nil {
			return queryErr
		}
		for rows.Next() {
			var customerID, amount string
			var lineIDs []string
			if scanErr := rows.Scan(&customerID, &amount, &lineIDs); scanErr != nil {
				rows.Close()
				return scanErr
			}
			usage[customerID] = amount
			ledgerLineIDs[customerID] = lineIDs
		}
		if rowsErr := rows.Err(); rowsErr != nil {
			rows.Close()
			return rowsErr
		}
		rows.Close()

		rows, queryErr = tx.Query(ctx, `
			SELECT t.customer_id, SUM(l.amount)::text AS adjustments
			FROM usage_adjustments a
			JOIN ledger_transactions t ON t.usage_event_id = a.resulting_usage_event_id
			JOIN ledger_lines l ON l.transaction_id = t.id
			WHERE a.status = 'approved'
			  AND a.period_start = $1
			  AND l.account_code = 'revenue'
			  AND l.direction = 'credit'
			GROUP BY t.customer_id
		`, *since)
		if queryErr != nil {
			return queryErr
		}
		for rows.Next() {
			var customerID, amount string
			if scanErr := rows.Scan(&customerID, &amount); scanErr != nil {
				return scanErr
			}
			adjustments[customerID] = amount
		}
		if rowsErr := rows.Err(); rowsErr != nil {
			rows.Close()
			return rowsErr
		}
		rows.Close()

		rows, queryErr = tx.Query(ctx, `
			SELECT customer_id, array_agg(id::text ORDER BY id) AS usage_event_ids,
			       COUNT(*) AS usage_event_count,
			       COALESCE(SUM(quantity), 0)::text AS usage_quantity
			FROM usage_events
			WHERE occurred_at >= $1 AND occurred_at < $2
			GROUP BY customer_id
		`, *since, *until)
		if queryErr != nil {
			return queryErr
		}
		defer rows.Close()
		for rows.Next() {
			var customerID, quantity string
			var eventIDs []string
			var count int64
			if scanErr := rows.Scan(&customerID, &eventIDs, &count, &quantity); scanErr != nil {
				return scanErr
			}
			usageEvidence[customerID] = periodCloseUsageEvidence{
				IDs: eventIDs, Count: strconv.FormatInt(count, 10), Quantity: quantity,
			}
		}
		return rows.Err()
	})
	if err != nil {
		log.Printf("GetPeriodCloseLedgerSummary: %v", err)
		writeErr(w, http.StatusInternalServerError, "failed to summarize period-close ledger activity")
		return
	}

	// Emit the union of customers represented by either ledger aggregate.
	// ts-console performs the outer merge from its authoritative customers
	// table, which supplies zero rows for customers absent from this response.
	customerIDs := make([]string, 0, len(usage)+len(adjustments)+len(usageEvidence))
	seen := make(map[string]struct{}, len(usage)+len(adjustments)+len(usageEvidence))
	for customerID := range usage {
		customerIDs = append(customerIDs, customerID)
		seen[customerID] = struct{}{}
	}
	for customerID := range adjustments {
		if _, exists := seen[customerID]; !exists {
			customerIDs = append(customerIDs, customerID)
			seen[customerID] = struct{}{}
		}
	}
	for customerID := range usageEvidence {
		if _, exists := seen[customerID]; !exists {
			customerIDs = append(customerIDs, customerID)
			seen[customerID] = struct{}{}
		}
	}
	sort.Strings(customerIDs)

	data := make([]periodCloseLedgerRow, 0, len(customerIDs))
	for _, customerID := range customerIDs {
		evidence, hasEvidence := usageEvidence[customerID]
		if !hasEvidence {
			evidence = periodCloseUsageEvidence{IDs: []string{}, Count: "0", Quantity: "0"}
		}
		lineIDs := ledgerLineIDs[customerID]
		if lineIDs == nil {
			lineIDs = []string{}
		}
		data = append(data, periodCloseLedgerRow{
			CustomerID:      customerID,
			UsageBilled:     zeroIfMissing(usage, customerID),
			Adjustments:     zeroIfMissing(adjustments, customerID),
			LedgerLineIDs:   lineIDs,
			UsageEventIDs:   evidence.IDs,
			UsageEventCount: evidence.Count,
			UsageQuantity:   evidence.Quantity,
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{"data": data})
}

func zeroIfMissing(values map[string]string, key string) string {
	if value, ok := values[key]; ok {
		return value
	}
	return "0"
}
