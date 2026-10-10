# Foreman contract — `dynamic-fanout:fanout` (args v2)

The master plans; the foreman (`workflows/fanout.js`) executes. **The foreman never
chooses a model or an effort.** It validates the master's cards against the rails,
prices them, runs every unit on its card, inspects, re-routes at most once onto the
card's pre-chosen fallback, dedups, verifies by rung, and returns a digest + ledger.
Read this file when you build the args or read the result.

## Invocation

```
Workflow({ name: "dynamic-fanout:fanout", args: <ARGS object, not a string> })
```
Pass `args` as a JSON object. `dryRun: true` validates + prices and returns the priced
card without launching anything — use it when unsure the plan passes the rails. It is
also **the pricing tool for implementation passes**: `kind: 'implement'` is accepted
only with `dryRun: true`, and its card (per-unit `estUsd` and `turns`, U/P/R/C) is the
envelope the implement playbook budgets against.

## ARGS (v2)

```js
{
  v: 2,
  kind: 'research' | 'review' | 'data' | 'implement',  // implement: fanout only dry-runs
                                                         //   the card; the real run is the
                                                         //   implement playbook's own inline
                                                         //   script (see "Implement mode")
  depth: 'quick' | 'standard' | 'deep',
  stage: 'all' | 'work' | 'verify',   // default 'all'; deep = 'work' then 'verify'
  dryRun: false, confirmed: false,     // confirmed bypasses the pauseUsd stop
  session: { S, W, refEffort, refSource, allowUp: false },
  //  S = session model (haiku|sonnet|opus|fable); W = work tier (= S, or opus on fable)
  //  refEffort = E_ref, the effort ultracode's crew would inherit; refSource = where it came from
  shared: '<preamble + rules capsule — identical for every agent, written once>',
  ultra: { agents, verifiers, ctxTok, inAvg, basis },
  //  what ultracode would spawn for this task; ctxTok = CLAUDE.md tokens on the path;
  //  inAvg = avg tokens an agent reads; basis = one line explaining the count
  units: [{
    id: 'u1', role: 'review',            // free text; cohort key = role + primary cell
    vec: 'D2 A1 T1 C1 V0 B2 G2',         // all 7 features, each 0..2
    n: 0,                                // 1 = numbers must tie out -> planned re-derivation
    scope: { files: ['path/a.py', 'path/b.py'] },
    in: 38000,                           // est. tokens this unit reads
    ctxTok: 30000,                       // optional; CLAUDE.md tokens on THIS unit's path
    ctx: 'omit' | 'keep',                // keep = CLAUDE.md loaded (worker-ctx)
    p:  { model?, effort },              // primary cell; model omitted = S
    fb: { model?, effort } | null,       // the ONE fallback, chosen now
    rd: { model?, effort },              // optional, n=1 only: re-derivation cell (default = p)
    check: 'quote' | 'set' | 'tests' | 'tieout+rederive' | 'V3' | ...,  // '+'-joined
    why: '<=140 chars, names the deciding feature',
    supersedes: 'u3',                    // optional; re-planned unit (fb must be null)
    brief: '<=120 words of pointers: paths, line ranges, questions>',
    schema: { ... }                      // optional JSON Schema for the free `result` field
  }],
  verify: {
    rungs: { blocker: 'V3', high: 'V3', medium: 'V2', low: 'V0', info: 'V0' },
    cells: { V3: { model?, effort }, V4: { model?, effort } },
    //  V2 = max(producer model, sonnet)·min(medium, refEffort); default V3 = W·min(high,
    //  refEffort); default V4 = V3 (same cell, run twice with different lenses)
    topK: 12, batch: 3, expected: 6
    //  topK default: quick 6 / standard 12 / deep 25 (parity claims are never cut by it)
    //  batch default: quick 5, else 3 (claims per V2/V3 skeptic call)
    //  expected default: quick ceil(n/3) / standard ceil(n/2) / deep n (n = unit count;
    //  pricing only — it does not cap how many verifier calls actually run)
  },
  sweep:  { rounds: 1, cell: { model?, effort } },
  //  rounds forced to 0 unless kind is review or research; default rounds quick 0/standard
  //  1/deep 2; default cell = W·min(medium, refEffort)
  reduce: { dedupKey: ['file', 'line'], invariants: [{ name, lhs, rhs, tolCents: 0 }] },
  caps: { ceilingMult: 0.5, parityBound: false, reserveCapPct: 20, rerouteRate: 0.1,
          maxOutputTokens: null, pauseUsd: 10, maxAgents: null, ceilingUsd: null },
  overrides: [{ id: 'u2', p: { model: 'opus', effort: 'high' }, fb: null, by: 'user' }],
  //  an override's `p` with no `fb` clears any old fallback (fb becomes null) — a
  //  re-route target needs no fb of its own; `by` is free text, any value exempts rails
  calib: { /* optional; at least the CALIB line from stats --summary (scale), see economics.md */ },
  agentTypes: { worker, workerCtx, workerMcp, implementer, skeptic, inspector },  // optional overrides
  claims: [ /* stage 'verify' only: results.claims from the 'work' stage, unchanged */ ],
  carry:  { committedUsd: 0, rerouteUsd: 0, invariants: [] }
  //  stage 'verify' only: money from 'work' (digest.money), plus the work-stage
  //  digest.invariants — stage 'verify' does not re-evaluate invariants, it reports
  //  these back unchanged in its own digest.invariants
}
```

Invariant expressions (`reduce.invariants`): `lhs`/`rhs` are `u1.total` (a number by
name from a unit's `numbers`) or `sum(u1.by_code.)` (sum of every number in u1 whose
name starts with `by_code.`). Evaluated in integer cents after all units finish; a
failure is reported in `digest.invariants` for the master — it never re-routes.

## Agent types (`typeKey` / `unitAgentType`) and turn caps

The foreman picks each unit's agent type; the master never names one directly. In order:

| # | Condition | typeKey → agent | Turn cap | Prefix priced |
|---|---|---|---|---|
| 1 | `role === 'implement'` | `implementer` → `dynamic-fanout:implementer` | 60 | 15k + `ctxTok` |
| 2 | else `ctx === 'keep'` | `workerCtx` → `dynamic-fanout:worker-ctx` | 30 | 15k + `ctxTok` |
| 3 | else vector `T === 2` (MCP or long tool loops) | `workerMcp` → `dynamic-fanout:worker-mcp` | 35 | 15k |
| 4 | else | `worker` → `dynamic-fanout:worker` | 30 | 8k (lean) |
| — | verifiers / inspectors | `skeptic` / `inspector` | 12 / 6 | 8k (lean) |

The cap is the agent file's `maxTurns` and the same number `price()` uses (`calib.caps`).
Each unit's planned turns = min(cap, round((10 + in/2500) × effort factor)); the card
prints them as `turns`, and the prompt states them (see "Unit prompt" below).

`agentTypes` overrides one or more of these by name (`workerMcp` is the override key for
step 3); an override still has to be a real agent file. `worker`/`worker-ctx`-adjacent
skeptics (`dynamic-fanout:skeptic`) follow the same `worker`/`worker-mcp` split on their
own tool needs, via the same vector check.

`worker`, `worker-low/medium/high` and `skeptic`/`skeptic-high` declare an explicit
`tools: Read, Grep, Glob, Bash` allowlist — no MCP tool definitions reach their system
prompt, which is the cheap end of the measured `baseCtx` range (see `economics.md`
Stage-0 calibration). `worker-mcp` and `worker-ctx`/`worker-ctx-xhigh` instead inherit
every tool minus `Edit, Write, NotebookEdit, Agent`, so an MCP-heavy or long-tool-loop
unit is not starved of what it needs. Route to the allowlisted agent whenever `T < 2`
and `ctx:'omit'`; reserve `worker-mcp`/`worker-ctx` for the units that actually need the
wider tool set.

## Rails — the whole plan is rejected before any agent launches

The foreman returns `{ started: false, errors: [...], warnings: [...], card }`
(`reason: 'rails'`). Fix the plan **once**; if it fails again, narrow verification or go
solo.

| Rail | Error text starts with |
|---|---|
| args shape: v missing/not 2, kind unknown, `kind:'implement'` without `dryRun`, depth unknown, stage unknown, units missing/empty, duplicate id | `args:` |
| S is haiku (haiku sessions run solo); W above S | `session:` |
| `vec` missing/malformed; `why` missing or >140; `brief` missing; unit id missing | `card u1:` |
| haiku cell with an effort, or with T≥1 (needs sonnet) | `haiku u1:` |
| cell model unknown; cell model above S without `allowUp`; a Fable session running a non-parity unit on fable; >1 allow-up unit in the whole run | `tier u1:` |
| effort missing (non-haiku) or unknown; effort above `refEffort` (warning, not error, for an overridden unit) | `effort u1:` |
| `fb` not strictly stronger than `p`; a `supersedes` unit with non-null `fb` | `fb u1:` |
| parity unit (V0∧B2∧D≥1) not on S·refEffort, or with non-null `fb` (skipped for an overridden unit); `ctx` is not checked — `omit` with a capsule is the default | `parity u1:` |
| `check` missing; `none` outside parity; n=1 without `rederive` in check | `check u1:` |
| verify rung for a severity not one of V0..V4 | `verify:` |
| V3/V4 cell model unknown or haiku; effort missing, unknown, or above `refEffort`; model above S without `allowUp`; weaker (model) than a non-parity producer | `verify:` |
| sweep cell missing a non-haiku model + effort, or effort above `refEffort` | `sweep:` |
| `ultra.agents` < 1 (U cannot be priced) | `money:` |
| `parityBound` set while parity spend ≤ ceilingMult·U | `money:` |
| P + R > C, crew ceiling (warning instead, when any unit is overridden or `caps.ceilingUsd` is set) | `money:` |
| planned agents > `caps.maxAgents` | `caps:` |

Warnings only: >2 distinct cells in the work stage (cache sharing, `cache:`); planned
agents > 25 (`size:`); for `review`/`research` with ≥3 units, more than 70 % of planned
work-unit spend on S (`routing: X% of planned work-unit spend runs on <S>; split
mechanical work (inventory, consistency, mapping, extraction) into sonnet units`); a verifier cell weaker than a user-overridden producer (`verify:`);
with any override, plan ≈ U or more (`money:`); a `parityBound` run (`money:`); an
override naming a unit id that does not exist (`override <id>: no such unit`).

Any `overrides[]` entry, whatever its `by`, skips the parity rail and the tier-above-S
rail entirely for that unit (a second allow-up unit can still trip the allow-up-count
rail), and turns the effort-above-`refEffort` error into a warning; the money rail (P+R>C)
becomes a warning whenever any unit is overridden or `caps.ceilingUsd` is set. The `fb`
not-strictly-stronger rail, the haiku rails, the allow-up-count rail, and all verify
rails still apply regardless of override. The card shows `override: <by>` on that unit
(`u.override || null`).

Strength order: model `haiku < sonnet < opus < fable`, then effort
`low < medium < high < xhigh < max`. "Strictly stronger" = higher model, or same model
and higher effort.

## Money (see economics.md for the price model)

| | Meaning |
|---|---|
| **U** | ultracode-equivalent: `ultra.agents` + `ultra.verifiers` priced at S·refEffort with `ultra.ctxTok` CLAUDE.md, as unbounded agents (full prefix, read factor 4, turn cap 80) |
| **P** | Σ units (primary + one inspector call if `check` has `quote` or vec is B2 + planned re-derivation) + expected × V3-cell verifiers + sweep rounds × sweep-cell + (deep only: 1 completeness critic on W·min(high,refEffort)) |
| **R** | reserve = Σ_fb rerouteRate·repair(fb), floored at the largest single repair, capped at reserveCapPct·P (the floor wins); the largest B2 repair is earmarked |
| **C** | crew ceiling = ceilingMult·U, or 0.8·U with `parityBound`, or `caps.ceilingUsd` (user) |

Pricing basis for P's non-unit terms: verifiers are priced on the `V3` cell at
`ultra.inAvg·verifierInFrac`, the sweep cell at `ultra.inAvg`, and the critic at
`ultra.inAvg·verifierInFrac` — all three with 0 CLAUDE.md context on the lean prefix,
the verifiers on the skeptic cap (12) and the sweep/critic on the worker cap (30). The
planned verification spend is reported as `verifyUsd`. The inspector call is
priced once per unit regardless of how many inspector calls that unit's run ends up
making (see "Inspector" below).

Runtime: every launch commits its estimate, from one of three pools:

| Pool | Size | Draws |
|---|---|---|
| work | `C − R − verifyUsd` | units, infra retries, capacity slices, inspectors, sweeps, the critic, promoted launches (their primary estimate) |
| verification reserve | `verifyUsd` | verifier batches first; once it is spent they draw from the work pool |
| re-route reserve | `R` | re-routes and promotion deltas (non-B2 units cannot touch the B2 earmark) |

A promoted launch must pass **both** checks (the delta against `R`, the primary estimate
against the work pool and the kill switch); if either refuses, the unit runs on `p`
through the normal check. A refused launch has a different effect per kind: a unit's
primary/infra-retry/re-route attempt → that unit `UNVERIFIED` with reason `budget`; a
verifier batch → those claims `UNVERIFIED` and dropped; an inspector call → recorded
`skipped`, no quote signal, the unit can still finish `ok`; a capacity slice → skipped
silently, its files listed as `uncovered`; a sweep round or the critic → dropped.

**Kill switch:** once measured output since start exceeds 75 % of `maxOutputTokens`
(default 1.5× planned output), no **new work** launches. It never refuses a verifier
batch: verification of claims already produced draws from its reserve, then from what
is left of the work pool. With a native `+Nk` budget, nothing launches below 25 %
remaining (verification included). Pause: `P > pauseUsd`, not `confirmed`, and stage is
not `'verify'` → returns the card unstarted (`reason: 'pause'`, plus a `note`).

If claims still come back UNVERIFIED `budget`, the master does not re-verify them by hand:
it runs `stage: 'verify'` with those `claims` and `carry`.

## Per-unit flow and the four failure classes

1 primary + ≤1 infra retry + ≤1 capacity slice + ≤1 capability re-route. Never more.

| Class | Signal | Action |
|---|---|---|
| infra | null result / API error | 1 retry on `p`: it keeps the agent type if that type already answered once in this run (so its turn cap and lean prefix still apply); a type never seen working is dropped (a missing plugin agent) and the retry runs on the default subagent; then UNVERIFIED `infra` |
| capacity | scope files missing from `files_read`, or `status:'partial'` with `remaining[]` | 1 run on `p` for the missing slice only; a second shortfall lists the files as uncovered |
| brief | `blocked`: `no_access` / `ambiguous_brief` / `out_of_scope` | no rerun → master |
| capability | quotes resolve <70 %; a cited file not in `files_read`; a B2 finding without evidence; `blocked`: `too_hard` / `contradictory_evidence` / **no `blocked_reason` at all**; tie-out mismatch; confidence <0.5 **and** a soft signal (70–90 % resolve, or ≥3 assumptions) | run `fb` once (mode below), re-check once; fail → UNVERIFIED |

Evaluation order decides the class, checked in this order: no result → `infra`; blocked
with a brief reason → `brief`; blocked with `too_hard`/`contradictory_evidence` **or
blocked with no reason at all** → `capability` straight to `fb` (no capacity slice, even
if scope files are missing); then `capacity` (only if a capacity slice hasn't already
run); then the other capability signals (quote resolve rate, uncited files, B2 evidence,
tie-out, confidence+soft); otherwise `ok`.

Mode: tie-out mismatch → `rederive` (a different method; a match with either earlier
derivation is CONFIRMED); <50 % quotes resolve → `redo` (fresh, defects as warnings);
a blocked-for-capability unit uses `rederive` if its tie-out failed, else `repair`
(never `redo`); otherwise `repair` (previous output + defect list, fix only those).
Confidence <0.5 with no soft signal → no rerun; the unit's claims go one verify rung up.

**Cohort promotion:** when ≥2 capability failures make up ≥25 % of a cohort (same role
+ same primary cell), the cohort's not-yet-started units launch directly on their own
`fb` (delta paid from R) and get no further fallback.

**Inspector:** units whose `check` contains `quote`, and every B2 unit, run an inspector
call checking that each `{file, line, quote}` exists within ±3 lines (≤40 quotes per
call). It fires once per returned result that has evidence to check — so a unit can get
up to 3 calls across its run (primary, a capacity slice, a re-route), merged together;
`price()` only budgets one call per such unit. A result with no evidence items gets no
call, and a budget-refused call is recorded `skipped` (no quote signal, not a capability
failure by itself). The inspector never judges correctness; deterministic file checks
happen later in `scripts/check-evidence.mjs` (downgrade-only).

## Verification rungs

Rung = `verify.rungs[severity]`, +1 for `ok-rerouted` **and** +1 for confidence <0.5
(they stack — a rerouted, low-confidence unit's claims get +2), raised to the unit's
own floor (a `V2`/`V3`/`V4` token in its `check`, case-insensitive), raised again to at
least V3 for parity claims, capped at V4. Claims from a unit that ended `unverified` or
`brief` are UNVERIFIED (`unit <outcome>: <reason>`) and skip verification entirely —
they never reach a rung. Claims beyond `topK` are UNVERIFIED `topK` and listed in
`digest.dropped`; parity claims are always verified and never count toward `topK` — the
cut applies only to the remaining claims, sorted by severity then blast radius.

| Rung | What runs | Verdict source |
|---|---|---|
| V0 | nothing | PLAUSIBLE |
| V1 | inspector-grounded quotes / tie-out | PLAUSIBLE (grounded); numbers that tie out are CONFIRMED |
| V2 | 1 skeptic on max(producer model, sonnet)·min(medium, refEffort), ≤`batch` claims of one unit | skeptic |
| V3 | 1 skeptic on `verify.cells.V3` (default W·min(high, refEffort)), ≤`batch` claims | skeptic |
| V4 | 2 skeptics with different lenses on `verify.cells.V4` (default = V3's cell) | same verdict from both → that verdict; any disagreement involving REFUTED → UNVERIFIED `split` (master spot-reads); any other disagreement → PLAUSIBLE; one lens returned nothing → the other lens's verdict alone |

REFUTED without a `counter_quote {file, line, quote}` is downgraded to PLAUSIBLE.
`UNVERIFIABLE` from a skeptic becomes UNVERIFIED. The V2 cell is not checked by the
`verify:` rails (only V3/V4 are).

## Unit prompt

Every unit prompt is `shared` preamble → unit header and brief → `Scope:` file list →
the fixed rules → the budget lines → (numbers rules) → (mode text) → the cost tag. The
budget lines, for a unit with planned turns N on an agent with cap CAP:

```
- Budget: about N tool calls (hard stop at CAP). Find before you read: grep or glob first,
  then Read only the line ranges you need (offset/limit), not whole files; leave Scope only
  to resolve a reference. Keep your last 2 calls for the answer; if the budget runs out,
  return status "partial" with remaining[] instead of continuing.
- Cite every file path exactly as it is written under Scope.
```

A `partial` with `remaining[]` is a capacity signal: one slice run on `p` covers the rest.
Inspector items are mapped onto the unit's scope files before the check (exact match,
then a unique suffix match), so a worker citing `fanout.js` for the scoped
`plugins/x/workflows/fanout.js` is still resolved.

## RESULT

```js
{ started: true, card,
  digest: {
    counts: { units, ok, okRerouted, okPromoted, brief, unverified, claims,
              confirmed, plausible, refuted, unverifiedClaims, pending },
    exceptions: [{ id, cls, reason, cell, why }],     // every non-ok unit
    top: [{ cid, unit, severity, title, verdict, file, line }],
    money: { U, P, R, C, parityBound, committedUsd, rerouteUsd, verifyUsd, outputTokens, note },
    //  committedUsd includes verification spend; verifyUsd = the part drawn by verifiers
    warnings: [], dropped: [{ what, count, reason }],
    invariants: [{ name, ok, lhs, rhs, diffCents }],
    critic: [ /* deep only: what is missing */ ] },
  ledger: {
    units: [{ id, role, vec, parity, p, fb, ctx, check, why, override, outcome, reason,
              verifyBump, attempts: [{ n, tag, cell, kind, mode, cls, estUsd }] }],
    verifiers: [{ tag, cell, rung, claims, estUsd }],
    inspectors: [{ tag, unit, quotes, resolved, estUsd, skipped }],
    sweeps: [{ tag, cell, round, newClaims, estUsd }],
    cells: { 'opus·high': 3 }, reroutes: 0, promotions: [] },
  results: {
    units: { u1: { status, summary, files_read, numbers, numbersStatus, numbersConflict,
                   result, assumptions, confidence, uncovered } },
    claims: [{ cid, unit, severity, verifiedSeverity, title, claim, evidence, rung,
               verdict, verdictBy, reason, counter_quote, parity, producer, bump, blast,
               floor, mergedFrom }] } }
```
`outcome` ∈ `ok | ok-rerouted | ok-promoted | brief | unverified`. A data unit with
`n:1` whose derivations disagree (and no `fb` has repaired it yet) carries
`numbersConflict: { primary, rederived, fallback: null }` — both derivations are kept
for the master, and `numbersStatus` is `UNVERIFIED`.

When `started` is `false` the shape is one of: `{ reason: 'rails', errors, warnings,
card }`; `{ reason: 'dryRun', warnings, card }`; `{ reason: 'pause', warnings, card,
note }`; `{ reason: 'no-args' }` (no other fields — args was missing entirely).

## Cost tags

Every prompt ends with one line the ledger script keys on:
`⟦df:<unitId>:<attempt>⟧` (work), `⟦df:i:<unitId>:<n>⟧` (inspector),
`⟦df:v:<batch>:<n>⟧` (verifier), `⟦df:s:<round>:1⟧` (sweep), `⟦df:c:1:1⟧` (critic).
Keep the shared preamble first and the tag last so the prefix stays cacheable.

## Deep runs (two workflows)

1. `stage: 'work'` — work, sweep, dedup; no verification (every claim comes back
   `PENDING`), and `digest.invariants` is evaluated as usual from `reduce.invariants`.
   Read the digest (SKILL.md step 6).
2. `stage: 'verify'` — same args plus `claims` (from `results.claims`, edited if you
   re-weighted severities) and `carry: { committedUsd, rerouteUsd, invariants }` (money
   and invariants from the `work` stage's `digest`). This stage does **not** re-evaluate
   `reduce.invariants` — it reports back `carry.invariants` unchanged as its own
   `digest.invariants`, so pass the work-stage digest's `invariants` through in `carry`.
   Runs verification + the completeness critic; `pauseUsd` never pauses a `stage:
   'verify'` call.

A unit with `supersedes` is re-planned work, not a rescue: give it to the foreman in a
follow-up `stage: 'all'` call (fresh work + verify), carrying `carry: digest.money` from
the first run so the combined spend still checks against the shared ceiling. Rescuing
the verification of claims already produced — without re-running any unit — is a
separate `stage: 'verify'` call with those `claims`.

## Implement mode

The foreman does not edit files, and `kind: 'implement'` is only accepted with
`dryRun: true` (fanout prices and validates the card, it never runs it). For a real
implement run, write an inline Workflow script from `playbooks/implement.md`, using the
same card format and rails, and call
`workflow('dynamic-fanout:fanout', { ...args, kind: 'review', ... })` for the diff
review (one nesting level is allowed).
