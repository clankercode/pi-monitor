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
