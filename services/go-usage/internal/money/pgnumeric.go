package money

import (
	"errors"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
)

// FromPGNumeric converts PostgreSQL's arbitrary-precision NUMERIC
// representation to an exact decimal value without passing through a float.
func FromPGNumeric(n pgtype.Numeric) (decimal.Decimal, error) {
	if !n.Valid {
		return decimal.Decimal{}, errors.New("numeric value is NULL")
	}
	return decimal.NewFromBigInt(n.Int, n.Exp), nil
}

// ToPGNumeric converts an exact decimal value to PostgreSQL's
// arbitrary-precision NUMERIC representation without passing through a float.
func ToPGNumeric(d decimal.Decimal) (pgtype.Numeric, error) {
	return pgtype.Numeric{Int: d.Coefficient(), Exp: d.Exponent(), Valid: true}, nil
}
