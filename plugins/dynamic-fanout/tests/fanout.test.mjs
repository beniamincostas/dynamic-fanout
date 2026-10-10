import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadCore, runFanout, tagOf, okUnit, inspectAll, verdictAll } from './harness.mjs'

const core = loadCore()

function baseArgs(over = {}) {
  return {
    v: 2, kind: 'review', depth: 'standard',
    session: { S: 'opus', W: 'opus', refEffort: 'xhigh', refSource: 'test', allowUp: false },
    shared: 'SHARED PREAMBLE',
    ultra: { agents: 6, verifiers: 2, ctxTok: 30000, inAvg: 40000, basis: 'test: 6 dimensions' },
    units: [
      { id: 'u1', role: 'review', vec: 'D2 A1 T1 C1 V1 B1 G0', scope: { files: ['src/a.py'] }, in: 30000, ctx: 'omit',
        p: { model: 'sonnet', effort: 'medium' }, fb: { effort: 'high' }, check: 'quote', why: 'C1 checkable by quotes', brief: 'review a.py' },
      { id: 'u2', role: 'review', vec: 'D1 A0 T1 C0 V2 B0 G0', scope: { files: ['src/b.py'] }, in: 20000, ctx: 'omit',
        p: { model: 'sonnet', effort: 'low' }, fb: { model: 'sonnet', effort: 'medium' }, check: 'set', why: 'V2 set equality', brief: 'list b' },
    ],
    verify: { cells: { V3: { effort: 'high' } } },
    sweep: { rounds: 0 },
    caps: { pauseUsd: 100 },
    ...over,
  }
}

const unit = (id, over = {}) => ({
  id, role: 'review', vec: 'D1 A0 T1 C0 V1 B1 G0', scope: { files: [`src/${id}.py`] }, in: 20000, ctx: 'omit',
  p: { model: 'sonnet', effort: 'medium' }, fb: { effort: 'high' }, check: 'quote', why: 'test unit', brief: `do ${id}`, ...over,
})

const finding = (file, line, sev = 'medium', title = 'issue') => ({ title, severity: sev, claim: `${title} in ${file}`, evidence: [{ file, line, quote: 'x = 1' }] })

// Default responder: every unit completes, reads its scope, inspector finds every quote, skeptics confirm.
function responder(map = {}) {
  return (prompt, opts, n) => {
    const tag = tagOf(prompt)
    if (map[tag] !== undefined) return typeof map[tag] === 'function' ? map[tag](prompt, opts, n) : map[tag]
    if (tag.startsWith('i:')) return inspectAll(prompt, true)
    if (tag.startsWith('v:')) return verdictAll(prompt, 'CONFIRMED')
    if (tag.startsWith('s:')) return okUnit()
    if (tag.startsWith('c:')) return { missing: [] }
    const files = [...prompt.matchAll(/^- (\S+)$/gm)].map(m => m[1])
    return okUnit({ files_read: files })
  }
}

const cellOfCall = (o, S = 'opus') => (o.model || S) === 'haiku' ? 'haiku' : `${o.model || S}·${o.effort}`

// ───────────────────────── rails ─────────────────────────

async function rejects(args, re) {
  const { res, calls } = await runFanout(args, responder())
  assert.equal(res.started, false, 'plan should be rejected')
  assert.equal(res.reason, 'rails')
  assert.equal(calls.length, 0, 'no agent may launch on a rejected plan')
  assert.ok(res.errors.some(e => re.test(e)), `expected an error matching ${re}, got:\n${res.errors.join('\n')}`)
  return res
}

test('accepts the base plan', async () => {
  const { res } = await runFanout(baseArgs({ dryRun: true }), responder())
  assert.equal(res.reason, 'dryRun')
  assert.deepEqual(res.warnings, [])
  assert.ok(res.card.money.U > 0 && res.card.money.P > 0)
})

test('rail: haiku with effort or tools', async () => {
  const a = baseArgs()
  a.units[1].p = { model: 'haiku', effort: 'low' }
  a.units[1].fb = { model: 'sonnet', effort: 'low' }
  await rejects(a, /^haiku u2: p haiku takes no effort/)
  await rejects(a, /^haiku u2: p haiku cannot run tools/)
})

test('rail: effort above refEffort, missing effort', async () => {
  const a = baseArgs()
  a.session.refEffort = 'high'
  a.units[0].p = { model: 'sonnet', effort: 'xhigh' }
  await rejects(a, /^effort u1: p xhigh is above refEffort high/)
  const b = baseArgs()
  b.units[0].p = { model: 'sonnet' }
  await rejects(b, /^effort u1: p effort missing/)
})

test('rail: tier above session needs allowUp, max one allow-up unit', async () => {
  const a = baseArgs()
  a.units[0].fb = { model: 'fable', effort: 'high' }
  await rejects(a, /^tier u1: fb fable is above the session model opus/)
  a.session.allowUp = true
  a.units[1].fb = { model: 'fable', effort: 'medium' }
  await rejects(a, /^tier: at most 1 allow-up unit/)
})

test('rail: fallback must be strictly stronger', async () => {
  const a = baseArgs()
  a.units[0].fb = { model: 'sonnet', effort: 'medium' }
  await rejects(a, /^fb u1: fallback sonnet·medium is not strictly stronger/)
  a.units[0].fb = { model: 'sonnet', effort: 'low' }
  await rejects(a, /^fb u1/)
})

test('rail: parity cell runs as ultracode would, fb null', async () => {
  const a = baseArgs()
  a.units[0] = { ...a.units[0], vec: 'D2 A1 T1 C1 V0 B2 G2' }
  await rejects(a, /^parity u1: V0∧B2∧D≥1 must run on the session cell as ultracode would/)
  await rejects(a, /^parity u1: fb must be null/)
  a.units[0] = { ...a.units[0], p: { effort: 'xhigh' }, ctx: 'omit', fb: null }  // 0.1.1: CLAUDE.md no longer forced
  const { res } = await runFanout({ ...a, dryRun: true }, responder())
  assert.equal(res.reason, 'dryRun')
  assert.equal(res.card.units[0].parity, true)
})

test('rail: check rules', async () => {
  const a = baseArgs()
  a.units[1].check = 'none'
  await rejects(a, /^check u2: check none is only allowed in the parity cell/)
  const b = baseArgs({ kind: 'data' })
  b.units[1] = { ...b.units[1], n: 1, check: 'tieout' }
  await rejects(b, /^check u2: n=1 needs a planned re-derivation/)
  const c = baseArgs()
  delete c.units[0].check
  await rejects(c, /^check u1: check missing/)
})

test('rail: card fields', async () => {
  const a = baseArgs()
  a.units[0].vec = 'D2 A1'
  a.units[1].why = 'x'.repeat(141)
  await rejects(a, /^card u1: vec must list/)
  await rejects(a, /^card u2: why is 141 chars/)
  const b = baseArgs()
  b.units[1].id = 'u1'
  await rejects(b, /^args: duplicate unit id u1/)
})

test('rail: verifier must not be weaker than the producers', async () => {
  const a = baseArgs()
  a.verify = { cells: { V3: { model: 'sonnet', effort: 'high' } } }
  await rejects(a, /^verify: V3 cell sonnet·high is weaker than producer model opus/)
})

test('rail: money ceiling and parityBound', async () => {
  const a = baseArgs()
  a.ultra = { ...a.ultra, agents: 1, verifiers: 0 }
  await rejects(a, /^money: plan P \$[\d.]+ \+ reserve R \$[\d.]+ = \$[\d.]+ exceeds the crew ceiling/)
  const b = baseArgs({ caps: { pauseUsd: 100, parityBound: true } })
  await rejects(b, /^money: parityBound is only allowed when parity spend/)
})

test('rail: session and kind', async () => {
  await rejects(baseArgs({ session: { S: 'haiku', W: 'haiku', refEffort: 'low' } }), /^session: S is haiku/)
  await rejects(baseArgs({ kind: 'implement' }), /^args: kind implement runs from the implement playbook/)
  const dry = await runFanout(baseArgs({ kind: 'implement', dryRun: true }), responder())
  assert.equal(dry.res.reason, 'dryRun', 'implement cards can be validated with a dry run')
  await rejects(baseArgs({ v: 1 }), /^args: v must be 2/)
})

test('user overrides are exempt from tier and money rails (warnings instead)', async () => {
  const a = baseArgs({ dryRun: true })
  a.ultra = { ...a.ultra, agents: 1, verifiers: 0 }
  a.overrides = [{ id: 'u1', p: { model: 'fable', effort: 'high' }, fb: null, by: 'user' }]
  const { res } = await runFanout(a, responder())
  assert.equal(res.reason, 'dryRun', JSON.stringify(res.errors))
  assert.ok(res.warnings.some(w => /^money:/.test(w)))
  assert.equal(res.card.units[0].override, 'user')
  assert.equal(res.card.units[0].cell, 'fable·high')
  assert.ok(res.warnings.some(w => /user-overridden producer \(fable\)/.test(w)))
})

test('classify: blocked for a capability reason skips the capacity slice', () => {
  const u1 = core.validate(baseArgs()).units[0]
  const c = core.classify(u1, okUnit({ status: 'blocked', blocked_reason: 'too_hard', files_read: [] }), null, {})
  assert.equal(c.cls, 'capability')
  assert.equal(core.classify(u1, okUnit({ status: 'blocked', files_read: [] }), null, {}).cls, 'capability')
})

test('warns on more than two primary cells in the work stage', async () => {
  const a = baseArgs({ dryRun: true })
  a.units.push(unit('u3', { p: { effort: 'high' }, fb: { effort: 'xhigh' } }))
  const { res } = await runFanout(a, responder())
  assert.ok(res.warnings.some(w => /^cache: 3 distinct primary cells/.test(w)))
})

test('no args: does nothing', async () => {
  const { res, calls } = await runFanout(undefined, responder())
  assert.equal(res.started, false)
  assert.equal(res.reason, 'no-args')
  assert.equal(calls.length, 0)
})

test('pause: a plan above pauseUsd returns the card unstarted unless confirmed', async () => {
  const a = baseArgs({ caps: { pauseUsd: 0.5 } })
  let r = await runFanout(a, responder())
  assert.equal(r.res.reason, 'pause')
  assert.equal(r.calls.length, 0)
  r = await runFanout({ ...a, confirmed: true }, responder())
  assert.equal(r.res.started, true)
})

// ───────────────────────── pricing ─────────────────────────

test('estUsd: turn-aware formula, lean vs full prefix, caps, scale', () => {
  const K = core.calibrate()
  assert.equal(K.baseCtxLean, 8000)
  assert.equal(K.baseCtx, 15000)
  // turns ≈ (10 + in/2.5k) · effort factor, capped
  assert.equal(core.turnsFor({ model: 'opus', effort: 'high' }, 50000, K), 30)
  assert.equal(core.turnsFor({ model: 'opus', effort: 'high' }, 100000, K, 30), 30)
  assert.equal(core.turnsFor({ model: 'opus', effort: 'medium' }, 50000, K), 24)
  // lean opus·high, 50k read, capped at 30 turns, no role: write (8k + 4·50k)·4·1.25 + read 30·(8k + 100k)·4·0.1 + out 30·1500·20
  assert.equal(K.readFactor, 4)
  const want = round((208000 * 4 * 1.25 + 30 * 108000 * 4 * 0.1 + 30 * 1500 * 20) / 1e6)
  assert.equal(core.estUsd({ model: 'opus', effort: 'high' }, 50000, 0, K, { lean: true, cap: 30 }), want)
  // the full prefix + CLAUDE.md costs more than lean for the same work
  const full = core.estUsd({ model: 'opus', effort: 'high' }, 50000, 78000, K, { lean: false, cap: 30 })
  assert.ok(full > want * 1.4, `${full} vs ${want}`)
  // calib.scale multiplies every estimate
  assert.equal(core.estUsd({ model: 'opus', effort: 'high' }, 50000, 0, core.calibrate({ scale: 2 }), { lean: true, cap: 30 }), round(want * 2))
  // haiku: no effort, fixed small output per turn
  assert.ok(core.estUsd({ model: 'haiku' }, 1000, 0, K, { lean: true }) < 0.1)
})
const round = x => Math.round(x * 10000) / 10000

test('price: ultracode baseline is unbounded (full prefix, CLAUDE.md, roaming) vs a capped lean crew', () => {
  const a = baseArgs()
  const K = core.calibrate()
  const V = core.validate(a)
  const M = core.price(a, V, K)
  const ref = { model: 'opus', effort: 'xhigh' }
  const ultraO = { lean: false, cap: K.ultraTurnCap, readFactor: K.ultraReadFactor, role: 'work' }
  assert.equal(M.U, round(6 * core.estUsd(ref, 40000, 30000, K, ultraO) + 2 * core.estUsd(ref, 20000, 30000, K, ultraO)))
  assert.equal(M.C, round(0.5 * M.U))
  assert.ok(M.verifyUsd > 0)
  assert.ok(M.P + M.R < M.C)
  // a unit records its agent type, planned turns and lean flag
  assert.equal(V.units[0].typeKey, 'worker')
  assert.equal(V.units[0].o.lean, true)
  assert.ok(V.units[0].turns > 0 && V.units[0].turns <= K.caps.worker)
})

// ───────────────────────── money ─────────────────────────

test('toCents / compareNumbers / invariants use integer cents', () => {
  assert.equal(core.toCents('-1234.56'), -123456)
  assert.equal(core.toCents('1.234,56'), 123456)
  assert.equal(core.toCents('1,234.56'), 123456)
  assert.equal(core.toCents('12,5'), 1250)
  assert.equal(core.toCents('0.105'), 11)
  assert.equal(core.toCents('108.43-'), -10843)
  assert.equal(core.toCents('abc'), null)
  assert.equal(core.centsStr(-10843), '-108.43')
  const a = [{ name: 'total', value: '23099.86' }, { name: 'rows', value: '106' }]
  assert.equal(core.compareNumbers(a, [{ name: 'total', value: '23099.86' }, { name: 'rows', value: '106.00' }]).ok, true)
  const d = core.compareNumbers(a, [{ name: 'total', value: '23099.85' }, { name: 'rows', value: '106' }])
  assert.equal(d.ok, false)
  assert.equal(d.diffs[0].diffCents, 1)
  assert.equal(core.compareNumbers(a, [{ name: 'total', value: '23099.85' }], 1).ok, false, 'a missing name fails')
  const inv = core.evalInvariants(
    [{ name: 'by code sums to total', lhs: 'sum(u1.by_code.)', rhs: 'u1.total' }],
    { u1: [{ name: 'total', value: '0.30' }, { name: 'by_code.1', value: '0.10' }, { name: 'by_code.5', value: '0.20' }] },
  )
  assert.deepEqual(inv[0], { name: 'by code sums to total', ok: true, lhs: '0.30', rhs: '0.30', diffCents: 0 })
})

// ───────────────────────── classification ─────────────────────────

test('classify: the four classes', () => {
  const V = core.validate(baseArgs())
  const u1 = V.units[0] // B1, check quote, scope src/a.py
  const ok = okUnit({ files_read: ['src/a.py'], findings: [finding('src/a.py', 3)] })
  assert.equal(core.classify(u1, null, null, {}).cls, 'infra')
  assert.equal(core.classify(u1, { ...ok, status: 'blocked', blocked_reason: 'ambiguous_brief' }, null, {}).cls, 'brief')
  assert.equal(core.classify(u1, { ...ok, files_read: [] }, null, {}).cls, 'capacity')
  assert.equal(core.classify(u1, { ...ok, status: 'partial', remaining: ['x'] }, null, {}).cls, 'capacity')
  const second = core.classify(u1, { ...ok, files_read: [] }, null, { capacityUsed: true })
  assert.equal(second.cls, 'capability', 'a cited file that was not read is a capability failure')
  const cap = (res, insp, st) => core.classify(u1, res, insp, st || {})
  assert.equal(cap(ok, { total: 10, resolved: 6, rate: 0.6 }).cls, 'capability')
  assert.equal(cap(ok, { total: 10, resolved: 4, rate: 0.4 }).mode, 'redo')
  assert.equal(cap(ok, { total: 10, resolved: 6, rate: 0.6 }).mode, 'repair')
  assert.equal(cap({ ...ok, status: 'blocked', blocked_reason: 'too_hard' }).cls, 'capability')
  assert.equal(cap(ok, null, { tieoutFailed: true }).mode, 'rederive')
  // low confidence + soft signal → capability; low confidence alone → ok with a verify bump
  assert.equal(cap({ ...ok, confidence: 0.3 }, { total: 10, resolved: 8, rate: 0.8 }).cls, 'capability')
  assert.equal(cap({ ...ok, confidence: 0.3, assumptions: ['a', 'b', 'c'] }).cls, 'capability')
  const lone = cap({ ...ok, confidence: 0.3 }, { total: 10, resolved: 10, rate: 1 })
  assert.equal(lone.cls, 'ok')
  assert.equal(lone.verifyBump, 1)
})

test('classify: a B2 finding without evidence is a capability failure', () => {
  const a = baseArgs()
  a.units[0].vec = 'D2 A1 T1 C1 V1 B2 G0'
  const u = core.validate(a).units[0]
  const res = okUnit({ files_read: ['src/a.py'], findings: [{ title: 't', severity: 'high', claim: 'c', evidence: [] }] })
  assert.equal(core.classify(u, res, null, {}).cls, 'capability')
})

// ───────────────────────── flows ─────────────────────────

test('happy path: each unit once on its own card; tag is the last line of every prompt', async () => {
  const { res, calls } = await runFanout(baseArgs(), responder({
    'u1:1': okUnit({ files_read: ['src/a.py'], findings: [finding('src/a.py', 3, 'high', 'bug A')] }),
  }))
  assert.equal(res.started, true)
  const work = calls.filter(c => /^u\d:/.test(tagOf(c.prompt)))
  assert.deepEqual(work.map(c => `${tagOf(c.prompt)}=${cellOfCall(c.opts)}`).sort(), ['u1:1=sonnet·medium', 'u2:1=sonnet·low'])
  for (const c of calls) {
    assert.ok(tagOf(c.prompt), `every prompt ends with a cost tag: ${c.prompt.slice(-80)}`)
    assert.ok(c.prompt.trimEnd().endsWith('⟧'))
  }
  // model omitted when the cell model equals S; effort always set (no haiku here)
  for (const c of calls) {
    assert.ok(c.opts.effort, 'effort is always pinned')
    assert.notEqual(c.opts.model, 'opus', 'S is never passed explicitly')
  }
  assert.equal(res.digest.counts.ok, 2)
  assert.equal(res.ledger.reroutes, 0)
  // the high claim went to V3 on the declared V3 cell (opus·high → model omitted)
  const v = calls.find(c => tagOf(c.prompt).startsWith('v:'))
  assert.equal(cellOfCall(v.opts), 'opus·high')
  assert.equal(res.results.claims[0].verdict, 'CONFIRMED')
})

test('capability failure: fb runs exactly once; a second failure ends UNVERIFIED (no third attempt)', async () => {
  const bad = okUnit({ files_read: ['src/a.py'], findings: [finding('src/a.py', 3)] })
  const { res, calls } = await runFanout(baseArgs(), responder({
    'u1:1': bad, 'u1:2': bad,
    'i:u1:1': p => inspectAll(p, false), 'i:u1:2': p => inspectAll(p, false),
  }))
  const u1 = calls.filter(c => /^u1:/.test(tagOf(c.prompt)))
  assert.deepEqual(u1.map(c => `${tagOf(c.prompt)}=${cellOfCall(c.opts)}`), ['u1:1=sonnet·medium', 'u1:2=opus·high'])
  assert.match(u1[1].prompt, /Fresh attempt/, 'all quotes failed → redo mode')
  const L = res.ledger.units.find(l => l.id === 'u1')
  assert.equal(L.outcome, 'unverified')
  assert.match(L.reason, /^after fallback/)
  assert.equal(res.ledger.reroutes, 1)
  assert.equal(res.results.claims.find(c => c.unit === 'u1').verdict, 'UNVERIFIED')
})

test('capability failure then success: ok-rerouted, claims bumped one rung', async () => {
  const good = okUnit({ files_read: ['src/a.py'], findings: [finding('src/a.py', 3, 'medium')] })
  const { res, calls } = await runFanout(baseArgs(), responder({
    'u1:1': good, 'i:u1:1': p => ({ checks: inspectAll(p, false).checks }),
    'u1:2': good,
  }))
  assert.equal(res.ledger.units.find(l => l.id === 'u1').outcome, 'ok-rerouted')
  const claim = res.results.claims.find(c => c.unit === 'u1')
  assert.equal(claim.rung, 'V2', 'medium (V1) + 1 for the re-route')
  const repair = calls.find(c => tagOf(c.prompt) === 'u1:2')
  assert.match(repair.prompt, /Fresh attempt|Repair/)
})

test('fb null: a capability failure is not re-run', async () => {
  const a = baseArgs()
  a.units[0].fb = null
  const { res, calls } = await runFanout(a, responder({
    'u1:1': okUnit({ files_read: ['src/a.py'], status: 'blocked', blocked_reason: 'too_hard', findings: [] }),
  }))
  assert.equal(calls.filter(c => /^u1:/.test(tagOf(c.prompt))).length, 1)
  assert.match(res.ledger.units[0].reason, /fb null/)
})

test('brief failure: never re-run, goes to the master', async () => {
  const { res, calls } = await runFanout(baseArgs(), responder({
    'u2:1': okUnit({ status: 'blocked', blocked_reason: 'ambiguous_brief', files_read: [] }),
  }))
  assert.equal(calls.filter(c => /^u2:/.test(tagOf(c.prompt))).length, 1)
  assert.deepEqual(res.digest.exceptions.map(e => [e.id, e.cls]), [['u2', 'brief']])
})

test('infra: one retry on the same cell; drops a plugin type only if it never worked in the run', async () => {
  // u1 answers first on dynamic-fanout:worker, so u2's retry keeps the type (and its turn cap)
  let r = await runFanout(baseArgs(), responder({ 'u2:1': null }), { sequential: true })
  let u2 = r.calls.filter(c => /^u2:/.test(tagOf(c.prompt)))
  assert.equal(u2.length, 2)
  assert.equal(cellOfCall(u2[0].opts), cellOfCall(u2[1].opts))
  assert.equal(u2[1].opts.agentType, 'dynamic-fanout:worker')
  assert.equal(r.res.ledger.units.find(l => l.id === 'u2').outcome, 'ok')
  // nothing on that type has worked yet: the retry falls back to the default subagent
  r = await runFanout(baseArgs(), responder({ 'u1:1': null }), { sequential: true })
  const u1 = r.calls.filter(c => /^u1:/.test(tagOf(c.prompt)))
  assert.equal(u1[1].opts.agentType, undefined)
})

test('capacity: one slice run on the same cell for the missing files only', async () => {
  const a = baseArgs()
  a.units[1].scope.files = ['src/b.py', 'src/c.py']
  const { res, calls } = await runFanout(a, responder({ 'u2:1': okUnit({ files_read: ['src/b.py'] }) }))
  const u2 = calls.filter(c => /^u2:/.test(tagOf(c.prompt)))
  assert.equal(u2.length, 2)
  assert.equal(cellOfCall(u2[1].opts), 'sonnet·low')
  assert.match(u2[1].prompt, /Continuation[\s\S]*- file: src\/c\.py/)
  assert.equal(res.ledger.units.find(l => l.id === 'u2').outcome, 'ok')
})

test('cohort promotion: after ≥2 capability failures (≥25 %), later units of the cohort start on their fb', async () => {
  const a = baseArgs()
  a.ultra = { ...a.ultra, agents: 20, verifiers: 4 }
  a.units = ['c1', 'c2', 'c3', 'c4', 'c5'].map(id => unit(id))
  a.caps = { pauseUsd: 100, reserveCapPct: 100, rerouteRate: 1 }
  const fail = okUnit({ status: 'blocked', blocked_reason: 'too_hard' })
  const { res, calls } = await runFanout(a, responder({ 'c1:1': fail, 'c2:1': fail }), { sequential: true })
  const first = id => calls.find(c => tagOf(c.prompt) === `${id}:1`)
  assert.equal(cellOfCall(first('c1').opts), 'sonnet·medium')
  assert.equal(cellOfCall(first('c3').opts), 'opus·high', 'promoted to its own fb')
  assert.equal(res.ledger.units.find(l => l.id === 'c3').outcome, 'ok-promoted')
  assert.deepEqual(res.ledger.promotions, ['review|sonnet·medium'])
  // promoted units have no further fallback
  const r2 = await runFanout(a, responder({ 'c1:1': fail, 'c2:1': fail, 'c3:1': fail }), { sequential: true })
  assert.equal(r2.calls.filter(c => /^c3:/.test(tagOf(c.prompt))).length, 1)
  assert.match(r2.res.ledger.units.find(l => l.id === 'c3').reason, /fallback already used/)
})

test('data: planned re-derivation; match → CONFIRMED numbers; mismatch spends the re-route in rederive mode', async () => {
  const a = baseArgs({ kind: 'data' })
  a.units = [unit('d1', { vec: 'D1 A0 T1 C1 V2 B2 G1', n: 1, check: 'tieout+rederive', rd: { model: 'sonnet', effort: 'medium' } })]
  a.ultra = { ...a.ultra, agents: 4 }
  const nums = v => okUnit({ files_read: ['src/d1.py'], numbers: [{ name: 'total', value: v, method: 'pandas' }] })
  let r = await runFanout(a, responder({ 'd1:1': nums('10.00'), 'd1:2': nums('10.00') }))
  assert.equal(r.res.results.units.d1.numbersStatus, 'CONFIRMED')
  assert.match(r.calls.find(c => tagOf(c.prompt) === 'd1:2').prompt, /Independent re-derivation/)
  r = await runFanout(a, responder({ 'd1:1': nums('10.00'), 'd1:2': nums('10.01'), 'd1:3': nums('10.01') }))
  const third = r.calls.find(c => tagOf(c.prompt) === 'd1:3')
  assert.equal(cellOfCall(third.opts), 'opus·high')
  assert.match(third.prompt, /DIFFERENT method/)
  assert.equal(r.res.results.units.d1.numbersStatus, 'CONFIRMED', 'fallback matched the planned re-derivation')
  assert.equal(r.res.ledger.units[0].outcome, 'ok-rerouted')
  r = await runFanout(a, responder({ 'd1:1': nums('10.00'), 'd1:2': nums('10.01'), 'd1:3': nums('9.99') }))
  assert.equal(r.res.results.units.d1.numbersStatus, 'UNVERIFIED')
  assert.equal(r.res.ledger.units[0].outcome, 'unverified')
  assert.ok(r.res.results.units.d1.numbersConflict)
})

test('reserve exhausted: a second capability failure is refused, not run', async () => {
  const a = baseArgs()
  a.ultra = { ...a.ultra, agents: 20, verifiers: 4 }
  a.units = [unit('r1'), unit('r2'), unit('r3'), unit('r4'), unit('r5'), unit('r6'), unit('r7'), unit('r8')]
  a.caps = { pauseUsd: 100, rerouteRate: 0.01, reserveCapPct: 1 }
  const fail = okUnit({ status: 'blocked', blocked_reason: 'too_hard' })
  const { res, calls } = await runFanout(a, responder({ 'r1:1': fail, 'r2:1': fail }), { sequential: true })
  assert.equal(calls.filter(c => tagOf(c.prompt) === 'r1:2').length, 1, 'first repair fits the floor')
  assert.equal(calls.filter(c => tagOf(c.prompt) === 'r2:2').length, 0, 'second repair is refused')
  assert.match(res.ledger.units.find(l => l.id === 'r2').reason, /^budget: re-route reserve exhausted/)
})

test('kill switch: no new launch once output passes 75 % of maxOutputTokens', async () => {
  const a = baseArgs({ caps: { pauseUsd: 100, maxOutputTokens: 1000 } })
  const { res, calls } = await runFanout(a, responder(), { spent: n => (n >= 1 ? 900 : 0), sequential: true })
  assert.equal(calls.length, 1)
  assert.match(res.ledger.units.find(l => l.id === 'u2').reason, /kill switch/)
})

// ───────────────────────── verification ─────────────────────────

test('verification: rungs, cells, topK, refuted-without-counter-quote', async () => {
  const a = baseArgs({ verify: { cells: { V3: { effort: 'high' } }, rungs: { medium: 'V2' }, topK: 2, batch: 5 } })
  a.units[0].vec = 'D2 A1 T1 C1 V0 B2 G1'
  a.units[0].p = { effort: 'xhigh' }
  a.units[0].ctx = 'keep'
  a.units[0].fb = null
  const { res, calls } = await runFanout(a, responder({
    'u1:1': okUnit({ files_read: ['src/a.py'], findings: [finding('src/a.py', 3, 'low', 'parity low')] }),
    'u2:1': okUnit({ files_read: ['src/b.py'], findings: [finding('src/b.py', 10, 'medium', 'm1'), finding('src/b.py', 50, 'medium', 'm2'), finding('src/b.py', 70, 'medium', 'm3'), finding('src/b.py', 90, 'low', 'l1')] }),
    'v:b1:1': p => verdictAll(p, 'REFUTED'),
  }))
  const byTitle = t => res.results.claims.find(c => c.title === t)
  assert.equal(byTitle('parity low').rung, 'V3', 'parity claims are verified at V3 or higher')
  assert.equal(byTitle('l1').verdict, 'PLAUSIBLE')
  assert.equal(byTitle('l1').verdictBy, 'V0')
  const vcalls = calls.filter(c => tagOf(c.prompt).startsWith('v:'))
  const cells = vcalls.map(c => cellOfCall(c.opts)).sort()
  assert.ok(cells.includes('opus·high'), 'parity claim on S·high')
  assert.ok(cells.includes('sonnet·medium'), 'V2 on the producer model at medium')
  // parity claims bypass topK; topK = 2 of the 3 non-parity V2 claims → one is UNVERIFIED topK
  assert.notEqual(byTitle('parity low').verdictBy, 'topK')
  assert.equal(res.results.claims.filter(c => c.verdictBy === 'topK').length, 1)
  assert.ok(res.digest.dropped.some(d => d.what === 'claims beyond topK'))
  // b1 refuted without a counter-quote → PLAUSIBLE
  const refutedBatch = res.results.claims.filter(c => (c.verdictBy || '').startsWith('b1'))
  for (const c of refutedBatch) assert.equal(c.verdict, 'PLAUSIBLE')
})

test('V4: a split panel ends UNVERIFIED for the master', () => {
  const v = core.mergeVerdicts([{ verdict: 'CONFIRMED', reason: 'a' }, { verdict: 'REFUTED', reason: 'b', counter_quote: { file: 'f', line: 1, quote: 'q' } }])
  assert.equal(v.verdict, 'UNVERIFIED')
  assert.equal(v.split, true)
  assert.equal(core.mergeVerdicts([{ verdict: 'CONFIRMED' }, { verdict: 'CONFIRMED' }]).verdict, 'CONFIRMED')
  assert.equal(core.normalizeVerdict({ verdict: 'REFUTED', reason: 'no' }).verdict, 'PLAUSIBLE')
})

test('dedup merges claims on the same file and line bucket, keeping the higher severity', () => {
  const claims = [
    { cid: 'a', title: 'x', severity: 'medium', evidence: [{ file: './src/a.py', line: 10, quote: 'q' }], producer: { model: 'sonnet' } },
    { cid: 'b', title: 'y', severity: 'high', evidence: [{ file: 'src/a.py', line: 11, quote: 'q2' }], producer: { model: 'opus' } },
    { cid: 'c', title: 'z', severity: 'low', evidence: [{ file: 'src/a.py', line: 40, quote: 'q3' }] },
  ]
  const out = core.dedupClaims(claims, ['file', 'line'])
  assert.equal(out.length, 2)
  assert.equal(out[0].severity, 'high')
  assert.deepEqual(out[0].mergedFrom, ['b'])
  assert.equal(out[0].producer.model, 'opus')
})

// ───────────────────────── ownership (property test) ─────────────────────────

test('ownership: every launched cell is on a card or a declared verifier/inspector/sweep cell', async () => {
  let seed = 7
  const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647)
  const pick = arr => arr[Math.floor(rnd() * arr.length)]
  for (let trial = 0; trial < 40; trial++) {
    const S = pick(['sonnet', 'opus', 'fable'])
    const E = pick(['medium', 'high', 'xhigh'])
    const W = S === 'fable' ? 'opus' : S
    const efforts = ['low', 'medium', 'high', 'xhigh'].filter(e => ['low', 'medium', 'high', 'xhigh'].indexOf(e) <= ['low', 'medium', 'high', 'xhigh'].indexOf(E))
    const units = Array.from({ length: 2 + Math.floor(rnd() * 4) }, (_, i) => {
      const pm = pick(['sonnet', W])
      const pe = pick(efforts.slice(0, -1).length ? efforts.slice(0, -1) : efforts)
      const fb = rnd() < 0.3 ? null : { model: W, effort: efforts[efforts.length - 1] }
      const ok = fb === null || ['sonnet', 'opus', 'fable'].indexOf(fb.model) > ['sonnet', 'opus', 'fable'].indexOf(pm) || efforts.indexOf(fb.effort) > efforts.indexOf(pe)
      return unit(`p${i}`, { p: { model: pm, effort: pe }, fb: ok ? fb : null, vec: `D1 A0 T1 C0 V${pick([1, 2])} B${pick([0, 1, 2])} G0`, n: 0 })
    })
    const a = baseArgs({
      session: { S, W, refEffort: E, refSource: 'prop', allowUp: false }, units,
      ultra: { agents: 30, verifiers: 10, ctxTok: 30000, inAvg: 40000, basis: 'prop' },
      verify: { cells: { V3: { model: W, effort: E === 'medium' ? 'medium' : 'high' } } },
      sweep: { rounds: 1 }, caps: { pauseUsd: 1000, reserveCapPct: 100, rerouteRate: 1 },
    })
    const allowed = new Set(['sonnet·low'])
    for (const u of units) {
      allowed.add(core.cellKey(core.cellOf(u.p, S)))
      if (u.fb) allowed.add(core.cellKey(core.cellOf(u.fb, S)))
      allowed.add(`${u.p.model || S}·${E === 'medium' ? 'medium' : 'medium'}`)
    }
    allowed.add(core.cellKey(core.cellOf(a.verify.cells.V3, S)))
    allowed.add(`${S}·${['high', 'xhigh', 'max'].includes(E) ? 'high' : E}`)
    allowed.add(`${W}·${E === 'medium' ? 'medium' : 'medium'}`)
    for (const m of ['sonnet', 'opus', 'fable']) allowed.add(`${m}·medium`)
    const failing = new Set(units.filter(() => rnd() < 0.4).map(u => `${u.id}:1`))
    const { res, calls } = await runFanout(a, (prompt, o, n) => {
      const tag = tagOf(prompt)
      if (failing.has(tag)) return okUnit({ status: 'blocked', blocked_reason: 'too_hard' })
      if (tag.startsWith('i:')) return inspectAll(prompt, rnd() < 0.7)
      if (tag.startsWith('v:')) return verdictAll(prompt, 'CONFIRMED')
      if (tag.startsWith('s:')) return okUnit()
      const files = [...prompt.matchAll(/^- (\S+)$/gm)].map(m => m[1])
      return okUnit({ files_read: files, findings: rnd() < 0.5 ? [finding(files[0] || 'x', 5, pick(['low', 'medium', 'high']))] : [] })
    })
    if (!res.started) continue
    const cardCells = new Set(res.card.units.flatMap(u => [u.cell, u.fb].filter(Boolean)))
    for (const c of calls) {
      const cell = cellOfCall(c.opts, S)
      const tag = tagOf(c.prompt)
      assert.ok(c.opts.effort, `effort pinned on ${tag}`)
      if (/^p\d+:/.test(tag)) assert.ok(cardCells.has(cell), `work call ${tag} on ${cell} not on any card (${[...cardCells]})`)
      else assert.ok(allowed.has(cell), `support call ${tag} on unexpected cell ${cell}`)
    }
    for (const L of res.ledger.units) {
      const work = L.attempts.filter(x => x.kind !== 'rederive-planned' && x.cls !== 'refused')
      assert.ok(work.length <= 4, `${L.id}: at most primary + infra + capacity + re-route`)
      assert.ok(L.attempts.filter(x => x.kind === 'reroute').length <= 1, `${L.id}: at most one re-route`)
    }
  }
})

// ───────────────────────── review fixes ─────────────────────────

test('override of p without fb clears the old fallback', () => {
  const a = baseArgs()
  a.overrides = [{ id: 'u2', p: { model: 'opus', effort: 'high' }, by: 'user' }]
  const V = core.validate(a)
  assert.equal(V.units[1].fbCell, null)
  assert.ok(!V.errors.some(e => /^fb u2/.test(e)), V.errors.join('\n'))
})

test('fable session: only parity units run on fable', async () => {
  const a = baseArgs({ session: { S: 'fable', W: 'opus', refEffort: 'xhigh', refSource: 't' } })
  a.units[0].fb = { model: 'fable', effort: 'high' }
  await rejects(a, /^tier u1: fb on a Fable session only parity units run on fable/)
})

test('check tokens V2/V3/V4 set a per-unit verification floor', async () => {
  assert.equal(core.floorOf(['quote', 'v3']), 3)
  assert.equal(core.floorOf(['set']), -1)
  assert.equal(core.rungFor({ severity: 'low', floor: 3 }, { low: 'V0' }), 'V3')
  const a = baseArgs()
  a.units[1].check = 'set+V3'
  const { res } = await runFanout(a, responder({ 'u2:1': okUnit({ files_read: ['src/b.py'], findings: [finding('src/b.py', 9, 'low', 'low but floored')] }) }))
  const c = res.results.claims.find(x => x.title === 'low but floored')
  assert.equal(c.rung, 'V3')
  assert.equal(c.verdict, 'CONFIRMED')
})

test('data with fb null: a tie-out mismatch keeps both derivations', async () => {
  const a = baseArgs({ kind: 'data' })
  a.units = [unit('d1', { vec: 'D1 A0 T1 C1 V2 B1 G1', n: 1, check: 'tieout+rederive', fb: null })]
  a.ultra = { ...a.ultra, agents: 4 }
  const nums = v => okUnit({ files_read: ['src/d1.py'], numbers: [{ name: 'total', value: v, method: 'm' }] })
  const { res } = await runFanout(a, responder({ 'd1:1': nums('1.00'), 'd1:2': nums('2.00') }))
  assert.equal(res.results.units.d1.numbersStatus, 'UNVERIFIED')
  assert.deepEqual(res.results.units.d1.numbersConflict.rederived, [{ name: 'total', value: '2.00', method: 'm' }])
})

test('stage verify: invariants come from carry, not re-evaluated on empty units', async () => {
  const a = baseArgs({ stage: 'verify', reduce: { invariants: [{ name: 'x', lhs: 'u1.total', rhs: 'u1.total' }] },
    claims: [], carry: { committedUsd: 0, rerouteUsd: 0, invariants: [{ name: 'x', ok: true, lhs: '1.00', rhs: '1.00', diffCents: 0 }] } })
  const { res, calls } = await runFanout(a, responder())
  assert.equal(calls.length, 0)
  assert.deepEqual(res.digest.invariants.map(i => i.ok), [true])
})

test('agent type: worker by default, worker-mcp for T2, worker-ctx for ctx keep', async () => {
  const a = baseArgs()
  a.units[1].vec = 'D1 A0 T2 C0 V2 B0 G0'
  a.units.push(unit('u3', { ctx: 'keep', vec: 'D1 A0 T2 C0 V1 B1 G0' }))
  const { calls } = await runFanout(a, responder())
  const at = id => calls.find(c => tagOf(c.prompt) === `${id}:1`).opts.agentType
  assert.equal(at('u1'), 'dynamic-fanout:worker')
  assert.equal(at('u2'), 'dynamic-fanout:worker-mcp')
  assert.equal(at('u3'), 'dynamic-fanout:worker-ctx')
})

// ───────────────────────── 0.1.1 ─────────────────────────

test('every unit prompt carries a turn + reading budget and the scope-path rule', async () => {
  const { calls } = await runFanout(baseArgs(), responder())
  const p = calls.find(c => tagOf(c.prompt) === 'u1:1').prompt
  assert.match(p, /Budget: about \d+ tool calls \(hard stop at 30\)/)
  assert.match(p, /Read only the line ranges you need/)
  assert.match(p, /Cite every file path exactly as it is written under Scope/)
})

test('toScope maps short evidence paths onto scope files; the inspector gets the full path', async () => {
  assert.equal(core.toScope('fanout.js', ['/abs/x/workflows/fanout.js']), '/abs/x/workflows/fanout.js')
  assert.equal(core.toScope('src/a.py', ['/r/src/a.py', '/r/lib/b.py']), '/r/src/a.py')
  assert.equal(core.toScope('a.py', ['/r/src/a.py', '/r/old/a.py']), 'a.py', 'ambiguous basename stays as cited')
  const { calls } = await runFanout(baseArgs(), responder({ 'u1:1': okUnit({ files_read: ['src/a.py'], findings: [finding('a.py', 3)] }) }))
  const insp = calls.find(c => tagOf(c.prompt) === 'i:u1:1')
  assert.match(insp.prompt, /f0\.e0 \| src\/a\.py \| 3 \|/)
})

test('kill switch stops new work but never the planned verification', async () => {
  const a = baseArgs({ caps: { pauseUsd: 100, maxOutputTokens: 1000 } })
  a.units = [unit('k1', { scope: { files: ['src/k1.py'] } })]
  a.ultra = { ...a.ultra, agents: 6 }
  const r = await runFanout(a, responder({ 'k1:1': okUnit({ files_read: ['src/k1.py'], findings: [finding('src/k1.py', 3, 'high', 'h')] }) }),
    { spent: n => (n >= 2 ? 900 : 0), sequential: true })
  const v = r.calls.filter(c => tagOf(c.prompt).startsWith('v:'))
  assert.equal(v.length, 1, 'the V3 skeptic still ran after the kill switch tripped')
  assert.equal(r.res.results.claims[0].verdict, 'CONFIRMED')
})

test('promoted launches respect the work pool', async () => {
  const a = baseArgs()
  a.ultra = { ...a.ultra, agents: 4, verifiers: 0 }
  a.units = ['c1', 'c2', 'c3', 'c4'].map(id => unit(id))
  a.caps = { pauseUsd: 100, reserveCapPct: 100, rerouteRate: 1, ceilingUsd: 3.2 }
  const fail = okUnit({ status: 'blocked', blocked_reason: 'too_hard' })
  const { res } = await runFanout(a, responder({ 'c1:1': fail, 'c2:1': fail }), { sequential: true })
  for (const id of ['c3', 'c4']) {
    const L = res.ledger.units.find(l => l.id === id)
    assert.notEqual(L.outcome, 'ok-promoted', `${id} must not launch promoted past the work pool`)
  }
})

test('routing warning when most planned spend sits on the session model', async () => {
  const a = baseArgs({ dryRun: true })
  a.units = ['r1', 'r2', 'r3'].map(id => unit(id, { p: { effort: 'high' }, fb: { effort: 'xhigh' } }))
  a.ultra = { ...a.ultra, agents: 12 }
  const { res } = await runFanout(a, responder())
  assert.ok(res.warnings.some(w => /^routing: \d+% of planned work-unit spend runs on opus/.test(w)), res.warnings.join(' | '))
})

// ───────────────────────── 0.1.2 ─────────────────────────

const near = (x, y, msg) => assert.ok(Math.abs(x - y) <= 1.5e-4, `${msg || ''} ${x} vs ${y}`)

test('per-role calibration: agentOpts carries the role; estimates scale by role × global scale', () => {
  const K = core.calibrate()
  assert.deepEqual(K.scaleByRole, { work: 1.3, verify: 0.3, inspect: 0.7 })
  assert.equal(K.scale, 1)
  for (const k of ['implementer', 'worker', 'workerMcp', 'workerCtx']) assert.equal(core.agentOpts(k, K).role, 'work', k)
  assert.equal(core.agentOpts('skeptic', K).role, 'verify')
  assert.equal(core.agentOpts('inspector', K).role, 'inspect')
  const cell = { model: 'opus', effort: 'high' }
  const base = key => { const o = core.agentOpts(key, K); return core.estUsd(cell, 40000, 0, K, { lean: o.lean, cap: o.cap }) }
  near(core.estUsd(cell, 40000, 0, K, core.agentOpts('skeptic', K)), base('skeptic') * 0.3, 'skeptic')
  near(core.estUsd(cell, 40000, 0, K, core.agentOpts('inspector', K)), base('inspector') * 0.7, 'inspector')
  near(core.estUsd(cell, 40000, 0, K, core.agentOpts('worker', K)), base('worker') * 1.3, 'worker')
  // the global scale stays an extra multiplier on top of the role factor
  const K2 = core.calibrate({ scale: 2 })
  near(core.estUsd(cell, 40000, 0, K2, core.agentOpts('skeptic', K2)), base('skeptic') * 0.3 * 2, 'skeptic × scale')
  // the verification reserve is priced on the skeptic role
  const a = baseArgs()
  const V = core.validate(a)
  const M = core.price(a, V, K)
  assert.equal(M.verifyUsd, round(M.expected * core.estUsd(V.V3, 40000 * K.verifierInFrac, 0, K, core.agentOpts('skeptic', K))))
})

test('calibrate merges scaleByRole like the other object fields', () => {
  const K = core.calibrate({ scaleByRole: { verify: 0.5 }, scale: 1.2, highsPerUnit: 2 })
  assert.deepEqual(K.scaleByRole, { work: 1.3, verify: 0.5, inspect: 0.7 })
  assert.equal(K.scale, 1.2)
  assert.equal(K.highsPerUnit, 2)
  assert.equal(K.mediumsPerUnit, 4)
  assert.deepEqual(core.calibrate().scaleByRole, { work: 1.3, verify: 0.3, inspect: 0.7 }, 'defaults are not mutated')
})

test('the priced card carries the calibration factors it used', async () => {
  let { res } = await runFanout(baseArgs({ dryRun: true }), responder())
  assert.deepEqual(res.card.calib, { scale: 1, scaleByRole: { work: 1.3, verify: 0.3, inspect: 0.7 } })
  ;({ res } = await runFanout(baseArgs({ dryRun: true, calib: { scale: 1.5, scaleByRole: { verify: 0.2 } } }), responder()))
  assert.deepEqual(res.card.calib, { scale: 1.5, scaleByRole: { work: 1.3, verify: 0.2, inspect: 0.7 } })
})

test('medium defaults to rung V1: grounded, no skeptic launched', async () => {
  assert.equal(core.DEFAULT_RUNGS.medium, 'V1')
  assert.equal(core.validate(baseArgs()).rungs.medium, 'V1')
  assert.equal(core.rungFor({ severity: 'medium' }, core.DEFAULT_RUNGS), 'V1')
  assert.equal(core.rungFor({ severity: 'high' }, core.DEFAULT_RUNGS), 'V3')
  const { res, calls } = await runFanout(baseArgs(), responder({
    'u1:1': okUnit({ files_read: ['src/a.py'], findings: [finding('src/a.py', 3, 'medium', 'mid')] }),
  }))
  const c = res.results.claims.find(x => x.title === 'mid')
  assert.equal(c.rung, 'V1')
  assert.equal(c.verdict, 'PLAUSIBLE')
  assert.equal(c.verdictBy, 'V1')
  assert.equal(calls.filter(x => tagOf(x.prompt).startsWith('v:')).length, 0)
})

test('blocker/high claims are exempt from topK; topK bounds only the remaining V2+ claims', async () => {
  const a = baseArgs({ verify: { cells: { V3: { effort: 'high' } }, rungs: { medium: 'V2' }, topK: 1 } })
  const { res } = await runFanout(a, responder({
    'u2:1': okUnit({ files_read: ['src/b.py'], findings: [
      finding('src/b.py', 10, 'high', 'h1'), finding('src/b.py', 50, 'high', 'h2'), finding('src/b.py', 90, 'blocker', 'h3'),
      finding('src/b.py', 130, 'medium', 'm1'), finding('src/b.py', 170, 'medium', 'm2'),
    ] }),
  }))
  const by = t => res.results.claims.find(c => c.title === t)
  for (const t of ['h1', 'h2', 'h3']) {
    assert.notEqual(by(t).verdictBy, 'topK', `${t} must not be dropped by topK`)
    assert.equal(by(t).verdict, 'CONFIRMED', t)
  }
  assert.deepEqual(res.results.claims.filter(c => c.verdictBy === 'topK').map(c => c.title), ['m2'])
  // pure rule
  assert.equal(core.topKExempt({ severity: 'high' }, core.DEFAULT_RUNGS), true)
  assert.equal(core.topKExempt({ severity: 'medium', bump: 2 }, core.DEFAULT_RUNGS), false)
  assert.equal(core.topKExempt({ severity: 'low', parity: true }, core.DEFAULT_RUNGS), true)
  assert.equal(core.topKExempt({ severity: 'high' }, { ...core.DEFAULT_RUNGS, high: 'V2' }), false, 'a master who lowers high to V2 opts out')
})

test('price: expected verifier batches follow the expected findings', () => {
  const K = core.calibrate()
  const R = core.DEFAULT_RUNGS
  // 8 units, standard (batch 3, topK 12): ceil(8·0.9/3) = 3 batches for highs, mediums at V1 → 0
  assert.equal(core.expectedVerifiers(8, 'standard', {}, R, K), 3)
  // medium at V2: + ceil(min(8·4, 12)/3) = 4
  assert.equal(core.expectedVerifiers(8, 'standard', {}, { ...R, medium: 'V2' }, K), 7)
  // explicit batch and topK
  assert.equal(core.expectedVerifiers(8, 'standard', { batch: 5, topK: 8 }, { ...R, medium: 'V3' }, K), 2 + 2)
  // quick depth: batch 5, topK 6
  assert.equal(core.expectedVerifiers(4, 'quick', {}, { ...R, medium: 'V2' }, K), 1 + 2)
  // price() uses it when verify.expected is absent, and honours an explicit one
  const a = baseArgs()
  assert.equal(core.price(a, core.validate(a), K).expected, Math.ceil(2 * 0.9 / 3))
  const b = baseArgs({ verify: { cells: { V3: { effort: 'high' } }, rungs: { medium: 'V2' } } })
  assert.equal(core.price(b, core.validate(b), K).expected, 1 + Math.ceil(Math.min(2 * 4, 12) / 3))
  const c = baseArgs({ verify: { cells: { V3: { effort: 'high' } }, expected: 5 } })
  assert.equal(core.price(c, core.validate(c), K).expected, 5)
})

test('every unit prompt carries a numeric reading budget', async () => {
  const { calls } = await runFanout(baseArgs(), responder())
  const p = calls.find(c => tagOf(c.prompt) === 'u1:1').prompt
  assert.match(p, /- Reading budget: about 2500 lines in total \(~30000 tokens\); each Read at most ~250 lines\./)
  const lines = p.split('\n')
  const i = lines.findIndex(l => l.startsWith('- Budget:'))
  assert.match(lines[i + 1], /^- Reading budget:/, 'right after the Budget line')
})
