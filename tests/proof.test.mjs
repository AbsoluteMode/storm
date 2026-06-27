// tests/proof.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProofFindings, classifyCost, predictMatches } from '../scripts/lib/proof.mjs';

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

test('classifyCost: declared paid wins', () => {
  assert.equal(classifyCost('node x.mjs', 'paid:openai'), 'paid');
});

test('classifyCost: plain local command -> free', () => {
  assert.equal(classifyCost('node --test', 'free'), 'free');
  assert.equal(classifyCost('npm test', undefined), 'free');
});

test('classifyCost: networked/paid-looking but declared free -> unknown (default-deny)', () => {
  assert.equal(classifyCost('curl https://api.openai.com/v1', 'free'), 'unknown');
  assert.equal(classifyCost('node hit.mjs && wget http://x', 'free'), 'unknown');
  assert.equal(classifyCost('npm install left-pad', 'free'), 'unknown');
});

test('classifyCost: empty command -> unknown', () => {
  assert.equal(classifyCost('', 'free'), 'unknown');
});

test('predictMatches: exit clauses', () => {
  assert.equal(predictMatches('exit!=0', { exitCode: 1 }), true);
  assert.equal(predictMatches('exit!=0', { exitCode: 0 }), false);
  assert.equal(predictMatches('exit==2', { exitCode: 2 }), true);
});

test('predictMatches: contains clauses + AND', () => {
  const res = { exitCode: 1, stdout: 'boom', stderr: 'Cannot read x' };
  assert.equal(predictMatches('stderr contains "Cannot read"', res), true);
  assert.equal(predictMatches('exit!=0 AND stdout contains "boom"', res), true);
  assert.equal(predictMatches('exit==0 AND stdout contains "boom"', res), false);
});

test('predictMatches: empty/unknown clause -> false (conservative)', () => {
  assert.equal(predictMatches('', { exitCode: 1 }), false);
  assert.equal(predictMatches('frobnicate the gizmo', { exitCode: 1 }), false);
});

test('predictMatches: null exitCode never satisfies exit clauses (timed-out / spawn-failed guard)', () => {
  // A killed experiment has exitCode: null. Must NOT be treated as proof of exit!=0.
  assert.equal(predictMatches('exit!=0', { exitCode: null }), false);
  assert.equal(predictMatches('exit==0', { exitCode: null }), false);
  assert.equal(predictMatches('exit!=1', { exitCode: null }), false);
});

test('predictMatches: normal numeric exitCode still works correctly', () => {
  // Regression guard: real non-zero exit codes must still satisfy exit!=0.
  assert.equal(predictMatches('exit!=0', { exitCode: 1 }), true);
  assert.equal(predictMatches('exit!=0', { exitCode: 127 }), true);
  assert.equal(predictMatches('exit!=0', { exitCode: 0 }), false);
});
