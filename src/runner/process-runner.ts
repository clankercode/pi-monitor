import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import {
  chmodSync,
  constants as fsConstants,
  createWriteStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  type WriteStream,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'stream';
import {
  CANCEL_SIGKILL_TIMEOUT_MS,
  PARENT_WATCHDOG_INTERVAL_S,
  PIPE_CLOSE_GRACE_MS,
  PROCESS_LINE_BUFFER_CAP_CHARS,
  PROCESS_OUTPUT_CAP_BYTES,
  PROCESS_OUTPUT_CAP_LINES,
} from '../limits.ts';
import type { OutputEvent, OutputStream } from '../types.ts';

// ----------------------------------------------------------------
// Errors
// ----------------------------------------------------------------

export class ProcessRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProcessRunnerError';
  }
}

// ----------------------------------------------------------------
// Exit result
// ----------------------------------------------------------------

export interface ProcessExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

// ----------------------------------------------------------------
// Tail buffer — rolling window per stream
// ----------------------------------------------------------------

class TailBuffer {
  #lines: string[] = [];
  #bytes = 0;
  #maxLines: number;
  #maxBytes: number;

  constructor(maxLines: number, maxBytes: number) {
    this.#maxLines = maxLines;
    this.#maxBytes = maxBytes;
  }

  get size(): number {
    return this.#lines.length;
  }

  get bytes(): number {
    return this.#bytes;
  }

  add(line: string): void {
    const len = Buffer.byteLength(line, 'utf8');
    this.#lines.push(line);
    this.#bytes += len;
    while (this.#lines.length > this.#maxLines || this.#bytes > this.#maxBytes) {
      const dropped = this.#lines.shift()!;
      this.#bytes -= Buffer.byteLength(dropped, 'utf8');
    }
  }

  snapshot(): string[] {
    return [...this.#lines];
  }
}

// ----------------------------------------------------------------
// Combined chronological tail (for exit messages)
// ----------------------------------------------------------------

class CombinedTailBuffer {
  #lines: string[] = [];
  #maxLines: number;

  constructor(maxLines: number) {
    this.#maxLines = maxLines;
  }

  add(stream: OutputStream, line: string): void {
    this.#lines.push(`[${stream}] ${line}`);
    while (this.#lines.length > this.#maxLines) {
      this.#lines.shift();
    }
  }

  snapshot(n?: number): string[] {
    if (n === undefined || n >= this.#lines.length) return [...this.#lines];
    return this.#lines.slice(-n);
  }
}

// ----------------------------------------------------------------
// ProcessRunner
// ----------------------------------------------------------------

const LINE_TRUNCATED_MARKER = ' …[line truncated]';

// ----------------------------------------------------------------
// Live process groups — synchronous last-resort kill on Pi exit
// ----------------------------------------------------------------

const liveGroups = new Set<number>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // 'exit' handlers must be synchronous; process.kill is.
  process.on('exit', () => {
    for (const pgid of liveGroups) {
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {
        /* group already gone */
      }
    }
    liveGroups.clear();
  });
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    // EPERM means the group exists but is not ours to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Wrapper script run as `/bin/sh -c WRAPPER sh <command> <piPid> <intervalSec>`.
 * A background watcher (stdio detached from the job's pipes) lives in the job's
 * process group and SIGKILLs the whole group once the Pi pid disappears. The
 * user's command runs via `eval` in the same shell, so exit code and output are
 * unchanged; an EXIT trap stops the watcher when the shell ends.
 */
const WATCHDOG_WRAPPER = [
  '( while kill -0 "$2" 2>/dev/null && kill -0 "$$" 2>/dev/null; do sleep "$3"; done;',
  '  kill -0 "$2" 2>/dev/null || kill -KILL -- "-$$" ) </dev/null >/dev/null 2>&1 &',
  'W=$!',
  'trap \'kill "$W" 2>/dev/null\' EXIT',
  'eval "$1"',
].join('\n');

export interface ProcessRunnerOptions {
  /** Pid whose death makes job process groups self-terminate (default: this process). */
  parentPid?: number;
  /** Watchdog poll interval in seconds (default PARENT_WATCHDOG_INTERVAL_S). */
  watchdogIntervalS?: number;
  /** SIGTERM -> SIGKILL grace in ms (default CANCEL_SIGKILL_TIMEOUT_MS). */
  sigkillGraceMs?: number;
  /** Max wait for stdio to close after the shell exits, in ms (default PIPE_CLOSE_GRACE_MS). */
  pipeCloseGraceMs?: number;
}

/**
 * Create (or verify) a private 0700 directory owned by the current user.
 * Refuses symlinks and directories owned by someone else.
 */
function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new ProcessRunnerError(`${dir} is not a plain directory`);
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid !== undefined && st.uid !== uid) {
    throw new ProcessRunnerError(`${dir} is not owned by the current user`);
  }
  if ((st.mode & 0o077) !== 0) {
    chmodSync(dir, 0o700);
  }
}

export interface ProcessRunnerEvents {
  output: OutputEvent;
}

interface ProcessHandle {
  process: ChildProcess;
  exitPromise: Promise<ProcessExitResult>;
  cancelled: boolean;
  outputPath: string;
  logStream: WriteStream;
}

export class ProcessRunner extends EventEmitter {
  #handles = new Map<string, ProcessHandle>();
  // jobID -> stdout/stderr -> TailBuffer
  #tails = new Map<string, Map<OutputStream, TailBuffer>>();
  #combinedTails = new Map<string, CombinedTailBuffer>();
  #outputPaths = new Map<string, string>();
  #nextSeq = 0;
  #sessionDir: string | undefined;
  #parentPid: number;
  #watchdogIntervalS: number;
  #sigkillGraceMs: number;
  #pipeCloseGraceMs: number;

  /**
   * @param sessionDir log directory; when omitted a fresh private directory is
   *   created lazily under `{tmpdir}/pi-monitor-{uid}/` (0700, mkdtemp).
   */
  constructor(sessionDir?: string, options: ProcessRunnerOptions = {}) {
    super();
    this.#sessionDir = sessionDir;
    this.#parentPid = options.parentPid ?? process.pid;
    this.#watchdogIntervalS = options.watchdogIntervalS ?? PARENT_WATCHDOG_INTERVAL_S;
    this.#sigkillGraceMs = options.sigkillGraceMs ?? CANCEL_SIGKILL_TIMEOUT_MS;
    this.#pipeCloseGraceMs = options.pipeCloseGraceMs ?? PIPE_CLOSE_GRACE_MS;
  }

  #resolveSessionDir(): string {
    if (this.#sessionDir === undefined) {
      const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
      const base = join(tmpdir(), `pi-monitor-${uid}`);
      ensurePrivateDir(base);
      this.#sessionDir = mkdtempSync(join(base, 'session-'));
    } else {
      ensurePrivateDir(this.#sessionDir);
    }
    return this.#sessionDir;
  }

  /**
   * Spawn a POSIX shell command.
   * Returns { jobID, exitPromise, outputPath }.
   *
   * - `detached: true` so the process runs in its own process group.
   * - The exit promise is created at spawn time (no race for fast commands).
   * - Output is emitted as `OutputEvent` lines; trailing empty-lines are dropped.
   * - Rolling tails enforce per-stream caps while streams keep draining.
   * - Full output is tee'd to `outputPath` (stream-tagged lines).
   */
  run(jobID: string, command: string): {
    jobID: string;
    exitPromise: Promise<ProcessExitResult>;
    outputPath: string;
  } {
    if (this.#handles.has(jobID)) {
      throw new ProcessRunnerError(`job ${jobID} already running`);
    }

    const outputPath = join(this.#resolveSessionDir(), `${jobID}.log`);
    // Exclusive, no-follow, owner-only create: never reuse or follow a pre-existing path.
    // The fd is opened synchronously so outputPath is valid immediately.
    const logFd = openSync(
      outputPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_APPEND | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const logStream = createWriteStream(outputPath, { fd: logFd });
    // Ignore late write errors (e.g. test teardown deleted the temp dir).
    logStream.on('error', () => {});

    const child = spawn(
      '/bin/sh',
      ['-c', WATCHDOG_WRAPPER, 'sh', command, String(this.#parentPid), String(this.#watchdogIntervalS)],
      {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false, // spawn already does the shell thing
      },
    );
    if (child.pid !== undefined) {
      liveGroups.add(child.pid);
      installExitHook();
    }

    // Create the exit promise BEFORE attaching any listeners — avoids the
    // "fast process exits before handler attached" race. Prefer `close` so
    // stdout/stderr have ended and final partial lines are flushed, but do not
    // wait forever: a backgrounded grandchild (`cmd &`) can hold the pipes open
    // after the shell exits, so `exit` arms a bounded wait.
    const exitPromise = new Promise<ProcessExitResult>((resolve) => {
      let settled = false;
      let pipeTimer: ReturnType<typeof setTimeout> | undefined;
      const settle = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        if (pipeTimer) clearTimeout(pipeTimer);
        resolve({ code, signal });
      };
      child.once('exit', (code, signal) => {
        pipeTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          settle(code, signal as NodeJS.Signals | null);
        }, this.#pipeCloseGraceMs);
        pipeTimer.unref();
      });
      child.once('close', (code, signal) => settle(code, signal as NodeJS.Signals | null));
    });

    void this.#onSpawn(jobID, child, exitPromise, outputPath, logStream);
    return { jobID, exitPromise, outputPath };
  }

  /**
   * Cancel a running job.
   * 1. SIGTERM to the process group (`kill(-pid)`).
   * 2. Wait up to `CANCEL_SIGKILL_TIMEOUT_MS`, then SIGKILL if alive.
   * 3. Fallback to `child.kill(signal)` when group-signal fails.
   *
   * Returns a promise that resolves when the process has actually exited.
   */
  async cancel(jobID: string): Promise<void> {
    const handle = this.#handles.get(jobID);
    if (!handle) {
      throw new ProcessRunnerError(`job ${jobID} not found`);
    }
    if (handle.cancelled) {
      return; // already done
    }
    handle.cancelled = true;

    // Phase 1 — SIGTERM to the whole group
    this.#killGroup(handle.process, 'SIGTERM');

    // Phase 2 — SIGKILL after the grace period. The group is signaled even if
    // the shell already exited: grandchildren may still be alive and ignoring TERM.
    await Promise.race([
      handle.exitPromise.then(() => {}),
      new Promise<void>((r) => setTimeout(r, this.#sigkillGraceMs).unref()),
    ]);
    await this.#escalateIfAlive(handle.process);

    // exitPromise is bounded (pipe-close grace), so this cannot hang on grandchildren.
    await handle.exitPromise;
  }

  /**
   * Get the rolling tail snapshot for a stream.
   */
  tail(jobID: string, stream: OutputStream): string[] {
    const map = this.#tails.get(jobID);
    if (!map) return [];
    const buf = map.get(stream);
    return buf ? buf.snapshot() : [];
  }

  /**
   * Last N chronological lines (stream-tagged) for exit notifications.
   * Prefer the in-memory combined tail; falls back to empty if disposed.
   */
  tailCombined(jobID: string, n: number): string[] {
    const buf = this.#combinedTails.get(jobID);
    if (!buf) return [];
    return buf.snapshot(n);
  }

  /** Path to the full output log for a job (available after run, survives dispose). */
  outputPath(jobID: string): string | undefined {
    return this.#outputPaths.get(jobID);
  }

  /**
   * Dispose a job, terminating it if still running. Does not delete the log file.
   *
   * Escalates like cancel (SIGTERM then SIGKILL after grace) but never blocks:
   * SIGKILL is fire-and-forget so session_shutdown does not hang on exitPromise.
   */
  dispose(jobID: string): void {
    const handle = this.#handles.get(jobID);
    if (handle) {
      handle.cancelled = true;
      const child = handle.process;
      // Always signal the group: the shell may be gone while `cmd &` grandchildren live on.
      this.#killGroup(child, 'SIGTERM');
      if (child.pid !== undefined && groupAlive(child.pid)) {
        // Fire-and-forget SIGKILL escalation — never block session_shutdown.
        const timer = setTimeout(() => {
          void this.#escalateIfAlive(child);
        }, this.#sigkillGraceMs);
        timer.unref();
      } else if (child.pid !== undefined) {
        liveGroups.delete(child.pid);
      }
    }
    if (handle?.logStream) {
      try {
        handle.logStream.end();
      } catch {
        /* ignore */
      }
    }
    this.#handles.delete(jobID);
    this.#tails.delete(jobID);
    this.#combinedTails.delete(jobID);
    // Keep outputPaths so agents can still resolve the log after dispose.
  }

  /** Dispose every running job (e.g. test teardown). Does not delete log files. */
  disposeAll(): void {
    for (const jobID of [...this.#handles.keys()]) {
      this.dispose(jobID);
    }
  }

  // -- Internal --------------------------------------------------

  #onSpawn(
    jobID: string,
    child: ChildProcess,
    exitPromise: Promise<ProcessExitResult>,
    outputPath: string,
    logStream: WriteStream,
  ): void {
    const tails = new Map<OutputStream, TailBuffer>([
      ['stdout', new TailBuffer(PROCESS_OUTPUT_CAP_LINES, PROCESS_OUTPUT_CAP_BYTES)],
      ['stderr', new TailBuffer(PROCESS_OUTPUT_CAP_LINES, PROCESS_OUTPUT_CAP_BYTES)],
    ]);

    // Keep enough combined lines for exit messages even if EXIT_TAIL_LINES grows slightly.
    const combined = new CombinedTailBuffer(PROCESS_OUTPUT_CAP_LINES);

    this.#handles.set(jobID, {
      process: child,
      exitPromise,
      cancelled: false,
      outputPath,
      logStream,
    });
    this.#tails.set(jobID, tails);
    this.#combinedTails.set(jobID, combined);
    this.#outputPaths.set(jobID, outputPath);

    void this.#drainStream(jobID, child.stdout!, 'stdout', tails, combined, logStream);
    void this.#drainStream(jobID, child.stderr!, 'stderr', tails, combined, logStream);

    // End log stream after process fully closes (streams drained via close event).
    void exitPromise.then(() => {
      try {
        logStream.end();
      } catch {
        /* ignore */
      }
    });
  }

  #drainStream(
    jobID: string,
    stream: Readable,
    type: OutputStream,
    tails: Map<OutputStream, TailBuffer>,
    combined: CombinedTailBuffer,
    logStream: WriteStream,
  ): void {
    let buffer = '';
    let pendingEmptyLines = 0;

    const emitLine = (line: string) => {
      this.#emit(jobID, type, line);
      tails.get(type)!.add(line);
      combined.add(type, line);
      try {
        logStream.write(`[${type}] ${line}\n`);
      } catch {
        /* best-effort log */
      }
    };

    const flushPendingEmptyLines = () => {
      while (pendingEmptyLines > 0) {
        emitLine('');
        pendingEmptyLines -= 1;
      }
    };

    stream.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      buffer += text;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.length === 0) {
          pendingEmptyLines += 1;
          continue;
        }
        flushPendingEmptyLines();
        emitLine(line);
      }
      // Unterminated stream: cap the partial-line buffer and flush it as a truncated line.
      while (buffer.length > PROCESS_LINE_BUFFER_CAP_CHARS) {
        flushPendingEmptyLines();
        emitLine(`${buffer.slice(0, PROCESS_LINE_BUFFER_CAP_CHARS)}${LINE_TRUNCATED_MARKER}`);
        buffer = buffer.slice(PROCESS_LINE_BUFFER_CAP_CHARS);
      }
    });

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      // Flush any remaining partial line (no trailing newline).
      if (buffer.length > 0) {
        flushPendingEmptyLines();
        emitLine(buffer);
        buffer = '';
      }
    };
    stream.once('end', finish);
    // Destroyed after the pipe-close grace: no 'end', but still flush what we have.
    stream.once('close', finish);
  }

  #emit(jobID: string, stream: OutputStream, line: string): void {
    const seq = ++this.#nextSeq;
    this.emit('output', {
      jobID,
      seq,
      stream,
      line,
      timestamp: Date.now(),
    } satisfies OutputEvent);
  }

  /** SIGKILL the group if any member survives; drop it from the exit-hook registry once gone. */
  async #escalateIfAlive(child: ChildProcess): Promise<void> {
    const pgid = child.pid;
    if (pgid === undefined) return;
    if (groupAlive(pgid)) {
      this.#killGroup(child, 'SIGKILL');
      try {
        child.kill('SIGKILL');
      } catch {
        /* process already gone */
      }
    }
    // Give the kernel a moment to reap before forgetting the group.
    await new Promise<void>((r) => setTimeout(r, 50).unref());
    if (!groupAlive(pgid)) liveGroups.delete(pgid);
  }

  /** Signal the whole process group (-pgid); fall back to the direct child. */
  #killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
      if (child.pid !== undefined) {
        process.kill(-child.pid, signal);
      }
    } catch {
      /* falls through to direct kill */
    }
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

export default ProcessRunner;
