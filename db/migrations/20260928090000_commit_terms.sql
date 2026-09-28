-- TEID-19: annual commits are grants rows (source = 'commit') carrying four
-- extra, commit-only fields. NULL/inapplicable for the other three sources.
ALTER TABLE grants ADD COLUMN IF NOT EXISTS drawdown_schedule TEXT
  CHECK (drawdown_schedule IN ('upfront', 'monthly', 'quarterly'));
ALTER TABLE grants ADD COLUMN IF NOT EXISTS overage_rate NUMERIC
  CHECK (overage_rate >= 0);
ALTER TABLE grants ADD COLUMN IF NOT EXISTS carries_over BOOLEAN NOT NULL DEFAULT false;
-- Drives processCommitDrawdowns's polling; NULL once no further tranche is
-- owed (upfront schedules, or a monthly/quarterly schedule's final tranche
-- already released).
ALTER TABLE grants ADD COLUMN IF NOT EXISTS next_release_at TIMESTAMPTZ;

-- The overage line's priced dollar amount when a commit's overage_rate
-- applies (see consumeAcrossGrants below). NULL when no commit rate applies,
-- matching today's unpriced-overage default.
ALTER TABLE usage_consumption_lines ADD COLUMN IF NOT EXISTS overage_amount_due NUMERIC
  CHECK (overage_amount_due >= 0);

-- Widen entry_type for AC1's drawdown tranches and AC4's carryover case.
-- grant_ledger_entries_entry_type_check is Postgres's default name for the
-- original single-column, unnamed CHECK in the TEID-17 migration.
ALTER TABLE grant_ledger_entries DROP CONSTRAINT grant_ledger_entries_entry_type_check;
ALTER TABLE grant_ledger_entries ADD CONSTRAINT grant_ledger_entries_entry_type_check
  CHECK (entry_type IN ('issued', 'expired', 'voided', 'released', 'carried_over'));
