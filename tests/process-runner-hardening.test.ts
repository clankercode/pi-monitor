import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProcessRunner } from '../src/runner/process-runner.ts';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

describe('ProcessRunner hardening', () => {
  const dirs: string[] = [];
  const runners: ProcessRunner[] = [];
  afterEach(() => {
    for (const r of runners.splice(0)) {
      r.disposeAll();
      r.removeAllListeners();
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function makeRunner(opts: ConstructorParameters<typeof ProcessRunner>[1] = {}): { runner: ProcessRunner; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'pi-monitor-hard-'));
    dirs.push(dir);
    const runner = new ProcessRunner(join(dir, 'logs'), { sigkillGraceMs: 300, pipeCloseGraceMs: 300, ...opts });
    runners.push(runner);
    return { runner, dir };
  }

  it('cancel() kills grandchildren that ignore SIGTERM and exitPromise resolves', async () => {
    const { runner, dir } = makeRunner();
    const pidFile = join(dir, 'gc.pid');
    const { exitPromise } = runner.run('j1', `sh -c 'trap "" TERM; echo $$ > ${pidFile}; while :; do sleep 1; done' & wait`);
    assert.ok(await waitFor(() => existsSync(pidFile) && statSync(pidFile).size > 0, 3000));
    const gc = Number((await import('node:fs')).readFileSync(pidFile, 'utf8').trim());
    await runner.cancel('j1');
    await exitPromise;
    assert.ok(await waitFor(() => !alive(gc), 2000), 'grandchild must be dead');
  });

  it('dispose() kills grandchildren after the shell already exited', async () => {
    const { runner, dir } = makeRunner();
    const pidFile = join(dir, 'gc.pid');
    // Shell exits immediately; the grandchild keeps the pipes open.
    const { exitPromise } = runner.run('j2', `sleep 60 & echo $! > ${pidFile}`);
    const result = await exitPromise; // bounded by pipeCloseGraceMs
    assert.equal(result.code, 0);
    const gc = Number((await import('node:fs')).readFileSync(pidFile, 'utf8').trim());
    assert.ok(alive(gc));
    runner.dispose('j2');
    assert.ok(await waitFor(() => !alive(gc), 2000), 'grandchild must be dead after dispose');
  });

  it('exitPromise resolves while a grandchild holds the pipes', async () => {
    const { runner } = makeRunner({ pipeCloseGraceMs: 200 });
    const started = Date.now();
    const { exitPromise } = runner.run('j3', 'sleep 30 & exit 3');
    const result = await exitPromise;
    assert.equal(result.code, 3);
    assert.ok(Date.now() - started < 5000);
    runner.dispose('j3');
  });

  it('watchdog kills the job group when the parent pid disappears', async () => {
    const { dir } = makeRunner();
    const fakeParent = spawn('sleep', ['60'], { stdio: 'ignore' });
    const runner2 = new ProcessRunner(join(dir, 'logs2'), { parentPid: fakeParent.pid!, watchdogIntervalS: 1 });
    runners.push(runner2);
    const pidFile = join(dir, 'w.pid');
    runner2.run('w1', `sleep 60 & echo $! > ${pidFile}; wait`);
    assert.ok(await waitFor(() => existsSync(pidFile) && statSync(pidFile).size > 0, 3000));
    const gc = Number((await import('node:fs')).readFileSync(pidFile, 'utf8').trim());
    assert.ok(alive(gc));
    fakeParent.kill('SIGKILL');
    assert.ok(await waitFor(() => !alive(gc), 6000), 'job group must die once parent is gone');
  });

  async function runCollect(runner: ProcessRunner, id: string, command: string) {
    const lines: string[] = [];
    runner.on('output', (e: { line: string }) => lines.push(e.line));
    const { exitPromise } = runner.run(id, command);
    const result = await exitPromise;
    return { result, lines };
  }

  it('a bare `wait` finishes on its own (watcher is not in the shell job table)', async () => {
    const { runner } = makeRunner({ sigkillGraceMs: 5000, pipeCloseGraceMs: 2000 });
    const started = Date.now();
    const { result, lines } = await runCollect(runner, 'wait1', 'sleep 0.2 & wait; echo done');
    assert.equal(result.code, 0);
    assert.deepEqual(lines, ['done']);
    assert.ok(Date.now() - started < 3000, 'must not hang until Pi exits');
  });

  it('exit code, signal death, EXIT trap and exec keep their native behavior', async () => {
    const { runner } = makeRunner();
    assert.equal((await runCollect(runner, 'c3', 'exit 3')).result.code, 3);

    const sig = await runCollect(runner, 'c4', 'kill -TERM $$; sleep 5');
    assert.equal(sig.result.signal, 'SIGTERM');
    assert.equal(sig.result.code, null);

    const trap = await runCollect(runner, 'c5', 'trap "echo bye" EXIT; exit 4');
    assert.equal(trap.result.code, 4);
    assert.deepEqual(trap.lines, ['bye']);

    const ex = await runCollect(runner, 'c6', 'exec echo execd');
    assert.equal(ex.result.code, 0);
    assert.deepEqual(ex.lines, ['execd']);
  });

  it('wrapper positional parameters do not leak into the user command', async () => {
    const { runner } = makeRunner();
    const { lines } = await runCollect(runner, 'pp', 'echo "[$#][$1][$2]"');
    assert.deepEqual(lines, ['[0][][]']);
  });

  it('cancel() grace is measured on the whole group, not the shell', async () => {
    const { runner, dir } = makeRunner({ sigkillGraceMs: 4000, pipeCloseGraceMs: 300 });
    const pidFile = join(dir, 'g.pid');
    const marker = join(dir, 'graceful');
    const gcScript = `trap "sleep 1; echo ok > ${marker}; exit 0" TERM; echo $$ > ${pidFile}; while :; do sleep 0.1; done`;
    const { exitPromise } = runner.run('g1', `sh -c '${gcScript}' >/dev/null 2>&1 & wait`);
    assert.ok(await waitFor(() => existsSync(pidFile) && statSync(pidFile).size > 0, 3000));
    const gc = Number(readFileSync(pidFile, 'utf8').trim());
    const cancelled = runner.cancel('g1');
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(alive(gc), 'grandchild must still be shutting down at 500ms (no early SIGKILL)');
    await cancelled;
    await exitPromise;
    assert.ok(existsSync(marker), 'grandchild must exit gracefully, not via SIGKILL');
    assert.ok(await waitFor(() => !alive(gc), 2000));
  });

  const hasDash = spawnSync('dash', ['-c', 'exit 0']).status === 0;
  it('watchdog kill line works under dash', { skip: !hasDash && 'dash not installed' }, () => {
    const r = spawnSync('dash', ['-c', 'sleep 30 & kill -s KILL -- "-$$" 2>&1; echo rc=$?'], { encoding: 'utf8' });
    assert.ok(!/Illegal/.test(r.stdout + r.stderr), r.stdout + r.stderr);
  });

  it('watchdog kill line uses the dash-compatible form', () => {
    const src = readFileSync(new URL('../src/runner/process-runner.ts', import.meta.url), 'utf8');
    assert.ok(src.includes('kill -s KILL -- "-$$"'));
    assert.ok(!src.includes('kill -KILL --'));
  });

  it('watchdog does not alter exit code or output', async () => {
    const { runner } = makeRunner();
    const lines: string[] = [];
    runner.on('output', (e: { line: string }) => lines.push(e.line));
    const { exitPromise } = runner.run('j4', 'echo hi; echo err >&2; exit 7');
    const result = await exitPromise;
    assert.equal(result.code, 7);
    assert.deepEqual(lines.sort(), ['err', 'hi']);
  });

  it('flushes an unterminated stream as truncated lines instead of buffering unboundedly', async () => {
    const { runner } = makeRunner();
    const lines: string[] = [];
    runner.on('output', (e: { line: string }) => lines.push(e.line));
    const { exitPromise } = runner.run('j5', `head -c 200000 /dev/zero | tr '\\0' 'a'`);
    await exitPromise;
    assert.ok(lines.length >= 3, `got ${lines.length} lines`);
    assert.ok(lines[0]!.endsWith('[line truncated]'));
    assert.ok(lines.every((l) => l.length <= 65536 + 40));
  });

  it('log file is created 0600 with O_EXCL and never reuses an existing path', async () => {
    const { runner, dir } = makeRunner();
    const { exitPromise, outputPath } = runner.run('j6', 'echo x');
    await exitPromise;
    assert.equal(statSync(outputPath).mode & 0o777, 0o600);
    runner.dispose('j6');
    assert.throws(() => runner.run('j6', 'echo y'), /EEXIST/);
    // symlink at the log path is not followed
    const target = join(dir, 'victim');
    writeFileSync(target, 'keep');
    symlinkSync(target, join(dir, 'logs', 'j7.log'));
    assert.throws(() => runner.run('j7', 'echo z'), /EEXIST|ELOOP/);
    assert.equal((await import('node:fs')).readFileSync(target, 'utf8'), 'keep');
  });

  it('session dir is private (0700) and refuses a symlink base', async () => {
    const { runner, dir } = makeRunner();
    const { exitPromise } = runner.run('j8', 'true');
    await exitPromise;
    assert.equal(statSync(join(dir, 'logs')).mode & 0o777, 0o700);

    const linkDir = join(dir, 'link');
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), linkDir);
    const r2 = new ProcessRunner(linkDir);
    runners.push(r2);
    assert.throws(() => r2.run('x', 'true'), /not a plain directory/);
  });

  it('default session dir is a fresh 0700 mkdtemp dir per runner', async () => {
    const a = new ProcessRunner();
    const b = new ProcessRunner();
    runners.push(a, b);
    const ra = a.run('mon_1', 'true');
    const rb = b.run('mon_1', 'true');
    await Promise.all([ra.exitPromise, rb.exitPromise]);
    assert.notEqual(ra.outputPath, rb.outputPath);
    const uid = process.getuid!();
    assert.match(ra.outputPath, new RegExp(`pi-monitor-${uid}/session-[^/]+/mon_1\\.log$`));
    const parent = join(ra.outputPath, '..');
    assert.equal(statSync(parent).mode & 0o777, 0o700);
    rmSync(parent, { recursive: true, force: true });
    rmSync(join(rb.outputPath, '..'), { recursive: true, force: true });
  });
});
