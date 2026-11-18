// The PreToolUse guard on the Workflow tool (hooks/guard-workflow.mjs), spawned with fixture input.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOOK = fileURLToPath(new URL('../hooks/guard-workflow.mjs', import.meta.url))
const run = (input, env = {}) => {
  const base = { ...process.env }; delete base.CLAUDE_PROJECT_DIR
  const r = spawnSync(process.execPath, [HOOK], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: { ...base, ...env } })
  return { code: r.status, out: r.stdout.trim(), json: r.stdout.trim() ? JSON.parse(r.stdout) : null }
}
const wf = (tool_input) => ({ hook_event_name: 'PreToolUse', tool_name: 'Workflow', tool_input })

test('hooks.json wires the guard on PreToolUse for the Workflow tool', () => {
  const h = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'))
  const entry = h.hooks.PreToolUse.find(e => e.matcher === 'Workflow')
  assert.ok(entry, 'a PreToolUse entry matching Workflow')
  assert.match(entry.hooks[0].command, /node .*\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/guard-workflow\.mjs/)
})

test('guard allows the plugin\'s own workflows silently', () => {
  for (const input of [
    wf({ name: 'dynamic-fanout:fanout' }),
    wf({ script: "const r = await workflow('dynamic-fanout:fanout', args)" }),
    wf({ script: 'await workflow("dynamic-fanout:implement", { units })' }),
  ]) {
    const r = run(input)
    assert.equal(r.code, 0)
    assert.equal(r.out, '', 'no output on a plain allow')
  }
})

test('guard reads scriptPath', () => {
  const dir = mkdtempSync(join(tmpdir(), 'df-hook-'))
  const ok = join(dir, 'ok.js'); writeFileSync(ok, "await workflow('dynamic-fanout:fanout', a)\n")
  const bad = join(dir, 'bad.js'); writeFileSync(bad, "await agent('review everything')\n")
  assert.equal(run(wf({ scriptPath: ok })).out, '')
  assert.equal(run(wf({ scriptPath: bad })).json.hookSpecificOutput.permissionDecision, 'deny')
})

test('guard denies a hand-written workflow and says why and what to use', () => {
  const r = run(wf({ script: "const a = await agent('build the feature')\nconst b = await agent('review it')" }))
  assert.equal(r.code, 0)
  const o = r.json.hookSpecificOutput
  assert.equal(o.hookEventName, 'PreToolUse')
  assert.equal(o.permissionDecision, 'deny')
  for (const re of [/bypasses the dynamic-fanout quality loop/, /uncapped/, /session model and effort/, /unchecked/, /no escalation/,
    /\/dynamic-fanout:dynamic-fanout/, /dynamic-fanout:implement/, /quality: 'max'/, /\/\/ dynamic-fanout: exempt <reason>/]) {
    assert.match(o.permissionDecisionReason, re)
  }
  // a different plugin's workflow name is not an allow
  assert.equal(run(wf({ name: 'other:thing', script: "await agent('x')" })).json.hookSpecificOutput.permissionDecision, 'deny')
})

test('exempt marker allows with additionalContext; a short reason does not count', () => {
  const r = run(wf({ script: "// dynamic-fanout: exempt user asked for a plain two-agent pipeline\nawait agent('x')" }))
  assert.equal(r.code, 0)
  assert.equal(r.json.hookSpecificOutput.permissionDecision, undefined)
  assert.match(r.json.hookSpecificOutput.additionalContext, /exempt.*user asked for a plain two-agent pipeline/)
  assert.equal(run(wf({ script: "// dynamic-fanout: exempt short\nawait agent('x')" })).json.hookSpecificOutput.permissionDecision, 'deny')
})

test('guard fails open on bad input', () => {
  for (const input of ['', 'not json', JSON.stringify({ tool_input: { scriptPath: '/nonexistent/df-hook.js' } }), JSON.stringify({})]) {
    const r = run(input)
    assert.equal(r.code, 0)
    assert.equal(r.out, '')
  }
})

test('guard: a saved hand-written workflow called by name is read and guarded like a script', () => {
  const dir = mkdtempSync(join(tmpdir(), 'df-hook-name-'))
  const wfd = join(dir, '.claude', 'workflows')
  require_mkdir(wfd)
  writeFileSync(join(wfd, 'my-review.js'), "await agent('review everything')\n")
  writeFileSync(join(wfd, 'routed.js'), "await workflow('dynamic-fanout:fanout', a)\n")
  const denied = run({ ...wf({ name: 'my-review' }), cwd: dir })
  assert.equal(denied.json.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(run({ ...wf({ name: 'routed' }), cwd: dir }).out, '')
})

test('guard: a named workflow it cannot read (another plugin, built-in) passes with a note, never silently', () => {
  const dir = mkdtempSync(join(tmpdir(), 'df-hook-name-'))
  const r = run({ ...wf({ name: 'other-plugin:thing' }), cwd: dir })
  assert.equal(r.code, 0)
  assert.equal(r.json.hookSpecificOutput.permissionDecision, undefined)
  assert.match(r.json.hookSpecificOutput.additionalContext, /could not|not a saved script/)
})

function require_mkdir(p) { mkdirSync(p, { recursive: true }) }

test('guard: a saved workflow is found by its meta.name, the name the Workflow tool registers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'df-hook-meta-'))
  const wfd = join(dir, '.claude', 'workflows'); require_mkdir(wfd)
  writeFileSync(join(wfd, 'fileA.js'), "export const meta = { name: 'nameB', description: 'x' }\nawait agent('review everything')\n")
  writeFileSync(join(wfd, 'fileC.js'), "export const meta = { name: 'routedC', description: 'x' }\nawait workflow('dynamic-fanout:fanout', a)\n")
  assert.equal(run({ ...wf({ name: 'nameB' }), cwd: dir }).json.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(run({ ...wf({ name: 'routedC' }), cwd: dir }).out, '')
  // The file name is not a registered name when the file has a meta name: nothing to guard, a note.
  assert.match(run({ ...wf({ name: 'fileA' }), cwd: dir }).json.hookSpecificOutput.additionalContext, /not a saved script/)
})

test('guard: saved workflows are looked up in the project root too, after a cd', () => {
  const proj = mkdtempSync(join(tmpdir(), 'df-hook-proj-'))
  const wfd = join(proj, '.claude', 'workflows'); require_mkdir(wfd)
  writeFileSync(join(wfd, 'r.js'), "export const meta = { name: 'proj-review', description: 'x' }\nawait agent('review')\n")
  const sub = join(proj, 'sub'); require_mkdir(sub)
  const r = run({ ...wf({ name: 'proj-review' }), cwd: sub }, { CLAUDE_PROJECT_DIR: proj })
  assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny')
})

test('guard: inputs are checked in the order the Workflow tool runs them (scriptPath, script, name)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'df-hook-order-'))
  const bad = join(dir, 'plain.js'); writeFileSync(bad, "await agent('review everything')\n")
  const deny = i => assert.equal(run(wf(i)).json.hookSpecificOutput.permissionDecision, 'deny', JSON.stringify(i))
  deny({ name: 'dynamic-fanout:fanout', scriptPath: bad })
  deny({ script: "await workflow('dynamic-fanout:fanout', a)", scriptPath: bad })
  deny({ name: 'dynamic-fanout:fanout', script: "await agent('x')" })
})

test('guard: a commented-out plugin call does not count; a template-literal call does', () => {
  const deny = s => assert.equal(run(wf({ script: s })).json.hookSpecificOutput.permissionDecision, 'deny', s)
  deny("// was: await workflow('dynamic-fanout:fanout', a)\nawait agent('review everything')\n")
  deny("/* old:\nawait workflow('dynamic-fanout:fanout', a)\n*/\nawait agent('review everything')\n")
  assert.equal(run(wf({ script: 'await workflow(`dynamic-fanout:fanout`, args)' })).out, '')
  assert.equal(run(wf({ script: "const r = await workflow('dynamic-fanout:fanout', args) // routed" })).out, '')
})
