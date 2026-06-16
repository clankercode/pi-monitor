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

/**
 * One-line preview shown while the Monitor tool is executing.
 * ◈ monitor · label · command
 */
export function renderMonitorCall(args: MonitorDetails, theme: Theme): Component {
  const { command, label } = args;
  const parts: string[] = [theme.fg("accent", "◈ monitor")];
  if (label) parts.push(theme.fg("text", ` · ${label}`));
  parts.push(theme.fg("borderMuted", " · "));
  parts.push(theme.fg("muted", command));

  return new Text(parts.join(""), 0, 0);
}

// ── Monitor tool: result renderer ──────────────────────────────────────────────

/**
 * Result shown when a monitor starts successfully.
 *
 * Collapsed:  ◈ monitor started · label
 * Expanded:   ◈ monitor started · label
 *             command
 *             /regex/ · ctx: ±N · debounce: Ns · trigger
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

  const { command, regex, before, after, debounceSeconds, label } = details;

  const container = new Container();

  // Header: ◈ monitor started · label
  const header = new Text(
    (label
      ? theme.fg("accent", "◈ monitor") + theme.fg("success", " started") + theme.fg("borderMuted", " · ") + theme.fg("text", label)
      : theme.fg("accent", "◈ monitor") + theme.fg("success", " started")),
    0, 0,
  );
  container.addChild(header);

  // Expanded: show command + metadata
  if (!isPartial) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", command), 0, 0));

    const meta: string[] = [];
    if (regex !== undefined && regex !== ".*") meta.push(`/${regex}/`);
    if (before !== undefined && after !== undefined && (before !== 0 || after !== 0)) {
      meta.push(`ctx: ±${before === after ? before : `${before}/${after}`}`);
    }
    if (debounceSeconds !== undefined && debounceSeconds !== 0) meta.push(`debounce: ${debounceSeconds}s`);
    if (details.triggerTurn) meta.push("trigger");

    if (meta.length > 0) {
      container.addChild(new Text(theme.fg("borderMuted", meta.join(" · ")), 0, 0));
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
    theme.fg("accent", "◈ monitor") +
    theme.fg("warning", " stopped") +
    theme.fg("borderMuted", " · ") +
    theme.fg("text", id);

  return new Text(line, 0, 0);
}
