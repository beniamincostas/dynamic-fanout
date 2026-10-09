# Economics — price model, budget block, solo gate, calibration

The master supplies counts and sizes; the foreman (`workflows/fanout.js`) does the
arithmetic. Read this file when you fill `ultra`, size units, or a plan comes back
with a `money:` rail. The numbers below are **priors**: stage-0 calibration replaces
them through `args.calib`, and `fanout.js` `DEFAULT_CALIB` is the reference copy.
`baseCtx` is the one exception — it is no longer a prior, it was measured (see
Stage-0 calibration, row b).

## Price table

| Model | Input $/MTok | Output $/MTok | Effort |
|---|---|---|---|
| haiku (Haiku 4.5) | 1 | 5 | none |
| sonnet (Sonnet 5/5.5) | 2 | 10 | low…max |
| opus (Opus 5.5) | 4 | 20 | low…max |
| fable (Fable 5.1) | 10 | 50 | low…max |

Cache write = 1.25× the input price, cache read = 0.1× the input price.

| Constant | Prior | Meaning |
|---|---|---|
| `baseCtx` | 40000 | system prompt + tools + preamble every agent pays — **measured**, not a prior (2026-10-09 smoke run, see Stage-0 calibration row b) |
| `turns` | 12 | tool turns per agent |
| `outByEffort` | low 4000 · medium 8000 · high 14000 · xhigh 22000 · max 32000 | output tokens per agent |
| `haikuOut` | 3000 | haiku output (no effort) |
| `inspectorIn` | 12000 | tokens an inspector call reads |
| `verifierInFrac` | 0.5 | a verifier (and the critic) is priced at this share of `ultra.inAvg` — never the producer unit's `in` |

## The estimate

```
estUsd(cell, in, ctxTok) =
  [ (baseCtx + ctxTok + in)       * inPrice * cacheWrite
  + (baseCtx + ctxTok + in/2) * (turns - 1) * inPrice * cacheRead
  + outTok(cell) * outPrice ] / 1e6
```

- `in` = tokens the agent reads; `ctxTok` = CLAUDE.md tokens on its path (0 for `ctx:'omit'`).
- Turn 1 writes the whole prefix to cache; each later turn re-reads the prefix plus, on
  average, half the material.
- `outTok` = `outByEffort[effort]`, or `haikuOut` for haiku.

Why this shape: in practice the fixed prefix (`baseCtx + ctxTok`) is re-read
every turn, so **agent count and CLAUDE.md dominate; effort comes next; the model comes last**.
That is also why `baseCtx` moves every dollar figure below it: it is the one number no
unit, cell or effort choice can opt out of paying.

## Calibration card (baseCtx 40000, other constants priors, computed from the formula)

One agent reading `in` = 40k. Lean = `ctx:'omit'`. Ultracode-style = +30k CLAUDE.md at xhigh
on the same model. (`in` = 40k happens to equal the new `baseCtx` — they are unrelated
parameters: `in` is how much the agent reads, `baseCtx` is the fixed prefix it pays
regardless of what it reads.)

| Cell | Lean (`ctx:omit`) | Ultracode-style (+30k CLAUDE.md, xhigh) |
|---|---|---|
| haiku | $0.18 | — |
| sonnet·low | $0.37 | $0.69 |
| sonnet·medium | $0.41 | $0.69 |
| opus·medium | $0.82 | $1.39 |
| opus·high | $0.94 | $1.39 |
| opus·xhigh | $1.10 | $1.39 |
| fable·medium | $2.06 | $3.46 |
| fable·high | $2.36 | $3.46 |

Inspector call (sonnet·low, 12k, omit) ≈ $0.27.

Reproduce any cell: from the plugin root,
`node -e "const {loadCore}=await import('./tests/harness.mjs'); const c=loadCore(); const K=c.calibrate(); console.log(c.estUsd({model:'opus',effort:'high'}, 40000, 0, K))"`
(swap in `ctxTok=30000` and `effort:'xhigh'` for the ultracode-style column).

How to read the card:
- On an Opus session, the same model with CLAUDE.md dropped and effort at medium costs
  about 0.6× of ultracode's agent ($0.82 vs $1.39).
- A sonnet·medium unit costs a bit under a third of it ($0.41 vs $1.39).
- The 30k CLAUDE.md alone adds about $0.28 per opus agent — that delta does **not** move
  with `baseCtx` (it cancels out of the subtraction; only the extra context's per-turn
  re-read cost matters). That is why `ctx:'keep'` is reserved for parity and G2 units.

## Budget block: U, P, R, C

| | How it is formed | Who |
|---|---|---|
| **U** | `ultra.agents` × estUsd(S·E_ref, `inAvg`, `ctxTok`) + `ultra.verifiers` × estUsd(S·E_ref, `verifierInFrac`·`inAvg`, `ctxTok`) | master counts, foreman prices |
| **P** | Σ units (estUsd(p, in, ctx) + one inspector if `check` has `quote` or the unit is B2 + planned re-derivation `rd`) + `expected` × estUsd(V3, `inAvg`·`verifierInFrac`) + `rounds` × estUsd(sweepCell, `inAvg`) + (depth `deep`: 1 completeness critic on W·high at `inAvg`·`verifierInFrac`, which also counts toward `plannedAgents`/`maxAgents`) | foreman |
| **R** | Σ over units with `fb`: `rerouteRate` × estUsd(fb, in, ctx); floor = the largest single repair; cap = `reserveCapPct`·P; **the floor wins** over the cap; the largest B2 repair is earmarked | foreman |
| **C** | crew ceiling = 0.5·U; with `parityBound` up to 0.8·U; `--ceiling` sets `caps.ceilingUsd` | rail |

Verifier and sweep agents run `ctx:'omit'`. `rerouteRate` defaults to 0.1, or the
observed rate from routing stats once a role cohort has n≥4.

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
1. **Pack harder.** Merge same-subtree units, up to ~120k reading or 25 files per agent.
2. **Lower effort** on checkable non-parity units (a named V1/V2 check catches the miss).
3. **Move checkable units to sonnet** (A≤1, C≤1, G≤1 only).
4. **Narrow verification** to the top-K claims; the rest are listed as UNVERIFIED `topK`.
5. **Go solo.**

A cheaper lever that sits alongside 1–3: a fallback only has to be **strictly
stronger** than the primary, not the strongest model available. Dropping a B2 unit's
`fb` from, say, opus·high to sonnet·high (same model, higher effort) still buys a real
second opinion and can be the difference that makes R fit, at `baseCtx` 40000 where a
cross-model `fb` costs more than it used to (see envelope 2 below).

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

## Stage-0 calibration

Three tiny headless runs (`claude -p --output-format json`) measure the inputs to the
formula. Record each number with its date and the Claude Code version.

| Measure | How | Replaces |
|---|---|---|
| a. Does `modelUsage` include subagents and workflow agents? | compare `modelUsage` totals with the journal's agent count | decides whether eval actuals are trustworthy |
| b. Fixed cost per agent, with and without `omitClaudeMd` | one trivial agent per mode, in a heavy subtree; check that nested CLAUDE.md files are dropped too | `baseCtx` — **measured** 2026-10-09, see below; the real `ctxTok` per path |
| c. Output tokens per effort | the same small unit at low / medium / high / xhigh | `outByEffort`, `haikuOut` |
| d. Cache reads: same-cell vs mixed-cell stage | 3 agents on one cell vs 3 on mixed cells | `cacheRead` share; whether ">2 cells per stage" becomes a rail |
| e. What `${CLAUDE_EFFORT}` reports under `effort: max` | typed and auto-triggered invocation; also a `PreToolUse(Skill)` hook | the E_ref capture (else E_ref stays `--ref-effort` or xhigh) |
| f. Master share at `max` vs `xhigh` | the same plan turn at each effort | the SKILL.md effort (drop to xhigh if max adds >30% output with no gain) |

**Row b, measured 2026-10-09 (smoke run, MCP-heavy setup):** a crew agent's fixed prefix
(system prompt + tool definitions) came in at 35–70k tokens — `baseCtx` is set to
**40000**, inside that range. Six tiny Sonnet agents cost $1.28 actual vs $0.95 estimated
at the old `baseCtx` 15000 (the estimate was low by 35%). The same unit run with
CLAUDE.md kept cost $0.34 vs $0.24 omitted (+43%; +28k tokens written). Caveat: those two
agents also differed in agent type (Explore vs general-purpose), so that CLAUDE.md delta
is not isolated from the agent-type confound — treat it as directional, not a clean A/B.
`baseCtx` remains tunable via `calib.baseCtx`: re-measure outside an MCP-heavy setup (the
low end of the 35–70k range) if a session's actuals come in consistently under estimate.

Also measure `turns`, `inspectorIn` and `verifierInFrac` from the journal of these runs.

Pass the measured numbers as `args.calib`. Every key is optional; missing keys keep the prior:

```js
calib: {
  prices: { haiku: {in:1, out:5}, sonnet: {in:2, out:10}, opus: {in:4, out:20}, fable: {in:10, out:50} },  // {in, out} $/MTok
  cacheWrite: 1.25, cacheRead: 0.1,
  baseCtx: 40000, turns: 12,
  outByEffort: { low: 4000, medium: 8000, high: 14000, xhigh: 22000, max: 32000 },
  haikuOut: 3000, inspectorIn: 12000, verifierInFrac: 0.5
}
```

After the evals, if U falls outside 1.5× of the ultracode arm's actual cost, or P+R
outside 1.5× of the crew's actual, tighten `ceilingMult` to 0.4 until the priors are fixed.

## Worked envelopes (Opus session, E_ref = xhigh, baseCtx 40000 measured, other calib priors)

### 1. Review: 6 units on a payments package

Ultracode basis: 8 agents (5 file clusters + 3 dimensions), 4 verifiers (≈12 findings ÷ 3),
`ctxTok` 30k, `inAvg` 40k → U = 8 × $1.39 + 4 × $1.24 ≈ **$16.06**. C = 0.5·U = **$8.03**.

The first-cut plan (6 units: u2/u3 on opus·medium, u4 and u5 separate, `verify.expected`
left at the depth default 3) no longer fits at `baseCtx` 40000: P $8.25 + R $0.94 =
**$9.20 > C $8.03** — the same plan that fit comfortably at `baseCtx` 15000 now runs
0.57·U. Pack harder and move two checkable units to sonnet:

| Unit | Cell (p → fb) | in · ctx | estUsd | repair (fb) |
|---|---|---|---|---|
| u1 money path, parity | opus·xhigh → null | 38k · keep 30k | $1.37 | — |
| u2 override logic | sonnet·medium → opus·high | 40k · omit | $0.41 | $0.94 |
| u3 state machine | sonnet·medium → opus·high | 30k · omit | $0.38 | $0.87 |
| u4 rendering + payload (merged u4+u5) | sonnet·medium → opus·high | 50k · omit | $0.45 | $1.02 |
| u6 option-set consistency | sonnet·low → sonnet·medium | 15k · omit | $0.28 | $0.32 |

- Work $2.89 + 4 inspectors $1.08 + verification $1.60 (`verify.expected: 2`, down from
  the depth default 3 — the foreman prices every expected verifier on V3 opus·high at
  20k) + 1 sweep opus·medium at inAvg 40k $0.82 → **P = $6.40**.
- R: Σ 0.1 × repairs = $0.32, cap 0.2·P = $1.28, floor = the largest repair $1.02 → **R = $1.02**.
- P + R = **$7.41 ≤ C $8.03** (0.46·U). Plus the master's ≈0.1·U, about 0.56× ultracode.

Three levers did the work: merging u4+u5 pays the fixed prefix once instead of twice;
moving u2/u3's primary off opus cuts the biggest two line items; narrowing
`verify.expected` to 2 closes what was left. Packing u2/u3 any further would blur the
override-logic and state-machine checks into one unit, so the plan stops there.

### 2. Data audit: ERP invoice/credit-note export for one month

Ultracode basis: 5 agents (invoice rows, credit-note rows, totals, tax formula, period/duplicates),
2 verifiers, `ctxTok` 23k, `inAvg` 30k → U = 5 × $1.25 + 2 × $1.14 ≈ **$8.52**. C = **$4.26**.

First plan: 4 units. Invoices and credit notes are separate sonnet·medium units (n=1, each with a
sonnet·medium re-derivation); then the tax formula at opus·high `keep`; then
period/duplicates at sonnet·low. At `baseCtx` 40000 this prices to P $5.20 + R $0.87 =
**$6.07 > C $4.26** — rejected harder than it was at `baseCtx` 15000, because the two
separate invoice/credit-note units each pay the fixed prefix on their own.

Fix by step 1, pack harder. Invoices + credit notes become one unit — but at `baseCtx` 40000 the first
packed cut still misses: with `fb` left at opus·high on the merged unit, R is $1.09 and
P + R = $4.71 > C $4.26. The fallback only has to be *stronger* than the sonnet·medium
primary, not the strongest model on the roster, so drop it one notch to sonnet·high:

| Unit | Cell (p → fb) | in · ctx | estUsd | repair (fb) |
|---|---|---|---|---|
| u1 invoices+credit-notes rows, totals by tax_code, n=1 | sonnet·medium → sonnet·high; rd sonnet·medium | 60k · omit | $0.48 + rd $0.48 | $0.54 (B2, earmarked) |
| u2 tax formula vs the tax-rules reference | opus·high → null | 25k · keep 23k | $1.05 | — |
| u3 out-of-period, duplicate doc_no, negatives | sonnet·low → sonnet·medium | 20k · omit | $0.30 | $0.34 |

- Work $1.84 + re-derivation $0.48 + 2 inspectors $0.54 + 1 V3 opus·high at 15k
  $0.76 → **P = $3.63**, with `verify.expected: 1` (the default 2 would price
  $4.39 and the plan would be rejected: P+R $4.93 > C $4.26).
- R: Σ 0.1 × repairs = $0.09, cap $0.73, floor $0.54 → **R = $0.54**.
- P + R = **$4.17 ≤ C $4.26** (0.49·U).
- The tax reading stays a separate W unit, because a tie-out proves arithmetic, not semantics.
- The merged unit's `fb` no longer needs to jump models: sonnet·high is already strictly
  stronger than the sonnet·medium primary, and that's enough reserve headroom without
  paying opus's price for it.
