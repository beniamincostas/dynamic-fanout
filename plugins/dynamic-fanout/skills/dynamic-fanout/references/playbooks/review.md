# Playbook — review / audit

Load this only when `kind: 'review'`. It adds kind-specific shape to `routing.md`;
it never overrides the rails in `workflow.md`.

## When this kind applies

- The user wants defects found: correctness bugs, risky logic, config drift, audit gaps,
  with file:line and a failure scenario.
- Also the diff-review stage of implement mode (`kind: 'review'` called from the inline script).
- **Pure code review of a repo, branch or PR → defer to a dedicated code-review skill if one
  is installed.** It owns scope resolution, finder angles and fixes; duplicating it here costs
  more and finds less. Use this playbook when the review mixes code with domain rules, data,
  or docs, or when no such skill is available.

## Shape: dimensions → dedup → verification by rung

1. **Work:** one unit per dimension × file cluster (packed). Each returns ≤8 findings
   `{title, severity, claim, evidence: ≤4 × {file, line, quote}}`; put the failure
   scenario in `claim`.
2. **Dedup** (the one barrier): the foreman merges on `reduce.dedupKey` and keeps `mergedFrom`.
3. **Verify:** per the declared rungs, deterministic first; skeptics see the claim and its
   evidence pointers, never the producer's narrative.
4. **Sweep:** a fresh look for what the dimensions missed (standard 1 round, deep 2 + critic).

## Decompose and pack

- Dimensions to choose from: money path, state/idempotency, external API contract,
  error handling, config/deploy, rendering/output, tests vs behaviour, security.
  Drop a dimension the scope cannot exhibit; do not pad.
- Pack dimensions that read the same files into one unit; split by subtree, not by angle,
  when one file cluster would push planned turns to the cap (see below) or exceeds 25 files.
- Split a unit off only if its reading is ≥2× its path's fixed context. A ~1.2k-line module
  is usually solo or ≤3 agents.
- **Split by work type, not only by subsystem** (`routing.md` §5). Peel the mechanical
  sub-tasks of each dimension into sonnet units with a deterministic check: inventory
  (every call site, option or constant), consistency (docs vs code, config vs schema),
  mapping, extraction. Keep W for the judgement. The foreman warns (`routing:`) when more
  than 70 % of planned unit spend runs on S.
- **Size units so planned turns stay under the cap** (worker 30): roughly ≤50k reading
  at high, ≤65k at medium. The dry-run card prints `turns`; a unit at its cap is too big.
- Briefs name the files, the dimension, and the known false-positive traps the master already
  knows (e.g. a deliberate delay that looks like a race).

## Typical vectors and cells (Opus session, E_ref = xhigh)

| Unit | Vector | p → fb | ctx · check | Why |
|---|---|---|---|---|
| Money path: state + bank import + payment lookup, packed | D2 A1 T1 C1 V0 B2 G2 | **opus·xhigh (parity)** → null | omit + capsule · V3 | recall unverifiable; a wrong post double-marks paid |
| Deploy path: workflow + Dockerfile + env wiring | D1 A1 T1 C1 V0 B2 G1 | **opus·xhigh (parity)** → null | omit + capsule · V3 | a missed deploy break is invisible until prod |
| Retry/timeout logic in a deployed service | D2 A1 T1 C1 V1 B1 G1 | opus·medium → opus·high | omit · quote | B1: medium with a real fb, not high |
| Docs vs code: every documented option exists and behaves as stated | D1 A0 T1 C1 V2 B0 G0 | sonnet·medium → opus·high | omit · set+quote | mechanical consistency, peeled off the judgement units |
| Rendering: payload/report formatting with fixtures | D1 A0 T1 C1 V1 B1 G0 | sonnet·medium → opus·high | omit · tests+quote | fixtures catch it |
| Constant/option sets defined vs compared | D0 A0 T1 C1 V2 B0 G0 | sonnet·low → sonnet·medium | omit · set | grep set-equality catches misses |

- **Money-path and deploy-path units usually land in the parity cell** (V0∧B2∧D≥1): recall
  cannot be checked and a miss is consequential. Run them on ultracode's cell: S·E_ref,
  `fb: null`, claims at V3, with `ctx:'omit'` plus a rules capsule and `path:line`
  pointers into the relevant CLAUDE.md sections. Never downgrade them to fit the ceiling;
  pack harder or set `caps.parityBound`.
- "Deployed code" alone is B1, not B2: B2 means booked numbers, money movement or a
  deploy break that is invisible until production.
- Everything cheaper than parity must name the check that catches its failure (`tests`,
  `set`, `quote`). `check: 'none'` outside parity is rejected.
- A review unit that carries the conclusion and is not parity gets a non-null `fb` (W·high).

## dedupKey

- Default `reduce.dedupKey: ['file', 'line']`: two dimensions often hit the same line
  (line is bucketed to groups of 4, so near-miss line numbers still merge).
- Supported keys are only `'file'`, `'line'` and `'title'` — an unknown key (e.g. `'symbol'`)
  is silently ignored, so `['file', 'symbol']` keys on the file alone and merges every
  finding in that file into one claim. When line numbers shift across units reading
  different revisions, use `['file', 'title']` instead.
- Add `'title'` only when one line legitimately carries two distinct defects; otherwise it
  splits duplicates on wording.
- Dedup runs before verification so each merged claim is verified once, at the highest
  rung any of its sources asked for.

## Verification

```js
verify: {
  rungs: { blocker: 'V3', high: 'V3', medium: 'V2', low: 'V0', info: 'V0' },
  cells: { V3: { effort: 'high' } },     // W·high; parity claims run S·high automatically
  topK: 12, batch: 3,
  expected: 8                             // ≈ ceil(nUnits·highsPerUnit / batch) for highs
                                           //   + ceil(min(nUnits·4, topK) / batch) for mediums
}
```

- V1 first: the inspector grounds every quote; tests or a grep count replace a skeptic
  whenever they decide the claim. **`medium` defaults to V2** since 0.1.4 — one skeptic at
  the producer's model·medium — because lean skeptics read through Bash and cost a
  fraction of what they did; a review still produces ~4 mediums per unit, so `topK`
  bounds how many get one. Drop to V1 (`rungs.medium: 'V1'`) only when mediums are noise.
- A skeptic's CONFIRMED needs its own support quote (or, for "X is missing", the empty
  search it ran); without one the foreman keeps the finding PLAUSIBLE.
- Rungs come from `verify.rungs` by severity (blocker/high default V3, medium V2), not from
  depth on their own. `quick`: nothing to lower further at the default. `standard`: the
  defaults above. `deep`: give the units whose findings drive the recommendation a `V4`
  token in `check` — `check` can name `V2`/`V3`/`V4` to floor that unit's claims there
  regardless of severity (claim rung = `max(verify.rungs[severity] + bump, floor)`, parity
  always ≥V3, capped at V4); or rely on the +1 bumps (ok-rerouted, confidence <0.5, which
  stack).
- REFUTED needs a `counter_quote`; without one it stays PLAUSIBLE.
- Claims past `topK` are UNVERIFIED `topK` and listed in `digest.dropped`; report them, do not drop them.
- Sweep: default cell is W·medium (clamped to E_ref); `standard` → `rounds: 1`, `deep` → 2
  plus the completeness critic. Set `sweep.cell` to the V3 cell explicitly if you want
  sweep findings checked there too.

## Report checklist (master)

- Findings by severity: file:line, scenario, verdict, and the unit's `why` if it was re-routed.
- A separate UNVERIFIED list with reasons (`budget`, `topK`, `split`, `infra`). For
  `budget`, run `stage:'verify'` with those claims rather than re-verifying them yourself.
- Note any known false-positive trap you pre-empted in the briefs.
