// Package auth resolves an API key to a tenant and enforces its API scope.
package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Principal struct {
	TenantID  string
	TenantKey string // e.g. "acct_1001", for logging/tests only
	Scope     string
}

var ErrNoKey = errors.New("auth: missing or malformed authorization header")
var ErrUnknownKey = errors.New("auth: unknown api key")

type ctxKey struct{}

func hashKey(plaintext string) string {
	sum := sha256.Sum256([]byte(plaintext))
	return hex.EncodeToString(sum[:])
}

// Resolve looks up the tenant for a plaintext API key. It never runs inside
// a tenant-scoped transaction: the caller has no tenant context yet, that's
// exactly what this call produces.
func Resolve(ctx context.Context, pool *pgxpool.Pool, plaintextKey string) (Principal, error) {
	row := pool.QueryRow(ctx, `
		SELECT k.id, t.id, t.external_key, k.scope
		FROM api_keys k
		JOIN tenants t ON t.id = k.issued_to_tenant_id
		WHERE k.key_hash = $1
		  AND k.revoked_at IS NULL
		  AND (k.expires_at IS NULL OR k.expires_at > now())
	`, hashKey(plaintextKey))

	var p Principal
	var apiKeyID string
	if err := row.Scan(&apiKeyID, &p.TenantID, &p.TenantKey, &p.Scope); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Principal{}, ErrUnknownKey
		}
		return Principal{}, err
	}
	// last_used_at is informational rather than a security control. Do not
	// reject an otherwise valid request if this best-effort display update
	// loses a race or transiently fails.
	_, _ = pool.Exec(ctx, `UPDATE api_keys SET last_used_at = now() WHERE id = $1`, apiKeyID)
	return p, nil
}

// Middleware authenticates every request and stores the resolved Principal
// on the request context. Handlers that need no tenant context (health
// checks) should be mounted outside this middleware.
func Middleware(pool *pgxpool.Pool, requiredScope string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			header := r.Header.Get("Authorization")
			const prefix = "Bearer "
			if !strings.HasPrefix(header, prefix) || len(header) <= len(prefix) {
				http.Error(w, `{"error":"missing or malformed Authorization header"}`, http.StatusUnauthorized)
				return
			}
			key := strings.TrimSpace(header[len(prefix):])

			principal, err := Resolve(r.Context(), pool, key)
			if err != nil {
				http.Error(w, `{"error":"invalid api key"}`, http.StatusUnauthorized)
				return
			}
			if principal.Scope != requiredScope && principal.Scope != "admin" {
				http.Error(w, `{"error":"api key scope does not permit this operation"}`, http.StatusForbidden)
				return
			}

			ctx := context.WithValue(r.Context(), ctxKey{}, principal)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func FromContext(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(ctxKey{}).(Principal)
	return p, ok
}
