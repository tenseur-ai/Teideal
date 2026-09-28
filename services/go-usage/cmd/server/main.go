package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
	_ "time/tzdata"

	"teideal/go-usage/internal/api"
	"teideal/go-usage/internal/auth"
	"teideal/go-usage/internal/db"
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
