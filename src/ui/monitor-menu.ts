/**
 * Interactive TUI menu for the /monitor-list command.
 *
 * Two modes:
 *   - list (default): a `SelectList` of active monitors (newest first), with a
 *     detail pane showing the last 10 stdout lines of the selected monitor.
 *   - details: full info for the selected monitor (command, regex, label,
 *     trigger flag, started-at, uptime, full tail).
 *
 * Hotkeys (list mode):
 *   - Up/Down    : navigate the list
 *   - Enter      : switch to details mode for the selected monitor
 *   - x          : kill the selected monitor (3-option prompt)
 *   - Esc / q    : close the menu
 *
 * Hotkeys (details mode):
 *   - Enter / Esc: back to list mode
 *
 * Visual: a `BorderPanel` wraps the inner content with `╭─╮ / │ / ╰─╯` characters
 * so the menu reads as a discrete panel floating over the surrounding TUI.
 * The header shows a live wall clock + elapsed-since-open; the per-monitor
 * uptimes and the tail snapshot also refresh every second.
 */
import { getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  Key,
  matchesKey,
  SelectList,
  type SelectItem,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

const TAIL_LINES = 10;
const REFRESH_MS = 1000;

export interface MonitorMenuMonitor {
  id: string;
  command: string;
  regex: string;
  label?: string;
  triggerTurn?: boolean;
  startedAt: number;
}

export interface ShowMonitorMenuOptions {
  ctx: {
    ui: {
      custom: <T>(factory: (tui: unknown, theme: Theme, keybindings: unknown, done: (result: T) => void) => unknown) => Promise<T>;
      confirm: (title: string, message: string) => Promise<boolean>;
      /** Select dialog for the x-kill prompt with 3 options. */
      select: (title: string, options: string[]) => Promise<string | undefined>;
      notify: (message: string, type?: "info" | "warning" | "error") => void;
    };
  };
  /** Optional theme override. Defaults to the global theme's SelectList theme. */
  getSelectListTheme?: () => ReturnType<typeof getSelectListTheme>;
  /** Optional border color function for the panel frame. Defaults to pass-through. */
  getBorderColor?: (text: string) => string;
  /** Optional muted/dim color for the hint footer text. Defaults to pass-through. */
  getMutedColor?: (text: string) => string;
  /** Live source for the current monitor set — re-queried on every refresh. */
  getMonitors: () => MonitorMenuMonitor[];
  /** Tail snapshot provider — called per monitor per refresh. */
  tail: (jobID: string, stream: "stdout" | "stderr") => string[];
  getConfirmStop: () => boolean;
  /**
   * Persist `confirmStop=false` after the user picks "Don't Ask Again".
   * Should return true on success.
   */
  setConfirmStop: (value: boolean) => boolean;
  /** Called when the user confirms stopping a monitor. Should be idempotent. */
  onCancel: (jobID: string) => Promise<string> | string;
}

function formatCommand(command: string, maxLen = 60): string {
  if (command.length <= maxLen) return command;
  return `${command.slice(0, maxLen - 1)}…`;
}

function formatUptime(startedAt: number, now: number): string {
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (elapsed < 60) return `${elapsed}s`;
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m${(elapsed % 60).toString().padStart(2, "0")}s`;
  return `${Math.floor(elapsed / 3600)}h${Math.floor((elapsed % 3600) / 60).toString().padStart(2, "0")}m`;
}

function formatClock(ts: number): string {
  const d = new Date(ts);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m${(total % 60).toString().padStart(2, "0")}s`;
  return `${Math.floor(total / 3600)}h${Math.floor((total % 3600) / 60).toString().padStart(2, "0")}m`;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString();
}

function buildSelectItems(monitors: MonitorMenuMonitor[], now: number): SelectItem[] {
  // Newest first.
  const sorted = [...monitors].sort((a, b) => b.startedAt - a.startedAt);
  return sorted.map((m) => {
    const flags: string[] = [];
    if (m.label) flags.push(`[${m.label}]`);
    if (m.regex && m.regex !== ".*") flags.push(`/${m.regex}/`);
    if (m.triggerTurn) flags.push("trigger");
    flags.push(formatUptime(m.startedAt, now));
    return { value: m.id, label: m.id, description: flags.join(" · ") || formatCommand(m.command) };
  });
}

/* ------------------------------------------------------------------ */
/* BorderPanel — draws ╭─╮ / │ │ / ╰─╯ around an inner Component     */
/* ------------------------------------------------------------------ */

class BorderPanel implements Component {
  constructor(
    private inner: Component,
    private borderColor: (text: string) => string = (t) => t,
  ) {}

  invalidate(): void {
    this.inner.invalidate();
  }

  render(width: number): string[] {
    if (width < 4) return [];
    const innerWidth = width - 4; // "│ " + " │"
    const lines = this.inner.render(innerWidth);
    // Pad each line to innerWidth visible columns so the right border aligns.
    const padded = lines.map((line) => truncateToWidth(line, innerWidth, "", true));
    const top = this.borderColor("╭" + "─".repeat(width - 2) + "╮");
    const bottom = this.borderColor("╰" + "─".repeat(width - 2) + "╯");
    const middle = padded.map((line) => this.borderColor("│ ") + line + this.borderColor(" │"));
    return [top, ...middle, bottom];
  }
}

function visibleLineCount(component: Component, width: number): number {
  // Strip ANSI for height measurement.
  const ansi = /\x1b\[[0-9;]*m/g;
  const lines = component.render(width);
  let h = 0;
  for (const line of lines) h += Math.max(1, Math.ceil(visibleWidth(line.replace(ansi, "")) / Math.max(1, width)));
  return h;
}

/* ------------------------------------------------------------------ */
/* Main menu                                                          */
/* ------------------------------------------------------------------ */

/**
 * Open the monitor-list menu overlay and resolve when the user closes it.
 */
export async function showMonitorMenu(opts: ShowMonitorMenuOptions): Promise<void> {
  // TODO: merge stdout + stderr into a single chronological log.
  // ProcessRunner exposes per-stream `tail(jobID, stream)` but no interleaved
  // view — would need ProcessRunner to track per-line timestamps, or to
  // expose a `getMergedTail(jobID)` method. Defer to v2.

  await opts.ctx.ui.custom<void>((_tui, _theme, _keybindings, done) => {
    const initialMonitors = opts.getMonitors();
    const menuOpenedAt = Date.now();
    const themeFn = opts.getSelectListTheme ?? getSelectListTheme;
    const borderColor = opts.getBorderColor ?? ((t: string) => t);
    const mutedColor = opts.getMutedColor ?? ((t: string) => t);

    if (initialMonitors.length === 0) {
      const container = new Container();
      container.addChild(new Text("Monitor List (0 running)", 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(new Text("No monitors running.", 0, 0));
      queueMicrotask(() => done(undefined));
      return new BorderPanel(container) as unknown as Component;
    }

    let monitors: MonitorMenuMonitor[] = initialMonitors;
    let tails = new Map<string, string[]>();
    for (const m of initialMonitors) {
      tails.set(m.id, opts.tail(m.id, "stdout"));
    }

    const items = buildSelectItems(monitors, Date.now());
    let list = new SelectList(items, Math.min(items.length, 8), themeFn());

    // Internal mode state.
    let mode: "list" | "details" = "list";

    function rebuildList(): void {
      // SelectList doesn't expose setItems, so on every refresh we
      // construct a new instance. The new list starts at index 0, which
      // is fine for a sorted-by-newest list.
      const newItems = buildSelectItems(monitors, Date.now());
      list = new SelectList(newItems, Math.min(newItems.length, 8), themeFn());
    }

    function refresh(): void {
      monitors = opts.getMonitors();
      tails = new Map<string, string[]>();
      for (const m of monitors) {
        tails.set(m.id, opts.tail(m.id, "stdout"));
      }
      rebuildList();
    }

    function buildListMode(now: number): Container {
      const elapsed = now - menuOpenedAt;
      const selected = list.getSelectedItem();
      const selectedMonitor = selected
        ? monitors.find((m) => m.id === selected.value)
        : undefined;
      const lines = selectedMonitor ? (tails.get(selectedMonitor.id) ?? []) : [];
      const last = lines.slice(-TAIL_LINES);

      const c = new Container();
      const title = `Monitor List · ${monitors.length} running`;
      const right = `${formatElapsed(elapsed)} · ${formatClock(now)}`;
      c.addChild(new Text(`${title}${" ".repeat(Math.max(1, 60 - title.length))}${right}`, 0, 0));
      c.addChild(new Spacer(1));
      c.addChild(list);
      c.addChild(new Spacer(1));
      c.addChild(new Text("─".repeat(60), 0, 0));
      const detailHeader = selectedMonitor
        ? `── ${selectedMonitor.id} · last ${TAIL_LINES} lines · ${formatUptime(selectedMonitor.startedAt, now)} ──`
        : "── select a monitor ──";
      c.addChild(new Text(detailHeader, 0, 0));
      if (last.length === 0) {
        c.addChild(new Text("  (no output yet)", 0, 0));
      } else {
        for (const line of last) {
          c.addChild(new Text(`  ${line}`, 0, 0));
        }
      }
      c.addChild(new Spacer(1));
      const hint = mutedColor("↑↓: navigate  ·  →/Enter: details  ·  ←/Esc/q: close  ·  x: kill  ·  (newest first)");
      c.addChild(new Text(hint, 0, 0));
      return c;
    }

    function buildDetailsMode(now: number): Container {
      const selected = list.getSelectedItem();
      const m = selected ? monitors.find((mm) => mm.id === selected.value) : undefined;
      const c = new Container();
      const header = m ? `Details · ${m.id}` : "Details · (no selection)";
      const right = `${formatClock(now)}`;
      c.addChild(new Text(`${header}${" ".repeat(Math.max(1, 60 - header.length))}${right}`, 0, 0));
      c.addChild(new Spacer(1));
      c.addChild(new Text("─".repeat(60), 0, 0));

      if (!m) {
        c.addChild(new Text("  (no monitor selected)", 0, 0));
      } else {
        const lines: Array<[string, string]> = [
          ["ID", m.id],
          ["Command", m.command],
          ["Regex", m.regex || ".*"],
          ["Label", m.label ?? "(none)"],
          ["Trigger", m.triggerTurn ? "yes (wakes LLM)" : "no"],
          ["Started", `${formatTimestamp(m.startedAt)} (${formatUptime(m.startedAt, now)} ago)`],
        ];
        for (const [k, v] of lines) {
          c.addChild(new Text(`  ${k.padEnd(10)} ${v}`, 0, 0));
        }

        c.addChild(new Spacer(1));
        c.addChild(new Text("─".repeat(60), 0, 0));
        c.addChild(new Text(`Tail (last ${TAIL_LINES} lines):`, 0, 0));
        const tail = (tails.get(m.id) ?? []).slice(-TAIL_LINES);
        if (tail.length === 0) {
          c.addChild(new Text("  (no output yet)", 0, 0));
        } else {
          for (const line of tail) {
            c.addChild(new Text(`  ${line}`, 0, 0));
          }
        }
      }

      c.addChild(new Spacer(1));
      c.addChild(new Text(mutedColor("←/Esc/Enter: back to list  ·  x: kill"), 0, 0));
      return c;
    }

    function buildContainer(): Component {
      const now = Date.now();
      const inner = mode === "list" ? buildListMode(now) : buildDetailsMode(now);
      return new BorderPanel(inner, borderColor);
    }

    let container: Component = buildContainer();

    const refreshTimer = setInterval(() => {
      refresh();
      container = buildContainer();
    }, REFRESH_MS);

    // Close the menu cleanly: clear the refresh timer, release the
    // custom() promise, and let the dispose callback do any extra work.
    // After this runs the input box is fully restored to the user.
    let closed = false;
    function closeMenu(): void {
      if (closed) return;
      closed = true;
      clearInterval(refreshTimer);
      done(undefined);
    }

    async function killSelected(): Promise<void> {
      const selected = list.getSelectedItem();
      if (!selected) return;
      const jobID = selected.value;

      let choice: string | undefined;
      if (opts.getConfirmStop()) {
        // 3-option prompt. "No" is the default (first option).
        choice = await opts.ctx.ui.select(`Stop ${jobID}?`, ["No", "Yes", "Don't Ask Again"]);
      } else {
        // Confirmation is disabled; treat as immediate "Yes".
        choice = "Yes";
      }

      if (choice === "Yes" || choice === "Don't Ask Again") {
        if (choice === "Don't Ask Again") {
          const ok = opts.setConfirmStop(false);
          if (!ok) {
            opts.ctx.ui.notify("Failed to persist confirmStop=false; killed this time only.", "warning");
          }
        }
        try {
          const msg = await opts.onCancel(jobID);
          opts.ctx.ui.notify(String(msg), "info");
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          opts.ctx.ui.notify(`failed to stop ${jobID}: ${reason}`, "error");
        }
        refresh();
        // If the kill drained the monitor list, close the menu so the user
        // gets back to the input box immediately. Leaving the menu open
        // with a stale "0 running" state has caused input-box issues in
        // the past (the custom() promise stays pending, the setInterval
        // keeps ticking, the input doesn't accept Enter).
        if (monitors.length === 0) {
          closeMenu();
          return;
        }
        container = buildContainer();
      }
      // "No" or Esc (undefined) → do nothing.
    }

    function goBack(): void {
      if (mode === "details") {
        mode = "list";
        container = buildContainer();
        return;
      }
      closeMenu();
    }

    function goForward(): void {
      if (mode === "list") {
        mode = "details";
        container = buildContainer();
        return;
      }
      // details mode: Enter/Right goes back to list
      mode = "list";
      container = buildContainer();
    }

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        // Drop any input that arrives after the menu has closed — pi-tui
        // may flush buffered keys during teardown, and we don't want them
        // leaking to the input box.
        if (closed) return;
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
          goBack();
          return;
        }
        if (matchesKey(data, "q") && mode === "list") {
          closeMenu();
          return;
        }
        if (matchesKey(data, "x")) {
          void killSelected();
          return;
        }
        if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
          goForward();
          return;
        }
        list.handleInput(data);
      },
      dispose: () => {
        clearInterval(refreshTimer);
        closed = true;
      },
    } as unknown as Component;
  });
}

// `visibleLineCount` is a helper we might want for tests later; keep exported
// (re-export via type-only import) — actually nothing imports it, so just
// mark unused to satisfy the linter.
void visibleLineCount;
