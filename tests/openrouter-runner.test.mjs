// tests/openrouter-runner.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSSELine, buildBody, buildAgenticBody, toolResultMessages } from '../scripts/lib/openrouter-runner.mjs';
import { TOOLS } from '../scripts/lib/openrouter-tools.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('buildAgenticBody: messages + tools + reasoning, non-stream', () => {
  const b = buildAgenticBody('m', [{ role: 'user', content: 'x' }], 'high', TOOLS);
  assert.equal(b.stream, false);
  assert.equal(b.model, 'm');
  assert.equal(b.tools, TOOLS);
  assert.deepEqual(b.reasoning, { effort: 'high' });
  assert.deepEqual(b.messages, [{ role: 'user', content: 'x' }]);
});

test('toolResultMessages: runs each tool_call in the sandbox, returns tool messages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'storm-tr-'));
  writeFileSync(join(dir, 'a.txt'), 'hello tool');
  try {
    const calls = [{ id: 'c1', function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) } }];
    const msgs = toolResultMessages(calls, dir);
    assert.equal(msgs[0].role, 'tool');
    assert.equal(msgs[0].tool_call_id, 'c1');
    assert.ok(msgs[0].content.includes('hello tool'), `got: ${msgs[0].content}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('toolResultMessages: malformed arguments -> error content, never throws', () => {
  const calls = [{ id: 'c1', function: { name: 'read_file', arguments: '{bad' } }];
  const msgs = toolResultMessages(calls, tmpdir());
  assert.equal(msgs[0].role, 'tool');
  assert.match(msgs[0].content, /error/i);
});

test('buildBody: includes reasoning effort when provided', () => {
  const b = buildBody('google/gemini-3.5-flash', 'prompt text', 'high');
  assert.deepEqual(b.reasoning, { effort: 'high' });
  assert.equal(b.stream, true);
  assert.equal(b.model, 'google/gemini-3.5-flash');
  assert.deepEqual(b.messages, [{ role: 'user', content: 'prompt text' }]);
});

test('buildBody: omits reasoning when effort not provided', () => {
  const b = buildBody('m', 'p', undefined);
  assert.equal(b.reasoning, undefined);
});

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
