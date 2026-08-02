import { formatMonitorXml } from './delivery-format.ts';
import type { PiMonitorMessageDetails } from './ui/compact-monitor-message.ts';

export interface MonitorDeliveryMessage {
  customType: 'pi-monitor';
  content: string;
  display: true;
  details: PiMonitorMessageDetails;
}

export interface MonitorDeliveryBatch {
  raw: string;
  details: PiMonitorMessageDetails;
  triggerTurn: boolean;
}

interface MonitorDeliveryBatcherOptions {
  schedule?: (fn: () => void) => void;
  send: (message: MonitorDeliveryMessage, triggerTurn: boolean) => void;
}

interface PendingGroup {
  rawParts: string[];
  details: PiMonitorMessageDetails;
  triggerTurn: boolean;
}

export class MonitorDeliveryBatcher {
  #pending: PendingGroup[] = [];
  #flushScheduled = false;
  #invalidated = false;
  readonly #schedule: (fn: () => void) => void;
  readonly #send: (message: MonitorDeliveryMessage, triggerTurn: boolean) => void;

  constructor(options: MonitorDeliveryBatcherOptions) {
    this.#schedule = options.schedule ?? ((fn) => { setTimeout(fn, 0); });
    this.#send = options.send;
  }

  /**
   * Mark the batcher as invalidated. After this, no more messages will be sent.
   * Call this when the extension context becomes stale (e.g., session replacement).
   * Use {@link reset} on the next session_start so deliveries work again.
   */
  invalidate(): void {
    this.#invalidated = true;
    this.#pending = [];
    this.#flushScheduled = false;
  }

  /**
   * Clear invalidation and any pending state so the batcher can deliver again
   * (e.g. after session_start following a previous session_shutdown).
   */
  reset(): void {
    this.#invalidated = false;
    this.#pending = [];
    this.#flushScheduled = false;
  }

  enqueue(batch: MonitorDeliveryBatch): void {
    if (this.#invalidated) return;
    const last = this.#pending.at(-1);
    if (last && canMerge(last, batch)) {
      last.rawParts.push(batch.raw);
      last.details = mergeDetails(last.details, batch.details);
    } else {
      this.#pending.push({
        rawParts: [batch.raw],
        details: { ...batch.details },
        triggerTurn: batch.triggerTurn,
      });
    }

    if (!this.#flushScheduled) {
      this.#flushScheduled = true;
      this.#schedule(() => this.flush());
    }
  }

  flush(): void {
    if (this.#invalidated || this.#pending.length === 0) {
      this.#flushScheduled = false;
      return;
    }

    const pending = this.#pending;
    this.#pending = [];
    this.#flushScheduled = false;

    for (const group of pending) {
      // Re-check each iteration: session_shutdown may invalidate mid-flush
      // (or a previous send may have auto-invalidated after a stale-ctx throw).
      if (this.#invalidated) return;

      const raw = group.rawParts.join('\n');
      try {
        this.#send({
          customType: 'pi-monitor',
          content: formatMonitorXml({ raw, jobID: group.details.jobID }),
          display: true,
          details: group.details,
        }, group.triggerTurn);
      } catch {
        // pi.sendMessage throws once the extension runtime is marked stale
        // (after session dispose / reload). Swallow so a deferred timer never
        // becomes an uncaughtException that kills the host process, and stop
        // delivering anything further from this batcher instance.
        this.invalidate();
        return;
      }
    }
  }
}

function canMerge(group: PendingGroup, next: MonitorDeliveryBatch): boolean {
  const current = group.details;
  const incoming = next.details;
  return group.triggerTurn === next.triggerTurn
    && current.jobID === incoming.jobID
    && current.command === incoming.command
    && current.regex === incoming.regex
    && current.label === incoming.label;
}

function mergeDetails(a: PiMonitorMessageDetails, b: PiMonitorMessageDetails): PiMonitorMessageDetails {
  return {
    ...a,
    matchCount: a.matchCount + b.matchCount,
    lineCount: a.lineCount + b.lineCount,
    truncated: a.truncated || b.truncated,
  };
}
