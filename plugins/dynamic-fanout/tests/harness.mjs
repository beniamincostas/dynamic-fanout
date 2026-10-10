// Loads workflows/fanout.js outside the Workflow runtime.
// loadCore(): the pure section (everything above `// @core-end`) as plain functions.
// runFanout(): the whole script with stubbed agent/parallel/pipeline/phase/log/budget.
// The Function constructors below only ever evaluate this plugin's own fanout.js read
// from disk (the same code the Workflow runtime evaluates); no external input reaches them.
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../workflows/fanout.js', import.meta.url), 'utf8')
const BODY = SRC.replace(/^export const meta\s*=/m, 'const meta =')
const CORE_END = BODY.indexOf('// @core-end')
if (CORE_END < 0) throw new Error('fanout.js has no // @core-end marker')

const CORE_NAMES = [
  'meta', 'MODELS', 'EFFORTS', 'DEFAULT_CALIB', 'UNIT_RESULT', 'calibrate', 'parseVec', 'isParity', 'cellOf', 'cellKey',
  'stronger', 'checksOf', 'estUsd', 'outTok', 'validate', 'price', 'moneyRails', 'buildCard', 'classify', 'toCents',
  'centsStr', 'compareNumbers', 'evalInvariants', 'dedupClaims', 'rungFor', 'mergeVerdicts', 'normalizeVerdict',
  'mergeResults', 'mergeInspections', 'modeText', 'missingFiles', 'pathMatch', 'floorOf', 'turnsFor', 'typeKey', 'agentOpts', 'toScope',
]

export function loadCore() {
  return new Function(`${BODY.slice(0, CORE_END)}\nreturn { ${CORE_NAMES.join(', ')} }`)()
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

export async function runFanout(args, responder, opts = {}) {
  const fn = new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', 'workflow', BODY)
  const calls = []
  const logs = []
  const agent = async (prompt, o) => {
    calls.push({ prompt, opts: o })
    return responder(prompt, o, calls.length)
  }
  const parallel = async thunks => Promise.all(thunks.map(t => Promise.resolve().then(t).catch(() => null)))
  const runItem = async (stages, it, i) => {
    let r = it
    try {
      for (const s of stages) r = await s(r, it, i)
      return r
    } catch (e) {
      return null
    }
  }
  const pipeline = async (items, ...stages) => {
    if (opts.sequential) {
      const out = []
      for (let i = 0; i < items.length; i++) out.push(await runItem(stages, items[i], i))
      return out
    }
    return Promise.all(items.map((it, i) => runItem(stages, it, i)))
  }
  const budget = opts.budget || { total: null, spent: () => (opts.spent ? opts.spent(calls.length) : 0), remaining: () => Infinity }
  const res = await fn(args, agent, parallel, pipeline, () => {}, m => logs.push(m), budget, async () => null)
  return { res, calls, logs }
}

export const tagOf = prompt => {
  const m = /⟦df:([^⟧]+)⟧\s*$/.exec(prompt)
  return m ? m[1] : null
}

// Default happy-path responses keyed on the cost tag. Override per test.
export function okUnit(extra = {}) {
  return {
    status: 'complete', files_read: [], summary: 'ok', findings: [], confidence: 0.9, assumptions: [], ...extra,
  }
}

export function inspectAll(prompt, found = true) {
  const refs = [...prompt.matchAll(/^(f\d+\.e\d+) \|/gm)].map(m => m[1])
  return { checks: refs.map(ref => ({ ref, found })) }
}

export function verdictAll(prompt, verdict = 'CONFIRMED', extra = {}) {
  const cids = [...prompt.matchAll(/^(\S+) \| (?:info|low|medium|high|blocker) \|/gm)].map(m => m[1])
  return { verdicts: cids.map(cid => ({ cid, verdict, reason: 'stub', ...extra })) }
}
