#!/usr/bin/env node
// claude-md-chain.mjs — what a Read-capable agent gets attached for free.
//
// Usage: node scripts/claude-md-chain.mjs <root> <file|dir>... [--json]
//
// omitClaudeMd only drops the CLAUDE.md files loaded at agent start. Whenever such an agent
// (ctx keep, implementer, an ultracode agent) uses the Read tool on a file, every CLAUDE.md in
// that file's directory chain between the session cwd (<root>) and the file's own directory is
// attached as a nested_memory side-channel — a cost the price model never sees.
//
// For each <file|dir>, lists the CLAUDE.md files in every directory strictly below <root> down
// to and including the path's own directory (a file's directory, or the directory itself),
// with each file's size in bytes and an approximate token count (bytes / 4). <root>'s own
// CLAUDE.md is excluded — it loads at session start, not on a Read. Identical chains (same set
// of CLAUDE.md files, in order) are deduped; each distinct chain is printed once with its
// total bytes/tokens, and the overall max across all distinct chains is printed last.
// A path with no CLAUDE.md below it (or that resolves outside <root>) yields an empty chain.
// Zero dependencies; Node >= 20.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const approxTokens = (bytes) => Math.round(bytes / 4);

/** Directory chain from (not including) root down to and including `dir`, root-first. */
function dirChain(root, dir) {
  const r = path.resolve(root);
  let d = path.resolve(dir);
  const rel = path.relative(r, d);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return [];
  if (rel === '') return [];
  const parts = rel.split(path.sep).filter(Boolean);
  const out = [];
  let cur = r;
  for (const p of parts) { cur = path.join(cur, p); out.push(cur); }
  return out;
}

/** The CLAUDE.md chain a Read of `target` (file or dir) under `root` would attach. */
export function chainFor(root, target) {
  let dir;
  try {
    const st = fs.statSync(target);
    dir = st.isDirectory() ? target : path.dirname(target);
  } catch {
    dir = target.endsWith(path.sep) || /[\\/]$/.test(target) ? target : path.dirname(target);
  }
  const dirs = dirChain(root, dir);
  const files = [];
  for (const d of dirs) {
    const p = path.join(d, 'CLAUDE.md');
    try {
      const st = fs.statSync(p);
      if (st.isFile()) files.push({ path: p, bytes: st.size, tokens: approxTokens(st.size) });
    } catch { /* no CLAUDE.md in this directory */ }
  }
  return files;
}

function chainKey(chain) {
  return chain.map((f) => f.path).join('\n');
}

export function build(root, targets) {
  const perTarget = targets.map((t) => ({ target: t, chain: chainFor(root, t) }));
  const byKey = new Map();
  for (const { target, chain } of perTarget) {
    const key = chainKey(chain);
    let g = byKey.get(key);
    if (!g) {
      const totalBytes = chain.reduce((s, f) => s + f.bytes, 0);
      g = { targets: [], chain, totalBytes, totalTokens: approxTokens(totalBytes) };
      byKey.set(key, g);
    }
    g.targets.push(target);
  }
  const chains = [...byKey.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  const max = chains.reduce((m, c) => Math.max(m, c.totalTokens), 0);
  return { root: path.resolve(root), chains, maxTokens: max };
}

export function formatText(rep) {
  const lines = [`claude-md-chain: ${rep.chains.length} distinct chain(s) under ${rep.root}`];
  for (const c of rep.chains) {
    lines.push(`- ${c.targets.join(', ')}: ${c.chain.length} file(s), ${c.totalBytes}B (~${c.totalTokens} tok)`);
    for (const f of c.chain) lines.push(`    ${f.path}  ${f.bytes}B (~${f.tokens} tok)`);
  }
  lines.push(`max: ~${rep.maxTokens} tokens`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const json = argv.includes('--json');
  const pos = argv.filter((a) => a !== '--json');
  return { root: pos[0], targets: pos.slice(1), json };
}

export function main(argv = process.argv.slice(2)) {
  const { root, targets, json } = parseArgs(argv);
  if (!root || !targets.length) {
    console.log('usage: node scripts/claude-md-chain.mjs <root> <file|dir>... [--json]');
    return 2;
  }
  const rep = build(root, targets);
  console.log(json ? JSON.stringify(rep, null, 2) : formatText(rep));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main();
