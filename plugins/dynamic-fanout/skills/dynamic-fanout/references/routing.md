# Routing guide: how the master picks every subagent's cell

Read this at plan time (SKILL.md §3, after scouting and packing in §2). It is the only place
routing judgement lives: the foreman (`workflows/fanout.js`) validates, prices and executes
your cards, and never picks or changes a cell. The args shape and rail error texts are in
`workflow.md`; prices and the U/P/R/C arithmetic are in `economics.md`.

**Contents**
1. Principle and session-relative names
2. Score the unit: the feature vector
3. Decide in this order
4. Context: `ctx:omit` vs `ctx:keep`
5. Decompose by work type, and bound every agent
6. The card
7. Rails, and what to do when the plan is rejected
8. Worked examples
9. Using routing stats (cross-run learning)
10. Anti-patterns

## 1. Principle and session-relative names

**Model buys capability; effort buys thoroughness.** Change the model only for a capability
gap (ambiguity, large cross-referenced context, domain traps, MCP exploration). Otherwise
change only the effort. Aim for **right first time**: each unit runs once on its primary
cell `p`; the fallback `fb` is insurance you choose now, used at most once, never a ladder.

| Name | Meaning |
|---|---|
| **S** | the session model (the master's own model) |
| **W** | the work tier: W = S, except W = opus on a Fable session |
| **E_ref** | the effort ultracode's crew would inherit: `--ref-effort` (refSource `flag`), else `xhigh` (refSource `default`). The run card prints it with its source; the skill's own `effort: max` is never E_ref |

- No crew cell above S unless the user passed `--allow-up` (then at most one unit).
- No crew effort above E_ref, and never `max` unless E_ref = max was passed explicitly.
  Why: every agent file and call pins effort, or it would inherit the skill's `max`.
- Strength order: `haiku < sonnet < opus < fable`, then `low < medium < high < xhigh < max`.
  Cell notation is `opus·high`; haiku has no effort.

## 2. Score the unit: the feature vector

Score each packed unit 0/1/2 on seven features, written as one string
`D2 A1 T1 C1 V0 B2 G2`. Add `n:1` (flag **N**) when numbers must tie out.

| Feature | 0 | 1 | 2 | Moves |
|---|---|---|---|---|
| **D** depth | lookup | a few hops | multi-hop, edge cases | effort |
| **A** ambiguity | exact spec | some judgement | done-ness needs judgement | model (fix the brief first) |
| **T** tools | none | Read/Grep/Bash | MCP, long tool loops | model floor: sonnet |
| **C** context | <20k | 20–80k | >80k, cross-referenced | model |
| **V** verifiability | deterministic: tie-out, tests, set-equality, schema | quotes / partial check | opinion, or recall ("nothing missed") | high V = licence to go cheap |
| **B** blast radius | advisory | internal, reversible | booked numbers, deployed code, finance-facing posts | effort floor, `fb`, verify rung |
| **G** domain traps | none | a few, the capsule states them | several the capsule cannot fully state | model + `ctx:keep` |

Note the direction of V: **V2 is the easy end** (deterministic check), V0 the hard end.
**N** adds no effort. It forces an independent re-derivation by a *different method*
(`check` must contain `rederive`; optional `rd` cell, default = `p`).

**T also picks the agent type, not just the model floor.** T2 (MCP or long tool loops)
routes the unit to `dynamic-fanout:worker-mcp` instead of the plain `worker`; everything
else (T0/T1, and `ctx:'omit'` work generally) runs on `worker`/`skeptic`, which carry an
explicit `tools: Read, Grep, Glob, Bash` allowlist. The allowlist is a cost lever, not
just a safety one: an agent file with a fixed tool list has no MCP tool-schema JSON in
its system prompt. Measured on 119 agents, allowlisted agents start at ~6–8k tokens
(`baseCtxLean` 8000), full-tool agents at ~15k (`baseCtx` 15000) before any CLAUDE.md.
Only pay for the full tool set (`worker-mcp`, `worker-ctx`) when the unit needs it.

## 3. Decide in this order

1. **An agent at all?** If you have already half-done the unit, finish it inline. A
   deterministic transform (rename, reformat, sum) is code, not an agent.
2. **Model: the lowest one that succeeds first time.**
   - **haiku:** T0 ∧ V2 ∧ B0, with enough volume to fill its own cache cell. Rare; prefer
     code. Never tools, MCP or an effort (rail).
   - **sonnet:** tool and file work, extraction, mechanical edits to an exact spec,
     SQL/pandas with pinned formats, exact MCP queries. Only when A≤1, C≤1, G≤1.
   - **W:** any of A2, C2, G2, MCP exploration, V0 ∧ D≥1, V3/V4 verifiers, implementation
     logic on B2 code.
   - **S when S ≠ W** (Fable session): the parity cell and its verifier only.
   - **Above S:** only with `--allow-up`, one crux unit (D2 ∧ V0 ∧ B2), ceiling still
     holding. Default no: a second independent W·high look beats a pricier first one.
3. **Effort** (then clamp to E_ref):
   - low: D0 ∧ V2.
   - medium: D1, or D2 with V2, B0 or **B1**. Anything the rules do not cover.
   - high: **D2 ∧ V≤1 ∧ B2** only; B2 implementation logic; V3/V4 verifiers.
   - E_ref: the parity cell only.

   In 0.1.0 "high" fired on any B≥1 unit, and "deployed code" made almost everything B1+:
   the first real run collapsed to opus·high/xhigh and every `fb` came out `null`
   (`p` ≥ W·high). A B1 unit now starts at **W·medium with `fb` W·high**, so the one
   re-route exists and the stronger run is paid only when a check fails.
4. **Parity cell** — the ≥ultracode guarantee. **V0 ∧ B2 ∧ D≥1** means an error would be
   both invisible and consequential, so the unit runs on ultracode's cell:
   **S·E_ref, `fb:null`, claims at V3** (on S·high). The rail enforces the cell and `fb`
   only; `ctx` is your choice and defaults to `omit` (section 4).
   Every other unit is cheaper only because it is easy, or because a named objective check
   catches its failure. `check:none` outside parity is a planning error.
5. **Unsure → W·medium plus an objective check.** Never guess low; a cheap miss costs a
   re-route plus a stronger run, which is more than W·medium would have.
6. **Fallback `fb`** — fixed now, used at most once, on a capability failure only:
   - strictly stronger than `p`, and ≤ S·E_ref (on Fable sessions keep it ≤ opus·E_ref);
   - default **W·high** when `p` < W·high; a same-model notch up (`sonnet·low → sonnet·medium`)
     is enough when the likely failure is thoroughness, not capability;
   - **`null`** when `p` ≥ W·high (strengthen the check instead), and for parity units,
     superseding units and peripheral B0 units;
   - units that carry the answer always get a non-null `fb` unless `p` ≥ W·high.
7. **Verifiers** (declare `verify.rungs` per severity and `verify.cells`):
   - the verifier's model ≥ every producer model it checks (rail);
   - V2 = the producer's model·medium (implicit); V3/V4 = W·high; parity claims run on S·high;
   - a deterministic re-check (tie-out, tests, grep count, set-equality) replaces a
     verifier whenever one exists;
   - **a tie-out proves arithmetic, not semantics.** Tax-code reading, join choice, sign
     conventions become their own W unit with a skeptic, never a sub-step of a V2 unit.
8. **≤2 cells per stage**, because the prompt cache is shared only within one
   model·effort·agentType. Merge the smallest cell **up** into the nearest one (same model
   first), never down. If merging up breaks the ceiling, split into sequential stages.
   Omit `model` when the cell's model = S.
9. **Session shapes**

| Session | W | Shape |
|---|---|---|
| Sonnet | sonnet | everything sonnet; effort alone routes. At standard/deep the card advises `/model opus` (~+$0.7/run) |
| Opus | opus | sonnet for checkable tool work, opus for the rest; parity at opus·E_ref |
| Fable | opus | opus is the work tier; fable only for the parity cell and its verifier |
| Haiku | — | solo. The foreman rejects S = haiku |

If E_ref is low or medium, the "high" rules collapse to E_ref; when no stronger `fb` fits
under S·E_ref, set `fb:null` and strengthen the check.

For fewer than 3 units, skip the full scoring pass: use step 5 unless a feature is obvious,
but still fill `vec`, `check` and `why` (the rails require them).

## 4. Context: `ctx:omit` vs `ctx:keep`

Fixed context per agent is usually the largest cost: in a large repo the root plus nested
CLAUDE.md files can reach tens of thousands of tokens per subtree, re-read on every turn.

| ctx | Agent | Use for | What the agent gets |
|---|---|---|---|
| `omit` (default) | `worker`, `skeptic`, `inspector` — or `worker-mcp` when the unit's vector has T2 | everything not listed below, **parity units included** | `omitClaudeMd` + the shared **rules capsule**: the unit's constraints ("the billing system is read-only", "never print credentials") and `path:line` pointers to the CLAUDE.md sections it may need, read on demand |
| `keep` | `worker-ctx`, `implementer` | G2 units whose traps the capsule cannot state; every implementer | full CLAUDE.md, so its domain knowledge matches ultracode's |

**Why parity no longer keeps CLAUDE.md.** In the first real run, CLAUDE.md-kept agents
started at ~85k tokens and re-read all of it on every turn; most of it was irrelevant to
the unit. Parity is about the *cell* (the same model and effort as ultracode), not about
paying for the whole CLAUDE.md: a capsule with the unit's rules and `path:line` pointers
into the relevant CLAUDE.md sections gives the same knowledge, read on demand.

- Put `ctxTok` (CLAUDE.md tokens on that unit's path) on every `keep` card so P is priced right.
- A `keep` unit runs on `worker-ctx` (full tools, 15k prefix + `ctxTok`), never the lean `worker`.
- Pack `keep` units in the same subtree together: one 66k context, not three.
- A capsule pointer beats `keep` whenever the trap fits in one line (G1).
- `ctx` and `T` are independent choices: a T2, `ctx:'omit'` unit runs on `worker-mcp`
  (full tool set, no CLAUDE.md); a T2, `ctx:'keep'` unit still runs on `worker-ctx`
  (`ctx:'keep'` wins the agent-type pick — see `workflow.md`'s agent-type rule).

## 5. Decompose by work type, and bound every agent

**Split by work type, not by subsystem.** In the first real run the review was split by
subsystem, every unit mixed judgement with mechanical checking, and every unit landed on
opus. Peel the mechanical part of each subsystem into its own sonnet unit with a
deterministic check; keep W for the judgement.

| Work type | Examples | Cell | Check |
|---|---|---|---|
| Judgement | failure modes across files, state/idempotency, "is this rule applied correctly" | W·medium (W·high only for D2 ∧ V≤1 ∧ B2) | quote, V3 |
| Inventory | every call site / option / constant with file:line | sonnet·low | set |
| Consistency | docs vs code, config vs schema, enum defined vs compared | sonnet·medium | set+quote |
| Mapping | field → column, category → account, route → handler | sonnet·medium | quote, tests |
| Extraction | numbers, rows, totals from files or queries | sonnet·medium | tieout+rederive |

Example: "review the ticket bot" split by subsystem gives 4 opus units. Split by work type
it gives 2 judgement units (decision logic, external side effects) on opus·medium, plus
one sonnet unit for "every category value defined vs used" and one for "docs vs code".

**The routing warning.** For `review`/`research` with ≥3 units, the foreman warns
`routing: X% of planned work-unit spend runs on <S>; split mechanical work (inventory,
consistency, mapping, extraction) into sonnet units` when more than 70% of the planned
unit spend sits on S. Treat it as a re-plan prompt, not noise.

**Turn caps.** Every crew agent type has a hard `maxTurns`; the foreman prices each unit
with planned turns = min(cap, round((10 + in/2500) × effort factor)) and the prompt states
"about N tool calls (hard stop at CAP)".

| Agent type (typeKey) | Picked when | Cap | Prefix |
|---|---|---|---|
| `worker` | default | 30 | lean 8k |
| `worker-mcp` (workerMcp) | vector T2, `ctx:omit` | 35 | 15k |
| `worker-ctx` (workerCtx) | `ctx:keep` | 30 | 15k + `ctxTok` |
| `implementer` | role `implement` | 60 | 15k + `ctxTok` |
| `skeptic` | verifiers | 12 | lean 8k |
| `inspector` | quote checks, B2 units | 6 | lean 8k |

Effort factor: low 0.6, medium 0.8, high 1.0, xhigh 1.3, max 1.6 (haiku 0.6). Size each
unit so its planned turns stay **below** its cap; planned turns at the cap mean the unit
will run out and come back `partial`, so split it. The card shows `turns` per unit.

## 6. The card

One JSON line per unit, in the `units[]` shape of `workflow.md`. In your plan and on the run
card, identical units share one line and one `why` (`u4–u7`); expand them to separate unit
objects in the args.

```js
{id:'u3', role:'review', vec:'D2 A1 T1 C1 V0 B2 G2', n:0, scope:{files:[...]}, in:38000,
 ctx:'omit', p:{effort:'xhigh'}, fb:null, check:'V3',
 why:'parity: a missed money-path bug is invisible and gets booked', brief:'...'}
{id:'u5', role:'data', vec:'D1 A0 T1 C1 V2 B2 G1', n:1, in:24000, ctx:'omit',
 p:{model:'sonnet', effort:'medium'}, fb:{effort:'high'}, rd:{model:'sonnet', effort:'medium'},
 check:'tieout+rederive', why:'V2: integer-cent tie-out + re-derivation catch it; spec pins format', brief:'...'}
```

- `why` ≤140 chars, names the **deciding feature** (`parity:`, `V2:`, `C2:`, `G2:` …). The
  ledger joins every outcome (ok, rerouted, refuted later, UNVERIFIED) to it, so a wrong
  route can be traced to its reasoning.
- `check` is `+`-joined: `quote`, `set`, `tests`, `tieout`, `rederive`, `V2`, `V3`, `V4`.
- `brief` ≤120 words of pointers (paths, line ranges, questions); never pasted content.
  For an `omit` parity unit, the capsule pointers (`CLAUDE.md:40-62 payment states`) go here.
- The dry-run card adds `turns` (planned tool calls) and `estUsd` per unit.

## 7. Rails, and what to do when the plan is rejected

The foreman rejects the **whole** plan before any agent launches; the authoritative table
and error prefixes are in `workflow.md`. In short:

- haiku with tools or an effort; a missing or unknown effort; effort > E_ref;
- a cell above S without `allowUp`, or >1 allow-up unit;
- `fb` not strictly stronger than `p`, above S·E_ref, or non-null on parity/superseding units;
- parity unit not on S·E_ref (the cell only; `ctx` is free);
- missing `vec`/`why`/`brief`/`check`, `check:none` outside parity, or `n:1` without `rederive`;
- a verifier weaker than a producer it checks;
- P + R > C, or `parityBound` without parity overflow; planned agents > `caps.maxAgents`.
- Warning only: >2 cells in the work stage, >25 planned agents, >70% of review/research
  unit spend on S (`routing:`).

**Fix the plan once.** If P + R > C, change the plan in this order: pack harder → lower
effort on checkable non-parity units → move checkable units to sonnet → narrow
verification to top-K → go solo. **Never downgrade a parity unit to fit**: if parity units
alone exceed 0.5·U after packing, set `caps.parityBound` (C rises to ≤0.8·U; the card and
ledger say so). If the second attempt still fails, narrow verification or go solo — do not
iterate on the rails. Use `dryRun:true` when unsure.

## 8. Worked examples

Opus session, E_ref = xhigh, so S = W = opus. Rough price for orientation (in=40k, lean
`worker`, turn-capped, from the `economics.md` model): sonnet·medium ≈$0.82, opus·medium
≈$1.63, opus·high ≈$2.13, opus·xhigh ≈$2.54; the unbounded ultracode-style opus·xhigh agent
with 30k CLAUDE.md ≈$3.95.

| Unit | Vector | p → fb | ctx · check | why |
|---|---|---|---|---|
| every place an enum's allowed values are defined or compared | D0 A0 T1 C1 V2 B0 G0 | sonnet·low → sonnet·medium | omit · set | V2: grep set-equality catches misses |
| …where code overrides a model's proposal, with file:line | D2 A1 T1 C2 V1 B0 G1 | opus·medium → opus·high | omit · quote | C2 needs W; advisory B0, so medium |
| Review `payments/`: state machine + matching + external lookup, packed | D2 A1 T1 C1 V0 B2 G2 | **opus·xhigh (parity)** → null | omit (capsule + pointers) · V3 | parity: recall unverifiable; a wrong result double-settles an invoice |
| …rendering: formatter.py, payload.py, report.py | D1 A0 T1 C1 V1 B1 G0 | sonnet·medium → opus·high | omit · tests+quote | V1: fixtures catch it |
| …deployed retry/backoff logic | D2 A1 T1 C1 V1 B1 G1 | opus·medium → opus·high | omit · quote | B1: not booked, so medium with a real fb |
| Billing export, invoices + credit notes for one month: rows, totals by tax_code, duplicate doc_no, negatives | D1 A0 T1 C1 V2 B2 G1 N | sonnet·medium → opus·high | omit · tieout+rederive | V2: integer cents; spec pins the delimiter, encoding and date format |
| …tax formula per tax_code vs the tax-rules reference | D2 A1 T1 C1 V1 B2 G2 | opus·high → null | keep · V3 | G2: tax-code semantics and sign conventions; a wrong reading still ties out |
| Data warehouse (MCP): contract price vs invoiced price, one region-month | D2 A1 T2 C1 V1 B1 G2 N | opus·medium → opus·high; `rd` opus·medium via an alternate join key | keep · rederive | G2: a wrong join returns clean numbers (e.g. a placeholder/default key) |
| Implement report_export: add a column + fixtures, exact spec | D1 A0 T1 C1 V2 B1 G0 | sonnet·medium (implementer) → opus·high | keep · tests | V2: the tests are the check |
| …category mapping, with a default-bucket fallback | D2 A1 T1 C1 V1 B2 G1 | opus·high → null | keep · V3+tests | B2: booked; its own tests share its blind spots |

Read the pairs: the mechanical half goes cheap because a check catches it; the semantic half
(tax reading, join choice, mapping fallback) gets its own W unit, because the tie-out or the
tests next to it would pass a wrong reading. In the data-warehouse row (B1, so medium) the
planned re-derivation is the second opinion and a mismatch spends the one re-route on
opus·high `rederive`; with `fb:null` it would end UNVERIFIED with both numbers for the master.

## 9. Using routing stats (cross-run learning)

In the scouting batch, run `node <base>/../../scripts/stats.mjs --summary <kind>` (base =
this skill's base directory; ≤40 lines). It prints cohorts keyed
`kind/role/D·V·B·T/model·effort/ctx` with `n` (decayed ×0.9 per run), `firstPassOk`,
`rerouted` and the confidence split, plus the rule lines below — no `medUsd` and no
per-run row (the ledger only ever records price-model estimates, not actual spend).
Labels are final outcomes: a unit that passed the gate but whose claim was later REFUTED
counts as a first-pass failure of its `p`. The stats inform your judgement only; code never
routes on them, and only `stats.mjs update` writes the file.

| Rule | Condition | Effect on your cards |
|---|---|---|
| **Promote** | matching cohort n≥4, firstPassOk <80% | start at the cohort's usual `fb`; pick a new stronger `fb` or `null` (rails still apply) |
| **Reserve prior** | role cohorts with n≥4 | set `caps.rerouteRate` to the observed rate instead of 0.1 |
| **Confidence** | conf-hi ok rate not ≥10 points above conf-lo | treat self-confidence as noise, not even a sort key; say so on the card |
| **Envelope** | the last run of this kind committed (estimated) >0.6·U | solo thresholds ×1.5 for this kind; note it on the card |

Probe (deliberately routing one notch cheaper to learn) is deferred to v0.2: it risks a
second run, which breaks right-first-time. In v0.1 stats only ratchet cells **up**.

No stats, or n<4: route from the rubric alone. A cohort's `why` pattern that keeps ending
REFUTED is a rubric gap; fix the scoring next time, not just the cell.

## 10. Anti-patterns

- **Over-routing drift.** Scoring everything V0/B2 out of caution puts every unit in
  parity or at W·high, and the savings vanish. The run card prints the cell mix; a parity
  share above 30% outside review-heavy tasks needs a stated reason. If parity is genuinely
  high, the savings must come from structure: fewer, larger parity units, solo gate,
  `ctx:omit` everywhere else.
- **Under-routing that passes the gate.** A unit marked V2 because a tie-out exists, where
  the real error is semantic (wrong join, wrong tax-code reading): clean numbers hide a
  wrong answer, and nothing re-routes. A tie-out proves arithmetic, not semantics; split
  the semantic question into its own W unit and give every N unit a re-derivation by a
  different method.
- **Splitting by subsystem.** Each unit mixes judgement with inventory, so each lands on
  opus·high and the plan has no sonnet work and no fallbacks. Split by work type (section 5).
- **Unbounded reading.** A brief that says "review X" without line ranges or a question
  invites whole-file reads; in the first real run agents read 2.4–5.6× what was planned.
  Briefs name ranges and questions; the turn cap and find-before-read rule do the rest.
- **Many cells in one stage.** Each extra model·effort pair is a cold cache; four cells of
  two agents each pay fixed context four times. Merge up, or stage them.
- **Cheap-first ladders.** Starting at haiku/sonnet·low "to see if it works" and escalating
  is forbidden. The fallback is one insurance step chosen now, not a plan to fail. If you
  cannot name the check that would catch the cheap cell's failure, the cheap cell is wrong.
- **Rubric overhead on tiny runs.** Scoring and writing whys costs master tokens; the solo
  gate runs first, and below 3 units use the unsure default.
