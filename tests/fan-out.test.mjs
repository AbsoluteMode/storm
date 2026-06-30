// tests/fan-out.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAll } from '../scripts/lib/fan-out.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-engine.mjs', import.meta.url));

// Build a minimal git repo so makeEngineWorkspace produces a real worktree.
function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'storm-fo-test-'));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(dir, 'f.txt'), 'hello\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return dir;
}

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

test('cwd from opts is threaded into each runner call and into the prompt', async () => {
  const seen = [];
  const runner = (id, _prompt, _cfg, opts) => {
    seen.push(opts.cwd);
    return Promise.resolve({ engine: id, status: 'ok', result: 'r' });
  };
  await runAll('task', [{ id: 'claude' }, { id: 'codex' }], { runner, cwd: '/target/repo' });
  assert.deepEqual(seen, ['/target/repo', '/target/repo']);
});

test('proof mode: each engine spawns in its own worktree, cleaned up after', async () => {
  // Build a temp git repo so makeEngineWorkspace can produce real worktrees.
  const repoPath = initRepo();
  try {
    // A runner that uses the real fake-engine in 'cwd' mode (prints process.cwd()).
    const runner = (id, _prompt, _cfg, opts) => {
      const r = spawnSync(process.execPath, [FAKE, 'cwd'], { cwd: opts.cwd, encoding: 'utf8', timeout: 5000 });
      const stdout = r.stdout ?? '';
      const match = stdout.match(/<STORM_RESULT>\n([\s\S]*?)\n<\/STORM_RESULT>/);
      const cwd = match ? match[1].trim() : null;
      return Promise.resolve({ engine: id, status: cwd ? 'ok' : 'no_result', result: cwd });
    };
    const engines = [{ id: 'claude' }, { id: 'codex' }];
    const results = await runAll('task', engines, { runner, cwd: repoPath, proof: true, timeoutMs: 10000 });

    // Each result must be ok and its cwd must be a storm-ws-* dir, not the repo root.
    assert.equal(results.length, 2);
    const cwds = results.map((r) => {
      assert.equal(r.status, 'ok', `engine ${r.engine} should be ok, got ${r.status}: ${r.error}`);
      return r.result;
    });
    const realTmpdir = realpathSync(tmpdir());
    for (const cwd of cwds) {
      assert.ok(cwd, 'cwd result should be non-empty');
      assert.notEqual(cwd, repoPath, 'each engine should run in its own worktree, not the repo root');
      assert.ok(cwd.startsWith(realTmpdir), `worktree dir should be under tmpdir(), got: ${cwd}`);
      assert.match(cwd, /storm-ws-/, 'worktree dir should match storm-ws-* prefix');
    }
    // All worktrees must be distinct.
    assert.notEqual(cwds[0], cwds[1], 'each engine should get its own distinct worktree');

    // Cleanup must have run: THIS run's specific worktree dirs must be gone.
    // (Scanning tmpdir globally for storm-ws-* is non-isolable — sibling test
    // files run in parallel under the same tmpdir and create their own.)
    for (const cwd of cwds) {
      assert.equal(existsSync(cwd), false, `worktree should be cleaned up after runAll, still exists: ${cwd}`);
    }
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('proof off: engines share the opts.cwd (no worktree created)', async () => {
  // Without proof mode, the existing behavior must be unchanged: all engines
  // receive opts.cwd directly, no per-engine worktree is created.
  const seen = [];
  const runner = (id, _prompt, _cfg, opts) => {
    seen.push(opts.cwd);
    return Promise.resolve({ engine: id, status: 'ok', result: 'r' });
  };
  await runAll('task', [{ id: 'claude' }, { id: 'codex' }], { runner, cwd: '/target/repo', proof: false });
  assert.deepEqual(seen, ['/target/repo', '/target/repo']);
});

test('proof mode: experimentEnv from engine config is passed as opts.env to runner', async () => {
  // e.experimentEnv must flow to runner's opts.env so the test key reaches the child.
  // Use a real temp git repo so makeEngineWorkspace succeeds and the runner is reached.
  const repoPath = initRepo();
  try {
    const seen = [];
    const runner = (id, _prompt, _cfg, opts) => {
      seen.push({ id, env: opts.env });
      return Promise.resolve({ engine: id, status: 'ok', result: 'r' });
    };
    const engines = [
      { id: 'claude', experimentEnv: { TEST_KEY: 'abc' } },
      { id: 'codex' },
    ];
    await runAll('task', engines, { runner, cwd: repoPath, proof: true });
    const claudeOpts = seen.find((s) => s.id === 'claude');
    const codexOpts = seen.find((s) => s.id === 'codex');
    assert.deepEqual(claudeOpts.env, { TEST_KEY: 'abc' });
    // codex has no experimentEnv — opts.env should be undefined or absent
    assert.ok(codexOpts.env === undefined || codexOpts.env === null || Object.keys(codexOpts.env ?? {}).length === 0, 'codex should have no experimentEnv');
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('per-engine stallMs is threaded into each runner call; missing falls back to global', async () => {
  const seen = {};
  const runner = (id, _p, _c, opts) => {
    seen[id] = opts.stallMs;
    return Promise.resolve({ engine: id, status: 'ok', result: 'r' });
  };
  const engines = [{ id: 'claude', stallMs: 20000 }, { id: 'codex', stallMs: 180000 }, { id: 'glm' }];
  await runAll('task', engines, { runner, stallMs: 999 });
  assert.equal(seen.claude, 20000);
  assert.equal(seen.codex, 180000);
  assert.equal(seen.glm, 999); // no per-engine value -> global fallback
});

test('partial synthesis: a stalled engine resolves and does not block the others', async () => {
  const runner = (id) =>
    id === 'glm'
      ? Promise.resolve({ engine: id, status: 'stalled', error: 'no output for 60000ms' })
      : Promise.resolve({ engine: id, status: 'ok', result: 'r' });
  const results = await runAll('task', [{ id: 'claude' }, { id: 'glm' }, { id: 'codex' }], { runner });
  assert.equal(results.length, 3);
  assert.equal(results.find((r) => r.engine === 'glm').status, 'stalled');
  assert.equal(results.filter((r) => r.status === 'ok').length, 2);
});

test('heartbeat emits a periodic per-engine progress line to onHeartbeat', async () => {
  const lines = [];
  const runner = async (id, _p, _c, opts) => {
    opts.onProgress?.({ chunks: 3, lastActivityAt: Date.now() });
    await new Promise((r) => setTimeout(r, 70)); // ~3x the 20ms heartbeat -> >=1 tick
    return { engine: id, status: 'ok', result: 'r' };
  };
  await runAll('task', [{ id: 'claude' }, { id: 'codex' }], {
    runner, heartbeatMs: 20, onHeartbeat: (l) => lines.push(l),
  });
  assert.ok(lines.length > 0, 'should emit at least one heartbeat line');
  assert.match(lines[0], /\[storm \+\d+s\]/);
  assert.match(lines[0], /claude:/);
  assert.match(lines[0], /codex:/);
});

test('heartbeatMs <= 0 disables the heartbeat', async () => {
  const lines = [];
  const runner = (id) => Promise.resolve({ engine: id, status: 'ok', result: 'r' });
  await runAll('task', [{ id: 'claude' }], { runner, heartbeatMs: 0, onHeartbeat: (l) => lines.push(l) });
  assert.equal(lines.length, 0);
});
