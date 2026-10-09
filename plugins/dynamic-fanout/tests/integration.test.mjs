// End-to-end: run the real foreman (workflows/fanout.js via tests/harness.mjs) on realistic
// scenarios, wrap its RESULT the way the Workflow tool's output file does
// ({summary, agentCount, logs, result}), then feed that file to the close-step scripts
// exactly as SKILL.md §7 runs them: check-evidence --write, then stats update on the
// audited file, then stats --summary. Guards against the scripts assuming a shape the
// foreman does not produce (e.g. ledger.units[].p is already a cell string).
// Run: node --test plugins/dynamic-fanout/tests/integration.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runFanout, tagOf, okUnit, inspectAll } from './harness.mjs';
import * as ce from '../scripts/check-evidence.mjs';
import * as st from '../scripts/stats.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, 'fixtures', 'integration', 'repo');
const SCRIPTS = path.join(HERE, '..', 'scripts');
const RANK = { CONFIRMED: 3, REFUTED: 3, PLAUSIBLE: 2, UNVERIFIABLE: 1, UNVERIFIED: 1, PENDING: 0 };

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'df-integration-'));
const cli = (script, args) => spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { encoding: 'utf8' });

const ev = (file, line, quote) => ({ file, line, quote });
const finding = (title, severity, evidence) => ({ title, severity, claim: `${title}.`, evidence });

/** The Workflow tool's output file around the script's return value. */
function workflowOutput(run) {
  return { summary: 'fanout finished', agentCount: run.calls.length, logs: run.logs, result: run.res };
}

/** Writes the output file, runs the three close-step commands, returns everything. */
function close(run, kind) {
  const dir = tmpDir();
  const outFile = path.join(dir, 'output.json');
  const audited = `${outFile}.audited.json`;
  const statsFile = path.join(dir, 'stats', 'routing-stats.json');
  fs.writeFileSync(outFile, JSON.stringify(workflowOutput(run), null, 2));

  const json = cli('check-evidence.mjs', [outFile, '--root', REPO, '--json']);
  assert.equal(json.status, 0, json.stderr);
  const write = cli('check-evidence.mjs', [outFile, '--root', REPO, '--write', audited]);
  assert.equal(write.status, 0, write.stderr);
  const upd = cli('stats.mjs', ['update', audited, '--file', statsFile, '--kind', kind]);
  assert.equal(upd.status, 0, upd.stderr + upd.stdout);
  const sum = cli('stats.mjs', ['--summary', kind, '--file', statsFile]);
  assert.equal(sum.status, 0, sum.stderr);
  return {
    report: JSON.parse(json.stdout),
    auditText: write.stdout,
    audited: JSON.parse(fs.readFileSync(audited, 'utf8')),
    updText: upd.stdout,
    stats: JSON.parse(fs.readFileSync(statsFile, 'utf8')),
    summary: sum.stdout,
    statsFile,
    outFile,
  };
}

function assertDowngradeOnly(before, after) {
  const was = new Map(before.map((c) => [c.cid, c.verdict]));
  for (const c of after) {
    const from = was.get(c.cid);
    assert.ok(RANK[c.verdict] <= RANK[from], `${c.cid}: ${from} -> ${c.verdict} is an upgrade`);
    if (from === 'REFUTED' && c.verdict !== 'REFUTED') assert.ok(['PLAUSIBLE', 'UNVERIFIED'].includes(c.verdict));
  }
}

const SESSION = { S: 'opus', W: 'opus', refEffort: 'xhigh', refSource: 'test', allowUp: false };
const SON_MED = { model: 'sonnet', effort: 'medium' };
const OPUS_HIGH = { effort: 'high' }; // model defaults to S (opus)

// ───────────────────────── scenario 1: review ─────────────────────────

function reviewArgs() {
  const u = (id, over) => ({
    id, role: 'review', vec: 'D2 A1 T1 C1 V1 B1 G1', in: 20000, ctx: 'omit', p: SON_MED, fb: OPUS_HIGH,
    check: 'quote', why: 'C1: every finding is checkable by its quote', brief: `review ${id}`, ...over,
  });
  return {
    v: 2, kind: 'review', depth: 'standard', confirmed: true,
    session: SESSION,
    shared: 'Review the invoice/payment fixture for correctness bugs.',
    ultra: { agents: 8, verifiers: 3, ctxTok: 20000, inAvg: 30000, basis: 'test: 4 review slices' },
    units: [
      u('r1', { scope: { files: ['src/invoice.py'] } }),
      u('r2', { scope: { files: ['src/payments.py'] } }),
      u('r3', { vec: 'D1 A0 T1 C0 V2 B1 G0', p: { model: 'sonnet', effort: 'low' }, fb: SON_MED, check: 'set',
        why: 'V2: the list of constants is a set check', scope: { files: ['src/payments.py'] } }),
      u('r4', { scope: { files: ['src/invoice.py'] } }),
    ],
    verify: { cells: { V3: { effort: 'high' } } },
    sweep: { rounds: 1 },
    caps: { pauseUsd: 100 },
  };
}

const COUNTER = ev('src/invoice.py', 14, 'raise ValueError("discount above 100%")');

function reviewResponder(prompt) {
  const tag = tagOf(prompt);
  if (tag.startsWith('i:')) return inspectAll(prompt, true);
  if (tag.startsWith('v:')) {
    const cids = [...prompt.matchAll(/^(\S+) \| (?:info|low|medium|high|blocker) \|/gm)].map((m) => m[1]);
    return { verdicts: cids.map((cid) => (cid === 'r1.f2'
      ? { cid, verdict: 'REFUTED', reason: 'pct > 100 raises right below', counter_quote: COUNTER }
      : { cid, verdict: 'CONFIRMED', reason: 'read it' })) };
  }
  if (tag === 's:1:1') {
    return okUnit({ files_read: ['src/invoice.py'], findings: [
      finding('VAT is derived from gross with a float-free Decimal', 'low', [ev('src/invoice.py', 8, 'vat = gross * VAT_RATE / (1 + VAT_RATE)')]),
    ] });
  }
  if (tag.startsWith('s:')) return okUnit();
  switch (tag) {
    case 'r1:1':
      return okUnit({ files_read: ['src/invoice.py'], confidence: 0.9, findings: [
        finding('is_overdue treats the due date itself as overdue', 'high', [ev('src/invoice.py', 19, 'return invoice.due_date <= today')]),
        finding('apply_discount accepts a discount above 100%', 'medium', [ev('src/invoice.py', 13, 'if pct > 100:')]),
      ] });
    case 'r2:1':
      return okUnit({ status: 'blocked', blocked_reason: 'too_hard', files_read: ['src/payments.py'], confidence: 0.3 });
    case 'r2:2': // the one capability re-route, on fb opus·high
      return okUnit({ files_read: ['src/payments.py'], confidence: 0.8, findings: [
        finding('settle lets open_cents go negative before flagging overpaid', 'high', [ev('src/payments.py', 14, 'invoice.open_cents -= payment.amount_cents')]),
      ] });
    case 'r3:1': // passes the gate (no inspector on a set check) with quotes that do not exist where cited
      return okUnit({ files_read: ['src/payments.py'], confidence: 0.9, findings: [
        finding('tolerance is five cents, so short payments settle', 'medium', [ev('src/payments.py', 3, 'TOLERANCE_CENTS = 5')]),
        finding('match compares reference to invoice number', 'low', [ev('src/payments.py', 12, 'if payment.reference == inv.number:')]),
      ] });
    case 'r4:1':
      return okUnit({ files_read: ['src/invoice.py'], confidence: 0.9, findings: [
        finding('VAT rate is hard-coded', 'low', [ev('src/invoice.py', 4, 'VAT_RATE = Decimal("0.20")')]),
      ] });
    default:
      throw new Error(`unexpected agent ${tag}`);
  }
}

describe('integration: review run -> check-evidence -> stats', async () => {
  const run = await runFanout(reviewArgs(), reviewResponder);
  const out = close(run, 'review');

  test('the foreman ran the scenario as intended', () => {
    assert.equal(run.res.started, true);
    const by = Object.fromEntries(run.res.ledger.units.map((l) => [l.id, l.outcome]));
    assert.deepEqual(by, { r1: 'ok', r2: 'ok-rerouted', r3: 'ok', r4: 'ok' });
    assert.equal(run.res.ledger.reroutes, 1);
    // ledger cells are already strings, card.S is top-level: the shapes the scripts must read
    assert.equal(run.res.ledger.units[0].p, 'sonnet·medium');
    assert.equal(run.res.ledger.units[0].fb, 'opus·high');
    assert.equal(run.res.card.S, 'opus');
    assert.equal(run.res.card.session, undefined);
    const v = Object.fromEntries(run.res.results.claims.map((c) => [c.cid, c.verdict]));
    assert.deepEqual(v, {
      'r1.f1': 'CONFIRMED', 'r1.f2': 'REFUTED', 'r2.f1': 'CONFIRMED',
      'r3.f1': 'CONFIRMED', 'r3.f2': 'PLAUSIBLE', 'r4.f1': 'PLAUSIBLE', 's1.f1': 'PLAUSIBLE',
    });
  });

  test('check-evidence reads the wrapped output and downgrades only the ungrounded claims', () => {
    const r = out.report;
    assert.equal(r.claims, 7);
    assert.equal(r.quotes, 7);
    assert.equal(r.resolved, 5);
    assert.equal(r.counterQuotes, 1);
    assert.equal(r.counterResolved, 1);
    assert.deepEqual(r.downgrades.map((d) => [d.cid, d.from, d.to, d.reason]), [
      ['r3.f1', 'CONFIRMED', 'UNVERIFIED', 'evidence'],
      ['r3.f2', 'PLAUSIBLE', 'UNVERIFIED', 'evidence'],
    ]);
    const drifted = r.items.find((i) => i.cid === 'r3.f2').evidence[0];
    assert.equal(drifted.foundAt, 8);
    assert.match(out.auditText, /r3\.f1: CONFIRMED -> UNVERIFIED \(evidence\)/);
  });

  test('--write keeps the wrapper, patches claims, top[] and counts, never raises a verdict', () => {
    const a = out.audited;
    assert.equal(a.summary, 'fanout finished');
    assert.equal(a.agentCount, run.calls.length);
    const claims = a.result.results.claims;
    assertDowngradeOnly(run.res.results.claims, claims);
    const c = a.result.digest.counts;
    const k = (v) => claims.filter((x) => x.verdict === v).length;
    assert.deepEqual([c.confirmed, c.plausible, c.refuted, c.unverifiedClaims], [k('CONFIRMED'), k('PLAUSIBLE'), k('REFUTED'), k('UNVERIFIED')]);
    assert.deepEqual([c.confirmed, c.plausible, c.refuted, c.unverifiedClaims], [2, 2, 1, 2]);
    for (const t of a.result.digest.top) assert.equal(t.verdict, claims.find((x) => x.cid === t.cid).verdict);
    const r3 = claims.find((x) => x.cid === 'r3.f1');
    assert.equal(r3.verdictBeforeAudit, 'CONFIRMED');
    assert.equal(r3.verdictBy, 'check-evidence');
    assert.equal(r3.verdictByBeforeAudit, run.res.results.claims.find((x) => x.cid === 'r3.f1').verdictBy);
    assert.equal(r3.reasonBeforeAudit, 'read it');
    assert.equal(r3.reason, 'check-evidence: src/payments.py:3 quote not found');
    assert.equal(claims.find((x) => x.cid === 'r3.f2').reason, 'check-evidence: src/payments.py:12 quote not at the cited line (it is at line 8)');
    assert.equal(a.result.evidenceAudit.downgrades.length, 2);
    assert.deepEqual(a.result.ledger, run.res.ledger, 'the ledger passes through untouched');
  });

  test('stats builds cohort keys from the real card/ledger fields', () => {
    const keys = Object.keys(out.stats.cohorts).sort();
    assert.deepEqual(keys, [
      'review/review/D1V2B1T1/sonnet·low/omit',
      'review/review/D2V1B1T1/sonnet·medium/omit',
    ]);
    const main = out.stats.cohorts['review/review/D2V1B1T1/sonnet·medium/omit'];
    assert.deepEqual([main.n, main.firstPassOk, main.refutedLater, main.rerouted, main.unverified], [3, 1, 1, 1, 0]);
    assert.deepEqual(main.fb, { 'opus·high': 3 });
    // r2's confidence is the fallback's, not p's: it must not feed p's confidence split
    assert.deepEqual(main.conf, { hi: { n: 2, ok: 1 }, lo: { n: 0, ok: 0 } });
    const set = out.stats.cohorts['review/review/D1V2B1T1/sonnet·low/omit'];
    assert.deepEqual(set.fb, { 'sonnet·medium': 1 });
    assert.equal(set.n, 1);
    const run0 = out.stats.runs[0];
    assert.equal(run0.kind, 'review');
    assert.equal(run0.units, 4);
    assert.equal(run0.reroutes, 1);
    assert.equal(run0.U, run.res.digest.money.U);
    assert.equal(run0.committedUsd, run.res.digest.money.committedUsd);
  });

  test('stats --summary prints the cohort; a second update of the same run is skipped', () => {
    assert.match(out.summary, /review\/D2V1B1T1\/sonnet·medium\/omit {2}n=3 {2}33% {2}33%/);
    assert.ok(!/\/opus\/omit/.test(out.summary), 'no cell collapsed to the bare session model');
    const again = cli('stats.mjs', ['update', `${out.outFile}.audited.json`, '--file', out.statsFile, '--kind', 'review']);
    assert.match(again.stdout, /already recorded/);
    // the raw (un-audited) file has the same ledger, so it is the same run too
    const raw = cli('stats.mjs', ['update', out.outFile, '--file', out.statsFile, '--kind', 'review']);
    assert.match(raw.stdout, /already recorded/);
  });
});

// ledger-cost reads transcripts, not the output file; the tags it parses are the ones the
// foreman writes on the last prompt line. Build one transcript per real agent call.
describe('integration: ledger-cost attributes every real foreman prompt', async () => {
  const run = await runFanout(reviewArgs(), reviewResponder);
  const dir = tmpDir();
  const fam = (o) => (o.model || 'opus');
  const journal = [];
  run.calls.forEach((c, i) => {
    const id = `a${String(i).padStart(2, '0')}`;
    const lines = [
      { type: 'user', message: { role: 'user', content: c.prompt } },
      { type: 'assistant', message: { id: `m${i}`, role: 'assistant', model: `claude-${fam(c.opts)}-test`, usage: { input_tokens: 100, output_tokens: 500, cache_creation_input_tokens: 1000, cache_read_input_tokens: 10000 } } },
    ];
    fs.writeFileSync(path.join(dir, `agent-${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    journal.push(JSON.stringify({ type: 'started', agentId: id, label: c.opts.label }));
  });
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), journal.join('\n') + '\n');
  const r = cli('ledger-cost.mjs', [dir, '--json']);
  const L = JSON.parse(r.stdout);

  test('no agent is untagged; kinds and units match the foreman ledger', () => {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(L.agents.length, run.calls.length);
    assert.ok(!('untagged' in L.byKind), JSON.stringify(L.agents.filter((a) => a.kind === 'untagged').map((a) => a.label)));
    const attempts = run.res.ledger.units.flatMap((u) => u.attempts.filter((a) => a.cls !== 'refused'));
    assert.equal(L.byKind.work.agents, attempts.length);
    assert.equal(L.byKind.inspector.agents, run.res.ledger.inspectors.length);
    assert.equal(L.byKind.verifier.agents, run.res.ledger.verifiers.length);
    assert.equal(L.byKind.sweep.agents, run.res.ledger.sweeps.length);
    assert.deepEqual(Object.keys(L.byUnit).sort(), ['r1', 'r2', 'r3', 'r4']);
    // the foreman ledger writes tags with their brackets; ledger-cost keys them as 'df:<inner>'
    for (const a of attempts) assert.ok(L.byTag[a.tag.replace(/^⟦|⟧$/g, '')], `${a.tag} has no actuals`);
    assert.equal(L.byUnit.r2.agents, 3, 'primary + re-route + inspector of the re-route');
    assert.deepEqual(Object.keys(L.byModel).sort(), ['opus', 'sonnet']);
  });
});

// ───────────────────────── scenario 2: data ─────────────────────────

function dataArgs() {
  const d = (id) => ({
    id, role: 'data', vec: 'D1 A1 T1 C1 V2 B1 G0', in: 15000, ctx: 'omit', n: 1, p: SON_MED, rd: { model: 'sonnet', effort: 'high' },
    fb: OPUS_HIGH, check: 'tieout+rederive', why: 'V2: totals tie out; rd re-derives', brief: `sum ledger.csv for ${id}`,
    scope: { files: ['data/ledger.csv'] },
  });
  return {
    v: 2, kind: 'data', depth: 'standard', confirmed: true,
    session: SESSION,
    shared: 'Totals from data/ledger.csv.',
    ultra: { agents: 6, verifiers: 2, ctxTok: 10000, inAvg: 20000, basis: 'test: 2 totals' },
    units: [d('d1'), d('d2')],
    verify: { cells: { V3: { effort: 'high' } } },
    reduce: { invariants: [{ name: 'revenue + discounts = net', lhs: 'sum(d1.acct_)', rhs: 'd2.net' }] },
    caps: { pauseUsd: 100 },
  };
}

const nums = (list, method) => okUnit({ files_read: ['data/ledger.csv'], confidence: 0.85,
  numbers: list.map(([name, value]) => ({ name, value, method })) });

function dataResponder(prompt) {
  const tag = tagOf(prompt);
  switch (tag) {
    case 'd1:1': return nums([['acct_4000', '250.00'], ['acct_4100', '-25.50']], 'pandas groupby');
    case 'd1:2': return nums([['acct_4000', '250.00'], ['acct_4100', '-25.50']], 'csv module loop');
    case 'd2:1': return nums([['net', '224.00']], 'pandas sum');           // wrong
    case 'd2:2': return nums([['net', '224.50']], 'awk');                  // planned re-derivation disagrees
    case 'd2:3': return nums([['net', '224.50']], 'python decimal');       // fb in rederive mode matches rd
    default: throw new Error(`unexpected agent ${tag}`);
  }
}

describe('integration: data run -> check-evidence -> stats', async () => {
  const run = await runFanout(dataArgs(), dataResponder);
  const out = close(run, 'data');

  test('the foreman tied out d1 and re-routed d2 in rederive mode', () => {
    assert.equal(run.res.started, true);
    const L = Object.fromEntries(run.res.ledger.units.map((l) => [l.id, l]));
    assert.equal(L.d1.outcome, 'ok');
    assert.equal(L.d2.outcome, 'ok-rerouted');
    assert.equal(L.d2.attempts.at(-1).mode, 'rederive');
    assert.equal(run.res.results.units.d1.numbersStatus, 'CONFIRMED');
    assert.equal(run.res.results.units.d2.numbersStatus, 'CONFIRMED');
    assert.deepEqual(run.res.digest.invariants.map((i) => [i.ok, i.lhs, i.rhs]), [[true, '224.50', '224.50']]);
  });

  test('check-evidence: no claims, nothing to downgrade, output still patched', () => {
    assert.equal(out.report.claims, 0);
    assert.equal(out.report.downgrades.length, 0);
    assert.equal(out.audited.result.evidenceAudit.claims, 0);
    assert.deepEqual(out.audited.result.results.units, run.res.results.units);
  });

  test('stats: one data cohort, first-pass vs re-routed, fb tally', () => {
    assert.deepEqual(Object.keys(out.stats.cohorts), ['data/data/D1V2B1T1/sonnet·medium/omit']);
    const c = out.stats.cohorts['data/data/D1V2B1T1/sonnet·medium/omit'];
    assert.deepEqual([c.n, c.firstPassOk, c.rerouted, c.unverified], [2, 1, 1, 0]);
    assert.deepEqual(c.fb, { 'opus·high': 2 });
    assert.deepEqual(c.conf, { hi: { n: 1, ok: 1 }, lo: { n: 0, ok: 0 } });
    assert.match(out.summary, /data\/D1V2B1T1\/sonnet·medium\/omit {2}n=2 {2}50% {2}50%/);
  });
});

// ───────────────────────── scenario 3: budget refusal + split stages ─────────────────────────

describe('integration: refused units and a verify-only stage', async () => {
  const args = reviewArgs();
  args.units = args.units.slice(0, 2).map((u) => ({ ...u, check: 'set', vec: 'D1 A0 T1 C0 V2 B1 G0' }));
  args.sweep = { rounds: 0 };
  args.caps = { pauseUsd: 100, maxOutputTokens: 1000 };
  const responder = (prompt) => {
    const tag = tagOf(prompt);
    if (tag === 'r1:1') return okUnit({ files_read: ['src/invoice.py'], findings: [] });
    throw new Error(`unexpected agent ${tag}`);
  };
  // output jumps past the kill switch after the first agent: r2 is refused before launch
  const run = await runFanout(args, responder, { spent: (n) => (n >= 1 ? 900 : 0), sequential: true });

  test('a unit the meter refused before launch is not counted against its cell', () => {
    const r2 = run.res.ledger.units.find((l) => l.id === 'r2');
    assert.equal(r2.outcome, 'unverified');
    assert.deepEqual(r2.attempts.map((a) => a.cls), ['refused']);
    const { labels } = st.labelUnits(run.res);
    assert.deepEqual(labels.map((l) => [l.id, l.label]), [['r1', 'firstPassOk']]);
  });

  test('a verify-only stage output (no ledger units) is not recorded and does not decay the file', async () => {
    const out = close(run, 'review');
    const before = fs.readFileSync(out.statsFile, 'utf8');
    const vargs = { ...reviewArgs(), stage: 'verify', claims: [
      { cid: 'r1.f1', unit: 'r1', severity: 'high', title: 't', claim: 'c', evidence: [ev('src/invoice.py', 19, 'return invoice.due_date <= today')], verdict: 'PENDING' },
    ] };
    const vrun = await runFanout(vargs, (prompt) => ({ verdicts: [{ cid: 'r1.f1', verdict: 'CONFIRMED', reason: 'ok' }] }));
    assert.equal(vrun.res.started, true);
    assert.deepEqual(vrun.res.ledger.units, []);
    const file = path.join(tmpDir(), 'verify.json');
    fs.writeFileSync(file, JSON.stringify(workflowOutput(vrun)));
    const upd = cli('stats.mjs', ['update', file, '--file', out.statsFile, '--kind', 'review']);
    assert.equal(upd.status, 0, upd.stderr);
    assert.match(upd.stdout, /no units/);
    assert.equal(fs.readFileSync(out.statsFile, 'utf8'), before);
    // check-evidence still audits the verify-stage claims
    const audit = ce.audit(ce.unwrap(workflowOutput(vrun)), { root: REPO });
    assert.deepEqual([audit.report.claims, audit.report.resolved, audit.report.downgrades.length], [1, 1, 0]);
  });

  test('a REFUTED claim merged by dedup counts against every unit that made it', async () => {
    const a = reviewArgs();
    a.units = [a.units[0], a.units[3]]; // r1 and r4, same cell
    a.sweep = { rounds: 0 };
    const same = finding('apply_discount accepts a discount above 100%', 'medium', [ev('src/invoice.py', 13, 'if pct > 100:')]);
    const resp = (prompt) => {
      const tag = tagOf(prompt);
      if (tag.startsWith('i:')) return inspectAll(prompt, true);
      if (tag.startsWith('v:')) return { verdicts: [{ cid: 'r1.f1', verdict: 'REFUTED', reason: 'raises', counter_quote: COUNTER }] };
      return okUnit({ files_read: ['src/invoice.py'], confidence: 0.9, findings: [same] });
    };
    const mrun = await runFanout(a, resp);
    const merged = mrun.res.results.claims;
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0].mergedFrom, ['r4.f1']);
    assert.equal(merged[0].verdict, 'REFUTED');
    const { labels } = st.labelUnits(mrun.res);
    assert.deepEqual(labels.map((l) => [l.id, l.label]), [['r1', 'refutedLater'], ['r4', 'refutedLater']]);
  });

  test('a rejected plan (started:false, no ledger) is refused by stats with a clear message', () => {
    const file = path.join(tmpDir(), 'rejected.json');
    fs.writeFileSync(file, JSON.stringify({ summary: 'x', agentCount: 0, logs: [], result: { started: false, reason: 'rails', errors: ['e'] } }));
    const upd = cli('stats.mjs', ['update', file, '--file', path.join(tmpDir(), 's.json')]);
    assert.equal(upd.status, 2);
    assert.match(upd.stderr, /did not start \(rails\)/);
  });
});
