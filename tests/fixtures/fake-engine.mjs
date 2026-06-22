// tests/fixtures/fake-engine.mjs
// modes: ok | nomarker | slow | utf8split  (arg 1)
const mode = process.argv[2];
if (mode === 'ok') {
  process.stdout.write('progress chatter...\n<STORM_RESULT>\n- ok finding\n</STORM_RESULT>\n');
  process.exit(0);
} else if (mode === 'nomarker') {
  process.stdout.write('blah blah no markers here\n');
  process.exit(0); // exit 0 on purpose: must not be treated as success
} else if (mode === 'slow') {
  setTimeout(() => process.stdout.write('too late\n'), 10000);
} else if (mode === 'utf8split') {
  // Write a multi-byte UTF-8 string split mid-codepoint across two writes to
  // reproduce chunk-split corruption (each codepoint in the multi-byte chars
  // spans >=2 bytes; splitting the buffer at byte 18 lands inside one of them).
  const buf = Buffer.from('<STORM_RESULT>\nпривет café 你好 €\n</STORM_RESULT>\n', 'utf8');
  process.stdout.write(buf.subarray(0, 18));
  process.stdout.write(buf.subarray(18));
  process.exit(0);
}
