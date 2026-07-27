import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { OutputEvent } from '../src/types.ts';
import { ProcessRunner, type ProcessExitResult } from '../src/runner/process-runner.ts';
import { PROCESS_OUTPUT_CAP_LINES } from '../src/limits.ts';

function waitForOutput(runner: ProcessRunner, jobID: string, maxLines = 4): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    const lines: string[] = [];
    const handler = (ev: { jobID: string; line: string }) => {
      if (ev.jobID === jobID) {
        lines.push(ev.line);
        if (lines.length >= maxLines) {
          runner.off('output', handler);
          resolve(lines);
        }
      }
    };
    runner.on('output', handler);
  });
}

function waitForExit(
  runner: ProcessRunner,
  jobID: string,
  exitPromise: Promise<ProcessExitResult>,
): Promise<ProcessExitResult> {
  return exitPromise.then((result) => {
    runner.dispose(jobID);
    return result;
  });
}

describe('ProcessRunner', () => {
  let runner: ProcessRunner;
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = join(tmpdir(), `pi-monitor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    runner = new ProcessRunner(sessionDir);
  });

  afterEach(() => {
    runner.disposeAll();
    runner.removeAllListeners();
    try {
      rmSync(sessionDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('spawns with /bin/sh -c and detached group', async () => {
    const id = 'pr_1';
    const { exitPromise } = runner.run(id, 'echo hello');
    const result = await waitForExit(runner, id, exitPromise);
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
  });

  it('creates exit promise before listeners', async () => {
    const id = 'pr_fast';
    const { exitPromise } = runner.run(id, 'true');
    const result = await Promise.race([
      exitPromise,
      new Promise<ProcessExitResult>((r) => setTimeout(() => r({ code: -1, signal: null }), 2000)),
    ]);
    assert.equal(result.code, 0);
    runner.dispose(id);
  });

  it('rejects duplicate jobID', () => {
    runner.run('dup', 'echo 1');
    assert.throws(() => runner.run('dup', 'echo 2'), { message: /already running/ });
  });

  it('emits OutputEvent with correct shape', async () => {
    const { exitPromise } = runner.run('out_1', 'echo hello');
    const lines = await waitForOutput(runner, 'out_1', 1);
    assert.ok(lines.includes('hello'));
    await exitPromise;
    runner.dispose('out_1');
  });

  it('emits globally unique increasing seqs across streams', async () => {
    const id = 'seq_1';
    const events: OutputEvent[] = [];
    runner.on('output', (ev) => {
      if (ev.jobID === id) events.push(ev);
    });
    const { exitPromise } = runner.run(id, 'printf "out1\\nout2\\n"; printf "err1\\nerr2\\n" >&2');
    await exitPromise;
    const nonEmptyEvents = events.filter((e) => e.line.length > 0).sort((a, b) => a.seq - b.seq);
    assert.equal(new Set(nonEmptyEvents.map((e) => e.seq)).size, nonEmptyEvents.length);
    for (let i = 1; i < nonEmptyEvents.length; i++) {
      assert.ok(nonEmptyEvents[i].seq > nonEmptyEvents[i - 1].seq);
    }
    runner.dispose(id);
  });

  it('flushes final partial line on stream end', async () => {
    const id = 'partial-flush';
    const events: OutputEvent[] = [];
    runner.on('output', (ev) => {
      if (ev.jobID === id) events.push(ev);
    });
    const { exitPromise } = runner.run(id, "printf 'done'");
    await exitPromise;
    const stdoutLines = events.filter((e) => e.stream === 'stdout').map((e) => e.line);
    assert.ok(stdoutLines.includes('done'));
    runner.dispose(id);
  });

  it('tail includes final partial line', async () => {
    const id = 'partial-tail';
    const { exitPromise } = runner.run(id, "printf 'hello world'");
    await exitPromise;
    const tail = runner.tail(id, 'stdout');
    assert.ok(tail.includes('hello world'));
    runner.dispose(id);
  });

  it('preserves non-trailing blank output lines', async () => {
    const id = 'blank-lines';
    const events: OutputEvent[] = [];
    runner.on('output', (ev) => {
      if (ev.jobID === id && ev.stream === 'stdout') events.push(ev);
    });
    const { exitPromise } = runner.run(id, "printf 'first\\n\\n'; sleep 0.1; printf 'second\\n'");
    await exitPromise;
    assert.deepStrictEqual(events.map((e) => e.line), ['first', '', 'second']);
    runner.dispose(id);
  });

  it('tail cap respects rolling 200-line limit', async () => {
    const id = 'tail_roll';
    const { exitPromise } = runner.run(id, 'for i in $(seq 0 249); do echo $i; done');
    await exitPromise;
    const tail = runner.tail(id, 'stdout');
    assert.equal(tail.length, PROCESS_OUTPUT_CAP_LINES);
    assert.ok(!tail.includes('0'));
    assert.ok(tail.includes('249'));
    runner.dispose(id);
  });

  it('emits stderr output events', async () => {
    const id = 'stderr_1';
    const events: OutputEvent[] = [];
    runner.on('output', (ev) => {
      if (ev.jobID === id) events.push(ev);
    });
    const { exitPromise } = runner.run(id, 'echo "err" >&2');
    await exitPromise;
    const stderrEvents = events.filter((e) => e.stream === 'stderr');
    assert.ok(stderrEvents.length >= 1);
    assert.equal(stderrEvents[0].line, 'err');
    runner.dispose(id);
  });

  it('tail tracks stderr independently', async () => {
    const id = 'stderr_tail';
    const { exitPromise } = runner.run(id, 'echo out; echo err >&2');
    await exitPromise;
    assert.ok(runner.tail(id, 'stdout').includes('out'));
    assert.ok(runner.tail(id, 'stderr').includes('err'));
    runner.dispose(id);
  });

  it('writes full output log with stream tags', async () => {
    const id = 'log_1';
    const { exitPromise, outputPath } = runner.run(id, 'echo hello; echo warn >&2');
    await exitPromise;
    assert.ok(existsSync(outputPath));
    // Wait for log stream to flush both lines (end is async after close).
    const deadline = Date.now() + 2_000;
    let content = '';
    while (Date.now() < deadline) {
      content = readFileSync(outputPath, 'utf8');
      if (content.includes('[stdout] hello') && content.includes('[stderr] warn')) break;
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.ok(content.includes('[stdout] hello'), `stdout missing in: ${JSON.stringify(content)}`);
    assert.ok(content.includes('[stderr] warn'), `stderr missing in: ${JSON.stringify(content)}`);
    assert.equal(runner.outputPath(id), outputPath);
    runner.dispose(id);
    // Path still resolvable after dispose
    assert.equal(runner.outputPath(id), outputPath);
    assert.ok(existsSync(outputPath));
  });

  it('returns non-zero exit code', async () => {
    const id = 'exit_7';
    const { exitPromise } = runner.run(id, 'exit 7');
    const result = await waitForExit(runner, id, exitPromise);
    assert.equal(result.code, 7);
  });

  it('tailCombined returns stream-tagged chronological lines', async () => {
    const id = 'combined';
    const { exitPromise } = runner.run(id, 'echo a; echo b');
    await exitPromise;
    const combined = runner.tailCombined(id, 10);
    assert.ok(combined.some((l) => l.includes('[stdout] a')));
    assert.ok(combined.some((l) => l.includes('[stdout] b')));
    const last1 = runner.tailCombined(id, 1);
    assert.equal(last1.length, 1);
    runner.dispose(id);
  });

  it('cancel throws for unknown jobID', async () => {
    await assert.rejects(() => runner.cancel('ghost_0'), { message: /not found/ });
  });

  it('cancel is idempotent for already-cancelled job', async () => {
    const id = 'cancel-idem';
    runner.run(id, 'sleep 30');
    await runner.cancel(id);
    await runner.cancel(id);
    runner.dispose(id);
  });

  it('cancel returns when process has already exited', async () => {
    const id = 'fast-cancel';
    const { exitPromise } = runner.run(id, 'echo done');
    await exitPromise;
    await runner.cancel(id);
    runner.dispose(id);
  });

  it('cancel uses SIGTERM + SIGKILL to process group', async () => {
    const id = 'group-kill';
    const { exitPromise } = runner.run(id, 'sleep 60');
    await runner.cancel(id);
    const result = await exitPromise;
    // Killed processes typically report null code and a signal
    assert.ok(result.code === null || result.code !== 0 || result.signal !== null);
    runner.dispose(id);
  });

  it('dispose clears handles', () => {
    const id = 'ds_1';
    runner.run(id, 'sleep 60');
    runner.dispose(id);
    assert.deepStrictEqual(runner.tail(id, 'stdout'), []);
  });

  it('dispose SIGTERMs without blocking on exitPromise', async () => {
    const id = 'ds_async';
    const { exitPromise } = runner.run(id, 'sleep 60');
    const started = Date.now();
    runner.dispose(id);
    const elapsed = Date.now() - started;
    // dispose must return immediately (not wait for SIGKILL grace)
    assert.ok(elapsed < 500, `dispose blocked for ${elapsed}ms`);
    // Process should still be killed asynchronously; exitPromise may resolve later.
    // Do not hang the test suite waiting the full grace — best-effort wait.
    await Promise.race([
      exitPromise,
      new Promise((r) => setTimeout(r, 200)),
    ]);
  });
});
