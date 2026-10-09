# Playbook — implement

Load this only when `kind: 'implement'`. **The foreman does not edit files**, so the master
writes one inline Workflow script from this recipe, using the same card format and rails.

## When this kind applies

- Code or config must change (feature, fix, mapping, fixtures) in ≥2 independent units;
  one coherent change is solo.
- The run card **always pauses** in implement mode: show cells, files, gate and worktree
  decision, and wait for `go`.

## Recipe (master, in order)

1. **Baseline test run first** (master, one Bash call): record the command and the ids of
   tests already failing. The gate is **"no new failures"**, so pre-existing reds never
   trigger a re-route.
2. **Validate the cards**: call `dynamic-fanout:fanout` with `kind: 'implement'`,
   `dryRun: true` and the unit cards. It runs the rails and prices U/P/R/C without launching.
3. **Isolation decision.** Use a worktree only if **all** hold: inside a git repo, clean
   tree, the units' files are disjoint, and ≥3 units. Otherwise run the units **serially
   in place** — a worktree costs setup and a merge, and pays off only for parallel writers.
4. **Run the inline script** below. Each implementer (`dynamic-fanout:implementer`,
   `ctx: 'keep'`) edits its scope and runs the tests **inside its own run**, then returns
   the failing test ids.
5. **Gate** in code: new failures = returned failing − baseline failing. A gate failure
   spends the unit's **one** re-route: `fb` in `repair` mode with the failing output. A
   second failure, or `fb: null` → UNVERIFIED → master. Never a third attempt.
6. **Diff review**: one reviewer unit on the V3 cell (W·high) over the combined changed
   files, via `workflow('dynamic-fanout:fanout', { ...reviewArgs, kind: 'review' })`.
   Its blocker/high findings are verified at V3. One nesting level is allowed.
7. **Master closes**: merge worktree branches (if any), re-run the baseline once on the
   merged tree, then the step-7 close scripts and the ledgers (SKILL.md §7).

## Typical vectors and cells (Opus session, E_ref = xhigh)

| Unit | Vector | p → fb | ctx · check | Why |
|---|---|---|---|---|
| Add a column + fixtures to an exact spec | D1 A0 T1 C1 V2 B1 G0 | sonnet·medium → opus·high | keep · tests | the tests are the check |
| Category mapping with a default-bucket fallback | D2 A1 T1 C1 V1 B2 G1 | opus·high → null | keep · tests+V3 | booked; its own tests share its blind spots |
| Rename/move across call sites | D0 A0 T1 C1 V2 B0 G0 | sonnet·low → sonnet·medium | keep · tests+set | grep count + tests catch misses |

- B2 implementation logic → W·high; mechanical edits to an exact spec → sonnet. The
  implementer always keeps CLAUDE.md: project rules (formats, read-only clients) live there.
- `check` contains `tests` on every unit; B2 units add `V3` because a unit's own tests
  share its blind spots.

## Inline script skeleton

Plain JS, literal `meta`, no `Date.now()`/`Math.random()`; cells come only from the cards.

```js
export const meta = {
  name: 'df-implement',
  description: 'dynamic-fanout implement: card-routed edits, test gate, one diff review',
  phases: [{ title: 'Implement' }, { title: 'Review' }],
}
// args: { shared, units:[card+brief], baseline:{ cmd, failing:[] }, worktree:bool, reviewArgs }
const A = args
const RESULT = { type: 'object', required: ['status', 'files_changed', 'tests', 'summary'],
  properties: {
    status: { type: 'string', enum: ['ok', 'partial', 'blocked'] }, blocked_reason: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    tests: { type: 'object', required: ['cmd', 'failing'], properties: {
      cmd: { type: 'string' }, failing: { type: 'array', items: { type: 'string' } } } },
    summary: { type: 'string', maxLength: 300 } } }

const opts = (cell, u, n, typed = true) => ({
  ...(cell.model ? { model: cell.model } : {}),          // omitted = session model S
  effort: cell.effort,                                    // implementers are never haiku
  ...(typed ? { agentType: 'dynamic-fanout:implementer' } : {}),
  ...(A.worktree ? { isolation: 'worktree' } : {}),
  schema: RESULT, label: `${u.id}#${n}`, phase: 'Implement' })
const prompt = (u, n, extra) => [A.shared, u.brief, extra || '',
  `Run \`${A.baseline.cmd}\` after editing; report every failing test id.`,
  `⟦df:${u.id}:${n}⟧`].join('\n\n')                     // tag stays the last line
const newFails = r => (r?.tests?.failing || []).filter(t => !A.baseline.failing.includes(t))

async function runUnit(u) {
  let n = 1, r = await agent(prompt(u, n), opts(u.p, u, n))
  if (!r) { n++; r = await agent(prompt(u, n), opts(u.p, u, n, false)) }   // infra: 1 retry, no agentType
  if (!r) return { id: u.id, outcome: 'unverified', reason: 'infra' }
  if (r.status === 'blocked') return { id: u.id, outcome: 'brief', reason: r.blocked_reason }
  let bad = newFails(r)
  if (!bad.length) return { id: u.id, outcome: 'ok', r }
  if (!u.fb) return { id: u.id, outcome: 'unverified', reason: 'gate', failing: bad }
  n++
  const fix = `MODE: repair. Fix only these new failures:\n${bad.join('\n')}\nPrevious summary: ${r.summary}`
  const r2 = await agent(prompt(u, n, fix), opts(u.fb, u, n))                // the one re-route
  bad = newFails(r2)
  return r2 && !bad.length ? { id: u.id, outcome: 'ok-rerouted', r: r2 }
    : { id: u.id, outcome: 'unverified', reason: 'gate-after-fb', failing: bad }
}

phase('Implement')
let done = []
if (A.worktree) done = await pipeline(A.units, u => runUnit(u))
else for (const u of A.units) done.push(await runUnit(u))                   // serial, in place

phase('Review')
const files = [...new Set(done.filter(d => d && d.r).flatMap(d => d.r.files_changed))]
const review = files.length ? await workflow('dynamic-fanout:fanout', { ...A.reviewArgs,
  kind: 'review', units: [{ ...A.reviewArgs.unit, scope: { files } }] }) : null
if (review && review.started === false) return { units: done, files, review }   // rails/dryRun/pause — surface it, do not read .digest
return { units: done, files, review: review && review.digest }
```

- `reviewArgs` is built by the master and must validate on its own: `v: 2`, `depth`,
  `session`, `shared`, `ultra`, `verify` (blocker/high → V3), `caps`, `confirmed: true`
  (the user already approved at the implement pause), and one review `unit` card (W·high,
  `check: 'quote+V3'`, `fb: null`). In worktree mode its brief names each unit's worktree
  path. If `review.started === false` (rails rejected it, or P exceeded `pauseUsd` before
  `confirmed` took effect), the skeleton returns `review` itself rather than
  `review.digest`, which would otherwise be `undefined` with no error raised.
- The inline script has no commit meter: print U/P/R/C from the dry run on the run card.
