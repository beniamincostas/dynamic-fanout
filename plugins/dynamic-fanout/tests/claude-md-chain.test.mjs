// Tests for scripts/claude-md-chain.mjs
// Run: node --test plugins/dynamic-fanout/tests/claude-md-chain.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as cmc from '../scripts/claude-md-chain.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'scripts', 'claude-md-chain.mjs');
const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-cmc-'));
  write(path.join(root, 'CLAUDE.md'), 'x'.repeat(100)); // excluded: loads at session start
  write(path.join(root, 'pkg', 'CLAUDE.md'), 'y'.repeat(40));
  write(path.join(root, 'pkg', 'sub', 'CLAUDE.md'), 'z'.repeat(20));
  write(path.join(root, 'pkg', 'sub', 'a.py'), '# a');
  write(path.join(root, 'pkg', 'sub', 'b.py'), '# b');
  write(path.join(root, 'pkg', 'other', 'c.py'), '# c'); // no CLAUDE.md in 'other'
  write(path.join(root, 'bare.py'), '# bare'); // directly under root, no nested CLAUDE.md
  return root;
}

test('chainFor: excludes the root CLAUDE.md, includes every directory down to the file', () => {
  const root = makeFixture();
  const chain = cmc.chainFor(root, path.join(root, 'pkg', 'sub', 'a.py'));
  assert.deepEqual(chain.map((f) => f.path), [path.join(root, 'pkg', 'CLAUDE.md'), path.join(root, 'pkg', 'sub', 'CLAUDE.md')]);
  assert.equal(chain[0].bytes, 40);
  assert.equal(chain[1].bytes, 20);
  assert.equal(chain[0].tokens, 10);
});

test('chainFor: a directory with no CLAUDE.md below it is an empty chain', () => {
  const root = makeFixture();
  assert.deepEqual(cmc.chainFor(root, path.join(root, 'pkg', 'other', 'c.py')), [
    { path: path.join(root, 'pkg', 'CLAUDE.md'), bytes: 40, tokens: 10 },
  ]);
  assert.deepEqual(cmc.chainFor(root, path.join(root, 'bare.py')), []);
});

test('build: dedupes identical chains and reports each distinct chain total + the overall max', () => {
  const root = makeFixture();
  const rep = cmc.build(root, [path.join(root, 'pkg', 'sub', 'a.py'), path.join(root, 'pkg', 'sub', 'b.py'), path.join(root, 'bare.py')]);
  assert.equal(rep.chains.length, 2, 'a.py and b.py share an identical chain; bare.py is distinct (empty)');
  const same = rep.chains.find((c) => c.chain.length === 2);
  assert.deepEqual(same.targets.sort(), [path.join(root, 'pkg', 'sub', 'a.py'), path.join(root, 'pkg', 'sub', 'b.py')].sort());
  assert.equal(same.totalBytes, 60);
  assert.equal(same.totalTokens, 15);
  const empty = rep.chains.find((c) => c.chain.length === 0);
  assert.deepEqual(empty.targets, [path.join(root, 'bare.py')]);
  assert.equal(rep.maxTokens, 15);
});

test('build: accepts a directory target the same as a file inside it', () => {
  const root = makeFixture();
  const rep = cmc.build(root, [path.join(root, 'pkg', 'sub')]);
  assert.equal(rep.chains[0].chain.length, 2);
});

test('CLI: --json prints the same shape build() returns', () => {
  const root = makeFixture();
  const target = path.join(root, 'pkg', 'sub', 'a.py');
  const r = run([root, target, '--json']);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), cmc.build(root, [target]));
});

test('CLI: missing args prints usage and exits 2', () => {
  assert.equal(run([]).status, 2);
  assert.match(run([]).stdout, /usage: node scripts\/claude-md-chain\.mjs/);
  const root = makeFixture();
  assert.equal(run([root]).status, 2, 'root with no targets is also usage');
});
