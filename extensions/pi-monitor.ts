/**
 * pi-monitor — background process monitoring with regex matching,
 * plus fire-and-forget background shell jobs.
 *
 * Tools:
 * - Monitor: run a shell command, deliver regex-matching stdout windows, notify on exit.
 * - Background: run a shell command with no intermediate deliveries; notify on exit only.
 * - MonitorStop / MonitorList: stop or list any job (mon_* or bg_*).
 *
 * Agents are notified automatically on match and on exit — do not poll.
 */
import { Type, type Static } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ProcessRunner } from "../src/runner/process-runner.ts";
import { MonitorEngine, type MonitorWindow } from "../src/runner/monitor-engine.ts";
import { vetRegexPattern, close as closeRedos } from "../src/runner/redos.ts";
import { MonitorDeliveryBatcher } from "../src/delivery-batcher.ts";
import { formatMonitorExitXml } from "../src/delivery-format.ts";
import type { OutputEvent } from "../src/types.ts";
import {
  MIN_MONITOR_DEBOUNCE_S,
  MAX_MONITOR_DEBOUNCE_S,
  MAX_REGEX_PATTERN_LENGTH,
  MAX_ACTIVE_JOBS,
  EXIT_TAIL_LINES,
} from "../src/limits.ts";
import {
  registerCompactMonitorRenderer,
  type PiMonitorMessageDetails,
} from "../src/ui/compact-monitor-message.ts";
import {
  renderMonitorCall,
  renderMonitorResult,
  renderMonitorStopResult,
  renderMonitorListCall,
  renderMonitorListResult,
  renderBackgroundCall,
  renderBackgroundResult,
  formatUptime,
  type MonitorDetails,
  type MonitorStopDetails,
  type MonitorListDetails,
  type ActiveMonitorInfo,
  type BackgroundDetails,
} from "../src/ui/monitor-tool-renderers.ts";
import { getConfirmStop, setConfirmStop } from "../src/settings.ts";

const MAX_CONTEXT_LINES = 200;
const STATUSLINE_KEY = "/m";
const DEFAULT_TRIGGER_TURN = true;

const NO_POLL_MATCH =
  "You will be notified automatically when matching output arrives and when this job exits (exit code, last lines, full output path). Do not poll MonitorList to wait for output or completion.";
const NO_POLL_BG =
  "No intermediate output is delivered. You will be notified automatically when this job exits (exit code, last lines, full output path). Do not poll.";

/* ------------------------------------------------------------------ */
/* Tool schemas                                                       */
/* ------------------------------------------------------------------ */

const MonitorToolSchema = Type.Object({
  command: Type.String({
    description:
      "Shell command to run in the background. Matching output and process exit are delivered automatically — do not poll.",
  }),
  regex: Type.Optional(Type.String({ description: "Regex pattern to match against each stdout line (default: match everything)" })),
  regexFlags: Type.Optional(Type.String({ description: "RegExp flags (default: '')" })),
  before: Type.Optional(Type.Number({ description: "Lines of context before match (default: 0)" })),
  after: Type.Optional(Type.Number({ description: "Lines of context after match (default: 0)" })),
  debounceSeconds: Type.Optional(Type.Number({ description: "Debounce window in seconds (0-60, default: 0)" })),
  label: Type.Optional(Type.String({ description: "Human-readable label for this monitor" })),
  triggerTurn: Type.Optional(Type.Boolean({
    default: DEFAULT_TRIGGER_TURN,
    description: "If true, deliver match output as a user turn that triggers an LLM response (default: true; set false to only display/log). Exit notifications always trigger a turn.",
  })),
});

const BackgroundToolSchema = Type.Object({
  command: Type.String({
    description:
      "Shell command to run in the background. No intermediate output is delivered. You will be notified when it exits — do not poll.",
  }),
  label: Type.Optional(Type.String({ description: "Human-readable label for this background job" })),
});

const MonitorStopSchema = Type.Object({
  id: Type.String({ description: "Job ID to stop (e.g. mon_1 or bg_1). You will be notified when the process exits after stop." }),
});

const MonitorListSchema = Type.Object({});

type MonitorToolParams = Static<typeof MonitorToolSchema>;
type BackgroundToolParams = Static<typeof BackgroundToolSchema>;

/* ------------------------------------------------------------------ */
/* Extension factory                                                  */
/* ------------------------------------------------------------------ */

export default function (pi: ExtensionAPI) {
  let runner: ProcessRunner | null = null;
  let engines: Map<string, MonitorEngine> | null = null;
  let monitorCounter = 0;
  let backgroundCounter = 0;
  const deliveryBatcher = new MonitorDeliveryBatcher({
    send: (message, triggerTurn) => {
      // Batcher catches throws from send (stale ctx) so deferred flushes never
      // become uncaughtExceptions. Keep this path direct; do not catch here.
      if (triggerTurn) {
        pi.sendMessage(message, { deliverAs: "steer", triggerTurn: true });
      } else {
        pi.sendMessage(message);
      }
    },
  });

  /**
   * Best-effort send that never throws after session replacement/reload.
   * Pi marks the extension runtime stale on dispose; async exit IIFEs and
   * timers must not turn that into an uncaughtException that kills pi.
   */
  function safeSendMessage(
    message: Parameters<ExtensionAPI["sendMessage"]>[0],
    options?: Parameters<ExtensionAPI["sendMessage"]>[1],
  ): boolean {
    try {
      if (options !== undefined) {
        pi.sendMessage(message, options);
      } else {
        pi.sendMessage(message);
      }
      return true;
    } catch {
      // Stale extension ctx (or other send failure). Drop the delivery.
      deliveryBatcher.invalidate();
      return false;
    }
  }

  interface JobInfo {
    id: string;
    kind: "mon" | "bg";
    command: string;
    regex: string;
    label?: string;
    triggerTurn?: boolean;
    startedAt: number;
    outputPath: string;
  }
  let activeJobs = new Map<string, JobInfo>();
  let setStatusRef: ((key: string, text: string | undefined) => void) | null = null;
  /** Jobs that should not send exit notifications (session shutting down). */
  let suppressExitNotify = false;
  /**
   * Bumped on session_start and session_shutdown so exit IIFEs from a prior
   * session cannot steer into a later session after suppressExitNotify is cleared.
   */
  let sessionGeneration = 0;

  registerCompactMonitorRenderer(pi);

  function updateStatusline(): void {
    if (!setStatusRef) return;
    try {
      if (activeJobs.size > 0) {
        setStatusRef(STATUSLINE_KEY, `${activeJobs.size}`);
      } else {
        setStatusRef(STATUSLINE_KEY, undefined);
      }
    } catch {
      // Bound ctx.ui.setStatus can throw once the extension runtime is stale.
      setStatusRef = null;
    }
  }

  function assertUnderJobLimit(): void {
    if (activeJobs.size >= MAX_ACTIVE_JOBS) {
      throw new Error(
        `maximum of ${MAX_ACTIVE_JOBS} active jobs reached; stop a job before starting another`,
      );
    }
  }

  function sendExitNotification(opts: {
    jobID: string;
    kind: "mon" | "bg";
    command: string;
    regex: string;
    label?: string;
    exitCode: number | null;
    signal: string | null;
    outputPath: string;
    lastLines: string[];
    /** Session generation captured when the job was started. */
    sessionGen: number;
  }): void {
    // Suppress on shutdown, and drop steers from jobs that belong to an older session.
    if (suppressExitNotify || opts.sessionGen !== sessionGeneration) return;

    // Flush any pending match batches first so exit arrives after matches.
    deliveryBatcher.flush();

    const details: PiMonitorMessageDetails = {
      jobID: opts.jobID,
      command: opts.command,
      regex: opts.regex,
      label: opts.label,
      matchCount: 0,
      lineCount: opts.lastLines.length,
      truncated: false,
      event: "exit",
      exitCode: opts.exitCode,
      signal: opts.signal,
      outputPath: opts.outputPath,
      kind: opts.kind,
    };

    const content = formatMonitorExitXml({
      jobID: opts.jobID,
      exitCode: opts.exitCode,
      signal: opts.signal,
      outputPath: opts.outputPath,
      lastLines: opts.lastLines,
    });

    // Exit always steers the agent (even if match triggerTurn was false).
    // Use safeSend so a race with session dispose never throws uncaught.
    safeSendMessage(
      {
        customType: "pi-monitor",
        content,
        display: true,
        details,
      },
      { deliverAs: "steer", triggerTurn: true },
    );
  }

  pi.on("session_start", async (_event, ctx) => {
    // New session: clear suppress, bump generation so prior-session exit IIFEs
    // cannot notify, and revive the batcher after session_shutdown invalidation.
    sessionGeneration += 1;
    suppressExitNotify = false;
    deliveryBatcher.reset();
    runner = new ProcessRunner();
    engines = new Map();
    setStatusRef = ctx.ui.setStatus.bind(ctx.ui);
    updateStatusline();
  });

  pi.on("session_shutdown", async () => {
    suppressExitNotify = true;
    // Bump generation so in-flight exit handlers from this session become inert
    // even if they race past suppressExitNotify being cleared on the next start.
    sessionGeneration += 1;
    // Invalidate the batcher first to prevent any scheduled flushes from
    // trying to send on a stale context after session replacement.
    deliveryBatcher.invalidate();

    // Destroy all monitor engines
    if (engines) {
      for (const engine of engines.values()) engine.destroy();
      engines.clear();
    }

    // Dispose runner processes (log files are kept on disk)
    if (runner) {
      for (const jobID of activeJobs.keys()) {
        try {
          runner.dispose(jobID);
        } catch {
          /* ignore */
        }
      }
    }

    await closeRedos();

    engines = null;
    runner = null;
    activeJobs.clear();
    if (setStatusRef) {
      setStatusRef(STATUSLINE_KEY, undefined);
      setStatusRef = null;
    }
  });

  /* ---------------------------------------------------------------- */
  /* Shared job start / exit cleanup                                  */
  /* ---------------------------------------------------------------- */

  async function startMonitorJob(
    command: string,
    regex: RegExp,
    before: number,
    after: number,
    debounceMs: number,
    label?: string,
    triggerTurn?: boolean,
  ): Promise<{ jobID: string; outputPath: string }> {
    const runnerRef = runner!;
    const enginesRef = engines!;

    assertUnderJobLimit();
    await vetRegexPattern(regex.source, regex.flags);

    const shouldTriggerTurn = triggerTurn ?? DEFAULT_TRIGGER_TURN;
    const jobID = `mon_${++monitorCounter}`;
    // Capture generation at start so exit handlers from this job are inert
    // after a later session_start/shutdown bumps sessionGeneration.
    const jobSessionGen = sessionGeneration;
    let engine: MonitorEngine | null = null;
    let onOutput: ((event: OutputEvent) => void) | null = null;

    let exitPromise: ReturnType<ProcessRunner["run"]>["exitPromise"];
    let outputPath: string;

    try {
      engine = new MonitorEngine({
        jobID,
        regex,
        before,
        after,
        debounceMs,
        onWindow: (window: MonitorWindow) => {
          // Drop match deliveries if the session that started this job is gone.
          if (jobSessionGen !== sessionGeneration) return;
          const lines = window.events.map((e) => e.line).join("\n");
          const details: PiMonitorMessageDetails = {
            jobID,
            command,
            regex: regex.source,
            label,
            matchCount: window.matchSeqs.length,
            lineCount: window.events.length,
            truncated: window.truncated,
            event: "match",
            kind: "mon",
          };
          deliveryBatcher.enqueue({
            raw: lines,
            details,
            triggerTurn: shouldTriggerTurn,
          });
        },
      });

      ({ exitPromise, outputPath } = runnerRef.run(jobID, command));
    } catch (error) {
      engine?.destroy();
      enginesRef.delete(jobID);
      runnerRef.dispose(jobID);
      throw error;
    }

    enginesRef.set(jobID, engine);
    activeJobs.set(jobID, {
      id: jobID,
      kind: "mon",
      command,
      regex: regex.source,
      label,
      triggerTurn: shouldTriggerTurn,
      startedAt: Date.now(),
      outputPath,
    });
    updateStatusline();

    // Docs and tool description: match stdout only. Still tee both streams via ProcessRunner.
    onOutput = (event: OutputEvent) => {
      if (event.stream !== "stdout") return;
      engine!.ingest(event);
    };
    runnerRef.on("output", onOutput);

    // Async cleanup + exit notification on process exit
    (async () => {
      let exitCode: number | null = null;
      let signal: string | null = null;
      try {
        const result = await exitPromise;
        exitCode = result.code;
        signal = result.signal;
        engine!.flush();
      } catch {
        // process error
      } finally {
        const lastLines = runnerRef.tailCombined(jobID, EXIT_TAIL_LINES);
        const path = runnerRef.outputPath(jobID) ?? outputPath;
        const info = activeJobs.get(jobID);

        if (onOutput) runnerRef.removeListener("output", onOutput);
        engine!.destroy();
        enginesRef.delete(jobID);
        // Snapshot before dispose so tails remain available for the message
        sendExitNotification({
          jobID,
          kind: "mon",
          command: info?.command ?? command,
          regex: info?.regex ?? regex.source,
          label: info?.label ?? label,
          exitCode,
          signal,
          outputPath: path,
          lastLines,
          sessionGen: jobSessionGen,
        });
        runnerRef.dispose(jobID);
        activeJobs.delete(jobID);
        updateStatusline();
      }
    })().catch(() => {});

    return { jobID, outputPath };
  }

  async function startBackgroundJob(
    command: string,
    label?: string,
  ): Promise<{ jobID: string; outputPath: string }> {
    const runnerRef = runner!;
    assertUnderJobLimit();
    const jobID = `bg_${++backgroundCounter}`;
    const jobSessionGen = sessionGeneration;

    const { exitPromise, outputPath } = runnerRef.run(jobID, command);

    activeJobs.set(jobID, {
      id: jobID,
      kind: "bg",
      command,
      regex: ".*",
      label,
      triggerTurn: true,
      startedAt: Date.now(),
      outputPath,
    });
    updateStatusline();

    // No MonitorEngine — exit-only ("infinite debounce")
    (async () => {
      let exitCode: number | null = null;
      let signal: string | null = null;
      try {
        const result = await exitPromise;
        exitCode = result.code;
        signal = result.signal;
      } catch {
        // process error
      } finally {
        const lastLines = runnerRef.tailCombined(jobID, EXIT_TAIL_LINES);
        const path = runnerRef.outputPath(jobID) ?? outputPath;
        const info = activeJobs.get(jobID);

        sendExitNotification({
          jobID,
          kind: "bg",
          command: info?.command ?? command,
          regex: ".*",
          label: info?.label ?? label,
          exitCode,
          signal,
          outputPath: path,
          lastLines,
          sessionGen: jobSessionGen,
        });
        runnerRef.dispose(jobID);
        activeJobs.delete(jobID);
        updateStatusline();
      }
    })().catch(() => {});

    return { jobID, outputPath };
  }

  /* ---------------------------------------------------------------- */
  /* Cancel handler                                                   */
  /* ---------------------------------------------------------------- */

  async function handleCancel(jobID: string): Promise<string> {
    const runnerRef = runner!;
    const enginesRef = engines!;

    if (!activeJobs.has(jobID) && !enginesRef.has(jobID)) {
      // Still try cancel in case race
      try {
        await runnerRef.cancel(jobID);
      } catch {
        return `job ${jobID} not found`;
      }
    }

    // Flush pending debounced match windows before destroy so stop does not
    // drop them; the exit IIFE still runs and will no-op flush on a destroyed engine.
    const engine = enginesRef.get(jobID);
    if (engine) {
      engine.flush();
      engine.destroy();
      enginesRef.delete(jobID);
    }

    try {
      await runnerRef.cancel(jobID);
    } catch {
      // process may already be gone — exit handler still runs
    }

    // Exit notification is sent by the job's exit async path once the process closes.
    return `${jobID} stop requested (you will be notified when the process exits — do not poll)`;
  }

  /* ---------------------------------------------------------------- */
  /* Slash commands                                                   */
  /* ---------------------------------------------------------------- */

  pi.registerCommand("monitor-stop", {
    description: "Stop a running monitor or background job (/monitor-stop <jobID>)",
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
    description: "Interactive menu: list running jobs (monitors + background), view tail, stop",
    handler: async (_args, ctx) => {
      if (activeJobs.size === 0) {
        ctx.ui.notify("no jobs running", "info");
        return;
      }
      const { showMonitorMenu } = await import("../src/ui/monitor-menu.js");
      await showMonitorMenu({
        ctx: ctx as unknown as Parameters<typeof showMonitorMenu>[0]["ctx"],
        getMonitors: () => [...activeJobs.values()].map((m) => ({
          id: m.id,
          command: m.command,
          regex: m.regex,
          label: m.label,
          triggerTurn: m.triggerTurn,
          startedAt: m.startedAt,
        })),
        tail: (jobID, stream) => {
          const r = runner;
          if (!r) return [];
          try {
            return r.tail(jobID, stream);
          } catch {
            // Engine may have been torn down between getMonitors and tail.
            return [];
          }
        },
        getConfirmStop: () => getConfirmStop(),
        setConfirmStop: (value) => setConfirmStop(value),
        onCancel: (jobID) => handleCancel(jobID),
      });
    },
  });

  /* ---------------------------------------------------------------- */
  /* AI-callable tools                                                */
  /* ---------------------------------------------------------------- */

  pi.registerTool({
    name: "Monitor",
    label: "Monitor",
    description:
      "Run a shell command in the background and watch stdout for regex matches. " +
      "Matching windows (with optional before/after context) are delivered to you automatically as steer messages. " +
      "When the process exits you are also notified with exit code, last lines of output, and the path to full output. " +
      "Do not poll MonitorList to wait for output or completion — you will be notified. " +
      "Use for watching logs, build output, test runners, deploy status. Stderr is captured to the log file but not matched.",
    parameters: MonitorToolSchema,
    renderShell: "self",
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const command = (params as MonitorToolParams).command;
      const regexStr = (params as MonitorToolParams).regex ?? ".*";
      const regexFlags = (params as MonitorToolParams).regexFlags;
      const before = (params as MonitorToolParams).before;
      const after = (params as MonitorToolParams).after;
      const debounceSeconds = (params as MonitorToolParams).debounceSeconds;
      const label = (params as MonitorToolParams).label;
      const triggerTurn = (params as MonitorToolParams).triggerTurn ?? DEFAULT_TRIGGER_TURN;

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
        const { jobID, outputPath } = await startMonitorJob(
          command,
          regex,
          b,
          a,
          ds * 1000,
          label,
          triggerTurn,
        );
        const parts: string[] = [];
        if (regexStr !== ".*") parts.push(`regex: /${regexStr}/`);
        if (b !== 0 || a !== 0) parts.push(`ctx: ±${b === a ? b : `${b}/${a}`}`);
        if (ds !== 0) parts.push(`debounce: ${ds}s`);
        if (triggerTurn) parts.push("trigger");
        if (label) parts.push(`[${label}]`);
        const details = parts.length > 0 ? ` (${parts.join(", ")})` : "";
        const text =
          `started ${jobID}: \`${command}\`${details}. ${NO_POLL_MATCH} Full output: ${outputPath}`;
        return {
          content: [{ type: "text", text }],
          details: {
            command,
            regex: regexStr,
            before: b,
            after: a,
            debounceSeconds: ds,
            label,
            triggerTurn,
            jobID,
            outputPath,
          },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Monitor error: ${(error as Error).message}` }],
          details: {},
          isError: true,
        };
      }
    },
    renderCall: (args, theme, _context) =>
      renderMonitorCall(args as MonitorDetails, theme),
    renderResult: (result, options, theme, context) =>
      renderMonitorResult(
        (result.details as MonitorDetails) ?? (context.args as MonitorDetails),
        context.isError,
        options.isPartial,
        theme,
      ),
  });

  pi.registerTool({
    name: "Background",
    label: "Background",
    description:
      "Run a shell command in the background without streaming intermediate output " +
      "(like a monitor with infinite debounce). When the process exits you are notified " +
      "with exit code, last lines of output, and the path to full output. " +
      "Do not poll MonitorList to wait for completion — you will be notified. " +
      "Use for builds, installs, long scripts, or any fire-and-forget shell work.",
    parameters: BackgroundToolSchema,
    renderShell: "self",
    async execute(_toolCallId, params) {
      const command = (params as BackgroundToolParams).command;
      const label = (params as BackgroundToolParams).label;

      try {
        const { jobID, outputPath } = await startBackgroundJob(command, label);
        const labelPart = label ? ` [${label}]` : "";
        const text =
          `started ${jobID}: \`${command}\`${labelPart}. ${NO_POLL_BG} Full output: ${outputPath}`;
        return {
          content: [{ type: "text", text }],
          details: { command, label, jobID, outputPath },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Background error: ${(error as Error).message}` }],
          details: { command, label, jobID: "", outputPath: "" },
          isError: true,
        };
      }
    },
    renderCall: (args, theme) =>
      renderBackgroundCall(args as BackgroundDetails, theme),
    renderResult: (result, options, theme, context) =>
      renderBackgroundResult(
        (result.details as BackgroundDetails) ?? (context.args as BackgroundDetails),
        context.isError,
        options.isPartial,
        theme,
      ),
  });

  pi.registerTool({
    name: "MonitorStop",
    label: "Stop Monitor",
    description:
      "Stop a running monitor or background job by its ID (mon_* or bg_*). " +
      "You will be notified when the process actually exits after the stop — do not poll.",
    parameters: MonitorStopSchema,
    renderShell: "self",
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
    renderResult: (_result, _options, theme, context) =>
      renderMonitorStopResult(context.args as MonitorStopDetails, context.isError, theme),
  });

  pi.registerTool({
    name: "MonitorList",
    label: "List Monitors",
    description:
      "List all running monitors and background jobs (for inspection only). " +
      "Do not poll this tool to wait for output or completion — matching output and process exits are delivered automatically.",
    parameters: MonitorListSchema,
    renderShell: "self",
    async execute() {
      const now = Date.now();
      const monitors: ActiveMonitorInfo[] = [...activeJobs.values()].map((m) => ({
        id: m.id,
        command: m.command,
        regex: m.regex,
        label: m.label,
        triggerTurn: m.triggerTurn,
        uptimeSec: Math.floor((now - m.startedAt) / 1000),
        kind: m.kind,
        outputPath: m.outputPath,
      }));
      // Plain text fallback for the LLM to read in tool result content.
      const text = monitors.length === 0
        ? "no jobs running. Jobs notify you on match/exit — do not poll this list to wait."
        : monitors
            .map((m) => {
              const parts = [`- ${m.id}`, `(${m.kind ?? "mon"})`, `\`${m.command}\``];
              if (m.kind !== "bg" && m.regex !== ".*") parts.push(`regex: /${m.regex}/`);
              if (m.triggerTurn) parts.push("trigger");
              if (m.label) parts.push(`[${m.label}]`);
              parts.push(formatUptime(m.uptimeSec));
              return parts.join(" ");
            })
            .join("\n");
      return { content: [{ type: "text", text }], details: { monitors } };
    },
    renderCall: (_args, theme) => renderMonitorListCall(theme),
    renderResult: (result, _options, theme, context) => {
      const details = (result.details as MonitorListDetails) ?? { monitors: [] };
      return renderMonitorListResult(details, context.isError, theme);
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
