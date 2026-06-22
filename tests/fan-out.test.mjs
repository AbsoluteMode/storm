// tests/fan-out.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAll } from '../scripts/lib/fan-out.mjs';

test('runs all engines concurrently and collects results', async () => {
  const started = [];
  const runner = async (id) => {
    started.push(id);
    await new Promise((r) => setTimeout(r, 20));
    return { engine: id, status: 'ok', result: `r-${id}` };
  };
  const engines = [{ id: 'claude' }, { id: 'codex' }, { id: 'antigravity' }];
  const results = await runAll('task', engines, { runner });
  assert.equal(results.length, 3);
  assert.deepEqual(results.map((r) => r.engine).sort(), ['antigravity', 'claude', 'codex']);
  assert.equal(started.length, 3); // all kicked off
});

test('one failing engine does not break the run', async () => {
  const runner = async (id) =>
    id === 'codex' ? { engine: id, status: 'timeout', error: 't' } : { engine: id, status: 'ok', result: 'r' };
  const results = await runAll('task', [{ id: 'claude' }, { id: 'codex' }], { runner });
  const codex = results.find((r) => r.engine === 'codex');
  const claude = results.find((r) => r.engine === 'claude');
  assert.equal(codex.status, 'timeout');
  assert.equal(claude.status, 'ok');
});
