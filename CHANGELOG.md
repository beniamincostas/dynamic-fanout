# Changelog

## dynamic-fanout 0.1.5 — 2026-10-21

Two measurements since 0.1.4. **Seven production runs (208 agents):** the lean Bash read
path works (0 nested CLAUDE.md attachments), but 3 re-routes were refused for budget after
"cited but not read" failures — agents that read through Bash cite files they grepped
without listing them in `files_read` — and 32 claims were then marked UNVERIFIED unchecked
(one master re-queued 16 by hand). One run declared every rung V0, so 5 high findings were
never checked. Parity raised low and info claims to V3, and `topK` then cut 20 claims,
including 9 mediums. Positional `$N` argument substitution mangled dollar amounts in
SKILL.md. A deep verify stage with 109 claims needed a hand-written 141 KB wrapper script.
Master turns at 600–855k tokens of context cost about USD 0.40 each; the master was about
43% of a deep run. Estimate/actual ranged 0.77–2.8×; the learned work factor went
0.6 → 1.04 → 0.81. **A blind quality audit** (46 sampled findings re-judged by reference
judges on ultracode's own cell; recall on 2 scopes by two blind reviewers each plus an
adjudicator): 0 of 42 non-refuted findings were false; 30% were overstated (real mechanism,
overstated trigger or impact); CONFIRMED and PLAUSIBLE were equally often true; 61% were
filed too high, often by two levels; recall was 60% for an opus·xhigh unit and 41% for a
sonnet·medium unit against the blind reviewers (the run also found real issues they
missed); a unit that stopped at the 8-finding cap missed 6 real issues; two
differently-focused reviewers overlapped little (26 issues merged into 17).

- **Recall rule** (SKILL.md, routing.md, review/research playbooks): score V by whether a
  missed issue would be noticed; if not, the unit routes as V0 and does not go to Sonnet.
- **`lenses: 2`** runs a review/research card as two copies (inputs and data / time and
  ordering), each priced, inspected and re-routed on its own; dedup merges them.
- **Findings cap 15** (was 8); `mediumsPerUnit` 4 → 5. One **severity rubric** for
  producers and skeptics; VERDICT `severity` is required and stored as `verifiedSeverity`,
  which orders `digest.top` and `digest.counts.bySeverity`.
- **Cited but not read:** a cited file with an inspector-resolved quote counts as read;
  without an inspector it is only a soft signal. A unit that ends unverified has its
  grounded claims **rescued** to verification one rung higher (`digest.counts.rescued`).
- **`verify.waiver`:** high/blocker below V2 is a rails error unless a waiver (≤200 chars)
  states why; echoed in the card and digest.
- **Parity floor** V3 only for medium and above. Inspector quotes per call 40 → 60.
- **Pricing:** `rerouteRate` 0.1 → 0.2 (7 capability failures in 44 units); `scaleByRole`
  `{work: 1.0, verify: 0.3, inspect: 0.3, sweep: 2.0, implement: 3.5}` with implementers on
  their own `implement` role; implement `args.calib` passes learned factors through.
- **report.mjs:** a PLAUSIBLE legend, `filed->verified` severity, header counts by
  `verifiedSeverity ?? severity`.
- **SKILL.md:** amounts written as `USD 40.53` (a docs test rejects a dollar sign before a
  digit); the run card has a `master:` line (planned master turns × current context ×
  cache-read price; above ~300k suggest `/compact` or a fresh session).
- **workflow.md:** `lenses`, `verify.waiver`, and the deep-verify wrapper pattern (a script
  that embeds ARGS and returns `await workflow('dynamic-fanout:fanout', ARGS)`, launched
  with Workflow `scriptPath`).
- **Whole-diff review follow-ups** (the build's reviewer said NEEDS CHANGES):
  - a rescued claim always gets a skeptic (rung floor V2), so a failed unit's low findings
    are not passed as PLAUSIBLE on quotes alone;
  - `lenses: 2` is refused on an allow-up card, which would otherwise run two above-session
    agents past the at-most-one rail;
  - the implement calibration reads the implementers' own tags, so inspector cost is no
    longer counted under both `implement` and `inspect`;
  - the implement reviewer sees up to 4000 characters per brief (1500 cut it off);
  - the economics.md defaults block states the new priors, and a docs test now checks every
    `scaleByRole` literal there;
  - tests cover rescue after a re-route that returned nothing and after a fallback that
    failed again.

## dynamic-fanout 0.1.4 — 2026-10-12

A 23-agent research run showed where the crew's money really went. `omitClaudeMd: true`
drops only the CLAUDE.md files loaded at agent start; whenever an agent uses the **Read**
tool, Claude Code attaches every CLAUDE.md between the session cwd and that file as
nested memory. A ~350 KB nested CLAUDE.md pushed 15 of 23 lean agents from ~8k to ~150k
tokens of context — about 2/3 of the crew's cost. A probe confirmed that Read attaches
it and Bash (`nl -ba FILE | sed -n 'A,Bp'`, `grep -n`) does not. The price model had
been fitted to that leak: `readFactor` 4 ("context grows 4–5× the planned reading") was
mostly the attached CLAUDE.md; without it workers read 5–24k tokens in 4–16 API turns.
The same run exposed a calibration double count (a legacy global `calib.scale` of 1.28
passed on top of per-role factors that already contained it), a gap sweep priced like a
full work unit ($3.73 estimate vs $0.35 actual), ~10 master shell calls to dig claims out
of the result JSON, and evidence cited both absolute and repo-relative for one file.

### Changed
- **The lean crew reads through Bash, not Read.** `worker`, `worker-low/medium/high`,
  `skeptic`, `skeptic-high`, `inspector` and `reviewer` carry `Grep, Glob, Bash`;
  `worker-mcp` disallows Read; `worker-ctx*` and `implementer*` keep Read. Agent bodies,
  unit, inspector and skeptic prompts carry a short read recipe (`grep -n`,
  `nl -ba | sed -n` ranges) and a defined outcome when Bash is refused (`blocked`,
  `no_access`). **Requirement:** read-only Bash in subagents (auto mode, or allow rules
  for `nl`, `sed -n`, `grep`).
- **Price model 3** (`PRICE_MODEL` in `fanout.js`), refitted without the leak:
  `baseCtxLean` 8000 → 11000, `readFactor` 4 → 1 (`ultraReadFactor` stays 4: ultracode's
  agents use Read), `verifierInFrac` 0.5 → 0.25, new `sweepInFrac` 0.25, and
  `scaleByRole` `{work 0.6, verify 0.35, inspect 0.5, sweep 0.8}`. The measured fit was
  work 0.41 / verify 0.19 / inspect 0.25 / sweep 0.72; the priors sit above it on purpose,
  because under-estimating drains the work pool and starves verification.
- **The gap sweep is its own role** (`sweep`), priced at `inAvg × sweepInFrac`.
- **Calibration is keyed by price model.** `card.calib` carries `pm`; `calibrate()`
  honours `scale`/`scaleByRole` only from the current price model and warns otherwise.
  `stats.mjs` uses `scaleByRole[role] × scale` as the factor a run was priced with (no
  double count), archives a calib from another price model, blends a role's first
  observation from that factor, and `--summary` prints `CALIB {"pm":3,...}` only for the
  current price model — the master passes it verbatim as `args.calib`.
- **`medium` defaults to V2 again** (V1 since 0.1.2): lean skeptics are cheap, so every
  medium within `topK` gets one.
- **CONFIRMED needs the skeptic's own support.** VERDICT gains `support {file, line,
  quote}` and `support_cmd` (the empty search, for an absence claim); a CONFIRMED with
  neither is kept as PLAUSIBLE, and `check-evidence.mjs` drops a CONFIRMED whose support
  quote does not resolve. Support is carried on claims, in results and in `digest.top`.
- **Evidence paths are canonicalized** to their Scope spelling at claim intake (unit
  findings, sweep claims, `counter_quote`, `support`), so one file cited absolute and
  repo-relative dedups to one claim.
- `implement.js` passes a theme's `ctxTok` through to its pricing card.
- **Dedup merges only the same issue.** A smoke review showed the 4-line bucket folding
  distinct bugs on adjacent lines into one claim ("divides by zero" into "loses remainder
  cents") and dropping the second one unverified. Two claims now merge only when they come
  from different producers, sit at most 3 lines apart, and cite the exact same line or have
  alike titles; the sweep's "already known" check uses the same test. Merged claims keep
  their titles in `merged`, and `report.mjs` prints them.
- **The whole-diff reviewer sees whole briefs** (whitespace collapsed, ≤1500 chars), not
  just their first line: it had flagged items 2..n of a multi-item brief as scope creep.

### Added
- `scripts/report.mjs`: one-call view of a run's output (header, per-unit rows, claims by
  severity with support; `--unit`, `--min-severity`, `--verdict`, `--payload`, `--json`).
  The close command now ends with it.
- `scripts/claude-md-chain.mjs`: lists the CLAUDE.md chain a Read-capable agent gets
  attached for given paths, with bytes and tokens — the per-unit `ctxTok` of a
  `ctx:'keep'` card.
- SKILL.md: scouting measures each unit's chain; a "large master context" note (plan in at
  most 3 turns, read results only through `report.mjs`).
- Tests: `agents.test.mjs` (tool rules, rung-copy identity), `claude-md-chain.test.mjs`,
  `report.test.mjs`, `docs.test.mjs` (docs state the defaults the code uses).

### Validated
- Built with the shipped implement workflow: 5 themes, all green on the first attempt, plus
  one whole-diff review — $12.38 actual against a $20.18 estimate (0.1.3 price model).
- End-to-end smoke review of this branch on a fixture whose subfolder holds a ~43k-token
  CLAUDE.md: 0 of 7 agents had it attached (the Read tool was never used), contexts stayed
  at 4–9k tokens, all 3 planted high-severity bugs came back CONFIRMED with the skeptic's
  own support quote (3/3 resolved), the one correct boundary was not flagged, and the crew
  cost $0.20. The same run exposed the dedup fold fixed above.

## dynamic-fanout 0.1.3 — 2026-10-11

Implement mode had been a playbook recipe the master hand-wrote into an inline Workflow
script on every run — nearly the same implementation workflow twice. 0.1.3 moves the cost
envelope and the pass cap out of prose and into code: `dynamic-fanout:implement`
(`workflows/implement.js`), a dedicated workflow the master calls with args v1 instead of
writing a script.

A real implementation cycle on a live service measured it: 7 serial test-first fixes
(opus·medium implementers, one repair pass each on a pre-chosen `fb`, full-suite gate)
cost **$10.13** against a **$20–25** estimate and worked well. Two of the seven themes
needed their repair pass (one first attempt returned nothing). The suite grew by 46 tests
across the run. The final whole-diff review, run on the 'skeptic' agent, hit its 12-turn
cap before it could report and needed a nudge mid-review to finish — a whole-PR review
needs a bigger budget than checking one claim.

### Added
- **`dynamic-fanout:implement` workflow** (`workflows/implement.js`): args v1 (`session`,
  `worktree`, `testCmd`, `commitPrefix`, `baseline`, `shared`, `themes[]`, `review`,
  `caps`). It prices every theme through one `dynamic-fanout:fanout` dry run
  (`kind: 'implement'`), so implement and fan-out estimates share one price model; runs
  each theme serially, test-first, on `dynamic-fanout:implementer`; gates on the baseline
  suite staying green; and allows **at most one repair pass per theme**, on that theme's
  own pre-chosen `fb`, never a third attempt.
- **`dynamic-fanout:reviewer` agent** (`agents/reviewer.md`, 30-turn cap): an independent
  whole-diff review over the run's own commits, judging each intended change
  FIXED/PARTIAL/NOT FIXED/NOT CHECKED with file:line and test coverage, naming
  regressions and new risks, and closing with SAFE TO MERGE or NEEDS CHANGES. Priced
  conservatively at `1.5×` the largest single theme estimate and reserved out of the
  budget before any theme launches, so a repair pass can never spend the money the merge
  gate needs.
- **Per-launch metering against a hard ceiling**: every theme attempt and the review are
  checked against `caps.ceilingUsd` as they run (not only once at plan time); a launch
  that no longer fits is refused with reason `budget` instead of running over.

### Changed
- **`skills/dynamic-fanout/references/playbooks/implement.md`** rewritten around the
  shipped workflow: the args v1 contract, the worktree + baseline recipe, the priced card
  per theme, the envelope now enforced in code, and the reviewer agent. The old
  "write an inline Workflow script" recipe is kept only as a short fallback, for a shape
  args v1 genuinely cannot express (for example themes that must run in parallel
  worktrees).
- **`SKILL.md`** (Launch, implement mode): the master now builds implement args v1 and
  calls `Workflow({ name: 'dynamic-fanout:implement', args })`, `dryRun` first, shows the
  priced card, confirms with the user, and asks again before any merge or deploy — rather
  than writing the inline script itself.
- **`references/workflow.md`**: a short `dynamic-fanout:implement` section describing the
  real run (the dry-run-only `kind:'implement'` card stays fanout's own pricing tool),
  and `dynamic-fanout:reviewer` added to the agent-type table (30-turn cap, lean prefix).
- **`references/routing.md`**: whole-diff reviews route to the reviewer agent, not a
  skeptic — a skeptic's 12-turn cap suits one claim's evidence, not a whole PR.

## dynamic-fanout 0.1.2 — 2026-10-10

Validation run on 0.1.1 (a review, 8 units, 69 findings: 7 high / 34 medium): the plan
estimated $15.29 for the crew, the crew actually spent **$19.89** (**$21.59** total with
the master), 0/25 agents over their turn cap. By role, estimate vs actual: **workers
$10.42 → $17.29** (ratio 1.66 at `readFactor` 3 — context still grew ~5× the planned
reading within ≤30 turns even though every agent was turn-capped), **skeptics $3.31 →
$1.31** (0.40), **inspectors $1.77 → $1.28** (0.72). Sonnet cost $7.26, Opus $12.63. Only
6 of the 69 findings got verified, because the master planned 4 verifier batches and
`topK: 8` while the 1.3× work overrun drained the pool before verification ran. A
separate verify-only pass of those 4 highs cost **$0.63 against a $3.31 estimate**
(ratio 0.19) and confirmed all 4. A single global `calib.scale` (1.28, the blend of
these) would have priced skeptics **~4× too expensive** and workers barely corrected —
the error is per-role, not global.

### Fixed
- **One global `calib.scale` mis-prices every role in the same direction.** Workers ran
  over, skeptics and inspectors ran under; blending them into one multiplier punished
  verification (already starved) to compensate for work overruns it didn't cause.
- **Verification reserve drained by `topK`, not risk.** With `medium` defaulting to `V2`,
  a review with ~4 mediums/unit put far more claims through a skeptic than `expected`
  ever reserved for, so `topK` — not severity — decided what got checked.

### Changed
- **Per-role calibration supersedes the single `calib.scale`.** `DEFAULT_CALIB.scaleByRole
  = { work: 1.3, verify: 0.3, inspect: 0.7 }`, seeded from the ratios above; `estUsd`
  multiplies by `scaleByRole[role]` (work/verify/inspect, from each agent type's
  `ROLE_OF`) and then by the now-neutral global `scale`. `stats.mjs` learns
  `scaleByRole` the same way it learned `scale`: `--ledger <ledger-cost.mjs --json>`
  compares each role's actual (its `byKind` totals: work pulls in `sweep`+`critic`) to
  its estimate, clamps the ratio to [0.1, 10], multiplies by the `scaleByRole` the run
  actually priced with (`card.calib.scaleByRole`) to get that observation's target, and
  folds it into `stats.calib.scaleByRole[role]` as an EWMA (α 0.5). The first per-role
  write parks the old global value at `calib.legacyScale` and resets `calib.scale` to 1
  (its neutral value); a `--ledger` file with no `byKind` still drives the old global
  path unchanged. `stats --summary` now prints `CALIB {"scaleByRole":{...}}` (the plain
  `"scale"` included only when it differs from 1), and the card records the factors it
  was priced with as `card.calib: {scale, scaleByRole}` so `stats.mjs` can compare like
  with like.
- **`readFactor` 3 → 4.** Even turn-capped agents with a targeted-reading prompt grew
  their context to ~4–5× the planned reading; workers alone still ran 1.66× over
  estimate at `readFactor` 3. The ultracode-equivalent `ultraReadFactor` was already 4.
- **`medium` defaults to `V1`, not `V2`.** A grounded, inspector-checked quote is the
  default bar for a medium finding; it no longer spends a skeptic call by default. Raise
  a medium to `V2` explicitly — via `verify.rungs.medium` or a `V2` token in that unit's
  `check` — when those findings matter enough to verify. Measured: ~4 mediums per unit,
  so `V2` on all of them let `topK` decide verification coverage instead of severity.
- **Verification sizing is risk-weighted, not a flat `ceil(n/k)`.** `verify.expected`
  (when the master omits it) is now `highs + mediums`: `highs = ceil(nUnits ×
  highsPerUnit / batch)` (every expected high is checked — highs are exempt from
  `topK`); `mediums = ceil(min(nUnits × mediumsPerUnit, topK) / batch)`, and only when
  `verify.rungs.medium` is `V2` or above (0 at the new `V1` default). New calibration
  constants `highsPerUnit: 0.9`, `mediumsPerUnit: 4`, measured on the same review (7
  high + 34 medium from 8 units). `topKExempt` likewise now exempts any claim whose
  severity is high/blocker **and** whose rung is V3+, not only parity claims.
- **Reading budget is now a number, not just a turn count.** Every unit prompt adds
  `Reading budget: about <in/12> lines in total (~<in> tokens); each Read at most ~250
  lines`, alongside the existing tool-call budget — a turn cap bounds calls, not how much
  of a file one `Read` pulls in.
- **The card records its own pricing factors.** `buildCard` adds `calib: {scale,
  scaleByRole}`, the exact numbers that run's estimates used, so a later `stats.mjs
  update --ledger` compares that run's actual against what it was *actually* priced
  with, not against whatever the default happens to be when `stats` runs.

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

