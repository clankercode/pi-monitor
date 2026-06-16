import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCancel,
  formatDelivery,
  formatJobs,
  formatMonitorXml,
  generateNonce,
  redactSecrets,
  sanitize,
} from '../src/delivery-format.ts';
import type { JobStatus } from '../src/delivery-format.ts';

describe('generateNonce', () => {
  it('returns a 32-char hex string', () => {
    assert.match(generateNonce(), /^[0-9a-f]{32}$/);
  });

  it('produces unique nonces', () => {
    const a = generateNonce();
    const b = generateNonce();
    assert.notEqual(a, b);
  });
});

describe('sanitize', () => {
  it('strips CSI escape sequences', () => {
    assert.equal(sanitize('\x1b[31mred\x1b[0m'), 'red');
  });

  it('strips OSC sequences', () => {
    assert.equal(sanitize('\x1b]0;title\x07text'), 'text');
  });

  it('preserves newlines and tabs', () => {
    const input = 'line1\n\tindented\tand more\t\r';
    assert.equal(sanitize(input), 'line1\n\tindented\tand more\t');
  });

  it('removes stray control chars', () => {
    assert.equal(sanitize('a\x00b\x07c'), 'abc');
  });

  it('handles plain text unchanged', () => {
    assert.equal(sanitize('no escapes here'), 'no escapes here');
  });
});

describe('redactSecrets', () => {
  it('redacts TOKEN value with = separator', () => {
    assert.equal(redactSecrets('TOKEN=eyJabc123'), 'TOKEN=****');
  });

  it('redacts TOKEN value with : separator', () => {
    assert.equal(redactSecrets('TOKEN: my-secret-val'), 'TOKEN: ****');
  });

  it('preserves original separator style', () => {
    assert.equal(redactSecrets('API_KEY=abcde12345'), 'API_KEY=****');
    assert.equal(redactSecrets('API_KEY: my-secure-key'), 'API_KEY: ****');
  });

  it('redacts ACCESS_TOKEN value', () => {
    assert.equal(redactSecrets('ACCESS_TOKEN=secret-value'), 'ACCESS_TOKEN=****');
  });

  it('redacts BEARER_TOKEN value', () => {
    assert.equal(redactSecrets('BEARER_TOKEN=xyz'), 'BEARER_TOKEN=****');
  });

  it('redacts PRIVATE_KEY value', () => {
    assert.equal(redactSecrets('PRIVATE_KEY=key123'), 'PRIVATE_KEY=****');
  });

  it('redacts API_KEY value', () => {
    assert.equal(redactSecrets('API_KEY=abcdef'), 'API_KEY=****');
  });

  it('redacts Authorization Bearer header', () => {
    assert.equal(redactSecrets('Authorization Bearer token123abc'), 'Authorization Bearer ****');
  });

  it('redacts dotted Authorization Bearer values such as JWTs', () => {
    assert.equal(
      redactSecrets('Authorization Bearer header.payload.signature'),
      'Authorization Bearer ****'
    );
  });

  it('redacts URL userinfo', () => {
    assert.equal(redactSecrets('http://user:pass@host/path'), 'http://****@host/path');
  });

  it('is case insensitive for secret keys', () => {
    assert.equal(redactSecrets('api_key=key123'), 'api_key=****');
  });

  it('redacts double-quoted key/value pairs', () => {
    assert.equal(redactSecrets('"TOKEN"="secretVal"'), '"TOKEN"="****"');
  });

  it('redacts single-quoted key/value pairs', () => {
    assert.equal(redactSecrets("'SECRET'='topsecret'"), "'SECRET'='****'");
  });

  it('leaves unknown text unchanged', () => {
    assert.equal(redactSecrets('hello world'), 'hello world');
  });
});

describe('formatDelivery', () => {
  it('wraps content with nonce fences', () => {
    const result = formatDelivery('hello\nworld');
    const lines = result.text.split('\n');
    assert.ok(lines.length >= 4);
    assert.match(lines[0], /^[0-9a-f]{32}$/);
    assert.match(lines[lines.length - 1], /^[0-9a-f]{32}$/);
    assert.equal(lines[1], 'monitor triggered.');
  });

  it('sanitizes raw input', () => {
    const result = formatDelivery('\x1b[31mred\x1b[0m');
    assert.ok(!result.text.includes('\x1b'));
  });

  it('redacts secrets in output', () => {
    const result = formatDelivery('TOKEN=secret123');
    assert.ok(result.text.includes('****'));
    assert.ok(!result.text.includes('secret123'));
  });

  it('allows an injectable nonce', () => {
    const result = formatDelivery('test', { nonce: 'abcdef0123456789abcdef0123456789' });
    assert.match(result.text, /^abcdef0123456789abcdef0123456789$/m);
  });

  it('produces commandPreview and promptPreview', () => {
    const long = 'a'.repeat(300);
    const result = formatDelivery(long);
    assert.ok(result.commandPreview!.length <= 200);
    assert.ok(result.promptPreview!.length <= 200);
  });

  it('truncates previews at maxPreviewLen', () => {
    const long = 'x'.repeat(500);
    const result = formatDelivery(long, { maxPreviewLen: 50 });
    assert.ok(result.commandPreview!.length <= 51);
  });

  it('avoids nested fences when input is already nonce-fenced', () => {
    const nonce = 'a'.repeat(32);
    const fenced = [nonce, 'monitor triggered.', 'inner content', nonce].join('\n');
    const result = formatDelivery(fenced, { nonce: 'b'.repeat(32) });
    const lines = result.text.split('\n');

    assert.equal(lines[0], 'b'.repeat(32));
    assert.equal(lines[lines.length - 1], 'b'.repeat(32));
    assert.ok(result.text.includes('inner content'));

    const oldNonceCount = lines.filter((l) => l === nonce).length;
    assert.equal(oldNonceCount, 0);
  });
});

describe('formatJobs', () => {
  it('lists all jobs with kind and status', () => {
    const jobs: JobStatus[] = [
      { jobID: 'j1', kind: 'bg', status: 'active' },
      { jobID: 'j2', kind: 'mon', status: 'failed' },
    ];
    const result = formatJobs(jobs);
    assert.ok(result.text.includes('j1 (background)'));
    assert.ok(result.text.includes('active'));
    assert.ok(result.text.includes('j2 (monitor)'));
    assert.ok(result.text.includes('failed'));
  });

  it('includes directive and nonce fences', () => {
    const jobs: JobStatus[] = [{ jobID: 'x', kind: 'loop', status: 'completed' }];
    const result = formatJobs(jobs);
    const lines = result.text.split('\n');
    assert.match(lines[0], /^[0-9a-f]{32}$/);
    assert.equal(lines[1], 'monitor triggered.');
  });
});

describe('formatCancel', () => {
  it('emits a cancelled message', () => {
    const result = formatCancel('job-42', 'mon');
    assert.ok(result.text.includes('job-42 (monitor)'));
    assert.ok(result.text.includes('cancelled'));
  });

  it('wraps with nonce fences', () => {
    const result = formatCancel('j1', 'bg');
    const lines = result.text.split('\n');
    assert.match(lines[0], /^[0-9a-f]{32}$/);
    assert.match(lines[lines.length - 1], /^[0-9a-f]{32}$/);
  });

  it('includes directive', () => {
    const result = formatCancel('j', 'sched');
    assert.ok(result.text.includes('monitor triggered.'));
  });
});

describe('formatMonitorXml', () => {
  const baseInput = {
    raw: 'matched line',
    jobID: 'mon_1',
    command: 'heartbeat 4.5m',
    regex: '.*',
    matchCount: 1,
    lineCount: 1,
    truncated: false,
    at: Date.parse('2026-06-17T01:18:00Z'),
  };

  it('wraps content in a pi-monitor envelope', () => {
    const xml = formatMonitorXml(baseInput);
    assert.ok(xml.startsWith('<pi-monitor '));
    assert.ok(xml.endsWith('</pi-monitor>'));
    assert.ok(xml.includes('matched line'));
  });

  it('includes id, command, regex, match_count, line_count, truncated, at attributes', () => {
    const xml = formatMonitorXml(baseInput);
    assert.ok(xml.includes('id="mon_1"'));
    assert.ok(xml.includes('command="heartbeat 4.5m"'));
    assert.ok(xml.includes('regex=".*"'));
    assert.ok(xml.includes('match_count="1"'));
    assert.ok(xml.includes('line_count="1"'));
    assert.ok(xml.includes('truncated="false"'));
    assert.ok(xml.includes('at="2026-06-17T01:18:00Z"'));
  });

  it('includes label only when set', () => {
    const without = formatMonitorXml(baseInput);
    assert.ok(!without.includes('label='));
    const withLabel = formatMonitorXml({ ...baseInput, label: 'heartbeat' });
    assert.ok(withLabel.includes('label="heartbeat"'));
  });

  it('escapes special characters in attribute values', () => {
    const xml = formatMonitorXml({
      ...baseInput,
      command: 'echo "hi" & <world>',
      label: 'a"b',
    });
    assert.ok(xml.includes('&amp;'));
    assert.ok(xml.includes('&lt;world&gt;'));
    assert.ok(xml.includes('&quot;'));
  });

  it('escapes special characters in content text', () => {
    const xml = formatMonitorXml({ ...baseInput, raw: '<danger> & "quoted"' });
    assert.ok(xml.includes('&lt;danger&gt;'));
    assert.ok(xml.includes('&amp;'));
    // " in text content is NOT escaped (only < and & need to be).
    assert.ok(xml.includes('"quoted"'));
  });

  it('redacts secrets in content', () => {
    const xml = formatMonitorXml({ ...baseInput, raw: 'TOKEN=abc123' });
    assert.ok(!xml.includes('abc123'));
    assert.ok(xml.includes('****'));
  });

  it('strips ANSI escape sequences from content', () => {
    const xml = formatMonitorXml({ ...baseInput, raw: '\x1b[31mERROR\x1b[0m connection refused' });
    assert.ok(!xml.includes('\x1b['));
    assert.ok(xml.includes('ERROR connection refused'));
  });

  it('formats the at timestamp as ISO 8601 UTC with second precision', () => {
    const xml = formatMonitorXml({ ...baseInput, at: Date.parse('2024-04-21T12:00:00.123Z') });
    assert.ok(xml.includes('at="2024-04-21T12:00:00Z"'));
  });
});
