// tests/openrouter-runner.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSSELine } from '../scripts/lib/openrouter-runner.mjs';

test('parseSSELine: content delta extracted to content channel', () => {
  const line = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'hello' } }] });
  assert.deepEqual(parseSSELine(line), { content: 'hello', reasoning: '' });
});

test('parseSSELine: reasoning delta extracted to reasoning (heartbeat) channel', () => {
  const line = 'data: ' + JSON.stringify({ choices: [{ delta: { reasoning: 'thinking...' } }] });
  assert.deepEqual(parseSSELine(line), { content: '', reasoning: 'thinking...' });
});

test('parseSSELine: [DONE] sentinel -> null', () => {
  assert.equal(parseSSELine('data: [DONE]'), null);
});

test('parseSSELine: non-data line (SSE comment / blank) -> null', () => {
  assert.equal(parseSSELine(': openrouter processing'), null);
  assert.equal(parseSSELine(''), null);
});

test('parseSSELine: malformed JSON payload -> null (tolerant, never throws)', () => {
  assert.equal(parseSSELine('data: {not valid json'), null);
});

test('parseSSELine: delta without content/reasoning -> empty strings', () => {
  const line = 'data: ' + JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] });
  assert.deepEqual(parseSSELine(line), { content: '', reasoning: '' });
});
