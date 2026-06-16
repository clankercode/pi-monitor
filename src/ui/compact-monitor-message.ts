/**
 * Compact TUI message renderer for pi-monitor deliveries.
 *
 * Renders monitor windows as a single line when collapsed, expanding to the
 * full window content on demand. Designed to stay out of the way in busy
 * sessions while remaining scannable.
 */
import type { Component } from "@earendil-works/pi-tui";
import { Container, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

export interface PiMonitorMessageDetails {
  jobID: string;
  command: string;
  regex: string;
  label?: string;
  matchCount: number;
  lineCount: number;
  truncated: boolean;
}

const ICON = "◈";
const KIND = "monitor";

/**
 * Build the compact single-line representation for a monitor window.
 *
 * The line is aggressively truncated so it never exceeds `width` display
 * columns, even after theme ANSI codes are applied.
 */
interface MonitorMessageLike<T> {
  content: string | unknown[];
  details?: T;
}

export function buildCompactLine(
  message: MonitorMessageLike<PiMonitorMessageDetails>,
  theme: Theme,
  width: number,
): string {
  const details = message.details;
  const content = typeof message.content === "string" ? message.content : "";

  const label = details?.label ?? details?.jobID ?? KIND;
  const matchCount = details?.matchCount ?? 1;
  const truncated = details?.truncated ?? false;

  // Pick the first non-empty line as the snippet.
  const firstLine = content
    .split("\n")
    .map((l: string) => l.trim())
    .find((l: string) => l.length > 0) ?? "";

  // Collapse whitespace in the snippet so it doesn't blow out the line.
  const snippet = firstLine.replace(/\s+/g, " ").trim();

  const parts: string[] = [];

  // Prefix: 1-space indent + icon + kind + label
  parts.push(" " + theme.fg("accent", `${ICON} ${KIND}`) + theme.fg("text", ` · ${label}`));

  // Match count when there are multiple matches.
  if (matchCount > 1) {
    parts.push(theme.fg("muted", `+${matchCount} matches`));
  }

  // Truncation indicator.
  if (truncated) {
    parts.push(theme.fg("warning", "truncated"));
  }

  // Content snippet.
  if (snippet.length > 0) {
    parts.push(theme.fg("dim", snippet));
  }

  const line = parts.join(theme.fg("borderMuted", " · "));
  return truncateToWidth(line, width);
}

/**
 * Build the expanded multi-line view for a monitor window.
 */
export function buildExpandedComponent(
  message: MonitorMessageLike<PiMonitorMessageDetails>,
  theme: Theme,
): Component {
  const details = message.details;
  const content = typeof message.content === "string" ? message.content : "";

  const label = details?.label ?? details?.jobID ?? KIND;
  const meta: string[] = [];
  if (details?.command) meta.push(details.command);
  if (details?.regex && details.regex !== ".*") meta.push(`/${details.regex}/`);
  if (details?.truncated) meta.push("truncated");

  const header = `${ICON} ${KIND} · ${label}` + (meta.length > 0 ? ` · ${theme.fg("muted", meta.join(" · "))}` : "");

  const container = new Container();
  container.addChild(new Text(theme.fg("accent", header), 1, 0));
  container.addChild(new Spacer(1));

  // Render the raw window content with default text color so newlines are preserved.
  container.addChild(new Text(theme.fg("toolOutput", content), 1, 0));

  return container;
}

/**
 * Component implementation that renders a monitor window either compactly or
 * expanded depending on the `expanded` flag.
 */
export class CompactMonitorMessage implements Component {
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private readonly message: MonitorMessageLike<PiMonitorMessageDetails>,
    private readonly expanded: boolean,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    if (this.expanded) {
      this.cachedLines = buildExpandedComponent(this.message, this.theme).render(width);
    } else {
      this.cachedLines = [buildCompactLine(this.message, this.theme, width)];
    }

    this.cachedWidth = width;
    return this.cachedLines;
  }

  handleInput(_data: string): void {
    // No interactive input on the collapsed message.
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

/**
 * Register the compact pi-monitor message renderer on an ExtensionAPI.
 */
export function registerCompactMonitorRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<PiMonitorMessageDetails>("pi-monitor", (message, { expanded }, theme) => {
    return new CompactMonitorMessage(message, expanded, theme);
  });
}
