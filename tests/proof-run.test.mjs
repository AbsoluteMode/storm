// tests/proof-run.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { runExperiment } from '../scripts/lib/proof.mjs';

test('runExperiment: captures exit code and stdout', async () => {
  const r = await runExperiment('echo hello; exit 3', tmpdir(), { timeoutMs: 5000 });
  assert.equal(r.exitCode, 3);
  assert.ok(r.stdoutTail.includes('hello'));
  assert.equal(r.timedOut, false);
});

test('runExperiment: captures stderr', async () => {
  const r = await runExperiment('echo oops 1>&2; exit 1', tmpdir(), { timeoutMs: 5000 });
  assert.equal(r.exitCode, 1);
  assert.ok(r.stderrTail.includes('oops'));
});

test('runExperiment: a hanging command is killed at timeout', async () => {
  const r = await runExperiment('sleep 30', tmpdir(), { timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.ok(r.durationMs < 3000, `should have been killed quickly, took ${r.durationMs}ms`);
});
