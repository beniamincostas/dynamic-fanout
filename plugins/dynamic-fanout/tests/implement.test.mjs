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
    if (tag === 'review:1') return 't1 — FIXED\nSAFE TO MERGE'
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

test('dryRun: returns the priced card and the estimate (units + 1.5x the largest unit for the review)', async () => {
  const a = baseArgs({ dryRun: true, themes: [theme('t1', { in: 20000 }), theme('t2', { in: 60000 })] })
  const { res, calls } = await run(a)
  assert.equal(res.started, false)
  assert.equal(res.reason, 'dryRun')
  assert.equal(calls.length, 0)
  const est = res.card.units.map(u => u.estUsd)
  assert.ok(est.every(x => x > 0))
  const sum = est[0] + est[1]
  assert.ok(Math.abs(res.estimate.units - sum) < 1e-3)
  assert.ok(Math.abs(res.estimate.review - 1.5 * Math.max(...est)) < 1e-3)
  assert.ok(Math.abs(res.estimate.total - (sum + 1.5 * Math.max(...est))) < 1e-3)
  // review disabled: no review stand-in
  const r2 = await run({ ...a, review: { enabled: false } })
  assert.equal(r2.res.estimate.review, 0)
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
  assert.equal(res.review.text, 't1 — FIXED\nSAFE TO MERGE')
  assert.equal(res.review.range, 'c-t1^..HEAD')
  const rp = calls.at(-1).prompt
  assert.match(rp, /git -C \/tmp\/work\/repo log --oneline c-t1\^\.\.HEAD/)
  assert.match(rp, /commits made in this run: c-t1, c-t2, c-t3/)
  // The whole brief (whitespace collapsed): a reviewer shown only line 1 of a multi-item
  // brief flags items 2..n as scope creep.
  for (const id of ['t1', 't2', 't3']) assert.ok(rp.includes(`- ${id} (ok): Fix ${id}: the first line of the brief more detail`), `intended change ${id} listed in full`)
  assert.ok(res.money.committedUsd <= res.money.ceilingUsd)
  assert.ok(Math.abs(res.money.committedUsd - res.estimate.total) < 1e-3, 'no repair: committed = estimate')
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
  assert.equal(reviewCalls(calls).length, 1)
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
  assert.equal(rp.trim().split('\n').at(-1), '⟦df:review:1⟧')
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
