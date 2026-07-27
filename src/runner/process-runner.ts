import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { createWriteStream, mkdirSync, openSync, closeSync, type WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'stream';
import {
  CANCEL_SIGKILL_TIMEOUT_MS,
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

export interface ProcessRunnerEvents {
  output: OutputEvent;
}

interface ProcessHandle {
  process: ChildProcess;
  exitPromise: Promise<ProcessExitResult>;
  cancelPending: boolean;
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
  #sessionDir: string;

  constructor(sessionDir?: string) {
    super();
    this.#sessionDir = sessionDir ?? join(tmpdir(), 'pi-monitor', String(process.pid));
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

    mkdirSync(this.#sessionDir, { recursive: true });
    const outputPath = join(this.#sessionDir, `${jobID}.log`);
    // Touch the file synchronously so outputPath is valid immediately (createWriteStream open is async).
    closeSync(openSync(outputPath, 'a'));
    const logStream = createWriteStream(outputPath, { flags: 'a' });
    // Ignore late write errors (e.g. test teardown deleted the temp dir).
    logStream.on('error', () => {});

    const child = spawn('/bin/sh', ['-c', command], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false, // spawn already does the shell thing
    });

    // Create the exit promise BEFORE attaching any listeners — avoids the
    // "fast process exits before handler attached" race. Use `close`, not
    // `exit`, so stdout/stderr have ended and final partial lines are flushed.
    const exitPromise = new Promise<ProcessExitResult>((resolve) => {
      child.once('close', (code, signal) => {
        resolve({ code, signal: signal as NodeJS.Signals | null });
      });
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

    // Phase 1 — SIGTERM
    this.#killGroup(handle.process, 'SIGTERM');

    // Phase 2 — SIGKILL after grace period
    await Promise.race([
      handle.exitPromise.then(() => {}),
      new Promise<void>((r) => setTimeout(r, CANCEL_SIGKILL_TIMEOUT_MS)),
    ]);

    if (handle.cancelPending) {
      // Still alive — bump it with SIGKILL
      this.#killGroup(handle.process, 'SIGKILL');
      // Final fallback: direct kill
      try {
        handle.process.kill('SIGKILL');
      } catch {
        /* process already gone */
      }
    }

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
    if (handle?.cancelPending) {
      handle.cancelled = true;
      this.#killGroup(handle.process, 'SIGTERM');
      const child = handle.process;
      // Fire-and-forget SIGKILL escalation — do not await exitPromise.
      void Promise.race([
        handle.exitPromise.then(() => 'exited' as const),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), CANCEL_SIGKILL_TIMEOUT_MS)),
      ]).then((outcome) => {
        if (outcome === 'timeout') {
          this.#killGroup(child, 'SIGKILL');
          try {
            child.kill('SIGKILL');
          } catch {
            /* process already gone */
          }
        }
      });
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
      cancelPending: true,
      cancelled: false,
      outputPath,
      logStream,
    });
    this.#tails.set(jobID, tails);
    this.#combinedTails.set(jobID, combined);
    this.#outputPaths.set(jobID, outputPath);

    void this.#drainStream(jobID, child.stdout!, 'stdout', tails, combined, logStream);
    void this.#drainStream(jobID, child.stderr!, 'stderr', tails, combined, logStream);

    child.on('exit', () => {
      const h = this.#handles.get(jobID);
      if (h?.cancelPending) {
        h.cancelPending = false;
      }
    });

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
    });

    stream.once('end', () => {
      // Flush any remaining partial line (no trailing newline).
      if (buffer.length > 0) {
        flushPendingEmptyLines();
        emitLine(buffer);
      }
    });
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
