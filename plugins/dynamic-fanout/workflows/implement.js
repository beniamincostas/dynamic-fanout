export const meta = {
  name: 'implement',
  description: 'dynamic-fanout implement: prices the themes through the foreman, runs them serially test-first under a hard cost ceiling, at most one repair pass per theme on its pre-chosen fallback, then one independent whole-diff review',
  whenToUse: 'Called by the dynamic-fanout skill with args v1 (themes, worktree, test command, ceiling; see references/playbooks/implement.md). A bare invocation without args does nothing: run /dynamic-fanout:dynamic-fanout <task> so the master can plan it.',
  phases: [
    { title: 'Validate', detail: 'shape checks, then the foreman prices the theme cards (dry run); over the ceiling, dry run or pause stops here' },
    { title: 'Implement', detail: 'one implementer per theme, serially; at most one repair pass on fb; every launch metered against the ceiling' },
    { title: 'Review', detail: 'one reviewer over the run\'s commits when at least one theme landed' },
  ],
}

// The implement loop the master used to hand-write from the playbook, with the cost
// envelope and the pass cap in code instead of prose. Like the foreman, this file never
// picks a model or an effort: every cell is one the master wrote on a theme (p, fb) or in
// review.cell. Pricing is the foreman's (a kind:'implement' dry run), so implement and
// fan-out estimates come from one price model.

// ═══════════════════════════════ CORE (pure) ═══════════════════════════════

const MODELS = ['haiku', 'sonnet', 'opus', 'fable']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const ID_RE = /^[A-Za-z0-9][\w.-]{0,39}$/
// A block the master has to fix (the brief, access, scope) is not a capability failure:
// a repair pass on a stronger cell would hit the same wall.
const BRIEF_BLOCK_RE = /brief|access|scope/i
// Stand-in for the reviewer's price: the foreman has no reviewer role to price, and a
// whole-diff review reads every theme's changes, so it is priced conservatively at 1.5x
// the largest single theme estimate (a real run: the review outgrew the skeptic's 12-turn
// cap that suits one claim, which is why the reviewer agent has 30).
const REVIEW_FACTOR = 1.5
const TOOL_CALLS = 35

const er = e => EFFORTS.indexOf(e)
const round4 = x => Math.round(x * 10000) / 10000
const minEffort = (want, cap) => (er(cap) >= 0 && er(want) > er(cap) ? cap : want)
// 1500 cut a reviewer off mid-brief on a 4-theme release; the whole list stays well under a
// typical prompt budget at 4000 per theme.
const REVIEW_BRIEF_CHARS = 4000
const briefText = s => {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > REVIEW_BRIEF_CHARS ? `${t.slice(0, REVIEW_BRIEF_CHARS)}…` : t
}

function validateArgs(a) {
  const errors = []
  if (!a || typeof a !== 'object') return ['args: missing — pass the args object']
  if (a.v !== 1) errors.push(`args: v must be 1 (got ${JSON.stringify(a.v)})`)
  if (typeof a.worktree !== 'string' || !/^(\/|[A-Za-z]:[\\/])/.test(a.worktree)) errors.push('args: worktree must be an absolute path (already on the work branch)')
  if (typeof a.testCmd !== 'string' || !a.testCmd.trim()) errors.push('args: testCmd must be a shell command that exits 0 when the suite is green')
  if (typeof a.commitPrefix !== 'string' || !a.commitPrefix.trim()) errors.push('args: commitPrefix missing (e.g. \'fix(scope):\')')
  const b = a.baseline
  if (b !== undefined && (!b || typeof b !== 'object' || !(Number(b.passed) >= 0))) errors.push('args: baseline must be { passed, skipped }')
  const s = a.session || {}
  if (!MODELS.includes(s.S)) errors.push(`session: S must be one of ${MODELS.join('|')}`)
  if (!Array.isArray(a.themes) || !a.themes.length) errors.push('args: themes must be a non-empty array')
  else {
    const seen = new Set()
    for (const t of a.themes) {
      const id = t && t.id
      if (typeof id !== 'string' || !ID_RE.test(id)) { errors.push(`theme ${JSON.stringify(id)}: id must be 1-40 chars of letters, digits, . _ -`); continue }
      if (seen.has(id)) errors.push(`args: duplicate theme id ${id}`)
      seen.add(id)
      if (typeof t.brief !== 'string' || !t.brief.trim()) errors.push(`theme ${id}: brief missing`)
      if (!t.p || typeof t.p !== 'object') errors.push(`theme ${id}: p missing — { model?, effort }`)
    }
  }
  const caps = a.caps || {}
  if (!(typeof caps.ceilingUsd === 'number' && caps.ceilingUsd > 0)) errors.push('caps: ceilingUsd is required and must be > 0')
  if (caps.pauseUsd !== undefined && !(typeof caps.pauseUsd === 'number' && caps.pauseUsd > 0)) errors.push('caps: pauseUsd must be a number > 0')
  const rc = a.review && a.review.cell
  if (rc) {
    if (rc.model !== undefined && (!MODELS.includes(rc.model) || rc.model === 'haiku')) errors.push('review: cell model must be sonnet|opus|fable (the reviewer reads files and runs git)')
    if (er(rc.effort) < 0) errors.push(`review: cell effort must be one of ${EFFORTS.join('|')}`)
  }
  return errors
}

// The foreman's args for pricing: one implement card per theme, dry run only.
function priceArgs(a) {
  const ins = a.themes.map(t => Number(t.in)).filter(x => x > 0)
  return {
    v: 2, kind: 'implement', depth: 'standard', dryRun: true, session: a.session, shared: a.shared || '',
    ultra: { agents: a.themes.length, verifiers: 1, ctxTok: 0, inAvg: ins.length ? Math.round(ins.reduce((x, y) => x + y, 0) / ins.length) : 30000, basis: 'implement: one agent per theme' },
    units: a.themes.map(t => ({
      id: t.id, role: 'implement', vec: t.vec, why: t.why, brief: t.brief, ...(Number(t.in) > 0 ? { in: Number(t.in) } : {}),
      ...(Number(t.ctxTok) > 0 ? { ctxTok: Number(t.ctxTok) } : {}),
      ctx: 'keep', p: t.p, fb: t.fb || null, check: 'tests',
    })),
    caps: { ceilingUsd: a.caps.ceilingUsd },
    // learned pricing factors (stats.mjs CALIB line), so themes price with scaleByRole.implement
    ...(a.calib && typeof a.calib === 'object' ? { calib: a.calib } : {}),
  }
}

const RESULT = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ok', 'partial', 'blocked'] },
    blocked_reason: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    suite: {
      type: 'object',
      properties: { passed: { type: 'integer', minimum: 0 }, failed: { type: 'integer', minimum: 0 } },
      required: ['passed', 'failed'],
    },
    commit: { type: 'string' },
    summary: { type: 'string', maxLength: 600 },
  },
  required: ['status', 'files_changed', 'suite', 'summary'],
}

const isOk = r => !!r && r.status === 'ok' && !!r.suite && r.suite.failed === 0
const isBriefBlock = r => !!r && r.status === 'blocked' && BRIEF_BLOCK_RE.test(String(r.blocked_reason || ''))

function rules(a) {
  const b = a.baseline || {}
  const base = Number(b.passed) >= 0 ? `baseline ${b.passed} passed${Number(b.skipped) > 0 ? `, ${b.skipped} skipped` : ''}, 0 failed` : 'baseline all green'
  return [
    'Rules for this theme:',
    `- Work only in ${a.worktree}; it is already on the work branch. Never push, switch or create branches, deploy, call external services or the network, or read, print or edit .env files and credentials.`,
    '- Test first: write or extend a test that fails for the reason in the brief, then make the change that turns it green.',
    '- Touch only the files the change needs, plus their tests. Follow the repo\'s conventions.',
    `- Run \`${a.testCmd}\` from ${a.worktree}. It must exit 0 and stay all green against the ${base}; report the final counts in suite {passed, failed}.`,
    `- When the suite is green, commit your change (only the files you changed) with a message starting "${a.commitPrefix}" and report the commit id in commit.`,
    `- Budget: about ${TOOL_CALLS} tool calls. Find before you read: grep or glob first, then Read only the line ranges you need. Keep your last 2 calls for the answer.`,
    '- status ok = change committed and suite green. partial = not finished (say what is left in summary). blocked = set blocked_reason: name brief, access or scope when the brief is unclear, you lack access, or the work is outside the scope; otherwise say why it is too hard.',
    '- Your final answer is the structured output only; summary at most 600 characters.',
  ].join('\n')
}

function themePrompt(a, t, n, prev) {
  const lines = [a.shared || '', '', `## Theme ${t.id}`, t.brief, '', rules(a)]
  if (!prev) {
    lines.push(`- Before you start, run \`git -C ${a.worktree} status --short\`. If it shows uncommitted changes you did not make, stop: status blocked, blocked_reason "scope: dirty worktree".`)
  } else {
    lines.push('', [
      'Repair: an earlier attempt at this theme did not finish green. Its result was:',
      JSON.stringify(prev || null).slice(0, 3000),
      `Inspect the branch state first (\`git -C ${a.worktree} status\`, \`git -C ${a.worktree} log --oneline -5\`, the diff). Keep what is right, fix or finish the rest, make the suite green and commit. This is the last attempt for this theme.`,
    ].join('\n'))
  }
  lines.push('', `⟦df:${t.id}:${n}⟧`)
  return lines.join('\n')
}

function reviewPrompt(a, themes, commits) {
  const range = commits.length ? `${commits[0]}^..HEAD` : null
  // The whole brief (whitespace collapsed, capped), not just its first line: a reviewer
  // that only sees item 1 of a multi-item brief flags items 2..n as scope creep and
  // cannot judge them against what was asked.
  const changes = themes.map(r => `- ${r.id} (${r.outcome}): ${briefText(r.brief)}`).join('\n')
  return {
    range,
    prompt: [
      a.shared || '', '', '## Whole-diff review',
      `Worktree: ${a.worktree}`,
      range
        ? `Range: ${range} (commits made in this run: ${commits.join(', ')}). Start with \`git -C ${a.worktree} log --oneline ${range}\` and \`git -C ${a.worktree} diff ${range}\`.`
        : `No commit ids were reported. Find this run's commits with \`git -C ${a.worktree} log --oneline\` (subjects start with "${a.commitPrefix}") and review them against the parent of the first one.`,
      `Test command (run from the worktree, at most once): ${a.testCmd}`,
      '',
      'Intended changes (id, outcome of its implementer, its brief):',
      changes,
      '',
      'Judge each intended change FIXED / PARTIAL / NOT FIXED / NOT CHECKED with file:line and its test coverage; list regressions and new risks (anything that makes a live system write, close, send or charge more, or silences an alert, comes first); end with SAFE TO MERGE or NEEDS CHANGES. Read-only: never edit or commit.',
      '',
      '⟦df:review:1⟧',
    ].join('\n'),
  }
}

// @core-end
// ═══════════════════════════════ RUN ═══════════════════════════════

let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch (e) { A = null } }
if (!A || typeof A !== 'object' || !Object.keys(A).length) {
  log('implement was started without args, so there is nothing to run. Use /dynamic-fanout:dynamic-fanout <task> so the master can plan it.')
  return { started: false, reason: 'no-args' }
}

phase('Validate')
const shapeErrors = validateArgs(A)
if (shapeErrors.length) {
  log(`implement rejected: ${shapeErrors.length} shape error(s); no agent launched`)
  return { started: false, reason: 'rails', errors: shapeErrors }
}

const S = A.session.S
const W = A.session.W || S
const ceilingUsd = A.caps.ceilingUsd
const priced = await workflow('dynamic-fanout:fanout', priceArgs(A))
if (!priced || typeof priced !== 'object') return { started: false, reason: 'rails', errors: ['price: the foreman dry run returned nothing'] }
if (priced.reason === 'rails') return { started: false, reason: 'rails', errors: priced.errors || [], warnings: priced.warnings || [], card: priced.card || null }
if (priced.reason !== 'dryRun' || !priced.card) return { started: false, reason: 'rails', errors: [`price: unexpected foreman result (${JSON.stringify(priced.reason || priced.started)})`] }
const card = priced.card
const warnings = priced.warnings || []
const estOf = new Map(card.units.map(u => [u.id, Number(u.estUsd) || 0]))

const reviewOn = !(A.review && A.review.enabled === false)
const reviewCell = (A.review && A.review.cell) || { model: W, effort: minEffort('high', A.session.refEffort) }
const unitSum = A.themes.reduce((t, x) => t + estOf.get(x.id), 0)
const reviewEst = reviewOn ? REVIEW_FACTOR * Math.max(0, ...A.themes.map(x => estOf.get(x.id))) : 0
const estimate = { units: round4(unitSum), review: round4(reviewEst), total: round4(unitSum + reviewEst) }
const total = unitSum + reviewEst

if (total > ceilingUsd + 1e-9) {
  log(`implement refused: estimate $${estimate.total} exceeds ceilingUsd $${ceilingUsd}`)
  return { started: false, reason: 'money', card, estimate, warnings, note: `estimate $${estimate.total} exceeds ceilingUsd $${ceilingUsd}: drop or merge themes, lower effort, or raise the ceiling with the user` }
}
if (A.dryRun) return { started: false, reason: 'dryRun', card, estimate, warnings }
if (typeof A.caps.pauseUsd === 'number' && total > A.caps.pauseUsd && !A.confirmed) {
  return { started: false, reason: 'pause', card, estimate, warnings, note: `estimate $${estimate.total} exceeds pauseUsd $${A.caps.pauseUsd}: show the card, then re-run with confirmed: true` }
}
log(`plan accepted: ${A.themes.length} theme(s), estimate $${estimate.total} (themes $${estimate.units} + review $${estimate.review}), ceiling $${ceilingUsd}`)

// Meter: every launch commits its estimate first (a repair is priced like the theme's
// primary). Theme launches also hold back the review's estimate, so repairs cannot eat
// the budget of the one check that gates the merge.
let committed = 0
const hold = reviewOn ? reviewEst : 0
const fits = (est, reserve) => committed + est + reserve <= ceilingUsd + 1e-9

const cellOf = c => ({ model: (c && c.model) || S, effort: c && c.effort })
const cellKey = c => `${c.model}·${c.effort}`
function opts(cell, label, phaseName, agentType, schema) {
  const o = { label, phase: phaseName, agentType, effort: cell.effort }
  if (cell.model !== S) o.model = cell.model
  if (schema) o.schema = schema
  return o
}
async function launch(prompt, o) {
  try { return (await agent(prompt, o)) || null } catch (e) { return null }
}

phase('Implement')
const results = []
for (const t of A.themes) {
  const est = estOf.get(t.id)
  const R = { id: t.id, brief: t.brief, attempts: [], outcome: null, result: null }
  results.push(R)
  const attempt = async (n, kind, spec, prev) => {
    const cell = cellOf(spec)
    if (!fits(est, hold)) {
      R.attempts.push({ n, cell: cellKey(cell), kind, ok: false, refused: 'budget' })
      return { refused: true }
    }
    committed += est
    const res = await launch(themePrompt(A, t, n, prev), opts(cell, `${t.id}·${cellKey(cell)}${kind === 'repair' ? '·repair' : ''}`, 'Implement', 'dynamic-fanout:implementer', RESULT))
    R.attempts.push({ n, cell: cellKey(cell), kind, ok: isOk(res) })
    return { res }
  }

  let r = await attempt(1, 'primary', t.p, null)
  if (r.refused) { R.outcome = 'refused'; R.reason = 'budget'; log(`${t.id}: refused (budget)`); continue }
  R.result = r.res
  if (isOk(r.res)) { R.outcome = 'ok'; continue }
  if (isBriefBlock(r.res)) { R.outcome = 'brief'; R.reason = r.res.blocked_reason; continue }
  if (!t.fb) { R.outcome = 'failed'; R.reason = r.res ? `${r.res.status}; fb null` : 'no result; fb null'; continue }
  // The one repair pass. Never a third attempt.
  r = await attempt(2, 'repair', t.fb, r.res || { status: 'none', summary: 'the first attempt returned no result' })
  if (r.refused) { R.outcome = 'refused'; R.reason = 'budget (repair)'; log(`${t.id}: repair refused (budget)`); continue }
  if (r.res) R.result = r.res
  R.outcome = isOk(r.res) ? 'ok-repaired' : 'failed'
  if (R.outcome === 'failed') R.reason = r.res ? `after repair: ${r.res.status}` : 'after repair: no result'
  log(`${t.id}: repaired on ${cellKey(cellOf(t.fb))} -> ${R.outcome}`)
}
for (const R of results) {
  const b = A.baseline
  if (R.result && R.result.suite && b && Number(R.result.suite.passed) < Number(b.passed)) {
    R.warning = `suite passed ${R.result.suite.passed} < baseline ${b.passed}: tests may have been removed or skipped`
  }
}

const landed = results.filter(R => R.outcome === 'ok' || R.outcome === 'ok-repaired')
let review = null
if (!reviewOn) review = { ran: false, reason: 'disabled' }
else if (!landed.length) review = { ran: false, reason: 'no theme landed' }
else {
  phase('Review')
  const commits = [...new Set(results.map(R => R.result && R.result.commit).filter(c => typeof c === 'string' && c.trim()).map(c => c.trim()))]
  const rp = reviewPrompt(A, results, commits)
  const cell = cellOf(reviewCell)
  if (!fits(reviewEst, 0)) review = { ran: false, reason: 'budget', cell: cellKey(cell) }
  else {
    committed += reviewEst
    const text = await launch(rp.prompt, opts(cell, `review·${cellKey(cell)}`, 'Review', 'dynamic-fanout:reviewer', null))
    review = { ran: true, cell: cellKey(cell), range: rp.range, text }
  }
}

const count = o => results.filter(R => R.outcome === o).length
const summary = { ok: count('ok'), repaired: count('ok-repaired'), failed: count('failed'), brief: count('brief'), refused: count('refused') }
log(`done: ${summary.ok + summary.repaired}/${results.length} theme(s) landed (${summary.repaired} repaired), ${summary.failed} failed, ${summary.brief} brief, ${summary.refused} refused; committed $${round4(committed)} of $${ceilingUsd}`)
return {
  started: true,
  card,
  estimate,
  money: { committedUsd: round4(committed), ceilingUsd },
  results: results.map(({ brief, ...R }) => R),
  review,
  summary,
  warnings,
}
