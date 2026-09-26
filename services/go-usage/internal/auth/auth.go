// Package auth resolves an API key to a tenant. It is intentionally minimal:
// one hash lookup, no scopes, no rotation, no revocation. TEID-92 (API key
// lifecycle) and TEID-43 (RBAC) extend this table and this check later --
// this is not a smaller version of those features, it is the subset TEID-41
// needs to attribute a request to a tenant at all.
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
		SELECT t.id, t.external_key
		FROM api_keys k
		JOIN tenants t ON t.id = k.issued_to_tenant_id
		WHERE k.key_hash = $1
	`, hashKey(plaintextKey))

	var p Principal
	if err := row.Scan(&p.TenantID, &p.TenantKey); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Principal{}, ErrUnknownKey
		}
		return Principal{}, err
	}
	return p, nil
}

// Middleware authenticates every request and stores the resolved Principal
// on the request context. Handlers that need no tenant context (health
// checks) should be mounted outside this middleware.
func Middleware(pool *pgxpool.Pool) func(http.Handler) http.Handler {
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

			ctx := context.WithValue(r.Context(), ctxKey{}, principal)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func FromContext(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(ctxKey{}).(Principal)
	return p, ok
}
