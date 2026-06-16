import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildCompactLine,
  buildExpandedComponent,
  CompactMonitorMessage,
  stripMonitorEnvelope,
  type PiMonitorMessageDetails,
} from '../../src/ui/compact-monitor-message.ts';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';

// ------------------------------------------------------------------
// Minimal theme that does not wrap/colour text (identity pass-through).
// This keeps width arithmetic deterministic in tests.
// ------------------------------------------------------------------
const plainTheme: Theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

function makeMessage(content: string, details: Partial<PiMonitorMessageDetails> = {}): {
  content: string;
  details: PiMonitorMessageDetails;
} {
  return {
    content,
    details: {
      jobID: details.jobID ?? 'mon_1',
      command: details.command ?? 'tail -f /var/log/app.log',
      regex: details.regex ?? 'error|warn',
      label: details.label,
      matchCount: details.matchCount ?? 1,
      lineCount: details.lineCount ?? 1,
      truncated: details.truncated ?? false,
    },
  };
}

describe('buildCompactLine', () => {
  it('includes label and first-line snippet', () => {
    const msg = makeMessage('ERROR: connection timeout', { label: 'app-logs' });
    const line = buildCompactLine(msg, plainTheme, 200);
    assert.ok(line.includes('monitor'), 'should show kind');
    assert.ok(line.includes('app-logs'), 'should show label');
    assert.ok(line.includes('ERROR: connection timeout'), 'should show snippet');
  });

  it('shows match count only when > 1', () => {
    const single = makeMessage('match', { matchCount: 1 });
    const multi = makeMessage('match', { matchCount: 3 });

    assert.ok(!buildCompactLine(single, plainTheme, 200).includes('+1 matches'));
    assert.ok(buildCompactLine(multi, plainTheme, 200).includes('+3 matches'));
  });

  it('shows truncated indicator when truncated', () => {
    const msg = makeMessage('match', { truncated: true });
    assert.ok(buildCompactLine(msg, plainTheme, 200).includes('truncated'));
  });

  it('collapses whitespace in snippet', () => {
    const msg = makeMessage('ERROR:   too   many    spaces');
    const line = buildCompactLine(msg, plainTheme, 200);
    assert.ok(line.includes('ERROR: too many spaces'));
  });

  it('truncates to the requested width', () => {
    const msg = makeMessage('this is a very long matching line that would normally overflow', { label: 'long-line-test' });
    const width = 40;
    const line = buildCompactLine(msg, plainTheme, width);
    assert.strictEqual(visibleWidth(line), width);
  });

  it('fits a long snippet by truncating rather than wrapping', () => {
    const msg = makeMessage('A'.repeat(200), { label: 'x' });
    const width = 30;
    const line = buildCompactLine(msg, plainTheme, width);
    assert.strictEqual(visibleWidth(line), width);
    assert.ok(line.includes('monitor'));
  });

  it('uses jobID as label fallback', () => {
    const msg = makeMessage('match', { label: undefined, jobID: 'mon_42' });
    const line = buildCompactLine(msg, plainTheme, 200);
    assert.ok(line.includes('mon_42'));
    assert.ok(line.includes('monitor'));
  });
});

describe('buildExpandedComponent', () => {
  it('renders header and content', () => {
    const msg = makeMessage('line one\nline two', { label: 'logs', regex: 'ERROR' });
    const component = buildExpandedComponent(msg, plainTheme);
    const lines = component.render(80);
    const joined = lines.join('\n');

    assert.ok(joined.includes('monitor'));
    assert.ok(joined.includes('logs'));
    assert.ok(joined.includes('/ERROR/'));
    assert.ok(joined.includes('line one'));
    assert.ok(joined.includes('line two'));
  });

  it('does not include regex when it matches everything', () => {
    const msg = makeMessage('match', { regex: '.*' });
    const component = buildExpandedComponent(msg, plainTheme);
    const joined = component.render(80).join('\n');
    assert.ok(!joined.includes('/.*/'));
  });
});

describe('CompactMonitorMessage', () => {
  it('returns exactly one line when collapsed', () => {
    const msg = makeMessage('match', { matchCount: 5, truncated: true });
    const component = new CompactMonitorMessage(msg, false, plainTheme);
    const lines = component.render(80);
    assert.strictEqual(lines.length, 1);
    assert.ok(visibleWidth(lines[0]!) <= 80);
  });

  it('returns multiple lines when expanded', () => {
    const msg = makeMessage('line one\nline two\nline three');
    const component = new CompactMonitorMessage(msg, true, plainTheme);
    const lines = component.render(80);
    assert.ok(lines.length > 1);
  });

  it('caches repeated renders', () => {
    const msg = makeMessage('match');
    const component = new CompactMonitorMessage(msg, false, plainTheme);
    const first = component.render(40);
    const second = component.render(40);
    assert.strictEqual(first, second);
  });

  it('invalidates cache on demand', () => {
    const msg = makeMessage('match');
    const component = new CompactMonitorMessage(msg, false, plainTheme);
    const first = component.render(40);
    component.invalidate();
    const second = component.render(40);
    assert.notStrictEqual(first, second);
    assert.deepStrictEqual(first, second);
  });
});

describe('stripMonitorEnvelope', () => {
  it('removes a wrapping <pi-monitor> envelope', () => {
    const wrapped = '<pi-monitor id="mon_1" at="2026-06-17T01:18:00Z">\nhello world\n</pi-monitor>';
    assert.strictEqual(stripMonitorEnvelope(wrapped), 'hello world');
  });

  it('returns content unchanged when no envelope is present', () => {
    const raw = 'just a line';
    assert.strictEqual(stripMonitorEnvelope(raw), raw);
  });

  it('preserves multi-line inner content', () => {
    const wrapped = '<pi-monitor id="x" at="t">\nline one\nline two\nline three\n</pi-monitor>';
    assert.strictEqual(stripMonitorEnvelope(wrapped), 'line one\nline two\nline three');
  });
});

describe('buildCompactLine with envelope content', () => {
  it('shows inner content, not the XML tag', () => {
    const msg = {
      content: '<pi-monitor id="mon_1" at="2026-06-17T01:18:00Z">\nactual matched line\n</pi-monitor>',
      details: {
        jobID: 'mon_1',
        command: 'echo hi',
        regex: '.*',
        label: 'xml-test',
        matchCount: 1,
        lineCount: 1,
        truncated: false,
      },
    };
    const line = buildCompactLine(msg, plainTheme, 200);
    assert.ok(line.includes('actual matched line'), 'should show inner content');
    assert.ok(!line.includes('<pi-monitor'), 'should not show the XML tag');
    assert.ok(!line.includes('at="'), 'should not show XML attributes');
  });
});
