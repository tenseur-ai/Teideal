package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5"

	"teideal/go-usage/internal/db"
	"teideal/go-usage/internal/ledger"
)

func main() {
	if len(os.Args) < 2 {
		panic("usage: worker-helper <get|reconcile> ...")
	}
	ctx := context.Background()
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		databaseURL = "postgres://teideal_app:teideal_app_dev_password@127.0.0.1:5432/teideal"
	}
	pool, err := db.Open(ctx, databaseURL)
	if err != nil {
		panic(err)
	}
	defer pool.Close()

	switch os.Args[1] {
	case "get":
		if len(os.Args) != 5 {
			panic("usage: worker-helper get <tenant-id> <customer-id> <account-code>")
		}
		var value string
		err := pool.WithTenant(ctx, os.Args[2], func(ctx context.Context, tx pgx.Tx) error {
			balance, err := ledger.GetCustomerBalance(ctx, tx, os.Args[3], os.Args[4])
			if err == nil {
				value = balance.String()
			}
			return err
		})
		if err != nil {
			panic(err)
		}
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"balance": value})
	case "reconcile":
		if len(os.Args) != 3 {
			panic("usage: worker-helper reconcile <RFC3339 timestamp>")
		}
		checkedAt, err := time.Parse(time.RFC3339Nano, os.Args[2])
		if err != nil {
			panic(fmt.Errorf("parse checked-at: %w", err))
		}
		started := time.Now()
		if err := ledger.ReconcileCustomerBalances(ctx, pool, checkedAt); err != nil {
			panic(err)
		}
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{
			"checked_at": checkedAt,
			"elapsed_ms": time.Since(started).Milliseconds(),
		})
	default:
		panic("unknown mode: " + os.Args[1])
	}
}
