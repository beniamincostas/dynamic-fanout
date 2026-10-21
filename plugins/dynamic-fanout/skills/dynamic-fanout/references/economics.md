# Economics — price model, budget block, solo gate, calibration

The master supplies counts and sizes; the foreman (`workflows/fanout.js`) does the
arithmetic. Read this file when you fill `ultra`, size units, or a plan comes back
with a `money:` rail. `fanout.js` `DEFAULT_CALIB` is the reference copy of every
constant below; `args.calib` overrides any of them, and `calib.scaleByRole` is the one the
plugin tunes itself, keyed by price model (see Self-calibration). The current price model
is **3** (`PRICE_MODEL` in `fanout.js`, since 0.1.4).

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
         + turns × outPerTurn[effort] × outPrice ] / 1e6 × scaleByRole[role] × scale
```

| Constant | Value | Meaning |
|---|---|---|
| `baseCtxLean` | 11000 | fixed prefix of the allowlisted types: `worker`, `skeptic`, `inspector` (7–12.5k at start, ~3–4k of tool/instruction attachments arrive on turn 2) |
| `baseCtx` | 15000 | fixed prefix of full-tool types: `worker-mcp`, `worker-ctx`, `implementer` (+ `ctxTok` when CLAUDE.md is kept) |
| `turnsBase`, `tokPerTurn` | 10, 2500 | turns ≈ 10 + in/2.5k at high effort |
| `effortTurns` | low 0.6 · medium 0.8 · high 1 · xhigh 1.3 · max 1.6 (haiku 0.6) | effort multiplies turns |
| `outPerTurn` | low 600 · medium 1000 · high 1500 · xhigh 1800 · max 2200; haiku 500 | output tokens per turn |
| `readFactor` | 1 | g: crew context grows to prefix + g·in. Was 4 (0.1.2–0.1.3); that 4–5× growth was mostly the nested CLAUDE.md that Read attached, gone for lean agents in price model 3 |
| `caps` | worker 30 · workerMcp 35 · workerCtx 30 · implementer 60 · skeptic 12 · inspector 6 | = each agent file's `maxTurns`; the price uses the same cap |
| `inspectorIn` | 12000 | tokens an inspector call reads |
| `verifierInFrac` | 0.25 | a verifier (and the critic) is priced at this share of `ultra.inAvg`; skeptics reading through Bash measured 4–10k tokens |
| `sweepInFrac` | 0.25 | a gap-sweep round is priced at this share of `ultra.inAvg` (it re-reads a slice of scope, not a unit's whole reading) |
| `ultraReadFactor`, `ultraTurnCap` | 4, 80 | how U's agents are priced (below) |
| `scaleByRole` | `{work: 1.0, verify: 0.3, inspect: 0.3, sweep: 2.0, implement: 3.5}` | per-role prior at or above the fit learned under price model 3 over 9 runs (work 0.6→1.04→0.81, verify 0.27–0.30, inspect 0.30–0.39, sweep 0.79→3.82, noisy); `implement` (since 0.1.5): implementers keep CLAUDE.md, run test suites and take many turns, and priced as `work` they came out ~3.5× low |
| `scale` | 1 | global multiplier on top of `scaleByRole`; honoured only from the current price model, neutral otherwise |

- `in` = tokens the agent is planned to read; `ctxTok` = CLAUDE.md tokens on its path
  (0 for `ctx:'omit'`).
- The agent type comes from the card (`typeKey`): `implement` role → implementer;
  `ctx:'keep'` → worker-ctx; vector T2 → worker-mcp; else worker. Its **role** —
  `implement` (implementer), `work` (worker/workerMcp/workerCtx), `verify` (skeptic) or `inspect`
  (inspector) — is fixed per type (`ROLE_OF`) and selects which `scaleByRole` entry
  applies; `estUsd`'s `o.role` carries it through. The gap sweep runs on a worker but is
  priced and calibrated as its own role, `sweep` (`agentOpts('worker', K, 'sweep')`).
- `ctxTok` for a `ctx:'keep'` unit is its own measured chain (`scripts/claude-md-chain.mjs
  <session-cwd> <paths>`); without a per-unit `ctxTok` it falls back to `ultra.ctxTok`.
- **U is priced the way ultracode actually behaves:** S·E_ref, full prefix + `ctxTok`,
  `ultraReadFactor` 4 (ultracode's agents use Read, so they do get the nested CLAUDE.md),
  turn cap 80 (no real cap), role `work`. The crew ceiling 0.5·U
  therefore compares bounded crew agents with unbounded ultracode agents, like with like.

Why this shape: an agent's cost is its context re-read on every turn, so **turns ×
context dominate; agent count and CLAUDE.md come next; the model comes last**. Capping
turns and keeping the prefix lean are the two biggest levers the plan controls.

## Calibration card (price model 3, computed from the formula, `in` = 40k)

| Cell | turns | Lean `worker` | `worker-ctx`, +30k CLAUDE.md | Ultracode-style (xhigh, +30k, unbounded) |
|---|---|---|---|---|
| haiku | 16 | $0.09 | $0.15 | — |
| sonnet·low | 16 | $0.19 | $0.31 | $1.18 |
| sonnet·medium | 21 | $0.28 | $0.42 | $1.18 |
| sonnet·high | 26 | $0.41 | $0.56 | $1.18 |
| opus·medium | 21 | $0.56 | $0.83 | $2.37 |
| opus·high | 26 | $0.81 | $1.13 | $2.37 |
| opus·xhigh | 30 (cap) | $1.02 | $1.37 | $2.37 (34 turns) |
| fable·medium | 21 | $1.40 | $2.09 | $5.92 |
| fable·high | 26 | $2.04 | $2.82 | $5.92 |

All columns carry `scaleByRole.work` 0.6, U's included, so P/U keeps its meaning.
Inspector (sonnet·low, 12k, 6 turns) ≈ $0.06. V3 skeptic (opus·high, 10k = 0.25 × 40k,
12 turns) ≈ $0.19; the ultracode-style verifier at the same reading ≈ $1.34. A sweep round
(opus·medium, 10k) ≈ $0.32.

Reproduce any cell: from the plugin root,
`node -e "const {loadCore}=await import('./tests/harness.mjs'); const c=loadCore(); const K=c.calibrate(); console.log(c.estUsd({model:'opus',effort:'high'}, 40000, 0, K, c.agentOpts('worker', K)))"`
(for the ultracode column: `ctxTok` 30000, `effort:'xhigh'`, options `{lean:false, cap:80, readFactor:4, role:'work'}`).

How to read the card:
- On an Opus session, a lean opus·medium unit costs about 0.25× ultracode's agent ($0.56 vs
  $2.37); sonnet·medium about 0.12×.
- Keeping 30k of CLAUDE.md (on the 15k full-tool prefix) adds $0.3–0.35 per opus agent,
  about as much as the effort step from medium to high. That is why `ctx:'keep'` is
  reserved for G2 units, and parity uses a capsule with pointers. A real nested chain can
  be far bigger than 30k: measure it, never guess.
- At the cap, effort stops adding turns (opus·xhigh is capped at 30): a unit that plans
  its turns at the cap is too big; split it.

## What 0.1.3 got wrong (price model 3; measured on a 23-agent research run)

`omitClaudeMd` drops only the CLAUDE.md files loaded at agent start. Whenever an agent
uses the **Read** tool, Claude Code attaches every CLAUDE.md between the session cwd and
the file as nested memory. On the measured run a ~350 KB nested CLAUDE.md pushed 15 of 23
lean agents from ~8k to ~150k tokens of context — about 2/3 of the crew's cost. A probe
confirmed that Read attaches it and Bash (`nl -ba FILE | sed -n 'A,Bp'`, `grep -n`) does
not, so 0.1.4 takes Read away from the lean crew. Price model 3 refits the defaults to
leak-free agents:
- **`readFactor` 4 → 1.** The "context grows 4–5× the planned reading" that justified 4
  was mostly the attached CLAUDE.md. Leak-free workers read 5–24k tokens in 4–16 API
  turns. Ultracode's agents still use Read, so `ultraReadFactor` stays 4.
- **`baseCtxLean` 8000 → 11000**: lean agents start at 7–12.5k and gain ~3–4k of
  attachments on turn 2.
- **`verifierInFrac` 0.5 → 0.25**: skeptics reading through Bash read 4–10k tokens.
- **The sweep is its own role.** It was priced like a full work unit ($3.73 estimate vs
  $0.35 actual); it now reads `inAvg × sweepInFrac` (0.25) and calibrates as `sweep`.
- **Calibration is keyed by price model.** The master passed a legacy global
  `calib.scale` (1.28, learned under the old model) on top of per-role factors that
  already contained it, and `stats.mjs` then learned per-role factors while ignoring that
  scale. Now `card.calib` records `pm`; `calibrate()` honours `scale`/`scaleByRole` only
  when `args.calib.pm` is the current price model (otherwise it warns and uses the
  defaults); `stats.mjs` computes `used = scaleByRole[role] × scale` and archives a calib
  from another price model instead of blending into it.
- **The priors sit above the fit.** At these settings the measured run fitted work 0.41,
  verify 0.19, inspect 0.25, sweep 0.72; the defaults are 0.6 / 0.35 / 0.5 / 0.8, because
  under-estimating exhausts the work pool and starves verification, while an
  over-estimate only leaves reserve unspent. Self-calibration walks them down with data.

## Re-pricing the real review

The first run's exact review cards, re-priced with 0.1.1: **U $119.38**, **P $44.08**
(agents capped), against **$58.58** actually spent by the unbounded 0.1.0 crew and the
$20.62 that 0.1.0 had estimated. Those cards were routed the 0.1.0 way (subsystem split,
"high" on deployed code); following the new routing rules (`routing.md` §3 and §5) lowers
P further.

## What 0.1.1 got wrong (per-role; measured on a validation run)

A validation run under 0.1.1 (a review, 8 units, 69 findings: 7 high / 34 medium) priced
the crew at $15.29 and actually spent **$19.89** ($21.59 with the master's own share),
0/25 agents over their turn cap — bounded agents fixed the blowout, but not the price.
The miss was **per role, in opposite directions**:

| Role | Estimate | Actual | Ratio |
|---|---|---|---|
| workers | $10.42 | $17.29 | 1.66 (at `readFactor` 3) |
| skeptics | $3.31 | $1.31 | 0.40 |
| inspectors | $1.77 | $1.28 | 0.72 |

A separate verify-only pass of the 4 highs that should have been checked cost **$0.63
against a $3.31 estimate** (0.19) and confirmed all 4. Only 6 of the 69 findings got
verified in the main run, because `verify.expected` was a flat `ceil(n/2)` = 4 batches at
`topK: 8`, while the 1.3× work overrun drained the shared ceiling before verification
ran — `topK`, not risk, decided what got checked.

A single global `calib.scale` (the blend, ≈1.28) would have priced skeptics **~4× too
expensive**, starving verification further to correct an overrun it had no part in.
0.1.2's fix has three parts, in order of how much of the gap each closes:
1. **`scaleByRole`** prices each role by its own measured ratio instead of one blend.
2. **`readFactor` 3 → 4** closes most of the worker gap on its own (workers still ran
   1.66× over at 3; `scaleByRole.work: 1.3` absorbs what is left).
3. **Risk-weighted `expected`** (below) sizes the verification reserve to the findings a
   run actually expects, so `topK` stops substituting for severity.

## Budget block: U, P, R, C

| | How it is formed | Who |
|---|---|---|
| **U** | `ultra.agents` × estUsd(S·E_ref, `inAvg`, `ctxTok`) + `ultra.verifiers` × estUsd(S·E_ref, `verifierInFrac`·`inAvg`, `ctxTok`), all on the unbounded ultracode options (full prefix, g 4, cap 80) | master counts, foreman prices |
| **P** | Σ units (estUsd(p, in, ctx) on the unit's agent type + one inspector if `check` has `quote` or the unit is B2 + planned re-derivation `rd`) + `expected` × V3 skeptic at `inAvg`·`verifierInFrac` + `rounds` × sweep worker at `inAvg`·`sweepInFrac` (role `sweep`) + (depth `deep`: 1 completeness critic on W·high at `inAvg`·`verifierInFrac`, which also counts toward `plannedAgents`/`maxAgents`) | foreman |
| **R** | Σ over units with `fb`: `rerouteRate` × estUsd(fb, in, ctx); floor = the largest single repair; cap = `reserveCapPct`·P; **the floor wins** over the cap; the largest B2 repair is earmarked | foreman |
| **C** | crew ceiling = 0.5·U; with `parityBound` up to 0.8·U; `--ceiling` sets `caps.ceilingUsd` | rail |

Verifier, sweep and critic agents run `ctx:'omit'` on the lean prefix.
`rerouteRate` defaults to 0.2 (since 0.1.5: 7 capability failures in 44 units, ~16%, across 7 runs), or the observed rate from routing stats once a role cohort has n≥4.

### Verification sizing: `expected` (0.1.2, risk-weighted)

When the master leaves `verify.expected` unset, the foreman sizes the reserve to the
findings a run actually expects, not a flat fraction of unit count:

```
highs   = ceil(nUnits × highsPerUnit / batch)              // every expected high is checked
medRung = verify.rungs.medium ?? DEFAULT_RUNGS.medium        // 'V2' by default (0.1.4; V1 in 0.1.2–0.1.3)
mediums = medRung ∈ {V2,V3,V4} ? ceil(min(nUnits × mediumsPerUnit, topK) / batch) : 0
expected = highs + mediums
```

`highsPerUnit: 0.9` and `mediumsPerUnit: 5` are measured on the validation review (7 high
+ 34 medium from 8 units; mediums raised from 4 to 5 in 0.1.5 with the 15-finding cap). Highs are exempt from `topK` outright (`topKExempt` also now
exempts any V3+-rung claim with severity ≥ high, not only parity), so `highs` reserves
real capacity for all of them. Since 0.1.4 mediums default to `V2` (lean skeptics are
cheap), so `mediums` reserves one skeptic per batch of up to `topK` mediums; a master who
sets `rungs.medium: 'V1'` gets `mediums` = 0. This is what keeps `topK` a size
limit again instead of the thing deciding which findings get checked at all.

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
  agents would read under). Measure the start-up ones with `wc -c <files> | tail -1` ÷ 4
  and the nested chain with `scripts/claude-md-chain.mjs <session-cwd> <paths>`.
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

## Self-calibration: per-role, keyed by price model (`calib.pm` + `calib.scaleByRole`)

0.1.1 learned one `calib.scale` for every agent. 0.1.2 learned one **per role** because
the validation run's miss ran in opposite directions by role (see "What 0.1.1 got
wrong"). 0.1.4 adds a fourth role and keys everything by price model; 0.1.5 a fifth,
`implement` (prior 3.5). The roles: `work` (worker/worker-mcp/worker-ctx, plus the deep
completeness critic), `implement` (implementer themes), `sweep`
(gap-sweep rounds), `verify` (skeptic batches), `inspect` (inspector calls).

1. At close, `ledger-cost.mjs <transcript-dir> --json` writes the actual dollars **by
   kind** (`byKind`). `stats.mjs update … --ledger <that file>` compares per role:
   - **estimate**, straight from this run's own ledger; **actual** from `byKind`
     (`work` = work + critic, `sweep` = sweep, `verify` = verifier, `inspect` =
     inspector). A role whose kinds never appear is skipped, not treated as zero.
   - `ratio = actual / estimate`, clamped to **[0.1, 10]**;
   - `used` = the factor this run was **actually priced with**:
     `card.calib.scaleByRole[role] × card.calib.scale` (1 when absent), so the global
     scale is never counted twice; `target = used × ratio`;
   - `stats.calib.scaleByRole[role]` folds in `target` as an EWMA (α 0.5). A role's first
     observation under a price model blends from `used` (0.5·target + 0.5·used) instead of
     replacing it outright.
   - **Price model:** when the run's `card.calib.pm` differs from `stats.calib.pm` (or the
     stored calib has none — the old global-scale era), the old calib moves to
     `stats.calibArchive[<old pm or 'legacy'>]` and calibration starts fresh. A run whose
     card carries no `pm`, or a `--ledger` file without `byKind`, feeds no calibration.
2. `stats.mjs --summary <kind>` prints `CALIB {"pm":3,"scaleByRole":{...}}` only when
   `stats.calib.pm` is the current price model — never a legacy global scale. The master
   passes that object **verbatim** as `args.calib`; the foreman honours `scale` and
   `scaleByRole` only when `pm` matches its `PRICE_MODEL`, and otherwise adds a warning and
   keeps the defaults.

`scaleByRole` and `scale` move each role's estimates proportionally, so they correct the
absolute dollars: the card, the `pauseUsd` stop, the ledger's committed-vs-actual line and
a user `--ceiling`. If actuals drift far from estimates because agents read more than
planned, fix the briefs and packing first (and check that the lean crew really reads
through Bash); the per-role scale absorbs what remains.

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

The 0.1.1 defaults come from 119 agents of one real run (see "What 0.1.0 got wrong");
`highsPerUnit`, `mediumsPerUnit` from the 0.1.2 validation run; price model 3's
`baseCtxLean`, `readFactor`, `verifierInFrac`, `sweepInFrac` and `scaleByRole` from the
23-agent research run (see "What 0.1.3 got wrong"). Learned factors (`scale`,
`scaleByRole`) need `pm: 3` beside them. Every key is optional; missing keys keep the default:

```js
calib: {
  pm: 3,
  prices: { haiku: {in:1, out:5}, sonnet: {in:2, out:10}, opus: {in:4, out:20}, fable: {in:10, out:50} },
  cacheWrite: 1.25, cacheRead: 0.1,
  baseCtxLean: 11000, baseCtx: 15000, turnsBase: 10, tokPerTurn: 2500,
  effortTurns: { low: 0.6, medium: 0.8, high: 1, xhigh: 1.3, max: 1.6 },
  outPerTurn: { low: 600, medium: 1000, high: 1500, xhigh: 1800, max: 2200 }, haikuOutPerTurn: 500,
  readFactor: 1, ultraReadFactor: 4, ultraTurnCap: 80,
  caps: { worker: 30, workerMcp: 35, workerCtx: 30, implementer: 60, skeptic: 12, inspector: 6 },
  inspectorIn: 12000, verifierInFrac: 0.25, sweepInFrac: 0.25,
  scaleByRole: { work: 0.6, verify: 0.35, inspect: 0.5, sweep: 0.8 }, scale: 1,
  highsPerUnit: 0.9, mediumsPerUnit: 5
}
```

`caps` in `calib` change the **price** only; the real turn limit is each agent file's
`maxTurns`, so keep the two in step.

## Worked envelopes (Opus session, E_ref = xhigh, 0.1.1 defaults)

Not re-priced for 0.1.2's `readFactor` 4 / `scaleByRole` or for price model 3; see the
calibration card above for current per-agent prices.

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
