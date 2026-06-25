#!/usr/bin/env node
// scripts/lib/openrouter-runner.mjs
//
// Storm "engine" wrapper for HTTP providers (Gemini via OpenRouter). Storm spawns
// this as a subprocess like any CLI engine. It reads the prompt from stdin and
// streams the OpenRouter SSE response:
//   - content deltas  -> stdout  (the answer; accumulates the STORM_RESULT markers)
//   - reasoning deltas -> stderr  (heartbeat, so run-engine's watchdog sees liveness
//                                  while the model is thinking and doesn't kill it)
// Zero runtime dependencies (built-in fetch + TextDecoder, Node 20+).

import { fileURLToPath } from 'node:url';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

// Pure: split one SSE line into { content, reasoning } text, or null to skip
// (non-data line, [DONE] sentinel, blank, or malformed JSON). Never throws.
export function parseSSELine(line) {
  if (typeof line !== 'string' || !line.startsWith('data:')) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;
  let ev;
  try { ev = JSON.parse(payload); } catch { return null; }
  const delta = ev.choices?.[0]?.delta;
  if (!delta) return null;
  return {
    content: typeof delta.content === 'string' ? delta.content : '',
    reasoning: typeof delta.reasoning === 'string' ? delta.reasoning : '',
  };
}

async function main() {
  const model = process.argv[2] || 'google/gemini-3.5-flash';
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) { process.stderr.write('openrouter: missing OPENROUTER_API_KEY\n'); process.exit(1); }

  let prompt = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) prompt += chunk;

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: prompt }] }),
    });
  } catch (e) {
    process.stderr.write(`openrouter fetch failed: ${e.message}\n`);
    process.exit(1);
  }
  if (!res.ok || !res.body) {
    process.stderr.write(`openrouter HTTP ${res.status}\n`);
    process.exit(1);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const parsed = parseSSELine(line);
      if (!parsed) continue;
      if (parsed.content) process.stdout.write(parsed.content);
      if (parsed.reasoning) process.stderr.write(parsed.reasoning);
    }
  }
  process.exit(0);
}

// Run main only when invoked directly, not when imported for unit tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
