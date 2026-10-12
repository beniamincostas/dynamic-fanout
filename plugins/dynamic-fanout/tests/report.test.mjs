// Tests for scripts/report.mjs
// Run: node --test plugins/dynamic-fanout/tests/report.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as rpt from '../scripts/report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'scripts', 'report.mjs');
const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

const RESULT = {
  started: true,
  card: {
    kind: 'review',
    units: [
      { id: 'u1', role: 'review', cell: 'opus·medium' },
      { id: 'u2', role: 'review', cell: 'sonnet·high' },
    ],
  },
  ledger: {
    units: [
      { id: 'u1', outcome: 'ok' },
      { id: 'u2', outcome: 'unverified' },
    ],
  },
  digest: {
    counts: { units: 2, ok: 1, okRerouted: 0, okPromoted: 0, confirmed: 1, plausible: 0, refuted: 1, unverifiedClaims: 0, pending: 0 },
    money: { U: 10, P: 4, committedUsd: 3.5 },
  },
  results: {
    units: {
      u1: { status: 'complete', summary: 'reviewed billing.py', files_read: ['src/billing.py'], assumptions: ['a1', 'a2', 'a3', 'a4'], result: { ok: true, n: 1 } },
      u2: { status: 'blocked', summary: 'could not reach file', files_read: [], assumptions: [], result: null },
    },
    claims: [
      { cid: 'u1.f1', unit: 'u1', severity: 'high', title: 'tax rounding off by one', verdict: 'CONFIRMED', rung: 'V3', evidence: [{ file: 'src/billing.py', line: 8, quote: 'x' }], reason: 'grounded' },
      { cid: 'u1.f2', unit: 'u1', severity: 'low', title: 'minor nit', verdict: 'REFUTED', rung: 'V2', verifiedSeverity: 'info', evidence: [{ file: 'src/billing.py', line: 20 }], reason: 'no repro' },
    ],
  },
};

function tmpJson(obj) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'df-report-')), 'out.json');
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}

test('build: unwraps the Workflow wrapper and reads card/ledger/results', () => {
  const rep = rpt.build({ summary: 's', agentCount: 1, logs: [], result: JSON.stringify(RESULT) });
  assert.equal(rep.header.kind, 'review');
  assert.deepEqual(rep.header.units, { ok: 1, total: 2 });
  assert.equal(rep.units.length, 2);
  const u1 = rep.units.find((u) => u.id === 'u1');
  assert.equal(u1.role, 'review');
  assert.equal(u1.cell, 'opus·medium');
  assert.equal(u1.outcome, 'ok');
  assert.equal(u1.assumptions.length, 3, 'trimmed to at most 3 assumptions');
  assert.equal(u1.files_read, 1);
  assert.equal(rep.claims.length, 2);
});

test('build: also accepts the raw RESULT object directly (no wrapper)', () => {
  const rep = rpt.build(RESULT);
  assert.equal(rep.units.length, 2);
});

test('build: --unit filters to one unit and its claims', () => {
  const rep = rpt.build(RESULT, { unit: 'u2' });
  assert.deepEqual(rep.units.map((u) => u.id), ['u2']);
  assert.equal(rep.claims.length, 0);
});

test('build: --min-severity keeps that severity and above', () => {
  const rep = rpt.build(RESULT, { minSeverity: 'high' });
  assert.deepEqual(rep.claims.map((c) => c.cid), ['u1.f1']);
});

test('build: --verdict filters case-insensitively', () => {
  const rep = rpt.build(RESULT, { verdicts: ['refuted'] });
  assert.deepEqual(rep.claims.map((c) => c.cid), ['u1.f2']);
});

test('build: claims sort by severity descending', () => {
  const rep = rpt.build(RESULT);
  assert.deepEqual(rep.claims.map((c) => c.cid), ['u1.f1', 'u1.f2']);
});

test('build: --payload keeps the full result, otherwise it is a trimmed one-line JSON string', () => {
  const trimmed = rpt.build(RESULT);
  assert.equal(typeof trimmed.units.find((u) => u.id === 'u1').result, 'string');
  const full = rpt.build(RESULT, { payload: true });
  assert.deepEqual(full.units.find((u) => u.id === 'u1').result, { ok: true, n: 1 });
});

test('build: never throws on a missing or malformed doc', () => {
  assert.doesNotThrow(() => rpt.build({}));
  assert.doesNotThrow(() => rpt.build(null));
  assert.doesNotThrow(() => rpt.build({ results: { claims: [{}] } }));
});

test('formatText: includes header counts and a claim line with file:line', () => {
  const text = rpt.formatText(rpt.build(RESULT));
  assert.match(text, /1\/2 units ok/);
  assert.match(text, /u1\.f1/);
  assert.match(text, /src\/billing\.py:8/);
});

test('CLI: --json on a file prints the same shape build() returns', () => {
  const file = tmpJson(RESULT);
  const r = run([file, '--json']);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.deepEqual(parsed, rpt.build(RESULT));
});

test('CLI: no file prints usage and exits 2', () => {
  const r = run([]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /usage: node scripts\/report\.mjs/);
});

test('CLI: an unreadable file warns and exits 0', () => {
  const r = run(['/no/such/file.json']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /warning: report failed/);
});
