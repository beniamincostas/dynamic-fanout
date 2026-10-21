// Docs-vs-code consistency: the skill and its references must describe the code as built.
// Run: node --test plugins/dynamic-fanout/tests/docs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(HERE, '..');
const REPO = path.join(PLUGIN, '..', '..');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const SKILL = read(PLUGIN, 'skills', 'dynamic-fanout', 'SKILL.md');
const REFS = path.join(PLUGIN, 'skills', 'dynamic-fanout', 'references');
const FANOUT = read(PLUGIN, 'workflows', 'fanout.js');

test('plugin.json version matches the newest CHANGELOG entry', () => {
  const version = JSON.parse(read(PLUGIN, '.claude-plugin', 'plugin.json')).version;
  const top = read(REPO, 'CHANGELOG.md').match(/^## dynamic-fanout (\d+\.\d+\.\d+)/m);
  assert.ok(top, 'CHANGELOG has a version heading');
  assert.equal(top[1], version);
});

test('SKILL.md states the medium rung fanout.js defaults to', () => {
  const medium = FANOUT.match(/const DEFAULT_RUNGS = \{[^}]*medium: '(V\d)'/)[1];
  assert.match(SKILL, new RegExp('`medium` defaults to \\*\\*' + medium + '\\*\\*'));
  assert.match(SKILL, new RegExp('medium→' + medium));
  assert.doesNotMatch(read(REFS, 'routing.md'), /medium[^\n]{0,40}defaults? to \*\*V1\*\*/);
});

test('SKILL.md wires the 0.1.4 scripts into scouting and close', () => {
  assert.match(SKILL, /claude-md-chain\.mjs/);
  assert.match(SKILL, /scripts\/report\.mjs <output-file>\.audited\.json/);
  assert.match(SKILL, /"pm"/);
});

test('economics.md carries the calibration card for the current price model', () => {
  const pm = FANOUT.match(/const PRICE_MODEL = (\d+)/)[1];
  const econ = read(REFS, 'economics.md');
  assert.match(econ, new RegExp('[Pp]rice model ' + pm));
  for (const k of ['baseCtxLean', 'readFactor', 'sweepInFrac', 'verifierInFrac']) {
    const v = FANOUT.match(new RegExp('\\n  ' + k + ': ([\\d.]+)'))[1];
    assert.match(econ, new RegExp('`' + k + '` \\| ' + v.replace('.', '\\.') + ' '), `${k} ${v} in economics.md`);
  }
});

test('workflow.md and schemas.md document VERDICT support and the new scripts', () => {
  for (const f of ['workflow.md', 'schemas.md']) {
    const t = read(REFS, f);
    assert.match(t, /support_cmd/, `${f} support_cmd`);
    assert.match(t, /calib[^\n]*pm/, `${f} calib.pm`);
  }
  const wf = read(REFS, 'workflow.md');
  assert.match(wf, /report\.mjs/);
  assert.match(wf, /claude-md-chain\.mjs/);
});

test('0.1.5 defaults: rerouteRate 0.2 and the role priors are stated in the docs', () => {
  const rate = FANOUT.match(/caps\.rerouteRate : ([\d.]+)/)[1];
  assert.equal(rate, '0.2');
  assert.match(read(REFS, 'routing.md'), new RegExp('instead of ' + rate.replace('.', '\\.')));
  const priors = FANOUT.match(/\n  scaleByRole: (\{[^}]*\})/)[1];
  assert.equal(priors, '{ work: 1.0, verify: 0.3, inspect: 0.3, sweep: 2.0, implement: 2.0 }');
  assert.match(read(REFS, 'economics.md'), /`\{work: 1\.0, verify: 0\.3, inspect: 0\.3, sweep: 2\.0, implement: 2\.0\}`/);
  assert.match(read(REFS, 'economics.md'), /`rerouteRate`[^\n]*0\.2/);
  // Every scaleByRole object literal in economics.md (the defaults block included) states the code's priors.
  for (const m of read(REFS, 'economics.md').matchAll(/scaleByRole: (\{[^}]*\})/g)) assert.equal(m[1], priors, 'economics.md scaleByRole block');
});

test('0.1.5 defaults: findings cap, inspector quotes, mediumsPerUnit and VERDICT severity are stated in the docs', () => {
  const cap = FANOUT.match(/findings: \{\n\s+type: 'array', maxItems: (\d+)/)[1];
  assert.equal(cap, '15');
  assert.match(FANOUT, new RegExp(`at most ${cap} findings`));
  assert.match(read(REFS, 'schemas.md'), new RegExp('`findings` \\| ≤' + cap + ' ×'));
  assert.match(read(REFS, 'playbooks', 'review.md'), new RegExp('≤' + cap + ' findings'));
  for (const f of ['worker', 'worker-ctx', 'worker-mcp']) {
    assert.match(read(PLUGIN, 'agents', `${f}.md`), new RegExp(`At most ${cap} findings`), f);
  }
  const quotes = FANOUT.match(/const MAX_INSPECT_QUOTES = (\d+)/)[1];
  assert.match(read(REFS, 'workflow.md'), new RegExp('≤' + quotes + ' quotes per'));
  const mpu = FANOUT.match(/\n  mediumsPerUnit: (\d+)/)[1];
  assert.match(read(REFS, 'economics.md'), new RegExp('`mediumsPerUnit: ' + mpu + '`'));
  assert.match(read(REFS, 'economics.md'), new RegExp('mediumsPerUnit: ' + mpu + '\\n'));
  assert.match(read(REFS, 'schemas.md'), /reason ≤300, severity, counter_quote\?/);
  const line = 'Rate by what the code does today, not the worst imaginable case; most findings are medium or low.';
  assert.ok(FANOUT.includes(line));
  for (const f of ['worker', 'worker-ctx', 'worker-mcp', 'skeptic']) {
    assert.ok(read(PLUGIN, 'agents', `${f}.md`).includes(line), `${f}.md carries the severity rubric`);
  }
});

test('SKILL.md has no "$" followed by a digit (positional $N argument substitution mangles it)', () => {
  assert.doesNotMatch(SKILL, /\$\d/);
  assert.match(SKILL, /USD 40\.53/);
});

test('0.1.5 docs: master overhead line, recall rule, lenses, waiver, wrapper pattern, implement role', () => {
  assert.match(SKILL, /^master: /m, 'run card has a master: line');
  assert.match(SKILL, /\/compact/);
  assert.match(SKILL, /43%/);
  for (const t of [SKILL, read(REFS, 'routing.md')]) {
    assert.match(t, /[Rr]ecall rule/);
    assert.match(t, /lenses: 2/);
    assert.match(t, /verify\.waiver/);
    assert.match(t, /rerouteRate[^\n]*0\.2/);
  }
  const wf = read(REFS, 'workflow.md');
  assert.match(wf, /`lenses`/);
  assert.match(wf, /verify\.waiver/);
  assert.match(wf, /await workflow\('dynamic-fanout:fanout', ARGS\)/);
  assert.match(wf, /scriptPath/);
  for (const f of ['review.md', 'research.md']) {
    const t = read(REFS, 'playbooks', f);
    assert.match(t, /lenses: 2/, f);
    assert.match(t, /[Rr]ecall rule/, f);
    assert.match(t, /most findings are medium or low/, f);
  }
  const impl = read(REFS, 'playbooks', 'implement.md');
  assert.match(impl, /`implement`[^\n]*2\.0/);
  assert.match(impl, /calib/);
  assert.match(read(REFS, 'economics.md'), /implement[^\n]*2\.0/);
});

test('SKILL.md names every playbook, so a new one is reachable', () => {
  for (const f of fs.readdirSync(path.join(REFS, 'playbooks'))) {
    if (f.endsWith('.md') && !['research.md', 'review.md', 'data.md', 'implement.md'].includes(f)) {
      assert.match(SKILL, new RegExp('playbooks/' + f.replace('.', '\\.')), f);
    }
  }
  assert.match(SKILL, /not checked out at the session cwd/);
});
