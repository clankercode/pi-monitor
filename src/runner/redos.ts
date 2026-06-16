/**
 * ReDoS pattern vetting for monitor job startup.
 *
 * Uses worker_threads isolation with configurable timeout and concurrency limits.
 * No external regex dependencies. No Pi/bridge/HTTP/MCP/status-store concepts.
 *
 * Adapted from the OpenCode monitor plugin's redos-worker.ts / redos-thread.ts.
 */

import { Worker } from 'worker_threads';
import {
  REDOS_MAX_CONCURRENT,
  REDOS_TIMEOUT_MS,
} from '../limits.ts';

// ----------------------------------------------------------------
// Fast-path safe patterns
// ----------------------------------------------------------------
/**
 * Patterns that are trivially safe and should skip the worker-based ReDoS
 * vetting entirely. This avoids worker-thread startup latency under load.
 */
const SAFE_PATTERN_RE = /^(?:\^?\.\*\$?|\^?\[\^\]?\*\$?|\^?\.\+\$?)$/;

// ----------------------------------------------------------------
// Errors
// ----------------------------------------------------------------
export class RedosTimeoutError extends Error {
  constructor(message?: string) {
    super(message ?? 'ReDoS regex check timed out');
    this.name = 'RedosTimeoutError';
  }
}

// ----------------------------------------------------------------
// Inline thread code (eval: true)
// ----------------------------------------------------------------
const THREAD_CODE = `
import { isMainThread, parentPort, workerData } from 'worker_threads';

if (isMainThread === false) {
  const data = workerData;
  try {
    const re = new RegExp(data.pattern, data.flags ?? '');
    const results = data.texts.map((text) => re.test(text));
    parentPort?.postMessage({ ok: true, results });
  } catch (err) {
    parentPort?.postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
`;

// ----------------------------------------------------------------
// Pool
// ----------------------------------------------------------------
interface WorkerResult {
  ok: true;
  results: boolean[];
}

interface WorkerError {
  ok: false;
  error: string;
}

type WorkerMessage = WorkerResult | WorkerError;

/**
 * Worker pool with timeout enforcement.
 * Limits concurrency to REDOS_MAX_CONCURRENT.
 * Rejects additional calls when the pool is full.
 */
class WorkerPool {
  #pool = new Set<Worker>();
  #pending = 0;
  #closed = false;

  post(pattern: string, flags: string, texts: string[], timeoutMs: number): Promise<WorkerResult> {
    if (this.#closed) throw new RedosTimeoutError('pool closed');
    if (this.#pending >= REDOS_MAX_CONCURRENT) {
      throw new RedosTimeoutError('worker pool full');
    }
    return this.#run(pattern, flags, texts, timeoutMs);
  }

  #run(
    pattern: string,
    flags: string,
    texts: string[],
    timeoutMs: number,
  ): Promise<WorkerResult> {
    this.#pending += 1;
    let worker: Worker;
    try {
      worker = new Worker(THREAD_CODE, {
        eval: true,
        workerData: { pattern, flags, texts },
      });
    } catch (err) {
      this.#freeSlot();
      return Promise.reject(err);
    }
    this.#pool.add(worker);

    return new Promise<WorkerResult>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const settle = (ok: boolean, result: WorkerResult | Error) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        // Free the slot so subsequent calls can proceed.
        this.#freeSlot();
        ok ? resolve(result as WorkerResult) : reject(result as Error);
      };

      worker.once('online', () => {
        if (settled) return;
        timer = setTimeout(() => {
          worker.terminate();
          settle(false, new RedosTimeoutError());
        }, timeoutMs);
      });

      worker.once('message', (msg: WorkerMessage) => {
        if ((msg as WorkerResult).ok) {
          settle(true, msg as WorkerResult);
        } else {
          settle(false, new Error((msg as WorkerError).error));
        }
      });

      worker.once('error', (err) => {
        settle(false, err);
      });

      worker.once('exit', () => {
        this.#pool.delete(worker);
        // If the worker exited before posting a message or error
        // (crash, OOM, SIGKILL, or pre-online termination), settle
        // the promise so it rejects instead of hanging and free the slot.
        if (!settled) {
          settle(false, new Error('worker exited prematurely'));
        }
      });
    });
  }

  #freeSlot(): void {
    if (this.#pending > 0) this.#pending -= 1;
  }

  close(): Promise<void> {
    this.#closed = true;
    const promises: Promise<void>[] = [];
    for (const w of this.#pool) {
      promises.push(
        new Promise<void>((resolve) => {
          const done = () => resolve();
          w.once('exit', done);
          w.terminate();
          setTimeout(done, 2000);
        }),
      );
    }
    this.#pool.clear();
    return Promise.all(promises).then(() => {});
  }
}

// ----------------------------------------------------------------
// ReDoSWorker — user-facing class API
// ----------------------------------------------------------------
export class ReDoSWorker {
  #pool = new WorkerPool();

  test(
    pattern: string,
    flags: string,
    texts: string[],
    timeoutMs: number = REDOS_TIMEOUT_MS,
  ): Promise<boolean[]> {
    return this.#pool.post(pattern, flags, texts, timeoutMs).then((r) => r.results);
  }

  close(): Promise<void> {
    return this.#pool.close();
  }
}

// ----------------------------------------------------------------
// Shared pool singleton (used by vetRegexPattern)
// ----------------------------------------------------------------
let _sharedPool: WorkerPool | null = new WorkerPool();

function getSharedPool(): WorkerPool {
  if (!_sharedPool) _sharedPool = new WorkerPool();
  return _sharedPool;
}

// Cache vet results per pattern+flags to avoid redundant worker runs.
const _vetCache = new Map<string, boolean>();

function cacheKey(pattern: string, flags: string): string {
  return JSON.stringify({ pattern, flags });
}

/**
 * Vets a regex pattern against pathological inputs to detect ReDoS risk.
 *
 * Anchors the pattern with `^`/`$` and tests against increasing lengths of
 * both matching and non-matching inputs. The anchored form forces the engine
 * to match the full string, exposing exponential backtracking.
 *
 * Results are cached per pattern+flags.
 *
 * Returns `true` if the pattern is safe (no ReDoS detected).
 * Throws `RedosTimeoutError` if a pathological input times out.
 * Throws on invalid regex syntax.
 */
export async function vetRegexPattern(
  pattern: string,
  flags?: string,
): Promise<boolean> {
  const key = cacheKey(pattern, flags ?? '');
  const cached = _vetCache.get(key);
  if (cached !== undefined) return cached;

  // Fast-path trivially safe patterns to avoid worker-thread startup latency.
  if (SAFE_PATTERN_RE.test(pattern)) {
    _vetCache.set(key, true);
    return true;
  }

  const pool = getSharedPool();
  // Anchor so the engine must match the entire string.
  const anchored = '^' + pattern + '$';

  // Increasing lengths of 'a's (matching) and 'a's + trailing '!' (non-matching).
  const lengths = [20, 32, 64, 128];
  const texts: string[] = [];
  for (const n of lengths) {
    texts.push('a'.repeat(n));
    texts.push('a'.repeat(n) + '!');
  }

  await pool.post(anchored, flags ?? '', texts, REDOS_TIMEOUT_MS);
  _vetCache.set(key, true);
  return true;
}

/**
 * Shuts down the shared pool.
 * Call this at the end of a test run or on shutdown.
 */
export function close(): Promise<void> {
  const pool = _sharedPool;
  _sharedPool = null;
  _vetCache.clear();
  return pool ? pool.close() : Promise.resolve();
}

export default ReDoSWorker;
