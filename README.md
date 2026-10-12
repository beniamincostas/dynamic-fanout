# dynamic-fanout

A **lean, master-routed replacement for ultracode's agent fan-out.** It covers
research, review/audit, data/finance analysis and implementation.

Ultracode gives every agent the session's model **and** effort (often Opus at xhigh)
and the full CLAUDE.md. Mechanical work pays top-tier prices, every agent re-pays a
large fixed context, and nothing checks or re-routes a weak result.

dynamic-fanout keeps your session as the **master**, at `effort: max`. The master
scouts, packs the work into as few agents as possible, and writes one card per subagent:
- the model·effort it starts on;
- one stronger fallback, chosen up front;
- whether it keeps CLAUDE.md;
- the objective check that catches its mistakes;
- a one-line reason.

A deterministic foreman workflow enforces the cards:
- it rejects a plan that breaks the rails, before any agent launches;
- it prices the plan against an ultracode estimate;
- it grounds every quote with a cheap inspector;
- it re-routes a failed unit **at most once**, onto that card's fallback.

Code never picks a model or an effort.

### 0.1.4: no nested CLAUDE.md for the lean crew

`omitClaudeMd` only drops the CLAUDE.md files loaded at agent start. The Read tool attaches
every CLAUDE.md between the session cwd and the file it reads. On a measured 23-agent
research run a ~350 KB nested CLAUDE.md pushed 15 lean agents from ~8k to ~150k tokens
of context, about 2/3 of the crew's cost. 0.1.4:
- the lean crew (`worker*`, `skeptic*`, `inspector`, `reviewer`) reads through Bash
  (`grep -n`, `nl -ba FILE | sed -n 'A,Bp'`), which attaches nothing; `worker-mcp`
  disallows Read; `worker-ctx*` and `implementer*` keep it and are priced with their own
  CLAUDE.md chain, measured by `scripts/claude-md-chain.mjs`;
- **price model 3** is refitted without the leak (`readFactor` 4 → 1, the gap sweep
  priced as its own cheap role) and calibration is keyed by price model, so an old
  global scale is no longer counted twice;
- `medium` findings get a skeptic again (V2), and a CONFIRMED needs the skeptic's own
  support quote (or the empty search for an absence claim);
- `scripts/report.mjs` prints a run's units and claims in one call; evidence paths are
  canonicalized, so the same file cited absolute and relative dedups.

**Requirement:** the lean crew needs read-only Bash in subagents — auto mode, or allow
rules for `nl`, `sed -n` and `grep`. If Bash is refused, those agents return `blocked`
(`no_access`) and the master re-runs the units with `ctx:'keep'`.

### 0.1.3: implement as its own workflow

The master used to hand-write the implement loop as an inline Workflow script from the
playbook, nearly the same code twice. 0.1.3 moves it into code:
`dynamic-fanout:implement` (`workflows/implement.js`) prices itself through one foreman
dry run, runs each theme serially with at most one repair pass on its pre-chosen
fallback, meters every launch against a cost ceiling, and ends with one independent
whole-diff review on a new `dynamic-fanout:reviewer` agent. A real cycle (7 serial
test-first fixes) cost $10.13 against a $20–25 estimate. Details: `CHANGELOG.md`.

### 0.1.2: per-role calibration

A validation run on 0.1.1 (8 review units) cost $21.59 total against a $15.29 crew
estimate, but not evenly: workers ran 1.66× over, while skeptics (0.40×) and inspectors
(0.72×) ran under. A single global `scale` would have corrected that by pricing
verification roughly 4× too high. 0.1.2 calibrates **per role** instead
(`scaleByRole: {work, verify, inspect}`, learned from `stats.mjs` the same way `scale`
was), raises `readFactor` to 4 (context still grew ~5× the planned reading), and makes
`medium` default to `V1` (a grounded quote, no skeptic) with verification sized to the
blocker/high findings a run actually expects rather than a flat fraction of unit count.
Details: `CHANGELOG.md` and
`plugins/dynamic-fanout/skills/dynamic-fanout/references/economics.md`.

### 0.1.1: bounded agents

The first real run (a large review of an LLM ticket bot, then 5 implementation themes)
cost about **$376**. The review crew cost **$58.58 against a $20.62 estimate**, because
crew agents ran unbounded: 28–65 turns each, reading 2.4–5.6× what was planned.
CLAUDE.md-kept agents started at ~85k tokens. The kill switch then cut verification.
Routing collapsed to Opus at high/xhigh, so no unit had a fallback. Implementation had
no envelope (~$226 over 9 launches).

0.1.1 fixes the cause, not just the numbers:
- every crew agent is **turn-capped**, and its prompt carries a turn budget and
  find-before-read rules;
- the price model is **turn-aware** and fitted on those 119 agents;
- ultracode's estimate is priced the way it actually runs (unbounded), so the 0.5× ceiling
  compares like with like;
- parity units drop CLAUDE.md for a rules capsule with pointers;
- planned verification has its own reserve, and the kill switch no longer cuts it;
- implementation passes get a priced envelope;
- the foreman warns when a review puts most of its spend on the session model.

Re-priced with 0.1.1, the same review cards come to U $119.38 and P $44.08 (agents
capped), against the $58.58 the unbounded crew really spent. Following the new routing
rules lowers P further. Details: `CHANGELOG.md` and
`plugins/dynamic-fanout/skills/dynamic-fanout/references/economics.md`.

### Install

```
/plugin marketplace add beniamincostas/dynamic-fanout     # skip if already added
/plugin install dynamic-fanout@dynamic-fanout
```

**Updates:** `/plugin marketplace update dynamic-fanout`, then
`/plugin update dynamic-fanout@dynamic-fanout`.

### Usage

```
/dynamic-fanout:dynamic-fanout <task> [--depth quick|standard|deep] [--ref-effort low|medium|high|xhigh|max]
                               [--allow-up] [--route u2=opus·high] [--ceiling <usd>] [--solo] [--confirm]
```

It also triggers on its own when an ultracode or multi-agent fan-out is about to start.

| Flag | Meaning |
|---|---|
| `--depth` | `quick` (≤4 agents, light verification), `standard`, or `deep` (two workflows, V4 panels, completeness critic). Auto-detected when omitted. |
| `--ref-effort` | The effort ultracode's crew would inherit (E_ref). Parity units and the ultracode estimate are priced at it. Default `xhigh`. |
| `--allow-up` | Lets one crux unit run on a model above your session's. |
| `--route u2=opus·high` | Overrides one unit's cell. The card marks it `override:user`. |
| `--ceiling <usd>` | Sets the crew ceiling in dollars. |
| `--solo` | Skips the fan-out; the master does the task itself. |
| `--confirm` | Pauses on the priced run card before launching. |

### Why it is cheaper

The savings are ranked by size, because fixed context per agent dominates cost:
1. **Fewer agents.** A price-aware solo gate and packing run the crew only when it pays.
2. **Bounded agents.** Every crew agent has a hard turn cap and a turn budget in its
   prompt, and reads targeted line ranges instead of whole files.
3. **No CLAUDE.md** by default, parity units included. A short rules capsule with
   `path:line` pointers replaces it — and no MCP tool schemas either, unless the unit
   needs them: `worker`/`skeptic` carry a plain `Grep, Glob, Bash` allowlist
   (no `Read`: it attaches every CLAUDE.md on a file's path; they read through Bash)
   (~8k-token prefix), and only units whose vector needs MCP or a long tool loop run on
   `worker-mcp`, which keeps the full tool set.
4. **Effort matched to difficulty**, and mechanical work peeled into Sonnet units.
5. **Risk-weighted verification**, with deterministic checks first.
6. **Cheaper models** only where a named check catches their failures.

### Guarantees

- **Cost:** the crew's ceiling is 0.5× the ultracode estimate (U). With the master's
  own share, that is about 0.6× in total. Every run ends with a cost ledger (U/P/R/C,
  committed vs actual, master vs crew share).
- **Quality:** units whose errors would be invisible *and* consequential sit in the
  **parity cell**. They run on ultracode's model and effort, with no fallback and V3
  verification; their CLAUDE.md rules come as a capsule with pointers. Every cheaper unit must name the objective
  check that catches its mistakes.
- **No churn:** each unit gets 1 primary run and at most 1 capability re-route, onto a
  fallback the master chose up front. If that fails too, the result is reported as
  UNVERIFIED with a reason; it is never silently dropped.

### Honest limits

- **Parity-heavy tasks save less.** When most of the risk is invisible and booked
  (money paths, tax readings), the savings come mostly from agent count and context,
  not from cheaper cells. The ceiling can rise to **0.8×** ultracode, and the card says
  *parity-bound*.
- The price model is fitted on one real run (119 agents). A self-calibrating `scale`
  (actual ÷ estimate, recorded at close and read back from the routing stats) corrects
  the absolute dollars over time; see
  `plugins/dynamic-fanout/skills/dynamic-fanout/references/economics.md`.
- The master's own share is outside the crew ceiling. A long multi-theme session at
  `effort: max` gets expensive; use a fresh session per implementation theme.
- Cheaper "probe" routing, to learn whether a lower cell would do, is deferred to v0.2.
  v0.1 only ratchets cells **up** from its routing stats.
- The Workflow rung runs only with opt-in: invoking the command, ultracode being on, or
  asking for a fan-out. Without opt-in, it falls back to the Agent tool, then to
  in-context work.

