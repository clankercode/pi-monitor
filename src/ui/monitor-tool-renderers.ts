/**
 * Tool call and result renderers for pi-monitor tools.
 *
 * These functions are consumed by the tool definitions in extensions/pi-monitor.ts.
 * The extension imports ToolRenderContext and AgentToolResult from
 * @earendil-works/pi-coding-agent and passes them through at the call site.
 */
import { Container, Text, Spacer } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

/** Re-export for use by the extension */
export type { PiMonitorMessageDetails } from "./compact-monitor-message.ts";

// ── detail types (also consumed by the extension for tool execute return) ──────

export interface MonitorDetails {
  command: string;
  regex: string;
  before: number;
  after: number;
  debounceSeconds: number;
  label?: string;
  triggerTurn?: boolean;
}

export interface MonitorStopDetails {
  id: string;
}

export interface ActiveMonitorInfo {
  id: string;
  command: string;
  regex: string;
  label?: string;
  triggerTurn?: boolean;
  uptimeSec: number;
}

export interface MonitorListDetails {
  monitors: ActiveMonitorInfo[];
}

// ── Monitor tool: call renderer ───────────────────────────────────────────────

const INDENT_DIAMOND = " ";
const INDENT_CHILD = "   ";

/**
 * One-line preview shown while the Monitor tool is executing.
 *  ◈ monitor · label · command
 */
export function renderMonitorCall(args: MonitorDetails, theme: Theme): Component {
  const { command, label } = args;
  const parts: string[] = [INDENT_DIAMOND, theme.fg("accent", "◈ monitor")];
  if (label) parts.push(theme.fg("text", ` · ${label}`));
  parts.push(theme.fg("borderMuted", " · "));
  parts.push(theme.fg("muted", command));

  return new Text(parts.join(""), 0, 0);
}

// ── Monitor tool: result renderer ──────────────────────────────────────────────

/**
 * Result shown when a monitor starts successfully.
 *
 *   ◈ monitor started · label
 *      /regex/
 *      ctx: ±N
 *      debounce: Ns
 *      trigger
 */
export function renderMonitorResult(
  details: MonitorDetails,
  isError: boolean,
  isPartial: boolean,
  theme: Theme,
): Component {
  if (isError || !details.command) {
    return new Text(theme.fg("error", "Monitor error"), 0, 0);
  }

  const { regex, before, after, debounceSeconds, label } = details;

  const container = new Container();

  // Header: ◈ monitor started · label (indented 1 space)
  const header = new Text(
    INDENT_DIAMOND +
      (label
        ? theme.fg("accent", "◈ monitor") + theme.fg("success", " started") + theme.fg("borderMuted", " · ") + theme.fg("text", label)
        : theme.fg("accent", "◈ monitor") + theme.fg("success", " started")),
    0, 0,
  );
  container.addChild(header);

  // Metadata: each on its own line, indented 3 spaces, directly under the parent
  if (!isPartial) {
    const metaItems: string[] = [];
    if (regex !== undefined && regex !== ".*") metaItems.push(`/${regex}/`);
    if (before !== undefined && after !== undefined && (before !== 0 || after !== 0)) {
      metaItems.push(`ctx: ±${before === after ? before : `${before}/${after}`}`);
    }
    if (debounceSeconds !== undefined && debounceSeconds !== 0) metaItems.push(`debounce: ${debounceSeconds}s`);
    if (details.triggerTurn) metaItems.push("trigger");

    for (const item of metaItems) {
      container.addChild(new Text(INDENT_CHILD + theme.fg("borderMuted", item), 0, 0));
    }
  }

  return container;
}

// ── MonitorStop tool: result renderer ────────────────────────────────────────

/**
 * Result shown when a monitor is stopped.
 *
 * ◈ monitor stopped · mon_X
 */
export function renderMonitorStopResult(
  details: MonitorStopDetails,
  isError: boolean,
  theme: Theme,
): Component {
  if (isError || !details.id) {
    return new Text(theme.fg("error", "MonitorStop error"), 0, 0);
  }

  const { id } = details;
  const line =
    INDENT_DIAMOND +
    theme.fg("accent", "◈ monitor") +
    theme.fg("warning", " stopped") +
    theme.fg("borderMuted", " · ") +
    theme.fg("text", id);

  return new Text(line, 0, 0);
}

// ── MonitorList tool: call + result renderers ────────────────────────────────

/**
 * One-line preview shown while the MonitorList tool is executing.
 *  ◈ monitor list
 */
export function renderMonitorListCall(theme: Theme): Component {
  const line =
    INDENT_DIAMOND +
    theme.fg("accent", "◈ monitor") +
    theme.fg("borderMuted", " · ") +
    theme.fg("text", "list");
  return new Text(line, 0, 0);
}

/**
 * Result shown for the MonitorList tool.
 *
 *   ◈ monitor list (N running)
 *      mon_1  `command`  meta...  uptime
 *      mon_2  `command`
 *      mon_3  `command`  /regex/  [label]  uptime
 *
 * Empty case:
 *   ◈ monitor list
 *      no monitors running
 */
export function renderMonitorListResult(
  details: MonitorListDetails,
  isError: boolean,
  theme: Theme,
): Component {
  if (isError) {
    return new Text(theme.fg("error", "MonitorList error"), 0, 0);
  }

  const monitors = details.monitors ?? [];
  const container = new Container();

  // Header: ◈ monitor list (N running) or ◈ monitor list when empty
  const header = new Text(
    INDENT_DIAMOND +
      theme.fg("accent", "◈ monitor") +
      theme.fg("borderMuted", " · ") +
      theme.fg("text", "list") +
      (monitors.length > 0
        ? theme.fg("muted", ` (${monitors.length} running)`)
        : ""),
    0, 0,
  );
  container.addChild(header);

  if (monitors.length === 0) {
    container.addChild(new Text(
      INDENT_CHILD + theme.fg("muted", "no monitors running"),
      0, 0,
    ));
    return container;
  }

  // One line per monitor, indented 3 spaces
  for (const m of monitors) {
    const parts: string[] = [
      theme.fg("text", m.id),
      theme.fg("muted", ` \`${m.command}\``),
    ];
    if (m.regex !== undefined && m.regex !== ".*") {
      parts.push(theme.fg("borderMuted", ` /${m.regex}/`));
    }
    if (m.triggerTurn) {
      parts.push(theme.fg("borderMuted", " trigger"));
    }
    if (m.label) {
      parts.push(theme.fg("borderMuted", ` [${m.label}]`));
    }
    parts.push(theme.fg("dim", ` ${formatUptime(m.uptimeSec)}`));

    container.addChild(new Text(INDENT_CHILD + parts.join(""), 0, 0));
  }

  return container;
}

// ── helpers ──────────────────────────────────────────────────────────────────

export function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}
