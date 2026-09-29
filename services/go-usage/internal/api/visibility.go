package api

import (
	"context"
	"net/http"

	"github.com/jackc/pgx/v5"

	"teideal/go-usage/internal/auth"
	"teideal/go-usage/internal/security"
)

func customerVisible(ctx context.Context, tx pgx.Tx, customerID string) (bool, error) {
	var exists bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM customers WHERE id = $1)`, customerID).Scan(&exists)
	return exists, err
}

func scopedToOtherCustomer(principal auth.Principal, customerID string) bool {
	return principal.CustomerID != nil && *principal.CustomerID != customerID
}

func denyCustomerNotVisible(w http.ResponseWriter, r *http.Request, h *Handlers, principal auth.Principal, endpoint, detail string) {
	_ = security.LogBlocked(r.Context(), h.Pool.Pool, security.BlockedAttempt{
		ActingTenantID: principal.TenantID,
		Endpoint:       endpoint,
		Method:         r.Method,
		Detail:         detail,
		ResolvedAction: "blocked_customer_not_visible",
	})
	writeErr(w, http.StatusForbidden, "customer not found for this tenant")
}
