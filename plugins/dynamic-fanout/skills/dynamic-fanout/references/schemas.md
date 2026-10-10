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
| `ctxTok` | no | CLAUDE.md tokens on this unit's path (when `ctx:'keep'`) |
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

`{kind, depth, stage, S, W, refEffort, refSource, units[], verify, sweep, money, plannedAgents, basis}`.
Each `units[]` row: `{id, role, vec, cell, fb, rd, ctx, check, why, parity, estUsd, turns, override}`.
`turns` is the unit's planned tool calls on its agent type (capped at that type's
`maxTurns`); the unit's prompt states the same number. `money` = `{U, P, R, C, ratio,
parityP, parityBound}`.

## UNIT_RESULT: every work and sweep agent returns this

| Field | Type | Notes |
|---|---|---|
| `status` | `complete \| partial \| blocked` | required |
| `blocked_reason` | `no_access \| ambiguous_brief \| out_of_scope \| too_hard \| contradictory_evidence` | the first three are brief failures (no rerun); the last two are capability failures (→ `fb`) |
| `remaining` | string[] | with `partial`: what was not reached (→ one slice run) |
| `files_read` | string[] | required; every file actually opened |
| `summary` | string ≤300 | required |
| `findings` | ≤8 × `{title ≤160, severity, claim ≤300, evidence: ≤4 × {file, line ≥1, quote ≤160}}` | required (may be empty); severity ∈ `info low medium high blocker` |
| `numbers` | `{name, value, method?}[]` | value is a decimal **string** (`"-1234.56"`); compared in integer cents |
| `confidence` | 0..1 | required; a sort key and one soft trigger, never a re-route on its own |
| `assumptions` | string[] | required; ≥3 counts as a soft signal |
| `result` | object | free; shaped by the card's `schema` (e.g. data units put `{script}` here) |

## INSPECT: inspector agent

`{ checks: [{ref, found: boolean, actual_line?}], unreadable?: string[] }`. Presence
only: the quote must appear (ignoring whitespace) within ±3 lines. Resolve rate <70 % is
a capability failure; <50 % selects `redo` mode.

## VERDICT: skeptic agent

`{ verdicts: [{cid, verdict, reason ≤300, severity?, counter_quote?}] }` with
`verdict ∈ CONFIRMED | REFUTED | PLAUSIBLE | UNVERIFIABLE`. A REFUTED verdict without a
`counter_quote {file, line, quote}` is kept as PLAUSIBLE; UNVERIFIABLE becomes UNVERIFIED.

## CRITIC: deep runs only

`{ missing: ≤8 × {what, why, suggestion?} }`, returned in `digest.critic` for the master.

## Claim (in `results.claims`)

`{cid, unit, severity, verifiedSeverity, title, claim, evidence, rung, verdict, verdictBy,
reason, counter_quote, parity, producer:{model, effort}, bump, blast, floor, mergedFrom}`.
`floor` is the unit's own rung floor from a `V2`/`V3`/`V4` token in its `check` (-1 if
none); when merging duplicate claims the kept floor is the highest of the merged set.
`verdict ∈ CONFIRMED | PLAUSIBLE | REFUTED | UNVERIFIED | PENDING` (PENDING only after a
deep `stage:'work'`). Pass these back unchanged as `claims` for `stage:'verify'`.

## Implement mode (inline script)

The implementer's output shape is set by the schema your inline script passes; the
playbook uses `{status, blocked_reason?, files_changed[], tests: {cmd, failing[]},
summary}`. Keep the same failure classes: tests newly failing = capability (one `fb`
repair), `blocked` with a brief reason = back to the master.
