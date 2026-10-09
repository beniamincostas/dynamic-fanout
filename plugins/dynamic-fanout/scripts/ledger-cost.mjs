#!/usr/bin/env node
// ledger-cost.mjs — actual $ per unit from a workflow's per-agent transcripts.
//
// Usage: node scripts/ledger-cost.mjs <workflow-transcript-dir> [--json]
//
// Reads agent-*.jsonl (+ optional agent-*.meta.json, journal.jsonl labels) in the dir.
// Each agent is attributed by the cost tag on the last line of its prompt:
//   ⟦df:<unitId>:<attempt>⟧ work · ⟦df:i:<unitId>:<n>⟧ inspector · ⟦df:v:<batch>:<n>⟧ verifier
//   ⟦df:s:<round>:1⟧ sweep · ⟦df:c:1:1⟧ critic · no tag -> 'untagged'
// Usage is summed over assistant messages DEDUPED BY message.id: a streamed message is
// written once per content block, and the early copies carry partial output_tokens, so the
// copy with the largest output_tokens wins.
// Prices ($/MTok in/out): haiku 1/5, sonnet 2/10, opus 4/20, fable 10/50.
// Cache write = 1.25x input (5-minute TTL; a 1-hour write is billed at 2x when the
// transcript breaks it out), cache read = 0.1x input.
// Fail soft: an unrecognised format prints a warning and exits 0 with what it could total.
// Zero dependencies; Node >= 20.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PRICES = {
  haiku: { in: 1, out: 5 },
  sonnet: { in: 2, out: 10 },
  opus: { in: 4, out: 20 },
  fable: { in: 10, out: 50 },
};
export const CACHE_WRITE = 1.25;
export const CACHE_WRITE_1H = 2;
export const CACHE_READ = 0.1;

const TAG_RE = /⟦df:([^⟧\s]+)⟧/g;

/** Model family from a model id by substring (fable/opus/sonnet/haiku), else null. */
export function family(model) {
  const m = String(model ?? '').toLowerCase();
  for (const f of ['fable', 'opus', 'sonnet', 'haiku']) if (m.includes(f)) return f;
  return null;
}

const UNTAGGED = Object.freeze({ tag: 'untagged', kind: 'untagged' });

/**
 * Parse the inner text of a ⟦df:...⟧ tag into {tag, kind, unit?, attempt?, batch?, round?, n?}.
 * The last segment must be an integer; anything off-grammar (e.g. a placeholder like
 * 'id:attempt' quoted from docs) counts as untagged rather than inventing a unit.
 */
export function parseTag(inner) {
  if (!inner) return UNTAGGED;
  const parts = String(inner).split(':');
  if (parts.length < 2 || !/^\d+$/.test(parts.at(-1)) || parts.some((p) => !p)) return UNTAGGED;
  const tag = `df:${inner}`;
  const n = Number(parts.at(-1));
  const k = parts[0];
  if (parts.length >= 3) {
    if (k === 'i') return { tag, kind: 'inspector', unit: parts.slice(1, -1).join(':'), n };
    if (k === 'v') return { tag, kind: 'verifier', batch: parts.slice(1, -1).join(':'), n };
    if (k === 's') return { tag, kind: 'sweep', round: parts.slice(1, -1).join(':'), n };
    if (k === 'c') return { tag, kind: 'critic', n };
  }
  return { tag, kind: 'work', unit: parts.slice(0, -1).join(':'), attempt: n };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && c.type === 'text' ? c.text ?? '' : '')).join('\n');
  return '';
}

/**
 * The ⟦df:…⟧ tag on the LAST non-empty line of a prompt, or null. Only the last line counts:
 * a tag quoted mid-prompt (docs, a plan) is not the agent's own tag.
 */
export function findTag(text) {
  const lines = String(text).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    let last = null;
    for (const m of lines[i].matchAll(TAG_RE)) last = m[1];
    return last;
  }
  return null;
}

/** Cost in USD of one usage block on one model family. */
export function priceUsage(u, fam) {
  const p = PRICES[fam];
  if (!p || !u) return 0;
  const inTok = u.input_tokens ?? 0;
  const out = u.output_tokens ?? 0;
  const cw = u.cache_creation_input_tokens ?? 0;
  const cr = u.cache_read_input_tokens ?? 0;
  const cw1h = Math.min(cw, u.cache_creation?.ephemeral_1h_input_tokens ?? 0);
  const cw5m = cw - cw1h;
  return (inTok * p.in + cw5m * p.in * CACHE_WRITE + cw1h * p.in * CACHE_WRITE_1H + cr * p.in * CACHE_READ + out * p.out) / 1e6;
}

const zero = () => ({ agents: 0, messages: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, usd: 0 });
function add(acc, r) {
  for (const k of Object.keys(acc)) acc[k] += r[k] ?? 0;
  return acc;
}

/**
 * Parse one agent transcript (array of JSONL lines). Pure.
 * @returns {{tag, kind, unit, models:{[fam]:usage}, messages, usageLines, skipped, unknownModels:Set, totals}}
 */
export function parseTranscript(lines) {
  const byId = new Map();
  let tagInner = null;
  let seenAssistant = false;
  let usageLines = 0;
  let skipped = 0;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    let o;
    try { o = JSON.parse(raw); } catch { skipped++; continue; }
    const msg = o?.message;
    const role = o?.type ?? msg?.role;
    // The tag lives in the prompt: user messages before the first assistant turn.
    // Later user messages are tool results and may quote tags from files the agent read.
    if (!seenAssistant && role === 'user' && msg) {
      const t = findTag(textOf(msg.content));
      if (t) tagInner = t;
    }
    if (role === 'assistant') seenAssistant = true;
    if (role === 'assistant' && msg?.usage) {
      usageLines++;
      const id = msg.id ?? o.requestId ?? o.uuid ?? `line${usageLines}`;
      const prev = byId.get(id);
      if (!prev || (msg.usage.output_tokens ?? 0) >= (prev.usage.output_tokens ?? 0)) {
        byId.set(id, { usage: msg.usage, model: msg.model ?? prev?.model });
      }
    }
  }
  const parsed = parseTag(tagInner);
  const models = {};
  const unknownModels = new Set();
  const totals = zero();
  for (const { usage, model } of byId.values()) {
    const fam = family(model);
    if (!fam) {
      // '<synthetic>' error stubs carry zero usage; anything else unknown is worth a warning.
      const tokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
      if (tokens > 0) unknownModels.add(String(model));
    }
    const key = fam ?? 'unknown';
    const r = {
      messages: 1,
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      usd: priceUsage(usage, fam),
    };
    models[key] = add(models[key] ?? zero(), r);
    add(totals, r);
  }
  return { ...parsed, models, messages: byId.size, usageLines, skipped, unknownModels, totals };
}

/** Optional labels: journal.jsonl 'started' rows map agentId -> label. */
function readJournal(dir) {
  const labels = new Map();
  try {
    for (const raw of fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').split('\n')) {
      if (!raw.trim()) continue;
      try {
        const o = JSON.parse(raw);
        if (o.type === 'started' && o.agentId) labels.set(o.agentId, o.label ?? null);
      } catch { /* ignore */ }
    }
  } catch { /* no journal */ }
  return labels;
}

/** Aggregate a transcript dir. Fail-soft: collects warnings instead of throwing. */
export function ledger(dir) {
  const warnings = [];
  const out = { dir, agents: [], byTag: {}, byUnit: {}, byKind: {}, byModel: {}, totals: zero(), usageLines: 0, warnings };
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^agent-.*\.jsonl$/.test(f)).sort();
  } catch (e) {
    warnings.push(`cannot read dir ${dir}: ${e.message}`);
    return out;
  }
  if (!files.length) warnings.push(`no agent-*.jsonl transcripts in ${dir}`);
  const labels = readJournal(dir);
  for (const f of files) {
    const agentId = f.replace(/^agent-/, '').replace(/\.jsonl$/, '');
    let lines;
    try { lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n'); } catch (e) {
      warnings.push(`${f}: unreadable (${e.message})`);
      continue;
    }
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, f.replace(/\.jsonl$/, '.meta.json')), 'utf8')); } catch { /* optional */ }
    const t = parseTranscript(lines);
    if (t.skipped) warnings.push(`${f}: ${t.skipped} unparseable line(s) skipped`);
    if (!t.usageLines) warnings.push(`${f}: no assistant usage found (format unrecognised?)`);
    for (const m of t.unknownModels) warnings.push(`${f}: unknown model '${m}' — tokens counted, priced $0`);
    out.usageLines += t.usageLines;
    const row = { agentId, file: f, label: labels.get(agentId) ?? meta?.description ?? null, tag: t.tag, kind: t.kind, unit: t.unit ?? null, models: t.models, ...t.totals, agents: 1 };
    out.agents.push(row);
    // byTag is keyed by the unbracketed form ('df:r1:1'), matching parseTag()'s `tag` output.
    // The foreman ledger stores the bracketed form ('⟦df:r1:1⟧') on its attempts/verifiers/
    // inspectors/sweeps — strip the brackets before joining estimate (ledger) to actual (here).
    const tagKey = t.tag;
    out.byTag[tagKey] = add(out.byTag[tagKey] ?? zero(), { ...t.totals, agents: 1 });
    out.byKind[t.kind] = add(out.byKind[t.kind] ?? zero(), { ...t.totals, agents: 1 });
    if (t.unit != null) out.byUnit[t.unit] = add(out.byUnit[t.unit] ?? zero(), { ...t.totals, agents: 1 });
    for (const [fam, r] of Object.entries(t.models)) out.byModel[fam] = add(out.byModel[fam] ?? zero(), { ...r, agents: 1 });
    add(out.totals, { ...t.totals, agents: 1 });
  }
  return out;
}

const usd = (x) => `$${x.toFixed(4)}`;
const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
function row(name, r) {
  return `  ${name.padEnd(22)} ${String(r.agents).padStart(3)} ag  in ${tok(r.input).padStart(7)}  cw ${tok(r.cacheWrite).padStart(7)}  cr ${tok(r.cacheRead).padStart(7)}  out ${tok(r.output).padStart(7)}  ${usd(r.usd).padStart(10)}`;
}

export function formatLedger(L) {
  const lines = [`ledger-cost: ${L.agents.length} agents, ${L.totals.messages} messages (${L.usageLines} usage lines, deduped by message.id)`];
  const sect = (title, obj) => {
    const keys = Object.keys(obj).sort((a, b) => obj[b].usd - obj[a].usd);
    if (!keys.length) return;
    lines.push(`${title}:`);
    for (const k of keys) lines.push(row(k, obj[k]));
  };
  sect('by tag', L.byTag);
  sect('by unit (work + inspector)', L.byUnit);
  sect('by kind', L.byKind);
  sect('by model', L.byModel);
  lines.push(row('TOTAL', L.totals));
  for (const w of L.warnings) lines.push(`warning: ${w}`);
  return lines.join('\n');
}

export function main(argv = process.argv.slice(2)) {
  const dir = argv.find((a) => !a.startsWith('--'));
  const json = argv.includes('--json');
  if (!dir || argv.includes('-h') || argv.includes('--help')) {
    console.log('usage: node scripts/ledger-cost.mjs <workflow-transcript-dir> [--json]');
    return dir ? 0 : 2;
  }
  let L;
  try { L = ledger(dir); } catch (e) {
    console.log(`warning: ledger-cost failed (${e.message}); no actuals — report costs as estimated`);
    return 0;
  }
  console.log(json ? JSON.stringify(L, null, 2) : formatLedger(L));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main();
