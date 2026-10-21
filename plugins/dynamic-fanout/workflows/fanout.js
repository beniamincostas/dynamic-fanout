export const meta = {
  name: 'fanout',
  description: 'dynamic-fanout foreman: validates the master\'s routing cards, prices them against an ultracode estimate, runs each unit on its card, inspects, re-routes at most once onto the pre-chosen fallback, dedups, verifies by rung, returns digest + ledger',
  whenToUse: 'Called by the dynamic-fanout skill with args v2 (one routing card per unit, see references/workflow.md). A bare invocation without args does nothing: run /dynamic-fanout:dynamic-fanout <task> so the master can plan it.',
  phases: [
    { title: 'Validate', detail: 'rails + pricing; a bad plan is rejected before any agent launches' },
    { title: 'Work', detail: 'each unit on its card; inspect; classify; at most one re-route onto fb' },
    { title: 'Sweep', detail: 'gap-finder rounds for review/research (depth-dependent)' },
    { title: 'Verify', detail: 'dedup, then verification by rung on the master-declared cells' },
  ],
}

// The foreman never picks a model or an effort. Every cell it launches is one the
// master wrote on a card (p, fb, rd) or declared for verification (verify.cells),
// or the fixed inspector cell. Judgement lives in the master; this file is
// arithmetic, rails and bookkeeping, so it can be unit-tested (tests/harness.mjs).

// ═══════════════════════════════ CORE (pure) ═══════════════════════════════

const MODELS = ['haiku', 'sonnet', 'opus', 'fable']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const KINDS = ['research', 'review', 'data', 'implement']
const DEPTHS = ['quick', 'standard', 'deep']
const STAGES = ['all', 'work', 'verify']
const SEVERITIES = ['info', 'low', 'medium', 'high', 'blocker']
const RUNGS = ['V0', 'V1', 'V2', 'V3', 'V4']
const FEATURES = ['D', 'A', 'T', 'C', 'V', 'B', 'G']
const BRIEF_REASONS = ['no_access', 'ambiguous_brief', 'out_of_scope']
const CAPABILITY_REASONS = ['too_hard', 'contradictory_evidence']
// 0.1.2: medium drops to V1 (grounded quotes, no skeptic). Measured: a review produced ~4
// mediums per unit, so V2 on mediums made topK — not risk — decide what got verified.
// 0.1.4: medium back to V2. Lean skeptics read through Bash and cost a fraction of before,
// so every medium gets one skeptic at the producer's model·medium; topK still bounds how
// many mediums are checked (only high/blocker and parity claims are exempt from it).
const DEFAULT_RUNGS = { blocker: 'V3', high: 'V3', medium: 'V2', low: 'V0', info: 'V0' }
const DEFAULT_TOPK = { quick: 6, standard: 12, deep: 25 }
const DEFAULT_ROUNDS = { quick: 0, standard: 1, deep: 2 }
const MAX_INSPECT_QUOTES = 60

// Bump PRICE_MODEL whenever estUsd's structure changes (new priors alone do not need it): learned
// factors (args.calib.scale / scaleByRole, from stats.mjs) only hold for the model they were
// learned under, so calibrate() ignores factors that carry another (or no) price model.
const PRICE_MODEL = 3

const DEFAULT_CALIB = {
  prices: { haiku: { in: 1, out: 5 }, sonnet: { in: 2, out: 10 }, opus: { in: 4, out: 20 }, fable: { in: 10, out: 50 } },
  cacheWrite: 1.25,
  cacheRead: 0.1,
  // Price model 3, fitted on a measured 23-agent research run once the nested CLAUDE.md leak
  // was gone (Read attaches every CLAUDE.md between the session cwd and the file read; lean
  // agents now read through Bash, which does not):
  // - fixed prefix: lean agents start at 7-12.5k tokens and gain ~3-4k of tool/instruction
  //   attachments on turn 2; full-tool agents ~15k before CLAUDE.md (ctxTok, ~78k on a heavy
  //   subtree);
  // - leak-free workers read 5-24k tokens in 4-16 API turns.
  baseCtxLean: 11000,
  baseCtx: 15000,
  turnsBase: 10,
  tokPerTurn: 2500,
  effortTurns: { low: 0.6, medium: 0.8, high: 1.0, xhigh: 1.3, max: 1.6 },
  outPerTurn: { low: 600, medium: 1000, high: 1500, xhigh: 1800, max: 2200 },
  haikuOutPerTurn: 500,
  // The old 4x context growth over the planned reading was mostly the nested CLAUDE.md, now
  // gone for lean agents; ctx keep units price their CLAUDE.md chain through ctxTok instead.
  // Ultracode's agents use Read and do get the nested CLAUDE.md, so their factor stays 4.
  readFactor: 1,
  ultraReadFactor: 4,
  ultraTurnCap: 80,
  caps: { worker: 30, workerMcp: 35, workerCtx: 30, implementer: 60, skeptic: 12, inspector: 6 },
  inspectorIn: 12000,
  // Skeptics reading through Bash read 4-10k tokens; the gap sweep re-reads a slice of scope.
  verifierInFrac: 0.25,
  sweepInFrac: 0.25,
  // Per-role multipliers, learned under price model 3 over 9 runs: work 0.6->1.04->0.81,
  // verify 0.27-0.30, inspect 0.30-0.39, sweep 0.79->3.82 (noisy). The priors sit at or above
  // the fit on purpose, because under-estimating exhausts the work pool and starves
  // verification. Implementers keep CLAUDE.md, run test suites and take many turns: priced
  // as work they came out ~3.5x low (theme estimates 0.5-0.8 vs actual 1.7-3.4), so they are
  // their own role. estUsd's structure is unchanged, so PRICE_MODEL stays and learned factors
  // stay valid.
  scaleByRole: { work: 1.0, verify: 0.3, inspect: 0.3, sweep: 2.0, implement: 3.5 },
  // Global extra multiplier on top of scaleByRole (only honoured from the same price model).
  scale: 1,
  // Expected findings per unit, for sizing the verification reserve. Measured: 7 high +
  // 34 medium from 8 review units; mediums raised to 5 with the 15-finding cap (0.1.5).
  highsPerUnit: 0.9,
  mediumsPerUnit: 5,
}

const mr = m => MODELS.indexOf(m)
const er = e => EFFORTS.indexOf(e)
const sevRank = s => { const i = SEVERITIES.indexOf(s); return i < 0 ? 0 : i }
const round2 = x => Math.round(x * 100) / 100
const round4 = x => Math.round(x * 10000) / 10000
const minEffort = (want, cap) => (er(cap) >= 0 && er(want) > er(cap) ? cap : want)

// Learned factors (scale, scaleByRole) are honoured only when they carry the current price
// model (c.pm); anything else is dropped with a warning. K.warnings reaches the run's warnings.
function calibrate(c) {
  const K = JSON.parse(JSON.stringify(DEFAULT_CALIB))
  K.warnings = []
  if (!c || typeof c !== 'object') return K
  const learned = c.pm === PRICE_MODEL
  if (!learned && ('scale' in c || 'scaleByRole' in c)) K.warnings.push(`calib from price model ${c.pm === undefined || c.pm === null ? 'none' : c.pm} ignored (current ${PRICE_MODEL})`)
  for (const k of Object.keys(c)) {
    if (!learned && (k === 'scale' || k === 'scaleByRole')) continue
    if (k === 'prices' && c.prices && typeof c.prices === 'object') {
      for (const m of Object.keys(c.prices)) K.prices[m] = { ...(K.prices[m] || {}), ...c.prices[m] }
    } else if (['effortTurns', 'outPerTurn', 'caps', 'scaleByRole'].includes(k) && c[k] && typeof c[k] === 'object') {
      K[k] = { ...K[k], ...c[k] }
    } else if (typeof c[k] === 'number' && k in K) {
      K[k] = c[k]
    }
  }
  return K
}

function parseVec(vec) {
  if (typeof vec !== 'string') return null
  const out = {}
  for (const tok of vec.trim().split(/\s+/)) {
    const m = /^([DATCVBG])([0-2])$/.exec(tok)
    if (!m || m[1] in out) return null
    out[m[1]] = Number(m[2])
  }
  return FEATURES.every(f => f in out) ? out : null
}

// V0 (unverifiable) ∧ B2 (consequential) ∧ D≥1 (not a lookup): an error here would be
// invisible AND expensive, so the unit must run exactly as ultracode would.
const isParity = v => !!v && v.V === 0 && v.B === 2 && v.D >= 1

function cellOf(spec, S) {
  if (spec === null || spec === undefined) return null
  if (typeof spec !== 'object') return { model: String(spec), effort: undefined }
  return { model: spec.model || S, effort: spec.effort }
}

const cellKey = c => (!c ? 'none' : c.model === 'haiku' ? 'haiku' : `${c.model}·${c.effort}`)

// a strictly stronger than b: a higher model, or the same model at a higher effort
function stronger(a, b) {
  if (mr(a.model) !== mr(b.model)) return mr(a.model) > mr(b.model)
  return er(a.effort || 'low') > er(b.effort || 'low')
}

function checksOf(check) {
  return String(check || '').split('+').map(s => s.trim().toLowerCase()).filter(Boolean)
}

const needsInspector = u => u.checks.includes('quote') || (!!u.v && u.v.B === 2)

function normPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/').replace(/\/$/, '')
}

// Map a cited path onto the unit's scope list: an exact/suffix match first, then a unique
// basename match ('fanout.js' -> '/abs/.../workflows/fanout.js'); otherwise unchanged.
function toScope(file, scope) {
  const f = normPath(file)
  if (!f || !Array.isArray(scope) || !scope.length) return file
  const exact = scope.find(x => normPath(x) === f)
  if (exact) return exact
  const hits = scope.filter(x => pathMatch(x, f))
  return hits.length === 1 ? hits[0] : file
}

function pathMatch(a, b) {
  const x = normPath(a), y = normPath(b)
  if (!x || !y) return false
  return x === y || x.endsWith('/' + y) || y.endsWith('/' + x)
}

// Turns grow with what an agent has to read and with its effort; a hard cap (the agent
// file's maxTurns) bounds them. Measured: ~10 + in/2.5k turns at high effort.
function turnsFor(cell, inTok, K, cap) {
  if (!cell) return 0
  const e = cell.model === 'haiku' ? 0.6 : (K.effortTurns[cell.effort] || 1)
  const t = Math.max(2, Math.round((K.turnsBase + (inTok || 0) / K.tokPerTurn) * e))
  return cap ? Math.min(cap, t) : t
}

function outTok(cell, K, turns) {
  if (!cell) return 0
  const per = cell.model === 'haiku' ? K.haikuOutPerTurn : (K.outPerTurn[cell.effort] || K.outPerTurn.medium)
  return per * (turns || turnsFor(cell, 0, K))
}

const roleScale = (K, role) => (role && K.scaleByRole ? K.scaleByRole[role] : undefined) ?? 1

// One agent. Its context starts at the fixed prefix (+ CLAUDE.md if kept) and grows to
// prefix + readFactor·in as it reads; everything is written to cache once, and every turn
// re-reads the context so far (on average half the growth). o: {lean, cap, readFactor, turns, role};
// the result is scaled by K.scaleByRole[role] and by the global K.scale.
function estUsd(cell, inTok, ctxTok, K, o) {
  o = o || {}
  if (!cell) return 0
  const p = K.prices[cell.model]
  if (!p) return 0
  const prefix = (o.lean ? K.baseCtxLean : K.baseCtx) + (ctxTok || 0)
  const g = o.readFactor || K.readFactor
  const turns = o.turns || turnsFor(cell, inTok, K, o.cap)
  const last = prefix + g * (inTok || 0)
  const avg = prefix + (g * (inTok || 0)) / 2
  const usd = (last * p.in * K.cacheWrite + turns * avg * p.in * K.cacheRead + outTok(cell, K, turns) * p.out) / 1e6
  return round4(usd * roleScale(K, o.role) * (K.scale || 1))
}

// Which plugin agent a unit runs on, and that agent's hard turn cap (its maxTurns).
function typeKey(u) {
  return u.role === 'implement' ? 'implementer' : u.ctx === 'keep' ? 'workerCtx' : u.v && u.v.T === 2 ? 'workerMcp' : 'worker'
}
const LEAN_TYPES = ['worker', 'skeptic', 'inspector']
const ROLE_OF = { implementer: 'implement', worker: 'work', workerMcp: 'work', workerCtx: 'work', skeptic: 'verify', inspector: 'inspect' }
// role overrides the agent type's role: the gap sweep runs on a worker but is priced (and
// calibrated) as its own role 'sweep'.
function agentOpts(key, K, role) {
  return { lean: LEAN_TYPES.includes(key), cap: K.caps[key] || null, role: role || ROLE_OF[key] || 'work' }
}

// topK and batch size of the verification stage (shared by price() and verify()).
function verifySizing(vcfg, depth) {
  vcfg = vcfg || {}
  const topK = Number.isInteger(vcfg.topK) ? vcfg.topK : DEFAULT_TOPK[depth]
  const batch = Number.isInteger(vcfg.batch) && vcfg.batch > 0 ? vcfg.batch : depth === 'quick' ? 5 : 3
  return { topK, batch }
}

// Verifier batches to reserve when the master gives no verify.expected: every expected
// high gets checked (highs are exempt from topK); mediums only when their rung is V2+,
// and then at most topK of them.
function expectedVerifiers(nUnits, depth, vcfg, rungs, K) {
  const { topK, batch } = verifySizing(vcfg, depth)
  const highs = Math.ceil((nUnits * K.highsPerUnit) / batch)
  const medRung = (rungs && rungs.medium) || DEFAULT_RUNGS.medium
  const mediums = ['V2', 'V3', 'V4'].includes(medRung) ? Math.ceil(Math.min(nUnits * K.mediumsPerUnit, topK || 0) / batch) : 0
  return highs + mediums
}

// A claim verified at V3+ because of its severity (blocker/high) or because it is a parity
// claim is never dropped by topK; topK only bounds the remaining V2+ claims.
function topKExempt(c, rungs) {
  if (c.parity && sevRank(c.severity) >= sevRank('medium')) return true
  if (sevRank(c.severity) < sevRank('high')) return false
  return RUNGS.indexOf((rungs && rungs[c.severity]) || DEFAULT_RUNGS[c.severity]) >= 3
}

function validate(a) {
  const errors = []
  const warnings = []
  const out = { errors, warnings, units: [] }
  if (!a || typeof a !== 'object') { errors.push('args: missing — pass the args object'); return out }
  if (a.v !== 2) errors.push(`args: v must be 2 (got ${JSON.stringify(a.v)})`)
  if (!KINDS.includes(a.kind)) errors.push(`args: kind must be one of ${KINDS.join('|')}`)
  if (a.kind === 'implement' && !a.dryRun) errors.push('args: kind implement runs from the implement playbook\'s inline script (fanout only dry-runs implement cards); call fanout with kind review for the diff review')
  if (!DEPTHS.includes(a.depth)) errors.push(`args: depth must be one of ${DEPTHS.join('|')}`)
  const stage = a.stage || 'all'
  if (!STAGES.includes(stage)) errors.push(`args: stage must be one of ${STAGES.join('|')}`)
  out.stage = stage

  const s = a.session || {}
  const S = s.S
  const W = s.W || S
  const E = s.refEffort
  const allowUp = !!s.allowUp
  if (mr(S) < 0) errors.push(`session: S must be one of ${MODELS.join('|')}`)
  else if (S === 'haiku') errors.push('session: S is haiku — a haiku session runs solo, do not fan out')
  if (mr(W) < 0 || (mr(S) >= 0 && mr(W) > mr(S))) errors.push('session: W must be a model at or below S')
  if (er(E) < 0) errors.push(`session: refEffort must be one of ${EFFORTS.join('|')}`)
  Object.assign(out, { S, W, E, allowUp })

  if (!Array.isArray(a.units) || !a.units.length) { errors.push('args: units must be a non-empty array'); return out }

  const overrides = new Map((Array.isArray(a.overrides) ? a.overrides : []).filter(o => o && o.id).map(o => [o.id, o]))
  for (const id of overrides.keys()) if (!a.units.some(u => u && u.id === id)) warnings.push(`override ${id}: no such unit`)

  const seen = new Set()
  const upUnits = new Set()
  const ultraCtx = Number(a.ultra && a.ultra.ctxTok) || 0
  const inAvg = Number(a.ultra && a.ultra.inAvg) > 0 ? Number(a.ultra.inAvg) : 40000

  for (const raw of a.units) {
    const u = JSON.parse(JSON.stringify(raw || {}))
    const id = u.id
    if (!id || typeof id !== 'string') { errors.push('card ?: id missing'); continue }
    if (seen.has(id)) errors.push(`args: duplicate unit id ${id}`)
    seen.add(id)
    const o = overrides.get(id)
    if (o) {
      // A routed p makes the old fallback meaningless (it may now be weaker than p).
      if ('p' in o) { u.p = o.p; if (!('fb' in o)) u.fb = null }
      if ('fb' in o) u.fb = o.fb
      u.override = o.by || 'user'
    }
    const userOv = !!u.override
    u.v = parseVec(u.vec)
    if (!u.v) errors.push(`card ${id}: vec must list D A T C V B G, each 0..2, e.g. 'D2 A1 T1 C1 V0 B2 G1' (got ${JSON.stringify(u.vec)})`)
    if (!u.why || typeof u.why !== 'string') errors.push(`card ${id}: why missing — name the feature that decided the route`)
    else if (u.why.length > 140) errors.push(`card ${id}: why is ${u.why.length} chars (max 140)`)
    if (!u.brief || typeof u.brief !== 'string') errors.push(`card ${id}: brief missing`)
    u.role = u.role || a.kind
    u.ctx = u.ctx === 'keep' ? 'keep' : 'omit'
    u.n = u.n ? 1 : 0
    u.in = Number(u.in) > 0 ? Number(u.in) : inAvg
    u.scope = u.scope && Array.isArray(u.scope.files) ? { files: u.scope.files.map(String) } : { files: [] }
    u.ctxTokEff = u.ctx === 'keep' ? (Number(u.ctxTok) > 0 ? Number(u.ctxTok) : ultraCtx) : 0
    u.parity = isParity(u.v)
    u.cell = cellOf(u.p, S)
    u.fbCell = cellOf(u.fb, S)
    u.rdCell = u.n ? cellOf(u.rd || u.p, S) : null
    u.checks = checksOf(u.check)
    out.units.push(u)
    if (!u.cell) { errors.push(`card ${id}: p missing`); continue }

    for (const [label, c] of [['p', u.cell], ['fb', u.fbCell], ['rd', u.rdCell]]) {
      if (!c) continue
      if (mr(c.model) < 0) { errors.push(`tier ${id}: ${label} model ${JSON.stringify(c.model)} unknown`); continue }
      if (c.model === 'haiku') {
        if (c.effort) errors.push(`haiku ${id}: ${label} haiku takes no effort — drop it`)
        if (u.v && u.v.T >= 1) errors.push(`haiku ${id}: ${label} haiku cannot run tools or MCP (vector T${u.v.T}); use sonnet`)
      } else if (er(c.effort) < 0) {
        errors.push(`effort ${id}: ${label} effort missing or unknown (${JSON.stringify(c.effort)}) — every crew call pins an effort`)
      } else if (er(E) >= 0 && er(c.effort) > er(E)) {
        ;(userOv ? warnings : errors).push(`effort ${id}: ${label} ${c.effort} is above refEffort ${E} — the crew never out-thinks ultracode's own crew`)
      }
      if (S === 'fable' && c.model === 'fable' && !u.parity && !userOv) {
        errors.push(`tier ${id}: ${label} on a Fable session only parity units run on fable; use W = opus (the verifier must not be weaker than any fb)`)
      }
      if (mr(S) >= 0 && mr(c.model) > mr(S)) {
        if (!allowUp && !userOv) errors.push(`tier ${id}: ${label} ${c.model} is above the session model ${S} (needs --allow-up)`)
        else upUnits.add(id)
      }
    }

    if (u.fbCell && mr(u.fbCell.model) >= 0 && !stronger(u.fbCell, u.cell)) {
      errors.push(`fb ${id}: fallback ${cellKey(u.fbCell)} is not strictly stronger than primary ${cellKey(u.cell)}`)
    }
    if (u.parity && !userOv) {
      if (!(u.cell.model === S && u.cell.effort === E)) {
        errors.push(`parity ${id}: V0∧B2∧D≥1 must run on the session cell as ultracode would — ${S}·${E} (got ${cellKey(u.cell)})`)
      }
      if (u.fbCell) errors.push(`parity ${id}: fb must be null — strengthen the check instead`)
    }
    if (u.supersedes && u.fbCell) errors.push(`fb ${id}: a superseding unit must have fb null`)
    if (!u.checks.length) errors.push(`check ${id}: check missing — name the objective check that catches this unit's failure`)
    else if (u.checks.includes('none') && !u.parity) errors.push(`check ${id}: check none is only allowed in the parity cell`)
    if (u.n && !u.checks.includes('rederive')) errors.push(`check ${id}: n=1 needs a planned re-derivation — add rederive to check`)
  }
  if (upUnits.size > 1) errors.push(`tier: at most 1 allow-up unit per run (got ${upUnits.size}: ${[...upUnits].join(', ')})`)

  // Verification cells: declared by the master; checked against the producers.
  const vcfg = a.verify || {}
  const cells = vcfg.cells || {}
  const rungs = { ...DEFAULT_RUNGS, ...(vcfg.rungs || {}) }
  for (const [sev, r] of Object.entries(rungs)) if (!RUNGS.includes(r)) errors.push(`verify: rung for ${sev} must be one of ${RUNGS.join('|')} (got ${JSON.stringify(r)})`)
  out.rungs = rungs
  // A high/blocker finding below V2 is never independently checked; a run may only skip that
  // with a stated reason, echoed in the card and digest.
  const waiver = typeof vcfg.waiver === 'string' ? vcfg.waiver.trim() : ''
  if (vcfg.waiver !== undefined && (!waiver || vcfg.waiver.length > 200)) errors.push('verify: waiver must be a non-empty string of at most 200 characters')
  else if (['high', 'blocker'].some(sev => RUNGS.indexOf(rungs[sev]) < 2) && !waiver) errors.push('verify: high/blocker findings need at least V2; set verify.waiver to run without')
  out.waiver = waiver || null
  const highE = er(E) >= 0 ? minEffort('high', E) : 'high'
  out.V3 = cellOf(cells.V3 || { model: W, effort: highE }, S)
  out.V4 = cellOf(cells.V4 || cells.V3 || { model: W, effort: highE }, S)
  let maxProducer = -1
  let maxOverride = -1
  for (const u of out.units) {
    if (!u.cell || u.parity) continue
    const m = Math.max(mr(u.cell.model), u.fbCell ? mr(u.fbCell.model) : -1)
    if (u.override) maxOverride = Math.max(maxOverride, m)
    else maxProducer = Math.max(maxProducer, m)
  }
  for (const [label, c] of [['V3', out.V3], ['V4', out.V4]]) {
    if (mr(c.model) < 0) { errors.push(`verify: ${label} model ${JSON.stringify(c.model)} unknown`); continue }
    if (c.model === 'haiku') { errors.push(`verify: ${label} cannot be haiku — skeptics read files`); continue }
    if (er(c.effort) < 0) errors.push(`verify: ${label} effort missing or unknown`)
    else if (er(E) >= 0 && er(c.effort) > er(E)) errors.push(`verify: ${label} effort ${c.effort} is above refEffort ${E}`)
    if (mr(S) >= 0 && mr(c.model) > mr(S) && !allowUp) errors.push(`verify: ${label} ${c.model} is above the session model ${S}`)
    if (maxProducer >= 0 && mr(c.model) < maxProducer) {
      errors.push(`verify: ${label} cell ${cellKey(c)} is weaker than producer model ${MODELS[maxProducer]} — a verifier must not run on a weaker model than what it checks`)
    }
    if (maxOverride > mr(c.model)) warnings.push(`verify: ${label} cell ${cellKey(c)} is weaker than a user-overridden producer (${MODELS[maxOverride]})`)
  }
  const sw = a.sweep || {}
  out.rounds = Number.isInteger(sw.rounds) ? Math.max(0, sw.rounds) : DEFAULT_ROUNDS[a.depth] || 0
  if (!['review', 'research'].includes(a.kind)) out.rounds = 0
  out.sweepCell = cellOf(sw.cell || { model: W, effort: er(E) >= 0 ? minEffort('medium', E) : 'medium' }, S)
  if (out.sweepCell && (mr(out.sweepCell.model) < 0 || out.sweepCell.model === 'haiku' || er(out.sweepCell.effort) < 0)) errors.push('sweep: cell must be a non-haiku model with an effort')
  else if (er(E) >= 0 && er(out.sweepCell.effort) > er(E)) errors.push(`sweep: effort ${out.sweepCell.effort} is above refEffort ${E}`)
  out.inspCell = { model: mr(S) >= mr('sonnet') ? 'sonnet' : S, effort: 'low' }
  out.criticCell = { model: W, effort: highE }

  const workCells = new Set(out.units.filter(u => u.cell).map(u => cellKey(u.cell)))
  if (workCells.size > 2) warnings.push(`cache: ${workCells.size} distinct primary cells in the work stage (${[...workCells].join(', ')}) — agents share a prompt cache only within a cell; merge the smallest cell up if you can`)
  return out
}

function price(a, V, K) {
  const ultra = a.ultra || {}
  const caps = a.caps || {}
  const ref = { model: V.S, effort: V.E }
  const inAvg = Number(ultra.inAvg) > 0 ? Number(ultra.inAvg) : 40000
  const ctxTok = Number(ultra.ctxTok) || 0
  const vIn = inAvg * K.verifierInFrac
  // Ultracode's agents: session cell, full tools, CLAUDE.md, no turn cap, unbounded reading.
  const ultraO = { lean: false, cap: K.ultraTurnCap, readFactor: K.ultraReadFactor, role: 'work' }
  const U = (Number(ultra.agents) || 0) * estUsd(ref, inAvg, ctxTok, K, ultraO) + (Number(ultra.verifiers) || 0) * estUsd(ref, vIn, ctxTok, K, ultraO)
  const inspO = agentOpts('inspector', K)
  const skepO = agentOpts('skeptic', K)
  const workO = agentOpts('worker', K)
  const sweepO = agentOpts('worker', K, 'sweep')
  const sweepIn = inAvg * K.sweepInFrac
  let P = 0, parityP = 0, plannedOut = 0, plannedAgents = 0, rerouteSum = 0, floor = 0, b2Earmark = 0
  for (const u of V.units) {
    if (!u.cell || mr(u.cell.model) < 0) continue
    u.typeKey = typeKey(u)
    u.o = agentOpts(u.typeKey, K)
    u.turns = turnsFor(u.cell, u.in, K, u.o.cap)
    u.estPrimary = estUsd(u.cell, u.in, u.ctxTokEff, K, u.o)
    let est = u.estPrimary
    plannedOut += outTok(u.cell, K, u.turns)
    plannedAgents += 1
    if (needsInspector(u)) { est += estUsd(V.inspCell, K.inspectorIn, 0, K, inspO); plannedOut += outTok(V.inspCell, K, turnsFor(V.inspCell, K.inspectorIn, K, inspO.cap)); plannedAgents += 1 }
    if (u.rdCell && mr(u.rdCell.model) >= 0) { est += estUsd(u.rdCell, u.in, u.ctxTokEff, K, u.o); plannedOut += outTok(u.rdCell, K, turnsFor(u.rdCell, u.in, K, u.o.cap)); plannedAgents += 1 }
    u.estUsd = round4(est)
    u.repairUsd = u.fbCell && mr(u.fbCell.model) >= 0 ? estUsd(u.fbCell, u.in, u.ctxTokEff, K, u.o) : 0
    P += est
    if (u.parity) parityP += est
    if (u.fbCell) {
      rerouteSum += u.repairUsd
      floor = Math.max(floor, u.repairUsd)
      if (u.v && u.v.B === 2) b2Earmark = Math.max(b2Earmark, u.repairUsd)
    }
  }
  const nUnits = V.units.length
  const vcfg = a.verify || {}
  const expected = Number.isInteger(vcfg.expected) ? Math.max(0, vcfg.expected) : expectedVerifiers(nUnits, a.depth, vcfg, V.rungs, K)
  const verifyUsd = expected * estUsd(V.V3, vIn, 0, K, skepO)
  const sweepUsd = V.rounds * estUsd(V.sweepCell, sweepIn, 0, K, sweepO)
  const criticUsd = a.depth === 'deep' ? estUsd(V.criticCell, vIn, 0, K, workO) : 0
  P += verifyUsd + sweepUsd + criticUsd
  plannedOut += expected * outTok(V.V3, K, turnsFor(V.V3, vIn, K, skepO.cap)) + V.rounds * outTok(V.sweepCell, K, turnsFor(V.sweepCell, sweepIn, K, sweepO.cap))
    + (a.depth === 'deep' ? outTok(V.criticCell, K, turnsFor(V.criticCell, vIn, K, workO.cap)) : 0)
  plannedAgents += expected + V.rounds + (a.depth === 'deep' ? 1 : 0)
  // Default 0.2: 7 capability failures in 44 units (~16%) across 7 runs.
  const rate = typeof caps.rerouteRate === 'number' ? caps.rerouteRate : 0.2
  const capPct = typeof caps.reserveCapPct === 'number' ? caps.reserveCapPct : 20
  // The floor (one full repair) wins over the cap: a reserve that cannot pay for a
  // single repair is a promise the foreman could not keep.
  const R = floor > 0 ? Math.max(floor, Math.min(rate * rerouteSum, (capPct / 100) * P)) : 0
  const mult = typeof caps.ceilingMult === 'number' ? caps.ceilingMult : 0.5
  let C = mult * U
  if (caps.parityBound) C = 0.8 * U
  if (typeof caps.ceilingUsd === 'number' && caps.ceilingUsd > 0) C = caps.ceilingUsd
  return {
    U: round4(U), P: round4(P), R: round4(R), C: round4(C), mult, parityP: round4(parityP),
    b2Earmark: round4(b2Earmark), plannedOut, plannedAgents, expected, rounds: V.rounds, verifyUsd: round4(verifyUsd), sweepUsd: round4(sweepUsd), criticUsd: round4(criticUsd),
  }
}

function moneyRails(a, V, M) {
  const caps = a.caps || {}
  const anyUser = V.units.some(u => u.override) || (typeof caps.ceilingUsd === 'number' && caps.ceilingUsd > 0)
  if (!(M.U > 0)) {
    V.errors.push('money: ultra.agents must be ≥1 so the ultracode-equivalent U can be priced')
    return
  }
  if (caps.parityBound && !(M.parityP > M.mult * M.U)) {
    V.errors.push(`money: parityBound is only allowed when parity spend ($${round2(M.parityP)}) exceeds ceilingMult·U ($${round2(M.mult * M.U)})`)
  }
  const total = M.P + M.R
  if (total > M.C + 1e-9) {
    const msg = `money: plan P $${round2(M.P)} + reserve R $${round2(M.R)} = $${round2(total)} exceeds the crew ceiling C $${round2(M.C)} (U $${round2(M.U)}). Pack harder, lower effort on checkable non-parity units, move checkable units to sonnet, narrow verification, or go solo`
    ;(anyUser ? V.warnings : V.errors).push(msg)
  }
  if (anyUser && total > 0.9 * M.U) V.warnings.push(`money: with overrides the plan is ${round2(total / M.U)}×U — it may cost about as much as ultracode`)
  if (caps.parityBound) V.warnings.push('money: parity-bound run — savings come from agent count and context, not from cheaper cells')
  if (Number.isInteger(caps.maxAgents) && M.plannedAgents > caps.maxAgents) {
    V.errors.push(`caps: ${M.plannedAgents} planned agents exceed maxAgents ${caps.maxAgents}`)
  }
  const unitUsd = V.units.reduce((t, u) => t + (u.estUsd || 0), 0)
  const sShare = unitUsd > 0 ? V.units.filter(u => u.cell && u.cell.model === V.S).reduce((t, u) => t + (u.estUsd || 0), 0) / unitUsd : 0
  if (['review', 'research'].includes(a.kind) && V.units.length >= 3 && sShare > 0.7) {
    V.warnings.push(`routing: ${Math.round(sShare * 100)}% of planned work-unit spend runs on ${V.S}; split mechanical work (inventory, consistency, mapping, extraction) into sonnet units if you can`)
  }
  if (M.plannedAgents > 25) V.warnings.push(`size: ${M.plannedAgents} planned agents (Claude Code flags workflows above 25)`)
}

function buildCard(a, V, M, K) {
  K = K || calibrate()
  return {
    kind: a.kind, depth: a.depth, stage: V.stage,
    S: V.S, W: V.W, refEffort: V.E, refSource: (a.session && a.session.refSource) || 'unknown',
    units: V.units.map(u => ({
      id: u.id, role: u.role, vec: u.vec, cell: cellKey(u.cell), fb: u.fbCell ? cellKey(u.fbCell) : null,
      rd: u.rdCell ? cellKey(u.rdCell) : null, ctx: u.ctx, check: u.check, why: u.why, parity: u.parity,
      estUsd: u.estUsd, turns: u.turns, override: u.override || null,
    })),
    verify: { rungs: V.rungs, V3: cellKey(V.V3), V4: cellKey(V.V4), expected: M.expected, waiver: V.waiver || null },
    sweep: { rounds: V.rounds, cell: cellKey(V.sweepCell) },
    money: {
      U: round2(M.U), P: round2(M.P), R: round2(M.R), C: round2(M.C), ratio: M.U > 0 ? round2((M.P + M.R) / M.U) : null,
      parityP: round2(M.parityP), parityBound: !!(a.caps && a.caps.parityBound),
    },
    plannedAgents: M.plannedAgents,
    // the factors these estimates were priced with, so stats.mjs updates relative to them
    calib: { pm: PRICE_MODEL, scale: K.scale, scaleByRole: { ...K.scaleByRole } },
    basis: (a.ultra && a.ultra.basis) || '',
  }
}

function missingFiles(scopeFiles, filesRead) {
  const read = Array.isArray(filesRead) ? filesRead : []
  return (scopeFiles || []).filter(f => !read.some(r => pathMatch(f, r)))
}

function citedFiles(res) {
  const files = new Set()
  for (const f of res.findings || []) for (const e of f.evidence || []) if (e && e.file) files.add(normPath(e.file))
  return [...files]
}

// Sorts a returned result into one of four classes. Only `capability` spends the one
// re-route; infra and capacity re-run the same cell; brief goes back to the master.
function classify(u, res, insp, st) {
  st = st || {}
  if (!res) return { cls: 'infra', reasons: ['no result'] }
  if (res.status === 'blocked' && BRIEF_REASONS.includes(res.blocked_reason)) {
    return { cls: 'brief', reasons: [`blocked: ${res.blocked_reason}`] }
  }
  // An agent that gave up for a capability reason did not run out of room: a slice
  // re-run on the same cell would fail the same way, so it goes straight to fb.
  if (res.status === 'blocked' && (CAPABILITY_REASONS.includes(res.blocked_reason) || !res.blocked_reason)) {
    const mode = st.tieoutFailed ? 'rederive' : 'repair'
    return { cls: 'capability', reasons: [`blocked: ${res.blocked_reason || 'no reason given'}`], mode }
  }
  const missing = missingFiles(u.scope.files, res.files_read)
  const remaining = Array.isArray(res.remaining) ? res.remaining : []
  const partial = res.status === 'partial' && remaining.length > 0
  if ((missing.length || partial) && !st.capacityUsed) {
    const reasons = []
    if (missing.length) reasons.push(`not read: ${missing.join(', ')}`)
    if (partial) reasons.push(`partial: ${remaining.length} item(s) remaining`)
    return { cls: 'capacity', reasons, missing, remaining }
  }
  const reasons = []
  let mode = 'repair'
  const rated = insp && insp.total > 0 && typeof insp.rate === 'number'
  if (rated && insp.rate < 0.7) reasons.push(`only ${Math.round(insp.rate * 100)}% of quotes resolve`)
  if (rated && insp.rate < 0.5) mode = 'redo'
  // Agents that read through Bash cite files they grepped: a cited file with a quote the
  // inspector resolved counts as read. Without an inspector (none planned, skipped or failed)
  // a cited-but-unlisted file is only a soft signal.
  const inspected = !!insp && typeof insp.resolved === 'number'
  const resolvedFiles = (insp && insp.resolvedFiles) || []
  const notRead = citedFiles(res).filter(f => !(res.files_read || []).some(r => pathMatch(f, r)) && !resolvedFiles.some(r => pathMatch(f, r)))
  if (notRead.length && inspected) reasons.push(`cited but not read: ${notRead.join(', ')}`)
  if (u.v && u.v.B === 2 && (res.findings || []).some(f => !(f.evidence || []).length)) reasons.push('B2 finding without evidence')
  if (st.tieoutFailed) { reasons.push('tie-out mismatch between derivations'); mode = 'rederive' }
  const lowConf = typeof res.confidence === 'number' && res.confidence < 0.5
  const softNotRead = notRead.length > 0 && !inspected
  const soft = (rated && insp.rate >= 0.7 && insp.rate < 0.9) || (Array.isArray(res.assumptions) && res.assumptions.length >= 3) || softNotRead
  if (lowConf && soft) reasons.push(`confidence ${res.confidence} with a soft signal${softNotRead ? ` (cited but not read: ${notRead.join(', ')})` : ''}`)
  if (reasons.length) return { cls: 'capability', reasons, mode }
  const uncovered = st.capacityUsed ? missing.concat(partial ? remaining : []) : []
  return { cls: 'ok', reasons: [], verifyBump: lowConf ? 1 : 0, uncovered }
}

// Decimal string → integer cents. Money is never summed as floats.
function toCents(v) {
  if (v === null || v === undefined) return null
  let t = typeof v === 'number' ? (Number.isFinite(v) ? v.toFixed(4) : '') : String(v)
  t = t.trim().replace(/[\s'’]/g, '').replace(/^€|€$/g, '')
  if (!t) return null
  let neg = false
  if (t.startsWith('(') && t.endsWith(')')) { neg = true; t = t.slice(1, -1) }
  if (t.startsWith('-')) { neg = !neg; t = t.slice(1) } else if (t.startsWith('+')) t = t.slice(1)
  if (t.endsWith('-')) { neg = !neg; t = t.slice(0, -1) }
  let intPart = t
  let frac = ''
  const dot = t.lastIndexOf('.')
  const comma = t.lastIndexOf(',')
  if (dot >= 0 && comma >= 0) {
    const dec = dot > comma ? '.' : ','
    const thou = dec === '.' ? ',' : '.'
    const parts = t.split(thou).join('').split(dec)
    if (parts.length !== 2) return null
    ;[intPart, frac] = parts
  } else if (comma >= 0) {
    const parts = t.split(',')
    if (parts.length === 2 && parts[1].length !== 3) { [intPart, frac] = parts } else { intPart = parts.join('') }
  } else if (dot >= 0) {
    const parts = t.split('.')
    if (parts.length === 2) { [intPart, frac] = parts } else { intPart = parts.join('') }
  }
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(frac) || intPart + frac === '') return null
  let cents = Number(intPart || '0') * 100 + Number((frac + '00').slice(0, 2))
  if (frac.length > 2 && Number(frac[2]) >= 5) cents += 1
  return neg ? -cents : cents
}

function centsStr(c) {
  if (c === null || c === undefined) return null
  const neg = c < 0
  const a = Math.abs(c)
  return `${neg ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`
}

function compareNumbers(a, b, tolCents) {
  const tol = Number(tolCents) || 0
  const A = new Map((Array.isArray(a) ? a : []).map(n => [n.name, toCents(n.value)]))
  const B = new Map((Array.isArray(b) ? b : []).map(n => [n.name, toCents(n.value)]))
  if (!A.size || !B.size) return { ok: false, reason: 'no numbers to compare', diffs: [] }
  const diffs = []
  for (const [name, x] of A) {
    if (!B.has(name)) { diffs.push({ name, a: centsStr(x), b: null, diffCents: null }); continue }
    const y = B.get(name)
    if (x === null || y === null) { diffs.push({ name, a: centsStr(x), b: centsStr(y), diffCents: null }); continue }
    if (Math.abs(x - y) > tol) diffs.push({ name, a: centsStr(x), b: centsStr(y), diffCents: x - y })
  }
  return { ok: diffs.length === 0, diffs }
}

function evalExpr(expr, numbersByUnit) {
  const s = String(expr || '').trim()
  let m = /^sum\(\s*([\w-]+)\.(.*)\)$/.exec(s)
  if (m) {
    const list = numbersByUnit[m[1]]
    if (!Array.isArray(list)) return null
    let total = 0, hit = 0
    for (const n of list) {
      if (String(n.name).startsWith(m[2])) {
        const c = toCents(n.value)
        if (c === null) return null
        total += c
        hit++
      }
    }
    return hit ? total : null
  }
  m = /^([\w-]+)\.(.+)$/.exec(s)
  if (m) {
    const list = numbersByUnit[m[1]]
    if (!Array.isArray(list)) return null
    const n = list.find(x => x.name === m[2])
    return n ? toCents(n.value) : null
  }
  return toCents(s)
}

function evalInvariants(invariants, numbersByUnit) {
  return (Array.isArray(invariants) ? invariants : []).map(inv => {
    const l = evalExpr(inv.lhs, numbersByUnit)
    const r = evalExpr(inv.rhs, numbersByUnit)
    const tol = Number(inv.tolCents) || 0
    const ok = l !== null && r !== null && Math.abs(l - r) <= tol
    return { name: inv.name || `${inv.lhs} = ${inv.rhs}`, ok, lhs: centsStr(l), rhs: centsStr(r), diffCents: l !== null && r !== null ? l - r : null }
  })
}

function normTitle(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).slice(0, 8).join(' ')
}

function claimKey(c, keys) {
  const e = (c.evidence || [])[0]
  const parts = []
  for (const k of keys) {
    if (k === 'file') { if (!e || !e.file) return null; parts.push(normPath(e.file)) }
    else if (k === 'line') { if (!e || !Number.isFinite(Number(e.line))) return null; parts.push(String(Math.round(Number(e.line) / 4))) }
    else if (k === 'title') parts.push(normTitle(c.title))
  }
  return parts.length ? parts.join('|') : null
}

// Two claims near one location are the same issue only when they come from different
// producers and either cite the exact same line or are named alike. A unit never reports
// one issue twice, so its own neighbouring findings stay apart. (Until 0.1.4 a 4-line
// bucket alone decided: a smoke review folded "split divides by zero" into "split loses
// remainder cents" and dropped the second bug's text unverified.)
const NEAR_LINES = 3
const STOP_WORDS = new Set(['and', 'the', 'for', 'with', 'not', 'are', 'was', 'when', 'from', 'into', 'that', 'this', 'its', 'can', 'but'])
const titleWords = t => new Set(normTitle(t).split(' ').filter(w => w.length >= 3 && !STOP_WORDS.has(w)))
function titleOverlap(a, b) {
  const x = titleWords(a), y = titleWords(b)
  if (!x.size || !y.size) return 0
  let n = 0
  for (const w of x) if (y.has(w)) n++
  return n / Math.min(x.size, y.size)
}
const firstLineOf = c => { const e = (c.evidence || [])[0]; return e && Number.isFinite(Number(e.line)) ? Number(e.line) : null }

function sameIssue(g, c) {
  const units = new Set([g.unit, ...(g.merged || []).map(m => m.unit)].filter(Boolean))
  if (c.unit && units.has(c.unit)) return false
  const la = firstLineOf(g), lb = firstLineOf(c)
  if (la !== null && la === lb) return true
  return titleOverlap(g.title, c.title) >= 0.5
}

// The first claim in `list` that `c` duplicates: same file (and title key, when asked for),
// first lines at most NEAR_LINES apart when lines count, and sameIssue().
function findSame(list, c, keys) {
  const k = Array.isArray(keys) && keys.length ? keys : ['file', 'line']
  const base = k.filter(x => x !== 'line')
  const key = claimKey(c, base.length ? base : ['file'])
  if (key === null || claimKey(c, k) === null) return null
  const lc = firstLineOf(c)
  return list.find(g => claimKey(g, base.length ? base : ['file']) === key
    && (!k.includes('line') || (firstLineOf(g) !== null && Math.abs(firstLineOf(g) - lc) <= NEAR_LINES))
    && sameIssue(g, c)) || null
}

function dedupClaims(claims, keys) {
  const out = []
  for (const c of claims) {
    const g = findSame(out, c, keys)
    if (!g) { out.push(c); continue }
    // Keep every merged claim's own title, so a wrong merge stays visible in the report.
    g.merged = (g.merged || []).concat({ cid: c.cid, unit: c.unit || null, title: c.title })
    if (sevRank(c.severity) > sevRank(g.severity)) { g.severity = c.severity; g.title = c.title; g.claim = c.claim }
    for (const e of c.evidence || []) if (!g.evidence.some(x => normPath(x.file) === normPath(e.file) && Number(x.line) === Number(e.line))) g.evidence.push(e)
    g.mergedFrom = (g.mergedFrom || []).concat(c.cid)
    g.parity = g.parity || c.parity
    g.bump = Math.max(g.bump || 0, c.bump || 0)
    g.blast = Math.max(g.blast || 0, c.blast || 0)
    if (Number.isInteger(c.floor)) g.floor = Math.max(Number.isInteger(g.floor) ? g.floor : -1, c.floor)
    if (c.producer && g.producer && mr(c.producer.model) > mr(g.producer.model)) g.producer = c.producer
  }
  return out
}

// Rung = verify.rungs[severity] + bump, raised to the unit's own floor (a V2/V3/V4 token
// in its check) and to V3 for parity claims of severity medium and above, capped at V4.
// Low and info parity claims keep their own rung (raising them let topK cut mediums).
const floorOf = checks => Math.max(-1, ...(checks || []).map(t => RUNGS.indexOf(t.toUpperCase())).filter(i => i >= 2))

function rungFor(c, rungs) {
  let r = RUNGS.indexOf(rungs[c.severity] || DEFAULT_RUNGS[c.severity] || 'V0')
  if (r < 0) r = 0
  r += c.bump || 0
  if (Number.isInteger(c.floor) && c.floor >= 0) r = Math.max(r, c.floor)
  if (c.parity && sevRank(c.severity) >= sevRank('medium')) r = Math.max(r, 3)
  return RUNGS[Math.min(4, Math.max(0, r))]
}

// A CONFIRMED verdict must carry the skeptic's own support: a verbatim quote it found
// (support) or, for an absence claim, the empty search it ran (support_cmd). Without
// either it is kept as PLAUSIBLE — a skeptic's say-so is not confirmation.
function requireSupport(v) {
  if (!v || v.verdict !== 'CONFIRMED') return v
  const quoted = v.support && v.support.file && v.support.quote
  const cmd = typeof v.support_cmd === 'string' && v.support_cmd.trim()
  if (quoted || cmd) return v
  return { ...v, verdict: 'PLAUSIBLE', reason: `confirmed without own support: ${v.reason || ''}`.trim() }
}

function mergeVerdicts(list) {
  const vs = list.filter(Boolean).map(requireSupport)
  if (!vs.length) return { verdict: 'UNVERIFIED', reason: 'no verdict returned' }
  if (vs.length === 1) return vs[0]
  const kinds = new Set(vs.map(v => v.verdict))
  if (kinds.size === 1) return { ...vs[0], reason: vs.map(v => v.reason).filter(Boolean).join(' / ').slice(0, 600) }
  if (kinds.has('REFUTED')) return { verdict: 'UNVERIFIED', reason: `split panel: ${vs.map(v => v.verdict).join(' vs ')} — master spot-read`, split: true }
  if (kinds.has('CONFIRMED') && kinds.has('PLAUSIBLE') && kinds.size === 2) {
    const unsupported = vs.some(v => (v.reason || '').startsWith('confirmed without own support'))
    return { verdict: 'PLAUSIBLE', reason: `panel: one lens could not fully confirm${unsupported ? ' (confirmed without own support)' : ''}` }
  }
  return { verdict: 'PLAUSIBLE', reason: `panel: ${vs.map(v => v.verdict).join(' vs ')}` }
}

function normalizeVerdict(v) {
  if (!v) return null
  if (v.verdict === 'REFUTED' && !(v.counter_quote && v.counter_quote.file && v.counter_quote.quote)) {
    return { ...v, verdict: 'PLAUSIBLE', reason: `refuted without a counter-quote — kept as plausible. ${v.reason || ''}`.trim() }
  }
  if (v.verdict === 'UNVERIFIABLE') return { ...v, verdict: 'UNVERIFIED' }
  return requireSupport(v)
}

function mergeResults(a, b) {
  if (!b) return a
  const files = [...new Set([...(a.files_read || []), ...(b.files_read || [])])]
  const nums = [...(a.numbers || [])]
  for (const n of b.numbers || []) if (!nums.some(x => x.name === n.name)) nums.push(n)
  const assumptions = [...new Set([...(a.assumptions || []), ...(b.assumptions || [])])]
  return {
    ...a,
    status: b.status === 'complete' ? 'complete' : b.status || a.status,
    blocked_reason: b.blocked_reason || a.blocked_reason,
    remaining: b.remaining || [],
    files_read: files,
    summary: `${a.summary || ''} | ${b.summary || ''}`.slice(0, 300),
    findings: [...(a.findings || []), ...(b.findings || [])],
    numbers: nums,
    confidence: Math.min(typeof a.confidence === 'number' ? a.confidence : 1, typeof b.confidence === 'number' ? b.confidence : 1),
    assumptions,
    result: { ...(a.result || {}), ...(b.result || {}) },
  }
}

function mergeInspections(a, b) {
  if (!a) return b || null
  if (!b) return a
  const total = a.total + b.total
  const resolved = a.resolved === null || b.resolved === null ? null : a.resolved + b.resolved
  return {
    total, resolved, rate: resolved === null ? null : resolved / total, skipped: a.skipped || b.skipped || null,
    resolvedFiles: [...new Set([...(a.resolvedFiles || []), ...(b.resolvedFiles || [])])],
    resolvedKeys: [...(a.resolvedKeys || []), ...(b.resolvedKeys || [])],
  }
}

const EVIDENCE = {
  type: 'object',
  properties: { file: { type: 'string' }, line: { type: 'integer', minimum: 1 }, quote: { type: 'string', maxLength: 160 } },
  required: ['file', 'line', 'quote'],
}
const UNIT_RESULT = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['complete', 'partial', 'blocked'] },
    blocked_reason: { type: 'string', enum: [...BRIEF_REASONS, ...CAPABILITY_REASONS] },
    remaining: { type: 'array', items: { type: 'string' } },
    files_read: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string', maxLength: 300 },
    findings: {
      type: 'array', maxItems: 15,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', maxLength: 160 },
          severity: { type: 'string', enum: SEVERITIES },
          claim: { type: 'string', maxLength: 300 },
          evidence: { type: 'array', items: EVIDENCE, maxItems: 4 },
        },
        required: ['title', 'severity', 'claim', 'evidence'],
      },
    },
    numbers: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, value: { type: 'string' }, method: { type: 'string', maxLength: 160 } },
        required: ['name', 'value'],
      },
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    assumptions: { type: 'array', items: { type: 'string' } },
    result: { type: 'object' },
  },
  required: ['status', 'files_read', 'summary', 'findings', 'confidence', 'assumptions'],
}
const INSPECT = {
  type: 'object',
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { ref: { type: 'string' }, found: { type: 'boolean' }, actual_line: { type: 'integer' } },
        required: ['ref', 'found'],
      },
    },
    unreadable: { type: 'array', items: { type: 'string' } },
  },
  required: ['checks'],
}
const VERDICT = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          cid: { type: 'string' },
          verdict: { type: 'string', enum: ['CONFIRMED', 'REFUTED', 'PLAUSIBLE', 'UNVERIFIABLE'] },
          reason: { type: 'string', maxLength: 300 },
          severity: { type: 'string', enum: SEVERITIES },
          counter_quote: EVIDENCE,
          support: EVIDENCE,
          support_cmd: { type: 'string', maxLength: 200 },
        },
        required: ['cid', 'verdict', 'reason', 'severity'],
      },
    },
  },
  required: ['verdicts'],
}
const CRITIC = {
  type: 'object',
  properties: {
    missing: {
      type: 'array', maxItems: 8,
      items: {
        type: 'object',
        properties: { what: { type: 'string', maxLength: 200 }, why: { type: 'string', maxLength: 200 }, suggestion: { type: 'string', maxLength: 200 } },
        required: ['what', 'why'],
      },
    },
  },
  required: ['missing'],
}

function unitSchema(u) {
  const s = JSON.parse(JSON.stringify(UNIT_RESULT))
  if (u.schema && typeof u.schema === 'object') s.properties.result = u.schema
  return s
}

// One severity scale for producers and skeptics. A blind audit found 61% of findings filed too
// high (often by two levels), so the rubric anchors each level to what the code does today.
const SEVERITY_RUBRIC = [
  'Severity:',
  '- blocker = wrong customer-facing money or legal action, or data loss, in normal operation.',
  '- high = a wrong outcome is likely in realistic cases.',
  '- medium = edge cases, or a real operational risk.',
  '- low = minor.',
  '- info = an observation.',
  'Rate by what the code does today, not the worst imaginable case; most findings are medium or low.',
].join('\n')

const RULES = [
  'Rules for this unit:',
  '- Read-only: do not edit, write, commit or push anything. Never print credentials or .env values.',
  '- Every finding needs evidence: file path, line number, and a quote of at most 160 characters copied verbatim from that line.',
  '- files_read must list every file you read lines from, including through grep or sed.',
  '- If you cannot finish, set status "partial" and list what is left in remaining. If the brief is unclear, you lack access, or the work is outside the scope, set status "blocked" with blocked_reason ambiguous_brief | no_access | out_of_scope instead of guessing. Use too_hard or contradictory_evidence when that is the honest reason.',
  '- confidence is your honest probability (0-1) that the findings are correct and complete. Being unsure is fine; overclaiming is not.',
  '- Compact output: at most 15 findings, summary at most 300 characters. Your final answer is the structured output only.',
  SEVERITY_RUBRIC,
].join('\n')

const NUMBER_RULES = [
  'Numbers for this unit:',
  '- Compute with code (python3 or SQL), never by mental arithmetic.',
  '- Report every result in numbers as {name, value, method}: value is a decimal string with "." as the decimal separator and no thousands separators (e.g. "-1234.56"); method names the tool and approach in one line.',
  '- Use exactly the names the brief asks for, so derivations can be compared.',
].join('\n')

const INSPECT_RULES = [
  'You check quotes, nothing else. For each item, print the cited lines with Bash (`nl -ba FILE | sed -n \'A,Bp\'`; paths are relative to the current working directory) and decide whether the quote appears verbatim, ignoring whitespace differences, within 3 lines of the given line.',
  'If the quote appears elsewhere in the file, set found=false and give actual_line. If the file cannot be read, set found=false and list it in unreadable.',
  'Do not judge whether any claim is correct. Return one check per item, keyed by its ref.',
].join('\n')

const SKEPTIC_RULES = [
  'You are an independent skeptic. For each claim decide:',
  '- CONFIRMED: you verified it yourself in the files or data, and you give your own support: support {file, line, quote} = a verbatim quote you found that shows the claimed behaviour (prefer a line other than the producer\'s evidence), or, for a claim that something is absent, support_cmd = the exact search you ran that came back empty. Without support, use PLAUSIBLE.',
  '- REFUTED: you found concrete counter-evidence; give counter_quote {file, line, quote}. No counter-evidence means not refuted.',
  '- PLAUSIBLE: it could be true but you could not fully confirm it.',
  '- UNVERIFIABLE: it cannot be checked with the access you have.',
  'You see only the claim and its evidence pointers, not the producer\'s reasoning. Check the files yourself with Bash (`grep -n`, `nl -ba FILE | sed -n \'A,Bp\'`). Keep each reason under 300 characters. Read-only: never edit anything.',
  'For every claim you check, state your own severity rating in severity, by the rubric below, whatever the producer filed.',
  SEVERITY_RUBRIC,
].join('\n')

function trimJson(x, max) {
  let s
  try { s = JSON.stringify(x) } catch (e) { s = String(x) }
  return s.length > max ? s.slice(0, max) + '…' : s
}

function modeText(mode, o) {
  o = o || {}
  const reasons = (o.reasons || []).map(r => `- ${r}`).join('\n')
  if (mode === 'capacity') {
    const items = [...(o.missing || []).map(f => `- file: ${f}`), ...(o.remaining || []).map(r => `- item: ${r}`)].join('\n')
    const prior = ((o.prev && o.prev.findings) || []).map(f => `- ${f.title}`).join('\n') || '- (none)'
    return `Continuation: an earlier run of this unit did not cover everything. Cover ONLY these:\n${items}\nDo not repeat these earlier findings:\n${prior}\nReport files_read for this run only.`
  }
  if (mode === 'repair') {
    const prev = o.prev ? { summary: o.prev.summary, findings: o.prev.findings, numbers: o.prev.numbers } : {}
    return `Repair: an earlier attempt of this unit had these defects:\n${reasons}\nIts output was:\n${trimJson(prev, 3000)}\nFix only the defects (re-read the files so every quote is grounded), keep what was correct, and return the complete corrected result.`
  }
  if (mode === 'redo') {
    return `Fresh attempt: an earlier attempt was mostly ungrounded (its quotes were not found in the files). Do not rely on it. Known problems:\n${reasons}\nStart from the files; every finding needs a verbatim quote.`
  }
  if (mode === 'rederive') {
    const names = [...new Set(((o.prev && o.prev.numbers) || []).map(n => n.name))].join(', ') || 'the numbers named in the brief'
    const methods = [...new Set([...((o.prev && o.prev.numbers) || []), ...(o.rdNumbers || [])].map(n => n.method).filter(Boolean))].join(' | ') || 'unknown'
    return `Independent re-derivation: compute the same numbers (${names}) by a DIFFERENT method than the earlier one(s): ${methods}. Do not reuse earlier scripts or results. Report each number with its method.`
  }
  return ''
}

// @core-end
// ═══════════════════════════════ RUN ═══════════════════════════════

let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch (e) { A = null } }
if (!A || typeof A !== 'object' || !Object.keys(A).length) {
  log('fanout was started without args, so there is nothing to run. Use /dynamic-fanout:dynamic-fanout <task> so the master can plan it.')
  return { started: false, reason: 'no-args' }
}

phase('Validate')
const K = calibrate(A.calib)
const V = validate(A)
V.warnings.push(...K.warnings)
const M = V.units.length && mr(V.S) >= 0 && er(V.E) >= 0 ? price(A, V, K) : null
if (M) moneyRails(A, V, M)
const card = M ? buildCard(A, V, M, K) : null
if (V.errors.length) {
  log(`plan rejected: ${V.errors.length} rail violation(s); no agent launched`)
  return { started: false, reason: 'rails', errors: V.errors, warnings: V.warnings, card }
}
if (A.dryRun) return { started: false, reason: 'dryRun', warnings: V.warnings, card }
const pauseUsd = A.caps && typeof A.caps.pauseUsd === 'number' ? A.caps.pauseUsd : 10
if (M.P > pauseUsd && !A.confirmed && V.stage !== 'verify') {
  return { started: false, reason: 'pause', warnings: V.warnings, card, note: `planned $${round2(M.P)} exceeds pauseUsd $${pauseUsd}: show the card, then re-run with confirmed: true` }
}
log(`plan accepted: ${V.units.length} unit(s), U $${round2(M.U)}, P $${round2(M.P)}, R $${round2(M.R)}, C $${round2(M.C)} (${card.money.ratio}×U)`)

const S = V.S
const E = V.E
const AT = {
  worker: 'dynamic-fanout:worker', workerMcp: 'dynamic-fanout:worker-mcp', workerCtx: 'dynamic-fanout:worker-ctx', implementer: 'dynamic-fanout:implementer',
  skeptic: 'dynamic-fanout:skeptic', inspector: 'dynamic-fanout:inspector', ...(A.agentTypes || {}),
}
const inAvg = Number(A.ultra && A.ultra.inAvg) > 0 ? Number(A.ultra.inAvg) : 40000
const tol = Number(A.reduce && A.reduce.tolCents) || 0
const carry = A.carry || {}
const money = {
  workPool: M.C - M.R - M.verifyUsd, reserve: M.R, b2Earmark: M.b2Earmark, verifyPool: M.verifyUsd,
  committed: Number(carry.committedUsd) || 0, rerouteUsd: Number(carry.rerouteUsd) || 0, verifySpent: 0,
}
const out0 = budget.spent()
const maxOut = A.caps && Number(A.caps.maxOutputTokens) > 0 ? Number(A.caps.maxOutputTokens) : Math.round(1.5 * M.plannedOut)
const b2Pending = new Set(V.units.filter(u => u.fbCell && u.v && u.v.B === 2).map(u => u.id))
const ledger = { units: [], verifiers: [], inspectors: [], sweeps: [], cells: {}, reroutes: 0, promotions: [], rescued: 0 }
const unitResults = {}
let claims = []
// Union of every unit's scope files, for canonicalizing evidence that isn't tied to one unit
// (sweep claims, and verdict counter_quote/support, which can cite any file in the task).
const allScopeFiles = [...new Set(V.units.flatMap(u => (u.scope && u.scope.files) || []))]
function scopeEvidence(list, scope) {
  return (Array.isArray(list) ? list : []).map(e => (e && e.file ? { ...e, file: toScope(e.file, scope) } : e))
}
const dropped = []
const warnings = [...V.warnings]

// The kill switch stops NEW WORK only. Planned verification of claims already produced
// draws from its own reserve and is never cut by it: cutting checks saves nothing that was
// not already spent, and costs quality.
function blocked(est, pool, u) {
  if (budget.total && budget.remaining() < 0.25 * budget.total) return 'budget: native budget below 25% remaining'
  if (pool === 'verify') {
    if (money.verifySpent + est <= money.verifyPool + 1e-9) return null
    if (money.committed + est > money.workPool + 1e-9) return 'budget: verification reserve and work pool exhausted'
    return null
  }
  if (budget.spent() - out0 > 0.75 * maxOut) return 'budget: kill switch (output above 75% of maxOutputTokens)'
  if (pool === 'reserve') {
    const hold = u && u.v && u.v.B === 2 ? 0 : b2Pending.size ? money.b2Earmark : 0
    if (money.rerouteUsd + est > money.reserve - hold + 1e-9) return 'budget: re-route reserve exhausted'
    return null
  }
  if (money.committed + est > money.workPool + 1e-9) return 'budget: work pool exhausted'
  return null
}
function commit(est, pool, cell) {
  if (pool === 'reserve') money.rerouteUsd += est
  else if (pool === 'verify' && money.verifySpent + est <= money.verifyPool + 1e-9) money.verifySpent += est
  else money.committed += est
  const k = cellKey(cell)
  ledger.cells[k] = (ledger.cells[k] || 0) + 1
}

async function call(prompt, cell, o) {
  const opts = { label: o.label, phase: o.phase }
  if (o.schema) opts.schema = o.schema
  if (cell.model !== S) opts.model = cell.model
  if (cell.model !== 'haiku' && cell.effort) opts.effort = cell.effort
  if (o.agentType) opts.agentType = o.agentType
  try {
    const r = await agent(prompt, opts)
    if (r && o.agentType) typeOk.add(o.agentType)
    return r
  } catch (e) { return null }
}

// A plugin agent type that answered once in this run exists; keep it on a retry so its
// turn cap and lean prefix still apply. Only a type never seen working is dropped (a missing
// plugin agent), falling back to the default workflow subagent.
const typeOk = new Set()
async function callOnce(prompt, cell, o) {
  const r = await call(prompt, cell, o)
  if (r && o.agentType) typeOk.add(o.agentType)
  if (r || !o.agentType) return r
  return call(prompt, cell, typeOk.has(o.agentType) ? o : { ...o, agentType: undefined })
}

// worker carries only Grep/Glob/Bash (no MCP schemas in its prefix; no Read, which attaches nested CLAUDE.md); a T2 unit
// (MCP or long tool loops) gets worker-mcp; ctx keep gets worker-ctx (all tools + CLAUDE.md).
const unitAgentType = u => AT[typeKey(u)] || AT.worker

function unitPrompt(u, attempt, mode) {
  const lines = [A.shared || '', '', `## Unit ${u.id}: ${u.role}`, u.brief, '']
  if (u.scope.files.length) lines.push('Scope: read these and list every file you actually read in files_read:', ...u.scope.files.map(f => `- ${f}`), '')
  lines.push(RULES)
  const cap = u.o && u.o.cap
  lines.push(`- Budget: about ${u.turns || 20} tool calls${cap ? ` (hard stop at ${cap})` : ''}. Find before you read: grep first, then print only the line ranges you need with Bash (\`nl -ba FILE | sed -n 'A,Bp'\`), not whole files; leave Scope only to resolve a reference. Keep your last 2 calls for the answer; if the budget runs out, return status "partial" with remaining[] instead of continuing.`)
  if (Number(u.in) > 0) lines.push(`- Reading budget: about ${Math.round(u.in / 12)} lines in total (~${u.in} tokens); each range at most ~250 lines.`)
  lines.push('- Cite every file path exactly as it is written under Scope.')
  if (u.n) lines.push('', NUMBER_RULES)
  if (mode) lines.push('', mode)
  lines.push('', `⟦df:${u.id}:${attempt}⟧`)
  return lines.join('\n')
}

async function inspect(u, res, n) {
  if (!res || !needsInspector(u)) return null
  const items = []
  ;(res.findings || []).forEach((f, i) => (f.evidence || []).forEach((e, j) => items.push({ ref: `f${i}.e${j}`, file: toScope(e.file, u.scope.files), line: e.line, quote: e.quote })))
  if (!items.length) return null
  const batch = items.slice(0, MAX_INSPECT_QUOTES)
  const est = estUsd(V.inspCell, K.inspectorIn, 0, K, agentOpts('inspector', K))
  const tag = `⟦df:i:${u.id}:${n}⟧`
  const why = blocked(est, 'work', u)
  if (why) { ledger.inspectors.push({ tag, unit: u.id, quotes: batch.length, resolved: null, estUsd: 0, skipped: why }); return { total: batch.length, resolved: null, rate: null, skipped: why } }
  commit(est, 'work', V.inspCell)
  const prompt = `${INSPECT_RULES}\n\nItems (ref | file | line | quote):\n${batch.map(it => `${it.ref} | ${it.file} | ${it.line} | ${it.quote}`).join('\n')}\n\n${tag}`
  const r = await callOnce(prompt, V.inspCell, { label: `inspect:${u.id}·${cellKey(V.inspCell)}`, phase: 'Work', schema: INSPECT, agentType: AT.inspector })
  if (!r) { ledger.inspectors.push({ tag, unit: u.id, quotes: batch.length, resolved: null, estUsd: est, skipped: 'inspector returned nothing' }); return { total: batch.length, resolved: null, rate: null, skipped: 'inspector failed' } }
  const found = new Set((r.checks || []).filter(c => c && c.found).map(c => c.ref))
  const hits = batch.filter(b => found.has(b.ref))
  const resolved = hits.length
  ledger.inspectors.push({ tag, unit: u.id, quotes: batch.length, resolved, estUsd: est })
  if (items.length > batch.length) warnings.push(`inspect ${u.id}: ${items.length - batch.length} quote(s) beyond ${MAX_INSPECT_QUOTES} left to check-evidence.mjs`)
  // resolvedFiles: cited files with >= 1 resolved quote (they count as read); resolvedKeys:
  // file|quote of each resolved item, so a failed unit's grounded claims can be rescued.
  return {
    total: batch.length, resolved, rate: resolved / batch.length,
    resolvedFiles: [...new Set(hits.map(b => b.file))], resolvedKeys: hits.map(b => `${b.file}|${b.quote}`),
  }
}

const promoted = new Set()
const cohortSize = new Map()
const cohortFails = new Map()
const cohortKey = u => `${u.role}|${cellKey(u.cell)}`
for (const u of V.units) cohortSize.set(cohortKey(u), (cohortSize.get(cohortKey(u)) || 0) + 1)
function noteCapFail(u) {
  const k = cohortKey(u)
  const f = (cohortFails.get(k) || 0) + 1
  cohortFails.set(k, f)
  if (!promoted.has(k) && f >= 2 && f / cohortSize.get(k) >= 0.25) {
    promoted.add(k)
    ledger.promotions.push(k)
    log(`cohort ${k}: ${f} capability failures; its not-yet-started units launch on their fallback`)
  }
}

// rescue: the inspection of res when the unit ends unverified because its capability re-route
// was refused, fb is null or fb failed. Claims with a resolved quote then go to verification
// one rung higher instead of being dumped as UNVERIFIED; the unit's outcome stays unverified.
function finishUnit(L, u, outcome, reason, res, c, producer, rescue) {
  L.outcome = outcome
  L.reason = reason || null
  L.verifyBump = (c && c.verifyBump ? 1 : 0) + (outcome === 'ok-rerouted' ? 1 : 0)
  const last = L.attempts[L.attempts.length - 1]
  if (last && !last.cls) last.cls = c ? c.cls : outcome
  b2Pending.delete(u.id)
  unitResults[u.id] = res ? {
    status: res.status, summary: res.summary, files_read: res.files_read || [], numbers: res.numbers || [],
    numbersStatus: res.numbersStatus || (u.n ? 'UNVERIFIED' : null), numbersConflict: res.numbersConflict || null,
    result: res.result || null, assumptions: res.assumptions || [], confidence: res.confidence,
    uncovered: (c && c.uncovered) || [],
  } : null
  const keys = new Set(outcome === 'unverified' && rescue ? rescue.resolvedKeys || [] : [])
  const grounded = f => (f.evidence || []).some(e => e && keys.has(`${toScope(e.file, u.scope.files)}|${e.quote}`))
  if (res) {
    ;(res.findings || []).forEach((f, i) => { const saved = keys.size > 0 && grounded(f); if (saved) ledger.rescued++; claims.push({
      cid: `${u.id}.f${i + 1}`, unit: u.id, severity: SEVERITIES.includes(f.severity) ? f.severity : 'medium',
      title: f.title, claim: f.claim, evidence: scopeEvidence(f.evidence, u.scope.files),
      parity: u.parity, producer: producer || u.cell, bump: L.verifyBump + (saved ? 1 : 0), blast: u.v ? u.v.B : 0, floor: floorOf(u.checks),
      verdict: !saved && (outcome === 'unverified' || outcome === 'brief') ? 'UNVERIFIED' : null,
      reason: saved ? `producer unit failed: ${reason || ''}`.trim() : outcome === 'unverified' || outcome === 'brief' ? `unit ${outcome}: ${reason || ''}`.trim() : null,
      rescued: saved ? `producer unit failed: ${reason || ''}`.trim() : null,
    }) })
  }
  return L
}

async function runUnit(u) {
  const L = {
    id: u.id, role: u.role, vec: u.vec, parity: u.parity, p: cellKey(u.cell), fb: u.fbCell ? cellKey(u.fbCell) : null,
    ctx: u.ctx, check: u.check, why: u.why, override: u.override || null, outcome: null, reason: null, verifyBump: 0, attempts: [],
  }
  ledger.units.push(L)
  const at = unitAgentType(u)
  const st = { capacity: false, fbUsed: false }
  let attempt = 0
  let cell = u.cell
  let kind = 'primary'
  if (promoted.has(cohortKey(u)) && u.fbCell) {
    const delta = Math.max(0, u.repairUsd - u.estPrimary)
    if (!blocked(delta, 'reserve', u) && !blocked(u.estPrimary, 'work', u)) { money.rerouteUsd += delta; cell = u.fbCell; kind = 'promoted'; st.fbUsed = true }
  }
  const run = async (c, k, mode, o) => {
    attempt++
    const tag = `⟦df:${u.id}:${attempt}⟧`
    const est = estUsd(c, u.in, u.ctxTokEff, K, u.o)
    const pool = k === 'reroute' ? 'reserve' : 'work'
    const why = k === 'promoted' ? blocked(u.estPrimary, 'work', u) : blocked(est, pool, u)
    if (why) { L.attempts.push({ n: attempt, tag, cell: cellKey(c), kind: k, mode: mode || null, cls: 'refused', estUsd: 0 }); return { refused: why } }
    if (k === 'promoted') { money.committed += u.estPrimary; ledger.cells[cellKey(c)] = (ledger.cells[cellKey(c)] || 0) + 1 } else commit(est, pool, c)
    const res = await call(unitPrompt(u, attempt, mode ? modeText(mode, o) : null), c, {
      label: `${u.id}·${cellKey(c)}${k === 'primary' ? '' : '·' + k}`, phase: 'Work', schema: unitSchema(u),
      agentType: o && o.noAgentType && !typeOk.has(at) ? undefined : at,
    })
    L.attempts.push({ n: attempt, tag, cell: cellKey(c), kind: k, mode: mode || null, cls: null, estUsd: round4(est) })
    return { res }
  }

  let r = await run(cell, kind, null, null)
  if (r.refused) return finishUnit(L, u, 'unverified', r.refused, null, null)
  let res = r.res
  if (!res) {
    L.attempts[L.attempts.length - 1].cls = 'infra'
    r = await run(cell, 'infra', null, { noAgentType: true })
    if (r.refused) return finishUnit(L, u, 'unverified', r.refused, null, null)
    res = r.res
    if (!res) return finishUnit(L, u, 'unverified', 'infra: no result after one retry', null, null)
  }
  let producer = cell
  let insp = await inspect(u, res, attempt)
  let rd = null
  let tie = null
  if (u.rdCell && res.status !== 'blocked') {
    r = await run(u.rdCell, 'rederive-planned', 'rederive', { prev: res })
    rd = r.res || null
    tie = rd ? compareNumbers(res.numbers, rd.numbers, tol) : { ok: false, reason: r.refused || 'planned re-derivation returned nothing', diffs: [] }
    if (L.attempts.length) L.attempts[L.attempts.length - 1].cls = tie.ok ? 'tie-ok' : 'tie-mismatch'
  }
  let c = classify(u, res, insp, { capacityUsed: false, tieoutFailed: !!(tie && !tie.ok) })
  if (c.cls === 'capacity') {
    L.attempts[0].cls = L.attempts[0].cls || 'capacity'
    st.capacity = true
    r = await run(cell, 'capacity', 'capacity', { missing: c.missing, remaining: c.remaining, prev: res })
    if (!r.refused && r.res) {
      const more = r.res
      insp = mergeInspections(insp, await inspect(u, more, attempt))
      res = mergeResults(res, more)
    }
    c = classify(u, res, insp, { capacityUsed: true, tieoutFailed: !!(tie && !tie.ok) })
  }
  if (c.cls === 'brief') return finishUnit(L, u, 'brief', c.reasons.join('; '), res, c, producer)
  if (c.cls === 'capability') {
    const lastPrimary = L.attempts.filter(x => x.kind !== 'rederive-planned').pop()
    if (lastPrimary) lastPrimary.cls = 'capability'
    noteCapFail(u)
    if (st.fbUsed || !u.fbCell) {
      if (u.n && tie) {
        res.numbersStatus = 'UNVERIFIED'
        if (!tie.ok) res.numbersConflict = { primary: res.numbers, rederived: rd ? rd.numbers : null, fallback: null }
      }
      return finishUnit(L, u, 'unverified', `exhausted (${st.fbUsed ? 'fallback already used' : 'fb null'}): ${c.reasons.join('; ')}`, res, c, producer, insp)
    }
    st.fbUsed = true
    r = await run(u.fbCell, 'reroute', c.mode, { reasons: c.reasons, prev: res, rdNumbers: rd && rd.numbers })
    if (r.refused) return finishUnit(L, u, 'unverified', `${r.refused} (needed a re-route: ${c.reasons.join('; ')})`, res, c, producer, insp)
    ledger.reroutes++
    log(`${u.id}: re-routed once to ${cellKey(u.fbCell)} (${c.mode}): ${c.reasons.join('; ')}`)
    const fixed = r.res
    if (!fixed) return finishUnit(L, u, 'unverified', 're-route returned no result', res, c, producer, insp)
    producer = u.fbCell
    const insp2 = await inspect(u, fixed, attempt)
    let tie2 = null
    if (c.mode === 'rederive') {
      const m1 = compareNumbers(res.numbers, fixed.numbers, tol)
      const m2 = rd ? compareNumbers(rd.numbers, fixed.numbers, tol) : { ok: false, diffs: [] }
      tie2 = m1.ok ? m1 : m2.ok ? m2 : m1
      fixed.numbersStatus = tie2.ok ? 'CONFIRMED' : 'UNVERIFIED'
      if (!tie2.ok) fixed.numbersConflict = { primary: res.numbers, rederived: rd ? rd.numbers : null, fallback: fixed.numbers }
    }
    const c2 = classify(u, fixed, insp2, { capacityUsed: true, tieoutFailed: !!(tie2 && !tie2.ok) })
    if (c2.cls !== 'ok') return finishUnit(L, u, 'unverified', `after fallback: ${(c2.reasons || []).join('; ') || c2.cls}`, fixed, c2, producer, insp2)
    return finishUnit(L, u, 'ok-rerouted', null, fixed, c2, producer)
  }
  if (u.n && tie) res.numbersStatus = tie.ok ? 'CONFIRMED' : 'UNVERIFIED'
  return finishUnit(L, u, kind === 'promoted' ? 'ok-promoted' : 'ok', null, res, c, producer)
}

async function sweep() {
  const found = []
  if (!V.rounds) return found
  const scopeFiles = [...new Set(V.units.flatMap(u => u.scope.files))]
  for (let r = 1; r <= V.rounds; r++) {
    const est = estUsd(V.sweepCell, inAvg * K.sweepInFrac, 0, K, agentOpts('worker', K, 'sweep'))
    const why = blocked(est, 'work')
    if (why) { dropped.push({ what: 'sweep rounds', count: V.rounds - r + 1, reason: why }); break }
    commit(est, 'work', V.sweepCell)
    const tag = `⟦df:s:${r}:1⟧`
    const known = [...claims, ...found].slice(0, 60).map(c => {
      const e = (c.evidence || [])[0]
      return `- ${c.title}${e ? ` @ ${e.file}:${e.line}` : ''}`
    }).join('\n') || '- (none)'
    const prompt = [
      A.shared || '', '', `## Gap sweep, round ${r}`,
      `Find NEW ${A.kind === 'review' ? 'issues' : 'findings'} of the same kind as the task, inside the scope below, that are NOT in this list:`, known, '',
      scopeFiles.length ? `Scope:\n${scopeFiles.map(f => `- ${f}`).join('\n')}` : 'Scope: the same as the task.', '',
      RULES, '', 'An empty findings list is a valid answer when nothing new exists.', '', tag,
    ].join('\n')
    const res = await callOnce(prompt, V.sweepCell, { label: `sweep${r}·${cellKey(V.sweepCell)}`, phase: 'Sweep', schema: UNIT_RESULT, agentType: AT.worker })
    const fresh = []
    ;((res && res.findings) || []).forEach((f, i) => {
      const c = {
        cid: `s${r}.f${i + 1}`, unit: 'sweep', severity: SEVERITIES.includes(f.severity) ? f.severity : 'medium', title: f.title,
        claim: f.claim, evidence: scopeEvidence(f.evidence, scopeFiles), parity: false, producer: V.sweepCell, bump: 0,
        blast: Math.max(0, ...V.units.map(u => (u.v ? u.v.B : 0))), verdict: null, reason: null,
      }
      // A re-find of a known claim (or of an earlier sweep finding) is dropped; a distinct
      // issue next to one is kept (see sameIssue).
      if (findSame([...claims, ...found, ...fresh], c, ['file', 'line'])) return
      fresh.push(c)
    })
    ledger.sweeps.push({ tag, cell: cellKey(V.sweepCell), round: r, newClaims: fresh.length, estUsd: est })
    found.push(...fresh)
    if (!fresh.length) break
  }
  return found
}

function verifierCell(c) {
  const highE = minEffort('high', E)
  if (c.rung === 'V2') {
    const pm = c.producer && mr(c.producer.model) >= mr('sonnet') ? c.producer.model : 'sonnet'
    return { model: pm, effort: minEffort('medium', E) }
  }
  if (c.parity) return { model: S, effort: highE }
  return c.rung === 'V4' ? V.V4 : V.V3
}

async function runBatch(b) {
  const lenses = b.rung === 'V4'
    ? ['Lens: correctness and reachability. Can this actually happen on a real path, with real inputs?', 'Lens: counter-evidence. Look for code, config, tests or data that make the claim false.']
    : [null]
  const verdictSets = []
  for (let i = 0; i < lenses.length; i++) {
    const est = estUsd(b.cell, inAvg * K.verifierInFrac, 0, K, agentOpts('skeptic', K))
    const why = blocked(est, 'verify')
    if (why) { verdictSets.push(null); dropped.push({ what: `verification ${b.id}${lenses.length > 1 ? ` lens ${i + 1}` : ''}`, count: b.claims.length, reason: why }); continue }
    commit(est, 'verify', b.cell)
    const tag = `⟦df:v:${b.id}:${i + 1}⟧`
    const list = b.claims.map(c => [
      `${c.cid} | ${c.severity} | ${c.title}`,
      `  claim: ${c.claim}`,
      `  evidence: ${(c.evidence || []).map(e => `${e.file}:${e.line} "${e.quote}"`).join('; ') || '(none)'}`,
    ].join('\n')).join('\n')
    const prompt = [A.shared || '', '', SKEPTIC_RULES, lenses[i] ? `\n${lenses[i]}` : '', '', 'Claims:', list, '', tag].join('\n')
    const r = await callOnce(prompt, b.cell, { label: `verify:${b.id}·${b.rung}·${cellKey(b.cell)}`, phase: 'Verify', schema: VERDICT, agentType: AT.skeptic })
    ledger.verifiers.push({ tag, cell: cellKey(b.cell), rung: b.rung, claims: b.claims.map(c => c.cid), estUsd: est })
    verdictSets.push(r ? new Map((r.verdicts || []).map(v => [v.cid, normalizeVerdict(v)])) : null)
  }
  for (const c of b.claims) {
    const got = verdictSets.map(m => (m ? m.get(c.cid) || null : null))
    if (got.every(v => !v)) {
      const reason = verdictSets.every(m => m === null) ? 'verifier refused or failed (see dropped)' : 'no verdict returned'
      Object.assign(c, { verdict: 'UNVERIFIED', verdictBy: b.id, reason })
      continue
    }
    const v = b.rung === 'V4' ? mergeVerdicts(got) : got[0]
    Object.assign(c, { verdict: v.verdict, verdictBy: `${b.id}·${cellKey(b.cell)}`, reason: v.reason || null })
    if (v.counter_quote) c.counter_quote = v.counter_quote.file ? { ...v.counter_quote, file: toScope(v.counter_quote.file, allScopeFiles) } : v.counter_quote
    if (v.support) c.support = v.support.file ? { ...v.support, file: toScope(v.support.file, allScopeFiles) } : v.support
    if (v.support_cmd) c.support_cmd = v.support_cmd
    // Always stored: the skeptic's own rating (a V4 panel: the highest any lens stated), else the
    // filed severity. The rung was already chosen from the filed severity.
    const rated = got.filter(x => x && SEVERITIES.includes(x.severity)).map(x => x.severity)
    c.verifiedSeverity = rated.length ? rated.reduce((a, s) => (sevRank(s) > sevRank(a) ? s : a)) : c.severity
  }
}

async function verify(all) {
  const { topK, batch: batchSize } = verifySizing(A.verify, A.depth)
  const pending = []
  for (const c of all) {
    if (c.verdict) continue
    c.rung = rungFor(c, V.rungs)
    if (c.rung === 'V0') { Object.assign(c, { verdict: 'PLAUSIBLE', verdictBy: 'V0', reason: 'not verified (rung V0)' }); continue }
    if (c.rung === 'V1') { Object.assign(c, { verdict: 'PLAUSIBLE', verdictBy: 'V1', reason: 'grounded quotes; not independently judged' }); continue }
    pending.push(c)
  }
  pending.sort((x, y) => sevRank(y.severity) - sevRank(x.severity) || (y.blast || 0) - (x.blast || 0) || String(x.cid).localeCompare(String(y.cid)))
  // Parity claims carry the >= ultracode guarantee and blocker/high claims sit at V3 by
  // severity: topK never drops either; it only bounds the remaining V2+ claims.
  const exempt = pending.filter(c => topKExempt(c, V.rungs))
  const rest = pending.filter(c => !topKExempt(c, V.rungs))
  const chosen = [...exempt, ...rest.slice(0, topK)]
  const over = rest.slice(topK)
  for (const c of over) Object.assign(c, { verdict: 'UNVERIFIED', verdictBy: 'topK', reason: `beyond topK ${topK}` })
  if (over.length) dropped.push({ what: 'claims beyond topK', count: over.length, reason: `topK=${topK}` })
  const groups = new Map()
  for (const c of chosen) {
    const cell = verifierCell(c)
    const key = `${c.rung}|${cellKey(cell)}|${c.unit}`
    if (!groups.has(key)) groups.set(key, { rung: c.rung, cell, claims: [] })
    groups.get(key).claims.push(c)
  }
  const batches = []
  let n = 0
  for (const g of groups.values()) {
    for (let i = 0; i < g.claims.length; i += batchSize) batches.push({ id: `b${++n}`, rung: g.rung, cell: g.cell, claims: g.claims.slice(i, i + batchSize) })
  }
  if (batches.length) await parallel(batches.map(b => () => runBatch(b)))
}

async function critic(all) {
  const est = estUsd(V.criticCell, inAvg * K.verifierInFrac, 0, K, agentOpts('worker', K))
  const why = blocked(est, 'work')
  if (why) { dropped.push({ what: 'completeness critic', count: 1, reason: why }); return [] }
  commit(est, 'work', V.criticCell)
  const summary = {
    units: ledger.units.map(l => ({ id: l.id, outcome: l.outcome, reason: l.reason, uncovered: (unitResults[l.id] && unitResults[l.id].uncovered) || [] })),
    claims: all.map(c => ({ cid: c.cid, severity: c.severity, title: c.title, verdict: c.verdict })),
    dropped,
  }
  const prompt = [
    A.shared || '', '', '## Completeness critic',
    'List what is missing from this run: a scope file left uncovered, a claim left unverified that matters, a source never read, an angle never run. At most 8 items, most important first. Read-only.',
    trimJson(summary, 6000), '', '⟦df:c:1:1⟧',
  ].join('\n')
  const r = await callOnce(prompt, V.criticCell, { label: `critic·${cellKey(V.criticCell)}`, phase: 'Verify', schema: CRITIC, agentType: AT.worker })
  return (r && r.missing) || []
}

let critique = []
if (V.stage !== 'verify') {
  phase('Work')
  await pipeline(V.units, u => runUnit(u))
  const order = new Map(V.units.map((u, i) => [u.id, i]))
  ledger.units.sort((x, y) => order.get(x.id) - order.get(y.id))
  claims.sort((x, y) => (order.get(x.unit) ?? 1e9) - (order.get(y.unit) ?? 1e9) || String(x.cid).localeCompare(String(y.cid)))
  phase('Sweep')
  claims.push(...(await sweep()))
  claims = dedupClaims(claims, A.reduce && A.reduce.dedupKey)
} else {
  claims = (Array.isArray(A.claims) ? A.claims : []).map(c => ({ ...c, verdict: c.verdict === 'PENDING' ? null : c.verdict }))
}
if (V.stage !== 'work') {
  phase('Verify')
  await verify(claims)
  if (A.depth === 'deep') critique = await critic(claims)
} else {
  for (const c of claims) if (!c.verdict) c.verdict = 'PENDING'
}

const numbersByUnit = {}
for (const [id, r] of Object.entries(unitResults)) if (r) numbersByUnit[id] = r.numbers
const invariants = V.stage === 'verify'
  ? (Array.isArray(carry.invariants) ? carry.invariants : [])
  : evalInvariants(A.reduce && A.reduce.invariants, numbersByUnit)
const count = o => ledger.units.filter(l => l.outcome === o).length
const vcount = v => claims.filter(c => c.verdict === v).length
const effSev = c => c.verifiedSeverity || c.severity
const SEV_ORDER = (x, y) => sevRank(effSev(y)) - sevRank(effSev(x)) || (y.blast || 0) - (x.blast || 0)
const digest = {
  counts: {
    units: ledger.units.length, ok: count('ok'), okRerouted: count('ok-rerouted'), okPromoted: count('ok-promoted'),
    brief: count('brief'), unverified: count('unverified'), claims: claims.length, confirmed: vcount('CONFIRMED'),
    plausible: vcount('PLAUSIBLE'), refuted: vcount('REFUTED'), unverifiedClaims: vcount('UNVERIFIED'), pending: vcount('PENDING'),
    rescued: claims.filter(c => c.rescued).length,
    bySeverity: Object.fromEntries(SEVERITIES.map(s => [s, claims.filter(c => effSev(c) === s).length])),
  },
  waiver: V.waiver || null,
  exceptions: ledger.units.filter(l => l.outcome !== 'ok').map(l => ({
    id: l.id, cls: l.outcome, reason: l.reason, cell: (l.attempts[l.attempts.length - 1] || {}).cell || l.p, why: l.why,
  })),
  top: [...claims].sort(SEV_ORDER).slice(0, 15).map(c => {
    const e = (c.evidence || [])[0] || {}
    const support = c.support && c.support.file ? `${c.support.file}:${c.support.line}` : c.support_cmd || null
    return { cid: c.cid, unit: c.unit, severity: c.severity, verifiedSeverity: c.verifiedSeverity || null, title: c.title, verdict: c.verdict, file: e.file || null, line: e.line || null, support }
  }),
  money: {
    U: round2(M.U), P: round2(M.P), R: round2(M.R), C: round2(M.C), parityBound: !!(A.caps && A.caps.parityBound),
    committedUsd: round2(money.committed + money.verifySpent), rerouteUsd: round2(money.rerouteUsd), verifyUsd: round2(money.verifySpent), outputTokens: budget.spent() - out0,
    note: 'estimates from the price model; run scripts/ledger-cost.mjs for actuals. outputTokens counts output only',
  },
  warnings, dropped, invariants, critic: critique,
}
log(`done: ${digest.counts.ok + digest.counts.okRerouted + digest.counts.okPromoted}/${digest.counts.units} units ok, ${ledger.reroutes} re-route(s), ${digest.counts.claims} claim(s): ${digest.counts.confirmed} confirmed / ${digest.counts.refuted} refuted / ${digest.counts.unverifiedClaims} unverified; committed $${digest.money.committedUsd} + reserve used $${digest.money.rerouteUsd}`)
return {
  started: true,
  card,
  digest,
  ledger,
  results: {
    units: unitResults,
    claims: claims.map(c => ({
      cid: c.cid, unit: c.unit, severity: c.severity, verifiedSeverity: c.verifiedSeverity || null, title: c.title, claim: c.claim,
      evidence: c.evidence, rung: c.rung || null, verdict: c.verdict, verdictBy: c.verdictBy || null, reason: c.reason || null,
      counter_quote: c.counter_quote || null, support: c.support || null, support_cmd: c.support_cmd || null, parity: !!c.parity, producer: c.producer || null, bump: c.bump || 0,
      blast: c.blast || 0, floor: Number.isInteger(c.floor) ? c.floor : -1, rescued: c.rescued || null, mergedFrom: c.mergedFrom || null, merged: c.merged || null,
    })),
  },
}
