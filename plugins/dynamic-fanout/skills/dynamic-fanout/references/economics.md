# Economics — price model, budget block, solo gate, calibration

The master supplies counts and sizes; the foreman (`workflows/fanout.js`) does the
arithmetic. Read this file when you fill `ultra`, size units, or a plan comes back
with a `money:` rail. `fanout.js` `DEFAULT_CALIB` is the reference copy of every
constant below; `args.calib` overrides any of them, and `calib.scale` is the one the
plugin tunes itself (see Self-calibration).

## Price table

| Model | Input $/MTok | Output $/MTok | Effort |
|---|---|---|---|
| haiku (Haiku 4.5) | 1 | 5 | none |
| sonnet (Sonnet 5/5.5) | 2 | 10 | low…max |
| opus (Opus 5.5) | 4 | 20 | low…max |
| fable (Fable 5.1) | 10 | 50 | low…max |

Cache write = 1.25× the input price, cache read = 0.1× the input price.

## What 0.1.0 got wrong (measured on 119 agents)

The first real run (a large review of an LLM ticket bot, then 5 implementation themes)
cost about **$376**. The review crew alone cost **$58.58 against a $20.62 estimate**,
because agents ran **unbounded**:
- 28–65 turns each, where 0.1.0 priced a flat 12;
- context grew to **2.4–5.6×** the planned reading (whole files, wandering);
- CLAUDE.md-kept agents started at ~85k tokens and re-read it on every turn;
- the output-token kill switch then cut verification: a quality loss with no saving,
  since the work it was meant to stop had already been paid for;
- routing collapsed to opus·high/xhigh, so every `fb` was null;
- implementation had no envelope (~$226 over 9 launches), and the master's own ~$78 was
  mostly long-context re-reads in one 27-hour session.

Measured fits from those 119 agents: allowlisted crew agents start at **~6–8k** tokens,
full-tool agents at **~15k** before CLAUDE.md; unbounded turns ≈ **10 + in/2.5k** at high
effort; output ≈ **1.5k tokens per turn** at high. 0.1.1 prices those facts and bounds the
agents: every crew agent type has a hard turn cap, and its prompt carries a turn budget.

## The estimate (turn-aware)

```
turns  = min(cap, round((turnsBase + in/tokPerTurn) × effortTurns[effort]))
prefix = (lean ? baseCtxLean : baseCtx) + ctxTok          // ctxTok only when CLAUDE.md is kept
estUsd = [ (prefix + g·in)        × inPrice × cacheWrite   // everything written to cache once
         + turns × (prefix + g·in/2) × inPrice × cacheRead  // each turn re-reads the context so far
         + turns × outPerTurn[effort] × outPrice ] / 1e6 × scale
```

| Constant | Value | Meaning |
|---|---|---|
| `baseCtxLean` | 8000 | fixed prefix of the allowlisted types: `worker`, `skeptic`, `inspector` |
| `baseCtx` | 15000 | fixed prefix of full-tool types: `worker-mcp`, `worker-ctx`, `implementer` (+ `ctxTok` when CLAUDE.md is kept) |
| `turnsBase`, `tokPerTurn` | 10, 2500 | turns ≈ 10 + in/2.5k at high effort |
| `effortTurns` | low 0.6 · medium 0.8 · high 1 · xhigh 1.3 · max 1.6 (haiku 0.6) | effort multiplies turns |
| `outPerTurn` | low 600 · medium 1000 · high 1500 · xhigh 1800 · max 2200; haiku 500 | output tokens per turn |
| `readFactor` (g) | 3 | crew context grows to prefix + 3·in (targeted reads, some re-reads) |
| `caps` | worker 30 · workerMcp 35 · workerCtx 30 · implementer 60 · skeptic 12 · inspector 6 | = each agent file's `maxTurns`; the price uses the same cap |
| `inspectorIn` | 12000 | tokens an inspector call reads |
| `verifierInFrac` | 0.5 | a verifier (and the critic) is priced at this share of `ultra.inAvg` |
| `ultraReadFactor`, `ultraTurnCap` | 4, 80 | how U's agents are priced (below) |
| `scale` | 1 | self-calibration multiplier on every estimate |

- `in` = tokens the agent is planned to read; `ctxTok` = CLAUDE.md tokens on its path
  (0 for `ctx:'omit'`).
- The agent type comes from the card (`typeKey`): `implement` role → implementer;
  `ctx:'keep'` → worker-ctx; vector T2 → worker-mcp; else worker.
- **U is priced the way ultracode actually behaves:** S·E_ref, full prefix + `ctxTok`,
  `readFactor` 4, turn cap 80 (no real cap). The crew ceiling 0.5·U therefore compares
  bounded crew agents with unbounded ultracode agents, like with like.

Why this shape: an agent's cost is its context re-read on every turn, so **turns ×
context dominate; agent count and CLAUDE.md come next; the model comes last**. Capping
turns and keeping the prefix lean are the two biggest levers the plan controls.

## Calibration card (computed from the formula, `in` = 40k)

| Cell | turns | Lean `worker` | `worker-ctx`, +30k CLAUDE.md | Ultracode-style (xhigh, +30k, unbounded) |
|---|---|---|---|---|
| haiku | 16 | $0.31 | — | — |
| sonnet·low | 16 | $0.63 | — | $1.97 |
| sonnet·medium | 21 | $0.82 | $1.06 | $1.97 |
| sonnet·high | 26 | $1.06 | $1.35 | $1.97 |
| opus·medium | 21 | $1.63 | $2.13 | $3.95 |
| opus·high | 26 | $2.13 | $2.70 | $3.95 |
| opus·xhigh | 30 (cap) | $2.54 | $3.17 | $3.95 (34 turns) |
| fable·medium | 21 | $4.08 | $5.32 | $9.87 |
| fable·high | 26 | $5.32 | $6.74 | $9.87 |

Inspector (sonnet·low, 12k, 6 turns) ≈ $0.18. V3 skeptic (opus·high, 20k, 12 turns) ≈ $0.88;
the ultracode-style verifier at the same reading ≈ $2.24.

Reproduce any cell: from the plugin root,
`node -e "const {loadCore}=await import('./tests/harness.mjs'); const c=loadCore(); const K=c.calibrate(); console.log(c.estUsd({model:'opus',effort:'high'}, 40000, 0, K, c.agentOpts('worker', K)))"`
(for the ultracode column: `ctxTok` 30000, `effort:'xhigh'`, options `{lean:false, cap:80, readFactor:4}`).

How to read the card:
- On an Opus session, a lean opus·medium unit costs about 0.4× ultracode's agent ($1.63 vs
  $3.95); sonnet·medium about 0.2×.
- Keeping 30k of CLAUDE.md (on the 15k full-tool prefix) adds $0.5–0.65 per opus agent,
  about as much as the effort step from medium to high. That is why `ctx:'keep'` is reserved for G2 units, and parity uses a
  capsule with pointers.
- At the cap, effort stops adding turns (opus·xhigh is capped at 30): a unit that plans
  its turns at the cap is too big; split it.

## Re-pricing the real review

The first run's exact review cards, re-priced with 0.1.1: **U $119.38**, **P $44.08**
(agents capped), against **$58.58** actually spent by the unbounded 0.1.0 crew and the
$20.62 that 0.1.0 had estimated. Those cards were routed the 0.1.0 way (subsystem split,
"high" on deployed code); following the new routing rules (`routing.md` §3 and §5) lowers
P further.

## Budget block: U, P, R, C

| | How it is formed | Who |
|---|---|---|
| **U** | `ultra.agents` × estUsd(S·E_ref, `inAvg`, `ctxTok`) + `ultra.verifiers` × estUsd(S·E_ref, `verifierInFrac`·`inAvg`, `ctxTok`), all on the unbounded ultracode options (full prefix, g 4, cap 80) | master counts, foreman prices |
| **P** | Σ units (estUsd(p, in, ctx) on the unit's agent type + one inspector if `check` has `quote` or the unit is B2 + planned re-derivation `rd`) + `expected` × V3 skeptic at `inAvg`·`verifierInFrac` + `rounds` × sweep worker at `inAvg` + (depth `deep`: 1 completeness critic on W·high at `inAvg`·`verifierInFrac`, which also counts toward `plannedAgents`/`maxAgents`) | foreman |
| **R** | Σ over units with `fb`: `rerouteRate` × estUsd(fb, in, ctx); floor = the largest single repair; cap = `reserveCapPct`·P; **the floor wins** over the cap; the largest B2 repair is earmarked | foreman |
| **C** | crew ceiling = 0.5·U; with `parityBound` up to 0.8·U; `--ceiling` sets `caps.ceilingUsd` | rail |

Verifier, sweep and critic agents run `ctx:'omit'` on the lean prefix. `rerouteRate`
defaults to 0.1, or the observed rate from routing stats once a role cohort has n≥4.

### The verification reserve

The planned verification spend (`expected` × V3 skeptic, `verifyUsd` on the card) is held
**out of the work pool**: `workPool = C − R − verifyUsd`. At run time, verifier batches
draw from that reserve first and only then from the work pool. The output-token kill
switch (output > 75 % of `maxOutputTokens`) stops **new work** only (units, inspectors,
sweeps, the critic) and never cuts planned verification: by the time claims exist, the
work that produced them is paid for, and dropping their checks saves nothing and costs
quality. In 0.1.0 the kill switch fired late in the review and cut exactly that.

### Counting U, the ultracode-equivalent (master, from scouting)

Count what ultracode would actually spawn, not what you plan to:
- **`ultra.agents`**: one per independent question, dimension or file cluster that
  ultracode would hand to its own agent. Do not apply your own packing here.
- **`ultra.verifiers`**: about one per 3 expected findings.
- **`ultra.ctxTok`**: CLAUDE.md tokens on the path (root + every nested CLAUDE.md the
  agents would read under). Measure with `wc -c <files> | tail -1` and divide by 4.
- **`ultra.inAvg`**: average tokens an ultracode agent would read (`wc -c` of its files ÷ 4).
- **`ultra.basis`**: one line, for example `8 = 5 file clusters + 3 dimensions; 4 verifiers ≈ 12 findings/3`.

The card prints U with its basis, so the user can challenge the count.

### Master share

The master's own plan + synthesis is about 0.1·U, so the total is about 0.6·U. With
`parityBound` the crew may reach 0.8·U and the total stays under 0.9·U. A user
`--ceiling` or `--route` past 0.9·U gets a card warning that the run may cost about as
much as ultracode.

### When P + R > C (a `money:` rail)

The master fixes the plan; code never downgrades a card. Apply in order and stop as
soon as the plan fits:
1. **Pack harder.** Merge same-subtree units while planned turns stay under the agent's
   cap (on a worker: below ~50k reading at high, ~65k at medium, ~95k at low, ~30k at
   xhigh; or 25 files).
2. **Lower effort** on checkable non-parity units (a named V1/V2 check catches the miss).
3. **Move checkable units to sonnet** (A≤1, C≤1, G≤1 only).
4. **Narrow verification** to the top-K claims; the rest are listed as UNVERIFIED `topK`.
5. **Go solo.**

A cheaper lever that sits alongside 1–3: a fallback only has to be **strictly
stronger** than the primary, not the strongest model available. Dropping a unit's `fb`
from opus·high to sonnet·high (same model, higher effort) still buys a real second
opinion and shrinks R's floor, which is the largest single repair.

**Never downgrade a parity unit to fit.** If the parity units alone exceed 0.5·U after
packing, set `caps.parityBound: true`. That lifts C to at most 0.8·U, and the card and
ledger say *parity-bound*. Setting it without a parity overflow is itself a `money:` rail.

## Solo gate (price-aware)

Do the task yourself, with no fan-out, when **any** of these hold:

| Condition | Why |
|---|---|
| Reading volume ≤ 80k on a Sonnet master, ≤ 40k on Opus, ≤ 15k on Fable | below this, a crew's fixed prefixes cost more than the master reading the material itself |
| One dependent reasoning chain | parallel agents cannot split it |
| ≥50% of the material is already in your context | a crew would pay to re-read it |
| Packing yields 1 unit | one agent = ultracode's shape at a lower tier, with no parallelism gain (a Fable master may still hand a ≥15k read to one cheaper reader) |
| U < 3× your own plan + synthesis overhead | the crew's savings cannot pay for the orchestration |

The routing-stats *Envelope* rule (last run of this kind above 0.6·U actual) multiplies
these thresholds by 1.5 for that kind, and the card notes it.

## Self-calibration (`calib.scale`)

`scale` multiplies every estimate. The plugin learns it from its own runs:
1. At close, `ledger-cost.mjs <transcript-dir> --json` writes the actual dollars, and
   `stats.mjs update … --ledger <that file>` takes actual ÷ estimated (the run's
   `committedUsd + rerouteUsd`), clamps it to [0.3, 5] so one odd run cannot swing it,
   and folds it into `stats.calib.scale` as an exponentially weighted average (α 0.5; the
   first observation sets it outright).
2. `stats.mjs --summary <kind>` prints `CALIB {"scale":X.XX}` whenever a scale exists;
   the master passes that object as `args.calib` on the next run.

`scale` moves U, P, R and C together, so it does not change whether a plan fits the
ceiling. It corrects the absolute dollars: the card, the `pauseUsd` stop, the ledger's
committed-vs-actual line and a user `--ceiling`. If actuals drift far from estimates
because agents read more than planned, fix the briefs and packing first; `scale` absorbs
what remains.

## Stage-0 calibration

Tiny headless runs (`claude -p --output-format json`) can re-measure any constant above;
record each number with its date and the Claude Code version, and pass it as `args.calib`.

| Measure | How | Replaces |
|---|---|---|
| a. Does `modelUsage` include subagents and workflow agents? | compare `modelUsage` totals with the journal's agent count | decides whether eval actuals are trustworthy |
| b. Fixed prefix per agent type, with and without `omitClaudeMd` | one trivial agent per type in a heavy subtree | `baseCtxLean`, `baseCtx`, the real `ctxTok` per path |
| c. Turns and output per effort | the same small unit at low / medium / high / xhigh | `effortTurns`, `outPerTurn`, `turnsBase`, `tokPerTurn` |
| d. Context growth | final context ÷ (prefix + planned `in`) from the journal | `readFactor` |
| e. Cache reads: same-cell vs mixed-cell stage | 3 agents on one cell vs 3 on mixed cells | `cacheRead` share; whether ">2 cells per stage" becomes a rail |
| f. Master share at `max` vs `xhigh` | the same plan turn at each effort | the SKILL.md effort |

The 0.1.1 defaults come from 119 agents of one real run (see "What 0.1.0 got wrong").
Every key is optional; missing keys keep the default:

```js
calib: {
  prices: { haiku: {in:1, out:5}, sonnet: {in:2, out:10}, opus: {in:4, out:20}, fable: {in:10, out:50} },
  cacheWrite: 1.25, cacheRead: 0.1,
  baseCtxLean: 8000, baseCtx: 15000, turnsBase: 10, tokPerTurn: 2500,
  effortTurns: { low: 0.6, medium: 0.8, high: 1, xhigh: 1.3, max: 1.6 },
  outPerTurn: { low: 600, medium: 1000, high: 1500, xhigh: 1800, max: 2200 }, haikuOutPerTurn: 500,
  readFactor: 3, ultraReadFactor: 4, ultraTurnCap: 80,
  caps: { worker: 30, workerMcp: 35, workerCtx: 30, implementer: 60, skeptic: 12, inspector: 6 },
  inspectorIn: 12000, verifierInFrac: 0.5, scale: 1
}
```

`caps` in `calib` change the **price** only; the real turn limit is each agent file's
`maxTurns`, so keep the two in step.

## Worked envelopes (Opus session, E_ref = xhigh, 0.1.1 defaults)

### 1. Review: 5 units on a payments package

Ultracode basis: 8 agents (5 file clusters + 3 dimensions), 4 verifiers (≈12 findings ÷ 3),
`ctxTok` 30k, `inAvg` 40k → U = 8 × $3.95 + 4 × $2.24 ≈ **$40.53**. C = 0.5·U = **$20.27**.

| Unit | Cell (p → fb) | in · ctx · turns | estUsd (with inspector) | repair (fb) |
|---|---|---|---|---|
| u1 money path, parity | opus·xhigh → null | 38k · omit + capsule · 30 | $2.65 | — |
| u2 override logic | sonnet·medium → opus·high | 40k · omit · 21 | $0.99 | $2.13 |
| u3 state machine | sonnet·medium → opus·high | 30k · omit · 18 | $0.79 | $1.62 |
| u4 rendering + payload | sonnet·medium → opus·high | 50k · omit · 24 | $1.21 | $2.69 |
| u6 option-set consistency | sonnet·low → sonnet·medium | 15k · omit · 10 | $0.25 | $0.34 |

- Work + inspectors $5.90 + verification $1.76 (`verify.expected: 2`, opus·high skeptics at
  20k) + 1 sweep opus·medium at 40k $1.63 → **P = $9.29**.
- R: Σ 0.1 × repairs = $0.88, cap 0.2·P = $1.86, floor = the largest repair $2.69 → **R = $2.69**.
- P + R = **$11.98 ≤ C $20.27** (0.30·U); the work pool is C − R − $1.76 = $15.82.
- Had u1 kept 30k of CLAUDE.md (`worker-ctx`), it alone would rise from $2.65 to $3.28.
- The foreman warns `cache:` (3 cells); merging u6 up into sonnet·medium removes it.

### 2. Data audit: billing export, invoices + credit notes for one month

Ultracode basis: 5 agents (invoice rows, credit-note rows, totals, tax formula,
period/duplicates), 2 verifiers, `ctxTok` 23k, `inAvg` 30k → **U = $18.49**, C = **$9.24**.

| Unit | Cell (p → fb) | in · ctx · turns | estUsd | repair (fb) |
|---|---|---|---|---|
| u1 invoices + credit-note rows, totals by tax_code, n=1 | sonnet·medium → sonnet·high; rd sonnet·medium | 60k · omit · 27 | $1.27 + rd $1.27 + inspector | $1.51 (B2, earmarked) |
| u2 tax formula vs the tax-rules reference | opus·high → null | 25k · keep 23k · 20 | $1.77 + inspector | — |
| u3 out-of-period, duplicate doc_no, negatives | sonnet·low → sonnet·medium | 20k · omit · 11 | $0.32 | $0.42 |

- Work $3.36 + re-derivation $1.27 + 2 inspectors $0.35 + 1 V3 skeptic $0.77
  (`verify.expected: 1`) → **P = $5.75** (data runs have no sweep).
- R: floor = the largest repair, u1's $1.51 → **R = $1.51**. P + R = **$7.26 ≤ C $9.24** (0.39·U).
- u1 plans 27 of its 30 turns: at the edge. Any more reading and it should be split into
  invoices and credit notes.
- The tax reading stays a separate W unit with CLAUDE.md kept (G2), because a tie-out
  proves arithmetic, not semantics.
