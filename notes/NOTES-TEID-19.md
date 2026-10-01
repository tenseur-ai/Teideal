# NOTES-TEID-19

Decisions where the spec and the code already in the tree do not line up. Nothing here changes the nine cataloged outcomes.

## A `source: "commit"` grant already existed

TEID-17 and TEID-18 create `source: "commit"` grants as one of the four consumption categories. They send no schedule and no overage rate, and `tests/consumption-order` expects `POST /grants` to return 201 with the full amount available immediately.

TEID-19 requires `drawdown_schedule` and `overage_rate` on every commit. Following that rule rejects those fixtures. The fixtures now send `drawdown_schedule: "upfront"` and `overage_rate: 0`. Upfront is the spec's "identical to today's insertGrant" path, so `remaining_amount` is still the full amount. A zero rate prices an overage line only when that same call draws the commit. The TEID-18 cases do not straddle a commit, and the direct SQL fixtures in TEID-18-T6 leave `overage_rate` NULL, so an overage line there stays unpriced.

## `audit_log` has no `reason` column

The spec says the amend reason lands in a top-level `reason` column that is already on `audit_log`. The table has `actor_user_id`, `before`, `after`, and `detail`. It does not have `reason`. Adding a column would go past the migration the spec writes out in full.

`PATCH /grants/:id/amend` still stores the full `GrantRecord` in `before` and `after`. The reason is stored in the existing `detail` JSON as `{"reason":"..."}`. `actor_user_id` is the operator. TEID-19-T5 reads those three.

## Tranche amounts use a fixed scale of 12

The spec says each tranche is `amount / trancheCount` as `NUMERIC` division "to the same precision the column itself stores", and the last tranche absorbs the remainder. `grants.amount` is unconstrained `NUMERIC`. That type does not have a scale, and Postgres's own division scale is chosen inside the server. `computeNextTranche` is a pure function with no database, and both `insertGrant` and the worker have to use it.

The helper divides in fixed point at 12 decimal places and gives the leftover to the last tranche. The strings it writes are the precision the column stores. Their numeric sum is the original amount. For the 250000 / 12 first tranche, `Number` of that string is the same value as `250000 / 12`, which is what TEID-19-T1 compares.

`monthsBetween` follows the spec's UTC year/month rule, including the day-of-month and time-of-day check. It does not call `period.Boundaries`.

The row does not store a tranche index. The worker's next index is the count of `issued` and `released` ledger rows for that grant. The issued row is the tranche released at insert.

## Overage after the commit is already empty

The rate is taken from a commit this call actually drew. A call that locks no eligible commit leaves `overage_amount_due` NULL. That is the spec's rule, so the priced amount cannot come from a grant that does not appear in the response lines.

TEID-19-T7's burst therefore has two kinds of overage. The one event that takes the last of the balance and still has a remainder is priced at that commit's rate. Later events in the same burst find the commit already at zero, do not lock it, and stay unpriced. The test asserts both.

## Identical timestamps

TEID-19-T8 sends two consumes with the same `as_of`. `as_of` only decides eligibility. It does not order the two transactions. The request whose transaction takes the `FOR UPDATE` lock first receives the entire remaining balance. The other is one overage line. The tested property is that the balance is not applied twice and is not split across both requests.

## Amending the term does not rebuild the schedule

`PATCH /grants/:id/amend` updates only the columns the body sent. It does not recompute `next_release_at`. The spec's statement of the update is that narrow, and no cataloged test changes `expiry_date`.

If an amended expiry moves the remaining anniversaries out of range, the worker clears `next_release_at` and does not insert a zero-amount `released` row. Lengthening the expiry does not add tranches after the schedule has already stored a null `next_release_at`.

## Carryover does not open the next term

A commit with `carries_over` true writes `entry_type = 'carried_over'` for the unused balance and still becomes `status = 'expired'`. No new grant is inserted. That is the boundary the spec states: the catalog only checks the non-carryover path, and the carrying path is a distinguishable ledger line rather than a new term.
