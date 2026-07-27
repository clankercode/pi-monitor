# @clanker-code/pi-monitor

GitHub: [`clankercode/pi-monitor`](https://github.com/clankercode/pi-monitor) · npm: [`@clanker-code/pi-monitor`](https://www.npmjs.com/package/@clanker-code/pi-monitor)

A [pi](https://pi.dev) extension that watches background processes and delivers **regex-matching stdout windows** (with before/after context) into the agent session.

This is a **partial pseudo-fork** of [`pi-monitor-plugin`](https://github.com/Shodocan/pi-monitor-plugin) by [Walisson Casonatto (Shodocan)](https://github.com/Shodocan). Upstream planned a broader jobs surface (background / monitor / loop / schedule). We ported the **monitor** tool and its core infrastructure, then rebuilt delivery, TUI, and agent integration for our direction. Upstream changes are reviewed when useful; we do not merge blindly.

> **Status:** Working monitor-only extension. Not a drop-in replacement for the full planned upstream jobs suite.

## Features

- **Regex matching** — only forward lines that match a pattern (default: match everything)
- **Before/after context** — deliver surrounding lines with each match
- **Debouncing** — batch nearby matches into a single delivery
- **`triggerTurn` (default on)** — wake/steer the assistant when matching output arrives; set `false` for display-only logging
- **ReDoS protection** — vet regex patterns before execution
- **Nonce-fencing** — untrusted output is fenced with cryptographic nonces
- **XML envelope** — delivered windows wrapped for LLM context (`id` + `at`)
- **Secret redaction** — best-effort scrubbing of tokens, keys, passwords
- **ANSI stripping** — remove terminal escape sequences from output
- **Idle/busy routing** — deliver immediately if idle; queue/invalidate safely across session lifecycle
- **Same-turn batching** — group monitor deliveries that fire together
- **Interactive `/monitor-list` TUI** — live tail, stop with confirm, keyboard nav
- **AI-callable tools** — `Monitor`, `MonitorStop`, `MonitorList`

## Fork divergences

This package intentionally diverges from upstream. Keep this table honest on every release.

| Feature | Status | Notes |
|---------|--------|-------|
| Package identity | ✅ shipped | Published as `@clanker-code/pi-monitor` on npm; repo `clankercode/pi-monitor`. |
| Monitor-only scope | ✅ shipped | Ported ProcessRunner, MonitorEngine, ReDoS protection, nonce-fencing, secret redaction, ANSI stripping. **Dropped** planned `/background`, `/loop`, `/schedule`, and multi-job “jobs” suite. |
| Working implementation | ✅ shipped | Upstream README describes a planning/scaffold jobs package; this repo is a usable monitor extension. |
| AI tools: stop + list | ✅ shipped | `MonitorStop` and `MonitorList` are first-class tools (not only slash commands). |
| `triggerTurn` + steer delivery | ✅ shipped | Default `true`: matching output is delivered as `deliverAs: "steer"` with `triggerTurn: true` so the agent reacts. Set `false` for log-only. |
| Same-turn delivery batching | ✅ shipped | Nearby/same-turn matches coalesce via `MonitorDeliveryBatcher`; invalidated on session shutdown so stale deliveries never fire. |
| XML envelope for LLM context | ✅ shipped | Deliveries use a minimal `<pi-monitor id="…" at="…">` envelope; TUI renderers strip it for humans. |
| Compact custom tool renderers | ✅ shipped | `Monitor` / `MonitorStop` / `MonitorList` use custom TUI renderers (`renderShell: 'self'`); statusline `/m` shows active monitors. |
| Interactive `/monitor-list` menu | ✅ shipped | Vertical frame, live tail (last 10 lines), details mode, confirm-or-force stop, left/right nav, auto-close when empty. |
| Sensible agent-oriented defaults | ✅ shipped | Default regex matches all lines; `before`/`after`/`debounceSeconds` default to `0` (opt in to context/debounce). Schema descriptions may still mention historical “10 / 5” examples — runtime clamps use 0. |
| Project/global settings | ✅ shipped | `confirmStop` in `.pi/pi-monitor.json` or `~/.pi/agent/pi-monitor.json` (project overrides global). |
| License | ✅ shipped | Unlicense / public domain (dual Unlicense + CC0 notes in history); not MIT like upstream’s published LICENSE. |
| No GitHub PR-watch skill | intentionally omitted | Upstream plans a `gh`-based PR watcher skill; out of scope here. |
| Fork maintenance docs | ✅ shipped | `AGENTS.md`, `RELEASE.md`, tag-driven CI publish. |

## Install

```bash
pi install npm:@clanker-code/pi-monitor
```

Local development:

```bash
pi install /path/to/pi-monitor
# or ad-hoc for one run:
pi -e ./extensions/pi-monitor.ts
```

Requires Node ≥ 22.19 and a recent pi coding agent.

## Tools

### `Monitor`

Run a shell command in the background and watch stdout for regex matches.

```
Monitor command="tail -f /var/log/app.log" regex="error|warn" before=5 after=3
```

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `command` | yes | — | Shell command to run |
| `regex` | no | match all | Regex pattern against each stdout line |
| `regexFlags` | no | `''` | RegExp flags |
| `before` | no | `0` | Context lines before match (0–200) |
| `after` | no | `0` | Context lines after match (0–200) |
| `debounceSeconds` | no | `0` | Debounce window in seconds (0–60) |
| `label` | no | — | Human-readable label |
| `triggerTurn` | no | `true` | Wake/steer the assistant on match; `false` = display-only |

### `MonitorStop`

Stop a running monitor by id (e.g. `mon_1`).

### `MonitorList`

List all running monitors (command, regex, label, uptime, trigger flag).

## Commands

| Command | Description |
|---------|-------------|
| `/monitor-stop <jobID>` | Stop a running monitor |
| `/monitor-list` | Interactive menu: list monitors, view tail, stop |

There is **no** `/monitor` slash command — start monitors via the `Monitor` tool (or your own wrapper).

### `/monitor-list` menu

- Lists active monitors, **newest first**
- Detail pane shows the **last 10 stdout lines** (refreshes every 1s)
- **Up/Down**: navigate · **Enter / s**: stop (confirm if `confirmStop`) · **x**: stop without confirm · **Left / Esc / q**: back/close · **Right**: Enter-equivalent on list

### Settings

Read from `<cwd>/.pi/pi-monitor.json` (project) or `~/.pi/agent/pi-monitor.json` (global); project overrides global.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `confirmStop` | boolean | `true` | Whether Enter/s asks for confirmation before stopping |

```json
{ "confirmStop": false }
```

## Security model

- Pi packages run with full system access — review the source before installing.
- Commands run in their own process group; stop is SIGTERM → grace → SIGKILL.
- Delivered process output is nonce-fenced, ANSI/control-stripped, and best-effort secret-redacted.
- Regex patterns are length-capped and ReDoS-vetted before a monitor starts.

## Development

```bash
pnpm install
pnpm test
pnpm check
```

Release process: see [RELEASE.md](./RELEASE.md).

## Upstream

- Original design and research: [Shodocan/pi-monitor-plugin](https://github.com/Shodocan/pi-monitor-plugin) (successor ideas also relate to [opencode-monitor-plugin](https://github.com/Shodocan/opencode-monitor-plugin)).
- We credit Walisson Casonatto for the monitor architecture (ProcessRunner, MonitorEngine, ReDoS worker, delivery hygiene). Divergences above are ours.

## License

[Unlicense](LICENSE) (public domain).
