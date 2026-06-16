/**
 * Interactive TUI menu for the /monitor-list command.
 *
 * Patterned after pi-subagents' settings menu: a `SelectList` of active monitors
 * on top, a detail pane (last few log lines) below, and footer keybinding hints.
 * Live-refreshes the tail snapshot every second so a long-running build/test
 * monitor shows fresh output without the user having to close and reopen.
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
      notify: (message: string, type?: "info" | "warning" | "error") => void;
    };
  };
  /** Optional theme override. Defaults to the global theme's SelectList theme. */
  getSelectListTheme?: () => ReturnType<typeof getSelectListTheme>;
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

  await opts.ctx.ui.custom<void>((_tui, _theme, _keybindings, done) => {
    const initialMonitors = opts.getMonitors();
    if (initialMonitors.length === 0) {
      // Defensive: the command handler should already have notify'd and returned
      // when the list is empty, but render an empty state in case a caller
      // forgets that check.
      const container = new Container();
      container.addChild(new Text("Monitor List (0 running)", 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(new Text("No monitors running.", 0, 0));
      // Defer close so the overlay has a chance to mount.
      queueMicrotask(() => done(undefined));
      return container as unknown as Component;
    }

    // Build initial state.
    let monitors: MonitorMenuMonitor[] = initialMonitors;
    let tails = new Map<string, string[]>();
    for (const m of initialMonitors) {
      tails.set(m.id, opts.tail(m.id, "stdout"));
    }

    const items = buildSelectItems(monitors, Date.now());
    const themeFn = opts.getSelectListTheme ?? getSelectListTheme;
    const list = new SelectList(items, Math.min(items.length, 8), themeFn());

    function rebuild(): void {
      // If the previously selected monitor was removed, clamp to index 0.
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
      rebuild();
    }

    function buildContainer(currentContainer: Container): void {
      // The SelectList component handles its own selection/render — we just
      // surround it with title, detail, and footer text. The detail is read
      // from the SelectList's current selection.
      const selected = list.getSelectedItem();
      const selectedMonitor = selected
        ? monitors.find((m) => m.id === selected.value)
        : undefined;
      const detailHeader = selectedMonitor
        ? `── ${selectedMonitor.id} last ${TAIL_LINES} lines ──`
        : "── select a monitor ──";
      const lines = selectedMonitor ? (tails.get(selectedMonitor.id) ?? []) : [];
      const last = lines.slice(-TAIL_LINES);

      // Build a fresh container each refresh so list+detail stay in sync.
      // pi-tui's Container doesn't expose a swap-children API, so we
      // rebuild the whole tree on each tick. This is cheap (8 monitors,
      // 10 tail lines) but could be optimized if needed.
      // To avoid leaking children, we don't mutate `currentContainer` —
      // we re-render from scratch via the outer `container` reference
      // (set after first build).
      const fresh = new Container();
      fresh.addChild(new Text(`Monitor List (${monitors.length} running)`, 0, 0));
      fresh.addChild(new Spacer(1));
      fresh.addChild(list);
      fresh.addChild(new Spacer(1));
      fresh.addChild(new Text(detailHeader, 0, 0));
      if (last.length === 0) {
        fresh.addChild(new Text("  (no output yet)", 0, 0));
      } else {
        for (const line of last) {
          fresh.addChild(new Text(`  ${line}`, 0, 0));
        }
      }
      fresh.addChild(new Spacer(1));
      const hint = opts.getConfirmStop()
        ? "Enter/s: stop (confirm)  ·  x: kill  ·  Esc/q: close  ·  (newest first)"
        : "Enter/s: stop  ·  x: kill  ·  Esc/q: close  ·  (newest first)";
      fresh.addChild(new Text(hint, 0, 0));

      // Mutate the original container's children via the public API.
      // Container in pi-tui has no removeChild, so we just hand `fresh`
      // back to the closure-scope `container` variable that `render()` reads.
      // TypeScript-wise we keep `currentContainer` as a placeholder so the
      // function signature matches.
      void currentContainer;
      container = fresh;
    }

    // Closure-scope reference that render() reads; replaced on each rebuild.
    let container: Container = new Container();
    buildContainer(container);

    const refreshTimer = setInterval(() => {
      refresh();
      buildContainer(container);
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
      // Refresh immediately so the just-stopped monitor disappears from the list.
      refresh();
      buildContainer(container);
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
        // Everything else: forward to the SelectList (arrow keys, page up/down, etc.)
        list.handleInput(data);
      },
      dispose: () => {
        clearInterval(refreshTimer);
      },
    } as unknown as Component;
  });
}
