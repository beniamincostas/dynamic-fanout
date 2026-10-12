// Tests for scripts/check-evidence.mjs, scripts/ledger-cost.mjs and scripts/stats.mjs.
// Run: node --test plugins/dynamic-fanout/tests/scripts.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as ce from '../scripts/check-evidence.mjs';
import * as lc from '../scripts/ledger-cost.mjs';
import * as st from '../scripts/stats.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const ROOT = path.join(FIX, 'repo');
const OUTPUT = path.join(FIX, 'workflow-output.json');
const TRANSCRIPTS = path.join(FIX, 'transcripts');
const SCRIPTS = path.join(HERE, '..', 'scripts');

const loadOutput = () => JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'df-scripts-'));
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const run = (script, args, env = {}) =>
  spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

// ---------------------------------------------------------------- check-evidence
describe('check-evidence', () => {
  const text = fs.readFileSync(path.join(ROOT, 'src/billing.py'), 'utf8');

  test('exact quote on the cited line resolves', () => {
    const r = ce.checkQuote(text, 8, 'tax = round(gross_cents * tax_rate / (1 + tax_rate))');
    assert.equal(r.resolved, true);
    assert.equal(r.how, 'exact');
  });

  test('quote within ±3 lines resolves; 4 lines away does not', () => {
    assert.equal(ce.checkQuote(text, 6, 'return gross_cents - tax').resolved, true); // quote on line 9
    const far = ce.checkQuote(text, 5, 'return gross_cents - tax');
    assert.equal(far.resolved, false);
    assert.equal(far.foundAt, 9);
  });

  test('whitespace-normalised match resolves', () => {
    const r = ce.checkQuote(text, 13, 'if payment.amount_cents == invoice.open_cents:');
    assert.equal(r.resolved, true);
    assert.equal(r.how, 'normalised');
  });

  test('quote elsewhere in the file reports foundAt but stays unresolved', () => {
    const r = ce.checkQuote(text, 3, 'invoice.due_date < today');
    assert.equal(r.resolved, false);
    assert.equal(r.foundAt, 19);
  });

  test('quote absent everywhere: unresolved, no foundAt', () => {
    const r = ce.checkQuote(text, 3, 'not in this file');
    assert.deepEqual([r.resolved, r.foundAt], [false, null]);
  });

  test('missing file and file:line shorthand', () => {
    assert.equal(ce.checkEvidence({ file: 'src/nope.py', line: 1, quote: 'x' }, ROOT).error, 'missing-file');
    assert.equal(ce.checkEvidence({ file: 'src/billing.py:3', quote: 'GRACE_MINUTES = 30' }, ROOT).resolved, true);
  });

  test('audit downgrades exactly the ungrounded claims', () => {
    const { report, claims } = ce.audit(ce.unwrap(loadOutput()), { root: ROOT });
    const v = Object.fromEntries(claims.map((c) => [c.cid, c.verdict]));
    assert.deepEqual(v, {
      c1: 'CONFIRMED', c2: 'CONFIRMED', c3: 'PLAUSIBLE',
      c4: 'UNVERIFIED',           // quote drifted to line 19
      c5: 'REFUTED',              // counter-quote grounded
      c6: 'PLAUSIBLE',            // counter-quote invented
      c7: 'UNVERIFIED', c8: 'UNVERIFIED', c9: 'UNVERIFIED',
    });
    assert.deepEqual(report.downgrades.map((d) => [d.cid, d.from, d.to, d.reason]), [
      ['c4', 'CONFIRMED', 'UNVERIFIED', 'evidence'],
      ['c6', 'REFUTED', 'PLAUSIBLE', 'counter_quote'],
      ['c8', 'PLAUSIBLE', 'UNVERIFIED', 'evidence'],
    ]);
    assert.equal(report.quotes, 9);
    assert.equal(report.resolved, 6);
    assert.equal(report.counterQuotes, 2);
    assert.equal(report.counterResolved, 1);
  });

  test('REFUTED with unresolved counter-quote AND bad evidence ends UNVERIFIED', () => {
    const res = { results: { claims: [{ cid: 'x', verdict: 'REFUTED',
      evidence: [{ file: 'src/billing.py', line: 1, quote: 'nowhere' }],
      counter_quote: { file: 'src/billing.py', line: 1, quote: 'also nowhere' } }] } };
    const { claims } = ce.audit(res, { root: ROOT });
    assert.equal(claims[0].verdict, 'UNVERIFIED');
  });

  test('downgrade-only: no verdict is ever raised', () => {
    const rank = { CONFIRMED: 3, REFUTED: 3, PLAUSIBLE: 2, UNVERIFIABLE: 1, UNVERIFIED: 1 };
    const verdicts = ['CONFIRMED', 'PLAUSIBLE', 'REFUTED', 'UNVERIFIED', 'UNVERIFIABLE'];
    const quotes = [
      { file: 'src/billing.py', line: 3, quote: 'GRACE_MINUTES = 30' },
      { file: 'src/billing.py', line: 3, quote: 'nowhere' },
      { file: 'src/missing.py', line: 3, quote: 'x' },
    ];
    for (const verdict of verdicts) for (const ev of quotes) for (const cq of [quotes[0], quotes[1], undefined]) {
      const res = { results: { claims: [{ cid: 'k', verdict, evidence: [ev], counter_quote: cq }] } };
      const after = ce.audit(res, { root: ROOT }).claims[0].verdict;
      assert.ok(rank[after] <= rank[verdict], `${verdict} -> ${after} is an upgrade`);
      if (verdict === 'UNVERIFIED' || verdict === 'UNVERIFIABLE') assert.equal(after, verdict);
    }
  });

  test('input is not mutated; patched output keeps the wrapper and fixes counts + top', () => {
    const doc = loadOutput();
    const before = JSON.stringify(doc);
    const { report, claims } = ce.audit(ce.unwrap(doc), { root: ROOT });
    assert.equal(JSON.stringify(doc), before);
    const patched = ce.patchOutput(doc, claims, report);
    assert.ok(patched.result && patched.summary);
    const c = patched.result.digest.counts;
    assert.deepEqual([c.confirmed, c.plausible, c.refuted, c.unverifiedClaims], [2, 2, 1, 4]);
    assert.equal(patched.result.digest.top.find((t) => t.cid === 'c4').verdict, 'UNVERIFIED');
    assert.equal(patched.result.evidenceAudit.downgrades.length, 3);
  });

  // ---------------- files_read path-robustness fallback ----------------
  describe('resolveViaFilesRead', () => {
    const nested = path.join(ROOT, 'lib/nested/mod.py');
    const other = path.join(ROOT, 'lib/other/mod.py');

    test('own unit files_read, suffix-matched beyond the basename: unique -> resolves', () => {
      const resultsUnits = { u1: { files_read: [nested] }, u2: { files_read: [] } };
      assert.equal(ce.resolveViaFilesRead('nested/mod.py', { unit: 'u1', resultsUnits }), nested);
    });

    test('own unit files_read with no matching suffix falls through to the all-units basename scan', () => {
      const resultsUnits = { u1: { files_read: ['lib/unrelated.py'] }, u2: { files_read: [nested] } };
      assert.equal(ce.resolveViaFilesRead('mod.py', { unit: 'u1', resultsUnits }), nested);
    });

    test('basename matches two different files_read entries: ambiguous -> null', () => {
      // u1's own files_read matches uniquely, so it resolves via (a) without ever consulting
      // the other unit; a unit with no own match (or none at all) falls to the ambiguous (b) scan.
      const resultsUnits = { u1: { files_read: [nested] }, u2: { files_read: [other] } };
      assert.equal(ce.resolveViaFilesRead('mod.py', { unit: 'u1', resultsUnits }), nested);
      assert.equal(ce.resolveViaFilesRead('mod.py', { unit: 'u3', resultsUnits }), null);
      assert.equal(ce.resolveViaFilesRead('mod.py', { resultsUnits }), null);
    });

    test('no match anywhere, or no resultsUnits at all -> null', () => {
      assert.equal(ce.resolveViaFilesRead('nope.py', { unit: 'u1', resultsUnits: { u1: { files_read: [nested] } } }), null);
      assert.equal(ce.resolveViaFilesRead('mod.py', {}), null);
      assert.equal(ce.resolveViaFilesRead('mod.py', undefined), null);
    });
  });

  test('checkEvidence: missing file under root resolves via the unit\'s own files_read (unique suffix match)', () => {
    const resultsUnits = { u1: { files_read: [path.join(ROOT, 'lib/nested/mod.py')] } };
    const r = ce.checkEvidence({ file: 'nested/mod.py', line: 3, quote: 'TIMEOUT_SECONDS = 30' }, ROOT, new Map(), { unit: 'u1', resultsUnits });
    assert.equal(r.resolved, true);
    assert.equal(r.resolvedPath, path.join(ROOT, 'lib/nested/mod.py'));
  });

  test('checkEvidence: missing file resolves via another unit\'s files_read (basename match)', () => {
    const resultsUnits = { u1: { files_read: ['lib/unrelated.py'] }, u2: { files_read: [path.join(ROOT, 'lib/nested/mod.py')] } };
    const r = ce.checkEvidence({ file: 'mod.py', line: 3, quote: 'TIMEOUT_SECONDS = 30' }, ROOT, new Map(), { unit: 'u1', resultsUnits });
    assert.equal(r.resolved, true);
    assert.equal(r.resolvedPath, path.join(ROOT, 'lib/nested/mod.py'));
  });

  test('checkEvidence: ambiguous basename match (no own-unit hit) stays unresolved, no resolvedPath, same as before the fallback existed', () => {
    const resultsUnits = { u1: { files_read: [path.join(ROOT, 'lib/nested/mod.py')] }, u2: { files_read: [path.join(ROOT, 'lib/other/mod.py')] } };
    const r = ce.checkEvidence({ file: 'mod.py', line: 1, quote: 'anything' }, ROOT, new Map(), { unit: 'u3', resultsUnits });
    assert.equal(r.resolved, false);
    assert.equal(r.error, 'missing-file');
    assert.equal(r.resolvedPath, undefined);
  });

  test('checkEvidence: without opts (no resultsUnits), a missing file behaves exactly as before', () => {
    const r = ce.checkEvidence({ file: 'nested/mod.py', line: 3, quote: 'TIMEOUT_SECONDS = 30' }, ROOT);
    assert.deepEqual([r.resolved, r.error, r.resolvedPath], [false, 'missing-file', undefined]);
  });

  test('audit: a claim citing a short path (worker shorthand) resolves through files_read instead of staying UNVERIFIED', () => {
    const res = {
      results: {
        units: { w1: { files_read: ['lib/nested/mod.py'].map((p) => path.join(ROOT, p)) } },
        claims: [{ cid: 'k1', unit: 'w1', verdict: 'CONFIRMED',
          evidence: [{ file: 'mod.py', line: 3, quote: 'TIMEOUT_SECONDS = 30' }] }],
      },
    };
    const { report, claims } = ce.audit(res, { root: ROOT });
    assert.equal(claims[0].verdict, 'CONFIRMED'); // not downgraded
    assert.equal(report.resolved, 1);
    assert.equal(report.items[0].evidence[0].resolvedPath, path.join(ROOT, 'lib/nested/mod.py'));
  });

  test('CLI: summary, --json and --write; accepts bare RESULT too', () => {
    const dir = tmpDir();
    const outFile = path.join(dir, 'patched.json');
    const r = run('check-evidence.mjs', [OUTPUT, '--root', ROOT, '--write', outFile]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /9 claims, quotes resolved 6\/9 \(66\.7%\)/);
    assert.match(r.stdout, /c4: CONFIRMED -> UNVERIFIED \(evidence\)/);
    assert.equal(JSON.parse(fs.readFileSync(outFile, 'utf8')).result.results.claims.find((c) => c.cid === 'c8').verdict, 'UNVERIFIED');

    const bare = path.join(dir, 'bare.json');
    fs.writeFileSync(bare, JSON.stringify(loadOutput().result));
    const j = run('check-evidence.mjs', [bare, '--root', ROOT, '--json']);
    assert.equal(j.status, 0, j.stderr);
    assert.equal(JSON.parse(j.stdout).downgrades.length, 3);
  });
});

// ---------------------------------------------------------------- ledger-cost
describe('ledger-cost', () => {
  // Fixture: 4 agents, 55 usage lines for 19 unique message ids. The final copy of each
  // message carries in 100 / cache-write 1000 / cache-read 10000 / out 500; earlier
  // streamed copies carry partial output (1, 2), which dedup must not add.
  const perMsg = (inP, outP) => (100 * inP + 1000 * inP * 1.25 + 10000 * inP * 0.1 + 500 * outP) / 1e6;

  test('tag parsing: work / inspector / verifier / sweep / critic / untagged', () => {
    assert.deepEqual(lc.parseTag('u1:2'), { tag: 'df:u1:2', kind: 'work', unit: 'u1', attempt: 2 });
    assert.deepEqual(lc.parseTag('i:u3:1'), { tag: 'df:i:u3:1', kind: 'inspector', unit: 'u3', n: 1 });
    assert.equal(lc.parseTag('v:2:1').kind, 'verifier');
    assert.equal(lc.parseTag('s:1:1').kind, 'sweep');
    assert.equal(lc.parseTag('c:1:1').kind, 'critic');
    assert.equal(lc.parseTag(null).kind, 'untagged');
    assert.equal(lc.parseTag('id:attempt').kind, 'untagged'); // doc placeholder, not a tag
  });

  test('only the last prompt line carries the tag', () => {
    assert.equal(lc.findTag('preamble ⟦df:u9:1⟧ mentioned\nbrief\n  ⟦df:u2:1⟧\n\n'), 'u2:1');
    assert.equal(lc.findTag('mentions ⟦df:u9:1⟧ mid-prompt\nlast line has none'), null);
  });

  test('model family by substring', () => {
    assert.equal(lc.family('claude-haiku-4-5-20251001'), 'haiku');
    assert.equal(lc.family('claude-opus-5-5'), 'opus');
    assert.equal(lc.family('<synthetic>'), null);
  });

  test('dedup by message.id: 55 usage lines -> 19 messages', () => {
    const L = lc.ledger(TRANSCRIPTS);
    assert.equal(L.usageLines, 55);
    assert.equal(L.totals.messages, 19);
    assert.equal(L.totals.output, 19 * 500);
    assert.equal(L.totals.cacheRead, 19 * 10000);
    near(L.totals.usd, 12 * perMsg(4, 20) + 4 * perMsg(2, 10) + 3 * perMsg(1, 5));
  });

  test('groups by tag, unit, kind and model; untagged agent stays untagged', () => {
    const L = lc.ledger(TRANSCRIPTS);
    assert.deepEqual(Object.keys(L.byTag).sort(), ['df:i:u1:1', 'df:u1:1', 'df:v:1:1', 'untagged']);
    assert.equal(L.byTag['df:u1:1'].messages, 7);
    assert.equal(L.byTag['untagged'].messages, 3); // its tool_result quotes ⟦df:u9:1⟧ — ignored
    assert.equal(L.byUnit.u1.agents, 2);           // work + inspector
    near(L.byUnit.u1.usd, 7 * perMsg(4, 20) + 4 * perMsg(2, 10));
    assert.equal(L.byKind.verifier.messages, 5);
    assert.deepEqual(Object.keys(L.byModel).sort(), ['haiku', 'opus', 'sonnet']);
    assert.equal(L.byModel.opus.agents, 2);
    near(L.byModel.haiku.usd, 3 * perMsg(1, 5));
    assert.ok(L.warnings.some((w) => /unparseable/.test(w)));
    assert.equal(L.agents.find((a) => a.agentId === 'aaa1').label, 'label-aaa1');
  });

  test('1-hour cache writes are priced at 2x', () => {
    const u = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000,
      cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 0 } };
    near(lc.priceUsage(u, 'opus'), (1000 * 4 * 2) / 1e6);
  });

  test('fail soft: unknown dir and unrecognised files exit 0 with a warning', () => {
    const missing = run('ledger-cost.mjs', [path.join(tmpDir(), 'nope')]);
    assert.equal(missing.status, 0);
    assert.match(missing.stdout, /warning: cannot read dir/);
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'agent-x.jsonl'), 'hello\n{"foo":1}\n');
    const odd = run('ledger-cost.mjs', [dir]);
    assert.equal(odd.status, 0);
    assert.match(odd.stdout, /no assistant usage found/);
    const ok = run('ledger-cost.mjs', [TRANSCRIPTS, '--json']);
    assert.equal(ok.status, 0);
    assert.equal(JSON.parse(ok.stdout).totals.messages, 19);
  });
});

// ---------------------------------------------------------------- stats
describe('stats', () => {
  const REVIEW = 'review/review/D2V1B1T1/opus·medium/omit';
  const EXTRACT = 'review/extract/D0V2B0T1/sonnet·low/omit';

  test('cohort key parts', () => {
    assert.equal(st.vecKey('D2 A1 T1 C1 V0 B2 G2'), 'D2V0B2T1');
    assert.equal(st.cellOf({ effort: 'high' }, 'opus'), 'opus·high');
    assert.equal(st.cellOf({ model: 'haiku' }, 'opus'), 'haiku');
  });

  test('final-outcome labelling; promoted and never-launched units skipped', () => {
    const { kind, labels } = st.labelUnits(st.unwrap(loadOutput()));
    assert.equal(kind, 'review');
    const by = Object.fromEntries(labels.map((l) => [l.id, l.label]));
    assert.deepEqual(by, {
      u1: 'firstPassOk',
      u2: 'refutedLater',   // passed the gate, claim c5 REFUTED in verification
      u3: 'rerouted',
      u5: 'unverified',
      u6: 'refutedLater',   // claim c6 REFUTED
    });
    assert.ok(!('u4' in by), 'ok-promoted never ran p');
    assert.ok(!('u7' in by), 'budget-refused unit never launched');
  });

  test('a check-evidence downgrade (not REFUTED) labels the unit ungroundedLater, not firstPassOk', () => {
    const res = st.unwrap(loadOutput());
    const patched = {
      ...res,
      results: {
        ...res.results,
        claims: res.results.claims.map((c) => (c.cid === 'c1' ? { ...c, verdict: 'UNVERIFIED', verdictBy: 'check-evidence' } : c)),
      },
    };
    const { labels } = st.labelUnits(patched);
    assert.equal(labels.find((l) => l.id === 'u1').label, 'ungroundedLater');
    const s = st.applyRun(st.emptyStats(), patched);
    assert.deepEqual([s.cohorts[REVIEW].firstPassOk, s.cohorts[REVIEW].ungroundedLater], [0, 1]);
  });

  test('mergeVerifyClaims folds a stage:verify output\'s verdicts into a stage:work output by cid', () => {
    const work = st.unwrap(loadOutput());
    const verify = { results: { claims: [{ cid: 'c1', verdict: 'REFUTED', verdictBy: 'skeptic', reason: 'counter-evidence found' }] } };
    const merged = st.mergeVerifyClaims(work, verify);
    const c1 = merged.results.claims.find((c) => c.cid === 'c1');
    assert.deepEqual([c1.verdict, c1.verdictBy, c1.reason], ['REFUTED', 'skeptic', 'counter-evidence found']);
    // untouched cids and the rest of the result pass through unchanged
    assert.equal(merged.results.claims.find((c) => c.cid === 'c2').verdict, 'CONFIRMED');
    assert.equal(merged.ledger, work.ledger);
    const { labels } = st.labelUnits(merged);
    assert.equal(labels.find((l) => l.id === 'u1').label, 'refutedLater');
  });

  test('CLI: update --verify merges verdicts before labelling', () => {
    const dir = tmpDir();
    const statsFile = path.join(dir, 'stats.json');
    const verifyFile = path.join(dir, 'verify.json');
    fs.writeFileSync(verifyFile, JSON.stringify({ results: { claims: [{ cid: 'c1', verdict: 'REFUTED', verdictBy: 'skeptic' }] } }));
    const r = run('stats.mjs', ['update', OUTPUT, '--file', statsFile, '--verify', verifyFile]);
    assert.equal(r.status, 0, r.stderr);
    const s = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
    assert.equal(s.cohorts[REVIEW].refutedLater, 3); // u1, u2, u6 now all REFUTED
  });

  test('applyRun counts cohorts, confidence buckets and fb tallies', () => {
    const s = st.applyRun(st.emptyStats(), st.unwrap(loadOutput()), { runId: 'r1' });
    const c = s.cohorts[REVIEW];
    assert.deepEqual([c.n, c.firstPassOk, c.refutedLater, c.rerouted, c.unverified], [4, 1, 2, 1, 0]);
    assert.deepEqual(c.conf, { hi: { n: 2, ok: 1 }, lo: { n: 1, ok: 0 } }); // u3 (ok-rerouted) carries the fallback's result, so its confidence is excluded
    assert.deepEqual(c.fb, { 'opus·high': 4 });
    assert.equal(s.cohorts[EXTRACT].unverified, 1);
    assert.deepEqual(s.runs[0], { id: 'r1', at: s.runs[0].at, kind: 'review', units: 5, reroutes: 1, U: 10, P: 4, committedUsd: 4.2 });
  });

  test('--kind overrides card.kind', () => {
    const s = st.applyRun(st.emptyStats(), st.unwrap(loadOutput()), { kind: 'data' });
    assert.ok(Object.keys(s.cohorts).every((k) => k.startsWith('data/')));
  });

  test('decay x0.9 on every counter before a run is added', () => {
    const res = st.unwrap(loadOutput());
    const s = st.applyRun(st.emptyStats(), res);
    st.applyRun(s, res);
    const c = s.cohorts[REVIEW];
    near(c.n, 4 * 0.9 + 4);
    near(c.firstPassOk, 0.9 + 1);
    near(c.conf.hi.n, 2 * 0.9 + 2);
    near(s.cohorts[EXTRACT].unverified, 0.9 + 1);
  });

  test('runs[] keeps the last 50', () => {
    const s = st.emptyStats();
    const res = st.unwrap(loadOutput());
    for (let i = 0; i < 55; i++) st.applyRun(s, res, { runId: `r${i}` });
    assert.equal(s.runs.length, 50);
    assert.equal(s.runs[0].id, 'r5');
  });

  test('rules: PROMOTE and RESERVE PRIOR fire; CONFIDENCE needs samples; no probe rule', () => {
    const s = st.applyRun(st.emptyStats(), st.unwrap(loadOutput()));
    const hits = st.rules(s, 'review');
    const promote = hits.find((h) => h.rule === 'PROMOTE');
    assert.equal(promote.cohort, REVIEW);
    assert.equal(promote.fb, 'opus·high');
    const reserve = hits.find((h) => h.rule === 'RESERVE PRIOR');
    assert.equal(reserve.role, 'review');
    near(reserve.rate, 0.25);
    assert.ok(!hits.some((h) => h.rule === 'CONFIDENCE'), 'hi.n=2 < 4');
    assert.ok(!hits.some((h) => h.rule === 'ENVELOPE'), '4.2 <= 0.6*10');
    assert.ok(!hits.some((h) => /PROBE/i.test(h.rule)));
  });

  test('rules: PROMOTE stays quiet when first-pass ≥80%', () => {
    const s = st.emptyStats();
    s.cohorts['review/r/D1V1B0T1/opus·medium/omit'] = { n: 5, firstPassOk: 4, rerouted: 0, refutedLater: 1, unverified: 0, conf: { hi: { n: 0, ok: 0 }, lo: { n: 0, ok: 0 } }, fb: {} };
    assert.ok(!st.rules(s, 'review').some((h) => h.rule === 'PROMOTE'));
  });

  test('rules: CONFIDENCE fires when hi is not ≥10 points above lo; ENVELOPE on the last run', () => {
    const s = st.emptyStats();
    s.cohorts['review/r/D1V1B0T1/opus·medium/omit'] = { n: 10, firstPassOk: 9, rerouted: 0, refutedLater: 0, unverified: 1, conf: { hi: { n: 5, ok: 4 }, lo: { n: 5, ok: 4 } }, fb: {} };
    s.runs.push({ kind: 'review', U: 10, committedUsd: 7 }, { kind: 'data', U: 10, committedUsd: 1 });
    const hits = st.rules(s, 'review');
    assert.ok(hits.some((h) => h.rule === 'CONFIDENCE'));
    const env = hits.find((h) => h.rule === 'ENVELOPE');
    near(env.ratio, 0.7); // 7 / 10 > 0.6
    assert.ok(!st.rules(s, 'data').some((h) => h.rule === 'ENVELOPE'));
    s.cohorts['review/r/D1V1B0T1/opus·medium/omit'].conf.hi.ok = 5; // 100% vs 80%
    assert.ok(!st.rules(s, 'review').some((h) => h.rule === 'CONFIDENCE'));
  });

  test('summary: ≤40 lines, n≥2 cohorts only, rule lines', () => {
    const s = st.applyRun(st.emptyStats(), st.unwrap(loadOutput()));
    for (let i = 0; i < 60; i++) s.cohorts[`review/r${i}/D1V1B0T1/opus·medium/omit`] = { n: 3, firstPassOk: 3, rerouted: 0, refutedLater: 0, unverified: 0, conf: { hi: { n: 0, ok: 0 }, lo: { n: 0, ok: 0 } }, fb: {} };
    const out = st.summary(s, 'review');
    const lines = out.split('\n');
    assert.ok(lines.length <= 40, `${lines.length} lines`);
    assert.match(out, /PROMOTE review\/review\/D2V1B1T1\/opus·medium\/omit/);
    assert.match(out, /RESERVE PRIOR role=review/);
    assert.ok(!out.includes('extract/'), 'n=1 cohort hidden');
    assert.match(out, /more cohort/);
  });

  // ---------------- self-calibration (calib.scale) ----------------
  describe('self-calibration', () => {
    test('estimatedUsdOf reads committedUsd + rerouteUsd from digest.money', () => {
      assert.equal(st.estimatedUsdOf(st.unwrap(loadOutput())), 4.2 + 0.5);
      assert.equal(st.estimatedUsdOf({}), 0);
    });

    test('applyCalibration: first observation sets calib.scale outright (no prior EWA)', () => {
      const s = st.emptyStats();
      st.applyCalibration(s, { actualUsd: 8, estimatedUsd: 4 }); // ratio 2
      assert.deepEqual(s.calib, { n: 1, scale: 2, last: { ratio: 2, at: 1 } });
    });

    test('applyCalibration: a second observation folds in as an EWA with alpha 0.5', () => {
      const s = st.emptyStats();
      st.applyCalibration(s, { actualUsd: 8, estimatedUsd: 4 });  // ratio 2    -> scale 2
      st.applyCalibration(s, { actualUsd: 4, estimatedUsd: 4 });  // ratio 1    -> scale 0.5*1 + 0.5*2 = 1.5
      assert.equal(s.calib.n, 2);
      assert.equal(s.calib.scale, 1.5);
      assert.deepEqual(s.calib.last, { ratio: 1, at: 2 });
    });

    test('applyCalibration clamps the ratio to [0.3, 5] before it enters the average', () => {
      const s = st.emptyStats();
      st.applyCalibration(s, { actualUsd: 100, estimatedUsd: 1 }); // ratio 100 -> clamped to 5
      assert.equal(s.calib.scale, 5);
      st.applyCalibration(s, { actualUsd: 0.01, estimatedUsd: 10 }); // ratio 0.001 -> clamped to 0.3
      assert.equal(s.calib.scale, 0.5 * 0.3 + 0.5 * 5);
    });

    test('applyCalibration is a no-op when estimatedUsd <= 0 (nothing to compare against)', () => {
      const s = st.emptyStats();
      st.applyCalibration(s, { actualUsd: 8, estimatedUsd: 0 });
      st.applyCalibration(s, { actualUsd: 8, estimatedUsd: -1 });
      assert.equal(s.calib, undefined);
    });

    test('CLI: a card without a price model feeds no calibration, and the update line says why', () => {
      const dir = tmpDir();
      const statsFile = path.join(dir, 'stats.json');
      const ledgerFile = path.join(dir, 'ledger.json');
      fs.writeFileSync(ledgerFile, JSON.stringify({ totals: { usd: 9.4 } }));
      const r = run('stats.mjs', ['update', OUTPUT, '--file', statsFile, '--ledger', ledgerFile]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /calib skipped \(card has no price model/);
      const s = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
      assert.equal(s.calib, undefined);
      assert.equal(s.runs.length, 1, 'the run itself is still recorded');
    });

    test('CLI: --summary never prints a legacy global scale', () => {
      const dir = tmpDir();
      const statsFile = path.join(dir, 'stats.json');
      fs.writeFileSync(statsFile, JSON.stringify({ ...st.emptyStats(), calib: { n: 1, scale: 1.28, last: { ratio: 1.28, at: 1 } } }));
      const sum = run('stats.mjs', ['--summary', 'review', '--file', statsFile]);
      assert.equal(sum.status, 0, sum.stderr);
      assert.doesNotMatch(sum.stdout, /CALIB/);
    });

    test('CLI: --ledger with a non-existent file errors out (status 2) instead of recording the run', () => {
      const dir = tmpDir();
      const r = run('stats.mjs', ['update', OUTPUT, '--file', path.join(dir, 's.json'), '--ledger', path.join(dir, 'nope.json')]);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /cannot read/);
    });
  });

  // ---------------- self-calibration, per-role (calib.scaleByRole), keyed by price model ----------------
  describe('self-calibration: per-role', () => {
    const CALIB_OUTPUT = path.join(FIX, 'workflow-output-calib.json');
    const loadCalibResult = () => st.unwrap(JSON.parse(fs.readFileSync(CALIB_OUTPUT, 'utf8')));
    // estimate: work = 1.0 + 1.0 (attempts) = 2.0; sweep = 0.5; verify = 1.0 + 0.5 = 1.5; inspect = 0.3
    // card.calib = { pm: 3, scale: 1, scaleByRole: { work: 1.2, verify: 0.8 } } (inspect/sweep absent -> 1)
    const LEDGER = { byKind: { work: { usd: 2.4 }, critic: { usd: 0.6 }, verifier: { usd: 1.0 } } }; // work actual 3.0

    test('PRICE_MODEL matches the foreman\'s', () => {
      const src = fs.readFileSync(path.join(HERE, '..', 'workflows', 'fanout.js'), 'utf8');
      assert.equal(Number(/^const PRICE_MODEL = (\d+)/m.exec(src)[1]), st.PRICE_MODEL);
      assert.equal(st.PRICE_MODEL, 3);
      assert.deepEqual(st.ROLES, ['work', 'verify', 'inspect', 'sweep']);
    });

    test('estimatedUsdByRole: work = unit attempts, sweep = sweep rounds, verify, inspect', () => {
      assert.deepEqual(st.estimatedUsdByRole(loadCalibResult()), { work: 2.0, verify: 1.5, inspect: 0.3, sweep: 0.5 });
      assert.deepEqual(st.estimatedUsdByRole({}), { work: 0, verify: 0, inspect: 0, sweep: 0 });
    });

    test('actualUsdByRole reads byKind.{work+critic, sweep, verifier, inspector}; a missing kind is null, not 0', () => {
      assert.deepEqual(
        st.actualUsdByRole({ byKind: { work: { usd: 3 }, critic: { usd: 0.2 }, sweep: { usd: 0.4 }, verifier: { usd: 1 } } }),
        { work: 3.2, verify: 1, inspect: null, sweep: 0.4 },
      );
      assert.deepEqual(st.actualUsdByRole({ totals: { usd: 9.4 } }), { work: null, verify: null, inspect: null, sweep: null });
      assert.deepEqual(st.actualUsdByRole({ byKind: { inspector: { usd: 0 } } }), { work: null, verify: null, inspect: 0, sweep: null });
    });

    test('applyCalibrationByRole: target = used x ratio; the first observation under a pm blends from used', () => {
      const s = st.emptyStats();
      // work: ratio 3.0/2.0 = 1.5, used 1.2 -> target 1.8 -> first obs 0.5*1.8 + 0.5*1.2 = 1.5
      // verify: ratio 1.0/1.5, used 0.8 -> target 0.5333 -> 0.5*0.5333 + 0.5*0.8 = 0.6667
      st.applyCalibrationByRole(s, { result: loadCalibResult(), ledgerJson: LEDGER });
      assert.equal(s.calib.pm, 3);
      near(s.calib.scaleByRole.work, 1.5);
      near(s.calib.scaleByRole.verify, 2 / 3);
      assert.ok(!('inspect' in s.calib.scaleByRole));
      assert.ok(!('sweep' in s.calib.scaleByRole));
      assert.deepEqual(s.calib.nByRole, { work: 1, verify: 1 });
      near(s.calib.lastByRole.work.target, 1.8);
      assert.equal(s.calib.lastByRole.work.used, 1.2);
      assert.ok(!('scale' in s.calib), 'no global scale under a price model');
    });

    test('applyCalibrationByRole: used folds in the card\'s global scale (no double count)', () => {
      const s = st.emptyStats();
      const result = loadCalibResult();
      result.card.calib.scale = 1.28;
      st.applyCalibrationByRole(s, { result, ledgerJson: { byKind: { verifier: { usd: 1.5 } } } }); // ratio 1
      near(s.calib.lastByRole.verify.used, 0.8 * 1.28);
      near(s.calib.scaleByRole.verify, 0.8 * 1.28);
    });

    test('applyCalibrationByRole: sweep is its own role', () => {
      const s = st.emptyStats();
      // sweep: ratio 0.25/0.5 = 0.5, used 1 (absent on the card) -> target 0.5 -> 0.75
      st.applyCalibrationByRole(s, { result: loadCalibResult(), ledgerJson: { byKind: { sweep: { usd: 0.25 } } } });
      near(s.calib.scaleByRole.sweep, 0.75);
      assert.ok(!('work' in s.calib.scaleByRole), 'the sweep no longer feeds work');
    });

    test('applyCalibrationByRole: a card without pm feeds no calibration', () => {
      const s = st.emptyStats();
      const result = loadCalibResult();
      delete result.card.calib.pm;
      st.applyCalibrationByRole(s, { result, ledgerJson: LEDGER });
      assert.equal(s.calib, undefined);
    });

    test('applyCalibrationByRole: a role whose estimate is <= 0 is skipped', () => {
      const s = st.emptyStats();
      const result = { card: { calib: { pm: 3 } }, ledger: { units: [], verifiers: [], inspectors: [], sweeps: [] } };
      st.applyCalibrationByRole(s, { result, ledgerJson: { byKind: { work: { usd: 5 }, verifier: { usd: 2 }, inspector: { usd: 1 } } } });
      assert.equal(s.calib, undefined);
    });

    test('applyCalibrationByRole: a second observation folds into an EWA with alpha 0.5, per role', () => {
      const s = st.emptyStats();
      const result = loadCalibResult();
      st.applyCalibrationByRole(s, { result, ledgerJson: LEDGER }); // work 1.5
      st.applyCalibrationByRole(s, { result, ledgerJson: { byKind: { work: { usd: 2.0 } } } });
      // work: ratio 1, used 1.2 -> target 1.2 -> 0.5*1.2 + 0.5*1.5 = 1.35
      near(s.calib.scaleByRole.work, 1.35);
      assert.equal(s.calib.nByRole.work, 2);
      assert.equal(s.calib.lastByRole.work.at, 2);
    });

    test('applyCalibrationByRole clamps the per-role ratio to [0.1, 10]', () => {
      const s = st.emptyStats();
      st.applyCalibrationByRole(s, { result: loadCalibResult(), ledgerJson: { byKind: { work: { usd: 1000 } } } });
      assert.equal(s.calib.lastByRole.work.ratio, 10);
      const s2 = st.emptyStats();
      st.applyCalibrationByRole(s2, { result: loadCalibResult(), ledgerJson: { byKind: { work: { usd: 0.0001 } } } });
      assert.equal(s2.calib.lastByRole.work.ratio, 0.1);
    });

    test('applyCalibrationByRole archives a calib from another price model (or none) and starts fresh', () => {
      const s = st.emptyStats();
      st.applyCalibration(s, { actualUsd: 8, estimatedUsd: 4 }); // legacy global scale = 2, no pm
      const legacy = JSON.parse(JSON.stringify(s.calib));
      st.applyCalibrationByRole(s, { result: loadCalibResult(), ledgerJson: LEDGER });
      assert.deepEqual(s.calibArchive.legacy, legacy);
      assert.equal(s.calib.pm, 3);
      assert.equal(s.calib.nByRole.work, 1);
      // a pm-2 calib is archived under its pm
      const s2 = { ...st.emptyStats(), calib: { pm: 2, scaleByRole: { work: 0.4 }, nByRole: { work: 3 }, lastByRole: {} } };
      st.applyCalibrationByRole(s2, { result: loadCalibResult(), ledgerJson: LEDGER });
      assert.deepEqual(s2.calibArchive['2'].scaleByRole, { work: 0.4 });
      near(s2.calib.scaleByRole.work, 1.5); // not blended with the pm-2 factor
    });

    test('applyCalibrationByRole leaves stats untouched when nothing gets written', () => {
      const s = st.emptyStats();
      st.applyCalibration(s, { actualUsd: 8, estimatedUsd: 4 });
      const before = JSON.stringify(s);
      st.applyCalibrationByRole(s, { result: { card: { calib: { pm: 3 } }, ledger: {} }, ledgerJson: { byKind: {} } });
      assert.equal(JSON.stringify(s), before);
    });

    test('CLI: update --ledger with a byKind breakdown writes calib.scaleByRole under the price model', () => {
      const dir = tmpDir();
      const statsFile = path.join(dir, 'stats.json');
      const ledgerFile = path.join(dir, 'ledger.json');
      fs.writeFileSync(ledgerFile, JSON.stringify({ ...LEDGER, totals: { usd: 4.0 } }));
      const r = run('stats.mjs', ['update', CALIB_OUTPUT, '--file', statsFile, '--ledger', ledgerFile]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /calib\.scaleByRole=\{"work":1\.5,"verify":0\.67\}/);
      const s = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
      assert.equal(s.calib.pm, 3);
      near(s.calib.scaleByRole.work, 1.5);
    });

    test('CLI: a ledger without byKind feeds no calibration and says why', () => {
      const dir = tmpDir();
      const statsFile = path.join(dir, 'stats.json');
      const ledgerFile = path.join(dir, 'ledger.json');
      fs.writeFileSync(ledgerFile, JSON.stringify({ totals: { usd: 4.0 } }));
      const r = run('stats.mjs', ['update', CALIB_OUTPUT, '--file', statsFile, '--ledger', ledgerFile]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /calib skipped \(ledger has no byKind/);
      assert.equal(JSON.parse(fs.readFileSync(statsFile, 'utf8')).calib, undefined);
    });

    test('CLI: --summary prints CALIB with pm and scaleByRole only for the current price model', () => {
      const dir = tmpDir();
      const statsFile = path.join(dir, 'stats.json');
      const ledgerFile = path.join(dir, 'ledger.json');
      fs.writeFileSync(ledgerFile, JSON.stringify(LEDGER));
      run('stats.mjs', ['update', CALIB_OUTPUT, '--file', statsFile, '--ledger', ledgerFile]);
      const sum = run('stats.mjs', ['--summary', 'review', '--file', statsFile]);
      assert.equal(sum.status, 0, sum.stderr);
      assert.match(sum.stdout, /CALIB \{"pm":3,"scaleByRole":\{"work":1\.50,"verify":0\.67\}\}/);
      assert.doesNotMatch(sum.stdout, /"scale":/);
      assert.match(sum.stdout, /pass this back to the foreman as args\.calib/);
      // a calib from another price model prints nothing
      const s = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
      s.calib.pm = 2;
      fs.writeFileSync(statsFile, JSON.stringify(s));
      assert.doesNotMatch(run('stats.mjs', ['--summary', 'review', '--file', statsFile]).stdout, /CALIB/);
    });
  });

  test('CLI: update creates dirs, is the sole writer, skips a duplicate run; --summary reads it', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'nested', 'deeper', 'routing-stats.json');
    const u1 = run('stats.mjs', ['update', OUTPUT, '--file', file]);
    assert.equal(u1.status, 0, u1.stderr);
    assert.ok(fs.existsSync(file));
    const once = fs.readFileSync(file, 'utf8');
    const u2 = run('stats.mjs', ['update', OUTPUT, '--file', file]);
    assert.match(u2.stdout, /already recorded/);
    assert.equal(fs.readFileSync(file, 'utf8'), once);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['routing-stats.json']); // no temp files left
    const sum = run('stats.mjs', ['--summary', 'review', '--file', file]);
    assert.equal(sum.status, 0);
    assert.match(sum.stdout, /PROMOTE/);
  });

  test('CLI: $DYNAMIC_FANOUT_STATS is the default file', () => {
    const file = path.join(tmpDir(), 'env-stats.json');
    const r = run('stats.mjs', ['update', OUTPUT, '--kind', 'research'], { DYNAMIC_FANOUT_STATS: file });
    assert.equal(r.status, 0, r.stderr);
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(Object.keys(s.cohorts).every((k) => k.startsWith('research/')));
    assert.equal(st.defaultFile({ DYNAMIC_FANOUT_STATS: file }), file);
    assert.match(st.defaultFile({}), /\.claude[\\/]dynamic-fanout[\\/]routing-stats\.json$/);
  });
});
