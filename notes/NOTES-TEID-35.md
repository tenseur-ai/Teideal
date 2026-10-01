# TEID-35 implementation notes

## Pure replay signature and starting state

The architecture section writes the signature as
`replayConsumption(events: ReplayableConsumeInput[]): ReplayResult`, while
the same section requires the function to take each grant's starting state.
`ReplayableConsumeInput` is explicitly fixed to event-only fields, so the
starting grants cannot be derived from that array without database access
(which the function is also explicitly forbidden to perform).

The conservative resolution is an explicit second argument:
`replayConsumption(events, startingGrants, override?, planOrder?)`. The grant
shape is the existing `DrawableGrant`, and the optional order arguments let
the function call the existing `resolveEffectiveOrder` and
`sortGrantsForDraw` functions directly. The function copies both input
arrays and remains synchronous, deterministic, side-effect-free, and free of
database access.

## Reconstructing the diagnostic endpoint's snapshot

The endpoint is required to read grants "as of before the earliest" replayed
event, but the current schema has no temporal grant-state snapshots. The
route reconstructs the information the schema does retain: in one
tenant-scoped transaction it reads grants eligible at the earliest timestamp
and adds back consumption lines recorded at or after that timestamp. This is
exact for the story's direct-insert fixtures and for ordinary draw-only
history. A historical grant void/status change cannot be reconstructed from
the current schema; TEID-34/36 callers therefore still need to supply the
consistent snapshot that the pure function contract requires.

There is also no `usage_event_id` column on `usage_consumptions`, despite the
spec referring to an originating usage event id. The acceptance fixtures use
the immutable `usage_events.id` as the matching `usage_consumptions.id`, so
the documented `(occurred_at, id)` tie-break remains literal without adding
an unrequested schema migration.

## Authentication wording

The route paragraph asks simultaneously for console roles (`Owner` and
`Billing Admin`) and `requireAuth(pool, "admin")`. The existing
`consumptionOrder.ts` pattern is session authentication via `requireSession`
plus `consoleRoute` role enforcement; `requireAuth` authenticates API keys
instead and cannot be combined with the same bearer session. The new route
follows the explicit role requirement and the file's actual existing pattern.

## Large request body

T5 sends 50,000 UUIDs, which exceeds Fastify's default one-megabyte request
limit. `consoleRoute` now accepts an optional Fastify route-options argument,
used only by replay-check to set a four-megabyte limit. Existing console
routes retain their prior options and behavior.
