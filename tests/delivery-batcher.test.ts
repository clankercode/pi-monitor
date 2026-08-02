import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MonitorDeliveryBatcher } from '../src/delivery-batcher.ts';
import type { PiMonitorMessageDetails } from '../src/ui/compact-monitor-message.ts';

function makeDetails(partial: Partial<PiMonitorMessageDetails> = {}): PiMonitorMessageDetails {
  return {
    jobID: partial.jobID ?? 'mon_1',
    command: partial.command ?? 'printf logs',
    regex: partial.regex ?? '.*',
    label: partial.label ?? 'room monitor',
    matchCount: partial.matchCount ?? 1,
    lineCount: partial.lineCount ?? 1,
    truncated: partial.truncated ?? false,
  };
}

describe('MonitorDeliveryBatcher', () => {
  it('groups same-turn windows for one monitor into one delivered message', () => {
    const sent: Array<{ content: string; details: PiMonitorMessageDetails; triggerTurn: boolean }> = [];
    const scheduled: Array<() => void> = [];
    const batcher = new MonitorDeliveryBatcher({
      schedule: (fn) => { scheduled.push(fn); },
      send: (message, triggerTurn) => {
        sent.push({
          content: message.content,
          details: message.details,
          triggerTurn,
        });
      },
    });

    batcher.enqueue({ raw: 'line one', details: makeDetails({ matchCount: 1, lineCount: 1 }), triggerTurn: true });
    batcher.enqueue({ raw: 'line two', details: makeDetails({ matchCount: 1, lineCount: 1 }), triggerTurn: true });

    assert.strictEqual(sent.length, 0, 'delivery is deferred until the turn flushes');
    assert.strictEqual(scheduled.length, 1, 'one flush scheduled for the turn');

    scheduled[0]!();

    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0]!.triggerTurn, true);
    assert.match(sent[0]!.content, /line one\nline two/);
    assert.strictEqual(sent[0]!.details.matchCount, 2);
    assert.strictEqual(sent[0]!.details.lineCount, 2);
  });

  it('preserves blank lines inside a grouped delivery', () => {
    const sent: Array<{ content: string }> = [];
    const scheduled: Array<() => void> = [];
    const batcher = new MonitorDeliveryBatcher({
      schedule: (fn) => { scheduled.push(fn); },
      send: (message) => { sent.push({ content: message.content }); },
    });

    batcher.enqueue({ raw: 'line one', details: makeDetails(), triggerTurn: false });
    batcher.enqueue({ raw: '', details: makeDetails(), triggerTurn: false });
    batcher.enqueue({ raw: 'line three', details: makeDetails(), triggerTurn: false });
    scheduled[0]!();

    assert.match(sent[0]!.content, /line one\n\nline three/);
  });

  it('does not group different monitors into one message', () => {
    const sent: Array<{ details: PiMonitorMessageDetails }> = [];
    const scheduled: Array<() => void> = [];
    const batcher = new MonitorDeliveryBatcher({
      schedule: (fn) => { scheduled.push(fn); },
      send: (message) => { sent.push({ details: message.details }); },
    });

    batcher.enqueue({ raw: 'one', details: makeDetails({ jobID: 'mon_1' }), triggerTurn: false });
    batcher.enqueue({ raw: 'two', details: makeDetails({ jobID: 'mon_2' }), triggerTurn: false });
    scheduled[0]!();

    assert.deepStrictEqual(sent.map((m) => m.details.jobID), ['mon_1', 'mon_2']);
  });

  it('drops queued deliveries after invalidation before scheduled flush', () => {
    const sent: Array<{ content: string }> = [];
    const scheduled: Array<() => void> = [];
    const batcher = new MonitorDeliveryBatcher({
      schedule: (fn) => { scheduled.push(fn); },
      send: (message) => { sent.push({ content: message.content }); },
    });

    batcher.enqueue({ raw: 'late line', details: makeDetails(), triggerTurn: false });
    assert.strictEqual(scheduled.length, 1, 'initial delivery schedules a flush');

    batcher.invalidate();
    scheduled[0]!();

    assert.strictEqual(sent.length, 0, 'invalidated batcher must not send through stale ctx');
  });

  it('ignores new deliveries after invalidation', () => {
    const sent: Array<{ content: string }> = [];
    const scheduled: Array<() => void> = [];
    const batcher = new MonitorDeliveryBatcher({
      schedule: (fn) => { scheduled.push(fn); },
      send: (message) => { sent.push({ content: message.content }); },
    });

    batcher.invalidate();
    batcher.enqueue({ raw: 'late line', details: makeDetails(), triggerTurn: false });
    batcher.flush();

    assert.strictEqual(scheduled.length, 0, 'invalidated batcher must not schedule stale ctx work');
    assert.strictEqual(sent.length, 0, 'invalidated batcher must drop stale ctx work');
  });

  it('reset clears invalidation so later sessions can deliver again', () => {
    const sent: Array<{ content: string }> = [];
    const scheduled: Array<() => void> = [];
    const batcher = new MonitorDeliveryBatcher({
      schedule: (fn) => { scheduled.push(fn); },
      send: (message) => { sent.push({ content: message.content }); },
    });

    batcher.enqueue({ raw: 'stale', details: makeDetails(), triggerTurn: false });
    batcher.invalidate();
    scheduled[0]!();
    assert.strictEqual(sent.length, 0);

    batcher.reset();
    batcher.enqueue({ raw: 'fresh session line', details: makeDetails(), triggerTurn: false });
    assert.strictEqual(scheduled.length, 2, 'reset batcher schedules new flushes');
    scheduled[1]!();

    assert.strictEqual(sent.length, 1);
    assert.match(sent[0]!.content, /fresh session line/);
  });

  it('does not throw when send fails mid-flush (stale ctx after session replacement)', () => {
    const sent: string[] = [];
    const scheduled: Array<() => void> = [];
    let calls = 0;
    const batcher = new MonitorDeliveryBatcher({
      schedule: (fn) => { scheduled.push(fn); },
      send: (message) => {
        calls += 1;
        if (calls === 1) {
          throw new Error(
            'This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().',
          );
        }
        sent.push(message.content);
      },
    });

    // Two groups so a naive loop would attempt a second send after the first throws.
    batcher.enqueue({ raw: 'first', details: makeDetails({ jobID: 'mon_1' }), triggerTurn: false });
    batcher.enqueue({ raw: 'second', details: makeDetails({ jobID: 'mon_2' }), triggerTurn: false });
    assert.strictEqual(scheduled.length, 1);

    assert.doesNotThrow(() => scheduled[0]!());
    assert.strictEqual(calls, 1, 'stops after the first send failure');
    assert.strictEqual(sent.length, 0);

    // Auto-invalidated: further enqueues must not schedule or send.
    batcher.enqueue({ raw: 'after-throw', details: makeDetails({ jobID: 'mon_3' }), triggerTurn: false });
    assert.strictEqual(scheduled.length, 1);
    batcher.flush();
    assert.strictEqual(sent.length, 0);
  });

  it('drops remaining groups if invalidated after flush has already snapshot pending', () => {
    const sent: string[] = [];
    const scheduled: Array<() => void> = [];
    let batcher!: MonitorDeliveryBatcher;
    batcher = new MonitorDeliveryBatcher({
      schedule: (fn) => { scheduled.push(fn); },
      send: (message) => {
        // Simulate session_shutdown invalidating mid-flush (after the first send).
        batcher.invalidate();
        sent.push(message.content);
      },
    });

    batcher.enqueue({ raw: 'one', details: makeDetails({ jobID: 'mon_1' }), triggerTurn: false });
    batcher.enqueue({ raw: 'two', details: makeDetails({ jobID: 'mon_2' }), triggerTurn: false });
    scheduled[0]!();

    // First send runs, then invalidate; second group must not send.
    assert.strictEqual(sent.length, 1, 'only the in-flight first group may send');
    assert.match(sent[0]!, /one/);
  });
});
