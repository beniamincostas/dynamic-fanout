// Loads the plugin's workflow scripts outside the Workflow runtime.
// loadCore(): the pure section of fanout.js (everything above `// @core-end`) as plain functions.
// runFanout(): the whole fanout.js with stubbed agent/parallel/pipeline/phase/log/budget/workflow.
// runWorkflow(): any workflows/<file> the same way, with workflow(name, args) routed to a
//   caller-supplied stub (e.g. implement.js pricing through a real fanout dry run).
// The Function constructors below only ever evaluate this plugin's own workflow files read
// from disk (the same code the Workflow runtime evaluates); no external input reaches them.
import { readFileSync } from 'node:fs'

const bodyOf = file => readFileSync(new URL(`../workflows/${file}`, import.meta.url), 'utf8').replace(/^export const meta\s*=/m, 'const meta =')
const BODY = bodyOf('fanout.js')
const CORE_END = BODY.indexOf('// @core-end')
if (CORE_END < 0) throw new Error('fanout.js has no // @core-end marker')

const CORE_NAMES = [
  'meta', 'MODELS', 'EFFORTS', 'DEFAULT_CALIB', 'PRICE_MODEL', 'UNIT_RESULT', 'calibrate', 'parseVec', 'isParity', 'cellOf', 'cellKey',
  'stronger', 'checksOf', 'estUsd', 'outTok', 'validate', 'price', 'moneyRails', 'buildCard', 'classify', 'toCents',
  'centsStr', 'compareNumbers', 'evalInvariants', 'dedupClaims', 'rungFor', 'mergeVerdicts', 'normalizeVerdict',
  'mergeResults', 'mergeInspections', 'modeText', 'missingFiles', 'pathMatch', 'floorOf', 'turnsFor', 'typeKey', 'agentOpts', 'toScope',
  'verifySizing', 'expectedVerifiers', 'topKExempt', 'DEFAULT_RUNGS',
]

export function loadCore() {
  return new Function(`${BODY.slice(0, CORE_END)}\nreturn { ${CORE_NAMES.join(', ')} }`)()
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

function makeRun(body) {
  const fn = new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', 'workflow', body)
  return async (args, responder, opts = {}) => {
    const calls = []
    const logs = []
    const phases = []
    const workflowCalls = []
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
    const workflow = async (name, a) => {
      workflowCalls.push({ name, args: a })
      return opts.workflowStub ? opts.workflowStub(name, a) : null
    }
    const res = await fn(args, agent, parallel, pipeline, p => phases.push(p), m => logs.push(m), budget, workflow)
    return { res, calls, logs, phases, workflowCalls }
  }
}

const runFanoutBody = makeRun(BODY)

export async function runFanout(args, responder, opts = {}) {
  return runFanoutBody(args, responder, opts)
}

const runners = new Map()

// runWorkflow('implement.js', args, responder, { workflowStub: (name, args) => result, sequential, budget, spent })
export async function runWorkflow(file, args, responder, opts = {}) {
  if (!/^[\w.-]+\.js$/.test(file)) throw new Error(`runWorkflow: expected a file name under workflows/, got ${file}`)
  if (!runners.has(file)) runners.set(file, makeRun(bodyOf(file)))
  return runners.get(file)(args, responder, opts)
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
