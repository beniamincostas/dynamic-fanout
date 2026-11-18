import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runFanout, runWorkflow, tagOf } from './harness.mjs'

// workflows/implement.js prices its themes through the real foreman: the workflow() stub
// below runs fanout.js's dry run in-process, so these tests also pin the pricing contract.
const fanoutStub = async (name, a) => {
  assert.equal(name, 'dynamic-fanout:fanout')
  return (await runFanout(a, () => { throw new Error('a dry run must not launch agents') })).res
}

const theme = (id, over = {}) => ({
  id, brief: `Fix ${id}: the first line of the brief\nmore detail`, vec: 'D1 A0 T1 C1 V2 B1 G0', why: 'V2 the tests are the check', in: 30000,
  p: { model: 'opus', effort: 'medium' }, fb: { model: 'opus', effort: 'high' }, ...over,
})

function baseArgs(over = {}) {
  return {
    v: 1, worktree: '/tmp/work/repo', testCmd: 'npm test', baseline: { passed: 120, skipped: 2 },
    session: { S: 'opus', W: 'opus', refEffort: 'xhigh' }, shared: 'SHARED CAPSULE',
    themes: [theme('t1'), theme('t2'), theme('t3')],
    caps: { ceilingUsd: 100 }, commitPrefix: 'fix(core):',
    ...over,
  }
}

const green = (extra = {}) => ({ status: 'ok', files_changed: ['src/a.js'], suite: { passed: 121, failed: 0 }, commit: 'abc123', summary: 'done', ...extra })
const red = (extra = {}) => ({ status: 'partial', files_changed: ['src/a.js'], suite: { passed: 119, failed: 2 }, summary: 'two red', ...extra })

// Responder keyed on the cost tag; theme attempts default to green, the reviewer to a verdict.
function responder(map = {}) {
  return (prompt, opts, n) => {
    const tag = tagOf(prompt)
    if (map[tag] !== undefined) return typeof map[tag] === 'function' ? map[tag](prompt, opts, n) : map[tag]
    if (/^review-[ABC]:\d+$/.test(tag)) return 't1 — FIXED\nSAFE TO MERGE'
    return green({ commit: `c-${tag}` })
  }
}

const run = (args, map, opts = {}) => runWorkflow('implement.js', args, responder(map), { workflowStub: fanoutStub, ...opts })
const implCalls = calls => calls.filter(c => c.opts.agentType === 'dynamic-fanout:implementer')
const reviewCalls = calls => calls.filter(c => c.opts.agentType === 'dynamic-fanout:reviewer')

// ───────────────────────── meta + rails ─────────────────────────

test('meta: a pure literal named implement with Validate/Implement/Review', () => {
  const src = readFileSync(new URL('../workflows/implement.js', import.meta.url), 'utf8')
  // Evaluates only this plugin's own implement.js meta literal (as tests/harness.mjs does).
  const lit = /export const meta = (\{[\s\S]*?\n\})\n/.exec(src)
  assert.ok(lit, 'meta literal found')
  const meta = new Function(`return ${lit[1]}`)()
  assert.equal(meta.name, 'implement')
  assert.deepEqual(meta.phases.map(p => p.title), ['Validate', 'Implement', 'Review'])
  assert.match(meta.whenToUse, /dynamic-fanout skill with args v1/)
  assert.match(meta.whenToUse, /bare invocation/i)
})

test('a bare invocation does nothing', async () => {
  const { res, calls, workflowCalls } = await run(undefined)
  assert.deepEqual(res, { started: false, reason: 'no-args' })
  assert.equal(calls.length, 0)
  assert.equal(workflowCalls.length, 0)
})

test('rails: shape errors reject before pricing or launching', async () => {
  const cases = [
    [{ v: 2 }, /^args: v must be 1/],
    [{ worktree: 'relative/path' }, /^args: worktree must be an absolute path/],
    [{ testCmd: '' }, /^args: testCmd/],
    [{ themes: [] }, /^args: themes must be a non-empty array/],
    [{ themes: [theme('t1'), theme('t1')] }, /^args: duplicate theme id t1/],
    [{ caps: {} }, /^caps: ceilingUsd is required/],
    [{ caps: { ceilingUsd: 0 } }, /^caps: ceilingUsd is required/],
  ]
  for (const [over, re] of cases) {
    const { res, calls, workflowCalls } = await run(baseArgs(over))
    assert.equal(res.started, false)
    assert.equal(res.reason, 'rails')
    assert.ok(res.errors.some(e => re.test(e)), `expected ${re}, got ${res.errors.join(' | ')}`)
    assert.equal(calls.length, 0)
    assert.equal(workflowCalls.length, 0, 'shape errors never reach the foreman')
  }
})

test('rails: the foreman\'s card rails come back unstarted', async () => {
  const a = baseArgs()
  a.themes[1].fb = { model: 'opus', effort: 'low' } // not strictly stronger than p
  const { res, calls, workflowCalls } = await run(a)
  assert.equal(res.reason, 'rails')
  assert.ok(res.errors.some(e => /^fb t2: fallback opus·low is not strictly stronger/.test(e)), res.errors.join(' | '))
  assert.equal(calls.length, 0)
  assert.equal(workflowCalls.length, 1)
})

test('pricing: the foreman gets one implement card per theme, dry run, ctx keep, check tests', async () => {
  const a = baseArgs({ themes: [theme('t1', { in: 20000 }), theme('t2', { in: 40000, fb: null })], dryRun: true })
  const { workflowCalls } = await run(a)
  const fa = workflowCalls[0].args
  assert.equal(fa.v, 2)
  assert.equal(fa.kind, 'implement')
  assert.equal(fa.dryRun, true)
  assert.equal(fa.depth, 'standard')
  assert.deepEqual(fa.caps, { ceilingUsd: 100 })
  assert.deepEqual({ agents: fa.ultra.agents, verifiers: fa.ultra.verifiers, ctxTok: fa.ultra.ctxTok, inAvg: fa.ultra.inAvg }, { agents: 2, verifiers: 1, ctxTok: 0, inAvg: 30000 })
  assert.deepEqual(fa.units.map(u => [u.id, u.role, u.ctx, u.check, u.in]), [['t1', 'implement', 'keep', 'tests', 20000], ['t2', 'implement', 'keep', 'tests', 40000]])
  assert.equal(fa.units[1].fb, null)
  // without per-theme in, inAvg falls back to 30000
  const b = baseArgs({ themes: [theme('t1', { in: undefined })], dryRun: true })
  const r2 = await run(b)
  assert.equal(r2.workflowCalls[0].args.ultra.inAvg, 30000)
  // a theme's ctxTok (its CLAUDE.md chain) passes through to the card; absent stays absent
  assert.equal('ctxTok' in fa.units[0], false)
  const c = baseArgs({ themes: [theme('t1', { in: 20000, ctxTok: 45000 })], dryRun: true })
  assert.equal((await run(c)).workflowCalls[0].args.units[0].ctxTok, 45000)
})

// ───────────────────────── money: refusal, dry run, pause ─────────────────────────

test('dryRun: returns the priced card and the estimate (units + 3 lenses x 1.5x the largest unit + the repair round)', async () => {
  const a = baseArgs({ dryRun: true, themes: [theme('t1', { in: 20000 }), theme('t2', { in: 60000 })] })
  const { res, calls } = await run(a)
  assert.equal(res.started, false)
  assert.equal(res.reason, 'dryRun')
  assert.equal(calls.length, 0)
  const est = res.card.units.map(u => u.estUsd)
  assert.ok(est.every(x => x > 0))
  const sum = est[0] + est[1]
  assert.ok(Math.abs(res.estimate.units - sum) < 1e-3)
  const lens = 1.5 * Math.max(...est)
  assert.ok(Math.abs(res.estimate.review - 3 * lens) < 1e-3, 'three lens reviewers, each priced at 1.5x the largest theme')
  // the repair round: one theme re-run plus a full re-review, held from the ceiling
  assert.ok(Math.abs(res.estimate.repair - (Math.max(...est) + 3 * lens)) < 1e-3)
  assert.ok(Math.abs(res.estimate.total - (sum + 3 * lens + Math.max(...est) + 3 * lens)) < 1e-3)
  // review disabled: no review stand-in, no repair round
  const r2 = await run({ ...a, review: { enabled: false } })
  assert.equal(r2.res.estimate.review, 0)
  assert.equal(r2.res.estimate.repair, 0)
})

test('money: an estimate above ceilingUsd is refused unstarted, with the card', async () => {
  const dry = (await run(baseArgs({ dryRun: true }))).res
  const { res, calls } = await run(baseArgs({ caps: { ceilingUsd: dry.estimate.total * 0.9 } }))
  assert.equal(res.started, false)
  assert.equal(res.reason, 'money')
  assert.ok(res.card && res.card.units.length === 3)
  assert.equal(calls.length, 0)
  // money is checked before dryRun
  const r2 = await run(baseArgs({ dryRun: true, caps: { ceilingUsd: dry.estimate.total * 0.9 } }))
  assert.equal(r2.res.reason, 'money')
})

test('pause: estimate above pauseUsd stops unless confirmed', async () => {
  const dry = (await run(baseArgs({ dryRun: true }))).res
  const caps = { ceilingUsd: 100, pauseUsd: dry.estimate.total / 2 }
  let r = await run(baseArgs({ caps }))
  assert.equal(r.res.reason, 'pause')
  assert.ok(r.res.estimate && r.res.card)
  assert.equal(r.calls.length, 0)
  r = await run(baseArgs({ caps, confirmed: true }))
  assert.equal(r.res.started, true)
  // no pauseUsd given: no pause
  r = await run(baseArgs())
  assert.equal(r.res.started, true)
})

// ───────────────────────── implement loop ─────────────────────────

test('themes run serially in order, then one review on the reviewer agent', async () => {
  let inFlight = 0
  let maxInFlight = 0
  const slow = tag => async () => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise(r => setTimeout(r, 5))
    inFlight--
    return green({ commit: `c-${tag}` })
  }
  const { res, calls, phases } = await run(baseArgs(), { 't1:1': slow('t1'), 't2:1': slow('t2'), 't3:1': slow('t3') })
  assert.equal(maxInFlight, 1, 'themes share files: never two implementers at once')
  assert.deepEqual(implCalls(calls).map(c => tagOf(c.prompt)), ['t1:1', 't2:1', 't3:1'])
  assert.deepEqual(phases, ['Validate', 'Implement', 'Review'])
  assert.equal(res.started, true)
  assert.deepEqual(res.summary, { ok: 3, repaired: 0, failed: 0, brief: 0, refused: 0 })
  assert.deepEqual(res.results.map(r => r.outcome), ['ok', 'ok', 'ok'])
  assert.deepEqual(res.results[0].attempts, [{ n: 1, cell: 'opus·medium', kind: 'primary', ok: true }])
  assert.equal(calls.at(-1).opts.agentType, 'dynamic-fanout:reviewer')
  assert.equal(res.review.ran, true)
  assert.equal(res.review.verdict, 'SAFE TO MERGE')
  assert.deepEqual(res.review.lenses.map(l => [l.id, l.verdict]), [['A', 'SAFE TO MERGE'], ['B', 'SAFE TO MERGE'], ['C', 'SAFE TO MERGE']])
  assert.match(res.review.text, /\[lens A: boundaries and time\]\nt1 — FIXED/)
  assert.equal(res.review.range, 'c-t1^..HEAD')
  assert.equal(res.review.repair, null, 'all SAFE: no repair round')
  assert.deepEqual(res.review.open, [])
  const rp = calls.at(-1).prompt
  assert.match(rp, /git -C \/tmp\/work\/repo log --oneline c-t1\^\.\.HEAD/)
  assert.match(rp, /commits made in this run: c-t1, c-t2, c-t3/)
  // The whole brief (whitespace collapsed): a reviewer shown only line 1 of a multi-item
  // brief flags items 2..n as scope creep.
  for (const id of ['t1', 't2', 't3']) assert.ok(rp.includes(`- ${id} (ok): Fix ${id}: the first line of the brief more detail`), `intended change ${id} listed in full`)
  assert.ok(res.money.committedUsd <= res.money.ceilingUsd)
  assert.ok(Math.abs(res.money.committedUsd - (res.estimate.units + res.estimate.review)) < 1e-3, 'no repair: committed = themes + the three lenses')
})

test('implementer prompt: shared first, brief, fixed rules, cost tag on the last line', async () => {
  const { calls } = await run(baseArgs({ themes: [theme('t1')] }))
  const p = implCalls(calls)[0].prompt
  assert.ok(p.startsWith('SHARED CAPSULE'))
  assert.match(p, /Fix t1: the first line of the brief/)
  assert.match(p, /Test first/)
  assert.match(p, /Touch only the files the change needs/)
  assert.match(p, /Run `npm test` from \/tmp\/work\/repo/)
  assert.match(p, /baseline 120 passed, 2 skipped, 0 failed/)
  assert.match(p, /starting "fix\(core\):"/)
  assert.match(p, /Never push, switch or create branches, deploy/)
  assert.match(p, /about 35 tool calls/)
  assert.equal(p.trim().split('\n').at(-1), '⟦df:t1:1⟧')
  const r = implCalls(calls)[0].opts
  assert.deepEqual(Object.keys(r.schema.properties).sort(), ['blocked_reason', 'commit', 'files_changed', 'status', 'suite', 'summary'])
  assert.equal(r.phase, 'Implement')
})

test('cells: model omitted when it equals S, effort always set (implementer and reviewer)', async () => {
  const a = baseArgs({
    themes: [
      theme('t1', { p: { model: 'opus', effort: 'medium' }, fb: null }),
      theme('t2', { p: { model: 'sonnet', effort: 'medium' }, fb: { model: 'sonnet', effort: 'high' } }),
      theme('t3', { p: { effort: 'low' }, fb: null }),
    ],
    review: { cell: { model: 'opus', effort: 'high' } },
  })
  const { calls } = await run(a)
  const [c1, c2, c3] = implCalls(calls).map(c => c.opts)
  assert.equal('model' in c1, false)
  assert.equal(c1.effort, 'medium')
  assert.equal(c2.model, 'sonnet')
  assert.equal(c2.effort, 'medium')
  assert.equal('model' in c3, false)
  assert.equal(c3.effort, 'low')
  const rv = reviewCalls(calls)[0].opts
  assert.equal('model' in rv, false)
  assert.equal(rv.effort, 'high')
  assert.equal(rv.schema, undefined, 'the review is free text')
})

test('review cell defaults to W·high', async () => {
  const a = baseArgs({ session: { S: 'fable', W: 'opus', refEffort: 'xhigh' }, themes: [theme('t1', { p: { model: 'opus', effort: 'medium' } })] })
  const { calls } = await run(a)
  const rv = reviewCalls(calls)[0].opts
  assert.equal(rv.model, 'opus')
  assert.equal(rv.effort, 'high')
})

test('one repair: a red first attempt gets exactly one repair on fb, with the previous result embedded', async () => {
  const { res, calls } = await run(baseArgs(), { 't2:1': red(), 't2:2': green({ commit: 'fixed2' }) })
  const t2 = implCalls(calls).filter(c => /^t2:/.test(tagOf(c.prompt)))
  assert.equal(t2.length, 2)
  assert.equal(t2[1].opts.effort, 'high', 'the repair runs on fb')
  assert.match(t2[1].prompt, /Repair: an earlier attempt/)
  assert.match(t2[1].prompt, /two red/)
  assert.match(t2[1].prompt, /Inspect the branch state first/)
  assert.equal(t2[1].prompt.trim().split('\n').at(-1), '⟦df:t2:2⟧')
  const r2 = res.results.find(r => r.id === 't2')
  assert.equal(r2.outcome, 'ok-repaired')
  assert.deepEqual(r2.attempts, [
    { n: 1, cell: 'opus·medium', kind: 'primary', ok: false },
    { n: 2, cell: 'opus·high', kind: 'repair', ok: true },
  ])
  assert.deepEqual(res.summary, { ok: 2, repaired: 1, failed: 0, brief: 0, refused: 0 })
})

test('one repair: a first attempt that returns nothing is repaired on fb', async () => {
  const { res, calls } = await run(baseArgs({ themes: [theme('t1')] }), { 't1:1': null })
  assert.equal(implCalls(calls).length, 2)
  assert.match(implCalls(calls)[1].prompt, /returned no result/)
  assert.equal(res.results[0].outcome, 'ok-repaired')
})

test('one repair: never a third attempt; status ok with failing tests is not ok', async () => {
  const { res, calls } = await run(baseArgs({ themes: [theme('t1'), theme('t2')] }), {
    't1:1': green({ suite: { passed: 100, failed: 1 } }), 't1:2': red(),
  })
  assert.deepEqual(implCalls(calls).map(c => tagOf(c.prompt)), ['t1:1', 't1:2', 't2:1'])
  assert.equal(res.results[0].outcome, 'failed')
  assert.equal(res.results[0].attempts.length, 2)
  assert.equal(res.results[1].outcome, 'ok')
})

test('one repair: no repair when fb is null', async () => {
  const { res, calls } = await run(baseArgs({ themes: [theme('t1', { fb: null })] }), { 't1:1': red() })
  assert.equal(implCalls(calls).length, 1)
  assert.equal(res.results[0].outcome, 'failed')
  assert.equal(reviewCalls(calls).length, 0, 'no theme landed: no review')
  assert.deepEqual(res.review, { ran: false, reason: 'no theme landed' })
})

test('one repair: no repair on a brief/access/scope block', async () => {
  for (const reason of ['ambiguous_brief', 'no_access', 'scope: dirty worktree']) {
    const { res, calls } = await run(baseArgs({ themes: [theme('t1')] }), { 't1:1': { status: 'blocked', blocked_reason: reason, files_changed: [], suite: { passed: 0, failed: 0 }, summary: 'stuck' } })
    assert.equal(implCalls(calls).length, 1, reason)
    assert.equal(res.results[0].outcome, 'brief')
  }
  // a capability block does get its repair
  const { res } = await run(baseArgs({ themes: [theme('t1')] }), { 't1:1': { status: 'blocked', blocked_reason: 'too_hard', files_changed: [], suite: { passed: 0, failed: 0 }, summary: 'hard' } })
  assert.equal(res.results[0].outcome, 'ok-repaired')
})

test('ceiling: a launch that would exceed ceilingUsd is refused mid-run; the review keeps its share', async () => {
  const dry = (await run(baseArgs({ dryRun: true }))).res
  const ceilingUsd = dry.estimate.total + 0.001
  // t1 needs its repair: that spends the slack, so t3 no longer fits (the review's estimate is held back)
  const { res, calls } = await run(baseArgs({ caps: { ceilingUsd } }), { 't1:1': red() })
  assert.deepEqual(implCalls(calls).map(c => tagOf(c.prompt)), ['t1:1', 't1:2', 't2:1'])
  assert.deepEqual(res.results.map(r => r.outcome), ['ok-repaired', 'ok', 'refused'])
  assert.equal(res.results[2].reason, 'budget')
  assert.deepEqual(res.results[2].attempts, [{ n: 1, cell: 'opus·medium', kind: 'primary', ok: false, refused: 'budget' }])
  assert.equal(res.review.ran, true)
  assert.equal(reviewCalls(calls).length, 3)
  assert.ok(res.money.committedUsd <= ceilingUsd + 1e-9)
  assert.deepEqual(res.summary, { ok: 1, repaired: 1, failed: 0, brief: 0, refused: 1 })
})

test('review: skipped when disabled; when it runs it lists failed themes too', async () => {
  let r = await run(baseArgs({ review: { enabled: false } }))
  assert.equal(reviewCalls(r.calls).length, 0)
  assert.deepEqual(r.res.review, { ran: false, reason: 'disabled' })
  r = await run(baseArgs({ themes: [theme('t1', { fb: null }), theme('t2')] }), { 't1:1': red() })
  const rp = reviewCalls(r.calls)[0].prompt
  assert.match(rp, /- t1 \(failed\): Fix t1/)
  assert.match(rp, /- t2 \(ok\): Fix t2/)
  assert.equal(rp.trim().split('\n').at(-1), '⟦df:review-A:1⟧')
})

test('review: without reported commits the reviewer is told to find them by prefix', async () => {
  const { res, calls } = await run(baseArgs({ themes: [theme('t1')] }), { 't1:1': green({ commit: undefined }) })
  assert.equal(res.review.range, null)
  assert.match(reviewCalls(calls)[0].prompt, /subjects start with "fix\(core\):"/)
})

test('a suite below the baseline count is flagged', async () => {
  const { res } = await run(baseArgs({ themes: [theme('t1')] }), { 't1:1': green({ suite: { passed: 90, failed: 0 } }) })
  assert.equal(res.results[0].outcome, 'ok')
  assert.match(res.results[0].warning, /passed 90 < baseline 120/)
})

test('harness: runWorkflow only loads files under workflows/', async () => {
  await assert.rejects(() => runWorkflow('../tests/harness.mjs', {}, () => null), /expected a file name under workflows/)
})

test('0.1.5 pricing: args.calib passes through to the foreman pricing call', async () => {
  const calib = { pm: 3, scaleByRole: { implement: 3.1 } }
  const { workflowCalls } = await run(baseArgs({ calib, dryRun: true }))
  assert.deepEqual(workflowCalls[0].args.calib, calib)
  const plain = await run(baseArgs({ dryRun: true }))
  assert.ok(!('calib' in plain.workflowCalls[0].args), 'no calib key without args.calib')
})

// ───────────────────────── 0.1.7: three-lens review + one repair round ─────────────────────────

const SAFE = 't1 — FIXED — a.js:1 — test: x — ok\nRegressions: none found\nNew risks: none found\nSAFE TO MERGE'
const lensTag = (l, n) => `review-${l}:${n}`

test('0.1.7 review: three lens reviewers run in parallel, one lens line each; SAFE only if all three are SAFE', async () => {
  let inFlight = 0
  let maxInFlight = 0
  const slow = text => async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise(r => setTimeout(r, 5)); inFlight--; return text }
  const { res, calls } = await run(baseArgs({ themes: [theme('t1')] }), {
    [lensTag('A', 1)]: slow(SAFE), [lensTag('B', 1)]: slow('t1 — PARTIAL — a.js:3 — test: none — rounding\nThemes to repair: none\nNEEDS CHANGES'), [lensTag('C', 1)]: slow(SAFE),
  })
  const rv = reviewCalls(calls)
  assert.deepEqual(rv.map(c => tagOf(c.prompt)), ['review-A:1', 'review-B:1', 'review-C:1'])
  assert.equal(maxInFlight, 3, 'the lenses run in parallel')
  assert.match(rv[0].prompt, /Lens A, boundaries and time: timeouts, retries, the ordering of side effects, partial failure, concurrency, dates/)
  assert.match(rv[1].prompt, /Lens B, inputs and data: unusual or malformed input, None\/null\/empty\/zero, encodings, rounding, multi-tenant data/)
  assert.match(rv[2].prompt, /Lens C, privacy and test integrity: data reaching the wrong party; edited pre-existing tests, weakened or removed asserts, fixtures that only mirror the new code/)
  for (const c of rv) {
    assert.equal((c.prompt.match(/^Lens [ABC],/gm) || []).length, 1, 'exactly one lens line per reviewer')
    assert.match(c.prompt, /SAFE TO MERGE or NEEDS CHANGES/)
    assert.match(c.prompt, /Regressions/)
    assert.equal(c.opts.agentType, 'dynamic-fanout:reviewer')
  }
  assert.equal(res.review.verdict, 'NEEDS CHANGES')
  assert.deepEqual(res.review.lenses.map(l => l.verdict), ['SAFE TO MERGE', 'NEEDS CHANGES', 'SAFE TO MERGE'])
  assert.ok(res.review.open.some(o => /^lens B \(inputs and data\): NEEDS CHANGES/.test(o)), res.review.open.join(' | '))
  // a lens that names no theme: nothing to re-run, nothing re-reviewed, and the open list says so
  assert.equal(implCalls(calls).length, 1)
  assert.deepEqual(res.review.repair.themes, [])
  assert.deepEqual(res.review.repair.rereview, [])
  assert.ok(res.review.open.some(o => /no lens named a theme/.test(o)))
})

test('0.1.7 review: an empty or unparsable lens retries once; still empty counts as NEEDS CHANGES, never SAFE', async () => {
  // A empty then SAFE; B unparsable (no verdict line) then SAFE; C empty twice
  let r = await run(baseArgs({ themes: [theme('t1')] }), {
    [lensTag('A', 1)]: '', [lensTag('A', 2)]: SAFE,
    [lensTag('B', 1)]: 't1 — FIXED\nlooks fine to me', [lensTag('B', 2)]: SAFE,
    [lensTag('C', 1)]: null, [lensTag('C', 2)]: '   ',
  })
  const tags = reviewCalls(r.calls).map(c => tagOf(c.prompt)).sort()
  assert.deepEqual(tags, ['review-A:1', 'review-A:2', 'review-B:1', 'review-B:2', 'review-C:1', 'review-C:2'], 'one retry per lens, never two')
  const [a, b, c] = r.res.review.lenses
  assert.equal(a.verdict, 'SAFE TO MERGE')
  assert.equal(b.verdict, 'SAFE TO MERGE')
  assert.equal(c.verdict, 'NEEDS CHANGES')
  assert.equal(c.note, 'review returned no text')
  assert.equal(r.res.review.verdict, 'NEEDS CHANGES')
  assert.ok(r.res.review.open.some(o => /lens C .*review returned no text/.test(o)))
  // all three empty: the review never passes
  r = await run(baseArgs({ themes: [theme('t1')] }), Object.fromEntries(['A', 'B', 'C'].flatMap(l => [[lensTag(l, 1), ''], [lensTag(l, 2), '']])))
  assert.equal(r.res.review.verdict, 'NEEDS CHANGES')
  assert.ok(r.res.review.lenses.every(l => l.note === 'review returned no text'))
  // a verdict wrapped in markdown still parses
  r = await run(baseArgs({ themes: [theme('t1')] }), { [lensTag('A', 1)]: 't1 — FIXED\n**SAFE TO MERGE**' })
  assert.equal(r.res.review.lenses[0].verdict, 'SAFE TO MERGE')
  assert.equal(reviewCalls(r.calls).length, 3, 'no retry for a parsable verdict')
})

test('0.1.7 review: acceptanceCmd (+ note) reaches every lens, run at most once; a malformed one is a rail', async () => {
  const { calls } = await run(baseArgs({ themes: [theme('t1')], acceptanceCmd: 'node render.js --dry', acceptanceNote: 'write-banned live re-render' }))
  for (const c of reviewCalls(calls)) {
    assert.match(c.prompt, /Acceptance command \(run from the worktree, at most once\): node render\.js --dry \(write-banned live re-render\)/)
  }
  const plain = await run(baseArgs({ themes: [theme('t1')] }))
  assert.doesNotMatch(reviewCalls(plain.calls)[0].prompt, /Acceptance command/)
  for (const over of [{ acceptanceCmd: '' }, { acceptanceCmd: 3 }, { acceptanceCmd: 'x', acceptanceNote: 4 }]) {
    const { res } = await run(baseArgs(over))
    assert.equal(res.reason, 'rails')
    assert.ok(res.errors.some(e => /^args: acceptance/.test(e)), res.errors.join(' | '))
  }
})

test('0.1.7 repair round: named themes re-run once on fb (p when fb is null) with the findings, then one re-review by the NEEDS CHANGES lenses', async () => {
  const a = baseArgs({ themes: [theme('t1'), theme('t2', { fb: null }), theme('t3')] })
  const needA = 't1 — PARTIAL — a.js:9 — test: none — retry without backoff\nNew risks: none found\nThemes to repair: t1, t2\nNEEDS CHANGES'
  const { res, calls } = await run(a, {
    [lensTag('A', 1)]: needA, [lensTag('B', 1)]: SAFE, [lensTag('C', 1)]: 't3 — FIXED\nNEEDS CHANGES',
    't1:2': green({ commit: 'r1' }), 't2:2': green({ commit: 'r2' }),
    [lensTag('A', 2)]: SAFE, [lensTag('C', 2)]: SAFE,
  })
  const impl = implCalls(calls)
  assert.deepEqual(impl.map(c => tagOf(c.prompt)), ['t1:1', 't2:1', 't3:1', 't1:2', 't2:2'], 'named themes only, serially, after the review')
  assert.equal(impl[3].opts.effort, 'high', 't1 re-runs on its fb')
  assert.equal(impl[4].opts.effort, 'medium', 't2 has fb null: it re-runs on p')
  assert.match(impl[3].prompt, /Review repair/)
  assert.match(impl[3].prompt, /retry without backoff/, 'the lens findings are embedded')
  assert.match(impl[3].prompt, /failing test first/)
  assert.equal(impl[3].prompt.trim().split('\n').at(-1), '⟦df:t1:2⟧')
  // the re-review: only the lenses that said NEEDS CHANGES (A, C), once, with their earlier findings
  const rv = reviewCalls(calls).map(c => tagOf(c.prompt))
  assert.deepEqual(rv.slice(3).sort(), ['review-A:2', 'review-C:2'])
  const reA = reviewCalls(calls).find(c => tagOf(c.prompt) === 'review-A:2').prompt
  assert.match(reA, /Re-review after one repair round/)
  assert.match(reA, /retry without backoff/)
  assert.match(reA, /commits made in this run: c-t1:1, c-t2:1, c-t3:1, r1, r2/)
  assert.equal(res.review.verdict, 'SAFE TO MERGE')
  assert.deepEqual(res.review.repair.themes.map(t => [t.id, t.cell, t.ok]), [['t1', 'opus·high', true], ['t2', 'opus·medium', true]])
  assert.deepEqual(res.review.repair.rereview, ['A', 'C'])
  assert.deepEqual(res.review.open, [])
  assert.deepEqual(res.results[0].attempts.at(-1), { n: 2, cell: 'opus·high', kind: 'review-repair', ok: true })
})

test('0.1.7 repair round: no further rounds; what is still open is reported; a theme already re-routed is not re-run', async () => {
  const a = baseArgs({ themes: [theme('t1'), theme('t2')] })
  const { res, calls } = await run(a, {
    't2:1': red(), 't2:2': green({ commit: 'fx2' }), // t2 used its one re-route on the theme stage
    [lensTag('A', 1)]: 't1 — NOT FIXED — a.js:1 — test: none — wrong\nt2 — PARTIAL — b.js:1 — test: none — half\nNEEDS CHANGES',
    't1:2': red({ summary: 'still red' }),
    [lensTag('A', 2)]: 't1 — NOT FIXED\nNEEDS CHANGES',
  })
  // without a "Themes to repair" line the PARTIAL / NOT FIXED rows name the themes
  assert.deepEqual(implCalls(calls).map(c => tagOf(c.prompt)), ['t1:1', 't2:1', 't2:2', 't1:2'])
  assert.deepEqual(reviewCalls(calls).map(c => tagOf(c.prompt)).sort(), ['review-A:1', 'review-A:2', 'review-B:1', 'review-C:1'], 'one re-review, never a third review round')
  assert.equal(res.review.verdict, 'NEEDS CHANGES')
  assert.deepEqual(res.review.repair.skipped, [{ id: 't2', reason: 'already re-routed once' }])
  assert.ok(res.review.open.some(o => /^lens A .*NEEDS CHANGES/.test(o)))
  assert.ok(res.review.open.some(o => /^theme t2: not re-run \(already re-routed once\)/.test(o)))
  assert.ok(res.review.open.some(o => /^theme t1: review repair did not finish green/.test(o)))
  assert.equal(res.results[0].outcome, 'ok', 'a red review repair keeps the theme\'s earlier landed result')
  assert.equal(res.results[0].reviewRepair.summary, 'still red')
})

test('0.1.7 repair round: metered against the ceiling with the re-review held back', async () => {
  const dry = (await run(baseArgs({ themes: [theme('t1')], dryRun: true }))).res
  // just enough for the theme and the three lenses: the repair round does not fit
  const ceilingUsd = dry.estimate.units + dry.estimate.review + dry.estimate.repair - 0.001
  const r = await run(baseArgs({ themes: [theme('t1')], caps: { ceilingUsd }, confirmed: true }), { [lensTag('A', 1)]: 't1 — PARTIAL\nThemes to repair: t1\nNEEDS CHANGES' })
  assert.equal(r.res.reason, 'money', 'the repair round is part of the estimate')
  const ok = await run(baseArgs({ themes: [theme('t1')], caps: { ceilingUsd: dry.estimate.total + 0.001 } }), {
    [lensTag('A', 1)]: 't1 — PARTIAL\nThemes to repair: t1\nNEEDS CHANGES', 't1:2': green({ commit: 'r1' }), [lensTag('A', 2)]: SAFE,
  })
  assert.equal(ok.res.review.verdict, 'SAFE TO MERGE')
  assert.ok(ok.res.money.committedUsd <= dry.estimate.total + 1e-6)
})
