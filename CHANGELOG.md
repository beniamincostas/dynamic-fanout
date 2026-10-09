# Changelog

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

