import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import piMonitorExtension from '../extensions/pi-monitor.ts';

type Handler = (event?: unknown, ctx?: unknown) => unknown | Promise<unknown>;

type RegisteredTool = {
  name?: string;
  description?: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal,
    onUpdate: (update: unknown) => void,
    ctx: unknown,
  ) => Promise<unknown>;
};

interface SentMessage {
  message: unknown;
  options: unknown;
}

function makeHarness(options?: { throwOnSend?: boolean | (() => boolean) }) {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, Handler[]>();
  const sent: SentMessage[] = [];
  const statuses = new Map<string, string | undefined>();
  let throwOnSend = options?.throwOnSend ?? false;

  const pi = {
    on(eventName: string, handler: Handler) {
      const existing = handlers.get(eventName) ?? [];
      existing.push(handler);
      handlers.set(eventName, existing);
    },
    registerTool(tool: RegisteredTool & { name: string }) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    registerMessageRenderer() {},
    sendMessage(message: unknown, options?: unknown) {
      const shouldThrow = typeof throwOnSend === 'function' ? throwOnSend() : throwOnSend;
      if (shouldThrow) {
        throw new Error(
          'This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().',
        );
      }
      sent.push({ message, options });
    },
  } as unknown as ExtensionAPI;

  piMonitorExtension(pi);

  const ctx = {
    ui: {
      setStatus(key: string, text: string | undefined) {
        statuses.set(key, text);
      },
    },
  };

  async function emit(eventName: string): Promise<void> {
    for (const handler of handlers.get(eventName) ?? []) {
      await handler({}, ctx);
    }
  }

  async function start(): Promise<void> {
    await emit('session_start');
  }

  async function shutdown(): Promise<void> {
    await emit('session_shutdown');
  }

  async function runTool(name: string, params: Record<string, unknown>): Promise<unknown> {
    const tool = tools.get(name);
    assert.ok(tool, `${name} tool should be registered`);
    return tool.execute('tool_1', params, new AbortController().signal, () => {}, ctx);
  }

  async function runMonitor(params: Record<string, unknown>): Promise<unknown> {
    return runTool('Monitor', params);
  }

  async function runBackground(params: Record<string, unknown>): Promise<unknown> {
    return runTool('Background', params);
  }

  return {
    sent,
    tools,
    start,
    shutdown,
    runMonitor,
    runBackground,
    runTool,
    setThrowOnSend(value: boolean | (() => boolean)) {
      throwOnSend = value;
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.fail(`timed out waiting for ${label}`);
}

function messageContent(sent: SentMessage): string {
  const msg = sent.message as { content?: string };
  return typeof msg.content === 'string' ? msg.content : '';
}

function messageDetails(sent: SentMessage): Record<string, unknown> {
  const msg = sent.message as { details?: Record<string, unknown> };
  return msg.details ?? {};
}

// Serial: each test open/closes the shared ReDoS worker pool via session_shutdown.
describe('pi-monitor extension delivery routing', { concurrency: 1 }, () => {
  it('defaults Monitor deliveries to trigger the assistant turn', async () => {
    const h = makeHarness();
    await h.start();
    try {
      const result = await h.runMonitor({
        command: "sleep 0.05; printf 'DEFAULT_TRIGGER_TEST\\n'",
        regex: 'DEFAULT_TRIGGER_TEST',
        before: 0,
        after: 0,
        debounceSeconds: 0,
        label: 'default-trigger-test',
      }) as { details: { triggerTurn?: boolean }; isError?: boolean; content: { text: string }[] };

      assert.equal(result.isError, undefined, result.content?.[0]?.text);
      assert.equal(result.details.triggerTurn, true);
      await waitFor(() => h.sent.some((s) => {
        const d = (s.message as { details?: { event?: string } }).details;
        return d?.event !== 'exit' && s.options !== undefined;
      }), 'match delivery');
      const match = h.sent.find((s) => {
        const d = (s.message as { details?: { event?: string } }).details;
        return d?.event !== 'exit';
      });
      assert.ok(match);
      assert.deepEqual(match!.options, { deliverAs: 'steer', triggerTurn: true });
    } finally {
      await h.shutdown();
    }
  });

  it('honors explicit triggerTurn false as display-only delivery for matches', async () => {
    const h = makeHarness();
    await h.start();
    try {
      const result = await h.runMonitor({
        command: "sleep 0.05; printf 'DISPLAY_ONLY_TEST\\n'",
        regex: 'DISPLAY_ONLY_TEST',
        before: 0,
        after: 0,
        debounceSeconds: 0,
        label: 'display-only-test',
        triggerTurn: false,
      });

      assert.deepEqual((result as { details: { triggerTurn: boolean } }).details.triggerTurn, false);
      await waitFor(() => h.sent.some((s) => {
        const d = (s.message as { details?: { event?: string } }).details;
        return d?.event !== 'exit';
      }), 'display-only match');
      const match = h.sent.find((s) => {
        const d = (s.message as { details?: { event?: string } }).details;
        return d?.event !== 'exit';
      });
      assert.ok(match);
      assert.equal(match!.options, undefined);
    } finally {
      await h.shutdown();
    }
  });

  it('notifies agent on process exit with exit code, last lines, and output path', async () => {
    const h = makeHarness();
    await h.start();
    try {
      const result = await h.runMonitor({
        command: "printf 'line1\\nline2\\nline3\\n'; exit 0",
        regex: 'line',
        before: 0,
        after: 0,
        debounceSeconds: 0,
        label: 'exit-test',
      }) as { content: { text: string }[]; details: { jobID: string; outputPath: string } };

      assert.ok(result.details.jobID.startsWith('mon_'));
      assert.ok(result.details.outputPath);
      assert.ok(result.content[0]!.text.includes('Do not poll'));
      assert.ok(result.content[0]!.text.includes(result.details.outputPath));

      await waitFor(
        () => h.sent.some((s) => (s.message as { details?: { event?: string } }).details?.event === 'exit'),
        'exit notification',
      );

      const exitIdx = h.sent.findIndex(
        (s) => (s.message as { details?: { event?: string } }).details?.event === 'exit',
      );
      assert.ok(exitIdx >= 0);
      assert.deepEqual(h.sent[exitIdx]!.options, { deliverAs: 'steer', triggerTurn: true });

      const content = messageContent(h.sent[exitIdx]!);
      const details = messageDetails(h.sent[exitIdx]!);
      assert.ok(content.includes('event="exit"'));
      assert.ok(content.includes('Do not poll'));
      assert.ok(content.includes('exitCode: 0') || content.includes('exitCode="0"'));
      assert.ok(content.includes('outputPath:'));
      assert.ok(content.includes('lastLines:'));
      assert.equal(details.event, 'exit');
      assert.equal(details.exitCode, 0);
      assert.ok(typeof details.outputPath === 'string');
      assert.ok(existsSync(details.outputPath as string));
    } finally {
      await h.shutdown();
    }
  });

  it('reports non-zero exit code on exit notification', async () => {
    const h = makeHarness();
    await h.start();
    try {
      await h.runMonitor({
        command: 'exit 7',
        regex: '.*',
        before: 0,
        after: 0,
        debounceSeconds: 0,
      });

      await waitFor(
        () => h.sent.some((s) => {
          const d = (s.message as { details?: { event?: string; exitCode?: number } }).details;
          return d?.event === 'exit' && d?.exitCode === 7;
        }),
        'exit code 7',
      );
    } finally {
      await h.shutdown();
    }
  });

  it('Background delivers only exit notification (no match windows)', async () => {
    const h = makeHarness();
    await h.start();
    try {
      const result = await h.runBackground({
        command: "printf 'BG_OUTPUT_LINE\\n'; exit 0",
        label: 'bg-test',
      }) as { content: { text: string }[]; details: { jobID: string; outputPath: string } };

      assert.ok(result.details.jobID.startsWith('bg_'));
      assert.ok(result.content[0]!.text.includes('Do not poll'));
      assert.ok(result.content[0]!.text.includes(result.details.outputPath));

      await waitFor(
        () => h.sent.some((s) => (s.message as { details?: { event?: string } }).details?.event === 'exit'),
        'bg exit',
      );

      // Only exit messages — no match-style deliveries
      const nonExit = h.sent.filter(
        (s) => (s.message as { details?: { event?: string } }).details?.event !== 'exit',
      );
      assert.equal(nonExit.length, 0);

      const exitMsg = h.sent.find(
        (s) => (s.message as { details?: { event?: string } }).details?.event === 'exit',
      )!;
      const details = (exitMsg.message as { details: { jobID: string; kind: string; exitCode: number } }).details;
      assert.ok(details.jobID.startsWith('bg_'));
      assert.equal(details.kind, 'bg');
      assert.equal(details.exitCode, 0);

      const content = (exitMsg.message as { content: string }).content;
      assert.ok(content.includes('Do not poll'));
      assert.ok(existsSync(result.details.outputPath));
      const log = readFileSync(result.details.outputPath, 'utf8');
      assert.ok(log.includes('BG_OUTPUT_LINE'));
    } finally {
      await h.shutdown();
    }
  });

  it('tool descriptions mention no polling and exit notification', () => {
    const h = makeHarness();
    const monitor = h.tools.get('Monitor');
    const background = h.tools.get('Background');
    const list = h.tools.get('MonitorList');
    assert.ok(monitor?.description?.toLowerCase().includes('do not poll'));
    assert.ok(monitor?.description?.toLowerCase().includes('exit'));
    assert.ok(background?.description?.toLowerCase().includes('do not poll'));
    assert.ok(background?.description?.toLowerCase().includes('exit'));
    assert.ok(list?.description?.toLowerCase().includes('do not poll'));
  });

  it('exit always steers even when triggerTurn is false', async () => {
    const h = makeHarness();
    await h.start();
    try {
      await h.runMonitor({
        command: 'exit 0',
        regex: 'nomatch',
        triggerTurn: false,
        before: 0,
        after: 0,
        debounceSeconds: 0,
      });

      await waitFor(
        () => h.sent.some((s) => (s.message as { details?: { event?: string } }).details?.event === 'exit'),
        'exit with triggerTurn false',
      );

      const exitMsg = h.sent.find(
        (s) => (s.message as { details?: { event?: string } }).details?.event === 'exit',
      )!;
      assert.deepEqual(exitMsg.options, { deliverAs: 'steer', triggerTurn: true });
    } finally {
      await h.shutdown();
    }
  });

  it('batcher delivers matches after session_start following session_shutdown', async () => {
    const h = makeHarness();
    await h.start();
    await h.shutdown();
    // Simulate session replacement: batcher was invalidated on shutdown; reset on start.
    await h.start();
    try {
      await h.runMonitor({
        command: "sleep 0.05; printf 'AFTER_RESTART_MATCH\\n'",
        regex: 'AFTER_RESTART_MATCH',
        before: 0,
        after: 0,
        debounceSeconds: 0,
        label: 'post-restart',
      });

      await waitFor(
        () => h.sent.some((s) => {
          const d = (s.message as { details?: { event?: string } }).details;
          return d?.event !== 'exit' && messageContent(s).includes('AFTER_RESTART_MATCH');
        }),
        'match after session restart',
      );
    } finally {
      await h.shutdown();
    }
  });

  it('does not deliver exit steers from a prior session into the next session', async () => {
    const h = makeHarness();
    await h.start();
    // Ignore SIGTERM so dispose on shutdown does not end the job before the next session.
    // Process exits on its own after ~0.5s, past session_start (suppress cleared).
    await h.runMonitor({
      command: "trap '' TERM; sleep 0.5; exit 0",
      regex: 'nomatch',
      before: 0,
      after: 0,
      debounceSeconds: 0,
      label: 'ghost-exit',
    });
    await h.shutdown();
    h.sent.length = 0;
    await h.start();

    // Wait for the prior-session process to exit and its IIFE to run.
    await new Promise((r) => setTimeout(r, 900));

    const exits = h.sent.filter(
      (s) => (s.message as { details?: { event?: string } }).details?.event === 'exit',
    );
    assert.equal(exits.length, 0, 'prior-session exit must not steer into the new session');
    await h.shutdown();
  });

  it('matches stdout only; stderr is logged but not delivered as matches', async () => {
    const h = makeHarness();
    await h.start();
    try {
      const result = await h.runMonitor({
        command: "printf 'err-only\\n' >&2; printf 'out-match\\n'; exit 0",
        regex: 'err-only|out-match',
        before: 0,
        after: 0,
        debounceSeconds: 0,
        label: 'stdout-only',
      }) as { details: { outputPath: string } };

      await waitFor(
        () => h.sent.some((s) => (s.message as { details?: { event?: string } }).details?.event === 'exit'),
        'exit after stdout-only test',
      );

      const matches = h.sent.filter((s) => {
        const d = (s.message as { details?: { event?: string } }).details;
        return d?.event !== 'exit';
      });
      assert.ok(matches.length >= 1, 'stdout match should be delivered');
      for (const m of matches) {
        const content = messageContent(m);
        assert.ok(content.includes('out-match'), `expected stdout match in: ${content}`);
        assert.ok(!content.includes('err-only'), `stderr must not match: ${content}`);
      }

      // Full log still tees both streams.
      const log = readFileSync(result.details.outputPath, 'utf8');
      assert.ok(log.includes('[stderr] err-only') || log.includes('err-only'));
      assert.ok(log.includes('[stdout] out-match') || log.includes('out-match'));
    } finally {
      await h.shutdown();
    }
  });

  it('rejects starting jobs when MAX_ACTIVE_JOBS is reached', async () => {
    const h = makeHarness();
    await h.start();
    try {
      const { MAX_ACTIVE_JOBS } = await import('../src/limits.ts');
      // Fill the registry with long-running background jobs.
      for (let i = 0; i < MAX_ACTIVE_JOBS; i++) {
        const result = await h.runBackground({
          command: 'sleep 30',
          label: `fill-${i}`,
        }) as { isError?: boolean; content: { text: string }[] };
        assert.equal(result.isError, undefined, result.content?.[0]?.text);
      }

      const over = await h.runBackground({
        command: 'sleep 1',
        label: 'over-limit',
      }) as { isError?: boolean; content: { text: string }[] };

      assert.equal(over.isError, true);
      assert.match(over.content[0]!.text, /maximum of \d+ active jobs/i);

      const overMon = await h.runMonitor({
        command: 'sleep 1',
        regex: 'x',
        before: 0,
        after: 0,
        debounceSeconds: 0,
      }) as { isError?: boolean; content: { text: string }[] };
      assert.equal(overMon.isError, true);
      assert.match(overMon.content[0]!.text, /maximum of \d+ active jobs/i);
    } finally {
      await h.shutdown();
    }
  });

  it('does not throw uncaught when match flush hits stale sendMessage after session dispose', async () => {
    // Reproduces: Timer flush -> pi.sendMessage -> assertActive throws after
    // session replacement. Must be swallowed so pi does not exit via uncaughtException.
    const h = makeHarness();
    await h.start();
    try {
      // Fast, continuous matches so a flush is almost certain after we arm throw.
      await h.runMonitor({
        command: "for i in 1 2 3 4 5; do printf 'STALE_CTX_MATCH %s\\n' \"$i\"; sleep 0.02; done",
        regex: 'STALE_CTX_MATCH',
        before: 0,
        after: 0,
        debounceSeconds: 0,
        label: 'stale-flush',
      });

      // Let at least one successful delivery prove the path works, then arm stale.
      await waitFor(() => h.sent.length > 0, 'initial match before arming stale', 2_000);
      const beforeStale = h.sent.length;
      h.setThrowOnSend(true);

      // Enough time for later flushes / exit path to hit send and throw.
      await new Promise((r) => setTimeout(r, 400));

      // Surviving means throws were contained. No further successful sends after arming.
      assert.equal(h.sent.length, beforeStale);
    } finally {
      h.setThrowOnSend(false);
      await h.shutdown();
    }
  });

  it('does not throw uncaught when exit notification hits stale sendMessage', async () => {
    const h = makeHarness();
    await h.start();
    try {
      // Arm throw immediately so exit cannot deliver.
      h.setThrowOnSend(true);
      await h.runBackground({
        command: 'printf done; exit 0',
        label: 'stale-exit',
      });

      // Wait until the job would have exited and attempted notify.
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(h.sent.length, 0, 'stale exit must not record a successful send');
    } finally {
      h.setThrowOnSend(false);
      await h.shutdown();
    }
  });
});
