// tests/fan-out.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAll } from '../scripts/lib/fan-out.mjs';

test('runs all engines concurrently and collects results', async () => {
  const DELAY_MS = 50;
  const startTimes = [];
  const runner = async (id) => {
    startTimes.push(Date.now());
    await new Promise((r) => setTimeout(r, DELAY_MS));
    return { engine: id, status: 'ok', result: `r-${id}` };
  };
  const engines = [{ id: 'claude' }, { id: 'codex' }, { id: 'antigravity' }];
  const results = await runAll('task', engines, { runner });
  assert.equal(results.length, 3);
  assert.deepEqual(results.map((r) => r.engine).sort(), ['antigravity', 'claude', 'codex']);
  assert.equal(startTimes.length, 3);
  // All three runners must have started before any single one finishes.
  // If sequential, spread would be >= DELAY_MS; concurrent spread is << DELAY_MS.
  const spread = Math.max(...startTimes) - Math.min(...startTimes);
  assert.ok(spread < DELAY_MS, `runners appear sequential (spread ${spread}ms >= ${DELAY_MS}ms delay)`);
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

test('synchronously-throwing runner is caught by allSettled defense; other engines still return', async () => {
  const runner = (id) => {
    if (id === 'badengine') throw new Error('sync boom');
    return Promise.resolve({ engine: id, status: 'ok', result: 'fine' });
  };
  const engines = [{ id: 'claude' }, { id: 'badengine' }];
  const results = await runAll('task', engines, { runner });
  assert.equal(results.length, 2);
  const bad = results.find((r) => r.engine === 'badengine');
  const good = results.find((r) => r.engine === 'claude');
  assert.equal(bad.status, 'error');
  assert.ok(bad.error.includes('sync boom'));
  assert.equal(good.status, 'ok');
});
