# Playbook — research

Load this only when `kind: 'research'`. It adds kind-specific shape to `routing.md`;
it never overrides the rails in `workflow.md`.

## When this kind applies

- The user wants an answer, explanation or map: "how does X work", "where is Y decided",
  "list every Z with file:line", "what changed between A and B".
- The output is prose plus evidence, not edits, findings-to-fix or tie-out numbers.
  Bugs → `review.md`; totals → `data.md`; changes → `implement.md`.
- Run the solo gate first. Most research questions are one reasoning chain; fan out only
  when several **independent** angles each need their own reading.

## Shape: sweep → deep-read → synthesis

| Stage | Who | Output |
|---|---|---|
| 1. Sweep | 2–4 angle units, one per independent question or subtree | candidate claims with `{file, line, quote}`, plus deep-read pointers returned in `result` via a card `schema` (e.g. `{pointers:[{file,lines,why}]}`) — `remaining[]` is only for work the unit did not finish, and a non-empty `remaining` triggers a capacity slice re-run on the same unit, not a hand-off to stage 2 |
| 2. Deep-read | 0–2 units on the top pointers, planned up front when the pointers are known, else one follow-up workflow | the claims that carry the answer, fully quoted |
| 3. Synthesis | the master, inline | the answer + confidence ledger |

- Skip stage 2 when the sweep already quotes the answer. Each extra stage re-pays fixed context.
- Synthesis is never an agent: the master holds the user's intent, and handing it off loses it.

## Decompose and pack

- One unit per **question angle**, not per file. Angles: definition site, call path,
  config/thresholds, tests that pin behaviour, docs vs code drift.
- Pack angles that read the same subtree into one unit: the nested CLAUDE.md is paid once.
- Split a unit off only if its reading is ≥2× its path's fixed context.
- Cap: planned turns under the agent's cap (worker 30): roughly ≤50k reading at high,
  ≤65k at medium, ≤95k at low, or 25 files. Over that, split by subtree; the dry-run card
  prints each unit's `turns`.
- **Peel mechanical angles into sonnet units** (`routing.md` §5): enumerations, constant
  inventories, docs-vs-code consistency and field mappings are sonnet work with a `set`
  or `quote` check; W is for the tracing and the "why". The foreman warns (`routing:`)
  when more than 70 % of planned unit spend runs on S.
- Brief ≤120 words of pointers: paths, line ranges, the exact question, the evidence format.
- Exclude duplicate, vendored or mirrored copies of the code, `.env`, key JSONs and `output/` from every scope.

## Typical vectors and cells (Opus session, E_ref = xhigh)

| Unit | Vector | p → fb | ctx · check | Why |
|---|---|---|---|---|
| Enumerate every threshold/multiplier constant with file:line | D0 A0 T1 C1 V2 B0 G0 | sonnet·low → sonnet·medium | omit · set+quote | grep count is the set-equality check |
| Trace how a row gets its action/band through the scorer | D2 A1 T1 C2 V1 B0 G1 | opus·medium → opus·high | omit · quote | C2 needs W; carries the answer, so fb |
| Which of those values the audit snapshot captures | D1 A1 T1 C1 V1 B1 G1 | opus·medium → opus·high | omit · quote+V3 | the key insight; cheap to quote-check |
| Domain-heavy reading (tax codes, entity rules) the capsule can't state | D2 A2 T1 C1 V1 B1 G2 | opus·high → null | keep · quote+V3 | G2: needs CLAUDE.md; p ≥ W·high so fb null |

Rules that matter here:
- **Units that carry the answer always get a non-null `fb`.** A wrong answer unit cannot be
  rescued by synthesis; a peripheral angle (B0, context only) may have `fb: null`.
- Research is rarely parity: V0∧B2∧D≥1 needs a consequential, uncheckable claim. If the
  answer drives a booking or deploy decision, treat that unit as parity (S·E_ref,
  `fb:null`, `ctx:omit` with a capsule and CLAUDE.md pointers).
- **Recall rule:** when the question is "what is there / what is wrong", score V by whether a
  *missed* item would be noticed. If not, the unit is V0 for routing even when each finding
  is quote-checkable, so it does not go to Sonnet. Give a parity or B2 research unit
  `lenses: 2` (inputs and data / time and ordering) to widen what it finds.
- **Severity rubric** (producers and skeptics, `SEVERITY_RUBRIC` in fanout.js): blocker =
  wrong customer-facing money or legal action, or data loss, in normal operation; high = a
  wrong outcome is likely in realistic cases; medium = edge cases or a real operational
  risk; low = minor; info = an observation. Rate by what the code does today:
  most findings are medium or low (a blind audit found 61% filed too high, often by two
  levels). The
  skeptic states its own `verifiedSeverity`; `report.mjs` shows `filed->verified`.
- `check` always contains `quote` for claim-producing units, so the inspector grounds every
  `{file, line, quote}` before a claim is accepted. A cited file outside `files_read` is a
  capability failure, not a style nit.
- Keep the sweep on ≤2 cells (e.g. sonnet·low + opus·medium) so siblings share the cache.

## Verification

Declare in `verify`:

```js
verify: {
  rungs: { blocker: 'V3', high: 'V3', medium: 'V2', low: 'V0', info: 'V0' },
  cells: { V3: { effort: 'high' } },     // W·high; model omitted = S on an Opus session
  topK: 8, batch: 3,
  expected: 5                             // ≈ ceil(nUnits·highsPerUnit / batch) for the
                                           //   claims that carry the answer + ceil(topK / batch) for mediums
}
```

- Severity in research = how much the claim carries the answer: `high` for the claims the
  answer rests on, `medium` for supporting context, `low`/`info` for background.
- V1 (inspector quote check) runs for every claim with a quote; it is the main defence
  against confident fabrication, which is the dominant research failure. Since 0.1.4 the
  **default rung for medium is V2**: a supporting-context claim also gets one lean skeptic
  (within `topK`), whose CONFIRMED must carry its own support quote or, for an absence
  claim, the empty search it ran. Lower it (`rungs.medium: 'V1'`) only for background-heavy
  questions.
- Cross-file or causal claims ("X is set here and read there") go to V3; single-site
  lookups stay at V1. Mark them `high`, not `medium`, if they carry the answer — a `high`
  severity is what exempts a claim from `topK` and reserves it a skeptic by default.
- Sweep: `standard` → `rounds: 1` on the cheapest W cell, asking "what did the sweep miss
  that the question needs?". `quick` → 0. `deep` → 2 plus the completeness critic.

## Synthesis checklist (master)

- Answer first, then the evidence table: claim · file:line · verdict.
- Mark every claim CONFIRMED / PLAUSIBLE / REFUTED / UNVERIFIED with its reason; never drop
  an UNVERIFIED claim silently.
- If two units disagree, spot-read ≤60 lines once; otherwise report both and say why.
- Cost ledger as in SKILL.md; note which unit's `why` was wrong if any unit was re-routed.
