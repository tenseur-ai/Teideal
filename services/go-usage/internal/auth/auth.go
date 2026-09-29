// Package auth resolves an API key to a tenant and enforces its API scope.
package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Principal struct {
	TenantID   string
	TenantKey  string // e.g. "acct_1001", for logging/tests only
	Scope      string
	UserID     *string // creator of the API key, when the key is user-attributed
	CustomerID *string // api_keys.customer_id when the key is customer-scoped (TEID-22)
	APIKeyID   string
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
	keyHash := hashKey(plaintextKey)
	row := pool.QueryRow(ctx, `
		SELECT k.id, t.id, t.external_key, k.scope, k.creator_user_id, k.customer_id
		FROM api_keys k
		JOIN tenants t ON t.id = k.issued_to_tenant_id
		WHERE k.key_hash = $1
		  AND k.revoked_at IS NULL
		  AND (k.expires_at IS NULL OR k.expires_at > now())
	`, keyHash)

	var p Principal
	if err := row.Scan(&p.APIKeyID, &p.TenantID, &p.TenantKey, &p.Scope, &p.UserID, &p.CustomerID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return resolveSession(ctx, pool, keyHash)
		}
		return Principal{}, err
	}
	// last_used_at is informational rather than a security control. Do not
	// reject an otherwise valid request if this best-effort display update
	// loses a race or transiently fails.
	_, _ = pool.Exec(ctx, `UPDATE api_keys SET last_used_at = now() WHERE id = $1`, p.APIKeyID)
	return p, nil
}

// resolveSession accepts a console session token so ts-console can fan out
// to go-usage with the same Bearer credential a support agent already holds.
// Sessions are tenant-scoped and read-only; they never carry api_keys.customer_id.
func resolveSession(ctx context.Context, pool *pgxpool.Pool, tokenHash string) (Principal, error) {
	row := pool.QueryRow(ctx, `
		SELECT s.id, t.id, t.external_key, s.user_id, s.idle_timeout_minutes, s.last_seen_at
		FROM sessions s
		JOIN tenants t ON t.id = s.issued_to_tenant_id
		WHERE s.token_hash = $1
	`, tokenHash)

	var p Principal
	var sessionID string
	var idleTimeoutMinutes int
	var lastSeen time.Time
	if err := row.Scan(&sessionID, &p.TenantID, &p.TenantKey, &p.UserID, &idleTimeoutMinutes, &lastSeen); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Principal{}, ErrUnknownKey
		}
		return Principal{}, err
	}
	if time.Since(lastSeen) > time.Duration(idleTimeoutMinutes)*time.Minute {
		_, _ = pool.Exec(ctx, `DELETE FROM sessions WHERE id = $1`, sessionID)
		return Principal{}, ErrUnknownKey
	}
	_, _ = pool.Exec(ctx, `UPDATE sessions SET last_seen_at = now() WHERE id = $1`, sessionID)
	p.Scope = "read-only"
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
