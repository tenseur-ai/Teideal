module teideal/go-usage/tests/balance-reconciliation

go 1.25.0

require (
	github.com/jackc/pgx/v5 v5.11.0
	teideal/go-usage v0.0.0
)

require (
	github.com/google/uuid v1.6.0 // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	github.com/shopspring/decimal v1.4.0 // indirect
	golang.org/x/sync v0.17.0 // indirect
	golang.org/x/text v0.29.0 // indirect
)

replace teideal/go-usage => ../../services/go-usage
