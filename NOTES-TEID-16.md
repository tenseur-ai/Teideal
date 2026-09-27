# NOTES-TEID-16

Decisions where the spec leaves a real choice, plus one gap that would otherwise surface as a 500. Nothing here blocked the story.

## GET /plans/:id when the plan is missing

The architecture section says this returns 404. The same paragraph then says to follow whichever of the api-keys 404 and the later 403-on-lookup precedent was used most recently, and that either is defensible. The most recent id lookup in this tree is TEID-44's export routes, which return 403. I used 404, matching the explicit sentence in that section and `GET /api-keys/:id`, which is the route file this story says to copy. PATCH of a plan the caller cannot see uses the same 404 and the body `{"error":"plan not found"}`, so the response does not contain the requested id. Publish of a plan the caller cannot see uses the spec's 409 text, which already covers "does not exist for this tenant".

## Story path `/v1/plans` and status 422

The catalog text says `POST /v1/plans` and a 422 for a missing currency. This service has no `/v1` prefix (`/api-keys`, `/customers`, `/exports`), and the spec's own implementation guidance says to follow `apiKeys.ts` and return 400 with `"currency is required"`. The routes are `/plans` and the validation failures are 400.

## Duplicate metric/model rates

`UNIQUE (plan_id, metric, model)` rejects two rows with the same non-null model. The spec does not say what HTTP error that should be. Leaving it unhandled turns a duplicate payload into an uncaught unique-violation 500. `validatePlanInput` rejects that case first with `duplicate rate for metric ${metric} and model ${model}`. The route also maps Postgres `23505` to 400 `duplicate rate for the same metric and model` in case of a race. Two rates for the same metric with a null model are still accepted: the spec calls out that Postgres treats those nulls as distinct and says that does not need special-casing.

## `updated_at` on publish

The spec's publish `UPDATE` sets status, version, published_by_user_id, and published_at. The statement in code also sets `updated_at = now()` so the row's update timestamp moves with the publish. No cataloged test reads `updated_at`.

## Money fields in JSON

`included_credits`, caps, and `rate` are `NUMERIC` in Postgres. node-pg returns those as strings. The shared row shaper converts them to JSON numbers so a value sent as `0.002` or `10000` comes back as that same JSON number. This is not a second rounding mode; it is the response shape T2's exact round-trip needs. TEID-94 is still untouched.
