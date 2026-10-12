#!/usr/bin/env node
// stats.mjs — cross-run routing stats for dynamic-fanout. Sole writer of routing-stats.json.
//
// Usage:
//   node scripts/stats.mjs update <workflow-output.json> [--file <stats.json>] [--kind <k>] [--verify <verify-stage-output.json>] [--ledger <ledger-cost.mjs --json output>]
//   node scripts/stats.mjs --summary <kind> [--file <stats.json>]
//
// Self-calibration (per role, keyed by price model): pass --ledger <ledger-cost.mjs --json
// output>. Its `byKind` totals give each role's actual $ — work (unit attempts + the deep
// completeness critic), sweep (gap-sweep rounds), verify (verifier batches), inspect
// (inspector calls) — and the foreman's own workflow-output ledger gives each role's estimate.
// ratio = actual/estimate, clamped to [0.1, 10]; used = card.calib.scaleByRole[role] (1 when
// absent) x card.calib.scale (1 when absent) is the factor the run actually priced with, so
// target = used x ratio is what the factor should have been. It folds into
// stats.calib.scaleByRole[role] as an EWMA (alpha 0.5); a role's first observation under a
// price model blends from `used` (0.5 x target + 0.5 x used) instead of replacing it outright.
//
// Learned factors only hold for the price model (card.calib.pm, the foreman's PRICE_MODEL)
// they were learned under. When a run's pm differs from stats.calib.pm (or the stored calib has
// none — the old global calib.scale era), the old calib moves to stats.calibArchive[<old pm or
// 'legacy'>] and calibration starts fresh. A run whose card carries no pm, or a --ledger file
// without byKind, feeds no calibration; the update line says why. `--summary` prints
// `CALIB {"pm":N,"scaleByRole":{...}}` (plus one line telling the master to pass it back as
// args.calib) only when stats.calib.pm is the current PRICE_MODEL — never a legacy global scale.
// applyCalibration (the old global scale) stays exported for compatibility; the CLI no longer calls it.
//
// Default file: $DYNAMIC_FANOUT_STATS, else ~/.claude/dynamic-fanout/routing-stats.json.
// Cohort key: kind/role/D<d>V<v>B<b>T<t>/<cell of p>/<ctx>
//   -> {n, firstPassOk, rerouted, refutedLater, ungroundedLater, unverified, conf:{hi:{n,ok}, lo:{n,ok}}, fb:{cell:n}}
// Every counter decays x0.9 before a run is added, so old runs fade.
// Labels use the FINAL outcome: a unit that passed the gate but had a claim REFUTED later
// counts against its primary cell (merged duplicates via mergedFrom included). A claim that
// check-evidence.mjs downgraded to UNVERIFIED (verdictBy 'check-evidence' — invented or
// drifted quotes) is NOT a REFUTED verdict, so on its own it would silently still count as
// firstPassOk; such a unit is labelled 'ungroundedLater' instead. Skipped: 'ok-promoted'
// units (never ran p) and units whose p never returned a result (refused by the meter before
// launch, or infra-only). The confidence split ignores units whose stored result came from a
// launched re-route. Reads the foreman's real shapes: card.S top-level, ledger.units[].p / .fb
// already cell strings ('sonnet·medium'). An output with no unit that ran p (a stage:'verify'
// run) is not recorded, so it cannot decay the file.
//
// Deep runs split 'work' (claims PENDING, has ledger.units) and 'verify' (has verdicts, no
// ledger.units) into two outputs — neither alone carries both the units and the verdicts that
// refutedLater/ungroundedLater need. Pass --verify <verify-stage-output.json> alongside the
// work-stage <workflow-output.json> to merge the verify output's claim verdicts (by cid) into
// the work output before labelling, so a deep run's claims are judged on their real outcome.
//
// The stats only inform the master's judgement; code never routes from them.
// Probing (routing cheaper on purpose) is deferred to v0.2, so there is no probe rule.
// Zero dependencies; Node >= 20.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const DECAY = 0.9;
export const MAX_RUNS = 50;
export const CONF_HI = 0.7;
export const RULES = { promoteN: 4, promoteBelow: 0.8, reserveN: 4, confMinN: 4, confGap: 0.1, envelope: 0.6, showN: 2 };
export const CALIB_ALPHA = 0.5;
export const CALIB_MIN = 0.3;
export const CALIB_MAX = 5;
// Keep equal to PRICE_MODEL in workflows/fanout.js (a test checks it).
export const PRICE_MODEL = 3;
export const ROLES = ['work', 'verify', 'inspect', 'sweep'];
export const ROLE_CALIB_MIN = 0.1;
export const ROLE_CALIB_MAX = 10;

export function defaultFile(env = process.env) {
  return env.DYNAMIC_FANOUT_STATS || path.join(os.homedir(), '.claude', 'dynamic-fanout', 'routing-stats.json');
}

export function emptyStats() {
  return { v: 1, cohorts: {}, runs: [] };
}

export function loadStats(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (s && typeof s === 'object' && s.cohorts && Array.isArray(s.runs)) return s;
  } catch { /* missing or corrupt -> start fresh */ }
  return emptyStats();
}

/** Atomic write: temp file + rename, so a crash never leaves half a file. */
export function saveStats(file, stats) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(stats, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function unwrap(doc) {
  if (doc && typeof doc === 'object' && 'result' in doc && !('digest' in doc) && !('results' in doc)) {
    let r = doc.result;
    if (typeof r === 'string') {
      try { r = JSON.parse(r); } catch { /* leave */ }
    }
    return r;
  }
  return doc;
}

/**
 * Merge a stage:'verify' RESULT's claim verdicts (by cid) into a stage:'work' RESULT, so a
 * deep run's two outputs can be labelled as one. The work result's claims start PENDING; the
 * verify result carries the real verdict/verdictBy/reason/counter_quote but no ledger.units.
 * Pure: returns a new result object, the inputs are not mutated. Unknown cids (present only
 * on one side) are left as-is.
 */
export function mergeVerifyClaims(workResult, verifyResult) {
  const byCid = new Map((verifyResult?.results?.claims ?? []).map((c) => [c.cid, c]));
  const claims = (workResult?.results?.claims ?? []).map((c) => {
    const v = byCid.get(c.cid);
    if (!v) return c;
    return {
      ...c,
      verdict: v.verdict ?? c.verdict,
      verdictBy: v.verdictBy ?? c.verdictBy ?? null,
      reason: v.reason ?? c.reason ?? null,
      counter_quote: v.counter_quote ?? c.counter_quote ?? null,
      verifiedSeverity: v.verifiedSeverity ?? c.verifiedSeverity ?? null,
      mergedFrom: v.mergedFrom ?? c.mergedFrom ?? null,
    };
  });
  return { ...workResult, results: { ...workResult?.results, claims } };
}

/** 'D2 A1 T1 C1 V0 B2 G2' -> 'D2V0B2T1' (missing features shown as '?'). */
export function vecKey(vec) {
  const f = {};
  for (const m of String(vec ?? '').matchAll(/([DATCVBG])\s*([0-2])/g)) f[m[1]] = m[2];
  return `D${f.D ?? '?'}V${f.V ?? '?'}B${f.B ?? '?'}T${f.T ?? '?'}`;
}

/**
 * Cell string 'opus·high'. The foreman's ledger already stores cells as strings
 * ('sonnet·medium', 'haiku'), which pass through unchanged; a {model?, effort} object
 * (a card's p/fb as the master wrote it) is rendered with the model defaulting to S.
 */
export function cellOf(c, S) {
  if (!c) return 'null';
  if (typeof c === 'string') return c;
  const model = c.model ?? S ?? 'S';
  if (model === 'haiku') return 'haiku';
  return c.effort ? `${model}·${c.effort}` : model;
}

const newCohort = () => ({ n: 0, firstPassOk: 0, rerouted: 0, refutedLater: 0, ungroundedLater: 0, unverified: 0, conf: { hi: { n: 0, ok: 0 }, lo: { n: 0, ok: 0 } }, fb: {} });

/** Multiply every numeric counter in place (recursively). */
export function decay(obj, f = DECAY) {
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'number') obj[k] = v * f;
    else if (v && typeof v === 'object') decay(v, f);
  }
  return obj;
}

/**
 * Label each unit of one RESULT by its final outcome. Pure.
 * @returns {Array<{key, id, label, refuted, conf, fbCell}>}
 */
/** Did p (or its same-cell infra retry) actually produce a result? Refused/infra-only units never did. */
function ranPrimary(u) {
  if (/^infra:/.test(String(u.reason ?? ''))) return false;   // no result after the infra retry
  if (!Array.isArray(u.attempts)) return true;
  return u.attempts.some((a) => a && a.kind !== 'reroute' && a.kind !== 'rederive-planned' && a.cls !== 'refused' && a.cls !== 'infra');
}

/** True when a re-route actually launched, so results.units[id] holds the fallback's output. */
function rerouteLaunched(u) {
  return Array.isArray(u.attempts) && u.attempts.some((a) => a && a.kind === 'reroute' && a.cls !== 'refused');
}

export function labelUnits(result, kindArg) {
  const kind = kindArg ?? result?.card?.kind ?? result?.kind ?? 'unknown';
  // fanout.js puts S at the top of the card (card.S); card.session.S is accepted for older files.
  const S = result?.card?.S ?? result?.card?.session?.S ?? result?.session?.S;
  const units = result?.ledger?.units ?? [];
  const claims = result?.results?.claims ?? [];
  const resUnits = result?.results?.units ?? {};
  const ids = new Set(units.map((u) => u?.id));
  // Dedup merges same-location claims into the first one and lists the rest in mergedFrom
  // (cids '<unit>.f<n>'), so a REFUTED merged claim counts against every unit that made it.
  const refutedUnits = new Set();
  // A claim check-evidence.mjs downgraded to UNVERIFIED (invented or drifted evidence) is not
  // a REFUTED verdict, so it needs its own signal: the gate passed on evidence that does not
  // actually ground the finding.
  const ungroundedUnits = new Set();
  for (const c of claims) {
    const toUnits = (set) => {
      set.add(c.unit);
      for (const cid of c.mergedFrom ?? []) {
        const m = /^(.*)\.f\d+$/.exec(String(cid));
        if (m && ids.has(m[1])) set.add(m[1]);
      }
    };
    if (c?.verdict === 'REFUTED') toUnits(refutedUnits);
    else if (c?.verdictBy === 'check-evidence' && c?.verdict === 'UNVERIFIED') toUnits(ungroundedUnits);
  }
  const out = [];
  for (const u of units) {
    if (!u || u.outcome === 'ok-promoted') continue;           // never ran p
    if (!ranPrimary(u)) continue;                              // refused before launch (budget) or infra only
    const refuted = refutedUnits.has(u.id);
    const ungrounded = !refuted && ungroundedUnits.has(u.id);
    let label;
    switch (u.outcome) {
      case 'ok': label = refuted ? 'refutedLater' : ungrounded ? 'ungroundedLater' : 'firstPassOk'; break;
      case 'ok-rerouted': label = 'rerouted'; break;
      case 'unverified': label = 'unverified'; break;
      default: label = u.outcome ?? 'unknown'; // 'brief': counted in n, not ok
    }
    // After a launched re-route the stored result (and its confidence) is the fallback's,
    // so it says nothing about how well p's self-confidence predicts p's success.
    const confidence = rerouteLaunched(u) ? null : resUnits?.[u.id]?.confidence;
    const key = [kind, u.role ?? '?', vecKey(u.vec), cellOf(u.p, S), u.ctx ?? 'omit'].join('/');
    out.push({ key, id: u.id, label, refuted, conf: typeof confidence === 'number' ? confidence : null, fbCell: u.fb ? cellOf(u.fb, S) : null });
  }
  return { kind, labels: out };
}

/** Fold one RESULT into stats (mutates and returns stats). Decays first. */
export function applyRun(stats, result, { kind: kindArg, runId, now = new Date() } = {}) {
  for (const c of Object.values(stats.cohorts)) decay(c);
  const { kind, labels } = labelUnits(result, kindArg);
  for (const l of labels) {
    const c = (stats.cohorts[l.key] ??= newCohort());
    c.n += 1;
    if (l.label === 'firstPassOk') c.firstPassOk += 1;
    if (l.label === 'refutedLater') c.refutedLater += 1;
    if (l.label === 'ungroundedLater') c.ungroundedLater += 1;
    if (l.label === 'rerouted') c.rerouted += 1;
    if (l.label === 'unverified') c.unverified += 1;
    if (l.conf != null) {
      const b = l.conf >= CONF_HI ? c.conf.hi : c.conf.lo;
      b.n += 1;
      if (l.label === 'firstPassOk') b.ok += 1;
    }
    if (l.fbCell) c.fb[l.fbCell] = (c.fb[l.fbCell] ?? 0) + 1;
  }
  const money = result?.digest?.money ?? {};
  stats.runs.push({
    id: runId ?? null, at: now.toISOString(), kind,
    units: labels.length,
    reroutes: result?.ledger?.reroutes ?? labels.filter((l) => l.label === 'rerouted').length,
    U: money.U ?? null, P: money.P ?? null, committedUsd: money.committedUsd ?? null,
  });
  if (stats.runs.length > MAX_RUNS) stats.runs = stats.runs.slice(-MAX_RUNS);
  return stats;
}

/** This run's estimate, the same two figures the master's done-line reports. */
export function estimatedUsdOf(result) {
  const m = result?.digest?.money ?? {};
  return (Number(m.committedUsd) || 0) + (Number(m.rerouteUsd) || 0);
}

/**
 * Fold one (actualUsd, estimatedUsd) observation into stats.calib (mutates and returns
 * stats). A no-op when estimatedUsd <= 0 — nothing to compare the actual against. ratio is
 * clamped to [CALIB_MIN, CALIB_MAX] before it enters the EWA, so one odd run can't swing
 * calib.scale too far in one step.
 */
export function applyCalibration(stats, { actualUsd, estimatedUsd }) {
  if (!(estimatedUsd > 0)) return stats;
  const ratio = Math.min(CALIB_MAX, Math.max(CALIB_MIN, (Number(actualUsd) || 0) / estimatedUsd));
  const calib = (stats.calib ??= { n: 0, scale: null, last: null });
  calib.scale = calib.n > 0 ? CALIB_ALPHA * ratio + (1 - CALIB_ALPHA) * calib.scale : ratio;
  calib.n += 1;
  calib.last = { ratio, at: calib.n };
  return stats;
}

const sumEst = (list, key = 'estUsd') => (Array.isArray(list) ? list : []).reduce((t, x) => t + (Number(x?.[key]) || 0), 0);

/**
 * This run's per-role $ ESTIMATE, straight from the foreman's own workflow-output ledger
 * (never from ledger-cost actuals): work = every unit attempt; sweep = every sweep round;
 * verify = every verifier batch; inspect = every inspector call. Pure.
 */
export function estimatedUsdByRole(result) {
  const ledger = result?.ledger ?? {};
  const attempts = (Array.isArray(ledger.units) ? ledger.units : []).flatMap((u) => u?.attempts ?? []);
  return {
    work: sumEst(attempts),
    verify: sumEst(ledger.verifiers),
    inspect: sumEst(ledger.inspectors),
    sweep: sumEst(ledger.sweeps),
  };
}

/**
 * This run's per-role $ ACTUAL, from a ledger-cost --json file's `byKind` totals: work pulls
 * in the completeness critic when present; sweep is its own role. A role whose kind(s) never
 * appear in byKind (nothing of that kind ran, or an old-style ledger-cost file with no byKind
 * at all) comes back null — the caller skips it rather than treating a true zero as "no
 * data". Pure.
 */
export function actualUsdByRole(ledgerJson) {
  const byKind = ledgerJson && typeof ledgerJson === 'object' ? ledgerJson.byKind : null;
  if (!byKind || typeof byKind !== 'object') return { work: null, verify: null, inspect: null, sweep: null };
  const usd = (k) => Number(byKind[k]?.usd) || 0;
  const work = ['work', 'critic'].some((k) => k in byKind)
    ? ['work', 'critic'].reduce((t, k) => t + (k in byKind ? usd(k) : 0), 0)
    : null;
  return {
    work,
    verify: 'verifier' in byKind ? usd('verifier') : null,
    inspect: 'inspector' in byKind ? usd('inspector') : null,
    sweep: 'sweep' in byKind ? usd('sweep') : null,
  };
}

/** The price model a run's card was priced under, or null when it carries none. */
export function pmOf(result) {
  const pm = result?.card?.calib?.pm;
  return typeof pm === 'number' ? pm : null;
}

/**
 * Fold one run's per-role estimate/actual into stats.calib.scaleByRole (mutates and returns
 * stats). For each role: ratio = actual/estimate, clamped to [ROLE_CALIB_MIN, ROLE_CALIB_MAX];
 * a role is skipped when its estimate is <= 0 or its actual is missing (null/undefined) — not
 * when its actual is a genuine zero. used = card scaleByRole[role] (1 when absent) x card scale
 * (1 when absent) — the factor the run really priced with, so a global scale on top of the role
 * factor is never counted twice; target = used x ratio. The new factor is an EWMA (alpha 0.5)
 * of the old one and the target, or, on a role's first observation under this price model, of
 * `used` and the target. A card without pm feeds nothing. A stored calib from another (or no)
 * price model moves to stats.calibArchive[<pm or 'legacy'>] before the fresh one is written.
 */
export function applyCalibrationByRole(stats, { result, ledgerJson }) {
  const pm = pmOf(result);
  if (pm === null) return stats;
  const est = estimatedUsdByRole(result);
  const act = actualUsdByRole(ledgerJson);
  const cardCalib = result?.card?.calib ?? {};
  const usedByRole = cardCalib.scaleByRole ?? {};
  const usedScale = typeof cardCalib.scale === 'number' ? cardCalib.scale : 1;
  // Compute every role's update before touching stats, so a run with nothing to compare
  // against leaves stats exactly as it found them.
  const updates = [];
  for (const role of ROLES) {
    const estimate = est[role];
    const actual = act[role];
    if (!(estimate > 0) || actual === null || actual === undefined) continue;
    const ratio = Math.min(ROLE_CALIB_MAX, Math.max(ROLE_CALIB_MIN, actual / estimate));
    const used = (typeof usedByRole[role] === 'number' ? usedByRole[role] : 1) * usedScale;
    updates.push({ role, ratio, used, target: used * ratio });
  }
  if (!updates.length) return stats;
  if (stats.calib && stats.calib.pm !== pm) {
    const key = typeof stats.calib.pm === 'number' ? String(stats.calib.pm) : 'legacy';
    (stats.calibArchive ??= {})[key] = stats.calib;
    stats.calib = undefined;
  }
  const calib = (stats.calib ??= { pm, scaleByRole: {}, nByRole: {}, lastByRole: {} });
  const byRole = (calib.scaleByRole ??= {});
  const nByRole = (calib.nByRole ??= {});
  const lastByRole = (calib.lastByRole ??= {});
  for (const { role, ratio, used, target } of updates) {
    const old = typeof byRole[role] === 'number' ? byRole[role] : used;
    byRole[role] = CALIB_ALPHA * target + (1 - CALIB_ALPHA) * old;
    nByRole[role] = (nByRole[role] || 0) + 1;
    lastByRole[role] = { ratio, used, target, at: nByRole[role] };
  }
  return stats;
}

/** Why this update feeds no calibration, or null when it can. Pure. */
export function calibSkipReason(result, ledgerJson) {
  const pm = pmOf(result);
  if (pm === null) return `card has no price model; it was priced before price model ${PRICE_MODEL} and its factors would not transfer`;
  if (!ledgerJson || !ledgerJson.byKind || typeof ledgerJson.byKind !== 'object') return 'ledger has no byKind breakdown; pass a ledger-cost.mjs --json output';
  return null;
}

const pct = (a, b) => (b > 0 ? Math.round((100 * a) / b) : 0);
const r1 = (x) => (Math.round(x * 10) / 10).toString();

/** Rule hits for a kind. Pure; returns structured hits for tests and the printer. */
export function rules(stats, kind) {
  const prefix = `${kind}/`;
  const cohorts = Object.entries(stats.cohorts).filter(([k]) => k.startsWith(prefix));
  const hits = [];
  for (const [k, c] of cohorts) {
    if (c.n >= RULES.promoteN && c.firstPassOk / c.n < RULES.promoteBelow) {
      const usual = Object.entries(c.fb ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      hits.push({ rule: 'PROMOTE', cohort: k, n: c.n, firstPass: c.firstPassOk / c.n, fb: usual });
    }
  }
  const byRole = {};
  for (const [k, c] of cohorts) {
    const role = k.split('/')[1];
    const r = (byRole[role] ??= { n: 0, rerouted: 0 });
    r.n += c.n;
    r.rerouted += c.rerouted;
  }
  for (const [role, r] of Object.entries(byRole)) {
    if (r.n >= RULES.reserveN) hits.push({ rule: 'RESERVE PRIOR', role, n: r.n, rate: r.rerouted / r.n });
  }
  const hi = { n: 0, ok: 0 };
  const lo = { n: 0, ok: 0 };
  for (const [, c] of cohorts) {
    hi.n += c.conf?.hi?.n ?? 0; hi.ok += c.conf?.hi?.ok ?? 0;
    lo.n += c.conf?.lo?.n ?? 0; lo.ok += c.conf?.lo?.ok ?? 0;
  }
  if (hi.n >= RULES.confMinN && lo.n >= RULES.confMinN) {
    const gap = hi.ok / hi.n - lo.ok / lo.n;
    if (gap < RULES.confGap) hits.push({ rule: 'CONFIDENCE', hiRate: hi.ok / hi.n, loRate: lo.ok / lo.n, gap });
  }
  const last = [...stats.runs].reverse().find((r) => r.kind === kind);
  if (last && last.U > 0 && last.committedUsd != null && last.committedUsd > RULES.envelope * last.U) {
    hits.push({ rule: 'ENVELOPE', U: last.U, committedUsd: last.committedUsd, ratio: last.committedUsd / last.U });
  }
  return hits;
}

/** ≤40 lines for the master's scouting batch. */
export function summary(stats, kind, maxLines = 40) {
  const prefix = `${kind}/`;
  const rows = Object.entries(stats.cohorts)
    .filter(([k, c]) => k.startsWith(prefix) && c.n >= RULES.showN)
    .sort((a, b) => b[1].n - a[1].n);
  const runs = stats.runs.filter((r) => r.kind === kind).length;
  const lines = [`routing stats · kind=${kind} · ${runs} run(s) on file · cohorts n≥${RULES.showN}: ${rows.length}`];
  const hits = rules(stats, kind);
  const ruleLines = [];
  for (const h of hits) {
    if (h.rule === 'PROMOTE') ruleLines.push(`PROMOTE ${h.cohort}: n=${r1(h.n)} first-pass ${pct(h.firstPass, 1)}% < 80% -> start at its usual fb ${h.fb ?? '(none recorded)'}; pick a new fb or null`);
    if (h.rule === 'RESERVE PRIOR') ruleLines.push(`RESERVE PRIOR role=${h.role}: n=${r1(h.n)} -> caps.rerouteRate ${h.rate.toFixed(2)}`);
    if (h.rule === 'CONFIDENCE') ruleLines.push(`CONFIDENCE: hi ok ${pct(h.hiRate, 1)}% vs lo ok ${pct(h.loRate, 1)}% (gap <10 pts) -> drop self-confidence as a sort key`);
    if (h.rule === 'ENVELOPE') ruleLines.push(`ENVELOPE: last ${kind} run committed $${h.committedUsd.toFixed(2)} = ${h.ratio.toFixed(2)}·U > 0.6·U -> solo thresholds x1.5`);
  }
  const budget = maxLines - lines.length - 2 - ruleLines.length;
  if (rows.length) lines.push('cohort (kind/role/vec/cell/ctx)  n  first-pass%  reroute%');
  const shown = rows.slice(0, Math.max(0, budget - 1));
  for (const [k, c] of shown) lines.push(`  ${k.slice(prefix.length)}  n=${r1(c.n)}  ${pct(c.firstPassOk, c.n)}%  ${pct(c.rerouted, c.n)}%`);
  if (rows.length > shown.length) lines.push(`  ... ${rows.length - shown.length} more cohort(s)`);
  lines.push(ruleLines.length ? 'rules:' : 'rules: none fire');
  lines.push(...ruleLines);
  return lines.slice(0, maxLines).join('\n');
}

function parseArgs(argv) {
  const a = { cmd: null, input: null, file: null, kind: null, verify: null, ledger: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === 'update') { a.cmd = 'update'; a.input = argv[++i]; }
    else if (t === '--summary') { a.cmd = 'summary'; a.kind = argv[++i]; }
    else if (t === '--file') a.file = argv[++i];
    else if (t === '--kind') a.kind = argv[++i];
    else if (t === '--verify') a.verify = argv[++i];
    else if (t === '--ledger') a.ledger = argv[++i];
    else if (t === '-h' || t === '--help') a.cmd = 'help';
  }
  return a;
}

const USAGE = 'usage: node scripts/stats.mjs update <workflow-output.json> [--file <stats.json>] [--kind <k>] [--verify <verify-stage-output.json>] [--ledger <ledger-cost.mjs --json output>]\n       node scripts/stats.mjs --summary <kind> [--file <stats.json>]';

export function main(argv = process.argv.slice(2), env = process.env) {
  const a = parseArgs(argv);
  const file = a.file ?? defaultFile(env);
  if (a.cmd === 'summary' && a.kind) {
    const stats = loadStats(file);
    console.log(summary(stats, a.kind));
    const calib = stats.calib;
    const roleKeys = calib?.pm === PRICE_MODEL && calib.scaleByRole ? ROLES.filter((r) => typeof calib.scaleByRole[r] === 'number') : [];
    if (roleKeys.length) {
      console.log(`CALIB {"pm":${PRICE_MODEL},"scaleByRole":{${roleKeys.map((r) => `"${r}":${calib.scaleByRole[r].toFixed(2)}`).join(',')}}}`);
      console.log('pass this back to the foreman as args.calib on the next run');
    }
    return 0;
  }
  if (a.cmd === 'update' && a.input) {
    let raw;
    try { raw = fs.readFileSync(a.input, 'utf8'); } catch (e) {
      console.error(`stats: cannot read ${a.input}: ${e.message}`);
      return 2;
    }
    let result;
    try { result = unwrap(JSON.parse(raw)); } catch (e) {
      console.error(`stats: ${a.input} is not JSON: ${e.message}`);
      return 2;
    }
    if (result && result.started === false) {
      console.error(`stats: the run did not start (${result.reason ?? 'unknown'}); nothing recorded`);
      return 2;
    }
    if (a.verify) {
      let verifyRaw;
      try { verifyRaw = fs.readFileSync(a.verify, 'utf8'); } catch (e) {
        console.error(`stats: cannot read ${a.verify}: ${e.message}`);
        return 2;
      }
      let verifyResult;
      try { verifyResult = unwrap(JSON.parse(verifyRaw)); } catch (e) {
        console.error(`stats: ${a.verify} is not JSON: ${e.message}`);
        return 2;
      }
      result = mergeVerifyClaims(result, verifyResult);
    }
    if (!Array.isArray(result?.ledger?.units)) {
      console.error('stats: no ledger.units in the workflow output; nothing recorded');
      return 2;
    }
    // A stage:'verify' run has no work units. Recording it would only decay every cohort.
    if (!labelUnits(result, a.kind ?? undefined).labels.length) {
      console.log('stats: no units ran p in this output (verify-only stage, or every unit refused); nothing recorded');
      return 0;
    }
    let ledgerJson = null;
    if (a.ledger) {
      let ledgerRaw;
      try { ledgerRaw = fs.readFileSync(a.ledger, 'utf8'); } catch (e) {
        console.error(`stats: cannot read ${a.ledger}: ${e.message}`);
        return 2;
      }
      try { ledgerJson = JSON.parse(ledgerRaw); } catch (e) {
        console.error(`stats: ${a.ledger} is not JSON: ${e.message}`);
        return 2;
      }
    }
    // The same output folded twice would double-count; key runs by content hash.
    const runId = crypto.createHash('sha256').update(JSON.stringify(result.ledger)).digest('hex').slice(0, 16);
    const stats = loadStats(file);
    if (stats.runs.some((r) => r.id === runId)) {
      console.log(`stats: run ${runId} already recorded in ${file}; skipped`);
      return 0;
    }
    applyRun(stats, result, { kind: a.kind ?? undefined, runId });
    let calibNote = '';
    if (ledgerJson) {
      const skip = calibSkipReason(result, ledgerJson);
      if (skip) calibNote = `, calib skipped (${skip})`;
      else {
        const before = JSON.stringify(stats.calib ?? null);
        applyCalibrationByRole(stats, { result, ledgerJson });
        const after = stats.calib?.scaleByRole;
        calibNote = JSON.stringify(stats.calib ?? null) !== before
          ? `, calib.scaleByRole=${JSON.stringify(Object.fromEntries(ROLES.filter((r) => typeof after[r] === 'number').map((r) => [r, Number(after[r].toFixed(2))])))} (pm ${stats.calib.pm})`
          : ', calib skipped (no role estimate/actual to compare)';
      }
    }
    saveStats(file, stats);
    const last = stats.runs.at(-1);
    console.log(`stats: recorded ${last.units} unit(s), kind=${last.kind}, run ${runId} -> ${file}${calibNote}`);
    return 0;
  }
  console.log(USAGE);
  return a.cmd === 'help' ? 0 : 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main();
