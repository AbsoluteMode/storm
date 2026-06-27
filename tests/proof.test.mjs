// tests/proof.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProofFindings, parseFindings, classifyCost, predictMatches, annotateWithProof } from '../scripts/lib/proof.mjs';

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

// --- parseFindings (new Stage-2 parser) ---

test('parseFindings extracts [FINDING] run/expects/observed', () => {
  const f = parseFindings('[FINDING] crash on empty\nrun: node -e "process.exit(3)"\nexpects: exit==3\nobserved: exited 3');
  assert.equal(f[0].tag, 'finding');
  assert.equal(f[0].run, 'node -e "process.exit(3)"');
  assert.equal(f[0].expects, 'exit==3');
});

test('parseFindings: UNPROVEN-CANNOT with inline why is still recognised', () => {
  const f = parseFindings('[UNPROVEN-CANNOT] Race — why: nondeterministic timing');
  assert.equal(f[0].tag, 'unproven-cannot');
  assert.equal(f[0].title, 'Race');
  assert.equal(f[0].why, 'nondeterministic timing');
});

test('parseFindings: multiple blocks, tolerant of junk lines', () => {
  const text = [
    '[FINDING] First',
    '  run: true',
    'garbage',
    '[UNPROVEN-CANNOT] Second',
  ].join('\n');
  const fs = parseFindings(text);
  assert.equal(fs.length, 2);
  assert.equal(fs[0].title, 'First');
  assert.equal(fs[1].tag, 'unproven-cannot');
});

test('parseFindings: empty / nullish -> []', () => {
  assert.deepEqual(parseFindings(''), []);
  assert.deepEqual(parseFindings(null), []);
});

// --- annotateWithProof (new Stage-2 verify pass) ---

test('locally-reproducible finding is re-verified to proven', async () => {
  const results = [{ engine: 'codex', status: 'ok',
    result: '[FINDING] exits 3\nrun: sh -c "exit 3"\nexpects: exit==3\nobserved: 3' }];
  const out = await annotateWithProof(results, { repoPath: process.cwd(), timeoutMs: 5000 });
  const f = out.results[0].findings[0];
  assert.equal(f.tag, 'proven');
  assert.equal(out.verified_experiments.length, 1);
});

test('engine fabrication (claims proven but does not reproduce) => disproven', async () => {
  const results = [{ engine: 'glm', status: 'ok',
    result: '[FINDING] fake\nrun: sh -c "exit 0"\nexpects: exit!=0\nobserved: fabricated' }];
  const out = await annotateWithProof(results, { repoPath: process.cwd(), timeoutMs: 5000 });
  assert.equal(out.results[0].findings[0].tag, 'disproven');
});

test('networked finding is engine-claimed, not re-run', async () => {
  const results = [{ engine: 'codex', status: 'ok',
    result: '[FINDING] api\nrun: curl https://api.openai.com/x\nexpects: stdout contains "gpt"\nobserved: saw gpt' }];
  const out = await annotateWithProof(results, { repoPath: process.cwd(), timeoutMs: 5000 });
  assert.equal(out.results[0].findings[0].tag, 'engine-claimed');
  assert.equal(out.engine_claimed_experiments.length, 1);
  assert.equal(out.verified_experiments.length, 0);
});

test('annotateWithProof: result with status != ok is passed through unchanged', async () => {
  const results = [{ engine: 'codex', status: 'error', result: '' }];
  const out = await annotateWithProof(results, { repoPath: process.cwd(), timeoutMs: 5000 });
  assert.equal(out.results[0].status, 'error');
  assert.ok(!out.results[0].findings);
});

test('annotateWithProof: finding without run/expects becomes unproven', async () => {
  const results = [{ engine: 'codex', status: 'ok',
    result: '[FINDING] something\nobserved: nothing' }];
  const out = await annotateWithProof(results, { repoPath: process.cwd(), timeoutMs: 5000 });
  assert.equal(out.results[0].findings[0].tag, 'unproven');
});
