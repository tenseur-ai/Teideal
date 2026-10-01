# Handover: Teideal, solution architect + local orchestrator

You're picking up as solution architect on **Teideal**, a multi-tenant
usage-based billing platform. Repo: `Sathyanarayan-Kiran/Teideal`
(GitHub). This is a continuation, not a fresh start -- read this whole
file before doing anything, then read `docs/parallel-work.md` in full
(it's the living process doc; this handover summarizes it but the repo
file is the source of truth if the two ever disagree).

## What's different about this session vs. prior ones

Prior sessions ran in an isolated cloud container with no access to the
user's machine. **This session runs locally (Claude Code launched from
VS Code)**, which means -- for the first time -- you have real shell
access to the user's installed tools. Confirmed installed and working
locally as of this handover:

```
grok --version    -> grok 1.0.41 (4220f3b224a6)
codex --version   -> codex-cli 0.157.1
gemini --version  -> 0.61.0
```

This changes the orchestration model from "write a spec, post a GitHub
issue, wait for a human to point an agent at it, wait for a PR" to
"invoke the coder CLI directly as a subprocess, drive it, review what it
produced." **You have not yet actually run any of these three CLIs** --
before relying on any invocation syntax, run `codex --help`, `gemini
--help`, `grok --help` yourself and confirm the real flags (how to pass
a prompt, how it handles git branches/commits, whether it opens a PR
itself or just edits the working tree) rather than assuming. Write down
what you find in `docs/parallel-work.md` once confirmed, the same way
every other process detail in this repo is documented rather than kept
in your own head.

## Your role (non-negotiable, established over many turns)

You are the **sole solution architect**. You write specs; you do not
write feature code. Developer agents (Codex, Gemini, and now
Cursor/Grok -- three total) each own a whole *phase* (= one epic) and
implement strictly from your specs, writing their own tests. Whether a
given agent is driven as a local CLI subprocess (this session's new
capability) or still via the GitHub-issue handoff from the prior
process, the contract is identical: the spec is complete and
self-contained, the agent doesn't need to consult the live board
directly, and **you independently verify every PR before calling it
done -- never on the agent's self-report.**

Ground rules that have held since story #1, all still in force:
- The backlog (`DATA` object embedded in `index.html`, also published
  live at `https://claude.ai/artifact/839FeX3RzSMymBpPySBYXj`) is the
  spec of record. Always pull a story's exact `ac[]`/`tests[]` from
  there before writing or reviewing a spec -- never from memory or from
  what a previous spec said.
- Stories within a phase are built in the backlog's `order`, one at a
  time. No jumping ahead within a phase. Two agents never share a phase.
- "Done" means every acceptance criterion is satisfied by working code
  **and** every cataloged test -- functional, non-functional, AND
  adversarial -- has a real, passing, automated test. Not "should pass."
  Run it.
- **Never trust a developer agent's self-reported "all tests passed."**
  Every PR gets independently verified by you before you call it done:
  pull the branch into a fresh git worktree (under `/home/user/` in the
  cloud sessions; locally, wherever is outside the main working copy
  and outside any path a restrictive local Postgres peer-auth setup
  can't traverse -- verify this works before relying on it), drop and
  rebuild the `teideal` Postgres database from scratch via
  `db/setup-local.sh` + the seed scripts, build and run the actual
  services, run every claimed test suite yourself, and spot-check that
  the test *assertions* are substantive, not tautological. This has
  caught real bugs already -- a CI step in one PR that referenced a test
  suite that didn't exist on that branch yet, and a load test whose
  "background load" variable was computed but never actually used to
  throttle anything. Don't skip this because a local CLI feels more
  trustworthy than a cloud one; the discipline is the same regardless of
  how the code arrived.
- **You now have standing merge authority** (granted 2026-09-27): once
  your independent verification passes, merge the PR yourself. No
  separate human click required.
- Push only to your own branch (see "Branch" below). Never push to
  `main` directly except by fast-forwarding it to match your branch
  after a merge (`git merge-base --is-ancestor origin/main
  origin/<your-branch>` first -- it's been a clean fast-forward every
  time so far, but check). Never create a PR without explicit permission
  each time, for anything that isn't a developer agent's own PR into
  your branch.
- Every commit/PR you make ends with the attribution footer given to
  you in *this* session's system reminder -- session URL changes per
  session, use whatever this session's reminder gives you, never an old
  one copied from a prior handover (including this one).

## Branch

The cloud-session harness auto-assigns a fresh branch name per session
(most recently `claude/eager-brown-dlqfl4`, before that
`claude/upbeat-cerf-c48vx0`). **A local session has no such
auto-assignment** -- there's no harness picking a name for you. Recommended:
keep working directly on `claude/eager-brown-dlqfl4` rather than
inventing a new branch name, so the branch-name churn stops now that
control is moving local. Confirm with the user if you want to rename it
to something stable instead, but don't let it drift silently.

Current state of that branch (verify this yourself with `git log` before
trusting it -- this is a snapshot, not a promise):
- HEAD: `403cdf9` ("specs/TEID-44: full data export")
- `main` is 2 commits behind (`0a5379c`), both docs/spec-only (no code
  drift) -- fast-forward it once you've got something new merged, or
  right away if the user just wants it synced now.

## Where things stand right now

**Phase E05** (tenant isolation, access control, data ownership) --
developer agent Codex, lives in `services/ts-console`:
- TEID-41, TEID-91, TEID-42, TEID-92, TEID-43 -- all done, all merged,
  all independently verified (most recently TEID-43: PR #3, rbac 8/8,
  cross-tenant 23/23, console-auth 13/13, audit-log 7/7, api-keys 9/9,
  re-run for real against a from-scratch DB rebuild).
- **TEID-44 (full data export) -- spec written (`specs/TEID-44.md`),
  committed, and posted as
  [GitHub issue #4](https://github.com/Sathyanarayan-Kiran/Teideal/issues/4).
  Not yet started by Codex as of this handover.** This is the largest
  architecture lift in the phase so far -- it required a narrow, explicit
  exception to ADR 0001's per-table ownership rule (reads `usage_events`,
  a `go-usage`-owned table, directly from `ts-console` rather than
  crossing into Gemini's active phase) and introduces two new
  dependencies (AWS SDK for S3/STS cross-account delivery, and
  `@dsnp/parquetjs`). Read the spec's "Scoping notes" section before
  doing anything with this story -- the reasoning is there, not just the
  conclusion.
- After TEID-44: no further E05 stories are currently in the visible
  backlog beyond what's cataloged -- check the live board for anything
  added since.

**Phase E03** (usage ingestion and exactly-once ledger) -- developer
agent Gemini, lives in `services/go-usage`:
- TEID-30 (usage event ingestion API) -- done, merged (directly, not via
  a GitHub-tracked "merged" PR -- verify with `git log --graph` rather
  than trusting the GitHub PR API's `merged` field, which showed `false`
  for this one despite the commits being genuinely there), independently
  verified twice (once per-branch after a CI-bug and load-fidelity fix,
  again post-merge against a from-scratch DB rebuild).
- **TEID-94 spec -- not yet written.** This is next in queue for
  Gemini. After TEID-94: TEID-95, 96, 31, 32, 33, 35, 34, 97, 36, in
  that order, per the backlog's `order` field -- pull each one's exact
  `ac[]`/`tests[]` fresh from the live artifact when you get there, per
  the standing rule above.

**Phase E01** (entitlement model and pricing configuration) -- newly
assigned developer agent Cursor/Grok, lives in `services/ts-console`
(same service as E05, but a structurally separate file set -- new
`plans`/`grants`/`commits`/`overrides` tables and routes, nothing E05's
files touch):
- **Nothing built yet. TEID-16 spec -- not yet written.** This is E01's
  first story (`order: 29`, the lowest in this epic among MVP-release
  stories -- TEID-21 is `order: 78`/phase-2, out of order for now).
  MVP order for the rest of this phase: TEID-16, 17, 18, 19, 20, 22, 23.
  This phase was chosen specifically because several already-shipped
  stories (TEID-92, TEID-43, TEID-44) all had to flag "plans/pricing
  config doesn't exist yet" as a scoping gap -- E01 is what actually
  resolves that for future stories.

**Live board**: `https://claude.ai/artifact/839FeX3RzSMymBpPySBYXj`.
`window.EMBEDDED_STATE` holds status/ac/tests/history per story -- TEID-41
through TEID-92, TEID-43, and TEID-30 are all marked `done` with every
AC/test checked and a history entry. TEID-44/94/16 are still `todo`
(spec-in-progress or not-started). You own syncing this -- no developer
agent has publish access. To edit it: `Artifact` tool's `read` action
with a prompt asking for the exact entry you need (it returns a saved
local HTML file you can grep/edit directly, since the response is often
too large for a single read), edit the `EMBEDDED_STATE` JSON with a
precise string replacement, then `Artifact` `publish` with `url` set to
republish in place.

## Cost and capacity management (established 2026-09-27, carry forward)

- **Rework is the dominant cost, more than verification thoroughness.**
  Ground every spec against the actual current codebase (read the real
  schema, the real existing routes, the real existing patterns) before
  writing it -- an ambiguity that sends an agent down the wrong path
  costs far more, in whichever tool's usage, than the extra time spent
  getting the spec right first.
- **Scale verification effort to the change.** The full from-scratch
  DB rebuild + every affected suite is non-negotiable for the final
  pre-merge pass. A quick fix-and-reverify loop after sending feedback
  back doesn't need the full matrix every time -- just what the diff
  could plausibly touch.
- **Cache dependencies across verification worktrees** (shared
  `npm`/Go module cache directory) rather than a fresh `npm ci`/`go mod
  download` per worktree -- only the *database* needs to be genuinely
  from-scratch each time, not the package cache.
- **Keep stories bounded (~5-8 points).** Caps how much one agent
  invocation can burn before there's a PR to review, and bounds the risk
  if a window cuts off mid-story (see below).
- **Check each CLI's own model/tier flag** for routine work vs.
  anything gnarly -- confirm via `--help` once you've actually run each
  one.
- **React to events, don't poll.** Use PR/CI activity subscriptions
  (cloud sessions) or whatever the local CLI's own completion signal is,
  rather than repeatedly checking status.

**If an agent hits a usage-window limit mid-story:** track story state
explicitly (issue/session open -> branch created -> PR opened -> merged)
so "stuck" is visible rather than assumed. Default policy is **wait and
resume the same tool** once its window resets -- work should be pushed
incrementally (commit + push before a session ends, not only at the very
end), so resuming means checking out the existing branch and continuing;
nothing is lost regardless of which literal invocation picks it back up.
Do **not** silently hand a partially-done story to a different tool
mid-flight -- a second tool untangling half-finished code built on a
different mental model is a worse outcome than waiting. Exception: a
story that hasn't been started at all (no commits pushed) is free to go
to whichever tool has capacity next, since there's no sunk work to
protect.

## Immediate next steps (pick up in this order, or ask the user which
they want first)

1. Confirm the three local CLIs' actual invocation syntax
   (`--help` on each) and write down what you learn in
   `docs/parallel-work.md`.
2. Either get Codex working on TEID-44 (issue #4 already posted -- spec
   is ready) via whatever mechanism you've confirmed, or write the
   TEID-94 spec for Gemini, or the TEID-16 spec for Grok -- all three
   are unblocked and ready to start in parallel, this is a judgment call
   on sequencing, not a hard dependency order.
2. Fast-forward `main` to match your branch once you're ready to sync it
   (it's currently 2 docs/spec-only commits behind -- confirm with the
   user first if they haven't already said "always do this").
