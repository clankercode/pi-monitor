/**
 * pi-monitor — Pi extension that watches background processes and feeds
 * their stdout lines as events to the agent session.
 *
 * Like Bash run_in_background but push-based: each stdout line arrives
 * as a notification, no polling required.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, type ChildProcess } from "node:child_process";

interface Monitor {
  id: string;
  command: string;
  filter: RegExp | null;
  child: ChildProcess;
  lineCount: number;
  matchedCount: number;
  startedAt: number;
  ctx: ExtensionContext;
}

const MAX_EVENTS_PER_MONITOR = 500;
const monitors = new Map<string, Monitor>();
let monitorCounter = 0;

export default function monitorExtension(pi: ExtensionAPI): void {
  // --- Monitor tool ---

  pi.registerTool({
    name: "monitor",
    label: "Monitor",
    description:
      "Run a shell command in the background and receive each stdout line as a notification. " +
      "Use for watching logs, build output, test runners, deploy status, file watchers. " +
      "Stderr is not forwarded. Use --filter to only receive lines matching a pattern.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run in the background" }),
      filter: Type.Optional(
        Type.String({
          description: "Regex pattern — only lines matching this are forwarded. Omit to receive all lines.",
        }),
      ),
      label: Type.Optional(
        Type.String({ description: "Human-readable label for this monitor (shown in status)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const { command, filter: filterStr, label } = params as {
        command: string;
        filter?: string;
        label?: string;
      };

      let filter: RegExp | null = null;
      if (filterStr) {
        try {
          filter = new RegExp(filterStr);
        } catch {
          return {
            content: [{ type: "text", text: `Invalid filter regex: ${filterStr}` }],
            details: {},
            isError: true,
          };
        }
      }

      const id = `monitor-${++monitorCounter}`;
      const child = spawn("bash", ["-c", command], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });

      const monitor: Monitor = {
        id,
        command,
        filter,
        child,
        lineCount: 0,
        matchedCount: 0,
        startedAt: Date.now(),
        ctx,
      };

      monitors.set(id, monitor);

      // Buffer partial lines
      let buffer = "";

      child.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // keep incomplete line in buffer

        for (const line of lines) {
          if (!line) continue;
          monitor.lineCount++;

          if (filter && !filter.test(line)) continue;

          monitor.matchedCount++;

          // Auto-stop if too many events (prevent context flooding)
          if (monitor.matchedCount > MAX_EVENTS_PER_MONITOR) {
            pi.sendMessage({
              customType: "monitor-event",
              content: `[${label ?? id}] Auto-stopped: exceeded ${MAX_EVENTS_PER_MONITOR} events. Re-run with a tighter filter.`,
              display: true,
            });
            stopMonitor(id);
            return;
          }

          // Push line to agent as a hidden message (visible in context, not TUI)
          pi.sendMessage({
            customType: "monitor-event",
            content: `[${label ?? id}] ${line}`,
            display: false,
          });
        }
      });

      child.on("close", (code) => {
        monitors.delete(id);
        const exitInfo = code === 0 ? "completed" : `exited with code ${code}`;
        pi.sendMessage({
          customType: "monitor-event",
          content: `[${label ?? id}] Monitor ${exitInfo} after ${monitor.lineCount} lines (${monitor.matchedCount} matched)`,
          display: true,
        });
      });

      child.on("error", (err) => {
        monitors.delete(id);
        pi.sendMessage({
          customType: "monitor-event",
          content: `[${label ?? id}] Monitor error: ${err.message}`,
          display: true,
        });
      });

      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Started monitor \`${id}\`: \`${command}\`${filter ? ` (filter: ${filterStr})` : ""}`,
          },
        ],
        details: {},
      });

      return {
        content: [
          {
            type: "text",
            text: [
              `Monitor started: ${id}`,
              `Command: ${command}`,
              filter ? `Filter: ${filterStr}` : null,
              label ? `Label: ${label}` : null,
              "",
              "Each matching stdout line will be sent to you as it arrives.",
              `Use \`monitor_stop\` with id \`${id}\` to stop.`,
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
        details: { id, command, filter: filterStr ?? null, label: label ?? null },
      };
    },
  });

  // --- Stop tool ---

  pi.registerTool({
    name: "monitor_stop",
    label: "Stop Monitor",
    description: "Stop a running monitor by its ID.",
    parameters: Type.Object({
      id: Type.String({ description: "Monitor ID to stop (e.g., monitor-1)" }),
    }),
    async execute(_toolCallId, params) {
      const { id } = params as { id: string };
      const stopped = stopMonitor(id);
      if (stopped) {
        return {
          content: [{ type: "text", text: `Monitor ${id} stopped.` }],
          details: { id, stopped: true },
        };
      }
      return {
        content: [{ type: "text", text: `Monitor ${id} not found or already stopped.` }],
        details: { id, stopped: false },
        isError: true,
      };
    },
  });

  // --- List tool ---

  pi.registerTool({
    name: "monitor_list",
    label: "List Monitors",
    description: "List all running monitors.",
    parameters: Type.Object({}),
    async execute() {
      if (monitors.size === 0) {
        return {
          content: [{ type: "text", text: "No monitors running." }],
          details: { monitors: [] },
        };
      }

      const list = [...monitors.values()].map((m) => ({
        id: m.id,
        command: m.command,
        filter: m.filter?.source ?? null,
        lines: m.lineCount,
        matched: m.matchedCount,
        uptime: Math.floor((Date.now() - m.startedAt) / 1000),
      }));

      const text = list
        .map(
          (m) =>
            `- \`${m.id}\`: \`${m.command}\` — ${m.matched}/${m.lines} lines matched, up ${m.uptime}s`,
        )
        .join("\n");

      return {
        content: [{ type: "text", text }],
        details: { monitors: list },
      };
    },
  });

  // --- Commands ---

  pi.registerCommand("monitor", {
    description: "Show running monitors",
    handler: async (_args, ctx) => {
      if (monitors.size === 0) {
        ctx.ui.notify("No monitors running.", "info");
        return;
      }

      const lines = ["**Running monitors**", ""];
      for (const m of monitors.values()) {
        const uptime = Math.floor((Date.now() - m.startedAt) / 1000);
        lines.push(
          `- \`${m.id}\`: \`${m.command}\` — ${m.matchedCount}/${m.lineCount} lines, up ${uptime}s`,
        );
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // --- Session lifecycle ---

  pi.on("session_shutdown", () => {
    // Stop all monitors on session exit
    for (const id of monitors.keys()) {
      stopMonitor(id);
    }
  });
}

function stopMonitor(id: string): boolean {
  const monitor = monitors.get(id);
  if (!monitor) return false;
  monitors.delete(id);
  try {
    monitor.child.kill("SIGTERM");
  } catch {
    // already dead
  }
  return true;
}
