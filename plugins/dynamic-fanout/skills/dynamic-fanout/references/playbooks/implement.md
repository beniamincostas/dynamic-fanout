# Playbook — implement

Load this only when `kind: 'implement'`. As of 0.1.3 the implement loop is its own
workflow, `dynamic-fanout:implement` (`workflows/implement.js`) — the master builds args
v1 and calls it; it is no longer a hand-written inline script.

## When this kind applies

- Code or config must change (feature, fix, mapping, fixtures) in ≥2 independent units;
  one coherent change is solo.
- The run **always pauses** before the real work: show cells, files, the priced card and
  the worktree decision, and wait for `go` (the workflow itself refuses to start without
  either `dryRun` first or an explicit `confirmed: true` once the estimate clears
  `pauseUsd`).

## The implementation envelope (now enforced in code)

0.1.0 had no cost envelope: the first real run spent ~$226 over 9 implement launches
after a review that cost $58.58. The workflow now prices and meters every launch itself:

1. **It prices every theme through the foreman** (`kind: 'implement'`, `dryRun: true`,
   one unit card per theme) before anything runs, and refuses to start if the estimate
   exceeds `caps.ceilingUsd`.
2. **The reviewer's cost is reserved up front**: estimate = Σ theme estimates +
   `1.5 × max(theme estimate)` for the whole-diff review, and the review's share is held
   back from the budget while themes run, so a repair pass can never eat the money the
   merge gate needs.
3. **At most one repair pass per theme, then stop.** A theme that fails twice (or once
   with `fb: null`) is reported `failed`/`refused`; the workflow never attempts a third
   pass on its own.
4. **Every launch is metered against the ceiling** as it runs (not only at the start): a
   theme or the review that no longer fits the remaining budget is refused with reason
   `budget`, not launched and then left to overrun.
5. **One independent whole-diff review** (`dynamic-fanout:reviewer`, read-only, 30 turns)
   runs once at least one theme landed, over every commit the run made — not a second
   fan-out, and not one of the implementers reviewing its own work.
6. **One fresh session per theme** is still the right call for multi-theme work (for
   example the themes a review produced): this skill runs at `effort: max`, and one long
   session re-reads its growing context on every turn (the first run's master cost ~$78,
   mostly that). Hand each theme over as a short brief: findings, files, the baseline
   command.

A real cycle (0.1.3): 7 serial test-first fixes (opus·medium implementers, one repair
pass on a pre-chosen `fb`, full-suite gate) cost **$10.13** against a **$20–25** estimate.
Two of the seven needed their repair pass (one first attempt returned nothing); the final
whole-diff review needed its own turn budget — the reviewer agent now gets 30 turns,
where a single-claim skeptic has 12 — and it still needed a nudge mid-review the first
time the cap was too tight. Size the review budget for a whole PR, not for one claim.

## Recipe (master, in order)

1. **Baseline test run first** (master, one Bash call, in the worktree): record `passed`
   and `skipped` counts — not individual failing test ids. The gate is **the suite stays
   green against this baseline**, so pre-existing reds never trigger a re-route, and a
   theme that quietly removes or skips a test is flagged (`suite passed < baseline`).
2. **Isolation decision.** Use a worktree only if **all** hold: inside a git repo, clean
   tree, the themes' files are disjoint, and ≥3 themes. Otherwise run the themes
   **serially in the current worktree** — `dynamic-fanout:implement` always runs themes
   serially either way; a worktree only changes whether the branch is shared with other
   work.
3. **Build args v1** (below) — one theme card per independent change, the test command,
   the commit prefix, the baseline, and `caps.ceilingUsd`.
4. **Call it with `dryRun: true` first.** Read the returned `estimate` and `card`; if
   `reason` is `'money'` (over ceiling) or `'rails'` (shape errors), fix the plan — drop
   or merge themes, lower effort, or raise the ceiling with the user — and dry-run again.
5. **Show the priced card and get `go`.** This mode always pauses; never launch the real
   run without the user's go-ahead, and never merge or deploy its result without asking
   again afterward.
6. **Launch for real** (same args, `confirmed: true` if the estimate is also over
   `pauseUsd`). The workflow runs each theme (test-first, one repair pass on its `fb`,
   gated on the baseline), then the whole-diff review when at least one theme landed.
7. **Master closes**: merge worktree branches (if any), re-run the baseline once on the
   merged tree, then the step-7 close scripts and the ledgers (SKILL.md §7); report the
   workflow's own `money.committedUsd` vs `ceilingUsd`, and the reviewer's verdict
   (`SAFE TO MERGE` / `NEEDS CHANGES`) before proposing any merge.

## Typical vectors and cells (Opus session, E_ref = xhigh)

| Theme | Vector | p → fb | Why |
|---|---|---|---|
| Add a column + fixtures to an exact spec | D1 A0 T1 C1 V2 B1 G0 | sonnet·medium → opus·high | the tests are the check |
| Category mapping with a default-bucket fallback | D2 A1 T1 C1 V1 B2 G1 | opus·high → null | booked; its own tests share its blind spots |
| Rename/move across call sites | D0 A0 T1 C1 V2 B0 G0 | sonnet·low → sonnet·medium | grep count + tests catch misses |

- B2 implementation logic → W·high; B1 logic → W·medium with `fb` W·high; mechanical
  edits to an exact spec → sonnet.
- Every theme keeps CLAUDE.md (`ctx: 'keep'`): project rules (formats, read-only
  clients) live there, and the implementer agent always runs with full context.

## Args v1 (`dynamic-fanout:implement`)

```js
{
  v: 1,
  session: { S, W, refEffort },
  worktree: '/abs/path',              // already on the work branch
  testCmd: 'npm test',                // exits 0 when the suite is green
  commitPrefix: 'fix(scope):',
  baseline: { passed: 42, skipped: 1 },
  shared: '<preamble + rules capsule, identical for every theme>',
  themes: [{
    id: 't1', vec: 'D1 A0 T1 C1 V2 B1 G0', why: '<=140 chars',
    brief: '<pointers: paths, line ranges, the failing behaviour>',
    in: 24000,                        // optional; est. tokens this theme reads
    p: { model?, effort },            // primary cell; model omitted = S
    fb: { model?, effort } | null,    // the one repair cell, strictly stronger than p
  }],
  review: { enabled: true, cell: { model?, effort } },  // default W·min(high, refEffort)
  caps: { ceilingUsd: 15, pauseUsd: 10 },
  calib: { pm, scaleByRole },         // optional: the CALIB line from stats.mjs --summary,
                                      //   passed through to the pricing dry run
  dryRun: false, confirmed: false,
}
```

- Pricing reuses the foreman: the workflow calls `dynamic-fanout:fanout` with
  `kind: 'implement'`, `dryRun: true` and one unit per theme (`ctx: 'keep'`,
  `check: 'tests'`), so implement and fan-out estimates come from one price model and the
  same `estUsd`/`turns` per theme.
- Themes price on their own role, `implement` (prior `scaleByRole.implement` 3.5, since
  0.1.5): implementers keep CLAUDE.md, run test suites and take many turns, and priced as
  `work` they came out ~3.5× low. Pass `args.calib` so the factor learned by `stats.mjs`
  (role `implement`) replaces the prior.
- Each theme runs on `dynamic-fanout:implementer` (60-turn cap), test-first: write or
  extend a failing test, then make the change that turns it green, then commit.
- A theme's result: `status: 'ok' | 'partial' | 'blocked'`, `suite: {passed, failed}`,
  `files_changed`, `commit`, `summary`. `ok` needs `suite.failed === 0`; a `blocked`
  result naming `brief`/`access`/`scope` goes back to the master, never to `fb` (the
  repair cell would hit the same wall).
- The review prompt carries the intended changes (theme id, outcome, first line of its
  brief) and the commit range, not the implementers' reasoning, so the reviewer judges
  the diff on its own terms. See `agents/reviewer.md` for what it checks and reports.

## RESULT

```js
{ started: true, card, estimate: { units, review, total },
  money: { committedUsd, ceilingUsd },
  results: [{ id, attempts: [{ n, cell, kind, ok }], outcome, reason, result, warning }],
  review: { ran: true, cell, range, text } | { ran: false, reason },
  summary: { ok, repaired, failed, brief, refused }, warnings }
```
`outcome` ∈ `ok | ok-repaired | failed | brief | refused`. `started: false` shapes mirror
the foreman's: `{ reason: 'rails'|'money'|'dryRun'|'pause'|'no-args', ... }`.

## Fallback: hand-written inline script

The dedicated workflow covers the common shape (serial themes, one repair pass, one
review). For a shape it does not fit — for example themes that must run in parallel
worktrees, or a review gate that is not a single reviewer agent — the master may still
write an inline Workflow script from the recipe above, using the same card format and
rails, and call `workflow('dynamic-fanout:fanout', { ...args, kind: 'review', ... })` for
its diff review (one nesting level is allowed). Reach for this only when
`dynamic-fanout:implement`'s args v1 genuinely cannot express the run.
