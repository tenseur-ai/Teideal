package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"teideal/go-usage/internal/db"
	"teideal/go-usage/internal/ledger"
)

func main() {
	ctx := context.Background()
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		databaseURL = "postgres://teideal_app:teideal_app_dev_password@127.0.0.1:5432/teideal"
	}
	checkedAt := time.Now().UTC()
	if raw := os.Getenv("LEDGER_CHECK_FIXED_NOW"); raw != "" {
		parsed, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			panic(fmt.Errorf("parse LEDGER_CHECK_FIXED_NOW: %w", err))
		}
		checkedAt = parsed
	}
	pool, err := db.Open(ctx, databaseURL)
	if err != nil {
		panic(err)
	}
	defer pool.Close()
	started := time.Now()
	if err := ledger.CheckAllTransactionsBalanced(ctx, pool, checkedAt); err != nil {
		panic(err)
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{
		"checked_at": checkedAt,
		"elapsed_ms": time.Since(started).Milliseconds(),
	})
}
