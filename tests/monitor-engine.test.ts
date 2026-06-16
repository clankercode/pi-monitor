import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OutputEvent } from '../src/types.ts';
import { MonitorEngine } from '../src/runner/monitor-engine.ts';
import type { MonitorWindow, MonitorEngineOptions } from '../src/runner/monitor-engine.ts';

function makeEvent(seq: number, line: string, stream: 'stdout' | 'stderr' = 'stdout'): OutputEvent {
  return { jobID: 'job-a', seq, stream, line, timestamp: 1_000 + seq * 10 };
}

function makeEventForJob(jobID: string, seq: number, line: string): OutputEvent {
  return { jobID, seq, stream: 'stdout', line, timestamp: 1_000 + seq * 10 };
}

describe('MonitorEngine', () => {
  it('should mark truncated when ring buffer drops before-lines', () => {
    const ringSize = 3;
    const before = 10;
    const calls: MonitorWindow[] = [];
    const engine = new MonitorEngine({
      jobID: 'job-a', regex: /ERR/, before, after: 0, debounceMs: 0, ringSize,
      onWindow: (w) => calls.push(w),
    });

    engine.ingest(makeEvent(1, 'ok1'));
    engine.ingest(makeEvent(2, 'ok2'));
    engine.ingest(makeEvent(3, 'ok3'));
    engine.ingest(makeEvent(4, 'ERR'));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].truncated, true);
  });

  it('should NOT mark truncated when enough before-lines are available', () => {
    const calls: MonitorWindow[] = [];
    const engine = new MonitorEngine({
      jobID: 'job-a', regex: /ERR/, before: 2, after: 0, debounceMs: 0, ringSize: 50,
      onWindow: (w) => calls.push(w),
    });

    engine.ingest(makeEvent(1, 'ok1'));
    engine.ingest(makeEvent(2, 'ok2'));
    engine.ingest(makeEvent(3, 'ERR'));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].truncated, false);
  });

  it('should collect before-lines up to the requested count', () => {
    const calls: MonitorWindow[] = [];
    const engine = new MonitorEngine({
      jobID: 'job-a', regex: /ERR/, before: 2, after: 0, debounceMs: 0, ringSize: 50,
      onWindow: (w) => calls.push(w),
    });

    engine.ingest(makeEvent(1, 'line1'));
    engine.ingest(makeEvent(2, 'line2'));
    engine.ingest(makeEvent(3, 'ERR'));

    assert.equal(calls.length, 1);
    const events = calls[0].events;
    assert.equal(events.length, 3);
    assert.equal(events[0].seq, 1);
    assert.equal(events[1].seq, 2);
    assert.equal(events[2].seq, 3);
  });

  it('should include only the matching line when before=0 and after=0', () => {
    const calls: MonitorWindow[] = [];
    const engine = new MonitorEngine({
      jobID: 'job-a', regex: /ERR/, before: 0, after: 0, debounceMs: 0, ringSize: 50,
      onWindow: (w) => calls.push(w),
    });

    engine.ingest(makeEvent(1, 'line1'));
    engine.ingest(makeEvent(2, 'line2'));
    engine.ingest(makeEvent(3, 'ERR'));

    assert.equal(calls.length, 1);
    assert.deepStrictEqual(calls[0].events.map((e) => e.seq), [3]);
  });

  it('should include after-lines after match', () => {
    const calls: MonitorWindow[] = [];
    const engine = new MonitorEngine({
      jobID: 'job-a', regex: /ERR/, before: 0, after: 2, debounceMs: 0, ringSize: 50,
      onWindow: (w) => calls.push(w),
    });

    engine.ingest(makeEvent(1, 'ERR'));
    engine.ingest(makeEvent(2, 'after1'));
    engine.ingest(makeEvent(3, 'after2'));

    assert.equal(calls.length, 1);
    const events = calls[0].events;
    assert.equal(events.length, 3);
    assert.equal(events[0].seq, 1);
    assert.equal(events[2].seq, 3);
  });

  it('should include match line in matchSeqs', () => {
    const calls: MonitorWindow[] = [];
    const engine = new MonitorEngine({
      jobID: 'job-a', regex: /ERR/, before: 0, after: 0, debounceMs: 0, ringSize: 50,
      onWindow: (w) => calls.push(w),
    });

    engine.ingest(makeEvent(1, 'ERR'));
    assert.deepStrictEqual(calls[0].matchSeqs, [1]);
  });

  it('should ignore duplicate input seqs', () => {
    const calls: MonitorWindow[] = [];
    const engine = new MonitorEngine({
      jobID: 'job-a', regex: /ERR/, before: 0, after: 0, debounceMs: 0, ringSize: 50,
      onWindow: (w) => calls.push(w),
    });

    engine.ingest(makeEvent(1, 'ERR'));
    engine.ingest(makeEvent(1, 'ERR-dup'));

    assert.equal(calls.length, 1);
    engine.ingest(makeEvent(2, 'ok'));
    assert.equal(calls.length, 1);
  });

  it('should ignore lower out-of-order seqs after a higher seq is seen', () => {
    const calls: MonitorWindow[] = [];
    const engine = new MonitorEngine({
      jobID: 'job-a', regex: /ERR/, before: 0, after: 0, debounceMs: 0, ringSize: 50,
      onWindow: (w) => calls.push(w),
    });

    engine.ingest(makeEvent(3, 'ERR-new'));
    engine.ingest(makeEvent(2, 'ERR-old'));

    assert.equal(calls.length, 1);
    assert.deepStrictEqual(calls[0].events.map((e) => e.seq), [3]);
  });

  it('flush() should immediately emit pending windows', () => {
    const calls: MonitorWindow[] = [];
    const engine = new MonitorEngine({
      jobID: 'job-b', regex: /WARN/, before: 0, after: 3, debounceMs: 0, ringSize: 50,
      onWindow: (w) => calls.push(w),
    });

    engine.ingest(makeEventForJob('job-b', 1, 'WARN'));
    engine.ingest(makeEventForJob('job-b', 2, 'after1'));

    engine.flush();
    assert.equal(calls.length, 1);
  });

  it('should reject invalid constructor options', () => {
    const base: MonitorEngineOptions = {
      jobID: 'job-a', regex: /ERR/, before: 0, after: 0, debounceMs: 0,
      onWindow: () => {},
    };

    assert.throws(() => new MonitorEngine({ ...base, before: -1 }), { message: /before/ });
    assert.throws(() => new MonitorEngine({ ...base, after: -1 }), { message: /after/ });
    assert.throws(() => new MonitorEngine({ ...base, debounceMs: -1 }), { message: /debounceMs/ });
    assert.throws(() => new MonitorEngine({ ...base, afterWaitMs: -1 }), { message: /afterWaitMs/ });
    assert.throws(() => new MonitorEngine({ ...base, ringSize: 0 }), { message: /ringSize/ });
  });

  it('should ignore events from other jobIDs', () => {
    const calls: MonitorWindow[] = [];
    const engine = new MonitorEngine({
      jobID: 'job-a', regex: /ERR/, before: 0, after: 0, debounceMs: 0, ringSize: 50,
      onWindow: (w) => calls.push(w),
    });

    engine.ingest(makeEventForJob('job-other', 1, 'ERR'));
    assert.equal(calls.length, 0);
  });

  it('destroy() should cancel timers so no pending delivery occurs', () => {
    const calls: MonitorWindow[] = [];
    const engine = new MonitorEngine({
      jobID: 'job-a', regex: /ERR/, before: 0, after: 5, debounceMs: 0, ringSize: 50,
      onWindow: (w) => calls.push(w),
    });

    engine.ingest(makeEvent(1, 'ERR'));
    engine.destroy();

    assert.equal(calls.length, 0);
  });

  it('should reset lastIndex before each regex test', () => {
    const regex = /ERR/;
    regex.lastIndex = 100;
    const calls: MonitorWindow[] = [];
    const engine = new MonitorEngine({
      jobID: 'job-a', regex, before: 0, after: 0, debounceMs: 0, ringSize: 50,
      onWindow: (w) => calls.push(w),
    });

    engine.ingest(makeEvent(1, 'ERR'));
    assert.equal(calls.length, 1);
  });

  it('should merge overlapping windows without redelivering shared seqs', () => {
    const calls: MonitorWindow[] = [];
    const engine = new MonitorEngine({
      jobID: 'job-a', regex: /ERR/, before: 1, after: 1, debounceMs: 0, ringSize: 50,
      onWindow: (w) => calls.push(w),
    });

    engine.ingest(makeEvent(1, 'before'));
    engine.ingest(makeEvent(2, 'ERR-one'));
    engine.ingest(makeEvent(3, 'ERR-two'));
    engine.ingest(makeEvent(4, 'after'));

    assert.equal(calls.length, 2);
    assert.deepStrictEqual(calls[0].events.map((e) => e.seq), [1, 2, 3]);
    assert.deepStrictEqual(calls[0].matchSeqs, [2]);
    assert.deepStrictEqual(calls[1].events.map((e) => e.seq), [4]);
    assert.deepStrictEqual(calls[1].matchSeqs, []);
  });

  it('should ring-buffer both stdout and stderr combined', () => {
    const ringSize = 3;
    const calls: MonitorWindow[] = [];
    const engine = new MonitorEngine({
      jobID: 'job-a', regex: /ERR/, before: 5, after: 0,
      debounceMs: 0, ringSize,
      onWindow: (w) => calls.push(w),
    });

    engine.ingest({ ...makeEvent(1, 'out1'), stream: 'stdout' });
    engine.ingest({ ...makeEvent(2, 'err1'), stream: 'stderr' });
    engine.ingest({ ...makeEvent(3, 'out2'), stream: 'stdout' });
    engine.ingest({ ...makeEvent(4, 'ERR'), stream: 'stdout' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].truncated, true);
  });
});
