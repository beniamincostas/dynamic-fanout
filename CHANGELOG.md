# Changelog

## dynamic-fanout 0.1.1 — 2026-10-10

The first real run (a large review of an LLM ticket bot, then 5 implementation themes)
cost about **$376**. The review crew cost **$58.58 against a $20.62 estimate** because
agents ran unbounded. Measured on 119 agents:
- 28–65 turns per agent;
- context grew to 2.4–5.6× the planned reading (whole files, wandering);
- CLAUDE.md-kept agents started at ~85k tokens and re-read it every turn;
- the output-token kill switch then cut verification (quality loss, no saving);
- implementation had no envelope (~$226 over 9 launches);
- routing collapsed to opus·high/xhigh (split by subsystem, and "high" fired on any
  deployed code), so every `fb` was null;
- the master's own ~$78 was mostly long-context re-reads in one 27-hour session.

Fits from those agents: allowlisted crew agents start at ~6–8k tokens, full-tool agents
at ~15k before CLAUDE.md; unbounded turns ≈ 10 + in/2.5k at high effort; output ≈ 1.5k
tokens per turn at high. Re-pricing the real review's exact cards with 0.1.1 gives
U $119.38 and P $44.08 (agents capped), against $58.58 actually spent unbounded.

### Fixed
- **False 0 % quote resolution.** A worker citing `fanout.js` for the scoped
  `…/workflows/fanout.js` made the inspector miss every quote and forced a re-route.
  Evidence paths are now mapped onto the unit's scope files (exact, then a unique suffix
  match) before the inspector runs, and every prompt says "cite every file path exactly
  as written under Scope".
- **Promoted launches skipped the budget check.** A cohort-promoted unit now passes the
  work-pool and kill-switch check for its primary estimate as well as the reserve check
  for the delta; if either refuses, it runs on `p` through the normal check.
- **Overestimated lean prefix.** 0.1.0 priced every agent at a 40k prefix (from an
  MCP-heavy smoke run). Allowlisted agents measure ~6–8k: `baseCtxLean` 8000 for
  `worker`/`skeptic`/`inspector`, `baseCtx` 15000 for full-tool types.
- **The kill switch cut verification.** It now stops new work only. Planned verification
  is held out of the work pool (`workPool = C − R − verifyUsd`) and draws from that
  reserve first, then the work pool.
- **Infra retries lost the agent type.** A retry keeps a plugin agent type that already
  answered in this run, so its turn cap and lean prefix still apply; only a type never
  seen working is dropped (a missing plugin agent).

### Changed
- **Turn-aware price model:** `estUsd = [(prefix + g·in)·pin·1.25 + turns·(prefix +
  g·in/2)·pin·0.1 + turns·outPerTurn·pout] / 1e6 · scale`, with turns = min(cap,
  round((10 + in/2500)·effortTurns)), effortTurns low .6 / medium .8 / high 1 / xhigh 1.3 /
  max 1.6, outPerTurn 600 / 1000 / 1500 / 1800 / 2200 (haiku 500), crew read factor g = 3.
  Replaces `turns` 12, `outByEffort` and `haikuOut`.
- **U is priced as unbounded ultracode agents** (full prefix + `ctxTok`, read factor 4,
  turn cap 80), so the 0.5·U crew ceiling compares like with like.
- **Turn caps per agent type** (= `maxTurns`): worker 30, worker-mcp 35, worker-ctx 30,
  implementer 60, skeptic 12, inspector 6. The type follows `typeKey`: implement →
  implementer; `ctx:keep` → worker-ctx; vector T2 → worker-mcp; else worker.
- **Parity no longer requires `ctx:'keep'`.** The rail checks only the session cell
  S·E_ref and `fb: null`; the recommended form is `ctx:'omit'` with a rules capsule and
  `path:line` pointers into the relevant CLAUDE.md sections.
- **Effort rule:** `high` only for D2 ∧ V≤1 ∧ B2. B1 units start at W·medium with `fb`
  W·high, so the one re-route exists.
- **Docs:** decomposition by work type (judgement vs inventory, consistency, mapping,
  extraction) in `routing.md`; packing limits expressed as turns under the cap instead of
  ~120k reading; the calibration card, worked envelopes and run card re-priced.

### Added
- **Turn budget in every unit prompt:** "about N tool calls (hard stop at CAP)",
  find-before-read (grep/glob first, Read line ranges with offset/limit, leave Scope only
  to resolve a reference), keep the last 2 calls for the answer, return `partial` with
  `remaining[]` when the budget runs out. The dry-run card shows each unit's `turns`.
- **Routing warning:** `routing: X% of planned work-unit spend runs on <S>; split
  mechanical work (inventory, consistency, mapping, extraction) into sonnet units`, for
  review/research with ≥3 units and a share above 70 %.
- **`calib.scale`**, a self-calibration multiplier (default 1): close passes `--ledger`
  to `stats update`, and the `CALIB` line from `stats --summary` goes back in as
  `args.calib`.
- **Implementation envelope** (`playbooks/implement.md`): dry-run price each pass, theme
  budget = estimate × 1.5, at most 2 passes + 1 diff review per theme then ask,
  `ledger-cost` after each pass, a fresh session per theme.
- `digest.money.verifyUsd`: the part of the committed spend drawn by verifiers.

## dynamic-fanout 0.1.0 — 2026-10-09

The first release of a lean, master-routed replacement for ultracode's agent fan-out.
Invoke it with `/dynamic-fanout:dynamic-fanout <task>`. It also triggers when an
ultracode or multi-agent fan-out is about to start.

### Added
- **Master-routed cards.** The main session (`effort: max`, no forced model) scores
  every unit on `D A T C V B G` (+`N`). It writes one card per subagent:
  primary model·effort `p`, one pre-chosen fallback `fb`, `ctx` (omit/keep CLAUDE.md),
  an objective `check` and a short `why`. Code never picks a model or an effort.
- **Foreman workflow** (`workflows/fanout.js`):
  - rails reject a bad plan before any agent launches;
  - U/P/R/C pricing and a commit meter, plus a kill switch on measured output;
  - four failure classes (infra / capacity / brief / capability);
  - at most **one** capability re-route per unit, onto the card's `fb`, in
    `repair` / `redo` / `rederive` mode;
  - cohort promotion onto `fb` after ≥2 failures that make up ≥25% of a cohort;
  - dedup, integer-cent invariants, digest and ledger.
- **Inspector** (sonnet·low, read-only) grounds every quoted `file:line` before a
  result is accepted. `scripts/check-evidence.mjs` re-audits in Phase 3 and can only
  downgrade a claim.
- **Verification rungs** V0–V4, declared per severity. Deterministic checks come first,
  skeptics see claims rather than narratives, and a REFUTED verdict needs a counter-quote.
- **Parity cell.** Units whose error would be invisible and consequential
  (V0 ∧ B2 ∧ D≥1) run exactly as ultracode would: S·E_ref, CLAUDE.md kept, no
  fallback, V3 verification.
- **Cost ceiling vs ultracode.** The crew ceiling is C = 0.5·U, about 0.6·U with the
  master. Parity-bound plans may lift it to at most 0.8·U. User overrides are marked
  `override:user`.
- **Price-aware solo gate** and packing rules (`references/economics.md`), with a
  calibration card that stage-0 numbers replace via `args.calib`.
- **Measured `baseCtx`.** A 2026-10-09 smoke run measured the fixed per-agent prefix at
  35–70k tokens in an MCP-heavy setup; the default moves from a 15000 prior to a
  measured 40000, and every price in `economics.md` is recomputed from it. Still
  tunable per session via `calib.baseCtx`.
- **Routing stats** (`scripts/stats.mjs`, sole writer, kept outside the repo).
  Cross-run cohorts labelled by final outcome, with ×0.9 decay. The master reads them;
  code never routes on them.
- **Scripts:** `check-evidence.mjs`, `ledger-cost.mjs` (per-unit $ from transcripts
  via `⟦df:…⟧` cost tags) and `stats.mjs`.
- **Effort-pinned agents** for the Workflow rung (`worker`, `worker-ctx`, `worker-mcp`,
  `skeptic`, `inspector`, `implementer`) and effort-tiered copies for the Agent-tool rung.
  Crew agents never inherit the skill's `max`.
- **`worker-mcp` + tool allowlists.** Units whose vector needs MCP or a long tool loop
  (T2) route to `worker-mcp`; everything else runs on `worker`/`skeptic`, which now
  declare an explicit `tools: Read, Grep, Glob, Bash` allowlist instead of inheriting
  every tool, so their fixed prefix carries no MCP tool-schema JSON.
- References: `routing.md` (the master's routing guide), `economics.md`,
  `workflow.md` (args contract v2), `schemas.md`, plus playbooks for research,
  review, data and implement.

### Deferred
- **Probes** (deliberately routing cheaper to learn a cohort) move to v0.2. Under the
  no-churn rule, v0.1 only ratchets up through cohort promotion.
- **Implement-mode helpers** beyond the `playbooks/implement.md` recipe. The master
  writes the inline script from the recipe for now.

