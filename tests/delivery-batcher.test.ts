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
});
