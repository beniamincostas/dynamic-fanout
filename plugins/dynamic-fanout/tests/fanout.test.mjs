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
  assert.equal(K.baseCtxLean, 11000)
  assert.equal(K.baseCtx, 15000)
  // turns ≈ (10 + in/2.5k) · effort factor, capped
  assert.equal(core.turnsFor({ model: 'opus', effort: 'high' }, 50000, K), 30)
  assert.equal(core.turnsFor({ model: 'opus', effort: 'high' }, 100000, K, 30), 30)
  assert.equal(core.turnsFor({ model: 'opus', effort: 'medium' }, 50000, K), 24)
  // lean opus·high, 50k read, capped at 30 turns, no role: write (11k + 1·50k)·4·1.25 + read 30·(11k + 25k)·4·0.1 + out 30·1500·20
  assert.equal(K.readFactor, 1)
  const want = round((61000 * 4 * 1.25 + 30 * 36000 * 4 * 0.1 + 30 * 1500 * 20) / 1e6)
  assert.equal(core.estUsd({ model: 'opus', effort: 'high' }, 50000, 0, K, { lean: true, cap: 30 }), want)
  // the full prefix + CLAUDE.md costs more than lean for the same work
  const full = core.estUsd({ model: 'opus', effort: 'high' }, 50000, 78000, K, { lean: false, cap: 30 })
  assert.ok(full > want * 1.4, `${full} vs ${want}`)
  // calib.scale (from the current price model) multiplies every estimate
  assert.equal(core.estUsd({ model: 'opus', effort: 'high' }, 50000, 0, core.calibrate({ pm: 3, scale: 2 }), { lean: true, cap: 30 }), round(want * 2))
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
  assert.equal(M.U, round(6 * core.estUsd(ref, 40000, 30000, K, ultraO) + 2 * core.estUsd(ref, 40000 * K.verifierInFrac, 30000, K, ultraO)))
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
  const inspected = { total: 1, resolved: 1, rate: 1, resolvedFiles: [] }
  const second = core.classify(u1, { ...ok, files_read: [] }, inspected, { capacityUsed: true })
  assert.equal(second.cls, 'capability', 'with an inspector, a cited file that was neither read nor resolved is a capability failure')
  assert.equal(core.classify(u1, { ...ok, files_read: [] }, { ...inspected, resolvedFiles: ['src/a.py'] }, { capacityUsed: true }).cls, 'ok', 'a resolved quote counts as read')
  assert.equal(core.classify(u1, { ...ok, files_read: [] }, null, { capacityUsed: true }).cls, 'ok', 'without an inspector it is only a soft signal')
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
  assert.equal(claim.rung, 'V3', 'medium (V2) + 1 for the re-route')
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
    'u1:1': okUnit({ files_read: ['src/a.py'], findings: [finding('src/a.py', 3, 'medium', 'parity med'), finding('src/a.py', 4, 'low', 'parity low')] }),
    'u2:1': okUnit({ files_read: ['src/b.py'], findings: [finding('src/b.py', 10, 'medium', 'm1'), finding('src/b.py', 50, 'medium', 'm2'), finding('src/b.py', 70, 'medium', 'm3'), finding('src/b.py', 90, 'low', 'l1')] }),
    'v:b1:1': p => verdictAll(p, 'REFUTED'),
  }))
  const byTitle = t => res.results.claims.find(c => c.title === t)
  assert.equal(byTitle('parity med').rung, 'V3', 'parity claims of medium and above are verified at V3 or higher')
  assert.equal(byTitle('parity low').rung, 'V0', 'low parity claims keep their own rung (0.1.5)')
  assert.equal(byTitle('l1').verdict, 'PLAUSIBLE')
  assert.equal(byTitle('l1').verdictBy, 'V0')
  const vcalls = calls.filter(c => tagOf(c.prompt).startsWith('v:'))
  const cells = vcalls.map(c => cellOfCall(c.opts)).sort()
  assert.ok(cells.includes('opus·high'), 'parity claim on S·high')
  assert.ok(cells.includes('sonnet·medium'), 'V2 on the producer model at medium')
  // parity claims bypass topK; topK = 2 of the 3 non-parity V2 claims → one is UNVERIFIED topK
  assert.notEqual(byTitle('parity med').verdictBy, 'topK')
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
  const sup = { support: { file: 'f', line: 2, quote: 'x' } }
  assert.equal(core.mergeVerdicts([{ verdict: 'CONFIRMED', ...sup }, { verdict: 'CONFIRMED', support_cmd: 'grep -n y f' }]).verdict, 'CONFIRMED')
  assert.equal(core.normalizeVerdict({ verdict: 'REFUTED', reason: 'no' }).verdict, 'PLAUSIBLE')
})

test('CONFIRMED needs the skeptic\'s own support: without it the verdict is kept as PLAUSIBLE', () => {
  const bare = core.normalizeVerdict({ cid: 'a', verdict: 'CONFIRMED', reason: 'looked' })
  assert.equal(bare.verdict, 'PLAUSIBLE')
  assert.equal(bare.reason, 'confirmed without own support: looked')
  const quoted = core.normalizeVerdict({ verdict: 'CONFIRMED', reason: 'r', support: { file: 'f', line: 1, quote: 'q' } })
  assert.equal(quoted.verdict, 'CONFIRMED')
  assert.equal(core.normalizeVerdict({ verdict: 'CONFIRMED', reason: 'r', support_cmd: 'grep -rn retry src/' }).verdict, 'CONFIRMED')
  assert.equal(core.normalizeVerdict({ verdict: 'CONFIRMED', reason: 'r', support: { file: 'f', line: 1 }, support_cmd: ' ' }).verdict, 'PLAUSIBLE', 'a quote-less support and a blank command do not count')
  // the schema and the skeptic rules ask for it
  const item = core.VERDICT.properties.verdicts.items.properties
  assert.deepEqual(item.support, core.EVIDENCE)
  assert.equal(item.support_cmd.maxLength, 200)
  assert.match(core.SKEPTIC_RULES, /support_cmd/)
  assert.match(core.SKEPTIC_RULES, /Without support, use PLAUSIBLE/)
})

test('V4: a lens that confirms without support makes the panel PLAUSIBLE', () => {
  const v = core.mergeVerdicts([
    { verdict: 'CONFIRMED', reason: 'a', support: { file: 'f', line: 2, quote: 'x' } },
    { verdict: 'CONFIRMED', reason: 'b' },
  ])
  assert.equal(v.verdict, 'PLAUSIBLE')
  assert.match(v.reason, /confirmed without own support/)
})

test('foreman: an unsupported CONFIRMED lands PLAUSIBLE; support is carried to results and digest', async () => {
  const quote = { file: 'src/b.py', line: 11, quote: 'other line' }
  const base = responder({
    'u2:1': okUnit({ files_read: ['src/b.py'], findings: [finding('src/b.py', 10, 'high', 'h1'), finding('src/b.py', 90, 'high', 'h2')] }),
  })
  // the skeptic quotes support for h1 only and confirms h2 on its say-so
  const skeptic = p => ({ verdicts: verdictAll(p, 'CONFIRMED', { support_cmd: undefined }).verdicts.map(v => (
    / \| h1$/m.test(p.split(`${v.cid} |`)[1].split('\n')[0]) ? { ...v, support: quote } : v)) })
  const { res } = await runFanout(baseArgs({ verify: { cells: { V3: { effort: 'high' } } } }),
    (p, o, n) => (tagOf(p).startsWith('v:') ? skeptic(p) : base(p, o, n)))
  const by = t => res.results.claims.find(c => c.title === t)
  assert.equal(by('h1').verdict, 'CONFIRMED')
  assert.deepEqual(by('h1').support, quote)
  assert.equal(by('h2').verdict, 'PLAUSIBLE')
  assert.match(by('h2').reason, /^confirmed without own support: /)
  assert.equal(res.digest.top.find(t => t.title === 'h1').support, 'src/b.py:11')
  assert.equal(res.digest.counts.confirmed, 1)
})

test('evidence is canonicalized onto scope at claim intake: absolute vs relative-suffix cites of the same scope file dedup to one claim', async () => {
  const a = baseArgs({
    units: [
      { id: 'u1', role: 'review', vec: 'D1 A0 T1 C0 V1 B1 G0', scope: { files: ['src/a.py'] }, in: 20000, ctx: 'omit',
        p: { model: 'sonnet', effort: 'medium' }, fb: { effort: 'high' }, check: 'quote', why: 'test', brief: 'review a.py (1)' },
      { id: 'u2', role: 'review', vec: 'D1 A0 T1 C0 V1 B1 G0', scope: { files: ['src/a.py'] }, in: 20000, ctx: 'omit',
        p: { model: 'sonnet', effort: 'medium' }, fb: { effort: 'high' }, check: 'quote', why: 'test', brief: 'review a.py (2)' },
    ],
  })
  const base = responder({
    'u1:1': okUnit({ files_read: ['src/a.py'], findings: [finding('src/a.py', 10, 'high', 'dup')] }),
    'u2:1': okUnit({ files_read: ['/repo/project/src/a.py'], findings: [finding('/repo/project/src/a.py', 10, 'high', 'dup')] }),
  })
  const { res } = await runFanout(a, base)
  const dups = res.results.claims.filter(c => c.title === 'dup')
  assert.equal(dups.length, 1, 'absolute and relative-suffix cites of the same scope file must dedup')
  assert.deepEqual(dups[0].evidence.map(e => e.file), ['src/a.py'])
  assert.ok(dups[0].mergedFrom && dups[0].mergedFrom.length === 1)
})

test('sweep evidence is canonicalized onto the union of unit scopes, so a sweep re-find of a known claim is not a new claim', async () => {
  const a = baseArgs({ sweep: { rounds: 1 } })
  const base = responder({
    'u1:1': okUnit({ files_read: ['src/a.py'], findings: [finding('src/a.py', 10, 'high', 'known')] }),
    's:1:1': okUnit({ findings: [finding('/repo/project/src/a.py', 10, 'high', 'known again'), finding('/repo/project/src/b.py', 40, 'medium', 'new in b')] }),
  })
  const { res } = await runFanout(a, base)
  const sweep = res.results.claims.filter(c => c.unit === 'sweep')
  assert.equal(sweep.length, 1, 'the absolute re-cite of a.py:10 matches the known claim')
  assert.deepEqual(sweep[0].evidence.map(e => e.file), ['src/b.py'], 'mapped onto the scope path of another unit')
})

test('verdict support and counter_quote paths are canonicalized onto scope', async () => {
  const a = baseArgs()
  const base = responder({
    'u1:1': okUnit({ files_read: ['src/a.py'], findings: [finding('src/a.py', 10, 'high', 'h1'), finding('src/a.py', 50, 'high', 'h2')] }),
  })
  const skeptic = p => ({
    verdicts: verdictAll(p, 'CONFIRMED').verdicts.map(v => (/ \| h1$/m.test(p.split(`${v.cid} |`)[1].split('\n')[0])
      ? { cid: v.cid, verdict: 'CONFIRMED', reason: 'seen', support: { file: '/repo/project/src/a.py', line: 11, quote: 'y = 2' } }
      : { cid: v.cid, verdict: 'REFUTED', reason: 'guarded', counter_quote: { file: '/repo/project/src/a.py', line: 48, quote: 'if ok:' } })),
  })
  const { res } = await runFanout(a, (p, o, n) => (tagOf(p).startsWith('v:') ? skeptic(p) : base(p, o, n)))
  const by = t => res.results.claims.find(c => c.title === t)
  assert.equal(by('h1').verdict, 'CONFIRMED')
  assert.equal(by('h1').support.file, 'src/a.py')
  assert.equal(by('h2').verdict, 'REFUTED')
  assert.equal(by('h2').counter_quote.file, 'src/a.py')
})

test('dedup merges one issue reported by two units near one line, keeping the higher severity and the merged title', () => {
  const claims = [
    { cid: 'a', unit: 'u1', title: 'total skips the last item', severity: 'medium', evidence: [{ file: './src/a.py', line: 10, quote: 'q' }], producer: { model: 'sonnet' } },
    { cid: 'b', unit: 'u2', title: 'Off-by-one: total() skips the last item', severity: 'high', evidence: [{ file: 'src/a.py', line: 11, quote: 'q2' }], producer: { model: 'opus' } },
    { cid: 'c', unit: 'u3', title: 'unrelated', severity: 'low', evidence: [{ file: 'src/a.py', line: 40, quote: 'q3' }] },
  ]
  const out = core.dedupClaims(claims, ['file', 'line'])
  assert.equal(out.length, 2)
  assert.equal(out[0].severity, 'high')
  assert.deepEqual(out[0].mergedFrom, ['b'])
  assert.deepEqual(out[0].merged.map(m => m.title), ['Off-by-one: total() skips the last item'])
  assert.equal(out[0].producer.model, 'opus')
})

test('dedup keeps distinct issues apart: one unit never reports one issue twice, and unlike titles on nearby lines are different bugs', () => {
  // The smoke-review case: one unit, two real bugs on adjacent lines of split().
  const sameUnit = core.dedupClaims([
    { cid: 'u2.f1', unit: 'u2', title: 'split loses remainder cents', severity: 'high', evidence: [{ file: 'svc/billing.py', line: 24, quote: 'q' }] },
    { cid: 'u2.f2', unit: 'u2', title: 'split divides by zero when parts is 0', severity: 'medium', evidence: [{ file: 'svc/billing.py', line: 23, quote: 'q' }] },
  ], ['file', 'line'])
  assert.equal(sameUnit.length, 2, 'adjacent findings of one unit stay two claims')
  const crossUnit = core.dedupClaims([
    { cid: 'a', unit: 'u1', title: 'parse_amount treats single-digit cents as hundredths', severity: 'high', evidence: [{ file: 'b.py', line: 31, quote: 'q' }] },
    { cid: 'b', unit: 'u2', title: 'parse_amount mishandles 3+ decimal digits and negatives', severity: 'medium', evidence: [{ file: 'b.py', line: 30, quote: 'q' }] },
  ], ['file', 'line'])
  assert.equal(crossUnit.length, 2, 'unlike titles two lines apart are different issues')
  const sameLine = core.dedupClaims([
    { cid: 'a', unit: 'u1', title: 'race on save', severity: 'high', evidence: [{ file: 'b.py', line: 31, quote: 'q' }] },
    { cid: 'b', unit: 'u2', title: 'state written before delivery', severity: 'medium', evidence: [{ file: 'b.py', line: 31, quote: 'q' }] },
  ], ['file', 'line'])
  assert.equal(sameLine.length, 1, 'two units on the exact same line merge')
  assert.deepEqual(sameLine[0].merged.map(m => m.cid), ['b'])
  const acrossBuckets = core.dedupClaims([
    { cid: 'a', unit: 'u1', title: 'fee boundary excludes the limit', severity: 'medium', evidence: [{ file: 'b.py', line: 9, quote: 'q' }] },
    { cid: 'b', unit: 'u2', title: 'fee boundary at the limit is wrong', severity: 'medium', evidence: [{ file: 'b.py', line: 10, quote: 'q' }] },
  ], ['file', 'line'])
  assert.equal(acrossBuckets.length, 1, 'alike titles one line apart merge even across the old 4-line bucket edge')
})

test('sweep keeps a distinct issue next to a known claim and drops a re-find of it', async () => {
  const a = baseArgs({ sweep: { rounds: 1 } })
  const base = responder({
    'u1:1': okUnit({ files_read: ['src/a.py'], findings: [finding('src/a.py', 10, 'high', 'total skips the last item')] }),
    's:1:1': okUnit({ findings: [finding('src/a.py', 11, 'medium', 'total divides by zero on empty input'), finding('src/a.py', 12, 'high', 'total() skips the last item (off by one)')] }),
  })
  const { res } = await runFanout(a, base)
  const sweep = res.results.claims.filter(c => c.unit === 'sweep').map(c => c.title)
  assert.deepEqual(sweep, ['total divides by zero on empty input'])
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
  assert.match(p, /nl -ba FILE \| sed -n/)
  assert.doesNotMatch(p, /Read only|offset\/limit/)
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
  assert.deepEqual(K.scaleByRole, { work: 1, verify: 0.3, inspect: 0.3, sweep: 2, implement: 3.5 })
  assert.equal(K.scale, 1)
  assert.equal(core.agentOpts('implementer', K).role, 'implement')
  for (const k of ['worker', 'workerMcp', 'workerCtx']) assert.equal(core.agentOpts(k, K).role, 'work', k)
  assert.equal(core.agentOpts('skeptic', K).role, 'verify')
  assert.equal(core.agentOpts('inspector', K).role, 'inspect')
  const cell = { model: 'opus', effort: 'high' }
  const base = key => { const o = core.agentOpts(key, K); return core.estUsd(cell, 40000, 0, K, { lean: o.lean, cap: o.cap }) }
  near(core.estUsd(cell, 40000, 0, K, core.agentOpts('skeptic', K)), base('skeptic') * 0.3, 'skeptic')
  near(core.estUsd(cell, 40000, 0, K, core.agentOpts('inspector', K)), base('inspector') * 0.3, 'inspector')
  near(core.estUsd(cell, 40000, 0, K, core.agentOpts('worker', K)), base('worker') * 1, 'worker')
  // the global scale stays an extra multiplier on top of the role factor
  const K2 = core.calibrate({ pm: 3, scale: 2 })
  near(core.estUsd(cell, 40000, 0, K2, core.agentOpts('skeptic', K2)), base('skeptic') * 0.3 * 2, 'skeptic × scale')
  // the verification reserve is priced on the skeptic role
  const a = baseArgs()
  const V = core.validate(a)
  const M = core.price(a, V, K)
  assert.equal(M.verifyUsd, round(M.expected * core.estUsd(V.V3, 40000 * K.verifierInFrac, 0, K, core.agentOpts('skeptic', K))))
})

test('calibrate merges scaleByRole like the other object fields', () => {
  const K = core.calibrate({ pm: 3, scaleByRole: { verify: 0.5 }, scale: 1.2, highsPerUnit: 2 })
  assert.deepEqual(K.scaleByRole, { work: 1, verify: 0.5, inspect: 0.3, sweep: 2, implement: 3.5 })
  assert.equal(K.scale, 1.2)
  assert.equal(K.highsPerUnit, 2)
  assert.equal(K.mediumsPerUnit, 5)
  assert.deepEqual(core.calibrate().scaleByRole, { work: 1, verify: 0.3, inspect: 0.3, sweep: 2, implement: 3.5 }, 'defaults are not mutated')
})

test('the priced card carries the calibration factors it used', async () => {
  let { res } = await runFanout(baseArgs({ dryRun: true }), responder())
  assert.deepEqual(res.card.calib, { pm: 3, scale: 1, scaleByRole: { work: 1, verify: 0.3, inspect: 0.3, sweep: 2, implement: 3.5 } })
  ;({ res } = await runFanout(baseArgs({ dryRun: true, calib: { pm: 3, scale: 1.5, scaleByRole: { verify: 0.2 } } }), responder()))
  assert.deepEqual(res.card.calib, { pm: 3, scale: 1.5, scaleByRole: { work: 1, verify: 0.2, inspect: 0.3, sweep: 2, implement: 3.5 } })
})

test('medium defaults to rung V2 (0.1.4): one skeptic per medium', async () => {
  assert.equal(core.DEFAULT_RUNGS.medium, 'V2')
  assert.equal(core.validate(baseArgs()).rungs.medium, 'V2')
  assert.equal(core.rungFor({ severity: 'medium' }, core.DEFAULT_RUNGS), 'V2')
  assert.equal(core.rungFor({ severity: 'high' }, core.DEFAULT_RUNGS), 'V3')
  assert.equal(core.topKExempt({ severity: 'medium' }, core.DEFAULT_RUNGS), false, 'topK still bounds mediums')
  const { res, calls } = await runFanout(baseArgs(), responder({
    'u1:1': okUnit({ files_read: ['src/a.py'], findings: [finding('src/a.py', 3, 'medium', 'mid')] }),
  }))
  const c = res.results.claims.find(x => x.title === 'mid')
  assert.equal(c.rung, 'V2')
  assert.equal(c.verdict, 'CONFIRMED')
  assert.equal(calls.filter(x => tagOf(x.prompt).startsWith('v:')).length, 1)
})

test('a master can still pin medium to V1: grounded, no skeptic launched', async () => {
  const a = baseArgs({ verify: { cells: { V3: { effort: 'high' } }, rungs: { medium: 'V1' } } })
  assert.equal(core.validate(a).rungs.medium, 'V1')
  const { res, calls } = await runFanout(a, responder({
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
  assert.equal(core.topKExempt({ severity: 'medium', parity: true }, core.DEFAULT_RUNGS), true)
  assert.equal(core.topKExempt({ severity: 'high' }, { ...core.DEFAULT_RUNGS, high: 'V2' }), false, 'a master who lowers high to V2 opts out')
})

test('price: expected verifier batches follow the expected findings', () => {
  const K = core.calibrate()
  const R = core.DEFAULT_RUNGS
  // 8 units, standard (batch 3, topK 12): ceil(8·0.9/3) = 3 batches for highs, mediums at the
  // V2 default: + ceil(min(8·5, 12)/3) = 4
  assert.equal(core.expectedVerifiers(8, 'standard', {}, R, K), 7)
  assert.equal(core.expectedVerifiers(8, 'standard', {}, { ...R, medium: 'V2' }, K), 7)
  // a medium pinned to V1 reserves none
  assert.equal(core.expectedVerifiers(8, 'standard', {}, { ...R, medium: 'V1' }, K), 3)
  // explicit batch and topK
  assert.equal(core.expectedVerifiers(8, 'standard', { batch: 5, topK: 8 }, { ...R, medium: 'V3' }, K), 2 + 2)
  // quick depth: batch 5, topK 6
  assert.equal(core.expectedVerifiers(4, 'quick', {}, { ...R, medium: 'V2' }, K), 1 + 2)
  // price() uses it when verify.expected is absent, and honours an explicit one
  const a = baseArgs({ verify: { cells: { V3: { effort: 'high' } }, rungs: { medium: 'V1' } } })
  assert.equal(core.price(a, core.validate(a), K).expected, Math.ceil(2 * 0.9 / 3))
  const b = baseArgs({ verify: { cells: { V3: { effort: 'high' } }, rungs: { medium: 'V2' } } })
  assert.equal(core.price(b, core.validate(b), K).expected, 1 + Math.ceil(Math.min(2 * 5, 12) / 3))
  const c = baseArgs({ verify: { cells: { V3: { effort: 'high' } }, expected: 5 } })
  assert.equal(core.price(c, core.validate(c), K).expected, 5)
})

test('every unit prompt carries a numeric reading budget', async () => {
  const { calls } = await runFanout(baseArgs(), responder())
  const p = calls.find(c => tagOf(c.prompt) === 'u1:1').prompt
  assert.match(p, /- Reading budget: about 2500 lines in total \(~30000 tokens\); each range at most ~250 lines\./)
  const lines = p.split('\n')
  const i = lines.findIndex(l => l.startsWith('- Budget:'))
  assert.match(lines[i + 1], /^- Reading budget:/, 'right after the Budget line')
})

test('inspector and skeptic prompts read through Bash, not the Read tool', async () => {
  const f = { ...finding('src/a.py', 3), severity: 'high' }
  const { calls } = await runFanout(baseArgs(), responder({ 'u1:1': okUnit({ files_read: ['src/a.py'], findings: [f] }) }))
  const insp = calls.find(c => tagOf(c.prompt) === 'i:u1:1')
  assert.ok(insp, 'an inspector ran')
  assert.match(insp.prompt, /print the cited lines with Bash \(`nl -ba FILE \| sed -n/)
  assert.doesNotMatch(insp.prompt, /open the file/)
  const sk = calls.find(c => /independent skeptic/.test(c.prompt))
  assert.ok(sk, 'a skeptic ran')
  assert.match(sk.prompt, /Check the files yourself with Bash \(`grep -n`, `nl -ba FILE \| sed -n/)
  assert.doesNotMatch(sk.prompt, /Read the files yourself/)
})

// ───────────────────────── 0.1.4: price model 3 ─────────────────────────

test('price model 3: leak-free defaults', () => {
  assert.equal(core.PRICE_MODEL, 3)
  const K = core.calibrate()
  assert.equal(K.baseCtxLean, 11000)
  assert.equal(K.readFactor, 1)
  assert.equal(K.ultraReadFactor, 4, 'ultracode agents read with Read and still get the nested CLAUDE.md')
  assert.equal(K.verifierInFrac, 0.25)
  assert.equal(K.sweepInFrac, 0.25)
  assert.deepEqual(K.scaleByRole, { work: 1, verify: 0.3, inspect: 0.3, sweep: 2, implement: 3.5 })
})

test('sweep is priced on its own role and a fraction of inAvg; the deep critic stays work', async () => {
  const K = core.calibrate()
  assert.equal(core.agentOpts('worker', K, 'sweep').role, 'sweep')
  assert.equal(core.agentOpts('worker', K, 'sweep').lean, true)
  const a = baseArgs({ sweep: { rounds: 2 } })
  const V = core.validate(a)
  const M = core.price(a, V, K)
  const sweepO = core.agentOpts('worker', K, 'sweep')
  near(M.sweepUsd, 2 * core.estUsd(V.sweepCell, 40000 * 0.25, 0, K, sweepO), 'sweepUsd')
  const raw = core.estUsd(V.sweepCell, 10000, 0, K, { lean: sweepO.lean, cap: sweepO.cap })
  near(core.estUsd(V.sweepCell, 10000, 0, K, sweepO), raw * 2, 'sweep role factor')
  // runtime: the sweep round commits the same sweep-role estimate
  const { res } = await runFanout({ ...a, sweep: { rounds: 1 }, caps: { pauseUsd: 1000 } }, responder())
  assert.equal(res.ledger.sweeps[0].estUsd, core.estUsd(V.sweepCell, 40000 * 0.25, 0, K, sweepO))
  // deep critic: role work
  const d = baseArgs({ depth: 'deep' })
  const Vd = core.validate(d)
  const Md = core.price(d, Vd, K)
  near(Md.criticUsd, core.estUsd(Vd.criticCell, 40000 * K.verifierInFrac, 0, K, core.agentOpts('worker', K)), 'criticUsd')
})

test('calibrate: scale/scaleByRole only from the current price model; other overrides still apply', async () => {
  let K = core.calibrate({ scale: 1.28, scaleByRole: { work: 2 }, highsPerUnit: 2 })
  assert.equal(K.scale, 1)
  assert.deepEqual(K.scaleByRole, core.DEFAULT_CALIB.scaleByRole)
  assert.equal(K.highsPerUnit, 2)
  assert.deepEqual(K.warnings, ['calib from price model none ignored (current 3)'])
  K = core.calibrate({ pm: 2, scaleByRole: { verify: 0.1 } })
  assert.deepEqual(K.warnings, ['calib from price model 2 ignored (current 3)'])
  assert.equal(K.scaleByRole.verify, 0.3)
  K = core.calibrate({ pm: 3, scale: 1.1, scaleByRole: { verify: 0.2 } })
  assert.deepEqual(K.warnings, [])
  assert.equal(K.scale, 1.1)
  assert.equal(K.scaleByRole.verify, 0.2)
  assert.deepEqual(core.calibrate({ highsPerUnit: 2 }).warnings, [], 'no factors passed -> nothing to warn about')
  // the warning reaches the dry-run card's warnings; the card records pm
  const { res } = await runFanout(baseArgs({ dryRun: true, calib: { scale: 1.28 } }), responder())
  assert.ok(res.warnings.includes('calib from price model none ignored (current 3)'), JSON.stringify(res.warnings))
  assert.equal(res.card.calib.pm, 3)
  assert.equal(res.card.calib.scale, 1)
})

// ───────────────────────── 0.1.5: foreman robustness ─────────────────────────

test('0.1.5: a cited file whose quote the inspector resolved counts as read', async () => {
  const { res, calls } = await runFanout(baseArgs(), responder({
    'u1:1': okUnit({ files_read: ['src/a.py'], findings: [finding('src/other.py', 3)] }),
  }))
  assert.equal(calls.filter(c => tagOf(c.prompt) === 'u1:2').length, 0, 'no re-route for a grepped, resolved cite')
  assert.equal(res.ledger.units.find(l => l.id === 'u1').outcome, 'ok')
})

test('0.1.5: without an inspector, cited-but-not-read is a soft signal only', async () => {
  const cite = conf => okUnit({ files_read: ['src/b.py'], confidence: conf, findings: [finding('src/other.py', 3, 'low')] })
  let { res, calls } = await runFanout(baseArgs(), responder({ 'u2:1': cite(0.9) }))
  assert.equal(calls.filter(c => tagOf(c.prompt) === 'u2:2').length, 0, 'confident unit is not re-routed')
  assert.equal(res.ledger.units.find(l => l.id === 'u2').outcome, 'ok')
  ;({ res, calls } = await runFanout(baseArgs(), responder({ 'u2:1': cite(0.3) })))
  assert.equal(calls.filter(c => tagOf(c.prompt) === 'u2:2').length, 1, 'low confidence + soft signal re-routes')
  assert.match(res.ledger.units.find(l => l.id === 'u2').attempts[0].cls, /capability/)
})

test('0.1.5: rescue — a failed unit\'s resolved claims go to verification one rung higher', async () => {
  const a = baseArgs()
  a.units[0].fb = null
  const two = [finding('src/a.py', 1, 'medium', 'grounded'), { ...finding('src/a.py', 9, 'medium', 'ungrounded'), evidence: [{ file: 'src/a.py', line: 9, quote: 'nope' }] }]
  const { res, calls } = await runFanout(a, responder({
    'u1:1': okUnit({ files_read: ['src/a.py'], status: 'blocked', blocked_reason: 'too_hard', findings: two }),
    'i:u1:1': { checks: [{ ref: 'f0.e0', found: true }, { ref: 'f1.e0', found: false }] },
  }))
  assert.equal(calls.filter(c => /^u1:/.test(tagOf(c.prompt))).length, 1)
  assert.equal(res.ledger.units[0].outcome, 'unverified')
  const [c1, c2] = ['u1.f1', 'u1.f2'].map(cid => res.results.claims.find(c => c.cid === cid))
  assert.equal(c1.verdict, 'CONFIRMED')
  assert.equal(c1.rung, 'V3', 'medium V2 + rescue bump')
  assert.match(c1.rescued, /^producer unit failed: exhausted \(fb null\)/)
  assert.equal(c2.verdict, 'UNVERIFIED')
  assert.equal(c2.rescued, null)
  assert.equal(res.digest.counts.rescued, 1)
  assert.equal(res.ledger.rescued, 1)
})

test('0.1.5: rescue also covers a refused re-route', async () => {
  const a = baseArgs()
  a.ultra = { ...a.ultra, agents: 20, verifiers: 4 }
  a.units = [unit('r1'), unit('r2'), unit('r3'), unit('r4'), unit('r5'), unit('r6'), unit('r7'), unit('r8')]
  a.caps = { pauseUsd: 100, rerouteRate: 0.01, reserveCapPct: 1 }
  const fail = id => okUnit({ files_read: [`src/${id}.py`], status: 'blocked', blocked_reason: 'too_hard', findings: [finding(`src/${id}.py`, 2, 'high')] })
  const { res } = await runFanout(a, responder({ 'r1:1': fail('r1'), 'r2:1': fail('r2') }), { sequential: true })
  const c = res.results.claims.find(x => x.cid === 'r2.f1')
  assert.match(c.rescued, /^producer unit failed: budget: re-route reserve exhausted/)
  assert.notEqual(c.verdict, 'UNVERIFIED')
  assert.equal(c.rung, 'V4')
})

test('0.1.5: a rescued low claim still gets a skeptic (floor V2), and keeps its rescue note', async () => {
  const a = baseArgs()
  a.units[0].fb = null
  const { res } = await runFanout(a, responder({
    'u1:1': okUnit({ files_read: ['src/a.py'], status: 'blocked', blocked_reason: 'too_hard', findings: [finding('src/a.py', 1, 'low', 'grounded low')] }),
  }))
  const c = res.results.claims.find(x => x.cid === 'u1.f1')
  assert.equal(c.rung, 'V2', 'low V0 + rescue bump would be V1; the rescue floor lifts it to V2')
  assert.equal(c.verdict, 'CONFIRMED', 'judged by a skeptic, not marked PLAUSIBLE on quotes alone')
  assert.match(c.rescued, /^producer unit failed: exhausted \(fb null\)/)
})

test('0.1.5: rescue covers a re-route that returned no result', async () => {
  const base = responder({
    'u1:1': okUnit({ files_read: ['src/a.py'], status: 'blocked', blocked_reason: 'too_hard', findings: [finding('src/a.py', 1, 'medium', 'grounded')] }),
  })
  const { res } = await runFanout(baseArgs(), (p, o, n) => (/^u1:[2-9]$/.test(tagOf(p)) ? null : base(p, o, n)))
  const L = res.ledger.units.find(l => l.id === 'u1')
  assert.equal(L.outcome, 'unverified')
  assert.match(L.reason, /re-route returned no result/)
  const c = res.results.claims.find(x => x.cid === 'u1.f1')
  assert.match(c.rescued, /^producer unit failed: re-route returned no result/)
  assert.notEqual(c.verdict, 'UNVERIFIED')
})

test('0.1.5: rescue covers a fallback that failed again, grounded on the fallback\'s own inspection', async () => {
  const fail = title => okUnit({ files_read: ['src/a.py'], status: 'blocked', blocked_reason: 'too_hard', findings: [finding('src/a.py', 5, 'medium', title)] })
  const { res } = await runFanout(baseArgs(), responder({ 'u1:1': fail('first try'), 'u1:2': fail('second try') }))
  const L = res.ledger.units.find(l => l.id === 'u1')
  assert.equal(L.outcome, 'unverified')
  assert.match(L.reason, /^after fallback/)
  const c = res.results.claims.find(x => x.unit === 'u1')
  assert.equal(c.title, 'second try', 'the claims come from the fallback attempt')
  assert.match(c.rescued, /^producer unit failed: after fallback/)
  assert.notEqual(c.verdict, 'UNVERIFIED')
})

test('0.1.5 rail: lenses 2 is refused on an allow-up card (it would run two above-session agents)', async () => {
  const a = baseArgs()
  a.session.allowUp = true
  a.units[0].p = { model: 'fable', effort: 'medium' }
  a.units[0].fb = null
  a.units[0].lenses = 2
  await rejects(a, /^card u1: lenses 2 cannot be combined with an above-session \(allow-up\) cell/)
})

test('0.1.5 rail: high/blocker rungs need V2 unless verify.waiver says why', async () => {
  const a = baseArgs()
  a.verify = { ...a.verify, rungs: { blocker: 'V0', high: 'V0', medium: 'V0', low: 'V0', info: 'V0' } }
  await rejects(a, /^verify: high\/blocker findings need at least V2; set verify\.waiver to run without/)
  a.verify.waiver = 'x'.repeat(201)
  await rejects(a, /^verify: waiver/)
  a.verify.waiver = 'smoke run on a throwaway branch'
  const { res } = await runFanout({ ...a, dryRun: true }, responder())
  assert.equal(res.reason, 'dryRun')
  assert.equal(res.card.verify.waiver, 'smoke run on a throwaway branch')
  const run = await runFanout(a, responder())
  assert.equal(run.res.digest.waiver, 'smoke run on a throwaway branch')
})

test('0.1.5: the parity V3 floor applies to medium and above only', () => {
  assert.equal(core.rungFor({ severity: 'low', parity: true }, core.DEFAULT_RUNGS), 'V0')
  assert.equal(core.rungFor({ severity: 'info', parity: true }, core.DEFAULT_RUNGS), 'V0')
  assert.equal(core.rungFor({ severity: 'medium', parity: true }, core.DEFAULT_RUNGS), 'V3')
  assert.equal(core.topKExempt({ severity: 'low', parity: true }, core.DEFAULT_RUNGS), false)
  assert.equal(core.topKExempt({ severity: 'medium', parity: true }, core.DEFAULT_RUNGS), true)
})

test('0.1.5: implementers price as their own role', () => {
  const K = core.calibrate()
  assert.equal(K.scaleByRole.implement, 3.5)
  assert.equal(core.agentOpts('implementer', K).role, 'implement')
  assert.equal(core.agentOpts('worker', K).role, 'work')
  const cell = { model: 'opus', effort: 'high' }
  const w = core.estUsd(cell, 20000, 0, K, core.agentOpts('workerCtx', K))
  const i = core.estUsd(cell, 20000, 0, K, core.agentOpts('implementer', K))
  assert.ok(i > 3 * w, `implement ${i} vs work ${w}`)
})

// ───────────────────────── 0.1.5 t2: severity calibration, findings cap ─────────────────────────

test('0.1.5: the severity rubric is in the unit, sweep and skeptic prompts', async () => {
  assert.match(core.SEVERITY_RUBRIC, /blocker = /)
  assert.match(core.SEVERITY_RUBRIC, /Rate by what the code does today, not the worst imaginable case; most findings are medium or low\./)
  assert.ok(core.RULES.includes(core.SEVERITY_RUBRIC), 'RULES carries the rubric')
  assert.ok(core.SKEPTIC_RULES.includes(core.SEVERITY_RUBRIC), 'SKEPTIC_RULES carries the rubric')
  const { calls } = await runFanout(baseArgs({ sweep: { rounds: 1 } }), responder({
    'u1:1': okUnit({ files_read: ['src/a.py'], findings: [finding('src/a.py', 3, 'high')] }),
  }))
  const unitCall = calls.find(c => tagOf(c.prompt) === 'u1:1')
  const sweepCall = calls.find(c => tagOf(c.prompt).startsWith('s:'))
  const skepCall = calls.find(c => tagOf(c.prompt).startsWith('v:'))
  for (const [name, c] of [['unit', unitCall], ['sweep', sweepCall], ['skeptic', skepCall]]) {
    assert.ok(c, `${name} call ran`)
    assert.ok(c.prompt.includes(core.SEVERITY_RUBRIC), `${name} prompt carries the rubric`)
  }
  assert.match(core.SKEPTIC_RULES, /For every claim you check, state your own severity rating/)
})

test('0.1.5: VERDICT requires severity; the findings cap is 15', () => {
  const item = core.VERDICT.properties.verdicts.items
  assert.ok(item.required.includes('severity'))
  assert.equal(core.UNIT_RESULT.properties.findings.maxItems, 15)
  assert.equal(core.MAX_INSPECT_QUOTES, 60)
  assert.equal(core.calibrate().mediumsPerUnit, 5)
  assert.match(core.RULES, /at most 15 findings/)
})

test('0.1.5: verifiedSeverity is always stored and drives digest ordering', async () => {
  const fs = Array.from({ length: 15 }, (_, i) => finding('src/a.py', i + 1, i === 0 ? 'high' : 'medium', `t${i}`))
  const base = responder({
    'u1:1': okUnit({ files_read: ['src/a.py'], findings: fs }),
    'u2:1': okUnit({ files_read: ['src/b.py'], findings: [finding('src/b.py', 2, 'medium', 'other')] }),
  })
  // The skeptic downgrades the high claim t0 to low and states no severity for the rest.
  const { res } = await runFanout(baseArgs(), (prompt, o, n) => {
    if (!tagOf(prompt).startsWith('v:')) return base(prompt, o, n)
    const r = verdictAll(prompt, 'CONFIRMED')
    for (const v of r.verdicts) if (prompt.includes(`${v.cid} | high | t0`)) v.severity = 'low'
    return r
  })
  const verified = res.results.claims.filter(c => c.verdict && c.verdict !== 'PENDING' && c.verdict !== 'UNVERIFIED' && c.rung && c.rung !== 'V0' && c.rung !== 'V1')
  assert.ok(verified.length > 0, 'some claims were verified by a skeptic')
  for (const c of verified) assert.ok(c.verifiedSeverity, `${c.cid} carries verifiedSeverity`)
  const t0 = res.results.claims.find(c => c.title === 't0')
  assert.equal(t0.severity, 'high', 'the filed severity is kept')
  assert.equal(t0.verifiedSeverity, 'low')
  assert.equal(t0.rung, 'V3', 'the rung is chosen from the filed severity')
  assert.notEqual(res.digest.top[0].title, 't0', 'top orders by verifiedSeverity')
  assert.equal(res.results.claims.filter(c => c.unit === 'u1').length, 15, 'a 15-finding unit is accepted whole')
})

// ───────────────────────── two-lens split (0.1.5) ─────────────────────────

test('lenses 2: a review card expands into <id>A and <id>B with the same card and one lens line each', () => {
  const a = baseArgs()
  a.units[0].lenses = 2
  const V = core.validate(a)
  assert.deepEqual(V.errors, [])
  assert.deepEqual(V.units.map(u => u.id), ['u1A', 'u1B', 'u2'])
  const [A, B] = V.units
  for (const k of ['cell', 'fbCell', 'checks', 'ctx', 'scope', 'in', 'vec', 'why']) assert.deepEqual(A[k], B[k], k)
  assert.equal(A.cell.effort, 'medium')
  assert.equal(A.lensOf, 'u1')
  assert.equal(A.brief, 'review a.py\nLens: inputs and data: unusual, missing, duplicated or malformed values, None/empty/zero, boundaries, encodings, rounding.')
  assert.equal(B.brief, 'review a.py\nLens: time and ordering: re-runs and replay, partial failure, the order of side effects, dates, clocks and business days, concurrency.')
})

test('lenses 2: both copies are priced (that unit\'s spend doubles) and shown on the card', async () => {
  const one = await runFanout(baseArgs({ dryRun: true }), responder())
  const a = baseArgs({ dryRun: true })
  a.units[0].lenses = 2
  const two = await runFanout(a, responder())
  assert.equal(two.res.reason, 'dryRun', JSON.stringify(two.res.errors))
  const u1 = one.res.card.units.find(u => u.id === 'u1')
  const rows = two.res.card.units.filter(u => u.lensOf === 'u1')
  assert.deepEqual(rows.map(u => u.id), ['u1A', 'u1B'])
  assert.deepEqual(rows.map(u => u.lens), ['A', 'B'])
  for (const r of rows) assert.equal(r.estUsd, u1.estUsd)
  assert.ok(two.res.card.money.P > one.res.card.money.P)
})

test('lenses 2: each copy runs once with its lens line; a duplicate finding merges, distinct ones stay', async () => {
  const a = baseArgs()
  a.units[0].lenses = 2
  const { res, calls } = await runFanout(a, responder({
    'u1A:1': okUnit({ files_read: ['src/a.py'], findings: [finding('src/a.py', 3, 'medium', 'total skips the last item'), finding('src/a.py', 40, 'low', 'empty list crashes')] }),
    'u1B:1': okUnit({ files_read: ['src/a.py'], findings: [finding('src/a.py', 3, 'medium', 'total skips the last item'), finding('src/a.py', 80, 'low', 'retry replays the write')] }),
  }))
  const pA = calls.find(c => tagOf(c.prompt) === 'u1A:1').prompt
  const pB = calls.find(c => tagOf(c.prompt) === 'u1B:1').prompt
  assert.match(pA, /Lens: inputs and data/)
  assert.doesNotMatch(pA, /Lens: time and ordering/)
  assert.match(pB, /Lens: time and ordering/)
  assert.deepEqual(res.ledger.units.map(u => u.id).sort(), ['u1A', 'u1B', 'u2'])
  const titles = res.results.claims.map(c => c.title).sort()
  assert.deepEqual(titles, ['empty list crashes', 'retry replays the write', 'total skips the last item'])
})

test('lenses 2: an override by the original id applies to both copies', () => {
  const a = baseArgs()
  a.units[0].lenses = 2
  a.overrides = [{ id: 'u1', p: { model: 'opus', effort: 'high' }, by: 'user' }]
  const V = core.validate(a)
  assert.deepEqual(V.warnings.filter(w => /^override/.test(w)), [])
  for (const u of V.units.slice(0, 2)) {
    assert.equal(u.override, 'user')
    assert.equal(cellKeyOf(u.cell), 'opus·high')
    assert.equal(u.fbCell, null)
  }
})

const cellKeyOf = c => `${c.model}·${c.effort}`

test('rail: lenses must be 1 or 2, only on review/research cards, never with n:1', async () => {
  const a = baseArgs()
  a.units[0].lenses = 3
  await rejects(a, /^card u1: lenses must be 1 or 2/)
  const b = baseArgs({ kind: 'data' })
  b.units[1] = { ...b.units[1], n: 1, check: 'tieout+rederive', lenses: 2 }
  await rejects(b, /^card u2: lenses 2 is only for kind review or research/)
  await rejects(b, /^card u2: lenses 2 cannot be combined with n:1/)
})
