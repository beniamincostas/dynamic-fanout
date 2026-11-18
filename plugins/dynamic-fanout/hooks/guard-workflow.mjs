#!/usr/bin/env node
// PreToolUse guard for the Workflow tool (0.1.7).
// A hand-written Workflow script runs its agents uncapped on the session model and effort,
// with no outcome check and no escalation; in production runs such agents ran hundreds of
// turns and most of the workflow spend went there. This hook lets a Workflow call through when
// it is one of this plugin's workflows (name 'dynamic-fanout:...'), when the script calls
// workflow('dynamic-fanout:...'), or when it carries `// dynamic-fanout: exempt <reason>`
// (reason of 10+ characters; the exemption is named back to the model). Anything else is
// denied with a reason that points to the skill. Any error fails open: exit 0, no output.
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'

const DENY_REASON = [
  'This Workflow script bypasses the dynamic-fanout quality loop: its agents run uncapped on the session model and effort, their outcomes go unchecked, and there is no escalation when a result is not good enough.',
  'Route it through /dynamic-fanout:dynamic-fanout instead: fan-out (workflow \'dynamic-fanout:fanout\') for review and research, dynamic-fanout:implement for builds, with quality: \'max\' when quality matters.',
  'Only when the user explicitly wants a plain workflow, add a line `// dynamic-fanout: exempt <reason>` (reason of 10+ characters) to the script.',
].join(' ')

const CALLS_PLUGIN = /\bworkflow\(\s*(['"`])dynamic-fanout:[^'"`]+\1/
const EXEMPT = /^\s*\/\/\s*dynamic-fanout:\s*exempt\s+(\S.{8,}\S)\s*$/m
const META_NAME = /export\s+const\s+meta\s*=\s*\{[\s\S]*?\bname\s*:\s*(['"`])([^'"`]+)\1/

// A commented-out plugin call does not route anything: whole-line // comments and /* */ blocks
// that start a line are removed before the plugin-call test (the exempt marker is read from the
// original script).
function code(src) {
  return src.replace(/^\s*\/\*[\s\S]*?\*\//gm, '').replace(/^\s*\/\/.*$/gm, '')
}

// A saved workflow is registered under its meta.name, not its file name (a file fileA.js with
// meta.name 'nameB' runs as 'nameB'; 'fileA' is "not found"). Look in the project's (the
// project root, and the current directory after a cd) and the user's .claude/workflows/ for the
// file whose meta.name is the called name; a file without a meta name counts under its basename.
// A name that resolves to no file there (another plugin's or a built-in workflow) cannot be
// inspected: let it through, but say so.
function savedWorkflow(name, cwd) {
  const roots = [process.env.CLAUDE_PROJECT_DIR, cwd].filter(r => typeof r === 'string' && r)
  const dirs = [...new Set([...roots.map(r => join(r, '.claude', 'workflows')), join(homedir(), '.claude', 'workflows')])]
  let byFile = null
  for (const dir of dirs) {
    let files
    try { files = readdirSync(dir).filter(f => /\.m?js$/.test(f)).sort() } catch { continue }
    for (const f of files) {
      let src
      try { src = readFileSync(join(dir, f), 'utf8') } catch { continue }
      const m = META_NAME.exec(src)
      if (m && m[2] === name) return src
      if (!m && byFile === null && f.replace(/\.m?js$/, '') === name) byFile = src
    }
  }
  return byFile
}

function decide(input) {
  const ti = (input && input.tool_input) || {}
  const cwd = input && typeof input.cwd === 'string' ? input.cwd : process.cwd()
  // The Workflow tool runs scriptPath first, then script, then name, so a script given next to a
  // plugin name is what runs and is what gets guarded.
  let script = null
  if (typeof ti.scriptPath === 'string' && ti.scriptPath) script = readFileSync(resolve(cwd, ti.scriptPath), 'utf8')
  else if (typeof ti.script === 'string') script = ti.script
  else if (typeof ti.name === 'string' && ti.name) {
    if (ti.name.startsWith('dynamic-fanout:')) return null
    script = savedWorkflow(ti.name, cwd)
    if (script === null) {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `dynamic-fanout guard: the named workflow '${ti.name}' is not a saved script this guard can read (another plugin's or a built-in workflow), so it was let through unchecked; its agents are not routed, checked or escalated by dynamic-fanout.` } }
    }
  }
  if (script === null) return null
  if (CALLS_PLUGIN.test(code(script))) return null
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
