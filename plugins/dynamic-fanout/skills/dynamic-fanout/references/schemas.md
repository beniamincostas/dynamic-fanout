# Schemas

The canonical JSON Schemas live in `workflows/fanout.js`; the foreman passes them to
`agent(…, {schema})`, so subagents are forced to return them. This page is the readable
version. Read it when you write a unit's `schema`, a brief that asks for specific
`numbers`, or the implement playbook's inline script.

## CARD: one per unit (master → foreman)

| Field | Required | Notes |
|---|---|---|
| `id` | yes | unique, short (`u1`, `ar`, `gu`) |
| `role` | no | free text, default = kind; cohort key = role + primary cell |
| `vec` | yes | `'D2 A1 T1 C1 V0 B2 G2'`: all seven features, each 0..2 |
| `n` | no | 1 = numbers must tie out (needs `rederive` in `check`) |
| `scope.files` | no | the files the unit must read; coverage is checked against `files_read` |
| `in` | no | estimated tokens read; default `ultra.inAvg` |
| `ctxTok` | no | when `ctx:'keep'`: tokens of this unit's CLAUDE.md chain (`scripts/claude-md-chain.mjs`); default `ultra.ctxTok` |
| `ctx` | no | `'omit'` (default) or `'keep'` |
| `p` | yes | `{model?, effort}`; model omitted = S; haiku takes no effort |
| `fb` | yes | `{model?, effort}` strictly stronger than `p`, or `null` |
| `rd` | no | n=1 only: the planned re-derivation cell (default = `p`) |
| `check` | yes | `+`-joined (see "`check` tokens" below) |
| `why` | yes | ≤140 chars naming the deciding feature |
| `supersedes` | no | id of the unit this one re-plans (`fb` must be null) |
| `brief` | yes | ≤120 words of pointers |
| `schema` | no | JSON Schema for the free `result` object |

### `check` tokens (`+`-joined)

| Token | What the foreman does with it |
|---|---|
| `quote` | adds an inspector call checking the unit's `{file, line, quote}` evidence |
| `rederive` | required whenever `n: 1` (numbers must tie out against a re-derivation) |
| `none` | parity-only; means parity is its own check |
| `V2` / `V3` / `V4` | sets a **floor** on this unit's claims: the verification rung is `max(verify.rungs[severity] + bump, floor)` — the token can only raise the rung, never lower it below what severity+bump would already give |
| `set`, `tests`, `tieout` | labels only — the foreman does not act on them; the master runs/checks them itself at close |

Every B2-vec unit also gets an inspector call, with or without `quote` in `check`.

## Priced card (foreman → master, in every result as `card`)

`{kind, depth, stage, S, W, refEffort, refSource, units[], verify, sweep, money, plannedAgents, calib, basis}`.
Each `units[]` row: `{id, role, vec, cell, fb, rd, ctx, check, why, parity, estUsd, turns, override}`.
`turns` is the unit's planned tool calls on its agent type (capped at that type's
`maxTurns`); the unit's prompt states the same number. `money` = `{U, P, R, C, ratio,
parityP, parityBound}`. `calib` = `{pm, scale, scaleByRole}`: the price model and the
exact factors these estimates were priced with, so `stats.mjs update --ledger` compares
that run's actual against what it actually used (`scaleByRole[role] × scale`). Pass back
`stats.mjs`'s `CALIB {"pm":…,"scaleByRole":…}` line verbatim as `args.calib`; learned
factors without the current `pm` are ignored with a warning.

## UNIT_RESULT: every work and sweep agent returns this

| Field | Type | Notes |
|---|---|---|
| `status` | `complete \| partial \| blocked` | required |
| `blocked_reason` | `no_access \| ambiguous_brief \| out_of_scope \| too_hard \| contradictory_evidence` | the first three are brief failures (no rerun); the last two are capability failures (→ `fb`) |
| `remaining` | string[] | with `partial`: what was not reached (→ one slice run) |
| `files_read` | string[] | required; every file actually opened |
| `summary` | string ≤300 | required |
| `findings` | ≤15 × `{title ≤160, trigger, impact, severity?, claim ≤300, evidence: ≤4 × {file, line ≥1, quote ≤160}}` | required (may be empty); trigger ∈ `normal edge misconfig theoretical`, impact ∈ `customer_money_legal wrong_outcome operational cosmetic`; severity (optional, ∈ `info low medium high blocker`) is stored as `filedSeverity` |
| `numbers` | `{name, value, method?}[]` | value is a decimal **string** (`"-1234.56"`); compared in integer cents |
| `confidence` | 0..1 | required; a sort key and one soft trigger, never a re-route on its own |
| `assumptions` | string[] | required; ≥3 counts as a soft signal |
| `result` | object | free; shaped by the card's `schema` (e.g. data units put `{script}` here) |

## INSPECT: inspector agent

`{ checks: [{ref, found: boolean, actual_line?}], unreadable?: string[] }`. Presence
only: the quote must appear (ignoring whitespace) within ±3 lines. Resolve rate <70 % is
a capability failure; <50 % selects `redo` mode.

## VERDICT: skeptic agent

`{ verdicts: [{cid, verdict, reason ≤300, trigger, impact, counter_quote?, support?, support_cmd? ≤200}] }` with
`verdict ∈ CONFIRMED | OVERSTATED | REFUTED | PLAUSIBLE | UNVERIFIABLE`. OVERSTATED (0.1.7) =
real, but the trigger or impact is filed too high: it needs support and a corrected
trigger/impact (else PLAUSIBLE) and counts as a real finding (`digest.counts.overstated`). An
OVERSTATED whose corrected pair does not rate the claim lower than filed becomes CONFIRMED
("confirmed at its filed severity; details corrected: …").
REFUTED is reserved for claims the evidence shows false: a REFUTED verdict without a
`counter_quote {file, line, quote}` is kept as PLAUSIBLE; a CONFIRMED or OVERSTATED verdict without the
skeptic's own `support {file, line, quote}` (a verbatim quote it found) or, for an absence
claim, `support_cmd` (the exact search that came back empty) is kept as PLAUSIBLE;
UNVERIFIABLE becomes UNVERIFIED. `trigger` and `impact` are **required** (since 0.1.7): the
skeptic's own pair; the severity derived from it is stored as the claim's `verifiedSeverity`.

### Calibrated severity (`SEVERITY_MATRIX`)

| impact \ trigger | normal | edge | misconfig | theoretical |
|---|---|---|---|---|
| customer_money_legal | blocker | high | medium | low |
| wrong_outcome | high | medium | low | low |
| operational | medium | low | low | info |
| cosmetic | low | info | info | info |

## UNIT_CRITIC: the per-unit outcome critic (0.1.7)

`{ coverage: 0..1, gaps: ≤6 × {area, why, material, evidence?}, overstated: [{fid, why}] }`.
`coverage` = share of the scope's real issues the findings cover. `material: true` on a gap,
or coverage < 0.75 on a recall-critical unit (V0 or B≥1), triggers the unit's one gap re-run;
`fid` names a finding (`f<n>`, its place in the unit's list) that is real but filed too high: it is verified one
rung higher, with `why` passed to the skeptic. A critic that returns nothing is listed in
`dropped`, never read as "no gaps".

## CRITIC: deep runs only

`{ missing: ≤8 × {what, why, suggestion?} }`, returned in `digest.critic` for the master.

## Claim (in `results.claims`)

`{cid, unit, severity, verifiedSeverity, filedSeverity, trigger, impact, verifiedTrigger, verifiedImpact, title, claim, evidence, rung, verdict, verdictBy,
reason, counter_quote, support, support_cmd, parity, producer:{model, effort}, bump, blast, floor, mergedFrom}`.
Evidence, `counter_quote` and `support` paths are canonicalized to the Scope spelling.
`node scripts/report.mjs <output.json>` prints them sorted by severity.
`severity` is derived by the foreman from the producer's `trigger` × `impact` (a finding
without a valid pair keeps its filed severity, else medium). `verifiedSeverity` is always set
on a verified claim: derived from the skeptic's own pair (a V4 panel keeps the highest any
lens gave), else `severity`. The rung is chosen from the derived `severity`; `digest.top`
ordering and `digest.counts.bySeverity` use `verifiedSeverity ?? severity`. Producers and
skeptics share one trigger and impact scale (`SEVERITY_RUBRIC` in fanout.js).
`floor` is the unit's own rung floor from a `V2`/`V3`/`V4` token in its `check` (-1 if
none); when merging duplicate claims the kept floor is the highest of the merged set.
`verdict ∈ CONFIRMED | OVERSTATED | PLAUSIBLE | REFUTED | UNVERIFIED | PENDING` (PENDING only after a
deep `stage:'work'`). Pass these back unchanged as `claims` for `stage:'verify'`.

## Implement mode (inline script)

The implementer's output shape is set by the schema your inline script passes; the
playbook uses `{status, blocked_reason?, files_changed[], tests: {cmd, failing[]},
summary}`. Keep the same failure classes: tests newly failing = capability (one `fb`
repair), `blocked` with a brief reason = back to the master.
