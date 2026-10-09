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
2. **No CLAUDE.md** on non-parity agents. A short rules capsule replaces it — and no MCP
   tool schemas either, unless the unit needs them: `worker`/`skeptic` carry a plain
   `Read, Grep, Glob, Bash` allowlist, and only units whose vector needs MCP or a long
   tool loop run on `worker-mcp`, which keeps the full tool set.
3. **Effort matched to difficulty.**
4. **Risk-weighted verification**, with deterministic checks first.
5. **Cheaper models** only where a named check catches their failures.

### Guarantees

- **Cost:** the crew's ceiling is 0.5× the ultracode estimate (U). With the master's
  own share, that is about 0.6× in total. Every run ends with a cost ledger (U/P/R/C,
  committed vs actual, master vs crew share).
- **Quality:** units whose errors would be invisible *and* consequential sit in the
  **parity cell**. They run exactly as ultracode would, at the same model and effort,
  with CLAUDE.md kept and V3 verification. Every cheaper unit must name the objective
  check that catches its mistakes.
- **No churn:** each unit gets 1 primary run and at most 1 capability re-route, onto a
  fallback the master chose up front. If that fails too, the result is reported as
  UNVERIFIED with a reason; it is never silently dropped.

### Honest limits

- **Parity-heavy tasks save less.** When most of the risk is invisible and booked
  (money paths, tax readings), the savings come mostly from agent count and context,
  not from cheaper cells. The ceiling can rise to **0.8×** ultracode, and the card says
  *parity-bound*.
- The price model starts from priors. Stage-0 calibration numbers replace them (see
  `plugins/dynamic-fanout/skills/dynamic-fanout/references/economics.md`), so early estimates can be off by a margin. One input,
  the fixed per-agent prefix (`baseCtx`), is no longer a prior: a 2026-10-09 smoke run
  measured it at 35–70k tokens in an MCP-heavy setup, and the default is now 40000. It
  stays tunable via `calib.baseCtx` for leaner setups.
- Cheaper "probe" routing, to learn whether a lower cell would do, is deferred to v0.2.
  v0.1 only ratchets cells **up** from its routing stats.
- The Workflow rung runs only with opt-in: invoking the command, ultracode being on, or
  asking for a fan-out. Without opt-in, it falls back to the Agent tool, then to
  in-context work.

