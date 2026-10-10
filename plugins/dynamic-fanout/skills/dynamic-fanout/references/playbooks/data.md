# Playbook — data / finance analysis

Load this only when `kind: 'data'`. It adds kind-specific shape to `routing.md`;
it never overrides the rails in `workflow.md`.

## When this kind applies

- The answer is numbers: row counts, totals by code/period/entity, tie-outs between two
  sources, duplicates, negatives, out-of-period rows, price-vs-invoice checks.
- Sources: CSV/XLSX on disk, read-only SQL (the data warehouse via MCP, the ERP read-only), read-only APIs.
- If the question is "is this formula/mapping right?" with no numbers, it is `review`.

## Ground rules (why they exist)

- **Workers compute with code, never by eye.** Each unit runs `python3` or SQL and returns
  every amount as a **decimal string** (`"1234.50"`) under a stable name in `numbers`, plus
  `method` (one line) and `script` (the code it ran). Floats and LLM arithmetic drift.
- **The foreman sums in integer cents.** Never pre-round or format in the worker.
- **Read-only access only.** SELECT-only SQL; no POST/PUT/PATCH/DELETE; never print
  credentials. Put these in the rules capsule, they are not optional.
- **Haiku never runs MCP or tools.** The rails reject it; route MCP work to sonnet or W.
- **Identical queries are deduped:** if two units need the same extract, make one unit
  produce it and let the other reference it by name. Two copies of the same query cannot
  check each other.

## Decompose and pack

| Unit type | What it does | Typical cell |
|---|---|---|
| Extract + compute (N) | load, filter, aggregate; returns `numbers` | sonnet·medium when formats are pinned |
| Re-derivation (planned) | the same totals by a **different method** | `rd` cell on the same card |
| Semantic (W) | tax-code reading, join choice, sign convention, period rule | W·high when B2 (else W·medium → W·high), `ctx:'keep'` only when G2 |
| Anomaly scan | duplicates, negatives, out-of-period, gaps | sonnet·low/medium, `check: 'set'` |

- Pack one file family (e.g. invoices + credit notes for one month) into one compute unit; split by
  source, not by metric. Keep planned turns under the agent's cap (worker 30, worker-mcp
  35): roughly ≤65k reading at medium, ≤50k at high, or 25 files; the dry-run card prints
  each unit's `turns`.
- **Semantic questions are separate W units.** A tie-out proves arithmetic, not
  semantics: a wrong tax_code reading or a wrong join still ties out perfectly.

## Every n=1 unit has a planned re-derivation

- Set `n: 1` and `check` containing `rederive` (the rail rejects n=1 without it).
- `rd` = the re-derivation cell; default = `p`. Pick a **different method**, not a
  different model: pandas groupby vs a csv-module loop; SQL `SUM` vs per-row fetch +
  local sum; an alternate join key vs the primary-key join.
- An exact integer-cent match is CONFIRMED, with no opinion needed.
- A mismatch is a capability failure: it spends the unit's **one** re-route on `fb` in
  `rederive` mode. A match with either earlier derivation is CONFIRMED; otherwise the unit
  is UNVERIFIED with both numbers shown.

## Typical vectors and cells (Opus session, E_ref = xhigh)

| Unit | Vector | p → fb (rd) | ctx · check | Why |
|---|---|---|---|---|
| Billing export for one month: rows, totals by tax_code, dup doc_no, negatives | D1 A0 T1 C1 V2 B2 G1 N | sonnet·medium → opus·high (rd sonnet·medium) | omit · tieout+rederive | integer cents; spec pins the delimiter, encoding and date format |
| Tax formula per tax_code vs the tax-rules reference | D2 A1 T1 C1 V1 B2 G2 | opus·high → null | keep · V3 | tax-code semantics and sign conventions: a wrong reading still ties out |
| Data warehouse (MCP): contract price vs invoiced price, one region-month | D2 A1 T2 C1 V1 B1 G2 N | opus·medium → opus·high (rd opus·medium) | keep · tieout+rederive | wrong join returns clean numbers (e.g. a placeholder/default key) |

## reduce.invariants

Declare the tie-outs the foreman checks in integer cents after all units finish:

```js
reduce: {
  dedupKey: ['file', 'line'],
  invariants: [
    { name: 'AR total = sum by code', lhs: 'u1.total',        rhs: 'sum(u1.by_code.)', tolCents: 0 },
    { name: 'AR = revenue journal total',      lhs: 'u1.total',        rhs: 'u3.revenue_total', tolCents: 0 },
    { name: 'row count',              lhs: 'u1.rows',         rhs: 'u2.rows',          tolCents: 0 }
  ]
}
```

- `u1.total` = a named number from unit u1; `sum(u1.by_code.)` = every number in u1 whose
  name starts with `by_code.` (keep the trailing dot).
- Name numbers in the brief so units agree (`total`, `rows`, `by_code.<code>`).
- An invariant failure is reported in `digest.invariants`; it never re-routes. The master
  decides which side is wrong (often a semantic unit) and says so.
- `tolCents: 0` unless rounding is part of the spec (then state why on the card).

## Verification

```js
verify: { rungs: { blocker: 'V3', high: 'V3', medium: 'V1', low: 'V0', info: 'V0' },
          cells: { V3: { effort: 'high' } }, topK: 8, batch: 3, expected: 1 }
```

- Numbers are verified by tie-out and re-derivation (V1), not by skeptics; `medium`'s V1
  default costs nothing extra on top of that. `expected` counts only the semantic claims
  that need V3 — raise a mismatch or a borderline reading to `medium: 'V2'`/`check: 'V2'`
  only if a skeptic (not a re-derivation) is the right check for it.
- Sweep: usually `rounds: 0`; the anomaly scan is the sweep. At deep, 1 round asking
  which population the totals could have missed (filters, periods, entities).
- Report: each number with its method, verdict, and both values on any mismatch.
