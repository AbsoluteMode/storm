// tests/result-parser.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractResult } from '../scripts/lib/result-parser.mjs';

test('extracts content between markers, trimmed', () => {
  const raw = 'noise\n<STORM_RESULT>\n- finding A\n</STORM_RESULT>\ntrailing';
  assert.deepEqual(extractResult(raw), { ok: true, result: '- finding A' });
});

test('takes the LAST block when several exist', () => {
  const raw = '<STORM_RESULT>old</STORM_RESULT>\n<STORM_RESULT>new</STORM_RESULT>';
  assert.deepEqual(extractResult(raw), { ok: true, result: 'new' });
});

test('no marker -> no_marker', () => {
  assert.deepEqual(extractResult('just chatter'), { ok: false, reason: 'no_marker' });
});

test('unterminated -> unterminated', () => {
  assert.deepEqual(extractResult('<STORM_RESULT>oops'), { ok: false, reason: 'unterminated' });
});

test('empty body -> empty_result', () => {
  assert.deepEqual(extractResult('<STORM_RESULT>   </STORM_RESULT>'), { ok: false, reason: 'empty_result' });
});

test('non-string -> empty', () => {
  assert.deepEqual(extractResult(undefined), { ok: false, reason: 'empty' });
});
