// tests/result-parser.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractResult, salvageTail } from '../scripts/lib/result-parser.mjs';

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

// Bug A: brittle marker parsing edge cases

test('Bug A: valid block followed by stray unclosed OPEN -> returns the valid block (NOT unterminated)', () => {
  const raw = '<STORM_RESULT>good answer</STORM_RESULT>\nsome trailing text <STORM_RESULT>oops unclosed';
  assert.deepEqual(extractResult(raw), { ok: true, result: 'good answer' });
});

test('Bug A: two complete blocks -> returns the LAST complete one', () => {
  const raw = '<STORM_RESULT>first block</STORM_RESULT>\n<STORM_RESULT>second block</STORM_RESULT>';
  assert.deepEqual(extractResult(raw), { ok: true, result: 'second block' });
});

test('Bug A: prompt template echo before real answer -> returns the last complete block', () => {
  // Engine echoes the prompt which contains marker lines as examples, then provides real answer
  const raw = 'Here is the format:\n<STORM_RESULT>\n(your answer here)\n</STORM_RESULT>\n\nNow my actual answer:\n<STORM_RESULT>\nreal finding\n</STORM_RESULT>';
  assert.deepEqual(extractResult(raw), { ok: true, result: 'real finding' });
});

test('Bug A: unclosed only (OPEN, no CLOSE) -> unterminated', () => {
  assert.deepEqual(extractResult('<STORM_RESULT>oops no close'), { ok: false, reason: 'unterminated' });
});

test('Bug A: nested/extra OPEN inside block -> uses last OPEN before last CLOSE', () => {
  // Content has an extra OPEN inside — last OPEN before the last CLOSE determines the body
  const raw = '<STORM_RESULT>outer start <STORM_RESULT>inner content</STORM_RESULT>';
  // Last CLOSE is at end; last OPEN before that CLOSE is "inner"; result is "inner content"
  assert.deepEqual(extractResult(raw), { ok: true, result: 'inner content' });
});

// salvageTail unit tests (Bug B)

test('salvageTail: long input truncates to maxLen tail', () => {
  const longText = 'A'.repeat(3000);
  const tail = salvageTail(longText, 2000);
  assert.equal(tail.length, 2000);
  assert.equal(tail, 'A'.repeat(2000));
});

test('salvageTail: short input returned whole', () => {
  const short = 'hello world this is a short answer';
  assert.equal(salvageTail(short, 2000), short);
});

test('salvageTail: whitespace-only input -> empty string', () => {
  assert.equal(salvageTail('   \n\t\n  ', 2000), '');
});

test('salvageTail: empty string -> empty string', () => {
  assert.equal(salvageTail('', 2000), '');
});

test('salvageTail: trims leading/trailing whitespace from tail', () => {
  const text = '   some answer with leading and trailing spaces   ';
  assert.equal(salvageTail(text, 2000), 'some answer with leading and trailing spaces');
});

test('salvageTail: default maxLen is 2000', () => {
  const longText = 'X'.repeat(5000);
  const tail = salvageTail(longText);
  assert.equal(tail.length, 2000);
});
