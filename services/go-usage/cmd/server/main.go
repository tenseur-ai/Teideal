package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
	_ "time/tzdata"

	"teideal/go-usage/internal/api"
	"teideal/go-usage/internal/auth"
	"teideal/go-usage/internal/db"
	"teideal/go-usage/internal/ledger"
)

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	connString := getenv("DATABASE_URL", "postgres://teideal_app:teideal_app_dev_password@localhost:5432/teideal?sslmode=disable")
	addr := ":" + getenv("PORT", "8082")

	pool, err := db.Open(ctx, connString)
	if err != nil {
		log.Fatalf("go-usage: failed to connect to database: %v", err)
	}
	defer pool.Close()

	h := &api.Handlers{Pool: pool}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})

	mux.Handle("GET /usage", auth.Middleware(pool.Pool, "read-only")(http.HandlerFunc(h.GetUsage)))
	mux.Handle("GET /usage/summary", auth.Middleware(pool.Pool, "read-only")(http.HandlerFunc(h.GetUsageSummary)))
	mux.Handle("POST /usage", auth.Middleware(pool.Pool, "ingest-only")(http.HandlerFunc(h.PostUsage)))
	mux.Handle("GET /idempotency-conflicts", auth.Middleware(pool.Pool, "admin")(http.HandlerFunc(h.GetIdempotencyConflicts)))
	mux.Handle("GET /rounding-config", auth.Middleware(pool.Pool, "admin")(http.HandlerFunc(h.GetRoundingConfig)))
	mux.Handle("PUT /rounding-config", auth.Middleware(pool.Pool, "admin")(http.HandlerFunc(h.PutRoundingConfig)))
	mux.Handle("POST /money/preview", auth.Middleware(pool.Pool, "admin")(http.HandlerFunc(h.PostMoneyPreview)))
	mux.Handle("POST /money/price", auth.Middleware(pool.Pool, "admin")(http.HandlerFunc(h.PostMoneyPrice)))
	mux.Handle("GET /customers/{id}/billing-config", auth.Middleware(pool.Pool, "admin")(http.HandlerFunc(h.GetBillingConfig)))
	mux.Handle("PUT /customers/{id}/billing-config", auth.Middleware(pool.Pool, "admin")(http.HandlerFunc(h.PutBillingConfig)))
	mux.Handle("POST /period/resolve", auth.Middleware(pool.Pool, "admin")(http.HandlerFunc(h.PostResolvePeriod)))
	mux.Handle("POST /reservations", auth.Middleware(pool.Pool, "admin")(http.HandlerFunc(h.PostReservation)))
	mux.Handle("POST /ledger/transactions", auth.Middleware(pool.Pool, "admin")(http.HandlerFunc(h.PostLedgerTransaction)))
	mux.Handle("POST /ledger/transactions/{id}/reverse", auth.Middleware(pool.Pool, "admin")(http.HandlerFunc(h.ReverseLedgerTransaction)))
	mux.Handle("GET /ledger/transactions/{id}", auth.Middleware(pool.Pool, "admin")(http.HandlerFunc(h.GetLedgerTransaction)))

	if os.Getenv("DISABLE_BACKGROUND_WORKERS") != "true" {
		interval := 24 * time.Hour
		if raw := os.Getenv("LEDGER_INTEGRITY_CHECK_INTERVAL_MS"); raw != "" {
			milliseconds, parseErr := strconv.ParseInt(raw, 10, 64)
			if parseErr != nil || milliseconds <= 0 {
				log.Printf("go-usage: invalid LEDGER_INTEGRITY_CHECK_INTERVAL_MS %q; using 24h", raw)
			} else {
				interval = time.Duration(milliseconds) * time.Millisecond
			}
		}
		go func() {
			ticker := time.NewTicker(interval)
			defer ticker.Stop()
			for {
				select {
				case checkedAt := <-ticker.C:
					if err := ledger.CheckAllTransactionsBalanced(ctx, pool, checkedAt); err != nil {
						log.Printf("go-usage: ledger integrity check failed: %v", err)
					}
				case <-ctx.Done():
					return
				}
			}
		}()
	}

	server := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()

	log.Printf("go-usage: listening on %s", addr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("go-usage: server error: %v", err)
	}
}
