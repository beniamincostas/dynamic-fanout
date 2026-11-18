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
  assert.equal(priors, '{ work: 1.0, verify: 0.3, inspect: 0.3, sweep: 2.0, implement: 2.0, critic: 0.5 }');
  assert.match(read(REFS, 'economics.md'), /`\{work: 1\.0, verify: 0\.3, inspect: 0\.3, sweep: 2\.0, implement: 2\.0, critic: 0\.5\}`/);
  assert.match(read(REFS, 'economics.md'), /`rerouteRate`[^\n]*0\.2/);
  // 0.1.7: the gap re-run rate behind R
  const gapRate = FANOUT.match(/caps\.gapRate : ([\d.]+)/)[1];
  assert.equal(gapRate, '0.3');
  assert.match(read(REFS, 'economics.md'), new RegExp('`gapRate` defaults to ' + gapRate.replace('.', '\\.')));
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
  assert.match(read(REFS, 'schemas.md'), /reason ≤300, trigger, impact, counter_quote\?/);
  const line = 'Rate by what the code does today, not the worst imaginable case.';
  assert.ok(FANOUT.includes(line));
  for (const f of ['worker', 'worker-ctx', 'worker-mcp', 'skeptic']) {
    const body = read(PLUGIN, 'agents', `${f}.md`);
    assert.ok(body.includes(line), `${f}.md carries the trigger/impact scale`);
    assert.match(body, /^- `trigger`: `normal` = .*`theoretical` = /m, `${f}.md explains trigger in one line`);
    assert.match(body, /^- `impact`: `customer_money_legal` = .*`cosmetic` = /m, `${f}.md explains impact in one line`);
    assert.doesNotMatch(body, /`blocker` — /, `${f}.md has no free severity rubric`);
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
    assert.match(t, /`trigger` \(normal \| edge \| misconfig \| theoretical\)/, f);
    assert.match(t, /OVERSTATED, not\s+REFUTED/, f);
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

test('0.1.7: schemas.md states SEVERITY_MATRIX and the OVERSTATED verdict as the code does', () => {
  const schemas = read(REFS, 'schemas.md');
  const block = FANOUT.match(/const SEVERITY_MATRIX = \{\n([\s\S]*?)\n\}/)[1];
  const rows = [...block.matchAll(/^\s+(\w+): \{ normal: '(\w+)', edge: '(\w+)', misconfig: '(\w+)', theoretical: '(\w+)' \},?$/gm)];
  assert.equal(rows.length, 4);
  for (const [, impact, ...sevs] of rows) assert.ok(schemas.includes(`| ${impact} | ${sevs.join(' | ')} |`), `schemas.md row for ${impact}`);
  const verdicts = FANOUT.match(/const VERDICTS = \[([^\]]+)\]/)[1].replace(/'/g, '').split(', ');
  assert.ok(schemas.includes(`verdict ∈ ${verdicts.join(' | ')}`), 'schemas.md lists the VERDICT enum');
  const skeptic = read(PLUGIN, 'agents', 'skeptic.md');
  assert.match(skeptic, /^\| OVERSTATED \| /m);
  assert.match(SKILL, /OVERSTATED/);
});

test('0.1.7: the skeptic turn cap agrees across fanout.js, the agent files and the docs', () => {
  const cap = FANOUT.match(/caps: \{[^}]*skeptic: (\d+)/)[1];
  assert.equal(cap, '20');
  for (const f of ['skeptic.md', 'skeptic-high.md']) {
    assert.match(read(PLUGIN, 'agents', f), new RegExp('^maxTurns: ' + cap + '$', 'm'), f);
  }
  assert.match(SKILL, new RegExp('skeptic ' + cap + ', inspector'));
  const routing = read(REFS, 'routing.md');
  assert.match(routing, new RegExp('\\| `skeptic` \\| verifiers \\| ' + cap + ' \\|'));
  assert.match(routing, new RegExp('skeptic call \\(' + cap + ' turns'));
});

test('0.1.7: docs state the verification-capacity defaults', () => {
  const strong = FANOUT.match(/const MAX_STRONG_BATCH = (\d+)/)[1];
  const routing = read(REFS, 'routing.md');
  for (const t of [SKILL, routing]) {
    assert.match(t, /max\(DEFAULT_TOPK\[depth\], ceil\(0\.5 ×/);
    assert.match(t, new RegExp('V3/V4 batches hold at most ' + strong + ' claims'));
  }
  assert.match(routing, /verifier failed twice \(infra\)/);
  assert.match(FANOUT, /'verifier failed twice \(infra\)'/);
});

test('0.1.7: worker and implementer bodies forbid citing scratchpad copies', () => {
  const dir = path.join(PLUGIN, 'agents');
  for (const f of fs.readdirSync(dir).filter(f => /^(worker|implementer)/.test(f))) {
    assert.match(read(dir, f), /never cite a scratchpad or temp copy/, f);
  }
});

test('0.1.7: SKILL.md states the stats quality rule, --also and repeated --ledger as stats.mjs implements them', async () => {
  const st = await import('../scripts/stats.mjs');
  const q = st.QUALITY;
  assert.match(SKILL, new RegExp(`PROMOTE QUALITY\` \\(n ≥ ${q.promoteN} and refuted\\+overstated ≥ ${q.refutedOverstated * 100}% or gap rate ≥ ${q.gapRate * 100}%\\)`));
  assert.match(SKILL, /--also <verify-output>\.audited\.json/);
  assert.match(SKILL, /one `--ledger` per stage/);
  const src = read(PLUGIN, 'scripts', 'stats.mjs');
  assert.match(src, /t === '--also'/);
  assert.match(src, /a\.ledgers\.push/);
});

test('0.1.7 docs: the implement review is three lenses priced at 3x the reviewer, with one repair round', () => {
  const IMPL = read(PLUGIN, 'workflows', 'implement.js');
  const factor = IMPL.match(/const REVIEW_FACTOR = ([\d.]+)/)[1];
  const lenses = (IMPL.match(/const REVIEW_LENSES = \[([\s\S]*?)\n\]/)[1].match(/id: '[A-Z]'/g) || []).length;
  assert.equal(lenses, 3);
  const pb = read(REFS, 'playbooks', 'implement.md');
  assert.match(pb, new RegExp('`' + lenses + ' × ' + factor.replace('.', '\\.') + ' × max\\(theme estimate\\)`'));
  assert.match(pb, /repair round/);
  assert.match(pb, /acceptanceCmd/);
  assert.match(pb, /review returned no text/);
  for (const l of ['boundaries and time', 'inputs and data', 'privacy and test integrity']) {
    assert.match(pb, new RegExp(l), l);
    assert.match(SKILL, new RegExp(l), l);
  }
  const rv = read(PLUGIN, 'agents', 'reviewer.md');
  assert.match(rv, /Themes to repair:/);
  assert.match(rv, /acceptance command/);
});

test('0.1.7 docs: SKILL.md states the orchestrator job, audit basis, critic, quality profile and guard hook', () => {
  assert.match(SKILL, /check(s)? (the|each) outcome/i);
  assert.match(SKILL, /escalat\w+ once/i);
  assert.match(SKILL, /11%/);
  assert.match(SKILL, /33%/);
  assert.match(SKILL, /recall-critical/);
  assert.match(SKILL, /gap re-run/);
  assert.match(SKILL, /OVERSTATED/);
  assert.match(SKILL, /trigger.*impact/);
  assert.match(SKILL, /QUALITY table/);
  // the quality profile, with the numbers fanout.js uses
  assert.match(SKILL, /`--quality max`/);
  assert.match(FANOUT, /a\.quality === 'max' \? 0\.9 : 0\.5/);
  assert.match(FANOUT, /quality === 'max' \? 2 :/);
  assert.match(FANOUT, /a\.quality === 'max' \? \{ medium: 'V3' \}/);
  assert.match(SKILL, /quality: 'max'[^\n]*`lenses: 2`[^\n]*medium→V3[^\n]*no topK[^\n]*critic on every unit[^\n]*batch(es)? of 2[^\n]*0\.9·U/);
  // the guard hook
  assert.match(SKILL, /guard-workflow\.mjs/);
  assert.match(SKILL, /\/\/ dynamic-fanout: exempt <reason>/);
  assert.match(SKILL, /every Workflow script/i);
});

test('0.1.7 docs: references, playbooks, README and CHANGELOG mirror the code', () => {
  const routing = read(REFS, 'routing.md');
  const workflow = read(REFS, 'workflow.md');
  const schemas = read(REFS, 'schemas.md');
  const econ = read(REFS, 'economics.md');
  for (const [name, doc] of [['routing', routing], ['workflow', workflow], ['economics', econ]]) {
    assert.match(doc, /quality: 'max'/, name);
    assert.match(doc, /critic/, name);
  }
  assert.match(schemas, /UNIT_CRITIC/);
  assert.match(schemas, /coverage/);
  // skeptic cap is the agent file's maxTurns (20), not the old 12
  const cap = read(PLUGIN, 'agents', 'skeptic.md').match(/maxTurns: (\d+)/)[1];
  assert.equal(cap, '20');
  assert.match(econ, new RegExp('skeptic ' + cap));
  assert.match(econ, new RegExp('skeptic: ' + cap));
  assert.match(workflow, new RegExp('skeptic cap \\(' + cap + '\\)'));
  assert.doesNotMatch(workflow, /skeptic cap \(12\)/);
  assert.doesNotMatch(econ, /skeptic 12\b|skeptic: 12\b/);
  for (const pb of ['review', 'research', 'implement', 'design']) {
    assert.match(read(REFS, 'playbooks', pb + '.md'), /quality: 'max'|dynamic-fanout: exempt/, pb);
  }
  assert.match(read(REFS, 'playbooks', 'implement.md'), /dynamic-fanout: exempt/);
  const readme = read(REPO, 'README.md');
  assert.match(readme, /### 0\.1\.7/);
  assert.match(readme, /guard/);
  const log = read(REPO, 'CHANGELOG.md');
  assert.match(log, /^## dynamic-fanout 0\.1\.7/m);
  assert.ok(fs.existsSync(path.join(PLUGIN, 'hooks', 'hooks.json')));
});
