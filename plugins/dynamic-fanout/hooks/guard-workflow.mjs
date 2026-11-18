#!/usr/bin/env node
// PreToolUse guard for the Workflow tool (0.1.7).
// A hand-written Workflow script runs its agents uncapped on the session model and effort,
// with no outcome check and no escalation; in production runs such agents ran hundreds of
// turns and most of the workflow spend went there. This hook lets a Workflow call through when
// it is one of this plugin's workflows (name 'dynamic-fanout:...'), when the script calls
// workflow('dynamic-fanout:...'), or when it carries `// dynamic-fanout: exempt <reason>`
// (reason of 10+ characters; the exemption is named back to the model). Anything else is
// denied with a reason that points to the skill. Any error fails open: exit 0, no output.
import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'

const DENY_REASON = [
  'This Workflow script bypasses the dynamic-fanout quality loop: its agents run uncapped on the session model and effort, their outcomes go unchecked, and there is no escalation when a result is not good enough.',
  'Route it through /dynamic-fanout:dynamic-fanout instead: fan-out (workflow \'dynamic-fanout:fanout\') for review and research, dynamic-fanout:implement for builds, with quality: \'max\' when quality matters.',
  'Only when the user explicitly wants a plain workflow, add a line `// dynamic-fanout: exempt <reason>` (reason of 10+ characters) to the script.',
].join(' ')

const CALLS_PLUGIN = /\bworkflow\(\s*(['"])dynamic-fanout:[^'"]+\1/
const EXEMPT = /^\s*\/\/\s*dynamic-fanout:\s*exempt\s+(\S.{8,}\S)\s*$/m

// A saved hand-written workflow is called by name: look for its file in the project's and the
// user's .claude/workflows/ and guard it like an inline script. A name that resolves to no file
// there (another plugin's or a built-in workflow) cannot be inspected: let it through, but say so.
function savedWorkflow(name, cwd) {
  if (!/^[\w.-]+$/.test(name)) return null
  for (const dir of [join(cwd, '.claude', 'workflows'), join(homedir(), '.claude', 'workflows')]) {
    for (const ext of ['.js', '.mjs']) {
      const p = join(dir, name + ext)
      if (existsSync(p)) return readFileSync(p, 'utf8')
    }
  }
  return null
}

function decide(input) {
  const ti = (input && input.tool_input) || {}
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd()
  if (typeof ti.name === 'string' && ti.name.startsWith('dynamic-fanout:')) return null
  let script = typeof ti.script === 'string' ? ti.script : null
  if (script === null && typeof ti.scriptPath === 'string' && ti.scriptPath) {
    script = readFileSync(resolve(cwd, ti.scriptPath), 'utf8')
  }
  if (script === null && typeof ti.name === 'string' && ti.name) {
    script = savedWorkflow(ti.name, cwd)
    if (script === null) {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `dynamic-fanout guard: the named workflow '${ti.name}' is not a saved script this guard can read (another plugin's or a built-in workflow), so it was let through unchecked; its agents are not routed, checked or escalated by dynamic-fanout.` } }
    }
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
