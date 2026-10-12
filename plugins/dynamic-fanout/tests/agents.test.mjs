// Agent definition files: tool lists and rung-copy identity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agents');

function load(name) {
  const text = fs.readFileSync(path.join(DIR, `${name}.md`), 'utf8');
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(m, `${name}: frontmatter`);
  const fm = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { fm, body: m[2] };
}
const list = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);
const names = fs.readdirSync(DIR).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));

test('lean agents (omitClaudeMd) never get the Read tool: it attaches nested CLAUDE.md files', () => {
  const lean = names.filter((n) => load(n).fm.omitClaudeMd === 'true');
  assert.ok(lean.length >= 9, lean.join(','));
  for (const n of lean) {
    const { fm } = load(n);
    if (fm.tools) {
      assert.ok(!list(fm.tools).includes('Read'), `${n}: tools must not include Read`);
      assert.ok(list(fm.tools).includes('Bash'), `${n}: tools must include Bash`);
    } else {
      assert.ok(list(fm.disallowedTools).includes('Read'), `${n}: disallowedTools must include Read`);
    }
  }
});

test('lean agent bodies carry the Bash reading recipe, not Read guidance', () => {
  for (const n of names.filter((x) => load(x).fm.omitClaudeMd === 'true')) {
    const { body } = load(n);
    assert.match(body, /nl -ba/, `${n}: nl -ba recipe`);
    assert.match(body, /CLAUDE\.md/, `${n}: says why Read is withheld`);
    assert.doesNotMatch(body, /then Read only/, `${n}: stale Read guidance`);
  }
});

test('agents that keep CLAUDE.md keep Read', () => {
  for (const n of ['worker-ctx', 'worker-ctx-xhigh', 'implementer', 'implementer-medium', 'implementer-high']) {
    const { fm } = load(n);
    assert.notEqual(fm.omitClaudeMd, 'true', n);
    if (fm.tools) assert.ok(list(fm.tools).includes('Read'), n);
    assert.ok(!list(fm.disallowedTools).includes('Read'), n);
  }
});

test('Agent-rung copies keep the base body; only name/description/effort differ', () => {
  const rungs = {
    worker: ['worker-low', 'worker-medium', 'worker-high'],
    skeptic: ['skeptic-high'],
    implementer: ['implementer-medium', 'implementer-high'],
    'worker-ctx': ['worker-ctx-xhigh'],
  };
  for (const [base, copies] of Object.entries(rungs)) {
    const b = load(base);
    for (const c of copies) {
      const x = load(c);
      assert.equal(x.body, b.body, `${c} body`);
      for (const k of new Set([...Object.keys(b.fm), ...Object.keys(x.fm)])) {
        if (!['name', 'description', 'effort'].includes(k)) assert.equal(x.fm[k], b.fm[k], `${c} ${k}`);
      }
    }
  }
});
