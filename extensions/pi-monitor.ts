/**
 * pi-monitor — background process monitoring with regex matching.
 *
 * Single tool: monitor. Runs a shell command in the background, watches
 * stdout for regex matches, and delivers matching windows (with before/after
 * context) to the agent session.
 */
import { Type, type Static } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ProcessRunner } from "../src/runner/process-runner.ts";
import { MonitorEngine, type MonitorWindow } from "../src/runner/monitor-engine.ts";
import { vetRegexPattern, close as closeRedos } from "../src/runner/redos.ts";
import { formatDelivery } from "../src/delivery-format.ts";
import type { OutputEvent } from "../src/types.ts";
import {
  MIN_MONITOR_DEBOUNCE_S,
  MAX_MONITOR_DEBOUNCE_S,
  MAX_REGEX_PATTERN_LENGTH,
} from "../src/limits.ts";
import {
  registerCompactMonitorRenderer,
  type PiMonitorMessageDetails,
} from "../src/ui/compact-monitor-message.ts";

const MAX_CONTEXT_LINES = 200;
const STATUSLINE_KEY = "/m";

/* ------------------------------------------------------------------ */
  /* ------------------------------------------------------------------ */
  /* Tool schemas                                                       */
  /* ------------------------------------------------------------------ */

  const MonitorToolSchema = Type.Object({
    command: Type.String({ description: "Shell command to run in the background" }),
    regex: Type.Optional(Type.String({ description: "Regex pattern to match against each stdout line (default: match everything)" })),
    regexFlags: Type.Optional(Type.String({ description: "RegExp flags (default: '')" })),
    before: Type.Optional(Type.Number({ description: "Lines of context before match (default: 10)" })),
    after: Type.Optional(Type.Number({ description: "Lines of context after match (default: 10)" })),
    debounceSeconds: Type.Optional(Type.Number({ description: "Debounce window in seconds (1-60, default: 5)" })),
    label: Type.Optional(Type.String({ description: "Human-readable label for this monitor" })),
    triggerTurn: Type.Optional(Type.Boolean({ description: "If true, deliver the monitor output as a user turn that triggers an LLM response (default: false)" })),
  });

  const MonitorStopSchema = Type.Object({
    id: Type.String({ description: "Monitor ID to stop (e.g., mon_1)" }),
  });

  const MonitorListSchema = Type.Object({});

  type MonitorToolParams = Static<typeof MonitorToolSchema>;

/* ------------------------------------------------------------------ */
/* Extension factory                                                  */
/* ------------------------------------------------------------------ */

export default function (pi: ExtensionAPI) {
  let runner: ProcessRunner | null = null;
  let engines: Map<string, MonitorEngine> | null = null;
  let monitorCounter = 0;

  interface MonitorInfo {
    id: string;
    command: string;
    regex: string;
    label?: string;
    triggerTurn?: boolean;
    startedAt: number;
  }
  let activeMonitors = new Map<string, MonitorInfo>();
  let setStatusRef: ((key: string, text: string | undefined) => void) | null = null;

  registerCompactMonitorRenderer(pi);

  function updateStatusline(): void {
    if (!setStatusRef) return;
    if (activeMonitors.size > 0) {
      setStatusRef(STATUSLINE_KEY, `${activeMonitors.size}`);
    } else {
      setStatusRef(STATUSLINE_KEY, undefined);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    runner = new ProcessRunner();
    engines = new Map();
    setStatusRef = ctx.ui.setStatus.bind(ctx.ui);
    updateStatusline();
  });

  pi.on("session_shutdown", async () => {
    // Destroy all monitor engines
    if (engines) {
      for (const engine of engines.values()) engine.destroy();
      engines.clear();
    }

    // Dispose all runner processes
    if (runner) {
      // runner doesn't track jobs by list, but engines being destroyed means
      // the output listeners are removed, so processes will be orphaned.
      // We rely on process group cleanup via SIGTERM on session exit.
    }

    await closeRedos();

    engines = null;
    runner = null;
    activeMonitors.clear();
    if (setStatusRef) {
      setStatusRef(STATUSLINE_KEY, undefined);
      setStatusRef = null;
    }
  });

  /* ---------------------------------------------------------------- */
  /* Monitor handler                                                  */
  /* ---------------------------------------------------------------- */

  async function handleMonitor(
    ctx: ExtensionContext,
    command: string,
    regex: RegExp,
    before: number,
    after: number,
    debounceMs: number,
    label?: string,
    triggerTurn?: boolean,
  ): Promise<string> {
    const runnerRef = runner!;
    const enginesRef = engines!;

    await vetRegexPattern(regex.source, regex.flags);

    const jobID = `mon_${++monitorCounter}`;
    let engine: MonitorEngine | null = null;
    let onOutput: ((event: OutputEvent) => void) | null = null;
    let exitPromise: Promise<number | null>;

    try {
      engine = new MonitorEngine({
        jobID,
        regex,
        before,
        after,
        debounceMs,
        onWindow: (window: MonitorWindow) => {
          const lines = window.events.map((e) => e.line).join("\n");
          const details: PiMonitorMessageDetails = {
            jobID,
            command,
            regex: regex.source,
            label,
            matchCount: window.matchSeqs.length,
            lineCount: window.events.length,
            truncated: window.truncated,
          };
          if (triggerTurn) {
            // When idle: use followUp so the renderer shows the compact view AND
            // triggerTurn wakes the LLM. When busy: steer interrupts after current tools.
            pi.sendMessage(
              {
                customType: "pi-monitor",
                content: lines,
                display: true,
                details,
              },
              ctx.isIdle()
                ? { triggerTurn: true, deliverAs: "followUp" }
                : { deliverAs: "steer" },
            );
          } else {
            pi.sendMessage({
              customType: "pi-monitor",
              content: lines,
              display: true,
              details,
            });
          }
        },
      });

      ({ exitPromise } = runnerRef.run(jobID, command));
    } catch (error) {
      engine?.destroy();
      enginesRef.delete(jobID);
      runnerRef.dispose(jobID);
      throw error;
    }

    enginesRef.set(jobID, engine);
    activeMonitors.set(jobID, { id: jobID, command, regex: regex.source, label, triggerTurn, startedAt: Date.now() });
    updateStatusline();

    onOutput = (event: OutputEvent) => {
      engine.ingest(event);
    };
    runnerRef.on("output", onOutput);

    // Async cleanup on process exit
    (async () => {
      try {
        await exitPromise;
        engine.flush();
      } catch {
        // process error
      } finally {
        if (onOutput) runnerRef.removeListener("output", onOutput);
        engine.destroy();
        enginesRef.delete(jobID);
        runnerRef.dispose(jobID);
        activeMonitors.delete(jobID);
        updateStatusline();
      }
    })().catch(() => {});

    return `started ${jobID}`;
  }

  /* ---------------------------------------------------------------- */
  /* Cancel handler                                                   */
  /* ---------------------------------------------------------------- */

  async function handleCancel(jobID: string): Promise<string> {
    const runnerRef = runner!;
    const enginesRef = engines!;

    const engine = enginesRef.get(jobID);
    if (!engine) {
      return `monitor ${jobID} not found`;
    }

    engine.destroy();
    enginesRef.delete(jobID);
    activeMonitors.delete(jobID);
    updateStatusline();

    try {
      await runnerRef.cancel(jobID);
    } catch {
      // process may already be gone
    }

    return `${jobID} cancelled`;
  }

  /* ---------------------------------------------------------------- */
  /* List handler                                                     */
  /* ---------------------------------------------------------------- */

  function handleList(): string {
    if (activeMonitors.size === 0) {
      return "no monitors running";
    }
    const now = Date.now();
    return [...activeMonitors.values()].map((m) => {
      const elapsed = Math.floor((now - m.startedAt) / 1000);
      const parts = [`- ${m.id}`];
      parts.push(`\`${m.command}\``);
      if (m.regex !== ".*") parts.push(`regex: /${m.regex}/`);
      if (m.triggerTurn) parts.push("trigger");
      if (m.label) parts.push(`[${m.label}]`);
      parts.push(formatUptime(elapsed));
      return parts.join(" ");
    }).join("\n");
  }

  /* ---------------------------------------------------------------- */
  /* Slash commands                                                   */
  /* ---------------------------------------------------------------- */

  pi.registerCommand("monitor", {
    description: "Watch a command's output for a regex (--regex <pattern> -- <command>)",
    handler: async (args, ctx) => {
      const parsed = parseMonitorArgs(args);
      if (typeof parsed === "string") {
        ctx.ui.notify(parsed, "error");
        return;
      }
      const result = await handleMonitor(
        ctx,
        parsed.command,
        parsed.regex,
        parsed.before,
        parsed.after,
        parsed.debounceMs,
        parsed.label,
        parsed.triggerTurn,
      );
      ctx.ui.notify(result);
    },
  });

  pi.registerCommand("monitor-stop", {
    description: "Stop a running monitor (/monitor-stop <jobID>)",
    handler: async (args, ctx) => {
      const jobID = args.trim();
      if (!jobID) {
        ctx.ui.notify("Usage: /monitor-stop <jobID>", "warning");
        return;
      }
      const result = await handleCancel(jobID);
      ctx.ui.notify(result);
    },
  });

  pi.registerCommand("monitor-list", {
    description: "List running monitors",
    handler: async (_args, ctx) => {
      ctx.ui.notify(handleList());
    },
  });

  /* ---------------------------------------------------------------- */
  /* AI-callable tool                                                 */
  /* ---------------------------------------------------------------- */

  pi.registerTool({
    name: "Monitor",
    label: "Monitor",
    description:
      "Run a shell command in the background and watch stdout for regex matches. " +
      "Matching windows (with before/after context lines) are delivered to you as they arrive. " +
      "Use for watching logs, build output, test runners, deploy status. " +
      "Stderr is not forwarded.",
    parameters: MonitorToolSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const command = (params as MonitorToolParams).command;
      const regexStr = (params as MonitorToolParams).regex ?? ".*";
      const regexFlags = (params as MonitorToolParams).regexFlags;
      const before = (params as MonitorToolParams).before;
      const after = (params as MonitorToolParams).after;
      const debounceSeconds = (params as MonitorToolParams).debounceSeconds;
      const label = (params as MonitorToolParams).label;
      const triggerTurn = (params as MonitorToolParams).triggerTurn ?? false;

      // Validate regex
      if (regexStr.length > MAX_REGEX_PATTERN_LENGTH) {
        return {
          content: [{ type: "text", text: `Regex pattern exceeds ${MAX_REGEX_PATTERN_LENGTH} characters` }],
          details: {},
          isError: true,
        };
      }

      const flags = regexFlags ?? "";
      for (const ch of flags) {
        if (ch === "g") {
          return {
            content: [{ type: "text", text: "Unsupported regex flag 'g'" }],
            details: {},
            isError: true,
          };
        }
        if (ch === "y") {
          return {
            content: [{ type: "text", text: "Unsupported regex flag 'y'" }],
            details: {},
            isError: true,
          };
        }
      }

      let regex: RegExp;
      try {
        regex = new RegExp(regexStr, flags);
      } catch {
        return {
          content: [{ type: "text", text: `Invalid regex: ${regexStr}` }],
          details: {},
          isError: true,
        };
      }

      const b = clampInt(before ?? 0, 0, MAX_CONTEXT_LINES);
      const a = clampInt(after ?? 0, 0, MAX_CONTEXT_LINES);
      const ds = clampInt(debounceSeconds ?? 0, MIN_MONITOR_DEBOUNCE_S, MAX_MONITOR_DEBOUNCE_S);

      try {
        const result = await handleMonitor(ctx, command, regex, b, a, ds * 1000, label, triggerTurn);
        const parts: string[] = [];
        if (regexStr !== ".*") parts.push(`regex: /${regexStr}/`);
        if (b !== 0 || a !== 0) parts.push(`ctx: ±${b === a ? b : `${b}/${a}`}`);
        if (ds !== 0) parts.push(`debounce: ${ds}s`);
        if (triggerTurn) parts.push("trigger");
        if (label) parts.push(`[${label}]`);
        const details = parts.length > 0 ? ` (${parts.join(", ")})` : "";
        return {
          content: [{ type: "text", text: `${result}: \`${command}\`${details}` }],
          details: { command, regex: regexStr, before: b, after: a, debounceSeconds: ds, label, triggerTurn },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Monitor error: ${(error as Error).message}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "MonitorStop",
    label: "Stop Monitor",
    description: "Stop a running monitor by its ID.",
    parameters: MonitorStopSchema,
    async execute(_toolCallId, params) {
      const { id } = params as { id: string };
      try {
        const result = await handleCancel(id);
        return { content: [{ type: "text", text: result }], details: { id } };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
          details: { id },
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "MonitorList",
    label: "List Monitors",
    description: "List all running monitors.",
    parameters: MonitorListSchema,
    async execute() {
      const result = handleList();
      return { content: [{ type: "text", text: result }], details: {} };
    },
  });
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isInteger(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

interface ParsedMonitor {
  command: string;
  regex: RegExp;
  before: number;
  after: number;
  debounceMs: number;
  label?: string;
  triggerTurn?: boolean;
}

function parseMonitorArgs(args: string): ParsedMonitor | string {
  const parts = args.trim().split(/\s+/);
  let command = "";
  let regexStr = "";
  let before = 10;
  let after = 10;
  let debounceMs = 5000;
  let label: string | undefined;
  let triggerTurn = false;

  let i = 0;
  while (i < parts.length) {
    const arg = parts[i];
    if (arg === "--regex" && i + 1 < parts.length) {
      regexStr = parts[++i];
    } else if (arg === "--before" && i + 1 < parts.length) {
      before = parseInt(parts[++i], 10);
    } else if (arg === "--after" && i + 1 < parts.length) {
      after = parseInt(parts[++i], 10);
    } else if (arg === "--debounce" && i + 1 < parts.length) {
      debounceMs = parseInt(parts[++i], 10) * 1000;
    } else if (arg === "--label" && i + 1 < parts.length) {
      label = parts[++i];
    } else if (arg === "--trigger") {
      triggerTurn = true;
    } else if (arg === "--") {
      command = parts.slice(i + 1).join(" ");
      break;
    } else if (!arg.startsWith("--") && !command) {
      command = parts.slice(i).join(" ");
      break;
    }
    i++;
  }

  if (!regexStr) return "Missing --regex <pattern>";
  if (!command) return "Missing command (after --)";

  try {
    const regex = new RegExp(regexStr);
    return { command, regex, before, after, debounceMs, label, triggerTurn };
  } catch {
    return `Invalid regex: ${regexStr}`;
  }
}
