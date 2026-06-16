/**
 * Interactive TUI menu for the /monitor-list command.
 *
 * Patterned after pi-subagents' settings menu: a `SelectList` of active monitors
 * on top, a detail pane (last few log lines) below, and footer keybinding hints.
 * Live-refreshes the tail snapshot every second so a long-running build/test
 * monitor shows fresh output without the user having to close and reopen.
 *
 * Visual design: the entire menu is wrapped in a `Box` with padding and a
 * horizontal-rule frame, so it reads as a separate "panel" floating over the
 * underlying TUI. A live-updating elapsed-time counter and wall-clock make the
 * 1s refresh rate obvious to the user.
 */
import { getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Box,
  type Component,
  Container,
  Key,
  matchesKey,
  SelectList,
  type SelectItem,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";

const TAIL_LINES = 10;
const REFRESH_MS = 1000;
const PAD_X = 2;
const PAD_Y = 1;

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
      notify: (message: string, type?: "info" | "warning" | "error") => void;
    };
  };
  /** Optional theme override. Defaults to the global theme's SelectList theme. */
  getSelectListTheme?: () => ReturnType<typeof getSelectListTheme>;
  /** Optional Theme for the panel frame. Falls back to passing through plain text. */
  getTheme?: () => Theme;
  /** Live source for the current monitor set — re-queried on every refresh. */
  getMonitors: () => MonitorMenuMonitor[];
  /** Tail snapshot provider — called per monitor per refresh. */
  tail: (jobID: string, stream: "stdout" | "stderr") => string[];
  getConfirmStop: () => boolean;
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

/**
 * Open the monitor-list menu overlay and resolve when the user closes it.
 *
 * Hotkeys:
 *   - Up/Down    : navigate the monitor list (delegated to SelectList)
 *   - Enter / s  : stop the selected monitor (with confirm if `getConfirmStop` returns true)
 *   - x          : stop the selected monitor (skip confirm — kill semantics)
 *   - Esc / q    : close the menu
 */
export async function showMonitorMenu(opts: ShowMonitorMenuOptions): Promise<void> {
  // TODO: merge stdout + stderr into a single chronological log.
  // ProcessRunner exposes per-stream `tail(jobID, stream)` but no interleaved
  // view — would need ProcessRunner to track per-line timestamps, or to
  // expose a `getMergedTail(jobID)` method. Defer to v2.

  await opts.ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
    const initialMonitors = opts.getMonitors();
    const menuOpenedAt = Date.now();
    const themeFn = opts.getSelectListTheme ?? getSelectListTheme;
    const panelTheme = opts.getTheme;

    if (initialMonitors.length === 0) {
      // Defensive empty state.
      const container = new Container();
      container.addChild(new Text("Monitor List (0 running)", 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(new Text("No monitors running.", 0, 0));
      queueMicrotask(() => done(undefined));
      return wrapInPanel(container, theme, panelTheme) as unknown as Component;
    }

    let monitors: MonitorMenuMonitor[] = initialMonitors;
    let tails = new Map<string, string[]>();
    for (const m of initialMonitors) {
      tails.set(m.id, opts.tail(m.id, "stdout"));
    }

    const items = buildSelectItems(monitors, Date.now());
    const list = new SelectList(items, Math.min(items.length, 8), themeFn());

    function clampSelection(): void {
      const selected = list.getSelectedItem();
      if (selected && !monitors.some((m) => m.id === selected.value)) {
        list.setSelectedIndex(0);
      }
    }

    function refresh(): void {
      monitors = opts.getMonitors();
      tails = new Map<string, string[]>();
      for (const m of monitors) {
        tails.set(m.id, opts.tail(m.id, "stdout"));
      }
      clampSelection();
    }

    function buildContainer(): Container {
      const now = Date.now();
      const elapsed = now - menuOpenedAt;
      const selected = list.getSelectedItem();
      const selectedMonitor = selected
        ? monitors.find((m) => m.id === selected.value)
        : undefined;
      const lines = selectedMonitor ? (tails.get(selectedMonitor.id) ?? []) : [];
      const last = lines.slice(-TAIL_LINES);

      const c = new Container();

      // Header bar: title left, live elapsed + clock right
      const title = `Monitor List · ${monitors.length} running`;
      const right = `${formatElapsed(elapsed)} · ${formatClock(now)}`;
      c.addChild(new Text(`${title}                                          ${right}`.trimEnd(), 0, 0));
      c.addChild(new Text("─".repeat(80), 0, 0));
      c.addChild(new Spacer(1));

      // Monitor list
      c.addChild(list);

      c.addChild(new Spacer(1));
      c.addChild(new Text("─".repeat(80), 0, 0));

      // Detail pane: selected monitor's last 10 lines
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
      c.addChild(new Text("─".repeat(80), 0, 0));

      // Footer bar: keyboard hints
      const hint = opts.getConfirmStop()
        ? "Enter/s: stop (confirm)  ·  x: kill  ·  Esc/q: close  ·  (newest first)"
        : "Enter/s: stop  ·  x: kill  ·  Esc/q: close  ·  (newest first)";
      c.addChild(new Text(hint, 0, 0));

      return c;
    }

    let container: Component = wrapInPanel(buildContainer(), theme, panelTheme);

    const refreshTimer = setInterval(() => {
      refresh();
      container = wrapInPanel(buildContainer(), theme, panelTheme);
    }, REFRESH_MS);

    async function stopSelected(skipConfirm: boolean): Promise<void> {
      const selected = list.getSelectedItem();
      if (!selected) return;
      const jobID = selected.value;
      if (!skipConfirm && opts.getConfirmStop()) {
        const ok = await opts.ctx.ui.confirm(
          `Stop ${jobID}?`,
          `This will terminate the background process for monitor ${jobID}.`,
        );
        if (!ok) return;
      }
      try {
        const msg = await opts.onCancel(jobID);
        opts.ctx.ui.notify(String(msg), "info");
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        opts.ctx.ui.notify(`failed to stop ${jobID}: ${reason}`, "error");
      }
      refresh();
      container = wrapInPanel(buildContainer(), theme, panelTheme);
    }

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
          clearInterval(refreshTimer);
          done(undefined);
          return;
        }
        if (matchesKey(data, "x")) {
          void stopSelected(true);
          return;
        }
        if (matchesKey(data, Key.enter) || matchesKey(data, "s")) {
          void stopSelected(false);
          return;
        }
        list.handleInput(data);
      },
      dispose: () => {
        clearInterval(refreshTimer);
      },
    } as unknown as Component;
  });
}

/**
 * Wrap an inner Container in a Box that gives the menu a clear visual
 * boundary against the surrounding TUI. The Box applies horizontal padding
 * so the panel content is inset from the panel border, and an optional
 * background function tints the panel area.
 *
 * If a panelTheme is provided, we use `theme.bg("customMessageBg", text)` to
 * give the panel a subtle background. Otherwise we fall back to passing text
 * through unchanged so the menu still works in print/RPC modes.
 */
function wrapInPanel(inner: Container, _theme: Theme, panelTheme?: () => Theme): Component {
  const bgFn = panelTheme ? (t: string) => panelTheme().bg("customMessageBg", t) : undefined;
  const box = new Box(PAD_X, PAD_Y, bgFn);
  box.addChild(inner);
  return box;
}
