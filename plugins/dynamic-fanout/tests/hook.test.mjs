// The PreToolUse guard on the Workflow tool (hooks/guard-workflow.mjs), spawned with fixture input.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOOK = fileURLToPath(new URL('../hooks/guard-workflow.mjs', import.meta.url))
const run = (input) => {
  const r = spawnSync(process.execPath, [HOOK], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' })
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
