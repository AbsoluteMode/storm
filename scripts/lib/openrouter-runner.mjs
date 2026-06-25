#!/usr/bin/env node
// scripts/lib/openrouter-runner.mjs
//
// Storm "engine" wrapper for Gemini via OpenRouter, with agentic file tools. Storm
// spawns this as a subprocess. It reads the prompt from stdin, then runs a
// multi-turn tool loop: the model may call read_file / list_dir / grep (sandboxed
// to the working directory — see openrouter-tools.mjs); the wrapper executes each
// call locally and feeds the result back. The final answer goes to stdout;
// tool-call progress goes to stderr. Zero runtime dependencies (built-in fetch).

import { fileURLToPath } from 'node:url';
import { TOOLS, executeTool } from './openrouter-tools.mjs';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_TURNS = 24;

// Pure: split one SSE line into { content, reasoning } text, or null to skip.
// (Kept for streaming callers/tests; the agentic loop below is non-stream.)
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

// Pure: streaming single-turn body (simple path).
export function buildBody(model, prompt, reasoningEffort) {
  const body = { model, stream: true, messages: [{ role: 'user', content: prompt }] };
  if (reasoningEffort) body.reasoning = { effort: reasoningEffort };
  return body;
}

// Pure: non-streaming agentic body — carries the running message list + tools.
export function buildAgenticBody(model, messages, reasoningEffort, tools) {
  const body = { model, messages, stream: false };
  if (tools) body.tools = tools;
  if (reasoningEffort) body.reasoning = { effort: reasoningEffort };
  return body;
}

// Execute each tool_call in the cwd sandbox -> tool-role messages for the next turn.
// Malformed arguments degrade to an error message (never throws).
export function toolResultMessages(toolCalls, cwd) {
  return (toolCalls || []).map((tc) => {
    let args;
    try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = null; }
    const content = args === null
      ? `error: could not parse arguments for ${tc.function?.name}`
      : executeTool(tc.function?.name, args, cwd);
    return { role: 'tool', tool_call_id: tc.id, content };
  });
}

async function main() {
  const model = process.argv[2] || 'google/gemini-3.5-flash';
  const reasoningEffort = process.argv[3] || undefined;
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) { process.stderr.write('openrouter: missing OPENROUTER_API_KEY\n'); process.exit(1); }
  const cwd = process.cwd();

  let prompt = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) prompt += chunk;

  const messages = [{ role: 'user', content: prompt }];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let data;
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(buildAgenticBody(model, messages, reasoningEffort, TOOLS)),
      });
      data = await res.json();
    } catch (e) {
      process.stderr.write(`openrouter fetch failed: ${e.message}\n`);
      process.exit(1);
    }
    if (data.error) {
      process.stderr.write(`openrouter error: ${JSON.stringify(data.error).slice(0, 300)}\n`);
      process.exit(1);
    }
    const msg = data.choices?.[0]?.message;
    if (!msg) { process.stderr.write('openrouter: no message in response\n'); process.exit(1); }

    if (msg.tool_calls && msg.tool_calls.length) {
      messages.push(msg); // assistant turn carrying the tool calls
      for (const tc of msg.tool_calls) {
        process.stderr.write(`→ ${tc.function?.name}(${tc.function?.arguments})\n`); // progress
      }
      messages.push(...toolResultMessages(msg.tool_calls, cwd));
      continue;
    }

    process.stdout.write(msg.content ?? '');
    process.exit(0);
  }

  process.stderr.write(`openrouter: max tool turns (${MAX_TURNS}) reached\n`);
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && typeof m.content === 'string');
  process.stdout.write(lastAssistant?.content ?? '');
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
