package api

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"teideal/go-usage/internal/auth"
	ledgerpkg "teideal/go-usage/internal/ledger"
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
