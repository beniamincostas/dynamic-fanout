#!/usr/bin/env node
// PreToolUse guard for the Workflow tool (0.1.7).
// A hand-written Workflow script runs its agents uncapped on the session model and effort,
// with no outcome check and no escalation; in production runs such agents ran hundreds of
// turns and most of the workflow spend went there. This hook lets a Workflow call through when
// it is one of this plugin's workflows (name 'dynamic-fanout:...'), when the script calls
// workflow('dynamic-fanout:...'), or when it carries `// dynamic-fanout: exempt <reason>`
// (reason of 10+ characters; the exemption is named back to the model). Anything else is
// denied with a reason that points to the skill. Any error fails open: exit 0, no output.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const DENY_REASON = [
  'This Workflow script bypasses the dynamic-fanout quality loop: its agents run uncapped on the session model and effort, their outcomes go unchecked, and there is no escalation when a result is not good enough.',
  'Route it through /dynamic-fanout:dynamic-fanout instead: fan-out (workflow \'dynamic-fanout:fanout\') for review and research, dynamic-fanout:implement for builds, with quality: \'max\' when quality matters.',
  'Only when the user explicitly wants a plain workflow, add a line `// dynamic-fanout: exempt <reason>` (reason of 10+ characters) to the script.',
].join(' ')

const CALLS_PLUGIN = /\bworkflow\(\s*(['"])dynamic-fanout:[^'"]+\1/
const EXEMPT = /^\s*\/\/\s*dynamic-fanout:\s*exempt\s+(\S.{8,}\S)\s*$/m

function decide(input) {
  const ti = (input && input.tool_input) || {}
  if (typeof ti.name === 'string' && ti.name.startsWith('dynamic-fanout:')) return null
  let script = typeof ti.script === 'string' ? ti.script : null
  if (script === null && typeof ti.scriptPath === 'string' && ti.scriptPath) {
    script = readFileSync(resolve(typeof input.cwd === 'string' ? input.cwd : process.cwd(), ti.scriptPath), 'utf8')
  }
  if (script === null) return null
  if (CALLS_PLUGIN.test(script)) return null
  const ex = EXEMPT.exec(script)
  if (ex) {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `dynamic-fanout guard: this Workflow is exempt from the quality loop (${ex[1].trim()}); its agents are not routed, checked or escalated.` } }
  }
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: DENY_REASON } }
}

try {
  const raw = readFileSync(0, 'utf8')
  const out = decide(JSON.parse(raw))
  if (out) process.stdout.write(JSON.stringify(out))
} catch {
  // fail open
}
process.exit(0)
