# TEID-68.1 implementation notes

- Report-window membership now uses the required half-open interval overlap
  predicate (`line start < report end` and `line end > report start`) directly
  in PostgreSQL. Lines ending exactly at the window start or starting exactly at
  the window end are therefore correctly excluded.
- Billed-line presence, rather than the mere existence of coverage-gap records,
  is the classification discriminator. Credit, payment, and refund activity can
  identify an otherwise line-free period as a known gap, but cannot suppress a
  detectable quantity or rate discrepancy on overlapping billed lines.
- Credits and refunds remain evidence only and are not netted into billed totals.
  Historical invoices synced before flattened line periods were available must
  be resynced and remapped before relying on this report.
