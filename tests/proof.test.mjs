// tests/proof.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProofFindings } from '../scripts/lib/proof.mjs';

test('parseProofFindings: NEEDS-EXPERIMENT with run/expects/cost sub-grammar', () => {
  const text = [
    'preamble chatter',
    '[NEEDS-EXPERIMENT] Null deref in parser',
    '  run: node repro.mjs',
    '  expects: exit!=0 AND stderr contains "Cannot read"',
    '  cost: free',
  ].join('\n');
  const [f] = parseProofFindings(text);
  assert.equal(f.tag, 'needs-experiment');
  assert.equal(f.title, 'Null deref in parser');
  assert.equal(f.run, 'node repro.mjs');
  assert.equal(f.expects, 'exit!=0 AND stderr contains "Cannot read"');
  assert.equal(f.cost, 'free');
});

test('parseProofFindings: UNPROVEN-CANNOT with inline why', () => {
  const [f] = parseProofFindings('[UNPROVEN-CANNOT] Race in scheduler — why: nondeterministic timing');
  assert.equal(f.tag, 'unproven-cannot');
  assert.equal(f.title, 'Race in scheduler');
  assert.equal(f.why, 'nondeterministic timing');
});

test('parseProofFindings: engine-claimed PROVEN is captured as proven-claimed (to be downgraded later)', () => {
  const [f] = parseProofFindings('[PROVEN] I am sure by reading line 42');
  assert.equal(f.tag, 'proven-claimed');
  assert.equal(f.title, 'I am sure by reading line 42');
});

test('parseProofFindings: multiple findings, tolerant of junk lines', () => {
  const text = [
    '[NEEDS-EXPERIMENT] First',
    '  run: true',
    'garbage line that means nothing',
    '[UNPROVEN-CANNOT] Second',
  ].join('\n');
  const fs = parseProofFindings(text);
  assert.equal(fs.length, 2);
  assert.equal(fs[0].title, 'First');
  assert.equal(fs[1].tag, 'unproven-cannot');
});

test('parseProofFindings: empty / nullish input -> []', () => {
  assert.deepEqual(parseProofFindings(''), []);
  assert.deepEqual(parseProofFindings(null), []);
});
