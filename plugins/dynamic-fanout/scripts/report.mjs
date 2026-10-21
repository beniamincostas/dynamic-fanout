#!/usr/bin/env node
// report.mjs — compact human/CLI view of a dynamic-fanout run, so the master does not have to
// dig claims and unit payloads out of the raw result JSON by hand.
//
// Usage: node scripts/report.mjs <output.json|audited.json> [--unit <id>]
//   [--min-severity info|low|medium|high|blocker] [--verdict CONFIRMED,PLAUSIBLE,...]
//   [--payload] [--json]
//
// Input: the Workflow output file ({summary, agentCount, logs, result}) or fanout.js's RESULT
// itself. results.units is an object keyed by unit id, results.claims an array; card.units
// supplies each unit's role + cell, ledger.units each unit's outcome.
// --unit filters to one unit id (its claims + its row). --min-severity keeps that severity and
// above. --verdict keeps only the listed verdicts (comma-separated, case-insensitive).
// --payload prints each unit's result payload in full instead of trimmed to 600 chars.
// Claim severity prints as filed->verified when the skeptic re-rated it; the header counts and
// the sort use verifiedSeverity ?? severity (--min-severity filters on the filed severity).
// --json emits the same structure (header, units, claims) as JSON instead of text.
// Never throws on missing fields; a malformed or partial doc still prints what it has.
// Zero dependencies; Node >= 20.

import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

const SEVERITIES = ['info', 'low', 'medium', 'high', 'blocker'];
const sevRank = (s) => Math.max(0, SEVERITIES.indexOf(s));
// The skeptic's rating when it has one, else the filed severity (fanout.js stores both).
const effSev = (c) => c.verifiedSeverity || c.severity;
export const LEGEND = 'PLAUSIBLE = grounded, not independently re-checked (in a blind audit plausible and confirmed findings were equally often true)';

/** Accept either the Workflow wrapper {summary, agentCount, logs, result} or RESULT itself. */
export function unwrap(doc) {
  if (doc && typeof doc === 'object' && 'result' in doc && !('digest' in doc) && !('results' in doc)) {
    let r = doc.result;
    if (typeof r === 'string') {
      try { r = JSON.parse(r); } catch { /* leave as string */ }
    }
    return r;
  }
  return doc;
}

function oneLine(x, max) {
  let s;
  try { s = JSON.stringify(x); } catch { s = String(x); }
  if (s === undefined) s = 'null';
  return !max || s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** Build the report's plain-object shape (used by both text and --json output). */
export function build(doc, opts = {}) {
  const r = unwrap(doc) || {};
  const digest = r.digest || {};
  const card = r.card || {};
  const results = r.results || {};
  const ledger = r.ledger || {};
  const cardById = new Map((card.units || []).map((u) => [u.id, u]));
  const ledgerById = new Map((ledger.units || []).map((u) => [u.id, u]));
  const resultsUnits = results.units && typeof results.units === 'object' ? results.units : {};

  let unitIds = Object.keys(resultsUnits);
  if (!unitIds.length && card.units) unitIds = card.units.map((u) => u.id);
  if (opts.unit) unitIds = unitIds.filter((id) => id === opts.unit);

  const units = unitIds.map((id) => {
    const res = resultsUnits[id] || {};
    const c = cardById.get(id) || {};
    const l = ledgerById.get(id) || {};
    return {
      id, role: c.role || null, cell: c.cell || null, outcome: l.outcome || null, status: res.status || null,
      summary: res.summary || null, assumptions: (res.assumptions || []).slice(0, 3), files_read: (res.files_read || []).length,
      result: opts.payload ? (res.result ?? null) : oneLine(res.result ?? null, 600),
    };
  });

  const minRank = sevRank(opts.minSeverity || 'info');
  const verdictFilter = opts.verdicts && opts.verdicts.length ? new Set(opts.verdicts.map((v) => String(v).toUpperCase())) : null;
  const allClaims = Array.isArray(results.claims) ? results.claims : [];
  let claims = allClaims.slice();
  if (opts.unit) claims = claims.filter((c) => c.unit === opts.unit);
  claims = claims.filter((c) => sevRank(c.severity) >= minRank);
  if (verdictFilter) claims = claims.filter((c) => verdictFilter.has(String(c.verdict || '').toUpperCase()));
  claims.sort((a, b) => sevRank(effSev(b)) - sevRank(effSev(a)));

  const header = {
    kind: card.kind || null,
    units: { ok: (digest.counts && (digest.counts.ok + digest.counts.okRerouted + digest.counts.okPromoted)) || 0, total: (digest.counts && digest.counts.units) || unitIds.length },
    claimsByVerdict: digest.counts
      ? { confirmed: digest.counts.confirmed || 0, plausible: digest.counts.plausible || 0, refuted: digest.counts.refuted || 0, unverified: digest.counts.unverifiedClaims || 0, pending: digest.counts.pending || 0 }
      : null,
    // Counted by verifiedSeverity ?? severity over every claim, before the display filters.
    claimsBySeverity: Object.fromEntries(SEVERITIES.slice().reverse().map((sv) => [sv, allClaims.filter((c) => effSev(c) === sv).length])),
    money: digest.money ? { U: digest.money.U, P: digest.money.P, committed: digest.money.committedUsd } : null,
  };

  return { header, units, claims };
}

function formatClaim(c) {
  const e = (c.evidence || [])[0] || {};
  const sev = c.verifiedSeverity && c.verifiedSeverity !== c.severity ? `${c.severity}->${c.verifiedSeverity}` : c.severity || '?';
  const verdict = `${c.verdict || 'PENDING'}${c.rung ? `(${c.rung})` : ''}`;
  const loc = e.file ? `${e.file}:${e.line ?? '?'}` : '(no evidence)';
  const line = `  ${c.cid || '?'}  ${sev}  ${verdict}  ${c.title || ''} — ${loc} — ${c.reason || ''}`.replace(/\s+—\s*$/, '');
  // Merged duplicates keep their own titles, so a wrong merge is visible here.
  const merged = Array.isArray(c.merged) && c.merged.length
    ? `\n      merged: ${c.merged.map((m) => `${m.cid || '?'} ${m.title || ''}`.trim()).join('; ')}`
    : '';
  return line + merged;
}

export function formatText(rep) {
  const lines = [];
  const h = rep.header;
  lines.push(`report: ${h.kind || '?'} — ${h.units.ok}/${h.units.total} units ok`
    + (h.claimsByVerdict ? ` — claims: ${h.claimsByVerdict.confirmed} confirmed / ${h.claimsByVerdict.plausible} plausible / ${h.claimsByVerdict.refuted} refuted / ${h.claimsByVerdict.unverified} unverified` : '')
    + (h.claimsBySeverity && Object.values(h.claimsBySeverity).some(Boolean) ? ` — ${Object.entries(h.claimsBySeverity).map(([k, v]) => `${v} ${k}`).join(' / ')}` : '')
    + (h.money ? ` — money U $${h.money.U} P $${h.money.P} committed $${h.money.committed}` : ''));
  if (rep.units.length) {
    lines.push('units:');
    for (const u of rep.units) {
      lines.push(`  ${u.id}  ${u.role || '?'}  ${u.cell || '?'}  ${u.outcome || '?'}/${u.status || '?'}  ${u.summary || ''}`);
      if (u.assumptions.length) lines.push(`    assumptions: ${u.assumptions.join('; ')}`);
      // --payload keeps the result as an object: print it as JSON, never „[object Object]“
      const result = u.result !== null && typeof u.result === 'object'
        ? JSON.stringify(u.result, null, 2).replace(/\n/g, '\n      ') : u.result;
      lines.push(`    files_read: ${u.files_read}  result: ${result}`);
    }
  }
  if (rep.claims.length) {
    lines.push('claims:');
    lines.push(`  ${LEGEND}`);
    for (const c of rep.claims) lines.push(formatClaim(c));
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const opts = { json: false, payload: false, verdicts: null, minSeverity: null, unit: null };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--payload') opts.payload = true;
    else if (a === '--unit') opts.unit = argv[++i];
    else if (a === '--min-severity') opts.minSeverity = argv[++i];
    else if (a === '--verdict') opts.verdicts = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (!a.startsWith('--')) pos.push(a);
  }
  opts.file = pos[0];
  return opts;
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (!opts.file) {
    console.log('usage: node scripts/report.mjs <output.json|audited.json> [--unit <id>] [--min-severity info|low|medium|high|blocker] [--verdict CONFIRMED,PLAUSIBLE,...] [--payload] [--json]');
    return 2;
  }
  let doc;
  try { doc = JSON.parse(fs.readFileSync(opts.file, 'utf8')); } catch (e) {
    console.log(`warning: report failed to read/parse ${opts.file} (${e.message})`);
    return 0;
  }
  const rep = build(doc, opts);
  console.log(opts.json ? JSON.stringify(rep, null, 2) : formatText(rep));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main();
