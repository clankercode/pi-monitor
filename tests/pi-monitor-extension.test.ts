import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import piMonitorExtension from '../extensions/pi-monitor.ts';

type Handler = (event?: unknown, ctx?: unknown) => unknown | Promise<unknown>;

type RegisteredTool = {
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

function makeHarness() {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, Handler[]>();
  const sent: SentMessage[] = [];
  const statuses = new Map<string, string | undefined>();

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

  async function runMonitor(params: Record<string, unknown>): Promise<unknown> {
    const monitor = tools.get('Monitor');
    assert.ok(monitor, 'Monitor tool should be registered');
    return monitor.execute('tool_1', params, new AbortController().signal, () => {}, ctx);
  }

  return { sent, start, shutdown, runMonitor };
}

async function waitForMessage(sent: SentMessage[], count = 1): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (sent.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${count} sent monitor message(s); saw ${sent.length}`);
}

describe('pi-monitor extension delivery routing', () => {
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
      });

      assert.deepEqual((result as { details: { triggerTurn: boolean } }).details.triggerTurn, true);
      await waitForMessage(h.sent);
      assert.deepEqual(h.sent[0]!.options, { deliverAs: 'steer', triggerTurn: true });
    } finally {
      await h.shutdown();
    }
  });

  it('honors explicit triggerTurn false as display-only delivery', async () => {
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
      await waitForMessage(h.sent);
      assert.equal(h.sent[0]!.options, undefined);
    } finally {
      await h.shutdown();
    }
  });
});
