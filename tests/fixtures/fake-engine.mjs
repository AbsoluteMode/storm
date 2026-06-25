// tests/fixtures/fake-engine.mjs
// modes: ok | nomarker | slow | utf8split | stdin  (arg 1)
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
} else if (mode === 'stdin') {
  // Read ALL of stdin then echo it inside STORM_RESULT markers.
  // This lets tests assert that the prompt arrived via stdin, not argv.
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { data += chunk; });
  process.stdin.on('end', () => {
    process.stdout.write(`<STORM_RESULT>\n${data}\n</STORM_RESULT>\n`);
    process.exit(0);
  });
} else if (mode === 'chatty') {
  // Produces substantial output (>= 40 chars) WITHOUT any markers — simulates
  // an engine that answered but forgot to wrap in STORM_RESULT tags.
  process.stdout.write('This is a detailed analysis of the topic at hand. The engine produced a real answer but forgot to include the required STORM_RESULT markers. This content should be salvaged.\n');
  process.exit(0);
} else if (mode === 'tiny') {
  // Produces trivial/short output without markers — too short to salvage.
  process.stdout.write('ok\n');
  process.exit(0);
}
// silent-hang: produce NO output and never exit on its own (until killed)
else if (mode === 'silent-hang') {
  setInterval(() => {}, 1000); // keep process alive, emit nothing
}
// auth-prompt: emit a CLI auth-failure line, then keep quiet (a REAL auth hang:
// prompt + silence waiting for input). The grace timer should fire -> auth_required.
else if (mode === 'auth-prompt') {
  process.stdout.write('You are not logged in. Run `claude login` to continue.\n');
  setInterval(() => {}, 1000);
}
// auth-then-work: emit an auth-looking line, then KEEP streaming and finish ok.
// Simulates codex echoing auth vocabulary while genuinely alive — must NOT be
// killed. Each chunk is long enough that ~30 of them push the auth phrase out of
// the 1000-char scan tail, proving liveness both ways (re-arm + tail eviction).
else if (mode === 'auth-then-work') {
  process.stdout.write('Authentication required for this provider.\n');
  let n = 0;
  const iv = setInterval(() => {
    process.stdout.write(`. still working ${n} with plenty of fresh output to push the auth line out of the scan tail and prove the engine is alive\n`);
    if (++n >= 30) {
      clearInterval(iv);
      process.stdout.write('<STORM_RESULT>\n- done despite the auth noise\n</STORM_RESULT>\n');
      process.exit(0);
    }
  }, 20);
}
// echo-env: echo a custom env var + whether PATH was inherited. Lets tests assert
// that per-engine env is MERGED into the child (custom var delivered) rather than
// REPLACING the inherited environment (PATH must survive).
else if (mode === 'echo-env') {
  const v = process.env.STORM_TEST_VAR ?? 'UNSET';
  const path = process.env.PATH ? 'PATH_PRESENT' : 'PATH_MISSING';
  process.stdout.write(`<STORM_RESULT>\n${v}|${path}\n</STORM_RESULT>\n`);
  process.exit(0);
}
// stream-json: emit NDJSON events with gaps (heartbeat), then a final result
// event carrying the STORM_RESULT markers. Simulates claude/glm under
// --output-format stream-json. The 30ms gaps exercise stall re-arming.
else if (mode === 'stream-json') {
  const events = [
    { type: 'system', subtype: 'init' },
    { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'reasoning...' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: '<STORM_' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'RESULT>\n- streamed\n</STORM_RESULT>' } },
    { type: 'result', subtype: 'success', result: '<STORM_RESULT>\n- streamed finding\n</STORM_RESULT>' },
  ];
  let i = 0;
  const iv = setInterval(() => {
    process.stdout.write(JSON.stringify(events[i]) + '\n');
    if (++i >= events.length) { clearInterval(iv); process.exit(0); }
  }, 30);
}
// stream-json-nofinal: text_delta events but NO result event -> exercises the
// delta-assembly fallback. Markers split across two deltas.
else if (mode === 'stream-json-nofinal') {
  const events = [
    { type: 'content_block_delta', delta: { type: 'text_delta', text: '<STORM_RESULT>\n- assembled' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: ' from deltas\n</STORM_RESULT>' } },
  ];
  let i = 0;
  const iv = setInterval(() => {
    process.stdout.write(JSON.stringify(events[i]) + '\n');
    if (++i >= events.length) { clearInterval(iv); process.exit(0); }
  }, 20);
}
// stream-json-garbage: a malformed line between valid events -> parser must skip
// it (tolerant) and still extract the result.
else if (mode === 'stream-json-garbage') {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    '{ this is not valid json',
    JSON.stringify({ type: 'result', subtype: 'success', result: '<STORM_RESULT>\n- survived garbage\n</STORM_RESULT>' }),
  ];
  let i = 0;
  const iv = setInterval(() => {
    process.stdout.write(lines[i] + '\n');
    if (++i >= lines.length) { clearInterval(iv); process.exit(0); }
  }, 20);
}
// slow-stream: emit a heartbeat chunk every 40ms for ~2s, then a valid result.
// Frequent chunks (40ms) vs the test's stallMs (1000ms) give a ~25x margin so
// the "heartbeat resets stall" test stays green even under machine load.
else if (mode === 'slow-stream') {
  let n = 0;
  const iv = setInterval(() => {
    process.stdout.write(`. tick ${n}\n`);
    if (++n >= 50) {
      clearInterval(iv);
      process.stdout.write('<STORM_RESULT>\n- slow but alive\n</STORM_RESULT>\n');
      process.exit(0);
    }
  }, 40);
}
