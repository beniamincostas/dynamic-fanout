#!/usr/bin/env node
// check-evidence.mjs — Phase-3 deterministic quote audit for a dynamic-fanout run.
//
// Usage: node scripts/check-evidence.mjs <workflow-output.json> [--root <dir>] [--write <patched.json>] [--json]
//
// For every results.claims[].evidence {file, line, quote}: resolved when the quote is an
// exact substring of lines [line-3, line+3] (1-based), else when it matches with whitespace
// collapsed in that window. A quote found only elsewhere in the file reports `foundAt` but
// stays unresolved (a drifted line is not grounded evidence).
// REFUTED verdicts: an unresolved counter_quote downgrades REFUTED -> PLAUSIBLE.
// CONFIRMED / PLAUSIBLE with any unresolved evidence quote -> UNVERIFIED (reason 'evidence').
// A downgraded claim gets verdictBy 'check-evidence', a reason naming the failed quotes, and
// keeps the verifier's verdict/reason/verdictBy in verdictBeforeAudit / reasonBeforeAudit /
// verdictByBeforeAudit. Input: the Workflow output file ({summary, agentCount, logs, result})
// or fanout.js's RESULT itself; claims are read from results.claims (PENDING claims of a
// stage:'work' run are audited but never change verdict).
// DOWNGRADE-ONLY: this script never raises a verdict and never launches agents.
// Zero dependencies; Node >= 20.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const WINDOW = 3;

// Verdict strength, used to enforce downgrade-only. REFUTED sits beside CONFIRMED:
// both are verifier-backed; losing the counter-quote drops REFUTED to PLAUSIBLE.
const RANK = { CONFIRMED: 3, REFUTED: 3, PLAUSIBLE: 2, UNVERIFIABLE: 1, UNVERIFIED: 1 };

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

export const collapse = (s) => String(s).replace(/\s+/g, ' ').trim();

/** Split "path/x.py:42" into {file, line} when no explicit line was given. */
function splitFileLine(file, line) {
  if (line == null && typeof file === 'string') {
    const m = file.match(/^(.*?):(\d+)(?:-\d+)?$/);
    if (m) return { file: m[1], line: Number(m[2]) };
  }
  return { file, line };
}

/**
 * Check one quote against file text.
 * @returns {{resolved:boolean, how:'exact'|'normalised'|null, foundAt:number|null, error?:string}}
 */
export function checkQuote(text, line, quote) {
  if (typeof quote !== 'string' || !quote.trim()) {
    return { resolved: false, how: null, foundAt: null, error: 'no-quote' };
  }
  const lines = text.split(/\r?\n/);
  const n = Number(line);
  if (Number.isInteger(n) && n >= 1) {
    const lo = Math.max(1, n - WINDOW);
    const hi = Math.min(lines.length, n + WINDOW);
    if (lo <= hi) {
      const win = lines.slice(lo - 1, hi).join('\n');
      if (win.includes(quote)) return { resolved: true, how: 'exact', foundAt: null };
      const q = collapse(quote);
      if (q && collapse(win).includes(q)) return { resolved: true, how: 'normalised', foundAt: null };
    }
  }
  return { resolved: false, how: null, foundAt: findElsewhere(lines, quote), error: Number.isInteger(n) && n >= 1 ? undefined : 'no-line' };
}

/** First 1-based line where the (whitespace-collapsed) quote begins, or null. */
export function findElsewhere(lines, quote) {
  const q = collapse(quote);
  if (!q) return null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(quote)) return i + 1;
  }
  // Multi-line or whitespace-shifted quote: slide a window as tall as the quote (+1 slack).
  const height = String(quote).split(/\r?\n/).length + 1;
  for (let i = 0; i < lines.length; i++) {
    if (collapse(lines.slice(i, i + height).join('\n')).includes(q)) return i + 1;
  }
  return null;
}

/** Resolve one evidence record {file, line, quote} under root. */
export function checkEvidence(ev, root, cache = new Map()) {
  if (!ev || typeof ev !== 'object') return { file: null, line: null, resolved: false, foundAt: null, error: 'malformed' };
  const { file, line } = splitFileLine(ev.file ?? ev.path, ev.line);
  const quote = ev.quote ?? ev.text;
  const base = { file: file ?? null, line: line ?? null };
  if (!file) return { ...base, resolved: false, foundAt: null, error: 'no-file' };
  const abs = path.isAbsolute(file) ? file : path.join(root, file);
  let text = cache.get(abs);
  if (text === undefined) {
    try { text = fs.readFileSync(abs, 'utf8'); } catch { text = null; }
    cache.set(abs, text);
  }
  if (text === null) return { ...base, resolved: false, foundAt: null, error: 'missing-file' };
  return { ...base, ...checkQuote(text, line, quote) };
}

function asList(ev) {
  if (ev == null) return [];
  return Array.isArray(ev) ? ev : [ev];
}

/** A string counter_quote has no location: grounded if it appears in any evidence file. */
function checkCounterQuote(cq, claim, root, cache) {
  if (cq && typeof cq === 'object') return checkEvidence(cq, root, cache);
  if (typeof cq === 'string' && cq.trim()) {
    for (const ev of asList(claim.evidence)) {
      const r = checkEvidence({ file: ev?.file, line: null, quote: cq }, root, cache);
      if (r.foundAt != null) return { file: r.file, line: r.foundAt, resolved: true, how: 'unlocated', foundAt: r.foundAt };
    }
    return { file: null, line: null, resolved: false, foundAt: null, error: 'unlocated' };
  }
  return { file: null, line: null, resolved: false, foundAt: null, error: 'missing' };
}

/** One line naming the quotes that did not resolve, e.g. "src/a.py:3 quote not found (it is at line 9)". */
function reasonText(code, evid, cq) {
  const where = (e) => {
    const loc = `${e.file ?? '?'}:${e.line ?? '?'}`;
    if (e.foundAt != null) return `${loc} quote not at the cited line (it is at line ${e.foundAt})`;
    return `${loc} ${e.error === 'missing-file' ? 'file not found' : e.error === 'no-quote' ? 'no quote given' : 'quote not found'}`;
  };
  const parts = [];
  if (cq && !cq.resolved) parts.push(`counter_quote ${cq.error === 'missing' ? 'missing' : where(cq)}`);
  if (code === 'evidence') parts.push(...evid.filter((e) => !e.resolved).map(where));
  return parts.join('; ') || code;
}

const lower = (from, to) => (RANK[to] ?? 0) < (RANK[from] ?? 0) || (from === 'REFUTED' && to === 'PLAUSIBLE');

/**
 * Audit every claim. Pure apart from file reads; returns {report, claims} where claims is a
 * patched deep copy. Never raises a verdict.
 */
export function audit(result, { root = process.cwd() } = {}) {
  const cache = new Map();
  const src = result?.results?.claims;
  const claims = Array.isArray(src) ? structuredClone(src) : [];
  const report = { claims: 0, quotes: 0, resolved: 0, counterQuotes: 0, counterResolved: 0, downgrades: [], items: [] };

  for (const c of claims) {
    report.claims++;
    const before = c.verdict ?? null;
    const evid = asList(c.evidence).map((ev) => checkEvidence(ev, root, cache));
    report.quotes += evid.length;
    report.resolved += evid.filter((e) => e.resolved).length;
    const item = { cid: c.cid ?? null, unit: c.unit ?? null, before, after: before, evidence: evid };

    let verdict = before;
    let reason = null;
    if (verdict === 'REFUTED') {
      const cq = checkCounterQuote(c.counter_quote, c, root, cache);
      item.counterQuote = cq;
      report.counterQuotes++;
      if (cq.resolved) report.counterResolved++;
      else { verdict = 'PLAUSIBLE'; reason = 'counter_quote'; }
    }
    if ((verdict === 'CONFIRMED' || verdict === 'PLAUSIBLE') && evid.some((e) => !e.resolved)) {
      verdict = 'UNVERIFIED';
      reason = 'evidence';
    }
    if (verdict !== before && lower(before, verdict)) {
      c.verdictBeforeAudit = before;
      // Keep what the verifier said: the master reports every UNVERIFIED item with its reason.
      c.reasonBeforeAudit = c.reason ?? null;
      c.verdictByBeforeAudit = c.verdictBy ?? null;
      c.verdict = verdict;
      c.reason = `check-evidence: ${reasonText(reason, evid, item.counterQuote)}`;
      c.verdictBy = 'check-evidence';
      item.after = verdict;
      item.reason = reason;
      report.downgrades.push({ cid: item.cid, from: before, to: verdict, reason });
    }
    report.items.push(item);
  }
  report.pctResolved = report.quotes ? Math.round((1000 * report.resolved) / report.quotes) / 10 : 100;
  return { report, claims };
}

/** Return a patched copy of the whole document (wrapper kept) with claims, top[] and counts updated. */
export function patchOutput(doc, claims, report) {
  const out = structuredClone(doc);
  const res = out && 'result' in out && !('digest' in out) && !('results' in out)
    ? (typeof out.result === 'string' ? (out.result = JSON.parse(out.result)) : out.result)
    : out;
  if (!res.results) res.results = {};
  res.results.claims = claims;
  const byCid = new Map(claims.map((c) => [c.cid, c]));
  const d = res.digest;
  if (d) {
    if (Array.isArray(d.top)) for (const t of d.top) if (byCid.has(t.cid)) t.verdict = byCid.get(t.cid).verdict;
    if (d.counts) {
      const k = (v) => claims.filter((c) => c.verdict === v).length;
      d.counts.confirmed = k('CONFIRMED');
      d.counts.plausible = k('PLAUSIBLE');
      d.counts.refuted = k('REFUTED');
      d.counts.unverifiedClaims = claims.filter((c) => c.verdict === 'UNVERIFIED' || c.verdict === 'UNVERIFIABLE').length;
    }
  }
  res.evidenceAudit = {
    claims: report.claims, quotes: report.quotes, resolved: report.resolved, pctResolved: report.pctResolved,
    counterQuotes: report.counterQuotes, counterResolved: report.counterResolved, downgrades: report.downgrades,
  };
  return out;
}

export function formatSummary(report) {
  const lines = [
    `check-evidence: ${report.claims} claims, quotes resolved ${report.resolved}/${report.quotes} (${report.pctResolved}%)` +
      (report.counterQuotes ? `, counter-quotes ${report.counterResolved}/${report.counterQuotes}` : ''),
  ];
  if (!report.downgrades.length) lines.push('downgrades: none');
  else {
    lines.push(`downgrades: ${report.downgrades.length}`);
    for (const d of report.downgrades) lines.push(`  ${d.cid}: ${d.from} -> ${d.to} (${d.reason})`);
  }
  const bad = report.items.flatMap((it) => it.evidence.filter((e) => !e.resolved).map((e) => ({ cid: it.cid, ...e })));
  for (const b of bad.slice(0, 10)) {
    const where = b.foundAt != null ? `found at line ${b.foundAt}` : b.error ?? 'not found';
    lines.push(`  unresolved ${b.cid}: ${b.file ?? '?'}:${b.line ?? '?'} (${where})`);
  }
  if (bad.length > 10) lines.push(`  ... ${bad.length - 10} more (use --json)`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const a = { input: null, root: process.cwd(), write: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--root') a.root = argv[++i];
    else if (t === '--write') a.write = argv[++i];
    else if (t === '--json') a.json = true;
    else if (t === '-h' || t === '--help') a.help = true;
    else if (!a.input) a.input = t;
  }
  return a;
}

export function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  if (a.help || !a.input) {
    console.log('usage: node scripts/check-evidence.mjs <workflow-output.json> [--root <dir>] [--write <patched.json>] [--json]');
    return a.help ? 0 : 2;
  }
  let doc;
  try { doc = JSON.parse(fs.readFileSync(a.input, 'utf8')); } catch (e) {
    console.error(`check-evidence: cannot read ${a.input}: ${e.message}`);
    return 2;
  }
  const result = unwrap(doc);
  if (!result || typeof result !== 'object') {
    console.error('check-evidence: no RESULT object found in input');
    return 2;
  }
  const { report, claims } = audit(result, { root: path.resolve(a.root) });
  if (a.write) {
    fs.mkdirSync(path.dirname(path.resolve(a.write)), { recursive: true });
    fs.writeFileSync(a.write, JSON.stringify(patchOutput(doc, claims, report), null, 2) + '\n');
  }
  console.log(a.json ? JSON.stringify(report, null, 2) : formatSummary(report));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main();
